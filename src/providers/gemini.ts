/**
 * Google Gemini provider adapter
 *
 * Direct adapter for Google's Generative AI REST API.
 * Supports Gemini 2.x, 2.5, 3.x models with:
 * - Text and image input
 * - Tool/function calling
 * - Streaming via SSE
 *
 * Auth: API key passed as query parameter (?key=...)
 * Endpoint: generativelanguage.googleapis.com/v1beta
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
// Gemini API Types
// ============================================================================

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
    safetyRatings?: unknown[];
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code: number; message: string; status: string };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface GeminiAdapterConfig {
  /** Google AI API key */
  apiKey?: string;

  /** Base URL (default: https://generativelanguage.googleapis.com/v1beta) */
  baseURL?: string;

  /** Default max output tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// Gemini Adapter
// ============================================================================

export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini';
  private apiKey: string;
  private baseURL: string;
  private defaultMaxTokens: number;

  constructor(config: GeminiAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? '';
    this.baseURL = (config.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;

    if (!this.apiKey) {
      throw new Error('Google AI API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gemini-');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const geminiRequest = this.buildRequest(request);
    options?.onRequest?.(geminiRequest);

    try {
      const url = `${this.baseURL}/models/${request.model}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${errorText}`);
      }

      const data = await response.json() as GeminiResponse;

      if (data.error) {
        throw new Error(`Gemini API error: ${data.error.code} ${data.error.message}`);
      }

      return this.parseResponse(data, request.model, geminiRequest);
    } catch (error) {
      throw this.handleError(error, geminiRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const geminiRequest = this.buildRequest(request);
    options?.onRequest?.(geminiRequest);

    try {
      const url = `${this.baseURL}/models/${request.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let finishReason = 'STOP';
      let toolCalls: { name: string; args: Record<string, unknown> }[] = [];
      let images: { data: string; mimeType: string }[] = [];
      let lastUsage: GeminiResponse['usageMetadata'] | undefined;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as GeminiResponse;
            const candidate = parsed.candidates?.[0];

            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  accumulated += part.text;
                  callbacks.onChunk(part.text);
                }
                if (part.inlineData) {
                  images.push({
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                  });
                }
                if (part.functionCall) {
                  toolCalls.push({
                    name: part.functionCall.name,
                    args: part.functionCall.args,
                  });
                }
              }
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }

            if (parsed.usageMetadata) {
              lastUsage = parsed.usageMetadata;
            }
          } catch {
            // Ignore parse errors in stream chunks
          }
        }
      }

      // Process any remaining data in the buffer (final chunk may not end with newline)
      if (buffer.trim()) {
        const remaining = buffer.trim();
        const dataLine = remaining.startsWith('data: ') ? remaining.slice(6).trim() : remaining;
        if (dataLine && dataLine !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataLine) as GeminiResponse;
            const candidate = parsed.candidates?.[0];

            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  accumulated += part.text;
                  callbacks.onChunk(part.text);
                }
                if (part.inlineData) {
                  images.push({
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                  });
                }
                if (part.functionCall) {
                  toolCalls.push({
                    name: part.functionCall.name,
                    args: part.functionCall.args,
                  });
                }
              }
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }

            if (parsed.usageMetadata) {
              lastUsage = parsed.usageMetadata;
            }
          } catch {
            // Final buffer wasn't valid JSON — nothing to do
          }
        }
      }

      return {
        content: this.buildContentBlocks(accumulated, toolCalls, images),
        stopReason: this.mapFinishReason(finishReason),
        stopSequence: undefined,
        usage: {
          inputTokens: lastUsage?.promptTokenCount ?? 0,
          outputTokens: lastUsage?.candidatesTokenCount ?? 0,
          cacheReadTokens: lastUsage?.cachedContentTokenCount
            ? lastUsage.cachedContentTokenCount
            : undefined,
        },
        model: request.model,
        rawRequest: geminiRequest,
        raw: { finishReason, usage: lastUsage },
      };
    } catch (error) {
      throw this.handleError(error, geminiRequest);
    }
  }

  // --------------------------------------------------------------------------
  // Request Building
  // --------------------------------------------------------------------------

  private buildRequest(request: ProviderRequest): GeminiRequest {
    const contents = this.convertMessages(request.messages as any[]);
    const maxTokens = request.maxTokens || this.defaultMaxTokens;

    const geminiRequest: GeminiRequest = { contents };

    // System instruction
    if (request.system) {
      const systemText = typeof request.system === 'string'
        ? request.system
        : (request.system as any[])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');

      if (systemText) {
        geminiRequest.systemInstruction = {
          parts: [{ text: systemText }],
        };
      }
    }

    // Generation config
    geminiRequest.generationConfig = {
      maxOutputTokens: maxTokens,
    };

    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      geminiRequest.generationConfig.topP = request.topP;
    }

    if (request.topK !== undefined) {
      geminiRequest.generationConfig.topK = request.topK;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      // Gemini API limits stop sequences to 5
      geminiRequest.generationConfig.stopSequences = request.stopSequences.slice(0, 5);
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = [{
        functionDeclarations: this.convertTools(request.tools as any[]),
      }];
    }

    // Extra params
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(geminiRequest, rest);
    }

    return geminiRequest;
  }

  private convertMessages(messages: any[]): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

      // Simple string content
      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      // Array content blocks (Anthropic-style)
      if (Array.isArray(msg.content)) {
        const parts: GeminiPart[] = [];
        const toolResultParts: GeminiPart[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) parts.push({ text: block.text });
          } else if (block.type === 'image') {
            // Anthropic image format → Gemini inlineData
            const source = block.source;
            if (source?.type === 'base64' && source.data) {
              parts.push({
                inlineData: {
                  mimeType: source.media_type ?? 'image/jpeg',
                  data: source.data,
                },
              });
            }
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input ?? {},
              },
            });
          } else if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            toolResultParts.push({
              functionResponse: {
                name: block.name ?? block.tool_use_id ?? 'unknown',
                response: { result: resultContent },
              },
            });
          }
        }

        // Tool results go in a user message
        if (toolResultParts.length > 0) {
          contents.push({ role: 'user', parts: toolResultParts });
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }

        continue;
      }

      // Null/empty content — skip
      if (msg.content === null || msg.content === undefined) continue;

      // Fallback
      contents.push({ role, parts: [{ text: String(msg.content) }] });
    }

    // Gemini requires alternating user/model roles.
    // Merge consecutive same-role messages.
    return this.mergeConsecutiveRoles(contents);
  }

  /**
   * Gemini requires strictly alternating user/model messages.
   * Merge consecutive messages with the same role into one.
   */
  private mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
    if (contents.length === 0) return contents;

    const merged: GeminiContent[] = [contents[0]!];

    for (let i = 1; i < contents.length; i++) {
      const current = contents[i]!;
      const last = merged[merged.length - 1]!;

      if (current.role === last.role) {
        // Merge parts into the previous message
        last.parts.push(...current.parts);
      } else {
        merged.push(current);
      }
    }

    // Gemini also requires the first message to be "user"
    if (merged.length > 0 && merged[0]!.role !== 'user') {
      merged.unshift({ role: 'user', parts: [{ text: '[Start]' }] });
    }

    return merged;
  }

  private convertTools(tools: any[]): GeminiFunctionDeclaration[] {
    return tools.map(tool => {
      const schema = tool.inputSchema || tool.input_schema || { type: 'object', properties: {} };
      return {
        name: tool.name,
        description: tool.description ?? '',
        parameters: schema,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Response Parsing
  // --------------------------------------------------------------------------

  private parseResponse(
    response: GeminiResponse,
    requestedModel: string,
    rawRequest: unknown
  ): ProviderResponse {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    let text = '';
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const images: { data: string; mimeType: string }[] = [];

    for (const part of parts) {
      if (part.text) text += part.text;
      if (part.inlineData) {
        images.push({
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        });
      }
      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
      }
    }

    return {
      content: this.buildContentBlocks(text, toolCalls, images),
      stopReason: this.mapFinishReason(candidate?.finishReason),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        cacheReadTokens: response.usageMetadata?.cachedContentTokenCount
          ? response.usageMetadata.cachedContentTokenCount
          : undefined,
      },
      model: response.modelVersion ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private buildContentBlocks(
    text: string,
    toolCalls: { name: string; args: Record<string, unknown> }[],
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

    for (const tc of toolCalls) {
      content.push({
        type: 'tool_use',
        id: `gemini-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        input: tc.args,
      });
    }

    return content;
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
        return 'refusal';
      case 'RECITATION':
        return 'refusal';
      case 'TOOL_CALLS':
      case 'FUNCTION_CALL':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return error;

    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('401') || message.includes('403') || message.includes('API_KEY_INVALID') || message.includes('PERMISSION_DENIED')) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
        const retryMatch = message.match(/retry.after[:\s]*(\d+)/i);
        const retryAfter = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : undefined;
        return rateLimitError(message, retryAfter, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long') || message.includes('token limit')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('INTERNAL')) {
        return serverError(message, undefined, error, rawRequest);
      }

      if (error.name === 'AbortError') {
        return abortError(undefined, rawRequest);
      }

      if (message.includes('network') || message.includes('fetch') || message.includes('ECONNREFUSED')) {
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

// ============================================================================
// Content Conversion Utilities
// ============================================================================

/**
 * Convert normalized content blocks to Gemini parts
 */
export function toGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks.map(block => {
    if (block.type === 'text') {
      return { text: (block as any).text };
    }
    if (block.type === 'tool_use') {
      return {
        functionCall: {
          name: (block as any).name,
          args: (block as any).input ?? {},
        },
      };
    }
    return { text: String(block) };
  });
}

/**
 * Convert Gemini parts to normalized content blocks
 */
export function fromGeminiParts(parts: GeminiPart[]): ContentBlock[] {
  const result: ContentBlock[] = [];

  for (const part of parts) {
    if (part.text) {
      result.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      result.push({
        type: 'tool_use',
        id: `gemini-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
      });
    }
  }

  return result;
}
