// Prompt-cache keepalive for the Anthropic direct API.
//
// Anthropic's prompt cache entries expire on a TTL, but reading an entry
// restarts its clock: the docs say the cache "is refreshed for no additional
// cost each time the cached content is used", and the lifetime runs from the
// start of the request that writes or reads the entry. A read is billed at
// 0.1x input, a one-hour write at 2x.
//
// A normal `max_tokens: 0` replay is intended to run prefill only, typically
// returning content `[]` and stop_reason `max_tokens` without output tokens.
// Refused, unknown or ineffective outcomes are not proof of a cache refresh;
// opt-in suppression checks the raw terminal reason as well as cache usage.
// `max_tokens` isn't part of the cache key. Caching is a prefix match, and an
// innocent-looking change to a replay turns the read into a write of the
// whole prefix, reported as a successful call and visible only in its usage:
// replaying a request sent with `thinking: {type:'adaptive'}` as
// `{type:'disabled'}` does. A prefix under the model's minimum cacheable
// length is processed and not cached.

import { collectMarkedBlocks } from './utils/cache-marker-budget.js';
import { isEffortOnlyMessage } from './utils/empty-text.js';
import { createHash } from 'node:crypto';

/** Vendor usage fields used by keepalive checks and spend observers. */
export interface KeepaliveUsage {
  // `null` when the API left the field out; `null` and 0 both count as no read.
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  service_tier?: string | null;
  inference_geo?: string | null;
}

export type KeepaliveSend = (
  wire: Record<string, unknown>,
  headers: Record<string, string> | undefined,
) => Promise<{ usage?: KeepaliveUsage; stop_reason?: unknown }>;

export type KeepaliveLane = 'stream' | 'complete';

/** With suppression enabled, one terminal receipt per KeepaliveSend invocation,
 * not per HTTP attempt. Legacy malformed null/undefined responses can deliver
 * success then error receipts during response processing.
 * Delivery is best-effort when onCall is configured and values are cloneable.
 * SDK-internal retries belong to that invocation. A success copies own enumerable
 * vendor response fields and their usage, including ineffective cache writes.
 * Resolved responses with throwing metadata accessors can instead report errors.
 * Request and success-response objects are observer-owned copies; an error
 * receipt's error value is not cloned. Recorded request headers are excluded.
 * Clone loss drops the receipt: opt-in reports receipt-clone-failed via onDiagnostic;
 * default-off drops it silently. */
export type KeepaliveCall = {
  key: string;
  /** The real request's lane whose cache lineage this poke refreshes. */
  lane: KeepaliveLane;
  /** Unix epoch milliseconds when this poke attempt began. */
  startedAt: number;
  durationMs: number;
  /** Observer-owned structured clone of the replay after sender settlement, not wire bytes.
   * A custom sender can mutate the prepared replay before this copy is made.
   * Default-off first JSON.stringify/JSON.parse round-trips the recorded request:
   * custom toJSON results are retained, callable fields may disappear, and
   * exact-digit JSON numbers may round before this copy is made.
   * Opt-in instead prepares from the retained caller request without JSON.parse;
   * structuredClone loses JSON.rawJSON branding and custom toJSON behavior.
   * Callable fields and, on some runtimes, rawJSON can then prevent delivery.
   * Clone loss is silent default-off; opt-in reports receipt-clone-failed via onDiagnostic.
   * In both modes the prepared replay has max_tokens: 0, omits stream, and trims
   * messages through the user turn at or after its last one-hour marker,
   * or retains all messages when no user message follows that marker. */
  request: Record<string, unknown>;
} & (
  | { outcome: 'success'; response: Record<string, unknown> & { usage?: KeepaliveUsage } }
  | { outcome: 'error'; error: unknown }
);

/** Opt-in operational notice, not a failed send and never delivered to onEvent. */
export type KeepaliveDiagnostic = { type: 'diagnostic'; key: string; reason: string };

export type KeepaliveSuppression = { type: 'suppressed'; key: string; source: 'foreground' | 'refresh' };

export type KeepaliveEvent =
  | { type: 'refreshed'; key: string; lane: KeepaliveLane; readTokens: number; idleMs: number }
  | { type: 'ineffective'; key: string; reason: string; readTokens: number; writeTokens: number }
  | { type: 'skipped'; key: string; reason: string }
  | { type: 'error'; key: string; error: string; consecutive: number }
  | { type: 'disabled'; reason: string }
  | { type: 'expired'; key: string; idleMs: number };

export interface CacheKeepaliveConfig {
  /** Opt-in semantic refusal suppression. Default false (legacy behavior).
   * Initial eligibility requires a known normal foreground completion; only one
   * begun after refusal can rearm. */
  suppressOnRefusal?: boolean;
  /** Separate opt-in suppression notifications; never delivered to onEvent.
   * Used only with suppressOnRefusal. Observer failures are isolated. */
  onSuppressed?: (event: KeepaliveSuppression) => void | Promise<void>;
  /** Non-failure operational notices, only with suppressOnRefusal.
   * Separate from onEvent so error events retain their failure-count semantics.
   * Throws and rejected promises are isolated. No request/response payloads. */
  onDiagnostic?: (event: KeepaliveDiagnostic) => void | Promise<void>;
  /** Master switch. Default true. */
  enabled?: boolean;
  /**
   * Stop refreshing once the last real request is this old. Keepalive pokes do
   * not extend it. Default 24h.
   */
  maxIdleMs?: number;
  /**
   * Refresh once the entry hasn't been touched for this long. Must be < the
   * cache TTL, with margin: the TTL clock starts at the start of the request,
   * and a long streaming turn can itself take minutes. Default 45m.
   */
  refreshAfterMs?: number;
  /** Timer cadence. Default 5m. */
  checkIntervalMs?: number;
  /** Which lanes to keep warm. Default ['stream'], the primary lane. */
  lanes?: KeepaliveLane[];
  /** LRU cap on tracked lineages, to bound memory: each holds a full wire
   *  request. Default 4. Only with suppressOnRefusal, nonfinite caps use the
   *  default. Default-off cap handling matches main (NaN/Infinity are unbounded).
   *  Finite nonpositive caps retain nothing in either mode; default-off
   *  negative Infinity also retains nothing. */
  maxLineages?: number;
  /** Adapter-global consecutive send/response-processing failures before disabling. Default 3.
   * A successfully processed refresh of any key resets the run; not a per-key budget.
   * Suppression mode counts usage access/coercion failures, but not replay preparation.
   * Default-off matches legacy: preparation/send failures accumulate, but a resolved
   * send resets the counter after receipt copying and before usage processing, so
   * usage errors restart at 1; throwing enumerable response getters precede that reset. */
  maxConsecutiveErrors?: number;
  /**
   * The number of pokes of a lineage in a row coming back without a cache read
   * (no read, or a write) at which the lineage is dropped. Default 2.
   */
  maxIneffective?: number;
  /** Each keepalive event as it happens. Throws and rejected promises are ignored. */
  onEvent?: (event: KeepaliveEvent) => void;
  /** Report background calls to the same ledger as foreground inference.
   * In suppression mode, one delivery attempt on success (including ineffective
   * responses) or failure; legacy malformed empty responses may emit success then error.
   * Delivery requires a cloneable prepared request and success response;
   * error receipt error values are passed through, not cloned.
   * Clone failures drop the receipt silently in default-off mode.
   * Opt-in mode reports receipt-clone-failed via onDiagnostic, without
   * changing send-failure accounting or retiring the snapshot.
   * Observer errors are isolated, and returned promises never delay the loop.
   * skipped only reports removal of an ineligible snapshot, before any send.
   * Opt-in operational notices go to onDiagnostic, never onEvent.
   * Eviction, receipt loss and unknown terminals do not increment consecutive
   * failures; an unknown refresh terminal retires the snapshot after a send.
   * Expired/disabled entries normally initiate no new calls; default-off replay
   * serialization can reenter stop and still send afterward (legacy behavior).
   * An in-flight sender still delivers its receipt after removal or stop.
   * Default-off poke serialization failures reach onEvent before any send.
   * Still-current opt-in preparation failures retire the snapshot and report
   * replay-preparation-failed ONLY via onDiagnostic, without counting a failure.
   * Configure onDiagnostic to observe these retirements; onEvent alone misses them.
   * Preparation made obsolete by reentrant stop/replacement is silently abandoned. */
  onCall?: (call: KeepaliveCall) => void | Promise<void>;
}

interface Lineage {
  wire: Record<string, unknown>;
  headers: Record<string, string> | undefined;
  lane: KeepaliveLane;
  lastRealAt: number;
  refreshBaselineAt: number;
  ineffective: number;
}

const DEFAULTS = {
  suppressOnRefusal: false,
  enabled: true,
  maxIdleMs: 24 * 60 * 60 * 1000,
  refreshAfterMs: 45 * 60 * 1000,
  checkIntervalMs: 5 * 60 * 1000,
  lanes: ['stream'] as KeepaliveLane[],
  maxLineages: 4,
  maxConsecutiveErrors: 3,
  maxIneffective: 2,
};

/**
 * Why a request isn't kept warm, or `null` when it is. A shape the API
 * refuses with `max_tokens: 0`, or one a replay could only send by editing it
 * in a way that moves the cache-invalidation boundary, is skipped rather than
 * edited; so is a request with no one-hour cache marker.
 */
export function ineligibleReason(wire: Record<string, unknown>): string | null {
  const thinking = wire.thinking as { type?: string } | undefined;
  // `max_tokens: 0` is refused with thinking.type 'enabled', and changing the
  // thinking config invalidates the messages cache.
  if (thinking?.type === 'enabled') return 'legacy-thinking-budget';

  const toolChoice = wire.tool_choice as { type?: string } | undefined;
  // Refused with max_tokens: 0, and a tool_choice change invalidates the
  // messages cache, so 'auto' can't stand in.
  if (toolChoice?.type === 'tool' || toolChoice?.type === 'any') return 'forced-tool-choice';

  const outputConfig = wire.output_config as { format?: unknown } | undefined;
  if (outputConfig?.format) return 'structured-output';

  const markers = scanCacheMarkers(wire);
  if (!markers.any) return 'no-cache-breakpoint';
  if (!markers.oneHour) return 'no-1h-breakpoint';

  return null;
}

function scanCacheMarkers(wire: Record<string, unknown>): { any: boolean; oneHour: boolean } {
  const marked = collectMarkedBlocks({ system: wire.system, tools: wire.tools, messages: wire.messages });
  const any = marked.length > 0;
  const oneHour = marked.some((block) => isOneHourMarker(block.cache_control as { ttl?: unknown }));
  return { any, oneHour };
}

/** A `cache_control` without a `ttl` is the five-minute cache's. */
function isOneHourMarker(cc: { ttl?: unknown }): boolean {
  return (cc.ttl ?? '5m') === '1h';
}

/**
 * The API takes consecutive user messages as one turn, and some models refuse
 * a request that ends with an assistant message, so a refresh's messages end
 * where a user turn ends, when one follows the last one-hour marker.
 */
export function messagesForRefresh(messages: readonly unknown[]): unknown[] {
  const isUser = (message: unknown) => (message as { role?: unknown } | null)?.role === 'user';
  const holdsOneHourMarker = (message: unknown) =>
    collectMarkedBlocks({ messages: [message] }).some((block) => isOneHourMarker(block.cache_control as { ttl?: unknown }));
  let from = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (holdsOneHourMarker(messages[index])) {
      from = index;
      break;
    }
  }
  let end = from;
  while (end < messages.length && !isUser(messages[end])) end++;
  while (end + 1 < messages.length && (isUser(messages[end + 1]) || isEffortOnlyMessage(messages[end + 1]))) end++;
  return messages.slice(0, end + 1);
}

/**
 * Identity of a cache lineage: model, system and tools, the root of the cached
 * prefix. Requests that share all three share a lineage, whatever their lane
 * or messages. Legacy mode uses record order; suppression mode orders snapshots
 * by request begin, ignoring older prefixes after a newer snapshot is installed.
 */
export function lineageKey(wire: Record<string, unknown>): string {
  const h = createHash('sha256');
  h.update(String(wire.model ?? ''));
  h.update('\0');
  h.update(JSON.stringify(wire.system ?? null));
  h.update('\0');
  h.update(JSON.stringify(wire.tools ?? null));
  return h.digest('hex').slice(0, 16);
}

interface OutcomeState { barrier: number; latest: number; qualified: boolean; }
/** Request-begin identity; treat as opaque and return only to its issuing keeper. */
export interface KeepaliveAttempt {
  readonly key: string;
  readonly _keepaliveAttempt: unique symbol;
}

interface AttemptData {
  readonly key: string;
  readonly sequence: number;
  readonly state: OutcomeState;
  readonly wire: Record<string, unknown>;
  readonly headers: Record<string, string> | undefined;
  readonly lane: KeepaliveLane;
  readonly sentAt: number;
  readonly purpose: 'normal' | 'maintenance';
  registered?: boolean;
}

/** Raw SDK terminal allowlist, never parse fallbacks or usage inference. */
function knownTerminal(reason: unknown): boolean {
  return typeof reason === 'string' && ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn', 'model_context_window_exceeded'].includes(reason);
}

export class CacheKeepalive {
  private outcomes = new Map<string, OutcomeState>();
  private sequence = 0;
  private attempts = new WeakMap<KeepaliveAttempt, AttemptData>();
  private lineages = new Map<string, Lineage>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private consecutiveErrors = 0;
  private stopped = false;
  private disabledReported = false;
  private readonly cfg: Required<Omit<CacheKeepaliveConfig, 'onEvent' | 'onCall' | 'onSuppressed' | 'onDiagnostic'>> &
    Pick<CacheKeepaliveConfig, 'onEvent' | 'onCall' | 'onSuppressed' | 'onDiagnostic'>;

  constructor(private readonly send: KeepaliveSend, config: CacheKeepaliveConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    if (this.cfg.suppressOnRefusal && !Number.isFinite(this.cfg.maxLineages)) this.cfg.maxLineages = DEFAULTS.maxLineages;
    if (!this.cfg.enabled) this.stopped = true;
  }

  /** Begin before awaiting the SDK, including lanes excluded from scheduling.
   * Maintenance is a trusted non-wire caller declaration, not inferred intent. */
  begin(wire: Record<string, unknown>, headers: Record<string, string> | undefined,
    lane: KeepaliveLane, purpose: 'normal' | 'maintenance' = 'normal', sentAt = Date.now()): KeepaliveAttempt | undefined {
    if (!this.cfg.suppressOnRefusal || this.stopped) return undefined;
    // Reserve entry order before caller-owned serialization or observers reenter.
    const sequence = ++this.sequence;
    // Keep SDK-native values (including JSON.rawJSON exact numbers) intact.
    // Callers must not mutate retained requests or use custom serialization.
    sentAt = Number(sentAt);
    headers = headers ? { ...headers } : undefined;
    const key = lineageKey(wire);
    if (this.stopped) return undefined;
    const state = this.outcomes.get(key);
    // Only potentially schedulable foreground requests may allocate a new key.
    // Other traffic still gets a handle: a late refusal must suppress a key
    // retained by then, and existing identities keep cross-lane rearm semantics.
    const admit = !!state || (purpose === 'normal' &&
      this.cfg.lanes.includes(lane) && ineligibleReason(wire) === null);
    if (this.stopped) return undefined;
    // Serialization may reenter, refuse, evict, and recreate this key. We cannot
    // safely adopt any resulting identity for success. Keep a detached handle:
    // its later refusal still applies to a retained key, without recreating one.
    if (!admit || sequence !== this.sequence) {
      const handle = Object.freeze({ key }) as KeepaliveAttempt;
      const detached = { barrier: 0, latest: 0, qualified: false };
      this.attempts.set(handle, { key, state: detached, sequence, wire, headers, lane, purpose, sentAt });
      if (admit && sequence !== this.sequence) this.diagnose(key, 'detached-attempt: serialization reentry prevents qualification');
      return handle;
    }
    const retained = state ?? { barrier: 0, latest: 0, qualified: false };
    this.outcomes.delete(key);
    this.outcomes.set(key, retained);
    while (this.outcomes.size > this.cfg.maxLineages) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
      this.lineages.delete(oldest);
      this.diagnose(oldest, 'outcome-lru-eviction: maxLineages cap exceeded');
    }
    if (this.stopped) return undefined;
    const handle = Object.freeze({ key }) as KeepaliveAttempt;
    this.attempts.set(handle, { key, state: retained, sequence, wire, headers, lane, purpose, sentAt });
    return handle;
  }

  /** Retained caller request; callers must not mutate it while tracked. */
  requestForAttempt(handle: KeepaliveAttempt): Record<string, unknown> | undefined {
    return this.attempts.get(handle)?.wire;
  }

  private current(attempt: AttemptData): boolean {
    return !this.stopped && this.outcomes.get(attempt.key) === attempt.state;
  }

  /** Prefix observation orders snapshots, but cannot initially qualify an identity. */
  prefix(handle: KeepaliveAttempt): void {
    const attempt = this.attempts.get(handle);
    if (!attempt || !this.current(attempt) ||
        attempt.sequence <= attempt.state.barrier || attempt.sequence < attempt.state.latest) return;
    if (!this.cfg.lanes.includes(attempt.lane)) return;
    const reason = ineligibleReason(attempt.wire);
    // Caller-owned eligibility accessors may reenter and finish this handle.
    if (this.attempts.get(handle) !== attempt || !this.current(attempt) || attempt.sequence <= attempt.state.barrier ||
        attempt.sequence < attempt.state.latest) return;
    if (reason) {
      attempt.state.latest = attempt.sequence;
      if (this.lineages.delete(attempt.key)) this.emit({ type: 'skipped', key: attempt.key, reason });
      else this.diagnose(attempt.key, `ineligible-prefix: ${reason}; older snapshots barred`);
      return;
    }
    // A pending prefix with no snapshot must not starve completed requests.
    if (attempt.state.qualified && !attempt.registered) {
      attempt.state.latest = attempt.sequence;
      this.installSnapshot(attempt.wire, attempt.headers, attempt.lane, attempt.sentAt, attempt.key, null);
      attempt.registered = true;
    }
  }

  /** Observe raw terminal metadata. Errors/cancellation must not call this as success. */
  finish(handle: KeepaliveAttempt, reason: unknown): void {
    const attempt = this.attempts.get(handle);
    if (!attempt || this.stopped) return;
    this.attempts.delete(handle); // First terminal wins before reentry; release prompts/headers.
    if (reason === 'refusal') {
      // Eviction invalidates successes, not a refusal for a retained key.
      // Do not recreate forgotten identities or enlarge the bounded map.
      const state = this.outcomes.get(attempt.key);
      if (state) this.suppress(attempt.key, state, 'foreground');
      return;
    }
    if (!knownTerminal(reason)) {
      this.diagnose(attempt.key, 'unknown-foreground-terminal: completion cannot qualify or rearm keepalive');
      return;
    }
    if (!this.current(attempt) || attempt.purpose !== 'normal' ||
        attempt.sequence <= attempt.state.barrier) return;
    const included = this.cfg.lanes.includes(attempt.lane);
    const needsSnapshot = included && attempt.sequence >= attempt.state.latest && !attempt.registered;
    const eligibility = needsSnapshot ? ineligibleReason(attempt.wire) : null;
    // Last check after all caller-controlled work, immediately before mutation.
    if (!this.current(attempt) || attempt.sequence <= attempt.state.barrier) return;
    attempt.state.qualified = true;
    // Keep the last refusal sequence after rearm: an older handle stays barred.
    if (!needsSnapshot || attempt.sequence < attempt.state.latest) return;
    attempt.state.latest = attempt.sequence;
    this.installSnapshot(attempt.wire, attempt.headers, attempt.lane, attempt.sentAt, attempt.key, eligibility);
    attempt.registered = true;
  }

  private suppress(key: string, state: OutcomeState, source: 'foreground' | 'refresh'): void {
    state.qualified = false;
    state.barrier = ++this.sequence;
    this.lineages.delete(key);
    try {
      void Promise.resolve(this.cfg.onSuppressed?.({ type: 'suppressed', key, source })).catch(() => {});
    } catch {
    }
  }

  /** Record a real request the provider is known to have begun answering, so
   *  it has processed the request's prefix. `sentAt` is when the request was
   *  sent, where the cache entry's clock starts: the lineage's touch counts
   *  from it, and its window from it or a later real call the lineage already
   *  has. Left out, both count from now. Call it once per call that gets that
   *  far. With suppression enabled, use begin/prefix/finish instead: record
   *  alone is ignored, even for an already-qualified identity. */
  record(
    wire: Record<string, unknown>,
    headers: Record<string, string> | undefined,
    lane: KeepaliveLane,
    sentAt: number = Date.now(),
  ): void {
    if (this.stopped || this.cfg.suppressOnRefusal) return;
    if (!this.cfg.lanes.includes(lane)) return;

    const reason = ineligibleReason(wire);
    const key = lineageKey(wire);
    this.installSnapshot(wire, headers, lane, sentAt, key, reason);
  }

  private installSnapshot(wire: Record<string, unknown>, headers: Record<string, string> | undefined,
    lane: KeepaliveLane, sentAt: number, key: string, reason: string | null): void {
    if (reason) {
      if (this.lineages.delete(key)) this.emit({ type: 'skipped', key, reason });
      return;
    }

    const existing = this.lineages.get(key);
    this.lineages.delete(key);
    this.lineages.set(key, {
      wire,
      headers,
      lane,
      lastRealAt: Math.max(sentAt, existing?.lastRealAt ?? sentAt),
      refreshBaselineAt: sentAt,
      ineffective: existing?.ineffective ?? 0,
    });

    while (this.lineages.size > this.cfg.maxLineages) {
      const oldest = this.lineages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lineages.delete(oldest);
    }

    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.checkIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const [key, lin] of [...this.lineages]) {
        if (this.stopped) break;
        if (this.lineages.get(key) !== lin) continue;
        const expiryNow = this.cfg.suppressOnRefusal ? Date.now() : now;
        if (expiryNow - lin.lastRealAt >= this.cfg.maxIdleMs) {
          this.lineages.delete(key);
          if (this.cfg.suppressOnRefusal) this.outcomes.delete(key);
          this.emit({ type: 'expired', key, idleMs: expiryNow - lin.lastRealAt });
          continue;
        }
        if (now - lin.refreshBaselineAt < this.cfg.refreshAfterMs) continue;
        await this.refresh(key, lin);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async refresh(key: string, lin: Lineage): Promise<void> {
    const state = this.outcomes.get(key);
    const startedAt = Date.now();
    const idleMs = startedAt - lin.refreshBaselineAt;
    let payload: Record<string, unknown> | undefined;
    let invoked = false;
    let reported = false;
    let settledDurationMs: number | undefined;
    try {
      // Validate before invoking the sender, but do not round-trip opt-in JSON:
      // parsing would round exact-digit rawJSON numbers to JavaScript doubles.
      const serialized = JSON.stringify(lin.wire);
      const wire: unknown = this.cfg.suppressOnRefusal ? lin.wire : JSON.parse(serialized);
      if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
        throw new Error('Keepalive request must serialize to a JSON object');
      }
      const recorded = wire as Record<string, unknown>;
      // A root serializer can override the zero-output budget and trimmed messages.
      // Fail closed in opt-in mode rather than risk a billable generation replay.
      if (this.cfg.suppressOnRefusal && typeof recorded.toJSON === 'function') {
        throw new Error('Keepalive does not support root toJSON serialization');
      }
      payload = { ...recorded, max_tokens: 0 };
      // Spreading can read a changing accessor: validate the actual replay too.
      if (this.cfg.suppressOnRefusal && typeof payload.toJSON === 'function') {
        throw new Error('Keepalive does not support root toJSON serialization');
      }
      if (Array.isArray(recorded.messages)) payload.messages = messagesForRefresh(recorded.messages);
      delete payload.stream;
      if (this.cfg.suppressOnRefusal) {
        if (this.stopped || this.lineages.get(key) !== lin || this.outcomes.get(key) !== state) return;
        // Replay preparation can run caller serializers/accessors and cross the
        // idle cutoff. Check again after all preparation, immediately before send.
        const expiryNow = Date.now();
        if (expiryNow - lin.lastRealAt >= this.cfg.maxIdleMs) {
          this.lineages.delete(key);
          this.outcomes.delete(key);
          this.emit({ type: 'expired', key, idleMs: expiryNow - lin.lastRealAt });
          return;
        }
      }
      invoked = true;
      const resolved = await this.send(payload, lin.headers);
      if (this.cfg.suppressOnRefusal) settledDurationMs = Date.now() - startedAt;
      // A resolved sender is a transport success even without a response body.
      // Preserve main's legacy processing (including errors) when opted out.
      const res = this.cfg.suppressOnRefusal ? resolved ?? {} : resolved;
      // Install the refusal barrier before receipt observers can replace the
      // snapshot. Refusals apply to the currently retained key, even if the
      // snapshot or outcome identity was replaced during the sender await.
      const stopReason = this.cfg.suppressOnRefusal ? res.stop_reason : undefined;
      const refused = this.cfg.suppressOnRefusal && stopReason === 'refusal';
      const currentState = this.outcomes.get(key);
      if (refused && !this.stopped && currentState) this.suppress(key, currentState, 'refresh');
      // Retire unknown terminals before unrelated response getters can throw.
      const unknown = this.cfg.suppressOnRefusal && !refused && !knownTerminal(stopReason);
      if (unknown && !this.stopped && this.lineages.get(key) === lin && this.outcomes.get(key) === state) {
        this.lineages.delete(key);
        this.diagnose(key, 'unknown-refresh-terminal: replay snapshot retired');
      }
      // Do not invoke a caller-owned terminal getter a second time while copying.
      // Keep legacy spread semantics unchanged when suppression is off.
      const response: Record<string, unknown> = {};
      if (this.cfg.suppressOnRefusal) {
        for (const key of Object.keys(res)) {
          Object.defineProperty(response, key, { value: key === 'stop_reason' ? stopReason :
            (res as Record<string, unknown>)[key], enumerable: true, configurable: true, writable: true });
        }
      }
      const durationMs = this.cfg.suppressOnRefusal ? settledDurationMs! : Date.now() - startedAt;
      const receiptResponse = this.cfg.suppressOnRefusal ? response : { ...res };
      reported = true;
      this.reportCall({
        key, lane: lin.lane, startedAt, durationMs,
        request: payload, outcome: 'success', response: receiptResponse,
      });
      // Successfully processed resolutions break a run of failures, even when the
      // semantic outcome cannot refresh the cache (or its snapshot is stale).
      if (!this.cfg.suppressOnRefusal || refused) this.consecutiveErrors = 0;
      if (refused) return;
      if (this.cfg.suppressOnRefusal) {
        if (this.stopped || this.lineages.get(key) !== lin || this.outcomes.get(key) !== state) {
          this.consecutiveErrors = 0;
          return;
        }
      }
      const rawRead = res.usage?.cache_read_input_tokens ?? 0;
      const rawWrote = res.usage?.cache_creation_input_tokens ?? 0;
      // In opt-in mode, complete potentially throwing coercion before resetting
      // the failure run. Subsequent comparisons must use captured primitives.
      const read = this.cfg.suppressOnRefusal ? Number(rawRead) : rawRead;
      const wrote = this.cfg.suppressOnRefusal ? Number(rawWrote) : rawWrote;
      if (this.cfg.suppressOnRefusal) {
        for (const [field, value] of [['cache_read_input_tokens', read], ['cache_creation_input_tokens', wrote]] as const) {
          if (!Number.isFinite(value)) throw new Error(`Non-finite keepalive usage: ${field}=${value}; expected finite provider/sender cache usage`);
        }
        this.consecutiveErrors = 0;
      }
      // Usage accessors, like receipt observers, may replace or stop this key.
      if (this.cfg.suppressOnRefusal &&
          (this.stopped || this.lineages.get(key) !== lin || this.outcomes.get(key) !== state)) return;

      if (read <= 0 || wrote > 0) {
        lin.ineffective += 1;
        // Retire opt-in identity before observers can begin its replacement.
        if (this.cfg.suppressOnRefusal && lin.ineffective >= this.cfg.maxIneffective) {
          this.lineages.delete(key);
          this.outcomes.delete(key);
          this.diagnose(key, `ineffective-retirement: replay snapshot and identity retired after ${lin.ineffective} consecutive ineffective refreshes`);
        }
        this.emit({
          type: 'ineffective',
          key,
          reason: wrote > 0 ? 'wrote-instead-of-read' : 'no-cache-read',
          readTokens: read,
          writeTokens: wrote,
        });
        if (this.cfg.suppressOnRefusal && (this.stopped || this.lineages.get(key) !== lin)) return;
        if (lin.ineffective >= this.cfg.maxIneffective) {
          if (this.lineages.get(key) === lin) {
            this.lineages.delete(key);
          }
        } else {
          lin.refreshBaselineAt = startedAt;
        }
        return;
      }

      lin.ineffective = 0;
      lin.refreshBaselineAt = startedAt;
      this.emit({ type: 'refreshed', key, lane: lin.lane, readTokens: read, idleMs });
    } catch (err) {
      // Capture rejection time before error formatting or other caller code.
      if (this.cfg.suppressOnRefusal) settledDurationMs ??= Date.now() - startedAt;
      let message = 'Unprintable keepalive error';
      try { message = String(err instanceof Error ? err.message : err); } catch {}
      if (payload && (!this.cfg.suppressOnRefusal || (invoked && !reported))) {
        this.reportCall({
          key, lane: lin.lane, startedAt,
          durationMs: this.cfg.suppressOnRefusal ? settledDurationMs! : Date.now() - startedAt,
          request: payload, outcome: 'error', error: err,
        });
      }
      // Transport failures are global, even when the invoked snapshot is stale.
      if (this.cfg.suppressOnRefusal && (this.stopped || (!invoked &&
          (this.lineages.get(key) !== lin || this.outcomes.get(key) !== state)))) return;
      // A preparation failure cannot improve by retrying the same snapshot.
      // Keep outcome identity so a later qualified prefix can replace it.
      if (this.cfg.suppressOnRefusal && !invoked) {
        this.lineages.delete(key);
        message = 'replay-preparation-failed: replay snapshot retired';
      }
      // Preparation failures are observable, but are not failed sends.
      if (!this.cfg.suppressOnRefusal || invoked) this.consecutiveErrors += 1;
      if (this.cfg.suppressOnRefusal && !invoked) this.diagnose(key, message);
      else this.emit({ type: 'error', key, error: message, consecutive: this.consecutiveErrors });
      if (this.cfg.suppressOnRefusal && this.stopped) return;

      if (!this.cfg.suppressOnRefusal ||
          (this.lineages.get(key) === lin && this.outcomes.get(key) === state)) lin.refreshBaselineAt = Date.now();

      if (!this.disabledReported && (!this.cfg.suppressOnRefusal || invoked) && this.consecutiveErrors >= this.cfg.maxConsecutiveErrors) {
        this.stop();
        this.emit({
          type: 'disabled',
          reason: `${this.consecutiveErrors} consecutive keepalive failures; last: ${message}`,
        });
      }
    }
  }

  private reportCall(call: KeepaliveCall): void {
    if (!this.cfg.onCall) return;
    let receipt: KeepaliveCall;
    try {
      receipt = call.outcome === 'success'
        ? { ...call, request: structuredClone(call.request), response: structuredClone(call.response) }
        : { ...call, request: structuredClone(call.request) };
    } catch {
      if (this.cfg.suppressOnRefusal) this.diagnose(call.key, 'receipt-clone-failed: receipt dropped');
      return;
    }
    try {
      void Promise.resolve(this.cfg.onCall(receipt)).catch(() => {});
    } catch {
    }
  }

  private diagnose(key: string, reason: string): void {
    try {
      void Promise.resolve(this.cfg.onDiagnostic?.({ type: 'diagnostic', key, reason })).catch(() => {});
    } catch {
    }
  }

  private emit(event: KeepaliveEvent): void {
    try {
      void Promise.resolve(this.cfg.onEvent?.(event)).catch(() => {});
    } catch {
    }
  }

  /** A snapshot of the tracked lineages. */
  getStatus(): Array<{ key: string; lane: KeepaliveLane; idleMs: number; realIdleMs: number }> {
    const now = Date.now();
    return [...this.lineages].map(([key, l]) => ({
      key,
      lane: l.lane,
      idleMs: now - l.refreshBaselineAt,
      realIdleMs: now - l.lastRealAt,
    }));
  }

  stop(reason?: string): void {
    const wasStopped = this.stopped;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lineages.clear();
    this.outcomes.clear();
    this.attempts = new WeakMap();
    if (reason && !wasStopped) {
      this.disabledReported = true;
      this.emit({ type: 'disabled', reason });
    }
  }
}
