/**
 * Anthropic provider adapter
 */

import { unreportedUsage } from '../utils/usage.js';
import { assertMessagePrefillSupported } from './request-capabilities.js';

import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { stripEmptyTextBlocks, stripEmptyTextRequest } from '../utils/empty-text.js';
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
import { assertTerminalEventObserved, toolUseInputFromText, toolUseInputFromValue, isDeadlineAbort, deadlineTimeoutError, isToolCallBlock, isToolCallArgumentsDelta } from './utils.js';
import { fetchWithCredentials, validateCredential, type CredentialContext, type CredentialResolver } from './credentials.js';
import { CacheKeepalive, type CacheKeepaliveConfig } from '../cache-keepalive.js';

// ============================================================================
// Model capability gates
// ============================================================================

/**
 * Models that reject the sampling parameters (`temperature`, `top_p`,
 * `top_k`) with a 400 invalid_request_error — which Membrane classifies as
 * non-retryable, so a single stray `temperature` kills the whole turn.
 * The OpenAI provider keeps a `noTemperatureSupport` list of its own, matched
 * by prefix.
 *
 * Each entry names one model that refuses them: documented, measured, or,
 * for Mythos 5.1, a member of the always-thinking family (below). Nothing
 * else is listed: this gate doesn't strip them for a model the list doesn't
 * name, so one that refuses them fails with the API's 400 until it's listed
 * here. The other gates in `buildRequest` still apply to every model (no
 * `top_p` beside a `temperature`, and under thinking no `temperature` or
 * `top_k` and no `top_p` below 0.95), and
 * `Membrane` drops them from a request's config for every Fable and Mythos
 * id by family name (`isAlwaysThinkingModel`), before this adapter sees the
 * request. Through `Membrane`, then, this list decides for those ids only
 * what a caller sends in `providerParams`. Haiku 4.5, Sonnet 4.6, Opus 4.6 and older ACCEPT
 * `temperature`, so they must NOT be listed.
 *
 *   - Opus 4.7 / Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 / Mythos preview:
 *     documented 400 on any sampling parameter (Sonnet 5 rejects only
 *     non-default values).
 *   - Haiku 5.5: measured against the Messages API on 2026-10-19, with no
 *     thinking config. `temperature` 0.2, `top_k` 40, and `top_p` 0.9 and 0.95
 *     were each refused with a 400 ("`temperature` is deprecated for this
 *     model", and likewise for the other two); `top_p` 0.99 was accepted.
 *   - Opus 5 and Opus 5.5: measured the same way on 2026-10-23, unstreamed.
 *     Each refused `temperature` 0.2, `top_k` 40 and `top_p` 0.9 with the same
 *     400s, and took a `top_p` of 0.99.
 *   - Fable 5.1: measured the same way on 2026-10-23, with the same answers.
 *   - Sonnet 5.5: `top_p` 0.9 refused and 0.99 accepted on 2026-10-19, and
 *     `temperature` 0.2 and `top_k` 40 refused on 2026-10-23, the same way.
 *   - Mythos 5.1: not measured, since our accounts aren't served it. Listed
 *     because membrane treats the Fable and Mythos family as always thinking
 *     (`Membrane.isAlwaysThinkingModel`), and with thinking on the API takes
 *     no custom `temperature` or `top_k`.
 *
 * A listed model loses every `top_p`, 0.99 included, with a thinking config
 * or without one.
 *
 * NB: claude-haiku-4-5 was previously listed here on the strength of a single
 * "observed 400 in production when temperature is sent" anecdote. Haiku 4.5
 * documentably supports `temperature`; the production 400 was almost certainly
 * the `extra`-params bypass fixed in this same PR (a sampling param smuggled
 * through `extra` and re-inserted after the gate — 400s on any model), not a
 * capability of Haiku. Listing it silently discarded a valid parameter on the
 * most common cheap model, so it has been removed.
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

/**
 * Whether `model` is a listed model: its id, or its id followed by anything
 * that isn't a later version, such as a dated snapshot
 * (claude-opus-4-8-20251001). A digit, or a hyphen and one or two digits,
 * continues the version, so `claude-opus-5` doesn't name `claude-opus-5-5`
 * or `claude-opus-5-6`, and each is listed on its own or not at all.
 */
function noTemperatureSupport(model: string): boolean {
  return NO_TEMPERATURE_MODELS.some((id) => model.startsWith(id) && !/^(\d|-\d{1,2}(?!\d))/.test(model.slice(id.length)));
}

/** Beta flag for thinking blocks between tool calls on pre-4.6 Claude 4.
 *  Shared with the Bedrock adapter, where it rides in the request body
 *  (`anthropic_beta`) instead of an HTTP header. */
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

/**
 * Interleaved thinking (thinking blocks between tool calls) is native from
 * Opus/Sonnet 4.6 onward; earlier Claude 4 models only do it behind the
 * `interleaved-thinking-2025-05-14` beta flag. Matches Claude 4 ids with a
 * minor version below 6 — dated snapshots (claude-opus-4-1-20250805), bare
 * bases (claude-opus-4), and date-only 4.0 ids (claude-opus-4-20250514) are
 * all covered, as are gateway-prefixed ids ('anthropic/claude-opus-4-5').
 * Claude 3.x never matches (no interleaved support, beta or not); 4.6+ and
 * the 5-series need no flag.
 */
export function needsInterleavedThinkingBeta(model: string): boolean {
  const m = /claude-(?:opus|sonnet|haiku)-4(?:-(\d+))?/.exec(model);
  if (!m) return false;
  const minor = m[1];
  if (minor === undefined) return true; // bare 'claude-opus-4'
  if (minor.length >= 8) return true;   // 8-digit date right after the major = a 4.0 id
  return parseInt(minor, 10) < 6;
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

/** Whether a built request asks for thinking-binding controls, which need
 *  their beta. Read from the final body, so a thinking config passed through
 *  `extra` counts too. */
export function sendsBlockBinding(params: { thinking?: unknown }): boolean {
  const binding = (params.thinking as { block_binding?: unknown } | null | undefined)?.block_binding;
  return binding !== undefined && binding !== null;
}

/** Beta flag for `thinking.display: 'updates'`, which returns the progress
 *  notes the model writes between tool calls as text while reasoning stays
 *  hidden. Without the beta the API rejects 'updates' as an unknown display
 *  value. Shared with the Bedrock adapter, where it rides in `anthropic_beta`. */
export const THINKING_DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18';

/** Whether a built request asks for `display: 'updates'`, which needs its
 *  beta. Read from the final body, so a thinking config passed through
 *  `extra` counts too. */
export function sendsDisplayUpdates(params: { thinking?: unknown }): boolean {
  return (params.thinking as { display?: unknown } | null | undefined)?.display === 'updates';
}

/** Beta flag for mid-conversation tool changes (`tool_addition` and
 *  `tool_removal` in a `role: 'system'` message), definitions by value
 *  included. System text there needs none. */
export const INLINE_TOOLS_BETA = 'inline-tools-2026-09-15';

/** Whether a built request carries a tool change, which needs its beta. */
export function sendsToolChanges(params: { messages?: unknown }): boolean {
  return Array.isArray(params.messages) && params.messages.some((message: { role?: unknown; content?: unknown }) =>
    message?.role === 'system' && Array.isArray(message.content) &&
    message.content.some((block: { type?: unknown }) => block?.type === 'tool_addition' || block?.type === 'tool_removal'));
}

/** The API's wordings, in a 400, for a model that takes no mid-conversation
 *  system message or no tool change in one (live runs, Oct 19 2026). */
const SYSTEM_CHANGE_REFUSALS = [
  "role 'system' is not supported on this model",
  'tool_addition/tool_removal requires a model that supports mid-conversation system content',
  'tool_addition/tool_removal is not supported on this model',
];

/** Whether a 400's own message is the API refusing the request's system change. */
export function isSystemChangeRefusal(body: unknown): boolean {
  const message = extractProviderErrorFields(body).message;
  return typeof message === 'string' && SYSTEM_CHANGE_REFUSALS.some((wording) => message.includes(wording));
}

/**
 * A response's `input_transformations` (Anthropic and Bedrock alike), each
 * entry with the block at its `messages.{i}.content.{j}` path in `messages`,
 * the messages as sent. Both adapters send a request's thinking blocks as
 * the request's own objects, so that is the block membrane built. Nothing
 * when the response carried no report.
 */
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

/**
 * A response's refusal category, as ProviderResponse.refusalCategory carries
 * it: `stop_details.category` when the response stopped with `refusal` and
 * the category is a non-empty string. Nothing otherwise, including a stop
 * that isn't a refusal, whatever its `stop_details` says.
 */
function readRefusalCategory(
  stopReason: string | null | undefined,
  stopDetails: unknown,
): { refusalCategory?: string } {
  if (stopReason !== 'refusal' || stopDetails === null || typeof stopDetails !== 'object') return {};
  const category = (stopDetails as { category?: unknown }).category;
  return typeof category === 'string' && category !== '' ? { refusalCategory: category } : {};
}

/** Resolve whether a thinking config is enabled on a request. Thinking can
 *  arrive top-level OR smuggled through `extra` (see the sampling gate in
 *  buildRequest) — both the sampling strip and the beta header must agree on
 *  one answer, so they share this resolver. Exported for the Bedrock adapter,
 *  which applies the same interleaved-thinking gate to its request body. */
export function thinkingEnabled(request: ProviderRequest): boolean {
  const extraThinking = (request.extra as { thinking?: { type?: string } } | undefined)?.thinking;
  const thinkingConfig = request.thinking ?? extraThinking;
  return thinkingConfig !== undefined && thinkingConfig.type !== 'disabled';
}

// ============================================================================
// Response diagnostics
// ============================================================================
//
// The stream loop consumes a fixed set of fields. What the API sends beyond
// them — a new field on message_start or message_delta, an event or delta
// type this adapter doesn't read — used to vanish, so a response that broke
// its contract (2026-10-19: tool calls stopped with end_turn) left nothing to
// diagnose it from or report it with. The stream path now keeps, on `raw`:
//   id               message_start's message id
//   request_id       the `request-id` response header (what support asks for)
//   provider_events  { message_start: the event, its message without
//                      `content`; message_delta: the event;
//                      unhandled: events and deltas the loop doesn't read,
//                      or doesn't apply (below), first
//                      UNHANDLED_EVENTS_MAX of them; unhandled_omitted:
//                      the count past that cap }
// Each kept event is bounded as boundedProviderEvent says. Block payloads stay
// in `content`; an event kept in unhandled keeps whatever it carried, payload
// included, as a citations_delta does. A new event type reaches the loop only
// if the SDK passes it on: @anthropic-ai/sdk 0.52's stream yields only the
// message and content-block events. So what this catches today is a new field
// on message_start or message_delta, extra keys on a content_block_stop, and a
// delta type the loop doesn't read; a new field on a start or delta the loop
// applies isn't kept, whether beside its block or delta or inside a delta of
// a type the loop reads.
//
// Blocks: the API sends each block's start, deltas and stop before the next
// block's start, and a tool call's deltas carry only its arguments. The
// first block event out of that order (a start while a block is open, or at
// an index other than the next; a delta or stop while no block is open, or
// for a block other than the open one; a delta a tool call can't take) stops
// the loop applying block events, with one
// warning: a block still open is finalized as cut off, that event and every
// later block event are kept in unhandled, and every tool_use block in the
// response is marked (unparseableInput), so the end_turn gate runs none of
// them and a caller can refuse them. Server tool calls (server_tool_use,
// mcp_tool_use) ran on the API's side and go back verbatim in later turns,
// so the marking leaves them as they streamed: one that stopped keeps its
// input, and one still open is marked as cut off, as before. Citations are
// the exception to "not applied": the SDK appends each one to the array a
// text block's start carried, which this loop's copy of the block shares, so
// a citation lands in such a block whatever the order (a start whose
// citations is null or absent shares none, and the SDK's new array isn't the
// loop's). A stream in order is
// unchanged, and so is one that ends with a block open, as a max_tokens cut
// does.
// message_stop is not kept: the loop ends on message_delta, by design (the
// teardown after it adds latency and carries no data).

/** Events and deltas kept in raw.provider_events.unhandled, at most. */
const UNHANDLED_EVENTS_MAX = 20;
/** JSON characters one kept provider event may take before it's truncated. */
const PROVIDER_EVENT_MAX_CHARS = 4096;

/**
 * A JSON-safe copy of a provider event, bounded: one whose JSON exceeds
 * PROVIDER_EVENT_MAX_CHARS keeps its `type`, a `truncated` flag and the first
 * PROVIDER_EVENT_MAX_CHARS characters of its JSON.
 */
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

/** The SDK's request id: MessageStream.request_id, or a parsed response's `_request_id`. */
function sdkRequestId(holder: unknown, key: 'request_id' | '_request_id'): string | undefined {
  if (holder === null || typeof holder !== 'object') return undefined;
  const id = (holder as Record<string, unknown>)[key];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

// ============================================================================
// Adapter Configuration
// ============================================================================

/**
 * What the dynamicHeaders callback is told about the request it stamps.
 * `lane` names the transport shape: 'stream' is the conversational turn loop,
 * 'complete' the non-streamed lane (compression, side-calls, keepalive
 * touches). A stamp that describes WHY the agent's turn fired belongs on the
 * stream lane only — a compression call running in the background is not the
 * turn, and stamping it with the turn's cause would lie to the ledger.
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
   * Live per-request headers, evaluated at request time — for values that
   * change between calls (e.g. household telemetry stamps such as
   * `x-gate-debt-chunks`, read by an inference gateway and stripped there
   * before the vendor ever sees them). Merged over the per-request beta
   * headers for the OUTGOING request only; cache-keepalive replays
   * deliberately resend their recorded headers, so a telemetry stamp is
   * never replayed stale — an unstamped touch is honest, a stale stamp lies.
   * null/undefined/'' values are dropped.
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
   * next wake. See `../cache-keepalive.ts`.
   * Pass `{ enabled: false }` to turn off.
   */
  cacheKeepalive?: CacheKeepaliveConfig;
}

// ============================================================================
// Anthropic Adapter
// ============================================================================

/** The SDK's fetch signature, taken from its public ClientOptions. */
type SdkFetch = NonNullable<ClientOptions['fetch']>;

/**
 * Wrap a fetch so each nonempty chunk of a successful response body is
 * reported to `observe` before the SDK parses it. The SDK drops SSE `ping`
 * events before callers see them, so this is the only point where keepalive
 * bytes are observable through public APIs. Bytes and headers pass through
 * unchanged; error responses are returned untouched so SDK error
 * classification keeps their full metadata. The rebuilt Response has an empty
 * `url`, which SDK 0.52 reads only for debug logging. Without `observe` the
 * base fetch is returned as is. SDK-supported bodies without pipeThrough also
 * pass through unchanged; their SDK events still refresh the idle watchdog.
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
  /** Membrane sends server-tool blocks back through this adapter, in the turn that produced them. Live checks had the API accept each type, with or without a cache marker, but `container_upload`, which it refuses in an assistant turn and so is left out (see utils/anthropic-server-blocks.ts). */
  readonly replaysAnthropicServerBlocks = true;
  /** Sends a mid-conversation `role: 'system'` message, with the inline-tools beta when it changes tools. Live checks had the API take tool removals and definitions by value there (Opus 5.5, Haiku 5.5), system text (Haiku 5.5, Sonnet 5), and a cache marker on each block type (Haiku 5.5). Where the model takes none, its 400 is marked `systemChangeRefused`. */
  readonly sendsSystemChanges = true;

  /**
   * Verified live 2026-08-25 (claude-haiku-4-5, 4,650-token cached system
   * prompt): call 1 returned input_tokens 8 / cache_creation_input_tokens 4650,
   * call 2 input_tokens 8 / cache_read_input_tokens 4650. `input_tokens` never
   * counts the cached span.
   */
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
  /** Live per-request header source (see AnthropicAdapterConfig.dynamicHeaders). */
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
          // Replay path. Deliberately bypasses buildRequest(): the payload is
          // the already-built wire request from a real call, and rebuilding it
          // risks a byte diff that silently converts a 0.1x read into a 2x write.
          async (wire, headers) => this.createMessage(
            wire as unknown as Anthropic.MessageCreateParamsNonStreaming, headers,
          ),
          config.cacheKeepalive ?? {},
        );
  }

  /** One SDK operation owns its failure state: concurrent calls cannot
   * overwrite each other's auth error or cancel each other's requests.
   * observeBody (stream only) is told about each nonempty chunk of a
   * successful response body before SDK parsing, so transport liveness stays
   * visible even for SSE keepalives the SDK filters out. */
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

    const headers = this.betaHeaders(request, anthropicRequest);
    const live = this.liveHeaders(headers, 'complete');

    try {
      // Membrane is the one retry layer (see Membrane's retryPlan): the SDK
      // client makes one attempt at this request, a credential resolver's
      // resend after a 401 inside it. The keepalive's replays, which also go
      // through createMessage, keep the SDK's default.
      // The cache's clock starts with this request, so the keepalive's touch
      // is stamped here, not when the answer arrives. Each of Membrane's
      // attempts is its own call here, so a retry's backoff isn't counted.
      const sentAt = Date.now();
      const response = await this.createMessage(fullRequest, live, options?.signal, { maxRetries: 0 });
      // The SDK has the provider's answer, so the provider has processed the
      // request's prefix: only now can the keepalive take it up (whether it was
      // cached, a refresh's self-check finds out). It's recorded before
      // membrane parses the answer, which can fail on an answer that arrived.
      // A call that failed before the SDK had an answer, a body cut off in
      // transit included, leaves the lineage's earlier snapshot as it was.
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
    // Note: stream is implicitly true when using .stream()
    const fullRequest = { ...anthropicRequest, stream: true };
    assertMessagePrefillSupported(fullRequest.model, fullRequest.messages, options, this.name, fullRequest);
    options?.onRequest?.(fullRequest);

    const headers = this.betaHeaders(request, anthropicRequest);
    const live = this.liveHeaders(headers, 'stream');

    // Idle timeout: abort on transport silence after the first SDK event.
    // The SDK's timeout only covers the initial HTTP response headers;
    // once streaming starts, a silently dropped connection waits forever.
    // Default raised 120s → 600s (2026-07-20): on Opus 4.7+/Fable-class models
    // thinking streams with display:"omitted" by default — a long think emits
    // NO deltas, and the SDK swallows SSE ping keepalives, so a healthy
    // request can legitimately be silent for minutes mid-stream. At 120s the
    // watchdog repeatedly killed real, billing, actively-thinking turns
    // (Cairn, 2026-07-20: every >120s think died for an hour straight). 600s
    // matches the SDK's own request timeout. Body keepalives now count as
    // activity after the first SDK event; this is no total or progress bound.
    const idleMs = options?.idleTimeoutMs ?? 600_000;
    // TTFT can legitimately exceed the inter-event idle: on a large context
    // with a cache miss, the API sends only SSE `ping` keepalives until
    // message_start — and the SDK swallows pings before they reach this loop
    // (core/streaming: `if (sse.event === 'ping') continue`). Transport body
    // bytes, pings included, re-arm the idle timer only after the first event.
    // The first event retains a fixed longer deadline; killing at idleMs turned
    // every long-TTFT request into a spurious "idle timeout" (Cairn, 600k
    // context, 2026-07-20: repeated deaths at exactly 120s). Give the first
    // event a much longer deadline; keep the tight idle for gaps after that.
    const firstEventMs = options?.firstEventTimeoutMs ?? Math.max(idleMs, 600_000);
    const idleAbort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimedOut = false;
    let sawEvent = false;

    // Link caller's signal so external cancellation still works
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
    // prove transport liveness after the first SDK event. They re-arm the idle
    // timer without extending the fixed first-event deadline; `settled` keeps
    // late chunks from re-arming after cleanup.
    let settled = false;
    const onTransportActivity = () => {
      if (sawEvent && !settled && !idleAbort.signal.aborted) resetIdleTimer();
    };

    resetIdleTimer();
    let session: ReturnType<AnthropicAdapter['credentialSession']> | undefined;

    try {
      session = this.credentialSession(idleAbort.signal, onTransportActivity);
      // The cache's clock starts with this request: the keepalive's touch is
      // stamped here, not at message_start (see complete()).
      const sentAt = Date.now();
      const stream = await session.client.messages.stream(anthropicRequest, {
        signal: session.signal,
        headers: live,
        // Membrane is the one retry layer: the SDK client makes one attempt
        // at this request, a credential resolver's resend after a 401 inside
        // it.
        maxRetries: 0,
      });

      // Accumulate response metadata from SSE events directly, so we can
      // skip finalMessage() and its variable-latency connection teardown.
      let model = '';
      let inputTokens = 0;
      let outputTokens = 0;
      // Whether the stream reported each count (an unreported one stays a 0 default).
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
      // Diagnostics kept on raw (see "Response diagnostics" above).
      let messageId: string | undefined;
      let messageStartEvent: unknown;
      let messageDeltaEvent: unknown;
      const unhandledEvents: unknown[] = [];
      let unhandledOmitted = 0;
      const noteUnhandled = (event: unknown): void => {
        if (unhandledEvents.length < UNHANDLED_EVENTS_MAX) unhandledEvents.push(boundedProviderEvent(event));
        else unhandledOmitted++;
      };

      // Content block tracking — finalized on content_block_stop
      const contentBlocks: Record<string, unknown>[] = [];
      let currentBlockIndex = -1;
      let currentBlockContent = '';
      let currentBlockInputJson = '';
      // When wrapThinkingTags is set (XML formatter path), native thinking
      // deltas are wrapped in <thinking>...</thinking> on the chunk stream so
      // the tag-based parser tracks them as thinking instead of visible text.
      // Tag opened lazily on the first delta — display:'omitted' models emit
      // thinking blocks with no thinking_delta at all (signature only).
      const wrapThinkingTags = options?.wrapThinkingTags === true;
      let thinkingTagOpen = false;
      // Index of a block that has started and not yet been stopped. A stream
      // can end with one still open: measured live against claude-haiku-4-5
      // (2026-08-25), a tool call truncated by max_tokens emits
      // content_block_start + input_json_delta fragments and then goes
      // straight to message_delta — no content_block_stop at all.
      let openBlockIndex = -1;
      // Block events come in the API's order: a start while no block is open,
      // at the next index, then that block's deltas (a tool call's carry only
      // its arguments: isToolCallBlock, isToolCallArgumentsDelta) and its stop. A
      // stream that ends with a block open, as a max_tokens cut does, is in
      // order. Once an event isn't, the stream can't vouch for which call any
      // arguments belong to: see breakBlockOrder.
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
              // Arguments never finished arriving, so `input` is still the
              // empty object content_block_start carried — a plausible no-arg
              // call that nothing downstream can distinguish from a real one.
              block.unparseableInput = currentBlockInputJson;
            } else if (currentBlockInputJson) {
              // Arguments that don't parse, or parse to anything but an
              // object, are the same fabrication reached by a block that did
              // stop: keep the raw accumulation and mark it so consumers can
              // refuse.
              const parsed = toolUseInputFromText(currentBlockInputJson);
              if (parsed.unparseableInput === undefined) block.input = parsed.input;
              else block.unparseableInput = parsed.unparseableInput;
            }
          } else if (isAnthropicServerBlock(block) && 'input' in block) {
            // A server tool's call (server_tool_use, mcp_tool_use) streams its
            // input as input_json_delta fragments, as a tool_use does, and its
            // content_block_start carried `input: {}`. The block is sent back
            // verbatim in later turns, so it must hold the input the model
            // wrote: only a block that stopped has all of it. One that didn't
            // stop, or whose fragments don't parse to an object (the API
            // refuses any other input), keeps the start's input and the raw
            // accumulation in `unparseableInput`, as a tool_use does, so a
            // consumer can tell the call it holds isn't the one the model
            // made. A cut-off call has no result after it, so it goes
            // back only where a lone call can (the request's final message),
            // as stored, without the marker; anywhere else it's left out as
            // a lone call (unpairedServerBlocks).
            let whole = sawBlockStop;
            // Whitespace alone is no input, {} unmarked, as a tool_use's is.
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

      // A block event out of order, and every block event after it, isn't
      // applied but kept in unhandled, with one warning at the first. A block
      // still open then gets no more and is finalized as cut off at the
      // stream's end, and every tool_use block in the response is marked
      // there.
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
        // The provider has processed the request's prefix from its
        // message_start on, so the keepalive can take it up across idle gaps
        // (whether it was cached, a refresh's self-check finds out; `stream:
        // true` is dropped at replay time: transport, not cache key). A call that
        // failed before this leaves the lineage's earlier snapshot as it was.
        // It's recorded before the caller's onProgress runs, so a callback
        // that throws can't lose a prefix the provider has.
        if (event.type === 'message_start') {
          this.cacheKeepalive?.record(fullRequest as unknown as Record<string, unknown>, headers, 'stream', sentAt);
        }
        // Every SDK event is progress; pings never reach this loop.
        options?.onProgress?.();
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
          // In order only while no block is open, at the next index: that one
          // condition also refuses an index skipped, negative or not a number.
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
          // In order only for the open block, so only while one is open (with
          // none, openBlockIndex is -1, which an event's index can be too),
          // and for a tool call only as its arguments.
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
            // Accumulate the cryptographic signature that authenticates this
            // thinking block. Without this, signatures never land on the
            // streaming path, and the next request, which carries the block
            // back in history, leaves it out as unsigned (isUnsignedThinking).
            const sig = (event.delta as { signature?: string }).signature;
            const block = contentBlocks[currentBlockIndex];
            if (block && block.type === 'thinking' && sig) {
              block.signature = ((block.signature as string | undefined) ?? '') + sig;
              // Reported as it accumulates, so a stream that ends before
              // content_block_stop still keeps the signature it received.
              callbacks.onThinkingSignature?.(currentBlockIndex, block.signature as string);
            }
          } else if ((event.delta as { type: string }).type === 'input_json_delta') {
            currentBlockInputJson += (event.delta as { partial_json: string }).partial_json;
          } else {
            // A delta type this loop doesn't read (citations_delta, or one
            // the API added): kept for diagnosis instead of dropped unseen.
            noteUnhandled(event);
          }

        } else if (event.type === 'content_block_stop') {
          // In order only for the open block, so only while one is open.
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
          // A block still open here is finalized after the loop, as cut off.
          // Capture final metadata and exit — message_stop and the SSE connection
          // teardown after it add only variable latency with no useful data.
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

      // Clean up idle timer and external signal listener
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      // A block still open here never received its content_block_stop: the
      // turn ended mid-block. Finalize it so the accumulated text is not lost
      // and a truncated tool call is marked rather than persisted as `{}`.
      if (openBlockIndex >= 0) {
        finalizeContentBlock(openBlockIndex, false);
        openBlockIndex = -1;
      }
      // After a break in block order no call in the response counts as
      // complete, those finished before the break included: each tool_use
      // block not already marked keeps its arguments, as JSON, in the marker,
      // and an empty input. One already marked keeps its marker and the input
      // its start carried, as any marked call does.
      if (blockOrderBroken) {
        for (const block of contentBlocks) {
          if (block?.type === 'tool_use' && block.unparseableInput === undefined) {
            block.unparseableInput = JSON.stringify(block.input ?? {});
            block.input = {};
          }
        }
      }

      // Force-close the HTTP connection so we don't block on SSE drain
      try { stream.controller.abort(); } catch { /* already closed */ }

      // message_delta is this adapter's terminal event — the loop breaks on
      // it. Falling out of the for-await without one means the SSE connection
      // closed mid-turn, and stopReason is still its 'end_turn' initialiser.
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
      // Clean up timer on error path too
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      // Our own idle watchdog fired: whatever shape the SDK wrapped the
      // abort into (AbortError, APIUserAbortError "Request was aborted.",
      // a connection error), the CAUSE is the stalled stream — classify as
      // the retryable timeout, never as a user abort / unknown error. It is
      // this call's deadline, so membrane doesn't send the call again.
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

  /** Base headers + the live dynamicHeaders stamp. Request time only: the
   *  keepalive recorder receives the base headers without this stamp, so
   *  replayed touches never carry a stale telemetry value. */
  private liveHeaders(base: Record<string, string> | undefined, lane: DynamicHeadersContext['lane']): Record<string, string> | undefined {
    const dyn = runCallerCode(() => this.dynamicHeaders?.({ lane }));
    if (!dyn) return base;
    const out: Record<string, string> = { ...(base ?? {}) };
    for (const [k, v] of Object.entries(dyn)) {
      if (v !== null && v !== undefined && v !== '') out[k] = String(v);
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** Per-request headers for both create() and stream(): the interleaved-
   *  thinking beta when thinking is enabled on a pre-4.6 Claude 4 model, the
   *  thinking-binding beta when the built request asks for binding controls,
   *  and the display-updates beta when it asks for `display: 'updates'`.
   *  Any default anthropic-beta (oauth) is re-carried in the same
   *  header — the SDK replaces same-key defaults instead of merging, and the
   *  API accepts comma-separated betas. Undefined when nothing to add, so
   *  the defaults apply untouched. */
  private betaHeaders(request: ProviderRequest, built: { thinking?: unknown; messages?: unknown }): Record<string, string> | undefined {
    const needed: string[] = [];
    if (thinkingEnabled(request) && needsInterleavedThinkingBeta(request.model)) needed.push(INTERLEAVED_THINKING_BETA);
    if (sendsBlockBinding(built)) needed.push(THINKING_BINDING_BETA);
    if (sendsDisplayUpdates(built)) needed.push(THINKING_DISPLAY_UPDATES_BETA);
    if (sendsToolChanges(built)) needed.push(INLINE_TOOLS_BETA);
    if (needed.length === 0) return undefined;
    // Set-join so a default that already carries a beta doesn't emit it
    // twice (the API tolerates duplicates; this is hygiene).
    const betas = new Set(
      (this.defaultBeta ?? '').split(',').map((b) => b.trim()).filter(Boolean),
    );
    for (const beta of needed) betas.add(beta);
    return { 'anthropic-beta': [...betas].join(',') };
  }

  private buildRequest(request: ProviderRequest, onContentAltered?: (block?: unknown) => void): Anthropic.MessageCreateParams {
    // Strip provider-specific fields (e.g., sourceUrl for Gemini) from image blocks
    // before sending to Anthropic, which rejects extra inputs.
    // Also normalize nested tool_result content blocks: Membrane uses camelCase
    // `mediaType`, Anthropic expects snake_case `media_type`. Without this,
    // an image returned by a tool reaches the API as `{source: {mediaType: ...}}`
    // and is silently rejected (the model sees the text label only).
    const sanitizedMessages = (request.messages as any[]).map((msg: any) => {
      if (!Array.isArray(msg.content)) return msg;
      // Media in MCP's form becomes membrane's first, for a caller that
      // builds a request directly (Membrane's own builds have converted it
      // already, utils/mcp-media.ts). A report about a block names the one
      // the caller handed in.
      const converted = convertMcpMedia(msg.content as unknown[]);
      return {
        ...msg,
        content: msg.content.map((original: any, index: number) => {
          const block = converted[index] as any;
          if (isSourcelessMedia(block)) {
            // Media with no source object (MCP's form that didn't convert)
            // has no form the API takes: left out, as in a tool_result, and
            // reported.
            onContentAltered?.(original);
            return undefined;
          }
          if (isUnsignedThinking(block)) {
            // Another provider's reasoning, such as Gemini's thought parts or
            // an OpenAI-compatible reasoning channel, has no signature, and
            // the API refuses a thinking block without a valid one (#191):
            // left out, and reported.
            onContentAltered?.(original);
            return undefined;
          }
          if (block.type === 'image') {
            const { sourceUrl, ...rest } = block;
            if (block.source?.type === 'url') {
              // A data: URL holds its image inline, so it goes as base64 data
              // labelled by its header, or as the placeholder. Any other URL is
              // the API's to fetch.
              const image = urlImageForRequest(block.source.url);
              if (image.placeholder) {
                onContentAltered?.(original);
                return rest.cache_control ? { ...image.placeholder, cache_control: rest.cache_control } : image.placeholder;
              }
              if (image.data) return { ...rest, source: { type: 'base64', media_type: image.mediaType, data: image.data } };
              return rest;
            }
            if (block.source?.type !== 'base64') return rest;
            // Overwrite media_type in place: a wire-shaped source keeps its key
            // order, so an already-correct image serializes to the same bytes
            // as before; only camelCase input gains a trailing media_type.
            const { mediaType, ...source } = block.source;
            const image = imageForRequest(source.data, source.media_type ?? mediaType);
            if (image.placeholder) {
              // Data that is no accepted image goes as the placeholder text,
              // keeping any cache breakpoint the image carried.
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
            // Nested blocks other than text and base64/URL images have no
            // Anthropic tool_result form and are left out, whitespace-only
            // nested text is cleaned away, and an image whose data the API
            // doesn't accept goes as the placeholder. Only an exactly empty ''
            // text block carried nothing.
            const carried = (block.content as Array<{ type?: string; text?: unknown }>)
              .filter((b) => !(b?.type === 'text' && (typeof b.text !== 'string' || b.text === ''))).length;
            if (content.length !== carried || substituted) onContentAltered?.(original);
            return { ...block, content };
          }
          if (block.type === 'tool_addition' && block.tool?.type === 'tool_definition' && block.tool.definition) {
            // A definition by value meets the same rule as `tools`: its root
            // union is flattened, as below. That changes what the model is
            // told about the tool, so its message is reported altered.
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

    // Byte-wall INVARIANT at the last exit before the SDK (2026-07-12): the
    // policy decision (shed with explicit opt-in, or fail loudly) happens
    // upstream at the request-build sites. Reaching this point oversize means
    // a compile path bypassed the policy — throw with the breakdown rather
    // than silently mutate or eat a 413 round-trip.
    assertWithinByteBudget(sanitizedMessages, undefined, 'anthropic-provider');

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: sanitizedMessages as Anthropic.MessageParam[],
    };
    
    // Handle system prompt - can be string or content blocks with cache_control
    if (request.system) {
      if (typeof request.system === 'string') {
        params.system = request.system;
      } else if (Array.isArray(request.system)) {
        // System is an array of content blocks (with potential cache_control)
        params.system = request.system as Anthropic.TextBlockParam[];
      }
    }
    
    // Sampling-parameter gates:
    //   - Some models reject temperature/top_p/top_k outright with a 400
    //     (see NO_TEMPERATURE_MODELS) — strip rather than let the whole
    //     inference die on a non-retryable invalid_request_error.
    //   - Extended thinking rejects custom temperature/top_k on every model
    //     (only the defaults are accepted while thinking is on) — strip those
    //     too when a thinking config is present and not disabled.
    const stripSampling = noTemperatureSupport(request.model);
    // Thinking can arrive top-level OR smuggled through `extra` — the same
    // `Object.assign(params, rest)` below installs `extra.thinking` into the
    // request AFTER this gate ran. Resolve from both sources so an enabled
    // thinking config strips sampling params no matter where it came from;
    // otherwise `extra: { thinking, temperature }` reproduces the exact 400
    // this gate exists to prevent (same bug class as the extra-sampling bypass,
    // one field over).
    const thinkingOn = thinkingEnabled(request);

    if (request.temperature !== undefined && !stripSampling && !thinkingOn) {
      params.temperature = request.temperature;
    }

    // Anthropic API rejects requests with both temperature and top_p set.
    // When both are provided, prefer temperature (more commonly tuned) and drop top_p.
    // With thinking on, top_p is only accepted in [0.95, 1] — strip values below.
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
      // MCP allows a root-level oneOf/anyOf/allOf in a tool's input schema,
      // but the Anthropic API rejects it ("input_schema does not support
      // oneOf, allOf, or anyOf at the top level") — one bad tool 400s the
      // entire inference. Flatten such roots into a single object schema
      // before shipping (see anthropic-tool-schema.ts).
      params.tools = (request.tools as Anthropic.Tool[]).map(tool => {
        const inputSchema = (tool as { input_schema?: unknown }).input_schema;
        const flattened = flattenRootSchemaUnion(inputSchema);
        return flattened === inputSchema
          ? tool
          : ({ ...tool, input_schema: flattened } as Anthropic.Tool);
      });
    }

    // Handle extended thinking
    if (request.thinking) {
      (params as any).thinking = request.thinking;
    }

    // Apply extra params, excluding internal membrane fields
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      // Sampling params passed through `extra` must obey the same gates as the
      // top-level ones. Otherwise a caller passing e.g. `extra: { temperature }`
      // for a reject-list model (or under extended thinking) would re-insert the
      // stripped value here — via Object.assign, after the gate above — and
      // reproduce the exact non-retryable 400 this stripping is meant to prevent.
      if (stripSampling || thinkingOn) {
        delete rest.temperature;
        delete rest.top_k;
        // top_p is accepted in [0.95, 1] while thinking is on, but never when
        // the model rejects sampling params outright.
        const extraTopP = rest.top_p;
        if (stripSampling || typeof extraTopP !== 'number' || extraTopP < 0.95) {
          delete rest.top_p;
        }
      }
      // A passthrough `messages` replaces the built messages wholesale.
      if (rest.messages !== undefined) onContentAltered?.();
      Object.assign(params, rest);
    }

    stripEmptyTextRequest(params, onContentAltered);
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
    // The API can say whether a failure is worth sending again, and the SDK
    // obeyed that before its own rules. Membrane is the one retry layer for a
    // call's requests now (the SDK client makes one attempt at each; only the
    // keepalive's replays keep its retries), so the advice decides
    // `retryable` here.
    const advice = error instanceof Anthropic.APIError ? error.headers?.get?.('x-should-retry') : undefined;
    if ((advice === 'true' || advice === 'false') && typed.retryable !== (advice === 'true')) {
      const advised = new MembraneError({ ...typed.toErrorInfo(), retryable: advice === 'true' });
      // A spent deadline stays one: the mark isn't part of the error's info.
      return isDeadlineExpiry(typed) ? deadlineExpired(advised) : advised;
    }
    return typed;
  }

  private typeError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);

    // A cancellation is a type, never a phrase — not even the SDK's own exact
    // phrase, which any caller can produce. The instanceof arm is what
    // actually catches the SDK abort: APIUserAbortError inherits `name ===
    // 'Error'` (measured against @anthropic-ai/sdk 0.52), so isTypedAbortError
    // does NOT match it; isTypedAbortError covers the other typed shapes —
    // DOMException AbortError, name === 'AbortError', and a membrane abort.
    // The idle watchdog that motivated the old message arm never reaches here:
    // the stream catch throws its typed timeout before calling handleError.
    if (error instanceof Anthropic.APIUserAbortError || isTypedAbortError(error)) {
      return abortError(undefined, rawRequest);
    }

    // The SDK's transport failures carry no status ("Connection error.",
    // `cause: TypeError: fetch failed`), so the status path below can't type
    // them. They are the SDK's own types: the timeout subclass first.
    //
    // A timeout is a deadline membrane leaves to the caller. The SDK reports
    // its own request timeout, undici's headers timeout and a connect timeout
    // as this same error, with no cause (SDK 0.52 makeRequest), so a connect
    // timeout, which membrane would otherwise send again, can't be told
    // apart here and goes to the caller too.
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
      // with status === undefined (sdk core/streaming.js) — overloaded_error
      // (529) most commonly arrives exactly this way. The shared table
      // recovers the effective status from the body's error type, so those
      // no longer fall through to `unknown, retryable: false`.
      const classified = errorFromProviderStatus({
        provider: this.name,
        status: error.status,
        body: error.error,
        message,
        retryAfterMs: this.parseRetryAfter(error),
        rawError: error,
        rawRequest,
      });

      // Vercel AI Gateway wraps transient upstream outages (a fallback
      // provider 503, routing churn on a sunsetting model) in non-5xx
      // aggregate errors whose body carries gateway routing metadata. The
      // SAME request frequently succeeds on retry once a live provider is
      // picked, so such an aggregate stays a retryable server error whatever
      // other status it reports. This exception belongs to this adapter alone
      // and keeps main's precedence: the statuses main typed before this rule
      // (400, 401 and 429, terminal quota included), sent or implied by the
      // provider code, still classify normally, and a 5xx is retryable either
      // way. Any other status (a 402, 403 or 404 from one route) stays
      // retryable, since another route may serve the request, and an
      // aggregate whose message says overloaded takes 529, the overloaded
      // schedule, as main's overloaded safety net gave it. The exception
      // keeps the provider code, retry hint and raw evidence.
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
      // A model without mid-conversation system messages or tool changes
      // refuses the request for its system change: said on the error, so the
      // caller can apply the change to `tools` and `system` instead.
      if (classified.httpStatus === 400 && isSystemChangeRefusal(error.error)) markSystemChangeRefused(classified);
      if (classified.type !== 'unknown') return classified;

      // Safety net: if the SSE error body wasn't parseable JSON, neither
      // status nor body type resolves — match the message itself rather
      // than let a transient capacity error become non-retryable.
      if (gw.includes('overloaded')) {
        return serverError(message, 529, error, rawRequest);
      }
    }

    return errorFromThrown(error, rawRequest);
  }

  /**
   * `retry-after` off the response headers: the authoritative source, and the
   * one nobody was reading. An error that carries no headers (a mid-stream SSE
   * rethrow) states no wait here; errorFromProviderStatus then reads its
   * message through the guarded prose reader.
   */
  private parseRetryAfter(error: { headers?: Headers }): number | undefined {
    // The SDK, which used to do the waiting, read `retry-after-ms` first.
    const ms = Number(error.headers?.get?.('retry-after-ms')?.trim() || NaN);
    if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
    const header = error.headers?.get?.('retry-after');
    if (header) {
      const seconds = Number(header.trim());
      if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
      const at = Date.parse(header.trim());
      if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    }
    // No prose fallback here: a wait read from a message belongs to the
    // shared, guarded reader (errorFromProviderStatus), which believes one only
    // as stated seconds on a retryable error. A loose /retry after (\d+)/ over
    // any status made 'do not retry after 3 attempts' a three-second hold.
    return undefined;
  }
}

// ============================================================================
// Content Conversion Utilities
// ============================================================================

/**
 * Convert Membrane tool-result content blocks to Anthropic's tool_result.content
 * mixed array (text + image). This is what carries an image returned by a tool
 * (e.g. an MCP fetch_attachment result) all the way to the model. Other block
 * types are not valid inside tool_result.content per the Anthropic API and are
 * dropped. `onPlaceholder` hears each image that goes as the placeholder.
 */
function toAnthropicToolResultContent(
  blocks: ContentBlock[],
  onPlaceholder?: () => void,
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  const out: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const block of stripEmptyTextBlocks(blocks)) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      // An image with no source object, someone else's shape that isn't
      // MCP's form, has nothing to send and is left out.
      const image = block.source?.type === 'base64'
        ? anthropicImage(block.source.data, block.source.mediaType ?? (block.source as { media_type?: string }).media_type)
        : block.source?.type === 'url' ? anthropicUrlImage(block.source.url) : undefined;
      if (image?.type === 'text') onPlaceholder?.();
      if (image) out.push(image);
    }
  }
  return out;
}

/**
 * Convert normalized content blocks to Anthropic format
 * Preserves cache_control for prompt caching
 */

/** Base64 image data as an Anthropic block: an image labelled by its bytes,
 *  since storage and ingest can lose or mislabel the type (a PNG tagged
 *  image/jpeg is a 400), or imageForRequest's placeholder text when the data
 *  is no image the API accepts. */
function anthropicImage(data: string, declared: unknown): Anthropic.ImageBlockParam | Anthropic.TextBlockParam {
  const image = imageForRequest(data, declared);
  if (image.placeholder) return image.placeholder;
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data } };
}

/** An image URL as an Anthropic block: a data: URL's image as base64 data
 *  labelled by its header, or the placeholder for data the API doesn't
 *  accept; any other URL as a url source, for the API to fetch. */
function anthropicUrlImage(url: string): Anthropic.ImageBlockParam | Anthropic.TextBlockParam {
  const image = urlImageForRequest(url);
  if (image.placeholder) return image.placeholder;
  return image.data
    ? { type: 'image', source: { type: 'base64', media_type: image.mediaType!, data: image.data } }
    : { type: 'image', source: { type: 'url', url: image.url } };
}

/**
 * Convert one turn's normalized content to Anthropic content blocks, for a
 * caller outside membrane's own builds, which go through NativeFormatter.
 *
 * With `role: 'assistant'`, an Anthropic server-tool block, or its zero-width
 * carrier, goes out as the block itself, in the place it had in the turn that
 * produced it, as NativeFormatter sends it when its build replays server
 * blocks (see utils/anthropic-server-blocks.ts), except a server call with no
 * result after it in the turn, or a result with no call before it, which the
 * API refuses (unpairedServerBlocks). With `lastMessage`, the turn is the
 * request's final message, a paused turn being resumed, and keeps its lone
 * calls, as NativeFormatter keeps them there; without it, every lone one is
 * left out. In any other role a server block is left out, as NativeFormatter
 * leaves it out of a user turn, which has no place for one. A caller that
 * names no role gets that too, as it always got for a carrier. Media in
 * MCP's form is converted to membrane's first (utils/mcp-media.ts), at the
 * top of the turn and inside a `tool_result`. A document that doesn't
 * convert, with no source after that, is left out, and so is an image with no
 * source object that isn't MCP's form, with neither `data` nor `mimeType`.
 * A thinking block with no signature is left out too (isUnsignedThinking).
 * Nothing reports what it leaves out: it has no alteration callback. It sees
 * one turn, so a turn whose only blocks it or pairing leaves out comes back
 * empty, for the caller to drop as the adapters' cleanup drops it, and to
 * refuse when it's the final turn, as that cleanup does.
 */
export function toAnthropicContent(
  blocks: ContentBlock[],
  options: { role?: 'user' | 'assistant'; lastMessage?: boolean } = {},
): Anthropic.ContentBlockParam[] {
  const result: Anthropic.ContentBlockParam[] = [];

  // An Anthropic server-tool block (web search and the like), kept on a
  // zero-width carrier, is that block on this wire: it is part of the turn
  // the model produced (see utils/anthropic-server-blocks.ts). In an
  // assistant turn, swap it in before the empty-text cleanup, which would
  // drop the carrier as empty text; in any other, leave it out.
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
        // Preserve cache_control if present
        if (block.cache_control) {
          textBlock.cache_control = block.cache_control;
        }
        result.push(textBlock);
        break;
      }
        
      case 'image':
        // An image with no source object, someone else's shape that isn't
        // MCP's form, has nothing to send and is left out.
        if (block.source?.type === 'base64') {
          result.push(anthropicImage(block.source.data, block.source.mediaType ?? (block.source as { media_type?: string }).media_type));
        } else if (block.source?.type === 'url') {
          result.push(anthropicUrlImage(block.source.url));
        }
        break;
        
      case 'document':
        // One with no source object, MCP's form that didn't convert or
        // someone else's shape, has nothing for a document block to carry.
        // Audio or video meets the error below in either form.
        if (isSourcelessMedia(block)) break;
        result.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.source.mediaType as 'application/pdf',
            data: block.source.data,
          },
          // Anthropic's document block carries the filename as `title`; it was
          // being dropped, so the model lost the one hint about what the PDF is.
          ...(block.filename ? { title: block.filename } : {}),
        });
        break;

      case 'generated_image':
        // A provider-generated image is a base64 image with a MIME type, which
        // is exactly Anthropic's image block — carrying it across costs nothing
        // and lets an image Gemini produced re-enter Anthropic history.
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
        // A thinking block with no signature, another provider's reasoning,
        // has no form the API takes (#191): left out.
        if (isUnsignedThinking(block)) break;
        // Signed, so the signature always goes.
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
        // The REQUEST path cannot degrade gracefully: a dropped block reaches
        // the model as an absence, and it answers about content it was never
        // shown. `audio` and `video` have no Anthropic Messages representation
        // at all, and a block type added later would silently join them. Fail
        // loudly at the boundary instead — the caller can strip or transcode.
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

/** Unrecognised response block types warn once each, not once per conversion. */
const warnedUnconvertibleResponseBlocks = new Set<string>();

/**
 * The RESPONSE path can degrade gracefully where the request path cannot: the
 * provider's own block is in hand, so keeping it verbatim on a zero-width
 * carrier loses nothing recoverable and lets formatters replay it. Warn once
 * per type so a new provider block type surfaces without flooding the log.
 */
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

/** Test seam: the once-per-type warn latch is process-wide otherwise. */
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
          // A server-tool block is its own native form: carried as itself,
          // with no unknown-type warning, as membrane's response path does.
          result.push({ type: 'text', text: '', rawItem: block } as ContentBlock);
        } else {
          // search_result and anything Anthropic adds later used to fall out
          // here silently.
          result.push(preserveUnconvertibleBlock(block, 'anthropic'));
        }
        break;
    }
  }
  
  return result;
}
