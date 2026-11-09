// Prompt-cache keepalive for the Anthropic direct API.
//
// Anthropic's prompt cache entries expire on a TTL, but reading an entry
// restarts its clock: the docs say the cache "is refreshed for no additional
// cost each time the cached content is used", and the lifetime runs from the
// start of the request that writes or reads the entry. A read is billed at
// 0.1x input, a one-hour write at 2x.
//
// A request with `max_tokens: 0` runs prefill only: content `[]`, stop_reason
// `max_tokens`, no output tokens billed, and the cache entry refreshed.
// `max_tokens` isn't part of the cache key. Caching is a prefix match, and an
// innocent-looking change to a replay turns the read into a write of the
// whole prefix, reported as a successful call and visible only in its usage:
// replaying a request sent with `thinking: {type:'adaptive'}` as
// `{type:'disabled'}` does. A prefix under the model's minimum cacheable
// length is processed and not cached.

import { collectMarkedBlocks } from './utils/cache-marker-budget.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
  /** JSON wire payload sent by the poke: max_tokens is 0, stream is omitted, and
   *  its messages are the recorded request's, through the user turn at or after its last one-hour marker,
   *  or all of them when no user message follows that marker. */
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
  /** A lineage brought back from `statePath` at construction. `idleMs` is
   *  how long its cache entry had gone untouched by then. */
  | { type: 'restored'; key: string; lane: KeepaliveLane; idleMs: number }
  /** `statePath` couldn't be read or written. The keepalive carries on in
   *  memory; a failed read starts it empty. */
  | { type: 'persist-error'; op: 'load' | 'save'; error: string }
  /** A lineage kept warm in memory but left out of `statePath`, because its
   *  request holds what looks like a credential (e.g. an MCP server's
   *  `authorization_token`). Emitted once per lineage. */
  | { type: 'not-persisted'; key: string; reason: string };

export interface CacheKeepaliveConfig {
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
   *  request. Default 4. */
  maxLineages?: number;
  /** Consecutive send failures before the whole keepalive disables itself. Default 3. */
  maxConsecutiveErrors?: number;
  /**
   * The number of pokes of a lineage in a row coming back without a cache read
   * (no read, or a write) at which the lineage is dropped. Default 2.
   */
  maxIneffective?: number;
  /**
   * A file that keeps the tracked lineages across a restart of the process.
   * Each change to them is written there (atomically, mode 0600), and a new
   * keepalive given the same path takes them back up and refreshes them when
   * they're due, as the old process would have. A lineage whose cache entry
   * was last touched an hour or more ago, or past `maxIdleMs` since its last
   * real request, isn't restored, since a replay of it would pay a write.
   * The file holds full wire requests (the conversation), so it belongs with
   * the agent's other private data. Only the `anthropic-beta` and
   * `anthropic-version` headers are saved, and a request holding what looks
   * like a credential is kept in memory only (`not-persisted`). One
   * keepalive per file: when another one writes it, the one that wrote it
   * before stops saving (`persist-error`). Unset: in memory only.
   */
  statePath?: string;
  /** Each keepalive event as it happens. An error it throws is ignored. */
  onEvent?: (event: KeepaliveEvent) => void;
  /** Report background calls to the same ledger as foreground inference.
   * Invoked once on success (including ineffective responses) or failure.
   * Observer errors are isolated, and returned promises never delay the loop.
   * Skipped, expired, and disabled lineages do not make calls or receipts.
   * Poke serialization failures are reported through onEvent before any sender invocation. */
  onCall?: (call: KeepaliveCall) => void | Promise<void>;
}

/** How long a one-hour cache entry lives after its last read or write. A
 *  restored lineage untouched this long has no entry left to refresh. */
const ONE_HOUR_TTL_MS = 60 * 60 * 1000;

/** The `statePath` file's shape. */
interface PersistedLineage {
  wire: Record<string, unknown>;
  headers?: Record<string, string>;
  lane: KeepaliveLane;
  lastRealAt: number;
  /** When the cache entry was last known to be read or written. */
  touchedAt: number;
  ineffective: number;
}
interface PersistedState {
  version: 1;
  lineages: PersistedLineage[];
}

/** The only headers that go to disk: anything else could be a credential. */
const PERSISTED_HEADERS = new Set(['anthropic-beta', 'anthropic-version']);

function persistableHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const kept = Object.entries(headers).filter(([name]) => PERSISTED_HEADERS.has(name.toLowerCase()));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

const CREDENTIAL_KEY = /(^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|credentials?)$/i;

/** The path of the first field outside the conversation (`system`, `tools`,
 *  `messages`) whose name looks like a credential, or null. `request.extra`
 *  reaches the wire as top-level fields, `mcp_servers[].authorization_token`
 *  among them, and those mustn't land on disk. */
export function credentialField(wire: Record<string, unknown>): string | null {
  const walk = (value: unknown, path: string, depth: number): string | null => {
    if (depth > 8 || value === null || typeof value !== 'object') return null;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`;
      if (!Array.isArray(value) && CREDENTIAL_KEY.test(k) && v !== undefined && v !== null && v !== '') return here;
      const found = walk(v, here, depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const [k, v] of Object.entries(wire)) {
    if (k === 'system' || k === 'tools' || k === 'messages') continue;
    if (CREDENTIAL_KEY.test(k) && v !== undefined && v !== null && v !== '') return k;
    const found = walk(v, k, 0);
    if (found) return found;
  }
  return null;
}

/** Write `data` to `path` atomically: a new private temp file (O_EXCL, so
 *  never through a planted link), flushed, then renamed over `path`. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  try {
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch {
    // Not every platform can fsync a directory (Windows); the rename stands.
  }
}

/** Identity of the file now at `path` (each atomic write is a new inode), or
 *  null when there is none. */
function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

interface Lineage {
  wire: Record<string, unknown>;
  headers: Record<string, string> | undefined;
  lane: KeepaliveLane;
  lastRealAt: number;
  /** When the next refresh is counted from: the last touch, or the last
   *  attempt, so a failing refresh isn't retried at every check. */
  refreshBaselineAt: number;
  /** When the cache entry was last known to be read or written. What a
   *  restart judges the entry's age by. */
  touchedAt: number;
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
  while (end + 1 < messages.length && isUser(messages[end + 1])) end++;
  return messages.slice(0, end + 1);
}

/**
 * Identity of a cache lineage: model, system and tools, the root of the cached
 * prefix. Requests that share all three share a lineage, whatever their lane
 * or messages, and the one recorded later replaces the other's snapshot.
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private consecutiveErrors = 0;
  private stopped = false;
  private readonly cfg: Required<Omit<CacheKeepaliveConfig, 'onEvent' | 'onCall' | 'statePath'>> &
    Pick<CacheKeepaliveConfig, 'onEvent' | 'onCall'>;

  private statePath: string | undefined;
  /** The file this keepalive last saw at `statePath`, or wrote there. */
  private fileSeen: string | null = null;
  /** Lineages already reported as `not-persisted`. */
  private readonly unsaved = new Set<string>();

  constructor(private readonly send: KeepaliveSend, config: CacheKeepaliveConfig = {}) {
    const { statePath, ...rest } = config;
    this.cfg = { ...DEFAULTS, ...rest };
    this.statePath = statePath;
    if (!this.cfg.enabled) this.stopped = true;
    if (this.statePath && !this.stopped) this.restore();
  }

  /** Take back up the lineages a previous process saved to `statePath`. */
  private restore(): void {
    this.fileSeen = fileIdentity(this.statePath!);
    let state: PersistedState;
    try {
      state = JSON.parse(readFileSync(this.statePath!, 'utf8')) as PersistedState;
    } catch (err) {
      // No file yet is the normal first start.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      this.emit({ type: 'persist-error', op: 'load', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (state?.version !== 1 || !Array.isArray(state.lineages)) {
      this.emit({ type: 'persist-error', op: 'load', error: 'unrecognized state file' });
      return;
    }
    const now = Date.now();
    const kept: Array<[string, Lineage]> = [];
    let malformed = 0;
    for (const saved of state.lineages) {
      try {
        const lineage = this.restoreOne(saved, now);
        if (lineage === 'malformed') malformed++;
        else if (lineage) kept.push(lineage);
      } catch {
        malformed++;
      }
    }
    if (malformed > 0) {
      this.emit({ type: 'persist-error', op: 'load', error: `${malformed} malformed lineage(s) left out` });
    }
    // The file lists the oldest first; keep the newest when maxLineages shrank.
    for (const [key, lineage] of kept.slice(-this.cfg.maxLineages)) {
      this.lineages.delete(key);
      this.lineages.set(key, lineage);
    }
    for (const [key, l] of this.lineages) {
      this.emit({ type: 'restored', key, lane: l.lane, idleMs: now - l.touchedAt });
    }
    this.persist();
    if (this.lineages.size > 0) {
      this.ensureTimer();
      // A restart can land late in an entry's hour: check at once, not one
      // checkIntervalMs from now, which could be past its expiry. Not inside
      // the constructor, though: whoever is building us isn't done yet.
      queueMicrotask(() => { void this.tick(); });
    }
  }

  /** One saved lineage, checked; null when it's valid but not worth keeping. */
  private restoreOne(saved: PersistedLineage, now: number): [string, Lineage] | null | 'malformed' {
    if (!saved || typeof saved !== 'object') return 'malformed';
    const { wire, headers, lane } = saved;
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return 'malformed';
    if (typeof lane !== 'string') return 'malformed';
    if (headers !== undefined && (typeof headers !== 'object' || headers === null
      || Object.values(headers).some((v) => typeof v !== 'string'))) return 'malformed';
    const lastRealAt = saved.lastRealAt;
    const touchedAt = saved.touchedAt;
    const ineffective = saved.ineffective ?? 0;
    if (![lastRealAt, touchedAt, ineffective].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return 'malformed';
    }
    if (!this.cfg.lanes.includes(lane)) return null;
    // The key is the wire's, not the file's word for it.
    const key = lineageKey(wire);
    const reason = ineligibleReason(wire);
    if (reason) {
      this.emit({ type: 'skipped', key, reason });
      return null;
    }
    // A clock that went back makes every age a guess: don't bet a write on it.
    if (touchedAt > now || lastRealAt > now) {
      this.emit({ type: 'skipped', key, reason: 'clock-went-back' });
      return null;
    }
    if (now - lastRealAt >= this.cfg.maxIdleMs) {
      this.emit({ type: 'expired', key, idleMs: now - lastRealAt });
      return null;
    }
    if (now - touchedAt >= ONE_HOUR_TTL_MS) {
      // The entry is gone: a replay would write the whole prefix.
      this.emit({ type: 'skipped', key, reason: 'cache-expired-while-stopped' });
      return null;
    }
    return [key, {
      wire, headers, lane, lastRealAt, touchedAt, refreshBaselineAt: touchedAt,
      ineffective: Math.max(0, Math.floor(ineffective)),
    }];
  }

  /** Write the tracked lineages to `statePath`, when one is set. */
  private persist(): void {
    if (!this.statePath || this.stopped) return;
    const path = this.statePath;
    const current = fileIdentity(path);
    if (current !== this.fileSeen) {
      // Another keepalive has written the file since we last did: it's the
      // newer process's now, and two writers would lose each other's lineages.
      this.statePath = undefined;
      this.emit({ type: 'persist-error', op: 'save', error: `${path} was written by another keepalive; no longer saving there` });
      return;
    }
    const lineages: PersistedLineage[] = [];
    for (const [key, l] of this.lineages) {
      const field = credentialField(l.wire);
      if (field) {
        if (!this.unsaved.has(key)) {
          this.unsaved.add(key);
          this.emit({ type: 'not-persisted', key, reason: `request holds ${field}` });
        }
        continue;
      }
      lineages.push({
        wire: l.wire,
        headers: persistableHeaders(l.headers),
        lane: l.lane,
        lastRealAt: l.lastRealAt,
        touchedAt: l.touchedAt,
        ineffective: l.ineffective,
      });
    }
    try {
      writeFileAtomic(path, JSON.stringify({ version: 1, lineages } satisfies PersistedState));
      this.fileSeen = fileIdentity(path);
    } catch (err) {
      this.emit({ type: 'persist-error', op: 'save', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Record a real request the provider is known to have begun answering, so
   *  it has processed the request's prefix. `sentAt` is when the request was
   *  sent, where the cache entry's clock starts: the lineage's touch counts
   *  from it, and its window from it or a later real call the lineage already
   *  has. Left out, both count from now. Call it once per call that gets that
   *  far. */
  record(
    wire: Record<string, unknown>,
    headers: Record<string, string> | undefined,
    lane: KeepaliveLane,
    sentAt: number = Date.now(),
  ): void {
    if (this.stopped) return;
    if (!this.cfg.lanes.includes(lane)) return;

    const reason = ineligibleReason(wire);
    const key = lineageKey(wire);
    if (reason) {
      if (this.lineages.delete(key)) {
        this.emit({ type: 'skipped', key, reason });
        this.persist();
      }
      return;
    }

    const existing = this.lineages.get(key);
    this.lineages.delete(key);
    this.lineages.set(key, {
      wire,
      headers,
      lane,
      lastRealAt: Math.max(sentAt, existing?.lastRealAt ?? sentAt),
      // The snapshot is this request's, so its entry's touch is this send's,
      // even when a later call on the lineage was recorded first.
      touchedAt: sentAt,
      refreshBaselineAt: sentAt,
      ineffective: existing?.ineffective ?? 0,
    });

    while (this.lineages.size > this.cfg.maxLineages) {
      const oldest = this.lineages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lineages.delete(oldest);
    }

    this.persist();
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
        if (now - lin.lastRealAt >= this.cfg.maxIdleMs) {
          this.lineages.delete(key);
          this.emit({ type: 'expired', key, idleMs: now - lin.lastRealAt });
          this.persist();
          continue;
        }
        if (now - lin.refreshBaselineAt < this.cfg.refreshAfterMs) continue;
        await this.refresh(key, lin);
        // Saved as each lineage changes, so a crash later in the tick keeps
        // it. After a stop() persist() does nothing: the file stays the state
        // the next process should take up, not the cleared one.
        this.persist();
      }
    } finally {
      this.ticking = false;
    }
  }

  private async refresh(key: string, lin: Lineage): Promise<void> {
    const startedAt = Date.now();
    const idleMs = startedAt - lin.refreshBaselineAt;
    let payload: Record<string, unknown> | undefined;
    try {
      // The JSON HTTP sends: callable fields serialize away, and toJSON values
      // are evaluated.
      const wire: unknown = JSON.parse(JSON.stringify(lin.wire));
      if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
        throw new Error('Keepalive request must serialize to a JSON object');
      }
      const recorded = wire as Record<string, unknown>;
      payload = { ...recorded, max_tokens: 0 };
      if (Array.isArray(recorded.messages)) payload.messages = messagesForRefresh(recorded.messages);
      delete payload.stream;
      const res = await this.send(payload, lin.headers);
      this.reportCall({
        key, lane: lin.lane, startedAt, durationMs: Date.now() - startedAt,
        request: payload, outcome: 'success', response: { ...res },
      });
      this.consecutiveErrors = 0;

      const read = res.usage?.cache_read_input_tokens ?? 0;
      const wrote = res.usage?.cache_creation_input_tokens ?? 0;

      if (read <= 0 || wrote > 0) {
        lin.ineffective += 1;
        this.emit({
          type: 'ineffective',
          key,
          reason: wrote > 0 ? 'wrote-instead-of-read' : 'no-cache-read',
          readTokens: read,
          writeTokens: wrote,
        });
        // A write made a new entry; a reply that neither read nor wrote says
        // nothing about the entry, so it isn't a touch.
        if (wrote > 0) lin.touchedAt = Math.max(lin.touchedAt, startedAt);
        if (lin.ineffective >= this.cfg.maxIneffective) {
          if (this.lineages.get(key) === lin) this.lineages.delete(key);
        } else {
          lin.refreshBaselineAt = startedAt;
        }
        return;
      }

      lin.ineffective = 0;
      lin.touchedAt = Math.max(lin.touchedAt, startedAt);
      lin.refreshBaselineAt = startedAt;
      this.emit({ type: 'refreshed', key, lane: lin.lane, readTokens: read, idleMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (payload) {
        this.reportCall({
          key, lane: lin.lane, startedAt, durationMs: Date.now() - startedAt,
          request: payload, outcome: 'error', error: err,
        });
      }
      this.consecutiveErrors += 1;
      this.emit({ type: 'error', key, error: message, consecutive: this.consecutiveErrors });

      // Paces the next try only: a failed refresh touched nothing, so the
      // saved last touch (touchedAt) stays where it was.
      lin.refreshBaselineAt = Date.now();

      if (this.consecutiveErrors >= this.cfg.maxConsecutiveErrors) {
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
      const receipt: KeepaliveCall = call.outcome === 'success'
        ? { ...call, request: structuredClone(call.request), response: structuredClone(call.response) }
        : { ...call, request: structuredClone(call.request) };
      void Promise.resolve(this.cfg.onCall(receipt)).catch(() => {
      });
    } catch {
    }
  }

  private emit(event: KeepaliveEvent): void {
    try {
      this.cfg.onEvent?.(event);
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

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lineages.clear();
  }
}
