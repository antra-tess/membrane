/**
 * OpenAI Responses API provider adapter
 *
 * Adapter for OpenAI's `/v1/responses` endpoint, required for image generation
 * models like `gpt-image-1`. The Responses API differs from Chat Completions:
 *
 * - Uses `input` array instead of `messages`
 * - Content types: `input_text` / `input_image` (not `text` / `image_url`)
 * - Image generation is a tool: `{"type": "image_generation"}`
 * - Generated images come back as `image_generation_call` output items
 * - Streaming uses different event types
 *
 * This adapter converts membrane's ProviderRequest into the Responses API format,
 * sends the request, and converts the response back into membrane ContentBlocks.
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
  networkError,
} from '../types/index.js';

// ============================================================================
// Responses API Types
// ============================================================================

interface ResponsesInputTextPart {
  type: 'input_text';
  text: string;
}

interface ResponsesInputImagePart {
  type: 'input_image';
  image_url: string; // data URI: "data:image/jpeg;base64,..."
  detail?: 'auto' | 'low' | 'high';
}

type ResponsesInputPart = ResponsesInputTextPart | ResponsesInputImagePart;

interface ResponsesInputMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: ResponsesInputPart[] | string;
}

interface ResponsesRequest {
  model: string;
  input: (ResponsesInputMessage | string)[];
  instructions?: string;
  tools?: { type: string; [key: string]: unknown }[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

interface ResponsesOutputText {
  type: 'output_text';
  text: string;
}

interface ResponsesImageGenerationCall {
  type: 'image_generation_call';
  id: string;
  result: string; // base64 image data
  status?: string;
}

type ResponsesOutputContent = ResponsesOutputText | ResponsesImageGenerationCall;

interface ResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  content: ResponsesOutputContent[];
}

type ResponsesOutputItem = ResponsesOutputMessage | ResponsesImageGenerationCall;

interface ResponsesAPIResponse {
  id: string;
  object: string;
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
  status?: string;
  error?: { code: string; message: string };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface OpenAIResponsesAdapterConfig {
  /** API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;

  /** Base URL (default: https://api.openai.com/v1) */
  baseURL?: string;

  /** Organization ID (optional) */
  organization?: string;

  /** Default max output tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// OpenAI Responses Adapter
// ============================================================================

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly name = 'openai-responses';
  private apiKey: string;
  private baseURL: string;
  private organization?: string;
  private defaultMaxTokens: number;

  constructor(config: OpenAIResponsesAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.organization = config.organization;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;

    if (!this.apiKey) {
      throw new Error('OpenAI API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gpt-image');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const responsesRequest = this.buildRequest(request);
    options?.onRequest?.(responsesRequest);

    try {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(responsesRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Responses API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as ResponsesAPIResponse;

      if (data.error) {
        throw new Error(`OpenAI Responses API error: ${data.error.code} ${data.error.message}`);
      }

      return this.parseResponse(data, request.model, responsesRequest);
    } catch (error) {
      throw this.handleError(error, responsesRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const responsesRequest = this.buildRequest(request);
    responsesRequest.stream = true;
    options?.onRequest?.(responsesRequest);

    try {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(responsesRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Responses API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let images: { data: string; mimeType: string }[] = [];
      let lastUsage: ResponsesAPIResponse['usage'] | undefined;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            // Handle text deltas
            if (parsed.type === 'response.output_text.delta') {
              const delta = parsed.delta ?? '';
              accumulated += delta;
              callbacks.onChunk(delta);
            }

            // Handle completed text
            if (parsed.type === 'response.output_text.done') {
              // Text already accumulated via deltas
            }

            // Handle image generation results
            if (parsed.type === 'response.image_generation_call.done') {
              if (parsed.result) {
                images.push({
                  data: parsed.result,
                  mimeType: 'image/png',
                });
              }
            }

            // Handle completed response (has usage)
            if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
              const resp = parsed.response ?? parsed;
              if (resp.usage) {
                lastUsage = resp.usage;
              }
              // Extract any images from the completed response output
              if (resp.output) {
                for (const item of resp.output) {
                  if (item.type === 'image_generation_call' && item.result) {
                    // Only add if not already captured via streaming events
                    const alreadyCaptured = images.some(img => img.data === item.result);
                    if (!alreadyCaptured) {
                      images.push({
                        data: item.result,
                        mimeType: 'image/png',
                      });
                    }
                  }
                }
              }
            }
          } catch {
            // Ignore parse errors in stream chunks
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const remaining = buffer.trim();
        const dataLine = remaining.startsWith('data: ') ? remaining.slice(6).trim() : remaining;
        if (dataLine && dataLine !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataLine);
            if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
              const resp = parsed.response ?? parsed;
              if (resp.usage) lastUsage = resp.usage;
            }
          } catch {
            // Final buffer wasn't valid JSON
          }
        }
      }

      const cachedTokens = lastUsage?.input_tokens_details?.cached_tokens ?? 0;

      return {
        content: this.buildContentBlocks(accumulated, images),
        stopReason: 'end_turn',
        stopSequence: undefined,
        usage: {
          inputTokens: lastUsage?.input_tokens ?? 0,
          outputTokens: lastUsage?.output_tokens ?? 0,
          cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
        },
        model: request.model,
        rawRequest: responsesRequest,
        raw: { usage: lastUsage },
      };
    } catch (error) {
      throw this.handleError(error, responsesRequest);
    }
  }

  // --------------------------------------------------------------------------
  // Request Building
  // --------------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    return headers;
  }

  private buildRequest(request: ProviderRequest): ResponsesRequest {
    const input = this.convertMessages(request.messages as any[]);
    const maxTokens = request.maxTokens || this.defaultMaxTokens;

    const responsesRequest: ResponsesRequest = {
      model: request.model,
      input,
      max_output_tokens: maxTokens,
    };

    // System prompt → instructions
    if (request.system) {
      const systemText =
        typeof request.system === 'string'
          ? request.system
          : (request.system as any[])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');

      if (systemText) {
        responsesRequest.instructions = systemText;
      }
    }

    if (request.temperature !== undefined) {
      responsesRequest.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      responsesRequest.top_p = request.topP;
    }

    // Auto-include image_generation tool for image models
    if (request.model?.includes('image')) {
      responsesRequest.tools = [{ type: 'image_generation' }];
    }

    // Apply extra params (filter out internal membrane fields)
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(responsesRequest, rest);
    }

    return responsesRequest;
  }

  private convertMessages(messages: any[]): ResponsesInputMessage[] {
    const result: ResponsesInputMessage[] = [];

    for (const msg of messages) {
      const role = this.mapRole(msg.role);

      // Simple string content
      if (typeof msg.content === 'string') {
        result.push({ role, content: msg.content });
        continue;
      }

      // Array content blocks (Anthropic-style)
      if (Array.isArray(msg.content)) {
        const parts: ResponsesInputPart[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) {
              parts.push({ type: 'input_text', text: block.text });
            }
          } else if (block.type === 'image') {
            const source = block.source;
            if (source?.type === 'base64' && source.data) {
              const mimeType = source.media_type ?? source.mediaType ?? 'image/jpeg';
              parts.push({
                type: 'input_image',
                image_url: `data:${mimeType};base64,${source.data}`,
              });
            }
          }
          // tool_use and tool_result are not supported in the Responses API input
          // for image models — skip them silently
        }

        if (parts.length > 0) {
          result.push({ role, content: parts });
        }
        continue;
      }

      // Null/empty content — skip
      if (msg.content === null || msg.content === undefined) continue;

      // Fallback
      result.push({ role, content: String(msg.content) });
    }

    return result;
  }

  private mapRole(role: string): 'user' | 'assistant' | 'system' | 'developer' {
    switch (role) {
      case 'user':
        return 'user';
      case 'assistant':
        return 'assistant';
      case 'system':
        return 'developer';
      default:
        return 'user';
    }
  }

  // --------------------------------------------------------------------------
  // Response Parsing
  // --------------------------------------------------------------------------

  private parseResponse(
    response: ResponsesAPIResponse,
    requestedModel: string,
    rawRequest: unknown
  ): ProviderResponse {
    let text = '';
    const images: { data: string; mimeType: string }[] = [];

    for (const item of response.output) {
      if (item.type === 'message') {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            text += content.text;
          } else if (content.type === 'image_generation_call') {
            images.push({
              data: content.result,
              mimeType: 'image/png',
            });
          }
        }
      } else if (item.type === 'image_generation_call') {
        images.push({
          data: item.result,
          mimeType: 'image/png',
        });
      }
    }

    const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;

    return {
      content: this.buildContentBlocks(text, images),
      stopReason: 'end_turn',
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
      },
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private buildContentBlocks(
    text: string,
    images: { data: string; mimeType: string }[] = []
  ): ContentBlock[] {
    const content: ContentBlock[] = [];

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const img of images) {
      content.push({
        type: 'generated_image',
        data: img.data,
        mimeType: img.mimeType,
      } as ContentBlock);
    }

    return content;
  }

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return error;

    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('429') || message.includes('rate_limit')) {
        const retryMatch = message.match(/retry after (\d+)/i);
        const retryAfter = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : undefined;
        return rateLimitError(message, retryAfter, error, rawRequest);
      }

      if (
        message.includes('401') ||
        message.includes('invalid_api_key') ||
        message.includes('Incorrect API key')
      ) {
        return authError(message, error, rawRequest);
      }

      if (
        message.includes('context_length') ||
        message.includes('maximum context') ||
        message.includes('too long')
      ) {
        return contextLengthError(message, error, rawRequest);
      }

      if (
        message.includes('500') ||
        message.includes('502') ||
        message.includes('503') ||
        message.includes('server_error')
      ) {
        return serverError(message, undefined, error, rawRequest);
      }

      if (error.name === 'AbortError') {
        return abortError(undefined, rawRequest);
      }

      if (
        message.includes('network') ||
        message.includes('fetch') ||
        message.includes('ECONNREFUSED')
      ) {
        return networkError(message, error, rawRequest);
      }
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
