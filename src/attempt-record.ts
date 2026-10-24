/**
 * The attempt record's observation: one AttemptObserver per provider attempt,
 * made by Membrane core only when `MembraneConfig.onAttempt` is set.
 */

import type { AttemptEnding, AttemptError, AttemptRecord, AttemptUsage, CallPurpose } from './types/attempt.js';
import type { ProgressSeen, ProviderResponse, SendReport } from './types/provider.js';
import type { StopReason } from './types/response.js';
import { isDeadlineExpiry, isTimeoutAbortError, errorFromThrown } from './types/errors.js';
import { classifyBadRequest, providerMessageOf } from './utils/bad-request.js';

/** What the call says about the attempt before it's sent. */
export interface AttemptContext {
  purpose?: CallPurpose;
  callerRequestId?: string;
  method: 'complete' | 'stream';
  round: number;
  attempt: number;
  provider: string;
  model: string;
}

/** A purpose option as the record carries it: one of CallPurpose, or none. */
export function purposeOf(value: unknown): CallPurpose | undefined {
  return value === 'turn' || value === 'compression' ? value : undefined;
}

/** A requestId option as the record carries it: a non-empty string, or none. */
export function callerRequestIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const nonNegativeCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Times one attempt from the moment its adapter reported its request, and
 * assembles its record when the adapter's call settles. Its methods sit in an
 * adapter's callbacks, so each takes whatever arrives: an event before the
 * send has no origin and isn't counted, and a send report that isn't an
 * object is ignored. The record is built once, at `settle`, and nothing
 * changes it after.
 */
export class AttemptObserver {
  private sentAt?: number;
  private sentMono?: number;
  private endMono?: number;
  private firstEvent?: number;
  private firstContent?: number;
  private lastEvent?: number;
  private maxGap?: number;
  private maxGapAfterContent?: number;
  private maxTokens?: number;
  private reportsContent = false;

  constructor(private readonly context: AttemptContext) {}

  /** The adapter's request went out (its onRequest returned). The first report counts. */
  sent(): void {
    if (this.sentMono !== undefined) return;
    this.sentAt = Date.now();
    this.sentMono = performance.now();
  }

  /** What the adapter reported as it sent (onSend). */
  send(report: SendReport | undefined): void {
    if (report === null || typeof report !== 'object') return;
    const maxTokens = nonNegativeCount(report.maxTokens);
    if (maxTokens !== undefined) this.maxTokens = maxTokens;
    if (report.reportsContent === true) this.reportsContent = true;
  }

  /** The adapter's call settled: the attempt's end. The first call counts. */
  ended(): void {
    if (this.endMono === undefined) this.endMono = performance.now();
  }

  /** A parsed provider event (onProgress), with what it was when the adapter says. */
  event(seen?: ProgressSeen): void {
    if (this.sentMono === undefined) return;
    const at = performance.now() - this.sentMono;
    if (this.lastEvent !== undefined) {
      const gap = at - this.lastEvent;
      this.maxGap = Math.max(this.maxGap ?? 0, gap);
      // A gap after content begins at or after the first content event.
      if (this.firstContent !== undefined) {
        this.maxGapAfterContent = Math.max(this.maxGapAfterContent ?? 0, gap);
      }
    }
    if (this.firstEvent === undefined) this.firstEvent = at;
    if (seen === 'content' && this.firstContent === undefined) this.firstContent = at;
    this.lastEvent = at;
  }

  /**
   * The attempt's record, once the adapter's call has settled, or nothing
   * when the adapter never reported its request.
   */
  settle(
    outcome:
      | {
          stopReason: StopReason;
          refusalCategory?: string;
          usage: ProviderResponse['usage'];
          unreportedUsage?: ProviderResponse['unreportedUsage'];
        }
      | { error: unknown; cancelled: boolean },
  ): AttemptRecord | undefined {
    this.ended();
    if (this.sentAt === undefined || this.sentMono === undefined) return undefined;
    const endMs = Math.round(this.endMono! - this.sentMono);
    const timing: Partial<AttemptRecord> = {};
    if (this.firstEvent !== undefined) timing.firstEventMs = Math.round(this.firstEvent);
    if (this.firstContent !== undefined) timing.firstContentMs = Math.round(this.firstContent);
    if (this.maxGap !== undefined) timing.maxGapMs = Math.round(this.maxGap);
    if (this.maxGapAfterContent !== undefined) timing.maxGapAfterContentMs = Math.round(this.maxGapAfterContent);
    if (this.lastEvent !== undefined) timing.lastEventMs = Math.round(this.lastEvent);

    let ending: AttemptEnding;
    let usage: AttemptUsage | undefined;
    if ('stopReason' in outcome) {
      ending = {
        stopReason: outcome.stopReason,
        ...(outcome.refusalCategory !== undefined ? { refusalCategory: outcome.refusalCategory } : {}),
      };
      usage = usageOf(outcome.usage, outcome.unreportedUsage);
    } else {
      ending = { error: errorOf(outcome.error, outcome.cancelled) };
    }

    return {
      ...(this.context.purpose !== undefined ? { purpose: this.context.purpose } : {}),
      ...(this.context.callerRequestId !== undefined ? { callerRequestId: this.context.callerRequestId } : {}),
      method: this.context.method,
      round: this.context.round,
      attempt: this.context.attempt,
      provider: this.context.provider,
      model: this.context.model,
      sentAt: this.sentAt,
      reportsContent: this.reportsContent,
      ...timing,
      endMs,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(usage ? { usage } : {}),
      ending,
    };
  }
}

/** The usage's counts, as a round report keeps them: each that's a number, leaving out what the provider didn't report. */
function usageOf(usage: ProviderResponse['usage'], unreported: ProviderResponse['unreportedUsage']): AttemptUsage {
  const counts: AttemptUsage = {};
  for (const field of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const) {
    const value = usage[field];
    if (typeof value === 'number' && !(unreported as readonly string[] | undefined)?.includes(field)) counts[field] = value;
  }
  return counts;
}

function errorOf(error: unknown, cancelled: boolean): AttemptError {
  // Typed as the call goes on to type it, without marking the error itself:
  // a MembraneError comes back as it is, and anything else as a new one.
  const typed = errorFromThrown(error);
  const badRequest = typed.httpStatus === 400
    ? classifyBadRequest(providerMessageOf(typed.rawError) ?? '')
    : {};
  return {
    type: typed.type,
    ...(typed.httpStatus !== undefined ? { httpStatus: typed.httpStatus } : {}),
    ...(typed.providerErrorCode !== undefined ? { providerErrorCode: typed.providerErrorCode } : {}),
    cancelled,
    deadline: isTimeoutAbortError(typed) || isDeadlineExpiry(typed),
    ...badRequest,
  };
}
