/**
 * AWS Bedrock provider adapter for Anthropic Claude models
 *
 * Uses the Anthropic Messages API format through AWS Bedrock.
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  ContentBlock,
} from '../types/index.js';
import {
  MembraneError,
  rateLimitError,
  contextLengthError,
  authError,
  serverError,
  abortError,
} from '../types/index.js';

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface BedrockAdapterConfig {
  /** AWS access key ID */
  accessKeyId?: string;

  /** AWS secret access key */
  secretAccessKey?: string;

  /** AWS region (defaults to us-west-2) */
  region?: string;

  /** AWS session token (for temporary credentials) */
  sessionToken?: string;

  /** Default max tokens */
  defaultMaxTokens?: number;

  /** Anthropic API version header (defaults to 2023-06-01) */
  anthropicVersion?: string;
}

// ============================================================================
// Bedrock Request/Response Types
// ============================================================================

interface BedrockMessageRequest {
  anthropic_version: string;
  max_tokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }>;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  thinking?: { type: 'enabled'; budget_tokens: number };
}

interface BedrockMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text' | 'tool_use' | 'thinking';
    text?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface BedrockStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string;
  };
  message?: BedrockMessageResponse;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ============================================================================
// AWS Signature V4 Implementation
// ============================================================================

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

async function signRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string | undefined,
  region: string,
  service: string
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = getAmzDate();

  // Prepare headers for signing
  const signedHeaders: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-date': amzDate,
  };

  if (sessionToken) {
    signedHeaders['x-amz-security-token'] = sessionToken;
  }

  // Create canonical request
  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map(k => `${k.toLowerCase()}:${signedHeaders[k]?.trim()}`)
    .join('\n') + '\n';
  const signedHeadersList = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
  const payloadHash = await sha256(body);

  // URI-encode path components for canonical request (AWS SigV4 requirement)
  // AWS requires double-encoding: %3A in the URL becomes %253A in the canonical request
  // We encode each segment without decoding first to achieve double-encoding
  const canonicalUri = url.pathname
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  const canonicalRequest = [
    method,
    canonicalUri,
    url.search.slice(1), // Remove leading '?'
    canonicalHeaders,
    signedHeadersList,
    payloadHash,
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  // Calculate signature
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Create authorization header
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return {
    ...signedHeaders,
    authorization,
  };
}

// ============================================================================
// Bedrock Adapter
// ============================================================================

export class BedrockAdapter implements ProviderAdapter {
  readonly name = 'bedrock';

  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  private region: string;
  private defaultMaxTokens: number;
  private anthropicVersion: string;

  constructor(config: BedrockAdapterConfig = {}) {
    this.accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? '';
    this.secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? '';
    this.sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN;
    this.region = config.region ?? process.env.AWS_REGION ?? 'us-west-2';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.anthropicVersion = config.anthropicVersion ?? 'bedrock-2023-05-31';

    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('AWS credentials required: accessKeyId and secretAccessKey');
    }
  }

  supportsModel(modelId: string): boolean {
    // Support both Bedrock model IDs and standard Claude model IDs
    return modelId.includes('claude') || modelId.startsWith('anthropic.');
  }

  /**
   * Convert a standard Claude model ID to Bedrock format if needed
   */
  private toBedrockModelId(modelId: string): string {
    // Strip bedrock: routing prefix if present (used for explicit routing to this adapter)
    if (modelId.startsWith('bedrock:')) {
      modelId = modelId.slice('bedrock:'.length);
    }

    // If already in Bedrock format, use as-is
    if (modelId.startsWith('anthropic.')) {
      return modelId;
    }

    // Map common Claude model IDs to Bedrock format
    const modelMap: Record<string, string> = {
      'claude-3-5-sonnet-20241022': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-sonnet-latest': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-haiku-20241022': 'anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-3-5-haiku-latest': 'anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-3-opus-20240229': 'anthropic.claude-3-opus-20240229-v1:0',
      'claude-3-sonnet-20240229': 'anthropic.claude-3-sonnet-20240229-v1:0',
      'claude-3-haiku-20240307': 'anthropic.claude-3-haiku-20240307-v1:0',
      'claude-sonnet-4-20250514': 'anthropic.claude-sonnet-4-20250514-v1:0',
      'claude-opus-4-20250514': 'anthropic.claude-opus-4-20250514-v1:0',
      // Haiku 4.5 aliases
      'claude-haiku-4-5-20251001': 'anthropic.claude-3-5-haiku-20241022-v1:0',
    };

    return modelMap[modelId] ?? `anthropic.${modelId}-v1:0`;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const bedrockModelId = this.toBedrockModelId(request.model);
    const bedrockRequest = this.buildRequest(request);
    const fullRequest = { modelId: bedrockModelId, ...bedrockRequest };
    options?.onRequest?.(fullRequest);

    try {
      const response = await this.invokeModel(bedrockModelId, bedrockRequest, options?.signal);
      return this.parseResponse(response, fullRequest);
    } catch (error) {
      throw this.handleError(error, fullRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const bedrockModelId = this.toBedrockModelId(request.model);
    const bedrockRequest = this.buildRequest(request);
    const fullRequest = { modelId: bedrockModelId, ...bedrockRequest, stream: true };
    options?.onRequest?.(fullRequest);

    try {
      return await this.invokeModelWithStream(bedrockModelId, bedrockRequest, callbacks, options?.signal);
    } catch (error) {
      throw this.handleError(error, fullRequest);
    }
  }

  private buildRequest(request: ProviderRequest): BedrockMessageRequest {
    const params: BedrockMessageRequest = {
      anthropic_version: this.anthropicVersion,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: request.messages as BedrockMessageRequest['messages'],
    };

    // Handle system prompt
    if (request.system) {
      params.system = request.system as BedrockMessageRequest['system'];
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      params.top_p = request.topP;
    }

    if (request.topK !== undefined) {
      params.top_k = request.topK;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop_sequences = request.stopSequences;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools;
    }

    // Handle extended thinking
    if ((request as any).thinking) {
      params.thinking = (request as any).thinking;
    }

    // Apply extra params, excluding internal membrane fields
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(params, rest);
    }

    return params;
  }

  private async invokeModel(
    modelId: string,
    request: BedrockMessageRequest,
    signal?: AbortSignal
  ): Promise<BedrockMessageResponse> {
    const url = new URL(
      `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`
    );

    const body = JSON.stringify(request);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };

    const signedHeaders = await signRequest(
      'POST',
      url,
      headers,
      body,
      this.accessKeyId,
      this.secretAccessKey,
      this.sessionToken,
      this.region,
      'bedrock'
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signedHeaders,
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new BedrockError(response.status, errorText);
    }

    return response.json() as Promise<BedrockMessageResponse>;
  }

  private async invokeModelWithStream(
    modelId: string,
    request: BedrockMessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<ProviderResponse> {
    const url = new URL(
      `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`
    );

    const body = JSON.stringify(request);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
    };

    const signedHeaders = await signRequest(
      'POST',
      url,
      headers,
      body,
      this.accessKeyId,
      this.secretAccessKey,
      this.sessionToken,
      this.region,
      'bedrock'
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signedHeaders,
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new BedrockError(response.status, errorText);
    }

    // Parse the binary event stream
    const contentBlocks: Array<{ type: string; text?: string }> = [];
    let currentBlockIndex = -1;
    let finalMessage: BedrockMessageResponse | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string = 'end_turn';
    let fullText = '';

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    let buffer = new Uint8Array(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append new data to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        // Parse complete events from buffer
        while (buffer.length >= 16) {
          // AWS event stream format:
          // 4 bytes: total byte length (big-endian)
          // 4 bytes: headers length (big-endian)
          // 4 bytes: prelude CRC
          // headers
          // payload
          // 4 bytes: message CRC
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const totalLength = view.getUint32(0, false);
          const headersLength = view.getUint32(4, false);

          if (buffer.length < totalLength) {
            // Incomplete message, wait for more data
            break;
          }

          // Extract payload (skip prelude, headers, and CRCs)
          const payloadStart = 12 + headersLength;
          const payloadEnd = totalLength - 4;
          const payloadBytes = buffer.slice(payloadStart, payloadEnd);

          // Parse headers to find event type
          let eventType = '';
          let headerOffset = 12;
          const headerEnd = 12 + headersLength;
          while (headerOffset < headerEnd) {
            const nameLength = buffer[headerOffset]!;
            headerOffset += 1;
            const name = new TextDecoder().decode(buffer.slice(headerOffset, headerOffset + nameLength));
            headerOffset += nameLength;
            const valueType = buffer[headerOffset]!;
            headerOffset += 1;

            if (valueType === 7) {
              // String type
              const valueLength = new DataView(buffer.buffer, buffer.byteOffset + headerOffset, 2).getUint16(0, false);
              headerOffset += 2;
              const value = new TextDecoder().decode(buffer.slice(headerOffset, headerOffset + valueLength));
              headerOffset += valueLength;

              if (name === ':event-type') {
                eventType = value;
              }
            } else {
              // Skip other header types
              break;
            }
          }

          // Parse the JSON payload
          if (eventType === 'chunk' && payloadBytes.length > 0) {
            try {
              const payloadJson = JSON.parse(new TextDecoder().decode(payloadBytes));
              if (payloadJson.bytes) {
                // Decode base64 payload
                const eventData = JSON.parse(atob(payloadJson.bytes)) as BedrockStreamEvent;

                if (eventData.type === 'message_start' && eventData.message) {
                  inputTokens = eventData.message.usage?.input_tokens ?? 0;
                } else if (eventData.type === 'content_block_start') {
                  currentBlockIndex = eventData.index ?? 0;
                  contentBlocks[currentBlockIndex] = eventData.content_block as { type: string };
                  callbacks.onContentBlock?.(currentBlockIndex, eventData.content_block);
                } else if (eventData.type === 'content_block_delta') {
                  if (eventData.delta?.type === 'text_delta' && eventData.delta.text) {
                    fullText += eventData.delta.text;
                    callbacks.onChunk(eventData.delta.text);
                    if (contentBlocks[currentBlockIndex]) {
                      contentBlocks[currentBlockIndex]!.text = (contentBlocks[currentBlockIndex]!.text ?? '') + eventData.delta.text;
                    }
                  } else if (eventData.delta?.type === 'thinking_delta' && eventData.delta.thinking) {
                    callbacks.onChunk(eventData.delta.thinking);
                  }
                } else if (eventData.type === 'message_delta') {
                  if (eventData.usage) {
                    outputTokens = eventData.usage.output_tokens;
                  }
                  if (eventData.delta?.stop_reason) {
                    stopReason = eventData.delta.stop_reason;
                  }
                }
              }
            } catch {
              // Skip malformed events
            }
          }

          // Remove processed message from buffer
          buffer = buffer.slice(totalLength);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build response from accumulated data
    finalMessage = {
      id: 'msg_stream',
      type: 'message',
      role: 'assistant',
      content: contentBlocks.map(b => ({
        type: b.type as 'text',
        text: b.text,
      })),
      model: modelId,
      stop_reason: stopReason as BedrockMessageResponse['stop_reason'],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    };

    return this.parseResponse(finalMessage, { modelId, ...request, stream: true });
  }

  private parseResponse(response: BedrockMessageResponse, rawRequest: unknown): ProviderResponse {
    const content: ContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      } else if (block.type === 'thinking' && block.thinking) {
        content.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        });
      }
    }

    return {
      content,
      stopReason: response.stop_reason ?? 'end_turn',
      stopSequence: response.stop_sequence ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens,
      },
      model: response.model,
      rawRequest,
      raw: response,
    };
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof BedrockError) {
      const status = error.status;
      const message = error.message;

      if (status === 429) {
        return rateLimitError(message, undefined, error, rawRequest);
      }

      if (status === 401 || status === 403) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long') || message.includes('token')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (status >= 500) {
        return serverError(message, status, error, rawRequest);
      }
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return abortError(undefined, rawRequest);
    }

    return new MembraneError({
      type: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      rawError: error,
      rawRequest,
    });
  }
}

// ============================================================================
// Error Class
// ============================================================================

class BedrockError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'BedrockError';
  }
}
