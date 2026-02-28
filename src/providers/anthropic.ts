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

    // Idle timeout: abort if no SSE event arrives within the deadline.
    // The SDK's timeout only covers the initial HTTP response headers;
    // once streaming starts, a silently dropped connection waits forever.
    const idleMs = options?.idleTimeoutMs ?? 120_000;
    const idleAbort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimedOut = false;

    // Link caller's signal so external cancellation still works
    const onExternalAbort = () => idleAbort.abort();
    if (options?.signal) {
      if (options.signal.aborted) { idleAbort.abort(); }
      else { options.signal.addEventListener('abort', onExternalAbort, { once: true }); }
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimedOut = true; idleAbort.abort(); }, idleMs);
    };

    resetIdleTimer();

    try {
      const stream = await this.client.messages.stream(anthropicRequest, {
        signal: idleAbort.signal,
      });

      let accumulated = '';

      // Accumulate response metadata from SSE events directly, so we can
      // skip finalMessage() and its variable-latency connection teardown.
      let model = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens: number | undefined;
      let cacheReadTokens: number | undefined;
      let stopReason: string = 'end_turn';
      let stopSequence: string | undefined;

      // Content block tracking — finalized on content_block_stop
      const contentBlocks: Record<string, unknown>[] = [];
      let currentBlockIndex = -1;
      let currentBlockContent = '';
      let currentBlockInputJson = '';

      for await (const event of stream) {
        resetIdleTimer();
        if (event.type === 'message_start') {
          model = event.message.model;
          const usage = event.message.usage as unknown as Record<string, number>;
          inputTokens = usage.input_tokens ?? 0;
          cacheCreationTokens = usage.cache_creation_input_tokens;
          cacheReadTokens = usage.cache_read_input_tokens;

        } else if (event.type === 'content_block_start') {
          currentBlockIndex = event.index;
          currentBlockContent = '';
          currentBlockInputJson = '';
          contentBlocks[currentBlockIndex] = { ...event.content_block };
          callbacks.onContentBlock?.(currentBlockIndex, event.content_block);

        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            accumulated += chunk;
            currentBlockContent += chunk;
            callbacks.onChunk(chunk);
          } else if (event.delta.type === 'thinking_delta') {
            currentBlockContent += event.delta.thinking;
            callbacks.onChunk(event.delta.thinking);
          } else if ((event.delta as { type: string }).type === 'input_json_delta') {
            currentBlockInputJson += (event.delta as { partial_json: string }).partial_json;
          }

        } else if (event.type === 'content_block_stop') {
          // Finalize block with accumulated content
          const block = contentBlocks[currentBlockIndex];
          if (block) {
            if (block.type === 'text') {
              block.text = currentBlockContent;
            } else if (block.type === 'thinking') {
              block.thinking = currentBlockContent;
            } else if (block.type === 'tool_use' && currentBlockInputJson) {
              try { block.input = JSON.parse(currentBlockInputJson); } catch { /* partial JSON */ }
            }
          }
          callbacks.onContentBlock?.(currentBlockIndex, contentBlocks[currentBlockIndex]);

        } else if (event.type === 'message_delta') {
          // All content blocks are finalized by the time message_delta arrives.
          // Capture final metadata and exit — message_stop and the SSE connection
          // teardown after it add only variable latency with no useful data.
          const delta = event.delta as { stop_reason?: string; stop_sequence?: string };
          stopReason = delta.stop_reason ?? 'end_turn';
          stopSequence = delta.stop_sequence ?? undefined;
          outputTokens = (event.usage as { output_tokens: number }).output_tokens ?? 0;
          break;
        }
      }

      // Clean up idle timer and external signal listener
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      // Force-close the HTTP connection so we don't block on SSE drain
      try { stream.controller.abort(); } catch { /* already closed */ }

      return {
        content: contentBlocks,
        stopReason,
        stopSequence,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
        },
        model,
        rawRequest: fullRequest,
        raw: {
          content: contentBlocks,
          stop_reason: stopReason,
          stop_sequence: stopSequence ?? null,
          model,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
          },
        },
      };

    } catch (error) {
      // Clean up timer on error path too
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      if (idleTimedOut && error instanceof Error && error.name === 'AbortError') {
        throw new MembraneError({
          type: 'timeout',
          message: `SSE stream idle timeout — no events received within ${idleMs}ms`,
          retryable: true,
          rawError: error,
          rawRequest: fullRequest,
        });
      }
      throw this.handleError(error, fullRequest);
    }
  }

  private buildRequest(request: ProviderRequest): Anthropic.MessageCreateParams {
    // Strip provider-specific fields (e.g., sourceUrl for Gemini) from image blocks
    // before sending to Anthropic, which rejects extra inputs
    const sanitizedMessages = (request.messages as any[]).map((msg: any) => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map((block: any) => {
          if (block.type === 'image' && block.sourceUrl !== undefined) {
            const { sourceUrl, ...rest } = block;
            return rest;
          }
          return block;
        }),
      };
    });

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: sanitizedMessages as Anthropic.MessageParam[],
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

    // Anthropic API rejects requests with both temperature and top_p set.
    // When both are provided, prefer temperature (more commonly tuned) and drop top_p.
    if (request.topP !== undefined && request.temperature === undefined) {
      params.top_p = request.topP;
    }

    if (request.topK !== undefined) {
      params.top_k = request.topK;
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

    // Apply extra params, excluding internal membrane fields
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(params, rest);
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
