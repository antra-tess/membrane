/**
 * Progress bounds for one streamed provider call: how long it may go without
 * content before its content begins, how long a thinking block may run, and
 * how long it may go without a provider event once content has begun. A
 * caller turns them on with `progressBounds` on `stream()` or
 * `streamYielding()`.
 */
export interface ProgressBounds {
  /** How long after the send a call may go without content, unless a thinking block's allowance runs longer. */
  beforeContentMs: number;
  /** How long a call whose content has begun may go without a provider event. */
  betweenEventsMs: number;
  /**
   * The slowest rate a thinking block is allowed: its allowance is the
   * output budget its request sends (`max_tokens`) at this many tokens a
   * second, rounded up to a whole second, from the block's start.
   */
  thinkTokensPerSecond: number;
}

/**
 * The bounds `progressBounds: true` takes. They were measured on a
 * production router's streamed Anthropic calls to `claude-opus-5-5` and
 * `claude-haiku-5-5`, and on no other provider, route or model; the README's
 * "Progress bounds" says what each costs there.
 */
export const PROGRESS_BOUNDS: Readonly<ProgressBounds> = Object.freeze({
  beforeContentMs: 60_000,
  betweenEventsMs: 150_000,
  thinkTokensPerSecond: 87,
});

/**
 * The bounds a `progressBounds` option asks for, or undefined for none:
 * `true` takes PROGRESS_BOUNDS, and an object takes them with any of its
 * three values in their place. Throws a TypeError for an option that isn't
 * a boolean or an object, and a TypeError or RangeError naming the field
 * for a value of the three that isn't a finite number above 0. Like the
 * retry config, it ignores a key it doesn't know.
 */
export function resolveProgressBounds(
  option: boolean | Partial<ProgressBounds> | undefined,
): ProgressBounds | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { ...PROGRESS_BOUNDS };
  if (typeof option !== 'object' || option === null) {
    throw new TypeError(`[membrane] progressBounds must be a boolean or an object of bounds, got ${option === null ? 'null' : typeof option}`);
  }
  const resolved: ProgressBounds = { ...PROGRESS_BOUNDS };
  for (const key of Object.keys(PROGRESS_BOUNDS) as (keyof ProgressBounds)[]) {
    const value: unknown = option[key];
    if (value === undefined) continue;
    if (typeof value !== 'number') {
      throw new TypeError(`[membrane] progressBounds.${key} must be a number, got ${value === null ? 'null' : typeof value}`);
    }
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`[membrane] progressBounds.${key} must be a finite number above 0, got ${value}`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/** When a call ends if nothing more arrives, and the bound that ends it then. */
export interface ProgressDue {
  at: number;
  bound: string;
}

/** One streamed call's progress under its bounds, from the send. */
export interface ProgressTracker {
  /**
   * A provider event at `at`: `'content'` for content, `'think'` for a
   * thinking block's start whose deltas aren't streamed as content, and
   * undefined for any other event.
   */
  seen(kind: 'content' | 'think' | undefined, at: number): void;
  due(): ProgressDue;
}

/**
 * Track one streamed call under `bounds`, sent at `sentAt` with an output
 * budget of `maxTokens`. Every time is in milliseconds on one monotonic
 * clock. A `maxTokens` that isn't a finite number above 0 gives a thinking
 * block no allowance.
 */
export function trackProgress(bounds: ProgressBounds, sentAt: number, maxTokens: number | undefined): ProgressTracker {
  const allowanceMs = maxTokens !== undefined && Number.isFinite(maxTokens)
    ? Math.ceil(maxTokens / bounds.thinkTokensPerSecond) * 1000
    : 0;
  const s = (ms: number): string => `${ms / 1000}s`;
  const allowanceText = (): string => `${s(allowanceMs)} of a thinking block's start (max_tokens ${maxTokens} at ${bounds.thinkTokensPerSecond} tokens a second)`;
  let contentSeen = false;
  let thinkEndsAt: number | undefined;
  let lastAt = sentAt;
  let lastWasThink = false;

  return {
    seen(kind, at) {
      lastAt = at;
      lastWasThink = kind === 'think';
      if (kind === 'content') contentSeen = true;
      else if (kind === 'think' && !contentSeen) thinkEndsAt = at + allowanceMs;
    },
    due() {
      if (!contentSeen) {
        const fromSend = sentAt + bounds.beforeContentMs;
        return thinkEndsAt !== undefined && thinkEndsAt > fromSend
          ? { at: thinkEndsAt, bound: `No content within ${allowanceText()}` }
          : { at: fromSend, bound: `No content within ${s(bounds.beforeContentMs)} of the send` };
      }
      return lastWasThink && allowanceMs > bounds.betweenEventsMs
        ? { at: lastAt + allowanceMs, bound: `No provider event within ${allowanceText()}` }
        : { at: lastAt + bounds.betweenEventsMs, bound: `No provider event within ${s(bounds.betweenEventsMs)}` };
    },
  };
}
