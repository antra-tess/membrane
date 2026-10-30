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
  UsageCacheConvention,
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
import { convertMcpMedia } from '../utils/mcp-media.js';
import { toolUseInputFromText, textOnlyToolResultContent, openAIImagePart, createCombinedSignal, SSELineParser, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved, streamedToolCalls, isEventObject, callerAbort } from './utils.js';

/** Content block for messages through OpenRouter */
type OpenRouterContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

/**
 * OpenRouter's documented `format` values for an `input_audio` part: wav,
 * mp3, aiff, aac, ogg, flac, m4a, pcm16, pcm24.
 */
function audioMimeToFormat(mimeType: string): string | undefined {
  switch (mimeType.split(';')[0]!.trim().toLowerCase()) {
    case 'audio/mpeg':
    case 'audio/mp3':
    case 'audio/mpeg3':      // legacy MP3 aliases some clients (e.g. Discord) report
    case 'audio/x-mpeg-3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/vnd.wave':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    case 'audio/aac':
      return 'aac';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    default:
      return undefined;
  }
}

interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Can be string, null, or content blocks array (for Claude cache_control / images) */
  content?: string | null | OpenRouterContentBlock[];
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
  /** Image-generation responses can carry images beside content. */
  images?: Array<{ image_url: { url: string } }>;
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
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

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

/**
 * OpenRouter passes the routed provider's usage payload through, so an
 * Anthropic-routed call reports `cache_read_input_tokens` and
 * `cache_creation_input_tokens` (disjoint from prompt_tokens) while an
 * OpenAI-routed one reports `prompt_tokens_details.cached_tokens` (a subset
 * of it).
 */
function resolveRoutedCacheConvention(
  anthropicShapedCacheRead: number | undefined,
  anthropicShapedCacheWrite: number | undefined,
  resolvedCacheRead: number | undefined,
): UsageCacheConvention | undefined {
  if (anthropicShapedCacheRead != null || anthropicShapedCacheWrite != null) return 'cache-excluded';
  return resolvedCacheRead != null ? 'cache-inclusive' : undefined;
}

const OPENAI_MAX_STOP_SEQUENCES = 4;

export class OpenRouterAdapter implements ProviderAdapter {
  readonly name = 'openrouter';

  /**
   * OpenRouter fronts BOTH conventions: it passes through Anthropic's
   * `cache_read_input_tokens` and `cache_creation_input_tokens`
   * (cache-excluded) or OpenAI's `prompt_tokens_details.cached_tokens`
   * (cache-inclusive) depending on which provider it routed to. The
   * convention is therefore a per-response fact — each parse sets
   * `usage.cacheConvention` from the fields it actually read, and this
   * adapter-level value is only the no-cache-tokens fallback.
   */
  readonly usageCacheConvention = 'unknown' as const;
  /** A tool result goes as a `role: 'tool'` message with string content, which carries no cache_control. */
  readonly sendsToolResultCacheMarkers = false;
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
    return modelId.includes('/');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openRouterRequest = this.buildRequest(request);
    assertMessagePrefillSupported(openRouterRequest.model, openRouterRequest.messages, options, this.name, openRouterRequest);
    options?.onRequest?.(openRouterRequest);

    try {
      const response = await this.makeRequest(openRouterRequest, options);
      return this.parseResponse(response, request.model, openRouterRequest);
    } catch (error) {
      throw callerAbort(options?.signal, error, openRouterRequest) ?? this.handleError(error, openRouterRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openRouterRequest = this.buildRequest(request);
    openRouterRequest.stream = true;
    openRouterRequest.stream_options = { include_usage: true };
    assertMessagePrefillSupported(openRouterRequest.model, openRouterRequest.messages, options, this.name, openRouterRequest);
    options?.onRequest?.(openRouterRequest);

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(openRouterRequest),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), openRouterRequest);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      const sseParser = new SSELineParser();
      const contentParts: OpenRouterContentBlock[] = [];
      const readImageUrl = createImageUrlReader();
      let finishReason: string | undefined;
      let sawTerminalEvent = false;
      const toolCalls = streamedToolCalls();
      let streamUsage: OpenRouterResponse['usage'] | undefined;
      // The model the provider served, echoed on every SSE chunk.
      let servedModel: string | undefined;

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

        // OpenRouter delivers mid-stream failures (e.g. upstream 429s) as an SSE
        // data line with an `error` payload.
        throwOnStreamErrorFrame(parsed, 'OpenRouter', openRouterRequest);

        const delta = parsed.choices?.[0]?.delta;

        const appendPart = (part: unknown): void => {
          if (!part || typeof part !== 'object') return;
          const block = part as { type?: unknown; text?: unknown };
          if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            const previous = contentParts[contentParts.length - 1];
            if (previous?.type === 'text') previous.text += block.text;
            else contentParts.push({ type: 'text', text: block.text });
            callbacks.onChunk(block.text);
          } else if (block.type === 'image_url') {
            const url = readImageUrl(part);
            if (url === undefined) return;
            contentParts.push(part as OpenRouterContentBlock);
            callbacks.onContentBlock?.(contentParts.length - 1, imageFromUrl(url));
          }
        };
        if (typeof delta?.content === 'string' && delta.content) {
          appendPart({ type: 'text', text: delta.content });
        } else if (Array.isArray(delta?.content)) {
          for (const part of delta.content) appendPart(part);
        }
        if (Array.isArray(delta?.images)) {
          for (const image of delta.images) {
            appendPart({ type: 'image_url', image_url: image?.image_url });
          }
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

        if (parsed.model) {
          servedModel = parsed.model;
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

      assertTerminalEventObserved(sawTerminalEvent, 'OpenRouter', openRouterRequest);

      const message: OpenRouterMessage = {
        role: 'assistant',
        content: contentParts.some(part => part.type === 'image_url')
          ? contentParts
          : contentParts.filter(part => part.type === 'text').map(part => part.text).join('') || null,
      };

      // A provider's tool-call index can skip a slot.
      const placedToolCalls = toolCalls.calls();
      if (placedToolCalls.length > 0) {
        message.tool_calls = placedToolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, servedModel ?? request.model, streamUsage, openRouterRequest);

    } catch (error) {
      throw callerAbort(options?.signal, error, openRouterRequest) ?? this.handleError(error, openRouterRequest);
    } finally {
      cleanup?.();
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
    const messages = this.convertMessages(convertMcpMedia(request.messages as any[]));
    
    const params: any = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
    };
    
    if (request.system) {
      if (typeof request.system === 'string') {
        messages.unshift({ role: 'system' as const, content: request.system });
      } else if (Array.isArray(request.system)) {
        const hasCache = (request.system as any[]).some((block: any) => block.cache_control);
        if (hasCache) {
          messages.unshift({
            role: 'system' as const,
            content: request.system as unknown as OpenRouterContentBlock[],
          });
        } else {
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

    // Anthropic models (routed via OpenRouter) reject both temperature and top_p.
    const isAnthropicModel = /claude|anthropic/i.test(request.model);
    if (request.topP !== undefined && !(isAnthropicModel && request.temperature !== undefined)) {
      params.top_p = request.topP;
    }

    if (request.presencePenalty !== undefined) {
      params.presence_penalty = request.presencePenalty;
    }

    if (request.frequencyPenalty !== undefined) {
      params.frequency_penalty = request.frequencyPenalty;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop = request.stopSequences.slice(0, OPENAI_MAX_STOP_SEQUENCES);
    }
    
    if (request.tools && request.tools.length > 0) {
      const firstTool = request.tools[0] as any;
      if (firstTool.input_schema) {
        params.tools = request.tools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      } else if (firstTool.inputSchema) {
        params.tools = this.convertTools(request.tools as ToolDefinition[]);
      } else {
        params.tools = request.tools;
      }
    }
    
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(params, rest);
    }
    
    return params;
  }

  private convertMessages(messages: any[]): OpenRouterMessage[] {
    return messages.flatMap(msg => {
      if (msg.role && (typeof msg.content === 'string' || msg.content === null || msg.tool_calls)) {
        return [msg as OpenRouterMessage];
      }
      
      if (Array.isArray(msg.content)) {
        // Claude models through OpenRouter cache only with cache_control on array content blocks.
        const hasCache = msg.content.some((block: any) => block.cache_control);

        const toolCalls: OpenRouterToolCall[] = [];
        const contentBlocks: OpenRouterContentBlock[] = [];
        const textParts: string[] = [];
        const toolResults: OpenRouterMessage[] = [];
        let hasImages = false;
        let hasAudio = false;

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (isRawItemCarrier(block)) continue;
            if (hasCache || hasImages || hasAudio) {
              const contentBlock: OpenRouterContentBlock = {
                type: 'text',
                text: block.text,
              };
              if (block.cache_control) {
                (contentBlock as any).cache_control = block.cache_control;
              }
              contentBlocks.push(contentBlock);
            } else {
              textParts.push(block.text);
            }
          } else if (block.type === 'image') {
            hasImages = true;
            for (const text of textParts) {
              contentBlocks.push({ type: 'text', text });
            }
            textParts.length = 0;

            const part = openAIImagePart(block.source);
            if (part) contentBlocks.push(part);
          } else if (block.type === 'audio') {
            // OpenRouter takes audio as an OpenAI-style `input_audio` part in array
            // content, raw base64 with no data-URI prefix.
            hasAudio = true;
            for (const text of textParts) {
              contentBlocks.push({ type: 'text', text });
            }
            textParts.length = 0;

            if (block.source?.type === 'base64' && block.source.data) {
              const mediaType = block.source.mediaType ?? block.source.media_type ?? 'audio/mpeg';
              const format = audioMimeToFormat(mediaType);
              if (format) {
                contentBlocks.push({
                  type: 'input_audio',
                  input_audio: { data: block.source.data, format },
                });
              } else {
                console.warn(
                  `[membrane:openrouter] Skipping audio block with unsupported MIME type "${mediaType}" ` +
                  `(no OpenRouter input_audio format mapping)`
                );
              }
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
              role: 'tool' as const,
              tool_call_id: block.tool_use_id || block.toolUseId,
              content: textOnlyToolResultContent(block.content),
            });
          }
        }

        if (toolResults.length > 0) {
          const interloperText = textParts.join('\n');
          if (contentBlocks.length > 0) {
            return [
              ...toolResults,
              { role: 'user' as const, content: contentBlocks },
            ];
          }
          if (interloperText) {
            return [
              ...toolResults,
              { role: 'user' as const, content: interloperText },
            ];
          }
          return toolResults;
        }

        if (textParts.length === 0 && contentBlocks.length === 0 && toolCalls.length === 0) {
          return [];
        }

        const useArray = hasCache || hasImages || hasAudio;
        const result: OpenRouterMessage = {
          role: msg.role,
          content: useArray ? contentBlocks : (textParts.length > 0 ? textParts.join('\n') : null),
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
      throwOnStreamErrorFrame(body, 'OpenRouter', request, 'response error');
      return body as OpenRouterResponse;
    } finally {
      cleanup?.();
    }
  }

  private parseResponse(response: OpenRouterResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    const cacheCreationTokens = response.usage?.cache_creation_input_tokens;
    const anthropicShapedCacheRead = response.usage?.cache_read_input_tokens;
    const cacheReadTokens = anthropicShapedCacheRead
      ?? response.usage?.prompt_tokens_details?.cached_tokens;
    const cacheConvention = resolveRoutedCacheConvention(anthropicShapedCacheRead, cacheCreationTokens, cacheReadTokens);

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      providerStopReason: choice?.finish_reason ?? undefined,
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? undefined,
        cacheReadTokens: cacheReadTokens ?? undefined,
        cacheConvention,
      },
      ...unreportedUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private parseStreamedResponse(
    message: OpenRouterMessage,
    finishReason: string | undefined,
    requestedModel: string,
    streamUsage?: OpenRouterResponse['usage'],
    rawRequest?: unknown
  ): ProviderResponse {
    const cacheCreationTokens = streamUsage?.cache_creation_input_tokens;
    const anthropicShapedCacheRead = streamUsage?.cache_read_input_tokens;
    const cacheReadTokens = anthropicShapedCacheRead
      ?? streamUsage?.prompt_tokens_details?.cached_tokens;
    const cacheConvention = resolveRoutedCacheConvention(anthropicShapedCacheRead, cacheCreationTokens, cacheReadTokens);

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      providerStopReason: finishReason,
      stopSequence: undefined,
      usage: {
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? undefined,
        cacheReadTokens: cacheReadTokens ?? undefined,
        cacheConvention,
      },
      ...unreportedUsage(streamUsage?.prompt_tokens, streamUsage?.completion_tokens),
      model: requestedModel,
      rawRequest,
      raw: { message, finish_reason: finishReason ?? 'stop', usage: streamUsage },
    };
  }

  private messageToContent(message: OpenRouterMessage | undefined): ContentBlock[] {
    return message ? fromOpenRouterMessage(message) : [];
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
        if (isRawItemCarrier(block)) continue;
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
          content: textOnlyToolResultContent(block.content),
        });
      }
    }
    
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

function createImageUrlReader(): (entry: unknown) => string | undefined {
  let warned = false;
  return (entry) => {
    const url = (entry as { image_url?: { url?: unknown } } | null)?.image_url?.url;
    if (typeof url === 'string') return url;
    if (!warned) {
      warned = true;
      console.warn('[membrane:openrouter] skipped image entry: expected a string image_url.url');
    }
    return undefined;
  };
}

function imageFromUrl(url: string): ContentBlock {
  const inline = /^data:([^,]*),([\s\S]*)$/i.exec(url);
  const [mediaType, ...parameters] = inline?.[1]?.split(';') ?? [];
  const base64 = mediaType && parameters.some(parameter => parameter.toLowerCase() === 'base64');
  return {
    type: 'image',
    source: inline && base64
      ? { type: 'base64', mediaType, data: inline[2]! }
      : { type: 'url', url },
  };
}

/**
 * Convert OpenRouter response to normalized content blocks
 */
export function fromOpenRouterMessage(message: OpenRouterMessage): ContentBlock[] {
  const result: ContentBlock[] = [];
  const readImageUrl = createImageUrlReader();
  
  if (message.content) {
    if (typeof message.content === 'string') {
      result.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          result.push({ type: 'text', text: block.text });
        } else if (block?.type === 'image_url') {
          const url = readImageUrl(block);
          if (url !== undefined) result.push(imageFromUrl(url));
        }
      }
    }
  }
  
  if (Array.isArray(message.images)) {
    for (const image of message.images) {
      const url = readImageUrl(image);
      if (url !== undefined) result.push(imageFromUrl(url));
    }
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

