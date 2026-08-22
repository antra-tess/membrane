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

/** Minimal shape we need back from a keepalive send. */
export interface KeepaliveUsage {
  // The SDK types these as `number | null`, and null is meaningfully different
  // from 0 here: null means the field was absent (we learned nothing), 0 means
  // the API told us nothing was read. Both are treated as "not a read" below.
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export type KeepaliveSend = (
  wire: Record<string, unknown>,
  headers: Record<string, string> | undefined,
) => Promise<{ usage?: KeepaliveUsage }>;

export type KeepaliveLane = 'stream' | 'complete';

export type KeepaliveEvent =
  | { type: 'refreshed'; key: string; lane: KeepaliveLane; readTokens: number; idleMs: number }
  | { type: 'ineffective'; key: string; reason: string; readTokens: number; writeTokens: number }
  | { type: 'skipped'; key: string; reason: string }
  | { type: 'error'; key: string; error: string; consecutive: number }
  | { type: 'disabled'; reason: string }
  | { type: 'expired'; key: string; idleMs: number };

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
  h.update(' ');
  h.update(JSON.stringify(wire.system ?? null));
  h.update(' ');
  h.update(JSON.stringify(wire.tools ?? null));
  return h.digest('hex').slice(0, 16);
}

export class CacheKeepalive {
  private lineages = new Map<string, Lineage>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private consecutiveErrors = 0;
  private stopped = false;
  private readonly cfg: Required<Omit<CacheKeepaliveConfig, 'onEvent'>> & {
    onEvent?: (event: KeepaliveEvent) => void;
  };

  constructor(private readonly send: KeepaliveSend, config: CacheKeepaliveConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    if (!this.cfg.enabled) this.stopped = true;
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
        await this.refresh(key, lin);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async refresh(key: string, lin: Lineage): Promise<void> {
    // Only max_tokens (not part of the cache key) and stream (transport) differ
    // from the recorded request. Nothing else is touched — see file header.
    const payload: Record<string, unknown> = { ...lin.wire, max_tokens: 0 };
    delete payload.stream;

    const idleMs = Date.now() - lin.lastTouchAt;
    try {
      const res = await this.send(payload, lin.headers);
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
      this.consecutiveErrors += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', key, error: message, consecutive: this.consecutiveErrors });

      // Back this lineage off immediately rather than retrying on the next tick.
      lin.lastTouchAt = Date.now();

      // Hard breaker. A background loop that keeps firing failing requests is
      // how fable-cm produced 1033 `400 invalid_request_error` rows in 3h on
      // 2026-08-21 — the exact error class that also trips the agent's
      // poison-history breaker. A keepalive must never be that loop.
      if (this.consecutiveErrors >= this.cfg.maxConsecutiveErrors) {
        this.stop();
        this.emit({
          type: 'disabled',
          reason: `${this.consecutiveErrors} consecutive keepalive failures; last: ${message}`,
        });
      }
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
