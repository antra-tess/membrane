import { unreportedUsage } from '../utils/usage.js';
import { createHash, randomUUID } from 'node:crypto';
import { nativeInputForRequest, normalizeResponsesInput } from './responses-input.js';
import { blockHandedIn, convertMcpMedia } from '../utils/mcp-media.js';
import { fetchWithCredentials, type CredentialResolver } from './credentials.js';
import { assertMessagePrefillSupported } from './request-capabilities.js';

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
  errorFromHttpResponse,
  invalidRequestError,
  isTypedAbortError,
  networkError,
  withRawRequest,
} from '../types/index.js';
import { errorFromThrown } from '../types/errors.js';
import { createCombinedSignal, SSELineParser, toolUseInputFromText, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, isEventObject } from './utils.js';

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

export interface OpenAIResponsesAPIAdapterConfig {
  /** API key (defaults to OPENAI_API_KEY). */
  apiKey?: string;
  /** Resolve a bearer token and associated headers for each request/401 retry.
   * Overrides apiKey; acquiring and persisting credentials belongs to the caller. */
  credentials?: CredentialResolver;
  /** ChatGPT subscription transport requires credentials and always uses SSE. */
  mode?: 'api' | 'subscription';
  /** Request priority service in subscription mode (default: false). */
  fastMode?: boolean;
  /** Called once if a subscription response to a request for the priority
   * tier reports another tier. If it throws, the error is logged with
   * console.warn and the response stands. */
  onFastModeFallback?: (serviceTier: string) => void;
  /** Subscription mode: base of the prompt-cache routing id sent as the
   * `session_id` header and as `prompt_cache_key`. Each request appends a digest
   * of its instructions and first input item, which groups requests by
   * serialized head: requests that share a head share an id; tools and later
   * items are not considered.
   * Streams that need isolation beyond that (same-head forks or subagents on
   * one adapter) should set `extra.prompt_cache_key`, which is used instead.
   * Defaults to a random id held for the adapter's lifetime, so a restart
   * pays one uncached read per head; pin it to survive restarts. */
  sessionId?: string;
  /** API base URL (defaults to the selected mode's endpoint). */
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

function functionToolStrictness(toolName: unknown, strict: unknown, position: number, rawRequest: unknown): boolean {
  if (strict === undefined || strict === null) return false;
  if (typeof strict === 'boolean') return strict;
  const spelled = typeof strict === 'string'
    ? strict.length <= MAX_QUOTED_STRICT_CHARS ? JSON.stringify(strict) : `a ${strict.length}-character string`
    : Array.isArray(strict)
      ? 'an array'
      : typeof strict === 'function'
        ? 'a function'
        : typeof strict === 'object'
          ? 'an object'
          : `${typeof strict} ${String(strict)}`;
  const tool = typeof toolName === 'string' && toolName !== ''
    ? `function tool ${JSON.stringify(toolName)}`
    : `the function tool at tools[${position}], which has no name,`;
  throw invalidRequestError(
    `OpenAI Responses API: ${tool} has strict set to ` +
      `${spelled}; strict must be true, false, null or omitted (omitted and null are sent as false).`,
    undefined,
    rawRequest,
  );
}

const MAX_QUOTED_STRICT_CHARS = 40;

/** A cache key is any JSON string, a header value is not: anything beyond
 * short visible ASCII is sent as a digest, which is just as stable. */
function headerSafeSessionId(key: string): string {
  return /^[\x21-\x7e]{1,128}$/.test(key)
    ? key
    : createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export class OpenAIResponsesAPIAdapter implements ProviderAdapter {
  readonly name: string = 'openai-responses-api';
  /**
   * Carries native input items verbatim, and reports what it can't: what
   * subscription-mode normalization leaves out or changes, and, in either
   * mode, a native input_image whose data: URL holds no image the API
   * accepts, which goes as the placeholder.
   */
  readonly reportsContentAlterations = true;

  /**
   * Reads `usage.input_tokens_details.cached_tokens` from OpenAI's automatic
   * prompt caching, whose cached span is a subset of the input count on
   * /v1/chat/completions; no cache hit has confirmed it on /v1/responses.
   */
  readonly usageCacheConvention = 'cache-inclusive' as const;

  private readonly apiKey: string;
  private readonly credentials?: CredentialResolver;
  private readonly subscription: boolean;
  readonly requiresNativeResponsesInput: boolean;
  private fastMode: boolean;
  private readonly onFastModeFallback?: (serviceTier: string) => void;
  private warnedFastFallback = false;
  private readonly sessionId: string;
  private readonly baseURL: string;
  private readonly organization?: string;
  private readonly project?: string;
  private readonly defaultMaxTokens: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAIResponsesAPIAdapterConfig = {}) {
    this.subscription = config.mode === 'subscription';
    this.requiresNativeResponsesInput = !this.subscription;
    this.credentials = config.credentials;
    if (this.subscription && !this.credentials) {
      throw new Error('Subscription mode requires a credential resolver');
    }
    this.fastMode = config.fastMode ?? false;
    this.onFastModeFallback = config.onFastModeFallback;
    this.sessionId = config.sessionId ?? randomUUID();
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = (config.baseURL ?? (this.subscription ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1')).replace(/\/$/, '');
    this.organization = config.organization;
    this.project = config.project;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};

    if (!this.apiKey && !this.credentials) {
      throw new Error('OpenAI API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    return !this.subscription || modelId.startsWith('gpt-') || modelId.includes('codex');
  }

  isFastMode(): boolean {
    return this.fastMode;
  }

  setFastMode(enabled: boolean): void {
    this.fastMode = enabled;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<OpenAIResponsesAPIProviderResponse> {
    if (this.subscription) return this.stream(request, { onChunk: () => {} }, options);
    const responsesRequest = this.buildRequest(request, options?.onContentAltered);
    // A gateway's Responses endpoint can serve a Claude model, which refuses
    // an input ending in an assistant turn: refuse it here, typed, before HTTP.
    assertMessagePrefillSupported(responsesRequest.model, responsesRequest.input, options, this.name, responsesRequest);
    options?.onRequest?.(responsesRequest);

    const { signal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await this.fetchResponse(responsesRequest, signal);

      await this.assertSuccessfulHTTPResponse(response, responsesRequest);
      const data = (await response.json()) as OpenAIResponsesAPIResponse;
      this.assertSuccessfulAPIResponse(data, responsesRequest, 'response error');
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
    const responsesRequest = this.buildRequest(request, options?.onContentAltered);
    responsesRequest.stream = true;
    assertMessagePrefillSupported(responsesRequest.model, responsesRequest.input, options, this.name, responsesRequest);
    options?.onRequest?.(responsesRequest);

    const { signal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await this.fetchResponse(responsesRequest, signal);

      await this.assertSuccessfulHTTPResponse(response, responsesRequest);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('OpenAI Responses API returned no response body');

      const decoder = new TextDecoder();
      const parser = new SSELineParser({ multiline: true });
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
        if (!isEventObject(event)) return;
        options?.onProgress?.();
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
          throwOnStreamErrorFrame(failed, 'OpenAI Responses API', responsesRequest);
          throw new Error('OpenAI Responses API stream error (response_failed): Response failed');
        } else if (event.type === 'error') {
          // The event's own `type` is the SSE event name ('error'), not a provider classification.
          throwOnStreamErrorFrame(
            { error: event.error ?? { code: event.code, message: event.message ?? 'Streaming request failed' } },
            'OpenAI Responses API',
            responsesRequest
          );
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const data of parser.feed(decoder.decode(value, { stream: true }))) {
            processData(data);
          }
        }
        for (const data of parser.feed(decoder.decode())) processData(data);
        for (const data of parser.flush()) processData(data);
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      // A well-formed stream ends with a terminal event (response.completed or
      // response.incomplete; response.failed and error throw above), so EOF
      // without one is a dropped connection.
      if (!terminalResponse) {
        throw networkError(
          'OpenAI Responses API stream ended before a terminal response event ' +
            `(connection dropped after ${events.length} events)`,
          undefined,
          responsesRequest
        );
      }

      this.assertSuccessfulAPIResponse(terminalResponse, responsesRequest);

      // Codex may deliver authoritative items only via output_item.done.
      // A non-empty terminal output remains authoritative when supplied.
      if (!terminalResponse.output?.length) {
        terminalResponse = { ...terminalResponse, output: output.filter(Boolean) };
      }
      const returnedTier = terminalResponse.service_tier;
      if (this.subscription && responsesRequest.service_tier === 'priority' &&
          typeof returnedTier === 'string' && returnedTier && returnedTier !== 'priority' &&
          !this.warnedFastFallback) {
        this.warnedFastFallback = true;
        try {
          this.onFastModeFallback?.(returnedTier);
        } catch (error) {
          console.warn('[membrane:openai-responses] onFastModeFallback threw; the response stands:', error);
        }
      }
      const parsed = this.parseResponse(terminalResponse, request.model, responsesRequest);
      parsed.content.forEach((block, index) => callbacks.onContentBlock?.(index, block));
      return parsed;
    } catch (error) {
      throw this.handleError(error, responsesRequest);
    } finally {
      cleanup?.();
    }
  }

  private async fetchResponse(
    request: OpenAIResponsesAPIRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    // Built with set() because header names are case-insensitive: spreading into
    // an object lets `Session_Id` in extraHeaders coexist with the computed
    // `session_id`, and Headers then joins the two into one comma-separated value.
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (this.organization) headers.set('OpenAI-Organization', this.organization);
    if (this.project) headers.set('OpenAI-Project', this.project);
    if (this.subscription) {
      // The subscription backend keys its prompt cache on this header and
      // ignores the body's prompt_cache_key. Warm calls still miss sporadically,
      // whatever the id.
      headers.set('session_id', headerSafeSessionId(String(request.prompt_cache_key)));
    }
    for (const [name, value] of Object.entries(this.extraHeaders)) headers.set(name, value);
    return fetchWithCredentials(`${this.baseURL}/responses`, {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
      headers,
    }, this.credentials ?? { token: this.apiKey });
  }

  private subscriptionInput(
    messages: ProviderRequest['messages'],
    onContentAltered?: (block?: unknown) => void,
  ): ReturnType<typeof normalizeResponsesInput> {
    const converted = convertMcpMedia(messages as unknown[]) as ProviderRequest['messages'];
    const handedIn = blockHandedIn(messages as unknown[], converted as unknown[]);
    return normalizeResponsesInput(
      converted,
      onContentAltered && ((block?: unknown) => onContentAltered(handedIn(block))),
    );
  }

  private buildRequest(request: ProviderRequest, onContentAltered?: (block?: unknown) => void): OpenAIResponsesAPIRequest {
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
    if (request.tools?.length) responsesRequest.tools = request.tools;

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

    if (Array.isArray(responsesRequest.tools)) {
      responsesRequest.tools = this.convertTools(responsesRequest.tools, responsesRequest);
    }

    // An input_image whose data: URL holds no image would be refused on every
    // request, so it goes as the placeholder in either mode.
    responsesRequest.input = this.subscription
      ? this.subscriptionInput(request.messages, onContentAltered)
      : nativeInputForRequest(request.messages, onContentAltered);
    responsesRequest.store = false;
    responsesRequest.include = this.mergeEncryptedReasoningInclude(responsesRequest.include);
    if (this.subscription) {
      for (const key of ['temperature', 'top_p', 'top_k', 'max_output_tokens', 'max_tokens', 'max_completion_tokens']) {
        delete responsesRequest[key];
      }
      if (this.fastMode) responsesRequest.service_tier = 'priority';
      else delete responsesRequest.service_tier;
      if (typeof responsesRequest.prompt_cache_key !== 'string' || !responsesRequest.prompt_cache_key) {
        const head = createHash('sha256')
          .update(this.sessionId)
          .update(JSON.stringify([responsesRequest.instructions ?? '', responsesRequest.input[0] ?? null]))
          .digest('hex')
          .slice(0, 12);
        responsesRequest.prompt_cache_key = `${this.sessionId}:${head}`;
      }
    }
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

  /**
   * OpenAI's strict validation treats every property as one the model must
   * send, where plain JSON Schema lets a property outside `required` be
   * omitted, and the API applies its own default to a tool sent without
   * `strict`.
   */
  private convertTools(tools: unknown[], rawRequest: unknown): unknown[] {
    return tools.map((rawTool: any, position) => {
      if (rawTool?.type && rawTool.type !== 'function') return rawTool;

      if (rawTool?.type === 'function' && rawTool.name) {
        return { ...rawTool, strict: functionToolStrictness(rawTool.name, rawTool.strict, position, rawRequest) };
      }
      if (rawTool?.type === 'function' && rawTool.function) {
        const fn = rawTool.function;
        return { type: 'function', ...fn, strict: functionToolStrictness(fn.name, fn.strict ?? rawTool.strict, position, rawRequest) };
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
        strict: functionToolStrictness(rawTool?.name, rawTool?.strict, position, rawRequest),
      };
    });
  }

  private parseResponse(
    response: OpenAIResponsesAPIResponse,
    requestedModel: string,
    rawRequest: OpenAIResponsesAPIRequest
  ): OpenAIResponsesAPIProviderResponse {
    const outputItems = Array.isArray(response.output) ? response.output : [];
    const content = this.outputToContent(outputItems);
    const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

    return {
      content,
      outputItems,
      stopReason: this.getStopReason(response, outputItems),
      providerStopReason: response.incomplete_details?.reason ?? response.status,
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        ...(typeof cachedTokens === 'number' ? { cacheReadTokens: cachedTokens } : {}),
      },
      ...unreportedUsage(response.usage?.input_tokens, response.usage?.output_tokens),
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
          ...toolUseInputFromText(item.arguments),
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
    if (response.status === 'incomplete' && reason) {
      if (reason.includes('max_output_tokens')) return 'max_tokens';
      if (reason === 'content_filter') return 'refusal';
      return reason;
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

  private async assertSuccessfulHTTPResponse(response: Response, rawRequest: unknown): Promise<void> {
    if (response.ok) return;
    throw errorFromHttpResponse(this.name, response, await response.text(), rawRequest);
  }

  private assertSuccessfulAPIResponse(
    response: OpenAIResponsesAPIResponse,
    rawRequest?: unknown,
    errorNoun?: string
  ): void {
    if (!response.error) return;
    throwOnStreamErrorFrame(response, 'OpenAI Responses API', rawRequest, errorNoun);
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (isDeadlineAbort(error)) return deadlineTimeoutError(error, rawRequest);
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    if (isTypedAbortError(error)) return abortError(undefined, rawRequest);

    return errorFromThrown(error, rawRequest);
  }
}
