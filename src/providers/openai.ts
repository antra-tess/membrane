/**
 * OpenAI Direct provider adapter
 * 
 * Direct adapter for OpenAI's API with support for modern models:
 * - GPT-4o, GPT-4 Turbo
 * - GPT-5, GPT-5-mini (uses max_completion_tokens)
 * - o1, o3, o4-mini reasoning models
 * 
 * Key differences from generic OpenAI-compatible:
 * - Uses max_completion_tokens for newer models (not max_tokens)
 * - Handles reasoning models' special requirements
 * - Direct API integration with proper error handling
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
    /** OpenAI prompt caching details (automatic for prompts ≥1024 tokens) */
    prompt_tokens_details?: {
      cached_tokens?: number;
      audio_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
    };
  };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface OpenAIAdapterConfig {
  /** API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  
  /** Base URL (default: https://api.openai.com/v1) - useful for Azure OpenAI */
  baseURL?: string;
  
  /** Organization ID (optional) */
  organization?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// Model Detection Helpers
// ============================================================================

/**
 * Models that require max_completion_tokens instead of max_tokens
 */
const COMPLETION_TOKENS_MODELS = [
  'gpt-5',
  'gpt-5-mini',
  'o1',
  'o1-mini',
  'o1-preview',
  'o3',
  'o3-mini',
  'o4-mini',
];

/**
 * Check if a model requires max_completion_tokens parameter
 */
function requiresCompletionTokens(model: string): boolean {
  return COMPLETION_TOKENS_MODELS.some(prefix => model.startsWith(prefix));
}

/**
 * Models that don't support custom temperature (only default 1.0)
 */
const NO_TEMPERATURE_MODELS = [
  'gpt-5',       // Base GPT-5 models
  'gpt-5-mini',
  'o1',          // Reasoning models
  'o1-mini',
  'o1-preview',
  'o3',
  'o3-mini',
  'o4-mini',
];

/**
 * Check if a model doesn't support custom temperature
 */
function noTemperatureSupport(model: string): boolean {
  return NO_TEMPERATURE_MODELS.some(prefix => model.startsWith(prefix));
}

/**
 * Models that don't support stop sequences (reasoning models)
 */
const NO_STOP_MODELS = [
  'o1',          // Reasoning models don't support stop sequences
  'o1-mini',
  'o1-preview',
  'o3',
  'o3-mini',
  'o4-mini',
];

/**
 * Check if a model doesn't support stop sequences
 */
function noStopSupport(model: string): boolean {
  return NO_STOP_MODELS.some(prefix => model.startsWith(prefix));
}

// ============================================================================
// OpenAI Adapter
// ============================================================================

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = 'openai';
  private apiKey: string;
  private baseURL: string;
  private organization?: string;
  private defaultMaxTokens: number;

  constructor(config: OpenAIAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = config.baseURL ?? 'https://api.openai.com/v1';
    this.organization = config.organization;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    
    if (!this.apiKey) {
      throw new Error('OpenAI API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    // OpenAI models typically start with gpt-, o1, o3, o4
    return (
      modelId.startsWith('gpt-') ||
      modelId.startsWith('o1') ||
      modelId.startsWith('o3') ||
      modelId.startsWith('o4')
    );
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);

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
    // Request usage data in stream for cache metrics
    openAIRequest.stream_options = { include_usage: true };

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openAIRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let finishReason = 'stop';
      let toolCalls: OpenAIToolCall[] = [];
      let streamUsage: OpenAIResponse['usage'] | undefined;

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

            // Capture usage data (comes in final chunk with stream_options.include_usage)
            if (parsed.usage) {
              streamUsage = parsed.usage;
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

      return this.parseStreamedResponse(message, finishReason, request.model, streamUsage, openAIRequest);

    } catch (error) {
      throw this.handleError(error, openAIRequest);
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }
    
    return headers;
  }

  private buildRequest(request: ProviderRequest): any {
    const messages = this.convertMessages(request.messages as any[]);
    const model = request.model;
    const maxTokens = request.maxTokens || this.defaultMaxTokens;
    
    const params: any = {
      model,
      messages,
    };
    
    // Use appropriate max tokens parameter based on model
    if (requiresCompletionTokens(model)) {
      params.max_completion_tokens = maxTokens;
    } else {
      params.max_tokens = maxTokens;
    }
    
    // Some models (gpt-5, o1, o3, o4) don't support custom temperature
    if (request.temperature !== undefined && !noTemperatureSupport(model)) {
      params.temperature = request.temperature;
    }
    
    // Reasoning models (o1, o3, o4) don't support stop sequences
    if (request.stopSequences && request.stopSequences.length > 0 && !noStopSupport(model)) {
      params.stop = request.stopSequences;
    }
    
    if (request.tools && request.tools.length > 0) {
      params.tools = this.convertTools(request.tools as any[]);
    }
    
    // Apply extra params (can override automatic choices)
    if (request.extra) {
      Object.assign(params, request.extra);
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
        
        // Otherwise build normal message
        const result: OpenAIMessage = {
          role: msg.role,
          content: textParts.join('\n') || null,
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
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }
    
    return response.json() as Promise<OpenAIResponse>;
  }

  private parseResponse(response: OpenAIResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    // Extract prompt caching details (OpenAI automatic caching for prompts ≥1024 tokens)
    const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        // OpenAI's automatic prompt caching - cached tokens are read from cache
        // Note: OpenAI doesn't have separate "creation" tokens - it's automatic
        cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
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
    streamUsage?: OpenAIResponse['usage'],
    rawRequest?: unknown
  ): ProviderResponse {
    // Extract cached tokens from stream usage if available
    const cachedTokens = streamUsage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      stopSequence: undefined,
      usage: {
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
        cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
      },
      model: requestedModel,
      rawRequest,
      raw: { message, finish_reason: finishReason, usage: streamUsage },
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

      // OpenAI specific error patterns
      if (message.includes('429') || message.includes('rate_limit')) {
        // Try to extract retry-after
        const retryMatch = message.match(/retry after (\d+)/i);
        const retryAfter = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : undefined;
        return rateLimitError(message, retryAfter, error, rawRequest);
      }

      if (message.includes('401') || message.includes('invalid_api_key') || message.includes('Incorrect API key')) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context_length') || message.includes('maximum context') || message.includes('too long')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('server_error')) {
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
export function toOpenAIContent(blocks: ContentBlock[]): string | null {
  const textBlocks = blocks.filter(b => b.type === 'text') as Array<{ type: 'text'; text: string }>;
  if (textBlocks.length === 0) return null;
  return textBlocks.map(b => b.text).join('\n');
}

/**
 * Convert OpenAI response message to normalized content blocks
 */
export function fromOpenAIContent(message: OpenAIMessage): ContentBlock[] {
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

