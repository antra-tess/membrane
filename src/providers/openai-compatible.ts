/**
 * OpenAI-Compatible provider adapter
 * 
 * Generic adapter for any OpenAI-compatible API endpoint:
 * - Ollama (http://localhost:11434/v1)
 * - vLLM
 * - Together AI
 * - Groq
 * - Local inference servers
 * - Any other OpenAI-compatible endpoint
 * 
 * Uses the standard OpenAI chat completions format with tool_calls support.
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

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface OpenAICompatibleAdapterConfig {
  /** Base URL for the API (required, e.g., 'http://localhost:11434/v1') */
  baseURL: string;
  
  /** API key (optional for local servers) */
  apiKey?: string;
  
  /** Provider name for logging/identification (default: 'openai-compatible') */
  providerName?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
  
  /** Additional headers to include with requests */
  extraHeaders?: Record<string, string>;
}

// ============================================================================
// OpenAI-Compatible Adapter
// ============================================================================

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  private baseURL: string;
  private apiKey: string;
  private defaultMaxTokens: number;
  private extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleAdapterConfig) {
    if (!config.baseURL) {
      throw new Error('OpenAI-compatible adapter requires baseURL');
    }
    
    this.name = config.providerName ?? 'openai-compatible';
    this.baseURL = config.baseURL.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey ?? '';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  supportsModel(_modelId: string): boolean {
    // This is a generic adapter - it supports whatever the endpoint supports
    // Model routing should be handled at a higher level
    return true;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);
    options?.onRequest?.(openAIRequest);

    try {
      const response = await this.makeRequest(openAIRequest, options);
      return this.parseResponse(response, request.model, openAIRequest);
    } catch (error) {
      throw this.handleError(error, openAIRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);
    openAIRequest.stream = true;
    options?.onRequest?.(openAIRequest);

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openAIRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let finishReason = 'stop';
      let toolCalls: OpenAIToolCall[] = [];

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
          } catch {
            // Ignore parse errors in stream
          }
        }
      }

      // Build response with accumulated data
      const message: OpenAIMessage = {
        role: 'assistant',
        content: accumulated || null,
      };

      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, request.model, openAIRequest);

    } catch (error) {
      throw this.handleError(error, openAIRequest);
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    
    // Only add Authorization header if we have an API key
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    return headers;
  }

  private buildRequest(request: ProviderRequest): any {
    const messages = this.convertMessages(request.messages as any[]);
    
    // Handle system prompt (same as openrouter.ts)
    if (request.system) {
      if (typeof request.system === 'string') {
        messages.unshift({ role: 'system' as const, content: request.system });
      } else if (Array.isArray(request.system)) {
        const text = (request.system as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        if (text) {
          messages.unshift({ role: 'system' as const, content: text });
        }
      }
    }
    
    const params: any = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
    };
    
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      params.top_p = request.topP;
    }

    if (request.presencePenalty !== undefined) {
      params.presence_penalty = request.presencePenalty;
    }

    if (request.frequencyPenalty !== undefined) {
      params.frequency_penalty = request.frequencyPenalty;
    }

    // OpenAI-compatible APIs may limit stop sequences (OpenAI: 4) — truncate to be safe
    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop = request.stopSequences.slice(0, 4);
    }
    
    if (request.tools && request.tools.length > 0) {
      params.tools = this.convertTools(request.tools as any[]);
    }
    
    // Apply extra params (filter out internal membrane fields)
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(params, rest);
    }
    
    return params;
  }

  private convertMessages(messages: any[]): OpenAIMessage[] {
    // Use flatMap to handle one-to-many expansion (multiple tool_results → multiple messages)
    return messages.flatMap(msg => {
      // If it's already in OpenAI format, pass through
      if (msg.role && (typeof msg.content === 'string' || msg.content === null || msg.tool_calls)) {
        return [msg as OpenAIMessage];
      }
      
      // Convert from Anthropic-style format
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: OpenAIMessage[] = [];
        
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
        
        // Skip messages with no usable content (image-only, embed-only messages)
        if (textParts.length === 0 && toolCalls.length === 0) {
          return [];
        }

        // Otherwise build normal message
        const result: OpenAIMessage = {
          role: msg.role,
          content: textParts.length > 0 ? textParts.join('\n') : null,
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

  private convertTools(tools: any[]): OpenAITool[] {
    return tools.map(tool => {
      // Handle different input formats
      const inputSchema = tool.inputSchema || tool.input_schema || { type: 'object', properties: {} };
      
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: inputSchema,
        },
      };
    });
  }

  private async makeRequest(request: any, options?: ProviderRequestOptions): Promise<OpenAIResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} ${errorText}`);
    }
    
    return response.json() as Promise<OpenAIResponse>;
  }

  private parseResponse(response: OpenAIResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private parseStreamedResponse(
    message: OpenAIMessage,
    finishReason: string,
    requestedModel: string,
    rawRequest?: unknown
  ): ProviderResponse {
    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      stopSequence: undefined,
      usage: {
        inputTokens: 0, // Not available in streaming
        outputTokens: 0,
      },
      model: requestedModel,
      rawRequest,
      raw: { message, finish_reason: finishReason },
    };
  }

  private messageToContent(message: OpenAIMessage | undefined): ContentBlock[] {
    if (!message) return [];
    
    const content: ContentBlock[] = [];
    
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

      if (message.includes('401') || message.includes('auth') || message.includes('Unauthorized')) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long') || message.includes('maximum context')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (message.includes('500') || message.includes('502') || message.includes('503')) {
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
 * Convert normalized content blocks to OpenAI message format
 */
export function toOpenAIMessages(
  messages: { role: string; content: ContentBlock[] }[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  
  for (const msg of messages) {
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
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
      const message: OpenAIMessage = {
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
 * Convert OpenAI response message to normalized content blocks
 */
export function fromOpenAIMessage(message: OpenAIMessage): ContentBlock[] {
  const result: ContentBlock[] = [];
  
  if (message.content) {
    result.push({ type: 'text', text: message.content });
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

