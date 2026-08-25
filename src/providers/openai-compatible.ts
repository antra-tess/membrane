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
  abortError,
  classifyError,
  errorFromHttpResponse,
  isTypedAbortError,
  withRawRequest,
} from '../types/index.js';
import { safeParseJson, createCombinedSignal, SSELineParser } from './utils.js';

// ============================================================================
// Types
// ============================================================================

interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** Reasoning-model trace (OpenRouter et al. deliver this in a separate
   *  channel from `content`). Captured into a thinking block, and re-sent on
   *  prior assistant turns to preserve chain-of-thought. */
  reasoning?: string;
  reasoning_details?: unknown;
}

/**
 * Some OpenRouter backends (e.g. Parasail, Io Net) spill the tail of the
 * reasoning plus the closing `</think>` into the `content` channel instead of
 * keeping it all in `reasoning`. If a `</think>` appears with no matching
 * `<think>` before it, drop everything up to and including it — that prefix is
 * leaked reasoning, not answer text.
 */
function stripOrphanThinkClose(text: string): string {
  const close = text.indexOf('</think>');
  if (close === -1) return text;
  const open = text.indexOf('<think>');
  if (open !== -1 && open < close) return text; // well-formed inline block — leave it
  return text.slice(close + '</think>'.length).replace(/^\s+/, '');
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

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openAIRequest),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), openAIRequest);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      const sseParser = new SSELineParser();
      let accumulated = '';
      let reasoning = '';
      let finishReason = 'stop';
      let toolCalls: OpenAIToolCall[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const dataLines = sseParser.feed(chunk);

        for (const data of dataLines) {
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              accumulated += delta.content;
              callbacks.onChunk(delta.content);
            }

            // Reasoning-model trace arrives on its own channel (not `content`).
            if (typeof delta?.reasoning === 'string') {
              reasoning += delta.reasoning;
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

      if (reasoning) message.reasoning = reasoning;

      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, request.model, openAIRequest);

    } catch (error) {
      throw this.handleError(error, openAIRequest);
    } finally {
      cleanup?.();
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

    if (request.repetitionPenalty !== undefined) {
      params.repetition_penalty = request.repetitionPenalty;
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
        const contentParts: OpenAIContentPart[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: OpenAIMessage[] = [];
        let reasoningText = '';

        for (const block of msg.content) {
          if (block.type === 'text') {
            contentParts.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            // Round-trip the reasoning trace back to the provider (OpenRouter
            // accepts `reasoning` on a prior assistant turn), mirroring how the
            // Anthropic adapter re-feeds signed thinking blocks.
            if (typeof block.thinking === 'string') {
              reasoningText += (reasoningText ? '\n' : '') + block.thinking;
            }
          } else if (block.type === 'image') {
            // Convert Anthropic-style image to OpenAI image_url with data URI
            if (block.source?.type === 'base64') {
              const mediaType = block.source.media_type ?? block.source.mediaType ?? 'image/png';
              contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${block.source.data}` },
              });
            } else if (block.source?.type === 'url') {
              contentParts.push({
                type: 'image_url',
                image_url: { url: block.source.url },
              });
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

        // If we have tool results, emit them (possibly multiple) as
        // role:'tool' messages — plus a FOLLOWING user message for any other
        // content sharing the envelope (e.g. a mid-turn injected user message
        // that mergeConsecutiveRoles folded into the tool_result envelope),
        // instead of silently dropping it. Mirrors openai.ts / openrouter.ts.
        if (toolResults.length > 0) {
          const hasImagesInterloper = contentParts.some(p => p.type === 'image_url');
          const interloperText = hasImagesInterloper
            ? ''
            : contentParts.filter(p => p.type === 'text').map(p => p.text!).join('\n');
          if (hasImagesInterloper || interloperText) {
            return [
              ...toolResults,
              {
                role: 'user' as const,
                content: hasImagesInterloper ? contentParts : interloperText,
              },
            ];
          }
          return toolResults;
        }

        // Skip messages with no usable content
        if (contentParts.length === 0 && toolCalls.length === 0) {
          return [];
        }

        // Build message — use string content when there are no images (simpler, more compatible)
        const hasImages = contentParts.some(p => p.type === 'image_url');
        const textOnly = contentParts.filter(p => p.type === 'text').map(p => p.text!).join('\n');

        const result: OpenAIMessage = {
          role: msg.role,
          content: hasImages ? contentParts : (textOnly || null),
        };

        if (toolCalls.length > 0) {
          result.tool_calls = toolCalls;
        }

        if (reasoningText) {
          result.reasoning = reasoningText;
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
    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), request);
      }

      return await response.json() as OpenAIResponse;
    } finally {
      cleanup?.();
    }
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

    // Reasoning trace first (mirrors Anthropic thinking-block ordering).
    const reasoning = (message as OpenAIMessage).reasoning;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      content.push({ type: 'thinking', thinking: reasoning } as ContentBlock);
    }

    if (message.content) {
      const raw = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text!).join('\n');
      const text = stripOrphanThinkClose(raw);
      if (text) content.push({ type: 'text', text });
    }

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments),
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

  /**
   * HTTP failures are classified at the fetch boundary, where status,
   * headers and body are still live; this handles what is left — typed
   * aborts and non-HTTP throwables — through the shared last-resort table.
   */
  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    if (isTypedAbortError(error)) return abortError(undefined, rawRequest);

    const info = classifyError(error);
    info.rawRequest = rawRequest;
    return new MembraneError(info);
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
    let reasoningText = '';

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'thinking') {
        if (typeof (block as { thinking?: string }).thinking === 'string') {
          reasoningText += (reasoningText ? '\n' : '') + (block as { thinking: string }).thinking;
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
        toolResults.push({
          id: block.toolUseId,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }
    
    // Add main message
    if (textParts.length > 0 || toolCalls.length > 0 || reasoningText) {
      const message: OpenAIMessage = {
        role: msg.role as 'user' | 'assistant',
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      if (reasoningText) {
        message.reasoning = reasoningText;
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

  const reasoning = message.reasoning;
  if (typeof reasoning === 'string' && reasoning.trim()) {
    result.push({ type: 'thinking', thinking: reasoning } as ContentBlock);
  }

  if (message.content) {
    const raw = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text!).join('\n');
    const text = stripOrphanThinkClose(raw);
    if (text) result.push({ type: 'text', text });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      result.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments),
      });
    }
  }
  
  return result;
}

