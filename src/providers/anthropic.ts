import { unreportedUsage } from '../utils/usage.js';
import { assertMessagePrefillSupported } from './request-capabilities.js';

import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { stripEmptyTextBlocks, stripEmptyTextAfterPassthrough } from '../utils/empty-text.js';
import { anthropicServerBlockFor, isAnthropicServerBlock, unpairedServerBlocks, type AnthropicServerBlock } from '../utils/anthropic-server-blocks.js';
import { imageForRequest, urlImageForRequest, assertWithinByteBudget, shedImagesToFitByteBudget } from '../utils/image-media.js';
import { convertMcpMedia, isSourcelessMedia } from '../utils/mcp-media.js';
import { isUnsignedThinking } from '../utils/thinking-carriers.js';
import type {
  ProviderAdapter,
  ProviderInputTransformation,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  ContentBlock,
} from '../types/index.js';
import {
  MembraneError,
  abortError,
  authError,
  errorFromProviderStatus,
  extractProviderErrorFields,
  isTypedAbortError,
  networkError,
  serverError,
  timeoutError,
  withRawRequest,
  unsupportedError,
} from '../types/index.js';
import { markSystemChangeRefused, runCallerCode, statusForProviderCode, deadlineExpired, isDeadlineExpiry, errorFromThrown } from '../types/errors.js';
import { flattenRootSchemaUnion } from './anthropic-tool-schema.js';
import { isPlainObject } from '../utils/tool-schema.js';
import { assertTerminalEventObserved, toolUseInputFromText, toolUseInputFromValue, isDeadlineAbort, deadlineTimeoutError, isToolCallBlock, isToolCallArgumentsDelta, contentOfAnthropicEvent } from './utils.js';
import { fetchWithCredentials, validateCredential, type CredentialContext, type CredentialResolver } from './credentials.js';
import { CacheKeepalive, type CacheKeepaliveConfig } from '../cache-keepalive.js';

/**
 * Models that reject the sampling parameters (`temperature`, `top_p`,
 * `top_k`) with a 400 invalid_request_error, each named on its own. Haiku 4.5,
 * Sonnet 4.6, Opus 4.6 and older accept `temperature`, so they must not be
 * listed.
 *
 *   - Opus 4.7 / Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 / Mythos preview:
 *     documented 400 on any sampling parameter (Sonnet 5 rejects only
 *     non-default values).
 *   - Haiku 5.5, Opus 5, Opus 5.5, Fable 5.1 and Sonnet 5.5: measured; each
 *     refuses `temperature` 0.2, `top_k` 40 and `top_p` 0.9 with a 400, and
 *     takes a `top_p` of 0.99.
 *   - Mythos 5.1: not measured. The Fable and Mythos family always thinks,
 *     and with thinking on the API takes no custom `temperature` or `top_k`.
 */
const NO_TEMPERATURE_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
  'claude-mythos-preview',
];

const LATER_VERSION_SUFFIX = /^(\d|-\d{1,2}(?!\d))/;

function noTemperatureSupport(model: string): boolean {
  return NO_TEMPERATURE_MODELS.some((id) => model.startsWith(id) && !LATER_VERSION_SUFFIX.test(model.slice(id.length)));
}

/** Beta flag for thinking blocks between tool calls on pre-4.6 Claude 4.
 *  On Bedrock it rides in the request body (`anthropic_beta`) instead of an
 *  HTTP header. */
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

const SNAPSHOT_DATE_DIGITS = 8;

/**
 * Interleaved thinking (thinking blocks between tool calls) is native from
 * Opus/Sonnet 4.6 onward; earlier Claude 4 models do it only behind the
 * `interleaved-thinking-2025-05-14` beta flag, and Claude 3.x not at all.
 */
export function needsInterleavedThinkingBeta(model: string): boolean {
  const m = /claude-(?:opus|sonnet|haiku)-4(?:-(\d+))?/.exec(model);
  if (!m) return false;
  const minorOrSnapshotDate = m[1];
  if (minorOrSnapshotDate === undefined) return true;
  if (minorOrSnapshotDate.length >= SNAPSHOT_DATE_DIGITS) return true;
  return parseInt(minorOrSnapshotDate, 10) < 6;
}

/** Pull the anthropic-beta value out of a ClientOptions defaultHeaders bag,
 *  which the SDK types as record | entries-array | Headers, as the SDK's
 *  buildHeaders reads it: case-insensitive on the key, each value of an array
 *  appended, undefined skipped, and null clearing what came before; an
 *  object's key replaces what an earlier key gave, where entries rows append.
 *  Nothing left is absent. */
function extractBetaHeader(headers: ClientOptions['defaultHeaders']): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('anthropic-beta') ?? undefined;
  }
  const rows = Array.isArray(headers);
  const entries = rows ? headers : Object.entries(headers as Record<string, unknown>);
  let values: string[] = [];
  for (const [key, value] of entries) {
    if (String(key).toLowerCase() !== 'anthropic-beta') continue;
    let replaced = rows;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined) continue;
      if (!replaced) { values = []; replaced = true; }
      if (v === null) values = [];
      else values.push(String(v));
    }
  }
  return values.length > 0 ? values.join(',') : undefined;
}

/** Beta flag for thinking-binding controls (`thinking.block_binding`) and
 *  the `input_transformations` report that comes back with them. Shared with
 *  the Bedrock adapter, where it rides in `anthropic_beta`. */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export function sendsBlockBinding(params: { thinking?: unknown }): boolean {
  const binding = (params.thinking as { block_binding?: unknown } | null | undefined)?.block_binding;
  return binding !== undefined && binding !== null;
}

/** Beta flag for `thinking.display: 'updates'`, which returns the progress
 *  notes the model writes between tool calls as text while reasoning stays
 *  hidden. Without the beta the API rejects 'updates' as an unknown display
 *  value. Shared with the Bedrock adapter, where it rides in `anthropic_beta`. */
export const THINKING_DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18';

export function sendsDisplayUpdates(params: { thinking?: unknown }): boolean {
  return (params.thinking as { display?: unknown } | null | undefined)?.display === 'updates';
}

/** Beta flag for mid-conversation tool changes (`tool_addition` and
 *  `tool_removal` in a `role: 'system'` message), definitions by value
 *  included. System text there needs none. */
export const INLINE_TOOLS_BETA = 'inline-tools-2026-09-15';

export function sendsToolChanges(params: { messages?: unknown }): boolean {
  return Array.isArray(params.messages) && params.messages.some((message: { role?: unknown; content?: unknown }) =>
    message?.role === 'system' && Array.isArray(message.content) &&
    message.content.some((block: { type?: unknown }) => block?.type === 'tool_addition' || block?.type === 'tool_removal'));
}

/** The API's wordings, in a 400, for a model that takes no mid-conversation
 *  system message or no tool change in one. */
const SYSTEM_CHANGE_REFUSALS = [
  "role 'system' is not supported on this model",
  'tool_addition/tool_removal requires a model that supports mid-conversation system content',
  'tool_addition/tool_removal is not supported on this model',
];

export function isSystemChangeRefusal(body: unknown): boolean {
  const message = extractProviderErrorFields(body).message;
  return typeof message === 'string' && SYSTEM_CHANGE_REFUSALS.some((wording) => message.includes(wording));
}

export function readInputTransformations(
  raw: unknown,
  messages: unknown,
): { inputTransformations?: ProviderInputTransformation[] } {
  if (!Array.isArray(raw)) return {};
  const sent = Array.isArray(messages) ? messages : [];
  const inputTransformations: ProviderInputTransformation[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const { type, reason, path } = entry as { type?: unknown; reason?: unknown; path?: unknown };
    if (typeof type !== 'string') continue;
    const at = typeof path === 'string' ? /^messages\.(\d+)\.content\.(\d+)$/.exec(path) : null;
    const content = at ? (sent[Number(at[1])] as { content?: unknown } | undefined)?.content : undefined;
    const block = at && Array.isArray(content) ? content[Number(at[2])] : undefined;
    inputTransformations.push({
      type,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(typeof path === 'string' ? { path } : {}),
      ...(block !== undefined ? { block } : {}),
    });
  }
  return { inputTransformations };
}

export function readRefusalCategory(
  stopReason: string | null | undefined,
  stopDetails: unknown,
): { refusalCategory?: string } {
  if (stopReason !== 'refusal' || stopDetails === null || typeof stopDetails !== 'object') return {};
  const category = (stopDetails as { category?: unknown }).category;
  return typeof category === 'string' && category !== '' ? { refusalCategory: category } : {};
}

export function thinkingEnabled(request: ProviderRequest): boolean {
  const extraThinking = (request.extra as { thinking?: { type?: string } } | undefined)?.thinking;
  const thinkingConfig = request.thinking ?? extraThinking;
  return thinkingConfig !== undefined && thinkingConfig.type !== 'disabled';
}

// @anthropic-ai/sdk 0.52's stream yields only the message and content-block
// events, so a new event type never reaches this loop. The API sends each
// block's start, deltas and stop before the next block's start, and a tool
// call's deltas carry only its arguments. The SDK appends each citation to the
// array a text block's start carried, which this loop's copy of the block
// shares, so a citation lands in such a block whatever the order (a start
// whose citations is null or absent shares none).

const UNHANDLED_EVENTS_MAX = 20;
const PROVIDER_EVENT_MAX_CHARS = 4096;

export function boundedProviderEvent(event: unknown): unknown {
  const type = (event as { type?: unknown } | null | undefined)?.type;
  let json: string | undefined;
  try {
    json = JSON.stringify(event);
  } catch {
    return { type, unserializable: true };
  }
  if (json === undefined) return null;
  if (json.length <= PROVIDER_EVENT_MAX_CHARS) return JSON.parse(json);
  return { type, truncated: true, json: json.slice(0, PROVIDER_EVENT_MAX_CHARS) };
}

function sdkRequestId(holder: unknown, key: 'request_id' | '_request_id'): string | undefined {
  if (holder === null || typeof holder !== 'object') return undefined;
  const id = (holder as Record<string, unknown>)[key];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * What the dynamicHeaders callback is told about the request it stamps.
 * `lane` names the transport shape: 'stream' is the conversational turn loop,
 * 'complete' the non-streamed lane (compression, side-calls).
 */
export interface DynamicHeadersContext {
  lane: 'stream' | 'complete';
}

export interface AnthropicAdapterConfig {
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string | null;

  /**
   * OAuth/Bearer token (defaults to ANTHROPIC_AUTH_TOKEN env var when the SDK
   * is allowed to resolve environment auth). If explicitly provided, API-key
   * auth is disabled so requests do not send both auth schemes.
   */
  authToken?: string | null | ((context: CredentialContext) => string | Promise<string>);

  /** Resolve a bearer token and associated headers per HTTP attempt. Takes
   * precedence over authToken/apiKey; refreshed once after HTTP 401. Applies
   * to complete, stream, and cache-keepalive requests. */
  credentials?: CredentialResolver;
  
  /** Base URL override */
  baseURL?: string;

  /** Default headers to include with Anthropic requests */
  defaultHeaders?: ClientOptions['defaultHeaders'];

  /**
   * Live per-request headers, evaluated at request time, for values that
   * change between calls. Merged over the per-request beta headers for the
   * outgoing request only; cache-keepalive replays resend their recorded
   * headers. null/undefined/'' values are dropped.
   */
  dynamicHeaders?: (ctx?: DynamicHeadersContext) => Record<string, string | number | null | undefined>;
  
  /** Default max tokens */
  defaultMaxTokens?: number;

  /**
   * Prompt-cache keepalive: hold this agent's cached prefix warm across idle
   * gaps by replaying the last request with `max_tokens: 0`, through its last
   * one-hour cache marker and the end of the user turn at or after it (whole,
   * when no user turn comes there), which refreshes the entry's TTL at
   * cache-READ price instead of letting it expire into a 2x cache write on the
   * next wake.
   * Pass `{ enabled: false }` to turn off.
   */
  cacheKeepalive?: CacheKeepaliveConfig;
}

type SdkFetch = NonNullable<ClientOptions['fetch']>;

/**
 * The SDK drops SSE `ping` events before callers see them, so a fetch wrapper
 * is the only point where keepalive bytes are observable through public APIs.
 * Error responses are returned untouched so the SDK's error classification
 * keeps their metadata. The rebuilt Response has an empty `url`, which SDK
 * 0.52 reads only for debug logging.
 */
function observeBodyActivity(base: SdkFetch, observe?: () => void): SdkFetch {
  if (!observe) return base;
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.ok || !response.body || typeof response.body.pipeThrough !== 'function') return response;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > 0) observe();
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  /**
   * Carries message content verbatim, and reports what it can't: an image
   * whose data the API doesn't accept, which goes as the placeholder (at the
   * top level or nested in a tool result), and the nested tool-result blocks
   * it has no form for.
   */
  readonly reportsContentAlterations = true;
  readonly cacheReceiptBasis = 'wire-request' as const;
  /** Membrane sends server-tool blocks back through this adapter, in the turn that produced them, except `container_upload`, which the API refuses in an assistant turn. */
  readonly replaysAnthropicServerBlocks = true;
  /** Sends a mid-conversation `role: 'system'` message, with the inline-tools beta when it changes tools. Where the model takes none, its 400 is marked `systemChangeRefused`. */
  readonly sendsSystemChanges = true;

  /** `input_tokens` never counts the cached span. */
  readonly usageCacheConvention = 'cache-excluded' as const;
  private client: Anthropic;
  private readonly credentials?: CredentialResolver;
  private defaultMaxTokens: number;
  /** Any anthropic-beta value from defaultHeaders (e.g. the oauth beta for
   *  subscription tokens). Per-request headers REPLACE same-key defaults in
   *  the SDK rather than merging, so when we add a per-request beta we must
   *  re-carry this one alongside it or auth breaks. */
  private defaultBeta: string | undefined;
  /** Holds idle agents' cached prefixes warm; undefined when disabled. */
  readonly cacheKeepalive: CacheKeepalive | undefined;
  private readonly dynamicHeaders?: (ctx?: DynamicHeadersContext) => Record<string, string | number | null | undefined>;

  constructor(config: AnthropicAdapterConfig = {}) {
    const clientOptions: ClientOptions = {
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    };
    this.defaultBeta = extractBetaHeader(config.defaultHeaders);
    this.dynamicHeaders = config.dynamicHeaders;

    const authToken = config.authToken;
    const credentials: CredentialResolver | undefined = config.credentials ?? (typeof authToken === 'function'
      ? async (context: CredentialContext) => ({ token: await authToken(context) })
      : undefined);
    this.credentials = credentials;
    if (credentials) {
      // Satisfy SDK auth validation without freezing a real credential. The
      // fetch seam replaces this placeholder before every network attempt,
      // including the SDK's stream and cache-keepalive transports.
      clientOptions.authToken = 'membrane-resolved-at-request-time';
      clientOptions.apiKey = null;
    } else if (authToken !== undefined) {
      clientOptions.authToken = authToken as string | null;
      clientOptions.apiKey = null;
    } else {
      clientOptions.apiKey = config.apiKey;
    }

    this.client = new Anthropic(clientOptions);
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;

    this.cacheKeepalive = config.cacheKeepalive?.enabled === false
      ? undefined
      : new CacheKeepalive(
          // The already-built wire request goes as it is: a rebuild risks a byte diff,
          // which turns a cache read into a cache write.
          async (wire, headers) => this.createMessage(
            wire as unknown as Anthropic.MessageCreateParamsNonStreaming, headers,
          ),
          config.cacheKeepalive ?? {},
        );
  }

  private credentialSession(signal?: AbortSignal, observeBody?: () => void) {
    const credentials = this.credentials;
    if (!credentials) {
      const client = observeBody
        ? this.client.withOptions({ fetch: observeBodyActivity((input, init) => fetch(input, init), observeBody) })
        : this.client;
      return { client, signal, failure: () => undefined };
    }
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let failure: MembraneError | undefined;
    const client = this.client.withOptions({
      fetch: observeBodyActivity((input, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('x-api-key');
        return fetchWithCredentials(input, { ...init, headers }, async context => {
          try {
            const credential = await credentials(context);
            validateCredential(credential);
            const resolvedHeaders = new Headers(credential.headers);
            resolvedHeaders.delete('x-api-key');
            return { ...credential, headers: Object.fromEntries(resolvedHeaders) };
          } catch (error) {
            if (combined.aborted) throw error;
            failure = error instanceof MembraneError ? error : authError(
              `Credential resolution failed: ${error instanceof Error ? error.message : String(error)}`, error,
            );
            // SDK 0.52 retries thrown fetch errors as connection failures.
            // Abort this operation to bypass that loop, then restore the
            // original error at the complete/stream/keepalive boundary.
            abort.abort(failure);
            throw failure;
          }
        });
      }, observeBody),
    });
    return { client, signal: combined, failure: () => failure };
  }

  private async createMessage(
    request: Anthropic.MessageCreateParamsNonStreaming,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    retries?: { maxRetries: number },
  ): Promise<Anthropic.Message> {
    const session = this.credentialSession(signal);
    try {
      return await session.client.messages.create(request, { headers, signal: session.signal, ...retries });
    } catch (error) {
      throw session.failure() ?? error;
    }
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('claude-');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const anthropicRequest = this.buildRequest(request, options?.onContentAltered);
    const fullRequest = { ...anthropicRequest, stream: false as const };
    assertMessagePrefillSupported(fullRequest.model, fullRequest.messages, options, this.name, fullRequest);
    options?.onRequest?.(fullRequest);
    options?.onSend?.({ maxTokens: fullRequest.max_tokens });

    const headers = this.betaHeaders(request, anthropicRequest);
    const live = this.liveHeaders(headers, 'complete');

    try {
      const sentAt = Date.now();
      const response = await this.createMessage(fullRequest, live, options?.signal, { maxRetries: 0 });
      this.cacheKeepalive?.record(
        fullRequest as unknown as Record<string, unknown>, headers, 'complete', sentAt,
      );

      return this.parseResponse(response, fullRequest);
    } catch (error) {
      // A deadline on the caller's signal (Membrane's progressTimeoutMs) is a
      // timeout, as on every adapter; the SDK's abort error can't say so.
      if (isDeadlineAbort(options?.signal?.reason)) throw deadlineTimeoutError(options!.signal!.reason, fullRequest);
      throw this.handleError(error, fullRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const anthropicRequest = this.buildRequest(request, options?.onContentAltered);
    const fullRequest = { ...anthropicRequest, stream: true };
    assertMessagePrefillSupported(fullRequest.model, fullRequest.messages, options, this.name, fullRequest);
    options?.onRequest?.(fullRequest);
    options?.onSend?.({ maxTokens: fullRequest.max_tokens, reportsContent: true });

    const headers = this.betaHeaders(request, anthropicRequest);
    const live = this.liveHeaders(headers, 'stream');

    // The SDK's timeout covers only the response headers; once streaming starts,
    // a silently dropped connection waits forever. Thinking with
    // display:"omitted" emits no deltas and the SDK swallows SSE ping keepalives,
    // so a healthy request can be silent for minutes mid-stream. 600s matches the
    // SDK's own request timeout.
    const idleMs = options?.idleTimeoutMs ?? 600_000;
    // TTFT can exceed the inter-event idle: on a large context with a cache
    // miss, the API sends only SSE `ping` keepalives until message_start, and
    // the SDK swallows pings before they reach this loop. So body bytes re-arm
    // the idle timer only after the first event, and the first event has a
    // deadline of its own, by default never under 600s.
    const firstEventMs = options?.firstEventTimeoutMs ?? Math.max(idleMs, 600_000);
    const idleAbort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimedOut = false;
    let sawEvent = false;

    const onExternalAbort = () => idleAbort.abort();
    if (options?.signal) {
      if (options.signal.aborted) { idleAbort.abort(); }
      else { options.signal.addEventListener('abort', onExternalAbort, { once: true }); }
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => { idleTimedOut = true; idleAbort.abort(); },
        sawEvent ? idleMs : firstEventMs,
      );
    };

    // Body bytes (including SSE pings the SDK filters before the loop below)
    // prove transport liveness after the first SDK event.
    let settled = false;
    const onTransportActivity = () => {
      if (sawEvent && !settled && !idleAbort.signal.aborted) resetIdleTimer();
    };

    resetIdleTimer();
    let session: ReturnType<AnthropicAdapter['credentialSession']> | undefined;

    try {
      session = this.credentialSession(idleAbort.signal, onTransportActivity);
      // The cache's clock starts with the request, not at message_start.
      const sentAt = Date.now();
      const stream = await session.client.messages.stream(anthropicRequest, {
        signal: session.signal,
        headers: live,
        maxRetries: 0,
      });

      // Accumulate response metadata from SSE events directly, so we can
      // skip finalMessage() and its variable-latency connection teardown.
      let model = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let inputReported = false;
      let outputReported = false;
      let cacheCreationTokens: number | undefined;
      let cacheReadTokens: number | undefined;
      let cacheCreation5mTokens: number | undefined;
      let cacheCreation1hTokens: number | undefined;
      let hasCacheCreationBreakdown = false;
      let inferenceGeo: string | undefined;
      let serviceTier: string | undefined;
      let stopReason: string = 'end_turn';
      let providerStopReason: string | undefined;
      let sawTerminalEvent = false;
      let stopSequence: string | undefined;
      let stopDetails: unknown;
      // The thinking-binding report: final in message_start, replaced by a
      // message_delta's after a server-side model fallback.
      let inputTransformations: unknown;
      let messageId: string | undefined;
      let messageStartEvent: unknown;
      let messageDeltaEvent: unknown;
      const unhandledEvents: unknown[] = [];
      let unhandledOmitted = 0;
      const noteUnhandled = (event: unknown): void => {
        if (unhandledEvents.length < UNHANDLED_EVENTS_MAX) unhandledEvents.push(boundedProviderEvent(event));
        else unhandledOmitted++;
      };

      const contentBlocks: Record<string, unknown>[] = [];
      let currentBlockIndex = -1;
      let currentBlockContent = '';
      let currentBlockInputJson = '';
      // display:'omitted' models emit thinking blocks with no thinking_delta at
      // all (signature only), so the tag opens on the first delta.
      const wrapThinkingTags = options?.wrapThinkingTags === true;
      let thinkingTagOpen = false;
      // A stream can end with a block still open: a tool call truncated by
      // max_tokens sends content_block_start and input_json_delta fragments, then
      // message_delta, with no content_block_stop.
      let openBlockIndex = -1;
      // Block events come in the API's order: a start while no block is open,
      // at the next index, then that block's deltas (a tool call's carry only
      // its arguments) and its stop. A stream that ends with a block open, as a
      // max_tokens cut does, is in order.
      let blockOrderBroken = false;

      const finalizeContentBlock = (blockIdx: number, sawBlockStop: boolean): void => {
        const block = contentBlocks[blockIdx];
        if (block) {
          if (block.type === 'text') {
            block.text = currentBlockContent;
          } else if (block.type === 'thinking') {
            block.thinking = currentBlockContent;
            if (thinkingTagOpen) {
              callbacks.onChunk('</thinking>\n');
              thinkingTagOpen = false;
            }
          } else if (block.type === 'tool_use') {
            if (!sawBlockStop) {
              block.unparseableInput = currentBlockInputJson;
            } else if (currentBlockInputJson) {
              const parsed = toolUseInputFromText(currentBlockInputJson);
              if (parsed.unparseableInput === undefined) block.input = parsed.input;
              else block.unparseableInput = parsed.unparseableInput;
            }
          } else if (isAnthropicServerBlock(block) && 'input' in block) {
            // A server tool's call (server_tool_use, mcp_tool_use) streams its input as
            // input_json_delta fragments, as a tool_use does, and its content_block_start
            // carried `input: {}`. The block goes back verbatim in later turns, and the
            // API refuses input that isn't an object, so it keeps the fragments only
            // when it stopped and they parse to an object.
            let whole = sawBlockStop;
            if (whole && currentBlockInputJson.trim()) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(currentBlockInputJson);
              } catch {
                whole = false;
              }
              if (whole && isPlainObject(parsed)) block.input = parsed;
              else whole = false;
            }
            if (!whole) {
              block.unparseableInput = currentBlockInputJson;
              console.warn(
                `[membrane:anthropic] the streamed input of ${String(block.type)} ${String(block.id ?? '(no id)')} ` +
                `${sawBlockStop ? "didn't parse to an object" : 'was cut off before its block stopped'} ` +
                `(${currentBlockInputJson.length} characters); it keeps the start's input, marked`,
              );
            }
          }
        }
        callbacks.onContentBlock?.(blockIdx, contentBlocks[blockIdx]);
      };

      const breakBlockOrder = (event: unknown): void => {
        if (!blockOrderBroken) {
          const { type, index } = event as { type?: unknown; index?: unknown };
          console.warn(
            `[membrane:anthropic] a ${String(type)} at index ${String(index)} is out of the API's block order: ` +
            'no later block event is applied, and every tool_use block in the response is marked',
          );
        }
        blockOrderBroken = true;
        noteUnhandled(event);
      };

      for await (const event of stream) {
        sawEvent = true;
        resetIdleTimer();
        // From message_start on, the provider has processed the request's prefix.
        if (event.type === 'message_start') {
          this.cacheKeepalive?.record(fullRequest as unknown as Record<string, unknown>, headers, 'stream', sentAt);
        }
        // Every SDK event is progress; the SDK drops pings before this loop.
        options?.onProgress?.(contentOfAnthropicEvent(event));
        if (event.type === 'message_start') {
          model = event.message.model;
          messageId = typeof event.message.id === 'string' && event.message.id ? event.message.id : undefined;
          {
            const { content: _content, ...messageWithoutContent } = event.message as unknown as Record<string, unknown>;
            messageStartEvent = boundedProviderEvent({ ...event, message: messageWithoutContent });
          }
          inputTransformations = (event.message as { input_transformations?: unknown }).input_transformations;
          const usage = event.message.usage as unknown as Record<string, unknown>;
          inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          inputReported = typeof usage.input_tokens === 'number';
          cacheCreationTokens = typeof usage.cache_creation_input_tokens === 'number'
            ? usage.cache_creation_input_tokens : undefined;
          cacheReadTokens = typeof usage.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens : undefined;
          const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
          if (cacheCreation) {
            hasCacheCreationBreakdown = true;
            cacheCreation5mTokens = typeof cacheCreation.ephemeral_5m_input_tokens === 'number'
              ? cacheCreation.ephemeral_5m_input_tokens : 0;
            cacheCreation1hTokens = typeof cacheCreation.ephemeral_1h_input_tokens === 'number'
              ? cacheCreation.ephemeral_1h_input_tokens : 0;
          }
          inferenceGeo = typeof usage.inference_geo === 'string' ? usage.inference_geo : undefined;
          serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined;

        } else if (event.type === 'content_block_start') {
          if (blockOrderBroken || openBlockIndex >= 0 || event.index !== contentBlocks.length) {
            breakBlockOrder(event);
          } else {
            currentBlockIndex = event.index;
            openBlockIndex = event.index;
            currentBlockContent = '';
            currentBlockInputJson = '';
            contentBlocks[currentBlockIndex] = { ...event.content_block };
            callbacks.onContentBlock?.(currentBlockIndex, event.content_block);
          }

        } else if (event.type === 'content_block_delta') {
          if (
            blockOrderBroken || openBlockIndex < 0 || event.index !== openBlockIndex ||
            (isToolCallBlock(contentBlocks[openBlockIndex]) && !isToolCallArgumentsDelta(event.delta))
          ) {
            breakBlockOrder(event);
          } else if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            currentBlockContent += chunk;
            callbacks.onChunk(chunk);
          } else if (event.delta.type === 'thinking_delta') {
            currentBlockContent += event.delta.thinking;
            if (wrapThinkingTags && !thinkingTagOpen) {
              callbacks.onChunk('<thinking>');
              thinkingTagOpen = true;
            }
            callbacks.onChunk(event.delta.thinking);
          } else if ((event.delta as { type: string }).type === 'signature_delta') {
            // signature_delta carries the signature that authenticates this thinking
            // block, which later requests send back signed.
            const sig = (event.delta as { signature?: string }).signature;
            const block = contentBlocks[currentBlockIndex];
            if (block && block.type === 'thinking' && sig) {
              block.signature = ((block.signature as string | undefined) ?? '') + sig;
              callbacks.onThinkingSignature?.(currentBlockIndex, block.signature as string);
            }
          } else if ((event.delta as { type: string }).type === 'input_json_delta') {
            currentBlockInputJson += (event.delta as { partial_json: string }).partial_json;
          } else {
            noteUnhandled(event);
          }

        } else if (event.type === 'content_block_stop') {
          const stopped = (event as { index: number }).index;
          if (blockOrderBroken || openBlockIndex < 0 || stopped !== openBlockIndex) {
            breakBlockOrder(event);
          } else {
            finalizeContentBlock(stopped, true);
            openBlockIndex = -1;
            // A stop has carried only type and index; anything more is new.
            if (Object.keys(event).some((key) => key !== 'type' && key !== 'index')) noteUnhandled(event);
          }

        } else if (event.type === 'message_delta') {
          // message_stop and the SSE teardown after it add only variable latency,
          // with no data.
          const delta = event.delta as {
            stop_reason?: string;
            stop_sequence?: string;
            stop_details?: unknown;
          };
          stopReason = delta.stop_reason ?? 'end_turn';
          providerStopReason = delta.stop_reason ?? undefined;
          sawTerminalEvent = true;
          messageDeltaEvent = boundedProviderEvent(event);
          const fallback = (event as { input_transformations?: unknown }).input_transformations;
          if (Array.isArray(fallback)) inputTransformations = fallback;
          stopSequence = delta.stop_sequence ?? undefined;
          // stop_details carries refusal metadata (e.g., category: 'reasoning_extraction')
          stopDetails = delta.stop_details ?? undefined;
          const deltaUsage = event.usage as unknown as {
            output_tokens: number;
            cache_creation_input_tokens?: number | null;
            cache_read_input_tokens?: number | null;
          };
          outputTokens = deltaUsage.output_tokens ?? 0;
          if (typeof deltaUsage.output_tokens === 'number') outputReported = true;
          // message_delta carries cumulative cache metrics — use as authoritative
          if (deltaUsage.cache_creation_input_tokens != null) {
            cacheCreationTokens = deltaUsage.cache_creation_input_tokens;
          }
          if (deltaUsage.cache_read_input_tokens != null) {
            cacheReadTokens = deltaUsage.cache_read_input_tokens;
          }
          break;
        } else {
          // An event type this loop doesn't read (pings never reach it). The
          // SDK yields only the event types it knows, so this keeps one only
          // if a later SDK passes it on.
          noteUnhandled(event);
        }
      }

      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      if (openBlockIndex >= 0) {
        finalizeContentBlock(openBlockIndex, false);
        openBlockIndex = -1;
      }
      if (blockOrderBroken) {
        for (const block of contentBlocks) {
          if (block?.type === 'tool_use' && block.unparseableInput === undefined) {
            block.unparseableInput = JSON.stringify(block.input ?? {});
            block.input = {};
          }
        }
      }

      // Force-close the HTTP connection so we don't block on SSE drain
      try { stream.controller.abort(); } catch { }

      assertTerminalEventObserved(sawTerminalEvent, 'Anthropic', fullRequest);

      // The SDK's MessageStream records the request-id header on connect,
      // before its first event.
      const requestId = sdkRequestId(stream, 'request_id');

      return {
        content: contentBlocks,
        stopReason,
        providerStopReason,
        ...readRefusalCategory(stopReason, stopDetails),
        stopSequence,
        ...(messageId ? { responseId: messageId } : {}),
        ...(requestId ? { requestId } : {}),
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
        },
        ...unreportedUsage(inputReported ? inputTokens : undefined, outputReported ? outputTokens : undefined),
        ...readInputTransformations(inputTransformations, anthropicRequest.messages),
        model,
        rawRequest: fullRequest,
        raw: {
          content: contentBlocks,
          stop_reason: stopReason,
          stop_sequence: stopSequence ?? null,
          stop_details: stopDetails ?? null,
          model,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
            ...(hasCacheCreationBreakdown ? {
              cache_creation: {
                ephemeral_5m_input_tokens: cacheCreation5mTokens ?? 0,
                ephemeral_1h_input_tokens: cacheCreation1hTokens ?? 0,
              },
            } : {}),
            ...(inferenceGeo ? { inference_geo: inferenceGeo } : {}),
            ...(serviceTier ? { service_tier: serviceTier } : {}),
          },
          ...(Array.isArray(inputTransformations) ? { input_transformations: inputTransformations } : {}),
          ...(messageId ? { id: messageId } : {}),
          ...(requestId ? { request_id: requestId } : {}),
          provider_events: {
            ...(messageStartEvent !== undefined ? { message_start: messageStartEvent } : {}),
            ...(messageDeltaEvent !== undefined ? { message_delta: messageDeltaEvent } : {}),
            ...(unhandledEvents.length ? { unhandled: unhandledEvents } : {}),
            ...(unhandledOmitted ? { unhandled_omitted: unhandledOmitted } : {}),
          },
        },
      };

    } catch (error) {
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      // The idle watchdog fired: whatever the SDK wrapped the abort in
      // (AbortError, APIUserAbortError "Request was aborted.", a connection
      // error), the cause is the stalled stream.
      if (idleTimedOut) {
        throw deadlineExpired(new MembraneError({
          type: 'timeout',
          message: sawEvent
            ? `SSE stream idle timeout — no observed activity within ${idleMs}ms`
            : `SSE stream first-event timeout — no message_start within ${firstEventMs}ms (TTFT deadline)`,
          retryable: true,
          rawError: error,
          rawRequest: fullRequest,
        }));
      }
      // A deadline on the caller's signal (Membrane's progressTimeoutMs) is a
      // timeout with its own message, whatever the SDK wrapped the abort in.
      if (isDeadlineAbort(options?.signal?.reason)) throw deadlineTimeoutError(options!.signal!.reason, fullRequest);
      throw this.handleError(session?.failure() ?? error, fullRequest);
    }
  }

  private liveHeaders(base: Record<string, string> | undefined, lane: DynamicHeadersContext['lane']): Record<string, string> | undefined {
    const dyn = runCallerCode(() => this.dynamicHeaders?.({ lane }));
    if (!dyn) return base;
    const out: Record<string, string> = { ...(base ?? {}) };
    for (const [k, v] of Object.entries(dyn)) {
      if (v !== null && v !== undefined && v !== '') out[k] = String(v);
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** Any default anthropic-beta (oauth) is re-carried in the same header: the
   *  SDK replaces same-key defaults instead of merging, and the API accepts
   *  comma-separated betas. */
  private betaHeaders(request: ProviderRequest, built: { thinking?: unknown; messages?: unknown }): Record<string, string> | undefined {
    const needed: string[] = [];
    if (thinkingEnabled(request) && needsInterleavedThinkingBeta(request.model)) needed.push(INTERLEAVED_THINKING_BETA);
    if (sendsBlockBinding(built)) needed.push(THINKING_BINDING_BETA);
    if (sendsDisplayUpdates(built)) needed.push(THINKING_DISPLAY_UPDATES_BETA);
    if (sendsToolChanges(built)) needed.push(INLINE_TOOLS_BETA);
    if (needed.length === 0) return undefined;
    const betas = new Set(
      (this.defaultBeta ?? '').split(',').map((b) => b.trim()).filter(Boolean),
    );
    for (const beta of needed) betas.add(beta);
    return { 'anthropic-beta': [...betas].join(',') };
  }

  private buildRequest(request: ProviderRequest, onContentAltered?: (block?: unknown) => void): Anthropic.MessageCreateParams {
    // Anthropic rejects extra inputs on an image block (e.g. Gemini's
    // sourceUrl), and expects snake_case `media_type` where membrane writes
    // `mediaType`: a nested tool_result image with `{source: {mediaType: ...}}`
    // fails the API's validation.
    const sanitizedMessages = (request.messages as any[]).map((msg: any) => {
      if (!Array.isArray(msg.content)) return msg;
      const converted = convertMcpMedia(msg.content as unknown[]);
      return {
        ...msg,
        content: msg.content.map((original: any, index: number) => {
          const block = converted[index] as any;
          if (isSourcelessMedia(block)) {
            onContentAltered?.(original);
            return undefined;
          }
          if (isUnsignedThinking(block)) {
            // The API refuses a thinking block without a valid signature, as another provider's reasoning has.
            onContentAltered?.(original);
            return undefined;
          }
          if (block.type === 'image') {
            const { sourceUrl, ...rest } = block;
            if (block.source?.type === 'url') {
              const image = urlImageForRequest(block.source.url);
              if (image.placeholder) {
                onContentAltered?.(original);
                return rest.cache_control ? { ...image.placeholder, cache_control: rest.cache_control } : image.placeholder;
              }
              if (image.data) return { ...rest, source: { type: 'base64', media_type: image.mediaType, data: image.data } };
              return rest;
            }
            if (block.source?.type !== 'base64') return rest;
            // A wire-shaped source keeps its key order, so an already-correct image
            // serializes to the same bytes as before (the prompt cache reads bytes).
            const { mediaType, ...source } = block.source;
            const image = imageForRequest(source.data, source.media_type ?? mediaType);
            if (image.placeholder) {
              onContentAltered?.(original);
              return rest.cache_control ? { ...image.placeholder, cache_control: rest.cache_control } : image.placeholder;
            }
            return {
              ...rest,
              source: {
                ...source,
                media_type: image.mediaType,
              },
            };
          }
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            let substituted = false;
            const content = toAnthropicToolResultContent(block.content as ContentBlock[], () => { substituted = true; });
            // Anthropic's tool_result content takes only text and image blocks.
            const carried = (block.content as Array<{ type?: string; text?: unknown }>)
              .filter((b) => !(b?.type === 'text' && (typeof b.text !== 'string' || b.text === ''))).length;
            if (content.length !== carried || substituted) onContentAltered?.(original);
            return { ...block, content };
          }
          if (block.type === 'tool_addition' && block.tool?.type === 'tool_definition' && block.tool.definition) {
            const definition = block.tool.definition;
            const flattened = flattenRootSchemaUnion(definition.input_schema);
            if (flattened !== definition.input_schema) {
              onContentAltered?.(original);
              return { ...block, tool: { ...block.tool, definition: { ...definition, input_schema: flattened } } };
            }
          }
          return block;
        }).filter((block: unknown) => block !== undefined),
      };
    });

    assertWithinByteBudget(sanitizedMessages, undefined, 'anthropic-provider');

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: sanitizedMessages as Anthropic.MessageParam[],
    };
    
    if (request.system) {
      if (typeof request.system === 'string') {
        params.system = request.system;
      } else if (Array.isArray(request.system)) {
        params.system = request.system as Anthropic.TextBlockParam[];
      }
    }
    
    // The API refuses sampling parameters with a 400 on the models
    // NO_TEMPERATURE_MODELS lists, and under extended thinking refuses a custom
    // temperature or top_k on every model.
    const stripSampling = noTemperatureSupport(request.model);
    const thinkingOn = thinkingEnabled(request);

    if (request.temperature !== undefined && !stripSampling && !thinkingOn) {
      params.temperature = request.temperature;
    }

    // The API refuses temperature and top_p together, and under thinking a top_p below 0.95.
    if (
      request.topP !== undefined &&
      params.temperature === undefined &&
      !stripSampling &&
      (!thinkingOn || request.topP >= 0.95)
    ) {
      params.top_p = request.topP;
    }

    if (request.topK !== undefined && !stripSampling && !thinkingOn) {
      params.top_k = request.topK;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop_sequences = request.stopSequences;
    }
    
    if (request.tools && request.tools.length > 0) {
      // MCP allows a root-level oneOf/anyOf/allOf in a tool's input schema; the
      // API refuses it ("input_schema does not support oneOf, allOf, or anyOf at
      // the top level") for the whole request.
      params.tools = (request.tools as Anthropic.Tool[]).map(tool => {
        const inputSchema = (tool as { input_schema?: unknown }).input_schema;
        const flattened = flattenRootSchemaUnion(inputSchema);
        return flattened === inputSchema
          ? tool
          : ({ ...tool, input_schema: flattened } as Anthropic.Tool);
      });
    }

    if (request.thinking) {
      (params as any).thinking = request.thinking;
    }

    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      if (stripSampling || thinkingOn) {
        delete rest.temperature;
        delete rest.top_k;
        const extraTopP = rest.top_p;
        if (stripSampling || typeof extraTopP !== 'number' || extraTopP < 0.95) {
          delete rest.top_p;
        }
      }
      if (rest.messages !== undefined) onContentAltered?.();
      Object.assign(params, rest);
    }

    stripEmptyTextAfterPassthrough(params, onContentAltered);
    return params;
  }

  private parseResponse(response: Anthropic.Message, rawRequest: unknown): ProviderResponse {
    // The SDK attaches the request-id header as a non-enumerable
    // `_request_id`, so it never reached a serialized raw response.
    const requestId = sdkRequestId(response, '_request_id');
    const responseId = typeof response.id === 'string' && response.id ? response.id : undefined;
    return {
      ...(responseId ? { responseId } : {}),
      ...(requestId ? { requestId } : {}),
      content: response.content,
      stopReason: response.stop_reason ?? 'end_turn',
      providerStopReason: response.stop_reason ?? undefined,
      ...readRefusalCategory(response.stop_reason, (response as { stop_details?: unknown }).stop_details),
      stopSequence: response.stop_sequence ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: (response.usage as any).cache_creation_input_tokens,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens,
      },
      ...unreportedUsage(response.usage?.input_tokens, response.usage?.output_tokens),
      ...readInputTransformations(
        (response as { input_transformations?: unknown }).input_transformations,
        (rawRequest as { messages?: unknown } | undefined)?.messages,
      ),
      model: response.model,
      rawRequest,
      raw: requestId ? { ...response, request_id: requestId } : response,
    };
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    const typed = this.typeError(error, rawRequest);
    // The API says in `x-should-retry` whether a failure is worth sending again.
    const advice = error instanceof Anthropic.APIError ? error.headers?.get?.('x-should-retry') : undefined;
    if ((advice === 'true' || advice === 'false') && typed.retryable !== (advice === 'true')) {
      const advised = new MembraneError({ ...typed.toErrorInfo(), retryable: advice === 'true' });
      return isDeadlineExpiry(typed) ? deadlineExpired(advised) : advised;
    }
    return typed;
  }

  private typeError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);

    // The SDK's APIUserAbortError has `name === 'Error'` (@anthropic-ai/sdk
    // 0.52), so isTypedAbortError doesn't match it: the instanceof arm does.
    if (error instanceof Anthropic.APIUserAbortError || isTypedAbortError(error)) {
      return abortError(undefined, rawRequest);
    }

    // The SDK's transport failures carry no status ("Connection error.",
    // `cause: TypeError: fetch failed`). It reports its own request timeout,
    // undici's headers timeout and a connect timeout as this same error, with no
    // cause (SDK 0.52 makeRequest), so a connect timeout can't be told apart.
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return deadlineExpired(timeoutError(error.message, error, rawRequest));
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return networkError(error.message, error, rawRequest);
    }

    if (error instanceof Anthropic.APIError) {
      const message = error.message;

      const gw = message.toLowerCase();

      // Mid-stream SSE `error` events are rethrown by the SDK as APIError
      // with status === undefined (sdk core/streaming.js); overloaded_error
      // (529) most commonly arrives this way.
      const classified = errorFromProviderStatus({
        provider: this.name,
        status: error.status,
        body: error.error,
        message,
        retryAfterMs: this.parseRetryAfter(error),
        rawError: error,
        rawRequest,
      });

      // Vercel AI Gateway wraps transient upstream outages (a fallback provider's
      // 503, routing churn on a sunsetting model) in non-5xx aggregate errors
      // whose body carries gateway routing metadata, and the same request often
      // succeeds on retry once a live provider is picked.
      const status = error.status ?? statusForProviderCode(classified.providerErrorCode);
      const gatewayAggregate = gw.includes("providermetadata") || gw.includes("fallbacksavailable") ||
        gw.includes("modelattempts") || gw.includes("temporarily unavailable") ||
        gw.includes("no_providers_available");
      if (gatewayAggregate && status !== 400 && status !== 401 && status !== 429 && !(status !== undefined && status >= 500)) {
        return new MembraneError({
          type: 'server',
          message,
          retryable: true,
          httpStatus: gw.includes('overloaded') ? 529 : status ?? 503,
          retryAfterMs: classified.retryAfterMs,
          providerErrorCode: classified.providerErrorCode,
          rawError: error,
          rawRequest,
        });
      }
      if (classified.httpStatus === 400 && isSystemChangeRefusal(error.error)) markSystemChangeRefused(classified);
      if (classified.type !== 'unknown') return classified;

      if (gw.includes('overloaded')) {
        return serverError(message, 529, error, rawRequest);
      }
    }

    return errorFromThrown(error, rawRequest);
  }

  private parseRetryAfter(error: { headers?: Headers }): number | undefined {
    // retry-after-ms first, as Anthropic's SDK reads them.
    const ms = Number(error.headers?.get?.('retry-after-ms')?.trim() || NaN);
    if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
    const header = error.headers?.get?.('retry-after');
    if (header) {
      const seconds = Number(header.trim());
      if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
      const at = Date.parse(header.trim());
      if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    }
    return undefined;
  }
}

function toAnthropicToolResultContent(
  blocks: ContentBlock[],
  onPlaceholder?: () => void,
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  const out: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const block of stripEmptyTextBlocks(blocks)) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const image = block.source?.type === 'base64'
        ? anthropicImage(block.source.data, block.source.mediaType ?? (block.source as { media_type?: string }).media_type)
        : block.source?.type === 'url' ? anthropicUrlImage(block.source.url) : undefined;
      if (image?.type === 'text') onPlaceholder?.();
      if (image) out.push(image);
    }
  }
  return out;
}

/** The API refuses an image whose declared type doesn't match its bytes (a
 *  PNG tagged image/jpeg is a 400), and storage can lose or mislabel it. */
function anthropicImage(data: string, declared: unknown): Anthropic.ImageBlockParam | Anthropic.TextBlockParam {
  const image = imageForRequest(data, declared);
  if (image.placeholder) return image.placeholder;
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data } };
}

function anthropicUrlImage(url: string): Anthropic.ImageBlockParam | Anthropic.TextBlockParam {
  const image = urlImageForRequest(url);
  if (image.placeholder) return image.placeholder;
  return image.data
    ? { type: 'image', source: { type: 'base64', media_type: image.mediaType!, data: image.data } }
    : { type: 'image', source: { type: 'url', url: image.url } };
}

/**
 * Convert one turn's normalized content to Anthropic content blocks, for a
 * caller outside membrane's own builds.
 *
 * With `role: 'assistant'`, an Anthropic server-tool block, or its zero-width
 * carrier, goes out as the block itself, in the place it had in the turn that
 * produced it, except a server call with no result after it in the turn, or
 * a result with no call before it, which the API refuses. With
 * `lastMessage`, the turn is the request's final message, a paused turn
 * being resumed, and keeps its lone calls; without it, every lone one is
 * left out. In any other role a server block is left out. A caller that
 * names no role gets that too. Media in MCP's form is converted to
 * membrane's first, at the top of the turn and inside a `tool_result`. A
 * document that doesn't convert, with no source after that, is left out, and
 * so is an image with no source object that isn't MCP's form, with neither
 * `data` nor `mimeType`. A thinking block with no signature is left out too.
 * Nothing reports what it leaves out: it has no alteration callback. It sees
 * one turn, so a turn whose only blocks it or pairing leaves out comes back
 * empty, for the caller to drop, unless it's the final turn and dropping it
 * would change the request's final role.
 */
export function toAnthropicContent(
  blocks: ContentBlock[],
  options: { role?: 'user' | 'assistant'; lastMessage?: boolean } = {},
): Anthropic.ContentBlockParam[] {
  const result: Anthropic.ContentBlockParam[] = [];

  const swapped = convertMcpMedia(blocks).flatMap((block): Array<ContentBlock | AnthropicServerBlock> => {
    const serverBlock = anthropicServerBlockFor(block);
    if (serverBlock === undefined) return [block];
    return options.role === 'assistant' ? [serverBlock] : [];
  });
  const unpaired = unpairedServerBlocks(swapped, options.lastMessage === true);
  const sendable = stripEmptyTextBlocks(swapped.filter((block) => !unpaired.has(block)));
  for (const block of sendable) {
    if (isAnthropicServerBlock(block)) {
      result.push(block as unknown as Anthropic.ContentBlockParam);
      continue;
    }
    switch (block.type) {
      case 'text': {
        const textBlock: any = { type: 'text', text: block.text };
        if (block.cache_control) {
          textBlock.cache_control = block.cache_control;
        }
        result.push(textBlock);
        break;
      }
        
      case 'image':
        if (block.source?.type === 'base64') {
          result.push(anthropicImage(block.source.data, block.source.mediaType ?? (block.source as { media_type?: string }).media_type));
        } else if (block.source?.type === 'url') {
          result.push(anthropicUrlImage(block.source.url));
        }
        break;
        
      case 'document':
        if (isSourcelessMedia(block)) break;
        result.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.source.mediaType as 'application/pdf',
            data: block.source.data,
          },
          ...(block.filename ? { title: block.filename } : {}),
        });
        break;

      case 'generated_image':
        result.push(anthropicImage(block.data, block.mimeType));
        break;
        
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
        
      case 'tool_result':
        result.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: typeof block.content === 'string'
            ? block.content
            : toAnthropicToolResultContent(block.content),
          is_error: block.isError,
        });
        break;
        
      case 'thinking':
        // The API refuses a thinking block without a valid signature.
        if (isUnsignedThinking(block)) break;
        result.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        } as any);
        break;

      case 'redacted_thinking':
        // Round-trip verbatim — `data` is the encrypted reasoning payload;
        // the API rejects/ignores the block without it.
        result.push({
          type: 'redacted_thinking',
          data: (block as any).data,
        } as any);
        break;

      default: {
        const unsupportedType = (block as { type?: string }).type ?? 'unknown';
        throw unsupportedError(
          `Anthropic has no representation for a "${unsupportedType}" content block, and dropping`
          + ' it would send the model a message missing content the caller supplied.'
          + ' Remove or convert the block before sending it on this provider.'
        );
      }
    }
  }

  return result;
}

const warnedUnconvertibleResponseBlocks = new Set<string>();

function preserveUnconvertibleBlock(block: unknown, sourceLabel: string): ContentBlock {
  const blockType = (block as { type?: string })?.type ?? 'unknown';
  if (!warnedUnconvertibleResponseBlocks.has(blockType)) {
    warnedUnconvertibleResponseBlocks.add(blockType);
    console.warn(
      `[membrane:${sourceLabel}] no normalized ContentBlock for provider block type`
      + ` "${blockType}" — preserving it verbatim as a rawItem carrier so it can be`
      + ' replayed, but its content is not visible to normalized consumers.'
    );
  }
  return { type: 'text', text: '', rawItem: block } as ContentBlock;
}

export function resetUnconvertibleBlockWarnings(): void {
  warnedUnconvertibleResponseBlocks.clear();
}

/**
 * Convert Anthropic response content to normalized format
 */
export function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        result.push({ type: 'text', text: block.text });
        break;
        
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          ...toolUseInputFromValue(block.input),
        });
        break;
        
      case 'thinking':
        result.push({
          type: 'thinking',
          thinking: (block as any).thinking,
          signature: (block as any).signature,
        });
        break;
        
      default:
        if ((block as any).type === 'redacted_thinking') {
          // Preserve the encrypted `data` payload — without it the block
          // cannot be round-tripped and prior reasoning is lost.
          result.push({ type: 'redacted_thinking', data: (block as any).data } as any);
        } else if (isAnthropicServerBlock(block)) {
          result.push({ type: 'text', text: '', rawItem: block } as ContentBlock);
        } else {
          result.push(preserveUnconvertibleBlock(block, 'anthropic'));
        }
        break;
    }
  }
  
  return result;
}
