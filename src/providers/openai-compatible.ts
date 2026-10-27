import { unreportedUsage } from '../utils/usage.js';
import { assertMessagePrefillSupported } from './request-capabilities.js';

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
  errorFromHttpResponse,
  isTypedAbortError,
  withRawRequest,
} from '../types/index.js';
import { errorFromThrown } from '../types/errors.js';
import { isRawItemCarrier } from '../utils/fidelity.js';
import { toolUseInputFromText, textOnlyToolResultContent, openAIImagePart, createCombinedSignal, SSELineParser, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved, streamedToolCalls, isEventObject } from './utils.js';
import { requiresCompletionTokens, noTemperatureSupport, noStopSupport } from './openai.js';
import { convertMcpMedia } from '../utils/mcp-media.js';

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
  /** Same trace under the DeepSeek spelling, used e.g. by Xiaomi's official
   *  MiMo API in both messages and stream deltas. Read as an alias of
   *  `reasoning`; `reasoning` wins when a backend sends both, unless it is
   *  blank and `reasoning_content` isn't. */
  reasoning_content?: string;
  reasoning_details?: unknown;
}

function reasoningOf(m: { reasoning?: unknown; reasoning_content?: unknown } | undefined): string | undefined {
  const reasoning = typeof m?.reasoning === 'string' ? m.reasoning : undefined;
  const alias = typeof m?.reasoning_content === 'string' ? m.reasoning_content : undefined;
  if (reasoning && (reasoning.trim() || !alias?.trim())) return reasoning;
  return alias ?? reasoning;
}

/**
 * Some OpenRouter backends (e.g. Parasail, Io Net) spill the tail of the
 * reasoning plus the closing `</think>` into the `content` channel instead of
 * keeping it all in `reasoning`.
 */
function stripOrphanThinkClose(text: string): string {
  const close = text.indexOf('</think>');
  if (close === -1) return text;
  const open = text.indexOf('<think>');
  if (open !== -1 && open < close) return text;
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

const OPENAI_MAX_STOP_SEQUENCES = 4;

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;

  /**
   * NOT ESTABLISHED, and not establishable per-adapter: this fronts arbitrary
   * OpenAI-shaped third-party endpoints whose caching semantics vary by vendor.
   */
  readonly usageCacheConvention = 'unknown' as const;
  private baseURL: string;
  private apiKey: string;
  private defaultMaxTokens: number;
  private extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleAdapterConfig) {
    if (!config.baseURL) {
      throw new Error('OpenAI-compatible adapter requires baseURL');
    }
    
    this.name = config.providerName ?? 'openai-compatible';
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  supportsModel(_modelId: string): boolean {
    return true;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);
    assertMessagePrefillSupported(openAIRequest.model, openAIRequest.messages, options, this.name, openAIRequest);
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
    // Ask for usage in the stream — without this the endpoint sends no usage
    // frame at all and every streamed call reports 0/0 tokens.
    openAIRequest.stream_options = { include_usage: true };
    assertMessagePrefillSupported(openAIRequest.model, openAIRequest.messages, options, this.name, openAIRequest);
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
      let finishReason: string | undefined;
      let sawTerminalEvent = false;
      const toolCalls = streamedToolCalls();
      let streamUsage: OpenAIResponse['usage'] | undefined;

      const processDataLine = (data: string): void => {
        if (data === '[DONE]') {
          sawTerminalEvent = true;
          return;
        }

        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (!isEventObject(parsed)) return;
        options?.onProgress?.();

        throwOnStreamErrorFrame(parsed, this.name, openAIRequest);

        const delta = parsed.choices?.[0]?.delta;

        if (delta?.content) {
          accumulated += delta.content;
          callbacks.onChunk(delta.content);
        }

        // Reasoning-model trace arrives on its own channel (not `content`),
        // as `reasoning` or `reasoning_content` depending on the backend.
        const reasoningDelta = reasoningOf(delta);
        if (reasoningDelta !== undefined) {
          reasoning += reasoningDelta;
        }

        // Some providers send tool-call deltas without an index (antra-tess/membrane#159).
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) toolCalls.add(tc);
        }

        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
          sawTerminalEvent = true;
        }

        if (parsed.usage) {
          streamUsage = parsed.usage;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          for (const data of sseParser.feed(chunk)) {
            processDataLine(data);
          }
        }

        // A final `data:` line can arrive without its trailing newline: servers and
        // proxies close right after writing the last event.
        for (const data of sseParser.flush()) {
          processDataLine(data);
        }
      } finally {
        // An unread body holds the connection: cancel it, so the provider stops
        // sending. After a full read it does nothing.
        void reader.cancel().catch(() => {});
      }

      assertTerminalEventObserved(sawTerminalEvent, this.name, openAIRequest);

      const message: OpenAIMessage = {
        role: 'assistant',
        content: accumulated || null,
      };

      if (reasoning) message.reasoning = reasoning;

      const placedToolCalls = toolCalls.calls();
      if (placedToolCalls.length > 0) {
        message.tool_calls = placedToolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, request.model, streamUsage, openAIRequest);

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
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    return headers;
  }

  private buildRequest(request: ProviderRequest): any {
    const messages = this.convertMessages(convertMcpMedia(request.messages as any[]));
    
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
    
    // OpenAI's own models keep their parameter surface when reached through
    // this adapter (e.g. baseURL https://api.openai.com/v1): GPT-5+ and the
    // o-series reject `max_tokens` ("Use 'max_completion_tokens' instead") and
    // custom temperature/top_p, and some reject `stop`.
    const model = request.model;
    const maxTokens = request.maxTokens || this.defaultMaxTokens;
    const params: any = {
      model,
      messages,
      ...(requiresCompletionTokens(model)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
    };
    
    if (request.temperature !== undefined && !noTemperatureSupport(model)) {
      params.temperature = request.temperature;
    }

    if (request.topP !== undefined && !noTemperatureSupport(model)) {
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

    if (request.stopSequences && request.stopSequences.length > 0 && !noStopSupport(model)) {
      params.stop = request.stopSequences.slice(0, OPENAI_MAX_STOP_SEQUENCES);
    }
    
    if (request.tools && request.tools.length > 0) {
      params.tools = this.convertTools(request.tools as any[]);
    }
    
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(params, rest);
    }
    
    return params;
  }

  private convertMessages(messages: any[]): OpenAIMessage[] {
    return messages.flatMap(msg => {
      if (msg.role && (typeof msg.content === 'string' || msg.content === null || msg.tool_calls)) {
        return [msg as OpenAIMessage];
      }
      
      if (Array.isArray(msg.content)) {
        const contentParts: OpenAIContentPart[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: OpenAIMessage[] = [];
        let reasoningText = '';

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (isRawItemCarrier(block)) continue;
            contentParts.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            // OpenRouter accepts `reasoning` on a prior assistant turn.
            if (typeof block.thinking === 'string') {
              reasoningText += (reasoningText ? '\n' : '') + block.thinking;
            }
          } else if (block.type === 'image') {
            const part = openAIImagePart(block.source);
            if (part) contentParts.push(part);
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
              role: 'tool' as const,
              tool_call_id: block.tool_use_id || block.toolUseId,
              content: textOnlyToolResultContent(block.content),
            });
          }
        }

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

        if (contentParts.length === 0 && toolCalls.length === 0) {
          return [];
        }

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

      const body: unknown = await response.json();
      // A 200 can carry the provider's error, as a stream frame can.
      throwOnStreamErrorFrame(body, this.name, request, 'response error');
      return body as OpenAIResponse;
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
      providerStopReason: choice?.finish_reason ?? undefined,
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      ...unreportedUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private parseStreamedResponse(
    message: OpenAIMessage,
    finishReason: string | undefined,
    requestedModel: string,
    streamUsage?: OpenAIResponse['usage'],
    rawRequest?: unknown
  ): ProviderResponse {
    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      providerStopReason: finishReason,
      stopSequence: undefined,
      usage: {
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
      },
      ...unreportedUsage(streamUsage?.prompt_tokens, streamUsage?.completion_tokens),
      model: requestedModel,
      rawRequest,
      raw: { message, finish_reason: finishReason ?? 'stop', usage: streamUsage },
    };
  }

  private messageToContent(message: OpenAIMessage | undefined): ContentBlock[] {
    if (!message) return [];

    const content: ContentBlock[] = [];

    const reasoning = reasoningOf(message);
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
          ...toolUseInputFromText(tc.function.arguments),
        });
      }
    }
    
    return content;
  }

  private mapFinishReason(reason: string | undefined): string {
    if (reason == null) return 'end_turn';
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
        return reason;
    }
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (isDeadlineAbort(error)) return deadlineTimeoutError(error, rawRequest);
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    if (isTypedAbortError(error)) return abortError(undefined, rawRequest);

    return errorFromThrown(error, rawRequest, this.baseURL);
  }
}

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
        if (isRawItemCarrier(block)) continue;
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
          content: textOnlyToolResultContent(block.content),
        });
      }
    }
    
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

  const reasoning = reasoningOf(message);
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
        ...toolUseInputFromText(tc.function.arguments),
      });
    }
  }
  
  return result;
}

