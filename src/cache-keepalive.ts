// Prompt-cache keepalive for the Anthropic direct API.
//
// WHY
// ---
// Anthropic prompt cache entries expire on a TTL (1h for `cache_control.ttl:
// '1h'`), but **reading an entry restarts its clock** — the docs say the cache
// "is refreshed for no additional cost each time the cached content is used",
// and the lifetime is measured from the start of the request that *writes or
// reads* the entry. Verified empirically 2026-08-22: a 5m entry, poked with a
// `max_tokens: 0` request every 4 minutes, was still served as a pure read at
// t+12m (2.4x its nominal TTL), every poke reporting create=0 / read=6617.
//
// So an idle agent's context can be held warm indefinitely at cache-READ price
// (0.1x input) instead of paying a cache-WRITE (2x input) on its next wake.
// For a ~500k-token resident that is the difference between ~$0.50 and ~$10.00
// per wake. Measured on fable-cm's 11-day log (2026-08-11..22): 49.7M tokens of
// cache_creation occurred on turns that followed a >1h idle gap — $944 of write
// premium that a keepalive converts into ~$308 of reads.
//
// HOW
// ---
// We snapshot the exact wire request of each real call and replay it verbatim
// with `max_tokens: 0`, which runs prefill only: content `[]`, stop_reason
// `max_tokens`, zero output tokens billed, and the cache entry refreshed.
//
// ⚠️ THE REPLAY MUST BE BYTE-IDENTICAL ABOVE THE LAST BREAKPOINT.
// Prompt caching is a prefix match, and the API's invalidation hierarchy means
// some innocent-looking "normalizations" silently turn a 0.1x read into a 2x
// write. Verified the hard way on 2026-08-22: replaying with
// `thinking: {type:'disabled'}` instead of the request's own
// `thinking: {type:'adaptive'}` produced create=5081 / read=0 — a full rewrite,
// reported as a perfectly successful call. That failure is invisible unless you
// check the usage numbers, so `refresh()` below checks them on every single
// poke and disables the lineage rather than quietly burning 20x.
//
// Hence: we never rewrite the snapshot. We change `max_tokens` (not part of the
// cache key) and drop `stream` (a transport concern), and nothing else. Any
// request shape that can't tolerate `max_tokens: 0` is skipped outright rather
// than "fixed up" — see `ineligibleReason()`.

import { createHash } from 'node:crypto';

/** Vendor usage fields used by keepalive checks and spend observers. */
export interface KeepaliveUsage {
  // The SDK types these as `number | null`, and null is meaningfully different
  // from 0 here: null means the field was absent (we learned nothing), 0 means
  // the API told us nothing was read. Both are treated as "not a read" below.
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
) => Promise<{ usage?: KeepaliveUsage }>;

export type KeepaliveLane = 'stream' | 'complete';

/** One terminal receipt per KeepaliveSend invocation, not per HTTP attempt.
 * SDK-internal retries belong to that invocation. A success carries the full
 * vendor response and its terminal usage, including ineffective cache writes.
 * Request and response objects are observer-owned copies; recorded request
 * headers are excluded. */
export type KeepaliveCall = {
  key: string;
  /** The real request's lane whose cache lineage this poke refreshes. */
  lane: KeepaliveLane;
  /** Unix epoch milliseconds when this poke attempt began. */
  startedAt: number;
  durationMs: number;
  /** JSON wire payload sent by the poke: max_tokens is 0 and stream is omitted. */
  request: Record<string, unknown>;
} & (
  | { outcome: 'success'; response: Record<string, unknown> & { usage?: KeepaliveUsage } }
  | { outcome: 'error'; error: unknown }
);

export type KeepaliveEvent =
  | { type: 'refreshed'; key: string; lane: KeepaliveLane; readTokens: number; idleMs: number }
  | { type: 'ineffective'; key: string; reason: string; readTokens: number; writeTokens: number }
  | { type: 'skipped'; key: string; reason: string }
  | { type: 'error'; key: string; error: string; consecutive: number }
  | { type: 'disabled'; reason: string }
  | { type: 'expired'; key: string; idleMs: number }
  /** A provider stated a wait for `model`: no lineage of that model is poked
   * before `until` (epoch ms; null holds until the keepalive stops). */
  | { type: 'held'; model: string; until: number | null; reason: string };

/** What the keepalive needs from a classified failure: the provider's stated
 * wait, and whether the provider says the request may be retried. */
export interface KeepaliveFailureClassification {
  retryAfterMs?: number;
  retryable?: boolean;
}

/** The last instant a JavaScript Date can represent (ECMA-262 time value range). */
const MAX_DATE_MS = 8.64e15;

export interface CacheKeepaliveConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /**
   * Stop refreshing once the last REAL request is this old. Keepalive pokes do
   * not extend this — otherwise an agent that never speaks again would be kept
   * warm forever. Default 24h.
   */
  maxIdleMs?: number;
  /**
   * Refresh once the entry hasn't been touched for this long. Must be < the
   * cache TTL, with margin: the TTL clock starts at the *start* of the request,
   * and a long streaming turn can itself eat minutes. Default 45m against a 1h
   * TTL leaves 15m of headroom.
   */
  refreshAfterMs?: number;
  /** Timer cadence. Default 5m. */
  checkIntervalMs?: number;
  /**
   * Which lanes to keep warm. Default ['stream'] — the primary/voice lane.
   * The aux ('complete') lane is measured to do no prompt caching at all today
   * (fable-cm: 382 aux calls, every one create=0/read=0), so warming it would
   * poke a cache entry that does not exist.
   */
  lanes?: KeepaliveLane[];
  /** LRU cap on tracked lineages, to bound memory. Each holds a full wire
   *  request (~1.5MB for a 500k-token resident). Default 4. */
  maxLineages?: number;
  /** Consecutive send failures before the whole keepalive disables itself. */
  maxConsecutiveErrors?: number;
  /**
   * How many times a lineage may come back as a WRITE instead of a read before
   * we stop poking it. A lineage whose prefix churns every turn cannot be kept
   * warm, and paying 2x to discover that repeatedly is the worst outcome.
   */
  maxIneffective?: number;
  onEvent?: (event: KeepaliveEvent) => void;
  /** Report background calls to the same ledger as foreground inference.
   * Invoked once on success (including ineffective responses) or failure.
   * Observer errors are isolated, and returned promises never delay the loop.
   * Skipped, expired, and disabled lineages do not make calls or receipts.
   * Poke serialization failures are reported through onEvent before any sender invocation. */
  onCall?: (call: KeepaliveCall) => void | Promise<void>;
}

interface Lineage {
  wire: Record<string, unknown>;
  headers: Record<string, string> | undefined;
  lane: KeepaliveLane;
  /** Last real (non-keepalive) request. Bounds the keepalive window. */
  lastRealAt: number;
  /** Last time the entry was touched by anything, real or keepalive. */
  lastTouchAt: number;
  ineffective: number;
}

const DEFAULTS = {
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
 * Reasons a request shape cannot be safely replayed as `max_tokens: 0`.
 *
 * Each of these is either rejected outright by the API, or — worse — would
 * require editing the request in a way that moves the cache-invalidation
 * boundary. Skipping is always cheaper than guessing.
 */
export function ineligibleReason(wire: Record<string, unknown>): string | null {
  const thinking = wire.thinking as { type?: string } | undefined;
  // `max_tokens: 0` is rejected with thinking.type 'enabled', and we must not
  // "fix" that by disabling thinking — toggling thinking invalidates the
  // messages cache (measured: create=5081/read=0).
  if (thinking?.type === 'enabled') return 'legacy-thinking-budget';

  const toolChoice = wire.tool_choice as { type?: string } | undefined;
  // Rejected with max_tokens: 0, and tool_choice changes invalidate the
  // messages cache, so we cannot substitute 'auto'.
  if (toolChoice?.type === 'tool' || toolChoice?.type === 'any') return 'forced-tool-choice';

  const outputConfig = wire.output_config as { format?: unknown } | undefined;
  if (outputConfig?.format) return 'structured-output';

  // Only the 1h cache is worth a background timer. A 5m entry would need a poke
  // every ~4 minutes; at 0.1x of a large prefix that costs more than it saves.
  const markers = scanCacheMarkers(wire);
  if (!markers.any) return 'no-cache-breakpoint';
  if (!markers.oneHour) return 'no-1h-breakpoint';

  return null;
}

/**
 * Walk system + tools + messages for cache_control markers.
 *
 * This runs on every outbound request, and `messages` on a large resident is
 * megabytes of blocks — so it short-circuits the moment it finds a 1h marker,
 * which is the answer in the overwhelmingly common case.
 */
function scanCacheMarkers(wire: Record<string, unknown>): { any: boolean; oneHour: boolean } {
  let any = false;
  let oneHour = false;

  const visit = (node: unknown): void => {
    if (oneHour) return; // nothing left to learn
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
        if (oneHour) return;
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const cc = obj.cache_control as { ttl?: string } | undefined;
    if (cc && typeof cc === 'object') {
      any = true;
      if ((cc.ttl ?? '5m') === '1h') {
        oneHour = true;
        return;
      }
    }
    if (obj.content) visit(obj.content);
  };

  visit(wire.system);
  visit(wire.tools);
  visit(wire.messages);
  return { any, oneHour };
}

/**
 * Identity of a cache lineage: model + system + tools. This is exactly the root
 * of the cached prefix, so two agents in one process, or an agent's primary vs
 * aux lane, land in different buckets automatically.
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

export class CacheKeepalive {
  private lineages = new Map<string, Lineage>();
  /**
   * Per model, the instant before which no lineage of that model is poked:
   * the maximum outstanding provider wait stated by any call to the model,
   * foreground or keepalive (Infinity when a stated wait cannot be held as an
   * instant: held until stop()). A wait passing is the only thing that ends
   * one; another caller's release of its own admission does not.
   */
  private holds = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private consecutiveErrors = 0;
  private stopped = false;
  private readonly cfg: Required<Omit<CacheKeepaliveConfig, 'onEvent' | 'onCall'>> &
    Pick<CacheKeepaliveConfig, 'onEvent' | 'onCall'>;

  /**
   * `classify` reads a failed poke as the adapter classifies it (stated wait,
   * retryability); without it, a failed poke holds nothing and always counts
   * toward the breaker.
   */
  constructor(
    private readonly send: KeepaliveSend,
    config: CacheKeepaliveConfig = {},
    private readonly classify?: (error: unknown) => KeepaliveFailureClassification | undefined,
  ) {
    this.cfg = { ...DEFAULTS, ...config };
    if (!this.cfg.enabled) this.stopped = true;
  }

  /**
   * A provider's stated wait for `model`, from any call to it: every lineage
   * of that model is skipped until the wait passes. Holds reduce by maximum
   * (a later, shorter wait never shortens one), and a wait that cannot be
   * held as an instant (not finite, or past the last Date instant) holds
   * until stop(). A value that is not a non-negative number states no wait.
   */
  holdModel(model: string, retryAfterMs: unknown, reason: string): void {
    if (this.stopped) return;
    if (typeof retryAfterMs !== 'number' || Number.isNaN(retryAfterMs) || retryAfterMs < 0) return;
    const instant = Date.now() + retryAfterMs;
    const until = Number.isFinite(instant) && instant <= MAX_DATE_MS ? instant : Number.POSITIVE_INFINITY;
    const current = this.holds.get(model);
    if (current !== undefined && current >= until) return;
    this.holds.set(model, until);
    this.emit({ type: 'held', model, until: Number.isFinite(until) ? until : null, reason });
  }

  /** The hold binding `model` at `now`, if any; a passed one is dropped. */
  private heldUntil(model: string, now: number): number | undefined {
    const until = this.holds.get(model);
    if (until === undefined) return undefined;
    if (now >= until) {
      this.holds.delete(model);
      return undefined;
    }
    return until;
  }

  /** Record a real outbound request. Cheap; called on every LLM call. */
  record(
    wire: Record<string, unknown>,
    headers: Record<string, string> | undefined,
    lane: KeepaliveLane,
  ): void {
    if (this.stopped) return;
    if (!this.cfg.lanes.includes(lane)) return;

    const reason = ineligibleReason(wire);
    const key = lineageKey(wire);
    if (reason) {
      // Drop any stale snapshot: the shape changed and is no longer warmable.
      if (this.lineages.delete(key)) this.emit({ type: 'skipped', key, reason });
      return;
    }

    const now = Date.now();
    const existing = this.lineages.get(key);
    // Re-insert to refresh LRU position.
    this.lineages.delete(key);
    this.lineages.set(key, {
      wire,
      headers,
      lane,
      lastRealAt: now,
      lastTouchAt: now,
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
    // Never hold the process open for a cache poke.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const [key, lin] of [...this.lineages]) {
        if (this.stopped) break;
        // The keepalive window is measured from the last REAL request, so pokes
        // can never extend their own mandate.
        if (now - lin.lastRealAt >= this.cfg.maxIdleMs) {
          this.lineages.delete(key);
          this.emit({ type: 'expired', key, idleMs: now - lin.lastRealAt });
          continue;
        }
        // Idle-gated, not blind: if real traffic already touched the entry
        // inside the window, it refreshed the TTL for free and we do nothing.
        // This is what keeps a busy agent's keepalive cost at ~zero.
        if (now - lin.lastTouchAt < this.cfg.refreshAfterMs) continue;
        // A stated wait on this lineage's model, including one a poke of
        // another lineage of the same model received earlier in this tick.
        if (this.heldUntil(String(lin.wire.model ?? ''), now) !== undefined) continue;
        await this.refresh(key, lin);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async refresh(key: string, lin: Lineage): Promise<void> {
    const startedAt = Date.now();
    const idleMs = startedAt - lin.lastTouchAt;
    let payload: Record<string, unknown> | undefined;
    try {
      // Materialize the same JSON shape HTTP would send, once. Callable fields
      // serialize away, and toJSON values are evaluated before both sending and
      // observation. Re-serializing caller objects for the receipt could differ
      // from the sent body; structuredClone on those objects can fail outright.
      const wire: unknown = JSON.parse(JSON.stringify(lin.wire));
      if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
        throw new Error('Keepalive request must serialize to a JSON object');
      }
      // Only max_tokens (not part of the cache key) and stream (transport)
      // differ from the recorded wire request — see file header.
      payload = { ...wire as Record<string, unknown>, max_tokens: 0 };
      delete payload.stream;
      const res = await this.send(payload, lin.headers);
      this.reportCall({
        key, lane: lin.lane, startedAt, durationMs: Date.now() - startedAt,
        request: payload, outcome: 'success', response: { ...res },
      });
      this.consecutiveErrors = 0;

      const read = res.usage?.cache_read_input_tokens ?? 0;
      const wrote = res.usage?.cache_creation_input_tokens ?? 0;

      // The self-check. A keepalive that WRITES has not kept anything alive —
      // it paid 2x to create a fresh entry, which is the exact failure this
      // whole module exists to avoid. Never assume the poke worked.
      if (read <= 0 || wrote > 0) {
        lin.ineffective += 1;
        this.emit({
          type: 'ineffective',
          key,
          reason: wrote > 0 ? 'wrote-instead-of-read' : 'no-cache-read',
          readTokens: read,
          writeTokens: wrote,
        });
        if (lin.ineffective >= this.cfg.maxIneffective) {
          this.lineages.delete(key);
        } else {
          lin.lastTouchAt = Date.now();
        }
        return;
      }

      lin.ineffective = 0;
      lin.lastTouchAt = Date.now();
      this.emit({ type: 'refreshed', key, lane: lin.lane, readTokens: read, idleMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (payload) {
        this.reportCall({
          key, lane: lin.lane, startedAt, durationMs: Date.now() - startedAt,
          request: payload, outcome: 'error', error: err,
        });
      }
      // The provider's stated wait, if it gave one, holds every lineage of this
      // model. A refusal the provider classifies as retryable that states a
      // wait is then paced, not blind repetition: it does not count toward the
      // breaker (the count stays where it was; it is not reset). A failure that
      // is not retryable still counts, whatever wait it states.
      let classified: KeepaliveFailureClassification | undefined;
      try { classified = this.classify?.(err); } catch { classified = undefined; }
      if (classified?.retryAfterMs !== undefined) {
        this.holdModel(String(lin.wire.model ?? ''), classified.retryAfterMs, message);
      }
      const paced = classified?.retryable === true && classified.retryAfterMs !== undefined;
      if (!paced) this.consecutiveErrors += 1;
      this.emit({ type: 'error', key, error: message, consecutive: this.consecutiveErrors });

      // Back this lineage off immediately rather than retrying on the next tick.
      lin.lastTouchAt = Date.now();

      // Hard breaker. A background loop that keeps firing failing requests is
      // how fable-cm produced 1033 `400 invalid_request_error` rows in 3h on
      // 2026-08-21 — the exact error class that also trips the agent's
      // poison-history breaker. A keepalive must never be that loop.
      if (!paced && this.consecutiveErrors >= this.cfg.maxConsecutiveErrors) {
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
    try {
      // A logging callback must not be able to change the cached prefix or
      // usage that the effectiveness check below will read.
      const receipt: KeepaliveCall = call.outcome === 'success'
        ? { ...call, request: structuredClone(call.request), response: structuredClone(call.response) }
        : { ...call, request: structuredClone(call.request) };
      void Promise.resolve(this.cfg.onCall(receipt)).catch(() => {
        // Observers cannot turn a completed call into a keepalive failure.
      });
    } catch {
      // Match onEvent isolation, including failures while copying the payload.
    }
  }

  private emit(event: KeepaliveEvent): void {
    try {
      this.cfg.onEvent?.(event);
    } catch {
      // Observability must never break the keepalive, nor the caller.
    }
  }

  /** Snapshot for operators / tests. */
  getStatus(): Array<{ key: string; lane: KeepaliveLane; idleMs: number; realIdleMs: number }> {
    const now = Date.now();
    return [...this.lineages].map(([key, l]) => ({
      key,
      lane: l.lane,
      idleMs: now - l.lastTouchAt,
      realIdleMs: now - l.lastRealAt,
    }));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lineages.clear();
  }
}
