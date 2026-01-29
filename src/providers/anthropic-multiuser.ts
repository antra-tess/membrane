/**
 * Anthropic Multiuser Adapter - Multi-party conversation support
 *
 * For conversations with multiple participants (e.g., group chats, Discord).
 * - All non-bot participants map to 'user' role
 * - Bot participant maps to 'assistant' role
 * - Prefixes messages with participant names for context
 * - Native Anthropic tool API
 *
 * Use AnthropicChatAdapter for simple two-party Human/Assistant conversations.
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
import { fromAnthropicContent } from './anthropic.js';

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface AnthropicMultiuserAdapterConfig {
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;

  /** Base URL override */
  baseURL?: string;

  /** Default max tokens */
  defaultMaxTokens?: number;

  /**
   * Bot/assistant participant name (default: 'Claude')
   * Messages with this participant become 'assistant' role (no name prefix).
   */
  assistantParticipant?: string;

  /**
   * Whether to prefix user messages with participant names (default: true)
   * When true: "Alice: Hello there"
   * When false: "Hello there"
   */
  includeParticipantNames?: boolean;

  /**
   * Format for participant name prefix (default: '{name}: ')
   * Use {name} as placeholder for participant name.
   */
  nameFormat?: string;
}

// ============================================================================
// Anthropic Multiuser Adapter
// ============================================================================

export class AnthropicMultiuserAdapter implements ProviderAdapter {
  readonly name = 'anthropic-multiuser';
  private client: Anthropic;
  private defaultMaxTokens: number;
  private assistantParticipant: string;
  private includeParticipantNames: boolean;
  private nameFormat: string;

  constructor(config: AnthropicMultiuserAdapterConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.assistantParticipant = config.assistantParticipant ?? 'Claude';
    this.includeParticipantNames = config.includeParticipantNames ?? true;
    this.nameFormat = config.nameFormat ?? '{name}: ';
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
   * - Bot messages become assistant role
   * - All other messages become user role with optional name prefix
   */
  private convertMessages(
    messages: Array<{ participant: string; content: ContentBlock[] }>
  ): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      const isAssistant = msg.participant === this.assistantParticipant;
      const role: 'user' | 'assistant' = isAssistant ? 'assistant' : 'user';

      // Convert content blocks
      const content: Anthropic.ContentBlockParam[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          let text = block.text;

          // Prefix with participant name for non-assistant messages
          if (!isAssistant && this.includeParticipantNames) {
            const prefix = this.nameFormat.replace('{name}', msg.participant);
            text = prefix + text;
          }

          const textBlock: any = { type: 'text', text };
          if (block.cache_control) {
            textBlock.cache_control = block.cache_control;
          }
          content.push(textBlock);
        } else if (block.type === 'image' && block.source.type === 'base64') {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: block.source.data,
            },
          });
        } else if (block.type === 'document') {
          content.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: block.source.mediaType as 'application/pdf',
              data: block.source.data,
            },
          });
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content),
            is_error: block.isError,
          });
        } else if (block.type === 'thinking') {
          content.push({
            type: 'thinking',
            thinking: block.thinking,
          } as any);
        }
      }

      result.push({ role, content });
    }

    // Anthropic requires alternating user/assistant messages
    // Merge consecutive same-role messages
    return this.mergeConsecutiveRoles(result);
  }

  /**
   * Merge consecutive messages with the same role.
   * Anthropic API requires strictly alternating user/assistant messages.
   */
  private mergeConsecutiveRoles(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length === 0) return [];

    const merged: Anthropic.MessageParam[] = [];
    let current: Anthropic.MessageParam = messages[0]!;

    for (let i = 1; i < messages.length; i++) {
      const next: Anthropic.MessageParam = messages[i]!;

      if (next.role === current.role) {
        // Merge content arrays
        const currentContent = Array.isArray(current.content) ? current.content : [{ type: 'text' as const, text: current.content }];
        const nextContent = Array.isArray(next.content) ? next.content : [{ type: 'text' as const, text: next.content }];
        current = {
          role: current.role,
          content: [...currentContent, ...nextContent],
        };
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
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
