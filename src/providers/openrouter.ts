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

interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | null;
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
    
    try {
      const response = await this.makeRequest(openRouterRequest, options);
      return this.parseResponse(response, request.model);
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openRouterRequest = this.buildRequest(request);
    openRouterRequest.stream = true;
    
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
      
      return this.parseStreamedResponse(message, finishReason, request.model);
      
    } catch (error) {
      throw this.handleError(error);
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
    
    // Apply extra params
    if (request.extra) {
      Object.assign(params, request.extra);
    }
    
    return params;
  }

  private convertMessages(messages: any[]): OpenRouterMessage[] {
    return messages.map(msg => {
      // If it's already in OpenRouter format, pass through
      if (msg.role && (typeof msg.content === 'string' || msg.content === null || msg.tool_calls)) {
        return msg as OpenRouterMessage;
      }
      
      // Convert from Anthropic-style format
      if (Array.isArray(msg.content)) {
        // Handle content blocks
        const textParts: string[] = [];
        const toolCalls: OpenRouterToolCall[] = [];
        
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
            // Tool results become separate messages
            return {
              role: 'tool' as const,
              tool_call_id: block.tool_use_id || block.toolUseId,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            };
          }
        }
        
        const result: OpenRouterMessage = {
          role: msg.role,
          content: textParts.join('\n') || null,
        };
        
        if (toolCalls.length > 0) {
          result.tool_calls = toolCalls;
        }
        
        return result;
      }
      
      return {
        role: msg.role,
        content: msg.content,
      };
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

  private parseResponse(response: OpenRouterResponse, requestedModel: string): ProviderResponse {
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
      raw: response,
    };
  }

  private parseStreamedResponse(
    message: OpenRouterMessage,
    finishReason: string,
    requestedModel: string
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
      raw: { message, finish_reason: finishReason },
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

  private handleError(error: unknown): MembraneError {
    if (error instanceof Error) {
      const message = error.message;
      
      if (message.includes('429') || message.includes('rate')) {
        return rateLimitError(message, undefined, error);
      }
      
      if (message.includes('401') || message.includes('auth')) {
        return authError(message, error);
      }
      
      if (message.includes('context') || message.includes('too long')) {
        return contextLengthError(message, error);
      }
      
      if (message.includes('500') || message.includes('502') || message.includes('503')) {
        return serverError(message, undefined, error);
      }
      
      if (error.name === 'AbortError') {
        return abortError();
      }
      
      if (message.includes('network') || message.includes('fetch')) {
        return networkError(message, error);
      }
    }
    
    return new MembraneError({
      type: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      rawError: error,
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
