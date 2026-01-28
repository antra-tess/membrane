/**
 * Anthropic provider adapter
 */

import Anthropic from '@anthropic-ai/sdk';
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

export interface AnthropicAdapterConfig {
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  
  /** Base URL override */
  baseURL?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// Anthropic Adapter
// ============================================================================

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  private client: Anthropic;
  private defaultMaxTokens: number;

  constructor(config: AnthropicAdapterConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('claude-');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const anthropicRequest = this.buildRequest(request);
    const fullRequest = { ...anthropicRequest, stream: false as const };
    options?.onRequest?.(fullRequest);

    try {
      const response = await this.client.messages.create(fullRequest, {
        signal: options?.signal,
      });

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
    const anthropicRequest = this.buildRequest(request);
    // Note: stream is implicitly true when using .stream()
    const fullRequest = { ...anthropicRequest, stream: true };
    options?.onRequest?.(fullRequest);

    try {
      const stream = await this.client.messages.stream(anthropicRequest, {
        signal: options?.signal,
      });

      let accumulated = '';
      const contentBlocks: unknown[] = [];
      let currentBlockIndex = -1;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          currentBlockIndex = event.index;
          contentBlocks[currentBlockIndex] = event.content_block;
          callbacks.onContentBlock?.(currentBlockIndex, event.content_block);
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            accumulated += chunk;
            callbacks.onChunk(chunk);
          } else if (event.delta.type === 'thinking_delta') {
            // Handle thinking delta
            callbacks.onChunk(event.delta.thinking);
          }
        } else if (event.type === 'content_block_stop') {
          callbacks.onContentBlock?.(currentBlockIndex, contentBlocks[currentBlockIndex]);
        }
      }

      const finalMessage = await stream.finalMessage();
      return this.parseResponse(finalMessage, fullRequest);

    } catch (error) {
      throw this.handleError(error, fullRequest);
    }
  }

  private buildRequest(request: ProviderRequest): Anthropic.MessageCreateParams {
    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: request.messages as Anthropic.MessageParam[],
    };
    
    // Handle system prompt - can be string or content blocks with cache_control
    if (request.system) {
      if (typeof request.system === 'string') {
        params.system = request.system;
      } else if (Array.isArray(request.system)) {
        // System is an array of content blocks (with potential cache_control)
        params.system = request.system as Anthropic.TextBlockParam[];
      }
    }
    
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    
    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop_sequences = request.stopSequences;
    }
    
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools as Anthropic.Tool[];
    }

    // Handle extended thinking
    if ((request as any).thinking) {
      (params as any).thinking = (request as any).thinking;
    }

    // Apply extra params
    if (request.extra) {
      Object.assign(params, request.extra);
    }

    return params;
  }

  private parseResponse(response: Anthropic.Message, rawRequest: unknown): ProviderResponse {
    return {
      content: response.content,
      stopReason: response.stop_reason ?? 'end_turn',
      stopSequence: response.stop_sequence ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: (response.usage as any).cache_creation_input_tokens,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens,
      },
      model: response.model,
      rawRequest,
      raw: response,
    };
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof Anthropic.APIError) {
      const status = error.status;
      const message = error.message;

      if (status === 429) {
        // Try to parse retry-after
        const retryAfter = this.parseRetryAfter(error);
        return rateLimitError(message, retryAfter, error, rawRequest);
      }

      if (status === 401) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long')) {
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

  private parseRetryAfter(error: { message: string }): number | undefined {
    // Try to extract retry-after from headers or message
    const message = error.message;
    const match = message.match(/retry after (\d+)/i);
    if (match && match[1]) {
      return parseInt(match[1], 10) * 1000;
    }
    return undefined;
  }
}

// ============================================================================
// Content Conversion Utilities
// ============================================================================

/**
 * Convert normalized content blocks to Anthropic format
 * Preserves cache_control for prompt caching
 */
export function toAnthropicContent(blocks: ContentBlock[]): Anthropic.ContentBlockParam[] {
  const result: Anthropic.ContentBlockParam[] = [];
  
  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const textBlock: any = { type: 'text', text: block.text };
        // Preserve cache_control if present
        if (block.cache_control) {
          textBlock.cache_control = block.cache_control;
        }
        result.push(textBlock);
        break;
      }
        
      case 'image':
        if (block.source.type === 'base64') {
          result.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: block.source.data,
            },
          });
        }
        break;
        
      case 'document':
        result.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.source.mediaType as 'application/pdf',
            data: block.source.data,
          },
        });
        break;
        
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
        
      case 'tool_result':
        result.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
          is_error: block.isError,
        });
        break;
        
      case 'thinking':
        result.push({
          type: 'thinking',
          thinking: block.thinking,
        } as any);
        break;
    }
  }
  
  return result;
}

/**
 * Convert Anthropic response content to normalized format
 */
export function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        result.push({ type: 'text', text: block.text });
        break;
        
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
        break;
        
      case 'thinking':
        result.push({
          type: 'thinking',
          thinking: (block as any).thinking,
          signature: (block as any).signature,
        });
        break;
        
      default:
        // Handle redacted_thinking or unknown types
        if ((block as any).type === 'redacted_thinking') {
          result.push({ type: 'redacted_thinking' });
        }
        break;
    }
  }
  
  return result;
}
