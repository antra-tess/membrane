/**
 * Membrane's retry decision, as plain functions with plain inputs, for every
 * layer that retries a provider call: membrane's core for the calls it
 * retries itself, and a caller that passes `retry: false` and retries its own
 * calls (agent-framework's turn policy and its storm hold, context-manager's
 * compression lane), each with its own settings. One decision means a call
 * path's classes, stated-wait rule and jitter are the same wherever it is
 * retried; only the numbers are each path's.
 *
 * It's the `@animalabs/membrane/retry` entry. It loads nothing of membrane at
 * run time but the default retry config's numbers (`types/config.ts`, which
 * imports types only), so taking it doesn't load a provider SDK.
 *
 * Three things are fixed here, not settings:
 * - the classes (classifyFailure);
 * - the stated-wait rule: a provider's stated wait (`retry-after`) only ever
 *   lengthens the backoff, and one past its schedule's ceiling isn't waited
 *   out but goes back to the caller (retryDecision);
 * - the jitter: equal jitter, a whole number of milliseconds in
 *   `[floor(d/2), d)` (a zero step waits 0), on the overloaded class only,
 *   since a capacity storm is where a fleet retrying in sync re-creates
 *   the stampede it's backing off from (delayFor).
 *
 * Attempts are counted as tries made so far: after a call's first send fails,
 * the attempt is 1, and the first retry waits the schedule's `firstDelayMs`.
 * A caller counting from 0 passes its count plus one.
 */

import { DEFAULT_RETRY_CONFIG, type RetryConfig } from './types/config.js';

/**
 * What a failed call is, for its retry:
 * - `deadline`: a deadline ran out on a request already sent, a call's own
 *   budget spent;
 * - `final`: not retryable;
 * - `overloaded`: a provider capacity error (a 529, or an overloaded error
 *   with no status);
 * - `rate_limited`: a rate limit;
 * - `retryable`: any other retryable failure (a 5xx, a 408, a connection
 *   failure).
 */
export type RetryClass = 'overloaded' | 'rate_limited' | 'retryable' | 'deadline' | 'final';

/** The facts classifyFailure reads, as membrane's ErrorInfo carries them. */
export interface FailureFacts {
  /** Whether the failure may be retried at all. */
  retryable: boolean;
  /** Membrane's error type, such as `'rate_limit'` or `'server'`. */
  type?: string;
  /** The HTTP status, when the failure had one. */
  httpStatus?: number;
  /** The failure's message, read for an overloaded error with no status. */
  message?: string;
  /** Whether a deadline ran out on a request already sent. */
  deadline?: boolean;
}

/**
 * One class's schedule. `attempt` counts the tries made so far, the first
 * send included, so the first retry is after attempt 1. Its un-jittered step
 * after `attempt` tries is `min(firstDelayMs × multiplier^(attempt − 1),
 * maxDelayMs)`, a zero `firstDelayMs` staying zero; delayFor and
 * retryDecision say how the wait is drawn from it.
 */
export interface RetrySchedule {
  /** The most tries in all, the first send included; `null` for no bound. */
  maxAttempts: number | null;
  firstDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  /** The longest stated wait waited out; `null` to wait out any finite one,
   *  however long. */
  statedWaitCeilingMs: number | null;
}

/** A call path's schedules. A class with none isn't retried, except
 *  `overloaded`, which then takes the `retryable` schedule, unjittered. */
export type RetrySettings = Partial<Record<RetryClass, RetrySchedule>>;

export type RetryDecision =
  | { retry: true; delayMs: number }
  /** `statedWaitMs`, when the stated wait was past its schedule's ceiling, or
   *  was Infinity, which nobody can wait out. */
  | { retry: false; statedWaitMs?: number };

/** A status-shaped 529, or Anthropic's overloaded error type, in a message. */
const OVERLOADED_PATTERN = /\b529\b|overloaded_error/i;

/**
 * The Anthropic SDK's own client (0.52's `retryRequest`) waits out a stated
 * wait only when it's under a minute.
 */
const STATED_WAIT_CEILING_MS = 60_000;

/**
 * An overloaded error that arrives mid-stream, after the 200, has no status,
 * so a failure with none is read by its message.
 */
function isOverloadedFailure(facts: Pick<FailureFacts, 'httpStatus' | 'message'>): boolean {
  if (facts.httpStatus !== undefined) return facts.httpStatus === 529;
  return OVERLOADED_PATTERN.test(facts.message ?? '');
}

/**
 * The class of a failure. A deadline that ran out on a sent request comes
 * first, whatever else is said of it; then a failure that isn't retryable;
 * then an overloaded error, then a rate limit, then any other retryable
 * failure.
 */
export function classifyFailure(facts: FailureFacts): RetryClass {
  if (facts.deadline === true) return 'deadline';
  if (!facts.retryable) return 'final';
  if (isOverloadedFailure(facts)) return 'overloaded';
  if (facts.type === 'rate_limit') return 'rate_limited';
  return 'retryable';
}

/** The schedule a class is retried on, and whether its delays are jittered:
 *  an overloaded failure whose settings have no overloaded schedule takes the
 *  retryable schedule, with no jitter. */
function scheduleFor(cls: RetryClass, settings: RetrySettings): { schedule?: RetrySchedule; jitter: boolean } {
  if (cls === 'overloaded') {
    return settings.overloaded
      ? { schedule: settings.overloaded, jitter: true }
      : { schedule: settings.retryable, jitter: false };
  }
  return { schedule: settings[cls], jitter: false };
}

/** Whether `attempt` is a count of tries: a whole number of at least 1. */
function isAttempt(attempt: number): boolean {
  return Number.isInteger(attempt) && attempt >= 1;
}

/** A zero first delay stays zero: times a power that overflowed to Infinity
 *  it would be NaN. */
function stepOf(schedule: RetrySchedule, attempt: number): number {
  return schedule.firstDelayMs === 0
    ? 0
    : Math.min(schedule.firstDelayMs * Math.pow(schedule.multiplier, attempt - 1), schedule.maxDelayMs);
}

/** A step's wait: on the overloaded class a whole number of milliseconds in
 *  `[floor(step/2), step)` (a zero step waits 0), drawn with `random`; on any
 *  other, the step itself. */
function waitOf(stepMs: number, jitter: boolean, random: () => number): number {
  return jitter ? Math.floor(stepMs / 2 + random() * (stepMs / 2)) : stepMs;
}

/**
 * How long to wait before a retry after `attempt` tries, with no stated wait:
 * `nominalMs` is the schedule's un-jittered step, and `delayMs` the wait, the
 * same as `nominalMs` but on the overloaded class with its own schedule,
 * where it's a whole number of milliseconds in `[floor(nominalMs/2),
 * nominalMs)` drawn with `random` (Math.random by default), or 0 for a zero
 * step. An overloaded failure with no overloaded schedule takes the
 * `retryable` one, unjittered.
 * It answers "how long" alone, not "whether". It throws for a class with no
 * schedule, an attempt that isn't a whole number of at least 1, or a schedule
 * whose numbers give no finite step.
 *
 * A wait can be longer than one setTimeout holds (2^31 − 1 ms, about 24.8
 * days), wherever a schedule's maxDelayMs is: Node and Bun run such a timer
 * at once, so a caller that sleeps `delayMs` with a single setTimeout retries
 * at once. Sleep it in chunks.
 */
export function delayFor(
  cls: RetryClass,
  attempt: number,
  settings: RetrySettings,
  random: () => number = Math.random,
): { delayMs: number; nominalMs: number } {
  const { schedule, jitter } = scheduleFor(cls, settings);
  if (!schedule) throw new RangeError(`[membrane] no retry schedule for the ${cls} class`);
  if (!isAttempt(attempt)) throw new RangeError(`[membrane] a retry's attempt is a count of tries from 1, not ${attempt}`);
  const nominalMs = stepOf(schedule, attempt);
  if (!Number.isFinite(nominalMs)) throw new RangeError(`[membrane] the ${cls} schedule's numbers give no finite wait at attempt ${attempt}`);
  return { delayMs: waitOf(nominalMs, jitter, random), nominalMs };
}

/**
 * Whether a call that failed in class `cls`, after `attempt` tries, is sent
 * again, and after how long. An overloaded failure with no overloaded
 * schedule is retried on the `retryable` schedule, unjittered. Not when its
 * class has no schedule, when its attempts are spent, or when the provider's
 * stated wait is past its schedule's ceiling or is Infinity: then the stated
 * wait goes back as `statedWaitMs`, for the caller to wait out or to end on.
 * Otherwise the wait is the backoff, or the stated wait where that's longer:
 * a stated wait never shortens the backoff, even where a schedule's
 * maxDelayMs is past its ceiling. A stated wait is read as a number, so a
 * numeric string counts as its number; one that reads as NaN counts as none.
 * A zero or negative one loses to the backoff.
 *
 * It fails closed: an attempt that isn't a whole number of at least 1, and a
 * wait that isn't a finite number (from a schedule's numbers), end the
 * retries.
 *
 * Under a `null` ceiling a stated wait can be longer than one setTimeout
 * holds (2^31 − 1 ms, about 24.8 days), and so can a schedule's maxDelayMs:
 * Node and Bun run such a timer at once, so a caller that sleeps `delayMs`
 * with a single setTimeout retries at once. Sleep it in chunks.
 */
export function retryDecision(
  cls: RetryClass,
  attempt: number,
  statedWaitMs: number | undefined,
  settings: RetrySettings,
  random: () => number = Math.random,
): RetryDecision {
  const { schedule, jitter } = scheduleFor(cls, settings);
  if (!schedule) return { retry: false };
  if (!isAttempt(attempt)) return { retry: false };
  // A bound that compares false with every count ends the retries rather than
  // letting them run on.
  if (schedule.maxAttempts !== null && !(attempt < schedule.maxAttempts)) return { retry: false };
  // Number(undefined) is NaN, so no stated wait reads as none.
  const read = Number(statedWaitMs);
  const stated = Number.isNaN(read) ? undefined : read;
  const ceiling = schedule.statedWaitCeilingMs;
  if (stated !== undefined && (stated === Infinity || (ceiling !== null && stated > ceiling))) {
    return { retry: false, statedWaitMs: stated };
  }
  const backoffMs = waitOf(stepOf(schedule, attempt), jitter, random);
  const delayMs = stated === undefined ? backoffMs : Math.max(backoffMs, stated);
  if (!Number.isFinite(delayMs)) return { retry: false };
  return { retry: true, delayMs };
}

/**
 * Membrane's own settings for a retry config, as its core retries a call:
 * - `retryable`: `maxRetries` attempts on the base schedule;
 * - `rate_limited`: the base schedule, with at least 5 attempts, so a
 *   transient rate limit doesn't end a call whatever `maxRetries` says;
 * - `overloaded`: the overloaded schedule, with the larger of the two
 *   attempt counts, or none when `overloaded.maxRetries` is 0, so a 529 is
 *   then retried as any other retryable failure;
 * - `deadline` and `final`: none.
 * A schedule's stated-wait ceiling is a minute, or its maxDelayMs where
 * that's longer. It takes a complete RetryConfig; it fills and checks nothing
 * itself.
 */
export function membraneRetrySettings(config: RetryConfig): RetrySettings {
  const base = {
    firstDelayMs: config.retryDelayMs,
    multiplier: config.backoffMultiplier,
    maxDelayMs: config.maxRetryDelayMs,
    statedWaitCeilingMs: Math.max(STATED_WAIT_CEILING_MS, config.maxRetryDelayMs),
  };
  const overloaded = config.overloaded;
  return {
    retryable: { ...base, maxAttempts: config.maxRetries },
    rate_limited: { ...base, maxAttempts: Math.max(config.maxRetries, 5) },
    ...(overloaded.maxRetries > 0
      ? {
          overloaded: {
            maxAttempts: Math.max(config.maxRetries, overloaded.maxRetries),
            firstDelayMs: overloaded.retryDelayMs,
            multiplier: overloaded.backoffMultiplier,
            maxDelayMs: overloaded.maxRetryDelayMs,
            statedWaitCeilingMs: Math.max(STATED_WAIT_CEILING_MS, overloaded.maxRetryDelayMs),
          },
        }
      : {}),
  };
}

/** Membrane's settings for its default retry config (DEFAULT_RETRY_CONFIG).
 *  Frozen, schedules and all: to change it, spread it and replace whole
 *  schedules, since a schedule's own numbers can't be edited in place. */
export const MEMBRANE_RETRY_SETTINGS: { readonly [K in RetryClass]?: Readonly<RetrySchedule> } = Object.freeze(
  Object.fromEntries(
    Object.entries(membraneRetrySettings(DEFAULT_RETRY_CONFIG)).map(([cls, schedule]) => [cls, Object.freeze(schedule)]),
  ) as RetrySettings,
);
