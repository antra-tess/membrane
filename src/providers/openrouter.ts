/**
 * OpenRouter provider adapter
 * 
 * Handles OpenAI-compatible API with tool_calls format
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  ContentBlock,
  ToolDefinition,
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
// Types
// ============================================================================

/** Content block for Anthropic-style caching through OpenRouter */
interface OpenRouterContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Can be string, null, or content blocks array (for Claude cache_control) */
  content?: string | null | OpenRouterContentBlock[];
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
}

interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: OpenRouterMessage;
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Anthropic prompt caching (when using Claude models with cache_control) */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /** OpenAI-style prompt caching details */
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface OpenRouterAdapterConfig {
  /** API key (defaults to OPENROUTER_API_KEY env var) */
  apiKey?: string;
  
  /** Base URL (default: https://openrouter.ai/api/v1) */
  baseURL?: string;
  
  /** HTTP Referer header for OpenRouter */
  httpReferer?: string;
  
  /** X-Title header for OpenRouter */
  xTitle?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// OpenRouter Adapter
// ============================================================================

export class OpenRouterAdapter implements ProviderAdapter {
  readonly name = 'openrouter';
  private apiKey: string;
  private baseURL: string;
  private httpReferer: string;
  private xTitle: string;
  private defaultMaxTokens: number;

  constructor(config: OpenRouterAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.baseURL = config.baseURL ?? 'https://openrouter.ai/api/v1';
    this.httpReferer = config.httpReferer ?? 'https://membrane.local';
    this.xTitle = config.xTitle ?? 'Membrane';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    // OpenRouter supports many models
    return modelId.includes('/');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openRouterRequest = this.buildRequest(request);
    options?.onRequest?.(openRouterRequest);

    try {
      const response = await this.makeRequest(openRouterRequest, options);
      return this.parseResponse(response, request.model, openRouterRequest);
    } catch (error) {
      throw this.handleError(error, openRouterRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openRouterRequest = this.buildRequest(request);
    openRouterRequest.stream = true;
    // Request usage data in stream for cache metrics
    openRouterRequest.stream_options = { include_usage: true };
    options?.onRequest?.(openRouterRequest);

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openRouterRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let finishReason = 'stop';
      let toolCalls: OpenRouterToolCall[] = [];
      let streamUsage: OpenRouterResponse['usage'] | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              accumulated += delta.content;
              callbacks.onChunk(delta.content);
            }

            // Handle streaming tool calls
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;
                if (!toolCalls[index]) {
                  toolCalls[index] = {
                    id: tc.id ?? '',
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) toolCalls[index].id = tc.id;
                if (tc.function?.name) toolCalls[index].function.name = tc.function.name;
                if (tc.function?.arguments) {
                  toolCalls[index].function.arguments += tc.function.arguments;
                }
              }
            }

            if (parsed.choices?.[0]?.finish_reason) {
              finishReason = parsed.choices[0].finish_reason;
            }

            // Capture usage data (comes in final chunk when stream_options.include_usage is set)
            if (parsed.usage) {
              streamUsage = parsed.usage;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      // Build response with accumulated data
      const message: OpenRouterMessage = {
        role: 'assistant',
        content: accumulated || null,
      };

      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, request.model, streamUsage, openRouterRequest);

    } catch (error) {
      throw this.handleError(error, openRouterRequest);
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.httpReferer,
      'X-Title': this.xTitle,
    };
  }

  private buildRequest(request: ProviderRequest): any {
    const messages = this.convertMessages(request.messages as any[]);
    
    const params: any = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
    };
    
    // Handle system prompt (can be string or content blocks with cache_control)
    if (request.system) {
      if (typeof request.system === 'string') {
        // Simple string system prompt - prepend as system message
        messages.unshift({ role: 'system' as const, content: request.system });
      } else if (Array.isArray(request.system)) {
        // Content blocks with potential cache_control - preserve for Claude caching
        const hasCache = (request.system as any[]).some((block: any) => block.cache_control);
        if (hasCache) {
          // Preserve cache_control in content block format for Claude
          messages.unshift({
            role: 'system' as const,
            content: request.system as unknown as OpenRouterContentBlock[],
          });
        } else {
          // No caching, just join text
          const text = (request.system as any[])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
          messages.unshift({ role: 'system' as const, content: text });
        }
      }
    }
    
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    
    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop = request.stopSequences;
    }
    
    if (request.tools && request.tools.length > 0) {
      // Check if tools are already in OpenRouter format (from buildNativeToolRequest)
      const firstTool = request.tools[0] as any;
      if (firstTool.input_schema) {
        // Already in provider format
        params.tools = request.tools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      } else if (firstTool.inputSchema) {
        // In ToolDefinition format
        params.tools = this.convertTools(request.tools as ToolDefinition[]);
      } else {
        // Unknown format, pass through
        params.tools = request.tools;
      }
    }
    
    // Apply extra params (filter out internal membrane fields)
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(params, rest);
    }
    
    return params;
  }

  private convertMessages(messages: any[]): OpenRouterMessage[] {
    // Use flatMap to handle one-to-many expansion (multiple tool_results → multiple messages)
    return messages.flatMap(msg => {
      // If it's already in OpenRouter format, pass through
      if (msg.role && (typeof msg.content === 'string' || msg.content === null || msg.tool_calls)) {
        return [msg as OpenRouterMessage];
      }
      
      // Convert from Anthropic-style format
      if (Array.isArray(msg.content)) {
        // Check if any block has cache_control - if so, preserve the array format
        // This is needed for Claude models through OpenRouter to use prompt caching
        const hasCache = msg.content.some((block: any) => block.cache_control);
        
        const toolCalls: OpenRouterToolCall[] = [];
        const contentBlocks: OpenRouterContentBlock[] = [];
        const textParts: string[] = [];
        const toolResults: OpenRouterMessage[] = [];
        
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (hasCache) {
              // Preserve cache_control in content block format
              const contentBlock: OpenRouterContentBlock = {
                type: 'text',
                text: block.text,
              };
              if (block.cache_control) {
                contentBlock.cache_control = block.cache_control;
              }
              contentBlocks.push(contentBlock);
            } else {
              textParts.push(block.text);
            }
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          } else if (block.type === 'tool_result') {
            // Collect ALL tool results - each becomes a separate message
            toolResults.push({
              role: 'tool' as const,
              tool_call_id: block.tool_use_id || block.toolUseId,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          }
        }
        
        // If we have tool results, return them (possibly multiple)
        if (toolResults.length > 0) {
          return toolResults;
        }
        
        // Otherwise build normal message
        const result: OpenRouterMessage = {
          role: msg.role,
          // Use content blocks array if caching is in use, otherwise concatenate text
          content: hasCache ? contentBlocks : (textParts.join('\n') || null),
        };
        
        if (toolCalls.length > 0) {
          result.tool_calls = toolCalls;
        }
        
        return [result];
      }
      
      return [{
        role: msg.role,
        content: msg.content,
      }];
    });
  }

  private convertTools(tools: ToolDefinition[]): OpenRouterTool[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private async makeRequest(request: any, options?: ProviderRequestOptions): Promise<OpenRouterResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter error: ${response.status} ${errorText}`);
    }
    
    return response.json() as Promise<OpenRouterResponse>;
  }

  private parseResponse(response: OpenRouterResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    // Extract cache tokens - OpenRouter passes through both Anthropic and OpenAI caching
    // Anthropic: cache_creation_input_tokens, cache_read_input_tokens
    // OpenAI: prompt_tokens_details.cached_tokens
    const cacheCreationTokens = response.usage?.cache_creation_input_tokens;
    const cacheReadTokens = response.usage?.cache_read_input_tokens
      ?? response.usage?.prompt_tokens_details?.cached_tokens;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? undefined,
        cacheReadTokens: cacheReadTokens ?? undefined,
      },
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private parseStreamedResponse(
    message: OpenRouterMessage,
    finishReason: string,
    requestedModel: string,
    streamUsage?: OpenRouterResponse['usage'],
    rawRequest?: unknown
  ): ProviderResponse {
    // Extract cache tokens if available from stream usage
    const cacheCreationTokens = streamUsage?.cache_creation_input_tokens;
    const cacheReadTokens = streamUsage?.cache_read_input_tokens
      ?? streamUsage?.prompt_tokens_details?.cached_tokens;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      stopSequence: undefined,
      usage: {
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? undefined,
        cacheReadTokens: cacheReadTokens ?? undefined,
      },
      model: requestedModel,
      rawRequest,
      raw: { message, finish_reason: finishReason, usage: streamUsage },
    };
  }

  private messageToContent(message: OpenRouterMessage | undefined): any {
    if (!message) return [];
    
    const content: any[] = [];
    
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    }
    
    return content;
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      case 'content_filter':
        return 'refusal';
      default:
        return 'end_turn';
    }
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('429') || message.includes('rate')) {
        return rateLimitError(message, undefined, error, rawRequest);
      }

      if (message.includes('401') || message.includes('auth')) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (message.includes('500') || message.includes('502') || message.includes('503')) {
        return serverError(message, undefined, error, rawRequest);
      }

      if (error.name === 'AbortError') {
        return abortError(undefined, rawRequest);
      }

      if (message.includes('network') || message.includes('fetch')) {
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
 * Convert normalized content blocks to OpenRouter format
 */
export function toOpenRouterMessages(
  messages: { role: string; content: ContentBlock[] }[]
): OpenRouterMessage[] {
  const result: OpenRouterMessage[] = [];
  
  for (const msg of messages) {
    const textParts: string[] = [];
    const toolCalls: OpenRouterToolCall[] = [];
    const toolResults: { id: string; content: string }[] = [];
    
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          id: block.toolUseId,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }
    
    // Add main message
    if (textParts.length > 0 || toolCalls.length > 0) {
      const message: OpenRouterMessage = {
        role: msg.role as 'user' | 'assistant',
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      result.push(message);
    }
    
    // Add tool results as separate messages
    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.id,
        content: tr.content,
      });
    }
  }
  
  return result;
}

/**
 * Convert OpenRouter response to normalized content blocks
 */
export function fromOpenRouterMessage(message: OpenRouterMessage): ContentBlock[] {
  const result: ContentBlock[] = [];
  
  if (message.content) {
    if (typeof message.content === 'string') {
      result.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      // Content blocks array - extract text (cache_control is for requests only)
      for (const block of message.content) {
        if (block.type === 'text') {
          result.push({ type: 'text', text: block.text });
        }
      }
    }
  }
  
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      result.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }
  
  return result;
}

