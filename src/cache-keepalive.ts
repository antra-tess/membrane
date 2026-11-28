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
import { isEffortOnlyMessage } from './utils/empty-text.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
   * Each change to them is written there (atomically, mode 0600 where the
   * platform has POSIX modes; on Windows the directory's ACL decides who can
   * read it), and a new keepalive given the same path takes them back up and
   * refreshes them when they're due, as the old process would have. A lineage
   * is restored only when its lane is one of `lanes`, its request is still
   * eligible, the clock hasn't gone back, its last real request is less than
   * `maxIdleMs` old (the keepalive stops refreshing at that age whether or not
   * it restarted), and its cache entry was touched less than an hour ago (an
   * older entry is gone, and a replay would pay a write); each one left out
   * gets a `skipped` or `expired` event. The file holds full wire requests
   * (the conversation), so it belongs with the agent's other private data.
   * Only the `anthropic-beta` and `anthropic-version` headers are saved, and a
   * request with what looks like a credential is kept in memory only
   * (`not-persisted`): outside the conversation, any field with a
   * credential-like name, in any case or spelling (`api_key`, `apiKey`,
   * `authorization_token`), and any URL with a password or a credential-like
   * query parameter; inside it (`system`, `tools`, `messages`), a string under
   * a credential-like name, such as a tool call's `api_key` input. Secrets in
   * free text aren't detected. One keepalive per file: a keepalive takes the
   * file when it starts, and the one that had it stops saving there
   * (`persist-error`) at its next save. Unset: in memory only.
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

/** A field name that looks like a credential, whatever its case or
 *  separators: `api_key`, `apiKey`, `x-api-key`, `accessToken`,
 *  `authorization_token`, `client-secret`. `max_tokens` and the like don't. */
const CREDENTIAL_NAME = /(token|secret|password|passwd|passphrase|apikey|authorization|credentials?|privatekey|accesskey|sessionkey|cookie)$/;
function credentialName(key: string): boolean {
  return CREDENTIAL_NAME.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** A URL with a password in it, or a credential-like query parameter. */
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@|[?&#;](?:[a-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|sig|signature|credential)[a-z0-9_.-]*)=[^&#\s]/i;

/** Deeper than this, a request isn't checked, and so isn't saved. */
const MAX_SCAN_DEPTH = 64;

/**
 * The path of the first part of a request that looks like it holds a
 * credential, or null. Outside the conversation (`request.extra` reaches the
 * wire as top-level fields, `mcp_servers[].authorization_token` and
 * `mcp_servers[].url` among them): any non-empty field with a credential-like
 * name, and any string that is a URL with a password or a credential-like
 * query parameter. Inside it (`system`, `tools`, `messages`), where tool
 * schemas name properties `password` and conversations quote URLs: a
 * non-empty string under a credential-like name, such as a tool call's
 * `api_key` input. Give it the request as JSON sends it (a `toJSON` value
 * already evaluated): what's checked is then what would be written.
 */
export function credentialField(wire: Record<string, unknown>): string | null {
  const walk = (value: unknown, path: string, depth: number, conversation: boolean): string | null => {
    if (typeof value === 'string') return !conversation && CREDENTIAL_URL.test(value) ? path : null;
    if (value === null || typeof value !== 'object') return null;
    if (depth > MAX_SCAN_DEPTH) return `${path} (nested too deep to check)`;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`;
      if (!Array.isArray(value) && credentialName(k)) {
        if (conversation ? typeof v === 'string' && v !== '' : v !== undefined && v !== null && v !== '') return here;
      }
      const found = walk(v, here, depth + 1, conversation);
      if (found) return found;
    }
    return null;
  };
  for (const [k, v] of Object.entries(wire)) {
    const conversation = k === 'system' || k === 'tools' || k === 'messages';
    if (!conversation && credentialName(k) && v !== undefined && v !== null && v !== '') return k;
    const found = walk(v, k, 0, conversation);
    if (found) return found;
  }
  return null;
}

/** Temp files writeFileAtomic makes for `path`. */
function isTempOf(path: string, name: string): boolean {
  const base = basename(path);
  return name.startsWith(`${base}.`) && /^\.[0-9a-f]{12}\.tmp$/.test(name.slice(base.length));
}

/** Write `data` to `path` atomically: a new private temp file (O_EXCL, so
 *  never through a planted link), written in full and flushed, then renamed
 *  over `path`. Returns the identity of the file it wrote, taken from the
 *  file it wrote, not from whatever `path` names after the rename. */
function writeFileAtomic(path: string, data: string): string {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  let identity: string;
  try {
    try {
      const bytes = Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        // A short write is carried on from where it stopped; none at all is a failure.
        if (n <= 0) throw new Error(`write to ${tmp} made no progress`);
        offset += n;
      }
      fsyncSync(fd);
      const st = fstatSync(fd);
      identity = `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`;
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
  return identity;
}

/** Identity of the file now at `path` (each atomic write is a new inode), or
 *  null when there is none. Any other failure to look is thrown: it isn't
 *  evidence that the file is gone. */
function fileIdentity(path: string): string | null {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  return `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const LOCK_TRIES = 40;
const LOCK_WAIT_MS = 5;

/**
 * Run `fn` holding `path`.lock, so checking who has the file and writing it
 * is one step against another process doing the same. The lock is held only
 * for that synchronous step, so one left by a process that died, or by this
 * one, is stale; a live holder is waited for briefly. Null when it stayed
 * held.
 */
function withFileLock<T>(path: string, fn: () => T): { value: T } | null {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      let holder = NaN;
      try { holder = Number(readFileSync(lock, 'utf8')); } catch { /* gone, or being written */ }
      if (holder === process.pid || (Number.isInteger(holder) && holder > 0 && !pidAlive(holder))) {
        try { unlinkSync(lock); } catch { /* another process took it away first */ }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    try {
      return { value: fn() };
    } finally {
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }
  return null;
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
  /** The request as it would be saved (JSON text), and what's wrong with
   *  saving it, worked out once per recorded request. */
  saved?: { json: string; credential: string | null };
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
  while (end + 1 < messages.length && (isUser(messages[end + 1]) || isEffortOnlyMessage(messages[end + 1]))) end++;
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

  /** Take back up the lineages a previous process saved to `statePath`, and
   *  take the file: reading it and writing it back is one step under the
   *  file's lock, so of two keepalives starting together the later one has
   *  it, and the other stops saving there at its next save. */
  private restore(): void {
    const path = this.statePath!;
    let held: { value: void } | null;
    try {
      held = withFileLock(path, () => {
        this.removeStaleTemps(path);
        this.fileSeen = fileIdentity(path);
        // A file it can't read is left as it is until the first save, as before.
        if (this.load(path)) this.writeState(path);
      });
    } catch (err) {
      this.emit({ type: 'persist-error', op: 'load', error: err instanceof Error ? err.message : String(err) });
      this.statePath = undefined;
      return;
    }
    if (!held) {
      this.emit({ type: 'persist-error', op: 'load', error: `${path}.lock stayed held; not saving there` });
      this.statePath = undefined;
      return;
    }
    if (this.lineages.size > 0) {
      this.ensureTimer();
      // A restart can land late in an entry's hour: check at once, not one
      // checkIntervalMs from now, which could be past its expiry. Not inside
      // the constructor, though: whoever is building us isn't done yet.
      queueMicrotask(() => { void this.tick(); });
    }
  }

  /** Temp files a process that died mid-write left beside `path`: each can
   *  hold a whole conversation. */
  private removeStaleTemps(path: string): void {
    let names: string[];
    try { names = readdirSync(dirname(path)); } catch { return; }
    for (const name of names) {
      if (!isTempOf(path, name)) continue;
      try { unlinkSync(join(dirname(path), name)); } catch { /* gone, or not ours to remove */ }
    }
  }

  /** The saved lineages, checked, into `lineages`. False when the file
   *  couldn't be read as a state file at all. */
  private load(path: string): boolean {
    let state: PersistedState;
    try {
      state = JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
    } catch (err) {
      // No file yet is the normal first start.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
      this.emit({ type: 'persist-error', op: 'load', error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    if (state?.version !== 1 || !Array.isArray(state.lineages)) {
      this.emit({ type: 'persist-error', op: 'load', error: 'unrecognized state file' });
      return false;
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
    // The file lists the oldest first; keep the newest when maxLineages shrank
    // (slice(-0) would keep them all).
    for (const [key, lineage] of kept.slice(Math.max(0, kept.length - this.cfg.maxLineages))) {
      this.lineages.delete(key);
      this.lineages.set(key, lineage);
    }
    for (const [key, l] of this.lineages) {
      this.emit({ type: 'restored', key, lane: l.lane, idleMs: now - l.touchedAt });
    }
    return true;
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
    // The key is the wire's, not the file's word for it.
    const key = lineageKey(wire);
    if (!this.cfg.lanes.includes(lane)) {
      this.emit({ type: 'skipped', key, reason: `lane-not-kept:${lane}` });
      return null;
    }
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

  /** Write the tracked lineages to `statePath`, when one is set: checking
   *  that the file is still the one this keepalive last wrote, and writing
   *  it, under the file's lock. */
  private persist(): void {
    if (!this.statePath || this.stopped) return;
    const path = this.statePath;
    let held: { value: boolean } | null;
    try {
      held = withFileLock(path, () => {
        if (fileIdentity(path) !== this.fileSeen) return false;
        this.writeState(path);
        return true;
      });
    } catch (err) {
      this.emit({ type: 'persist-error', op: 'save', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Held by a live writer all along: this change waits for the next save.
    if (!held) return;
    if (!held.value) {
      // Another keepalive has taken the file since we last wrote it: it's the
      // newer process's now, and two writers would lose each other's lineages.
      this.statePath = undefined;
      this.emit({ type: 'persist-error', op: 'save', error: `${path} was written by another keepalive; no longer saving there` });
    }
  }

  /** The state file's text, and the write of it. Each lineage's request is
   *  serialized and checked once per recorded request, as JSON sends it. */
  private writeState(path: string): void {
    const parts: string[] = [];
    for (const [key, l] of this.lineages) {
      if (!l.saved) {
        const json = JSON.stringify(l.wire);
        const value: unknown = json === undefined ? undefined : JSON.parse(json);
        const credential = value && typeof value === 'object' && !Array.isArray(value)
          ? credentialField(value as Record<string, unknown>)
          : 'request (not a JSON object)';
        l.saved = { json: json ?? 'null', credential };
      }
      if (l.saved.credential) {
        if (!this.unsaved.has(key)) {
          this.unsaved.add(key);
          this.emit({ type: 'not-persisted', key, reason: `request holds ${l.saved.credential}` });
        }
        continue;
      }
      const headers = persistableHeaders(l.headers);
      parts.push(`{"wire":${l.saved.json}${headers ? `,"headers":${JSON.stringify(headers)}` : ''}`
        + `,"lane":${JSON.stringify(l.lane)},"lastRealAt":${l.lastRealAt},"touchedAt":${l.touchedAt}`
        + `,"ineffective":${l.ineffective}}`);
    }
    // A lineage that left isn't held back any more: forget it.
    for (const key of this.unsaved) if (!this.lineages.has(key)) this.unsaved.delete(key);
    this.fileSeen = writeFileAtomic(path, `{"version":1,"lineages":[${parts.join(',')}]}`);
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

  /** The file the keepalive is saving to: `statePath`, until another
   *  keepalive takes it over or the keepalive is disabled. A host can also
   *  test `'persistPath' in CacheKeepalive.prototype` to tell whether this
   *  membrane supports `statePath` at all. */
  get persistPath(): string | undefined {
    if (this.stopped || !this.statePath) return undefined;
    // Taken over by another keepalive, which this one learns at its next
    // save: say so now.
    try {
      if (fileIdentity(this.statePath) !== this.fileSeen) return undefined;
    } catch {
      return undefined;
    }
    return this.statePath;
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
