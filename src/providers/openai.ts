import { unreportedUsage } from '../utils/usage.js';
import { assertMessagePrefillSupported } from './request-capabilities.js';

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
  abortError,
  errorFromHttpResponse,
  isTypedAbortError,
  withRawRequest,
} from '../types/index.js';
import { errorFromThrown } from '../types/errors.js';
import { isRawItemCarrier } from '../utils/fidelity.js';
import { convertMcpMedia } from '../utils/mcp-media.js';
import { toolUseInputFromText, textOnlyToolResultContent, openAIImagePart, createCombinedSignal, SSELineParser, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved, streamedToolCalls, isEventObject, callerAbort } from './utils.js';

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

export interface OpenAIAdapterConfig {
  /** API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  
  /** Base URL (default: https://api.openai.com/v1) */
  baseURL?: string;
  
  /** Organization ID (optional) */
  organization?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
}

function gptGeneration(model: string): number | undefined {
  const m = /^gpt-(\d+)/.exec(model);
  return m ? Number(m[1]) : undefined;
}

/**
 * GPT-5 and every later generation share the reasoning-model parameter
 * surface (max_completion_tokens, default-only temperature/top_p, no stop);
 * a legacy parameter 400s at the wire: "Unsupported parameter: 'max_tokens'
 * is not supported with this model. Use 'max_completion_tokens' instead."
 */
function isReasoningGenerationGpt(model: string): boolean {
  const gen = gptGeneration(model);
  return gen !== undefined && gen >= 5;
}

const COMPLETION_TOKENS_MODELS = [
  'o1',
  'o1-mini',
  'o1-preview',
  'o3',
  'o3-mini',
  'o4-mini',
];

export function requiresCompletionTokens(model: string): boolean {
  return isReasoningGenerationGpt(model) || COMPLETION_TOKENS_MODELS.some(prefix => model.startsWith(prefix));
}

/**
 * Models that don't support custom temperature (only default 1.0)
 */
const NO_TEMPERATURE_MODELS = [
  'o1',
  'o1-mini',
  'o1-preview',
  'o3',
  'o3-mini',
  'o4-mini',
];

export function noTemperatureSupport(model: string): boolean {
  return isReasoningGenerationGpt(model) || NO_TEMPERATURE_MODELS.some(prefix => model.startsWith(prefix));
}

/** Models that don't support stop sequences; o1 and o3-mini do. */
const NO_STOP_MODELS = [
  'o3',          // o3 (full) doesn't support stop, but o3-mini does!
  'o4-mini',
];

export function noStopSupport(model: string): boolean {
  return isReasoningGenerationGpt(model) || NO_STOP_MODELS.some(prefix => model.startsWith(prefix));
}

const OPENAI_MAX_STOP_SEQUENCES = 4;

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = 'openai';

  /** `prompt_tokens` includes the cached span (`prompt_tokens_details.cached_tokens`): a SUBSET, not an addition. */
  readonly usageCacheConvention = 'cache-inclusive' as const;
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
    assertMessagePrefillSupported(openAIRequest.model, openAIRequest.messages, options, this.name, openAIRequest);
    options?.onRequest?.(openAIRequest);

    try {
      const response = await this.makeRequest(openAIRequest, options);
      return this.parseResponse(response, request.model, openAIRequest);
    } catch (error) {
      throw callerAbort(options?.signal, error, openAIRequest) ?? this.handleError(error, openAIRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const openAIRequest = this.buildRequest(request);
    openAIRequest.stream = true;
    // OpenAI streams usage, in the final chunk, only when include_usage asks for it.
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
      let finishReason: string | undefined;
      let sawTerminalEvent = false;
      const toolCalls = streamedToolCalls();
      let streamUsage: OpenAIResponse['usage'] | undefined;
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
          return; // Ignore parse errors (partial/keep-alive lines)
        }
        if (!isEventObject(parsed)) return;
        options?.onProgress?.();

        throwOnStreamErrorFrame(parsed, 'OpenAI', openAIRequest);

        const delta = parsed.choices?.[0]?.delta;

        if (delta?.content) {
          accumulated += delta.content;
          callbacks.onChunk(delta.content);
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

      assertTerminalEventObserved(sawTerminalEvent, 'OpenAI', openAIRequest);

      const message: OpenAIMessage = {
        role: 'assistant',
        content: accumulated || null,
      };

      // A provider's tool-call index can skip a slot.
      const placedToolCalls = toolCalls.calls();
      if (placedToolCalls.length > 0) {
        message.tool_calls = placedToolCalls;
      }

      return this.parseStreamedResponse(message, finishReason, servedModel ?? request.model, streamUsage, openAIRequest);

    } catch (error) {
      throw callerAbort(options?.signal, error, openAIRequest) ?? this.handleError(error, openAIRequest);
    } finally {
      cleanup?.();
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
    const messages = this.convertMessages(convertMcpMedia(request.messages as any[]));
    const model = request.model;
    const maxTokens = request.maxTokens || this.defaultMaxTokens;
    
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
      model,
      messages,
    };
    
    if (requiresCompletionTokens(model)) {
      params.max_completion_tokens = maxTokens;
    } else {
      params.max_tokens = maxTokens;
    }
    
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

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (isRawItemCarrier(block)) continue;
            contentParts.push({ type: 'text', text: block.text });
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
      throwOnStreamErrorFrame(body, 'OpenAI', request, 'response error');
      return body as OpenAIResponse;
    } finally {
      cleanup?.();
    }
  }

  private parseResponse(response: OpenAIResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      providerStopReason: choice?.finish_reason ?? undefined,
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        // OpenAI has no separate cache-creation count: its caching is automatic.
        ...(typeof cachedTokens === 'number' ? { cacheReadTokens: cachedTokens } : {}),
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
    const cachedTokens = streamUsage?.prompt_tokens_details?.cached_tokens;

    return {
      content: this.messageToContent(message),
      stopReason: this.mapFinishReason(finishReason),
      providerStopReason: finishReason,
      stopSequence: undefined,
      usage: {
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
        ...(typeof cachedTokens === 'number' ? { cacheReadTokens: cachedTokens } : {}),
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

    if (message.content) {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text!).join('\n');
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
 * Join normalized content's text blocks into OpenAI message content: their
 * text, joined by newlines; '' when every text block is a zero-width carrier,
 * and null when there is no text block.
 */
export function toOpenAIContent(blocks: ContentBlock[]): string | null {
  const textBlocks = blocks.filter(b => b.type === 'text' && !isRawItemCarrier(b)) as Array<{ type: 'text'; text: string }>;
  if (textBlocks.length === 0) return blocks.some(b => b.type === 'text') ? '' : null;
  return textBlocks.map(b => b.text).join('\n');
}

/**
 * Convert OpenAI response message to normalized content blocks
 */
export function fromOpenAIContent(message: OpenAIMessage): ContentBlock[] {
  const result: ContentBlock[] = [];

  if (message.content) {
    const text = typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text!).join('\n');
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

