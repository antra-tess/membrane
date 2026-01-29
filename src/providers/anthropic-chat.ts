/**
 * Anthropic Chat Adapter - Simple two-party conversation
 *
 * For standard Human/Assistant conversations without multi-user support.
 * - Strict participant validation (only configured human/assistant names allowed)
 * - No participant names in messages (pure user/assistant roles)
 * - Native Anthropic tool API
 *
 * Use AnthropicMultiuserAdapter for multi-party conversations.
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
import { toAnthropicContent, fromAnthropicContent } from './anthropic.js';

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface AnthropicChatAdapterConfig {
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;

  /** Base URL override */
  baseURL?: string;

  /** Default max tokens */
  defaultMaxTokens?: number;

  /**
   * Human participant name (default: 'Human')
   * Messages with this participant become 'user' role.
   */
  humanParticipant?: string;

  /**
   * Assistant participant name (default: 'Claude')
   * Messages with this participant become 'assistant' role.
   */
  assistantParticipant?: string;
}

// ============================================================================
// Anthropic Chat Adapter
// ============================================================================

export class AnthropicChatAdapter implements ProviderAdapter {
  readonly name = 'anthropic-chat';
  private client: Anthropic;
  private defaultMaxTokens: number;
  private humanParticipant: string;
  private assistantParticipant: string;

  constructor(config: AnthropicChatAdapterConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.humanParticipant = config.humanParticipant ?? 'Human';
    this.assistantParticipant = config.assistantParticipant ?? 'Claude';
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

  // ============================================================================
  // Message Conversion
  // ============================================================================

  /**
   * Convert normalized messages to Anthropic format.
   * Validates that only configured human/assistant participants are used.
   */
  private convertMessages(
    messages: Array<{ participant: string; content: ContentBlock[] }>
  ): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      // Validate participant
      if (msg.participant !== this.humanParticipant && msg.participant !== this.assistantParticipant) {
        throw new MembraneError({
          type: 'invalid_request',
          message: `AnthropicChatAdapter only supports two participants: "${this.humanParticipant}" and "${this.assistantParticipant}". ` +
            `Got: "${msg.participant}". Use AnthropicMultiuserAdapter for multi-party conversations.`,
          retryable: false,
          rawError: new Error(`Invalid participant: ${msg.participant}`),
        });
      }

      const role: 'user' | 'assistant' = msg.participant === this.humanParticipant ? 'user' : 'assistant';
      const content = toAnthropicContent(msg.content);

      result.push({ role, content });
    }

    return result;
  }

  private buildRequest(request: ProviderRequest): Anthropic.MessageCreateParams {
    // Get normalized messages from extra (preferred) or fall back to provider messages
    const normalizedMessages = request.extra?.normalizedMessages as Array<{ participant: string; content: ContentBlock[] }> | undefined;

    let messages: Anthropic.MessageParam[];
    if (normalizedMessages) {
      messages = this.convertMessages(normalizedMessages);
    } else {
      // Assume already in provider format
      messages = request.messages as Anthropic.MessageParam[];
    }

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages,
    };

    // Handle system prompt
    if (request.system) {
      if (typeof request.system === 'string') {
        params.system = request.system;
      } else if (Array.isArray(request.system)) {
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

    // Apply extra params (excluding normalizedMessages)
    if (request.extra) {
      const { normalizedMessages: _, ...rest } = request.extra;
      Object.assign(params, rest);
    }

    return params;
  }

  private parseResponse(response: Anthropic.Message, rawRequest: unknown): ProviderResponse {
    return {
      content: fromAnthropicContent(response.content),
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
    const message = error.message;
    const match = message.match(/retry after (\d+)/i);
    if (match && match[1]) {
      return parseInt(match[1], 10) * 1000;
    }
    return undefined;
  }
}
