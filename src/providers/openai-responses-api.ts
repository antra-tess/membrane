/**
 * OpenAI Responses API adapter.
 *
 * This is intentionally separate from `openai-responses.ts`. Despite its name,
 * that compatibility-sensitive adapter targets the Images API.
 *
 * This adapter is stateless and provider-native: `ProviderRequest.messages` is
 * sent verbatim as the Responses API `input` item array, and `outputItems`
 * exposes the response's ordered output array verbatim for the next turn.
 */

import type {
  ContentBlock,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../types/index.js';
import {
  MembraneError,
  abortError,
  authError,
  contextLengthError,
  networkError,
  rateLimitError,
  serverError,
} from '../types/index.js';
import { createCombinedSignal, SSELineParser, safeParseJson } from './utils.js';

// ============================================================================
// Provider-native Responses API types
// ============================================================================

export interface OpenAIResponsesInputItem {
  type?: string;
  id?: string | null;
  [key: string]: unknown;
}

export interface OpenAIResponsesOutputItem {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface OpenAIResponsesAPIRequest {
  model: string;
  input: OpenAIResponsesInputItem[];
  store: false;
  include: string[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIResponsesAPIResponse {
  id?: string;
  object?: string;
  model?: string;
  output: OpenAIResponsesOutputItem[];
  status?: string;
  incomplete_details?: { reason?: string | null } | null;
  error?: { code?: string | null; message?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
  [key: string]: unknown;
}

export type OpenAIResponsesAPIContentBlock =
  | (ContentBlock & {
      itemId?: string;
      outputIndex: number;
      contentIndex?: number;
      phase?: 'commentary' | 'final_answer' | null;
      rawItem?: OpenAIResponsesOutputItem;
    })
  | {
      type: 'compaction';
      id?: string;
      encryptedContent: string;
      createdBy?: string;
      outputIndex: number;
      rawItem: OpenAIResponsesOutputItem;
    }
  | {
      type: 'openai_response_item';
      itemId?: string;
      itemType: string;
      outputIndex: number;
      rawItem: OpenAIResponsesOutputItem;
    };

export interface OpenAIResponsesAPIProviderResponse extends Omit<ProviderResponse, 'content' | 'raw'> {
  content: OpenAIResponsesAPIContentBlock[];
  /** Ordered, provider-native output items. Append these verbatim to the next input. */
  outputItems: OpenAIResponsesOutputItem[];
  raw: OpenAIResponsesAPIResponse | Record<string, unknown>;
}

// ============================================================================
// Configuration
// ============================================================================

export interface OpenAIResponsesAPIAdapterConfig {
  /** API key (defaults to OPENAI_API_KEY). */
  apiKey?: string;
  /** API base URL (default: https://api.openai.com/v1). */
  baseURL?: string;
  /** Optional OpenAI organization ID. */
  organization?: string;
  /** Optional OpenAI project ID. */
  project?: string;
  /** Default maximum output tokens when the request does not provide one. */
  defaultMaxTokens?: number;
  /** Additional HTTP headers. */
  extraHeaders?: Record<string, string>;
}

// ============================================================================
// Adapter
// ============================================================================

export class OpenAIResponsesAPIAdapter implements ProviderAdapter {
  readonly name = 'openai-responses-api';

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly organization?: string;
  private readonly project?: string;
  private readonly defaultMaxTokens: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAIResponsesAPIAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.organization = config.organization;
    this.project = config.project;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};

    if (!this.apiKey) {
      throw new Error('OpenAI API key not provided');
    }
  }

  supportsModel(_modelId: string): boolean {
    return true;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<OpenAIResponsesAPIProviderResponse> {
    const responsesRequest = this.buildRequest(request);
    options?.onRequest?.(responsesRequest);

    const { signal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(responsesRequest),
        signal,
      });

      await this.assertSuccessfulHTTPResponse(response);
      const data = (await response.json()) as OpenAIResponsesAPIResponse;
      this.assertSuccessfulAPIResponse(data);
      return this.parseResponse(data, request.model, responsesRequest);
    } catch (error) {
      throw this.handleError(error, responsesRequest);
    } finally {
      cleanup?.();
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<OpenAIResponsesAPIProviderResponse> {
    const responsesRequest = this.buildRequest(request);
    responsesRequest.stream = true;
    options?.onRequest?.(responsesRequest);

    const { signal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(responsesRequest),
        signal,
      });

      await this.assertSuccessfulHTTPResponse(response);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('OpenAI Responses API returned no response body');

      const decoder = new TextDecoder();
      const parser = new SSELineParser();
      const events: unknown[] = [];
      const output: OpenAIResponsesOutputItem[] = [];
      let terminalResponse: OpenAIResponsesAPIResponse | undefined;

      const processData = (data: string): void => {
        if (!data || data === '[DONE]') return;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        events.push(event);

        if (event.type === 'response.output_text.delta') {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (delta) callbacks.onChunk(delta);
          this.applyTextDelta(output, event);
        } else if (event.type === 'response.function_call_arguments.delta') {
          this.applyFunctionArgumentsDelta(output, event);
        } else if (
          event.type === 'response.output_item.added' ||
          event.type === 'response.output_item.done'
        ) {
          if (Number.isInteger(event.output_index) && event.item) {
            output[event.output_index] = event.item;
          }
        } else if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete'
        ) {
          terminalResponse = event.response;
        } else if (event.type === 'response.failed') {
          const failed = event.response as OpenAIResponsesAPIResponse | undefined;
          throw new Error(
            `OpenAI Responses API error: ${failed?.error?.code ?? 'response_failed'} ` +
              `${failed?.error?.message ?? 'Response failed'}`
          );
        } else if (event.type === 'error') {
          throw new Error(
            `OpenAI Responses API error: ${event.code ?? 'stream_error'} ` +
              `${event.message ?? 'Streaming request failed'}`
          );
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of parser.feed(decoder.decode(value, { stream: true }))) {
          processData(data);
        }
      }
      for (const data of parser.feed(decoder.decode())) processData(data);
      for (const data of parser.flush()) processData(data);

      // A well-formed stream always ends with a terminal event
      // (response.completed / response.incomplete; response.failed and error
      // throw above). Reaching EOF without one means the connection was
      // dropped mid-stream (proxy/LB close, early termination). Fabricating a
      // 'completed' response here would persist a silently truncated turn
      // with end_turn/zero usage — signal a retryable stream failure instead.
      if (!terminalResponse) {
        throw networkError(
          'OpenAI Responses API stream ended before a terminal response event ' +
            `(connection dropped after ${events.length} events)`,
          undefined,
          responsesRequest
        );
      }

      this.assertSuccessfulAPIResponse(terminalResponse);

      const parsed = this.parseResponse(terminalResponse, request.model, responsesRequest);
      parsed.content.forEach((block, index) => callbacks.onContentBlock?.(index, block));
      return parsed;
    } catch (error) {
      throw this.handleError(error, responsesRequest);
    } finally {
      cleanup?.();
    }
  }

  // --------------------------------------------------------------------------
  // Request construction
  // --------------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(this.organization ? { 'OpenAI-Organization': this.organization } : {}),
      ...(this.project ? { 'OpenAI-Project': this.project } : {}),
      ...this.extraHeaders,
    };
  }

  private buildRequest(request: ProviderRequest): OpenAIResponsesAPIRequest {
    if (!Array.isArray(request.messages)) {
      throw new Error('OpenAI Responses API input must be a provider-native input-item array');
    }

    const responsesRequest: OpenAIResponsesAPIRequest = {
      model: request.model,
      input: request.messages as OpenAIResponsesInputItem[],
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: request.maxTokens || this.defaultMaxTokens,
    };

    const instructions = this.flattenInstructions(request.system);
    if (instructions) responsesRequest.instructions = instructions;
    if (request.temperature !== undefined) responsesRequest.temperature = request.temperature;
    if (request.topP !== undefined) responsesRequest.top_p = request.topP;
    if (request.tools?.length) responsesRequest.tools = this.convertTools(request.tools);

    if (request.extra) {
      const {
        normalizedMessages,
        prompt,
        messages,
        input,
        store,
        stream,
        include,
        ...extra
      } = request.extra;
      void normalizedMessages;
      void prompt;
      void messages;
      void input;
      void store;
      void stream;
      Object.assign(responsesRequest, extra);
      responsesRequest.include = this.mergeEncryptedReasoningInclude(include);
    }

    // These invariants define the adapter's stateless native-item contract and
    // cannot be overridden through provider params.
    responsesRequest.input = request.messages as OpenAIResponsesInputItem[];
    responsesRequest.store = false;
    responsesRequest.include = this.mergeEncryptedReasoningInclude(responsesRequest.include);
    return responsesRequest;
  }

  private mergeEncryptedReasoningInclude(value: unknown): string[] {
    const include = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    return include.includes('reasoning.encrypted_content')
      ? include
      : [...include, 'reasoning.encrypted_content'];
  }

  private flattenInstructions(system: ProviderRequest['system']): string | undefined {
    if (typeof system === 'string') return system || undefined;
    if (!Array.isArray(system)) return undefined;
    const text = system
      .map((block: any) =>
        block?.type === 'text' || block?.type === 'input_text' ? block.text : undefined
      )
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n');
    return text || undefined;
  }

  private convertTools(tools: unknown[]): unknown[] {
    return tools.map((rawTool: any) => {
      if (rawTool?.type && rawTool.type !== 'function') return rawTool;

      // Responses function definitions are flat. Accept them verbatim, while
      // also adapting Membrane and Chat Completions function schemas.
      if (rawTool?.type === 'function' && rawTool.name) return rawTool;
      if (rawTool?.type === 'function' && rawTool.function) {
        return { type: 'function', ...rawTool.function };
      }
      return {
        type: 'function',
        name: rawTool?.name,
        description: rawTool?.description,
        parameters:
          rawTool?.parameters ??
          rawTool?.inputSchema ??
          rawTool?.input_schema ??
          { type: 'object', properties: {} },
        ...(rawTool?.strict !== undefined ? { strict: rawTool.strict } : {}),
      };
    });
  }

  // --------------------------------------------------------------------------
  // Response conversion
  // --------------------------------------------------------------------------

  private parseResponse(
    response: OpenAIResponsesAPIResponse,
    requestedModel: string,
    rawRequest: OpenAIResponsesAPIRequest
  ): OpenAIResponsesAPIProviderResponse {
    const outputItems = Array.isArray(response.output) ? response.output : [];
    const content = this.outputToContent(outputItems);
    const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;

    return {
      content,
      outputItems,
      stopReason: this.getStopReason(response, outputItems),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
      },
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private outputToContent(items: OpenAIResponsesOutputItem[]): OpenAIResponsesAPIContentBlock[] {
    const content: OpenAIResponsesAPIContentBlock[] = [];

    items.forEach((item, outputIndex) => {
      if (item.type === 'message') {
        const phase = this.asPhase(item.phase);
        const messageContent = Array.isArray(item.content) ? item.content : [];
        messageContent.forEach((part: any, contentIndex: number) => {
          if (part?.type === 'output_text' && typeof part.text === 'string') {
            content.push({
              type: 'text',
              text: part.text,
              itemId: item.id,
              outputIndex,
              contentIndex,
              phase,
              rawItem: item,
            });
          } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
            content.push({
              type: 'text',
              text: part.refusal,
              itemId: item.id,
              outputIndex,
              contentIndex,
              phase,
              rawItem: item,
            });
          }
        });
      } else if (item.type === 'reasoning') {
        if (typeof item.encrypted_content === 'string') {
          content.push({
            type: 'redacted_thinking',
            data: item.encrypted_content,
            itemId: item.id,
            outputIndex,
            rawItem: item,
          });
        } else {
          const thinking = this.extractReasoningText(item);
          content.push({
            type: 'thinking',
            thinking,
            itemId: item.id,
            outputIndex,
            rawItem: item,
          });
        }
      } else if (item.type === 'function_call') {
        const callId = typeof item.call_id === 'string' ? item.call_id : item.id ?? '';
        content.push({
          type: 'tool_use',
          id: callId,
          name: typeof item.name === 'string' ? item.name : '',
          input: safeParseJson(typeof item.arguments === 'string' ? item.arguments : '{}'),
          itemId: item.id,
          outputIndex,
          rawItem: item,
        });
      } else if (item.type === 'function_call_output') {
        content.push({
          type: 'tool_result',
          toolUseId: typeof item.call_id === 'string' ? item.call_id : '',
          content:
            typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null),
          itemId: item.id,
          outputIndex,
          rawItem: item,
        });
      } else if (item.type === 'compaction' && typeof item.encrypted_content === 'string') {
        content.push({
          type: 'compaction',
          id: item.id,
          encryptedContent: item.encrypted_content,
          ...(typeof item.created_by === 'string' ? { createdBy: item.created_by } : {}),
          outputIndex,
          rawItem: item,
        });
      } else {
        content.push({
          type: 'openai_response_item',
          itemId: item.id,
          itemType: item.type,
          outputIndex,
          rawItem: item,
        });
      }
    });

    return content;
  }

  private extractReasoningText(item: OpenAIResponsesOutputItem): string {
    const values = [item.summary, item.content]
      .filter(Array.isArray)
      .flatMap((parts) => parts as unknown[])
      .map((part: any) => part?.text)
      .filter((text): text is string => typeof text === 'string');
    return values.join('\n');
  }

  private asPhase(value: unknown): 'commentary' | 'final_answer' | null | undefined {
    return value === 'commentary' || value === 'final_answer' || value === null
      ? value
      : undefined;
  }

  private getStopReason(
    response: OpenAIResponsesAPIResponse,
    output: OpenAIResponsesOutputItem[]
  ): string {
    if (output.some((item) => item.type === 'function_call')) return 'tool_use';
    if (output.some((item) =>
      item.type === 'message' &&
      Array.isArray(item.content) &&
      item.content.some((part: any) => part?.type === 'refusal')
    )) return 'refusal';

    const reason = response.incomplete_details?.reason;
    if (response.status === 'incomplete' && reason?.includes('max_output_tokens')) {
      return 'max_tokens';
    }
    return 'end_turn';
  }

  private applyTextDelta(output: OpenAIResponsesOutputItem[], event: any): void {
    if (!Number.isInteger(event.output_index) || typeof event.delta !== 'string') return;
    const outputIndex = event.output_index as number;
    const contentIndex = Number.isInteger(event.content_index) ? event.content_index : 0;
    const existing = output[outputIndex] as any;
    const message = existing?.type === 'message'
      ? existing
      : {
          type: 'message',
          id: event.item_id,
          role: 'assistant',
          status: 'in_progress',
          content: [],
        };
    const part = message.content[contentIndex] ?? { type: 'output_text', text: '', annotations: [] };
    part.text = `${part.text ?? ''}${event.delta}`;
    message.content[contentIndex] = part;
    output[outputIndex] = message;
  }

  private applyFunctionArgumentsDelta(output: OpenAIResponsesOutputItem[], event: any): void {
    if (!Number.isInteger(event.output_index) || typeof event.delta !== 'string') return;
    const outputIndex = event.output_index as number;
    const item = output[outputIndex] as any;
    if (item?.type === 'function_call') {
      item.arguments = `${item.arguments ?? ''}${event.delta}`;
    }
  }

  // --------------------------------------------------------------------------
  // Errors
  // --------------------------------------------------------------------------

  private async assertSuccessfulHTTPResponse(response: Response): Promise<void> {
    if (response.ok) return;
    const errorText = await response.text();
    throw new Error(`OpenAI Responses API error: ${response.status} ${errorText}`);
  }

  private assertSuccessfulAPIResponse(response: OpenAIResponsesAPIResponse): void {
    if (!response.error) return;
    throw new Error(
      `OpenAI Responses API error: ${response.error.code ?? 'api_error'} ` +
        `${response.error.message ?? 'Unknown error'}`
    );
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return error;
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes('429') || message.includes('rate_limit')) {
        const retryMatch = message.match(/retry after (\d+)/i);
        const retryAfter = retryMatch?.[1] ? Number(retryMatch[1]) * 1000 : undefined;
        return rateLimitError(message, retryAfter, error, rawRequest);
      }
      if (
        message.includes('401') ||
        message.includes('invalid_api_key') ||
        message.includes('Incorrect API key')
      ) {
        return authError(message, error, rawRequest);
      }
      if (
        message.includes('context_length') ||
        message.includes('maximum context') ||
        message.includes('too long')
      ) {
        return contextLengthError(message, error, rawRequest);
      }
      if (
        message.includes('500') ||
        message.includes('502') ||
        message.includes('503') ||
        message.includes('server_error')
      ) {
        return serverError(message, undefined, error, rawRequest);
      }
      if (error.name === 'AbortError') return abortError(undefined, rawRequest);
      if (
        message.includes('network') ||
        message.includes('fetch') ||
        message.includes('ECONNREFUSED')
      ) {
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
