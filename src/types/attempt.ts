/**
 * The attempt record: one per provider attempt, given to
 * `MembraneConfig.onAttempt` as the attempt settles.
 */

import type { MembraneErrorType } from './errors.js';
import type { StopReason } from './response.js';

/**
 * What a call is for, as its caller says with the `purpose` option. Membrane
 * reads nothing into it: it carries it onto each attempt record the call
 * makes, so an observer can count turns and compression apart. A call that
 * sets none is anything else.
 */
export type CallPurpose = 'turn' | 'compression';

/**
 * Token counts of an attempt that returned a response, normalized as membrane
 * normalizes usage everywhere (cache reads and writes outside `inputTokens`).
 * A count the provider didn't report is left out.
 */
export interface AttemptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** How an attempt that failed failed, from the error membrane typed it as. */
export interface AttemptError {
  /** The error's `MembraneError.type`. */
  type: MembraneErrorType;
  httpStatus?: number;
  providerErrorCode?: string;
  /** The call's signal was aborted: the caller cancelled. */
  cancelled: boolean;
  /**
   * A deadline ended it: membrane's progress deadline, the adapter's
   * `timeoutMs`, or a deadline on a request already sent (an adapter's
   * watchdog, a timeout its SDK reports, a runtime's fetch timeout).
   */
  deadline: boolean;
  /** For an HTTP 400: the id of the template its message matches (BAD_REQUEST_TEMPLATES). */
  template?: string;
  /**
   * For an HTTP 400 whose message opens with a field path: that path, with
   * each numeric segment as `N`, when every other segment is a field name
   * from REQUEST_FIELD_NAMES. Left out otherwise.
   */
  fieldPath?: string;
}

/**
 * How an attempt ended: with the provider's response, or with an error.
 */
export type AttemptEnding =
  | {
      /**
       * Membrane's stop reason for the provider's own stop, before a local
       * stop sequence or the XML loop's parser cuts the round.
       */
      stopReason: StopReason;
      /**
       * The provider's own token, as the round's `details.stop.providerReason`
       * carries it: the adapter's `providerStopReason`, or else a stop reason
       * membrane doesn't map. A token outside StopReason is a stop membrane
       * reads as `end_turn`.
       */
      providerStopReason?: string;
      /** With a `refusal`: the provider's category, when it named one (ProviderResponse.refusalCategory). */
      refusalCategory?: string;
    }
  | { error: AttemptError };

/**
 * One provider attempt: one request membrane had its adapter send, whether a
 * call's first send, a retry after a failure, or a refusal re-issue. An
 * attempt is recorded once its adapter has reported its request through
 * `ProviderRequestOptions.onRequest`, which every built-in adapter does
 * before sending; one that fails before that, or an adapter that never
 * reports one, gives no record. What an adapter does after reporting its
 * request is the attempt's: a credential resolver's refresh before the send,
 * whose failure ends the attempt, and its resend after an HTTP 401, which
 * reports no request of its own, so the attempt's times then include the
 * refused send and the refresh.
 *
 * Times after `sentAt` are milliseconds from it on the monotonic clock,
 * rounded. An event is a call to `ProviderRequestOptions.onProgress`: one per
 * parsed provider event, never a keepalive.
 */
export interface AttemptRecord {
  /** The call's `purpose` option, when it set one. */
  purpose?: CallPurpose;
  /** The call's `requestId` option, when it set one. */
  callerRequestId?: string;
  /**
   * The adapter method membrane called. A `complete()` attempt usually
   * reports no events, since its answer arrives whole.
   */
  method: 'complete' | 'stream';
  /** The call's round, from 0: each tool round or resumption is a new one. `complete()` has one. */
  round: number;
  /**
   * Earlier tries of this round's request in this call, from 0, a try being
   * membrane's call to its adapter: retries after a failure and refusal
   * re-issues alike. A try that failed before its adapter reported its
   * request has no record, so the numbers can skip one.
   */
  attempt: number;
  /** The adapter's `name`. */
  provider: string;
  /** The model membrane asked the adapter for. */
  model: string;
  /** When the adapter reported its request, as epoch milliseconds. */
  sentAt: number;
  /**
   * Whether the adapter said, as it sent this request, that it reports
   * content (`SendReport.reportsContent`). Without it, a missing
   * `firstContentMs` means "not reported", not "none arrived".
   */
  reportsContent: boolean;
  /** The first event. */
  firstEventMs?: number;
  /** The first event reported as `'content'` (see ProgressSeen). */
  firstContentMs?: number;
  /** The longest gap between two consecutive events. */
  maxGapMs?: number;
  /** The longest gap between two consecutive events that began at or after first content. */
  maxGapAfterContentMs?: number;
  /** The last event. */
  lastEventMs?: number;
  /** When the adapter's call settled, with its response or its error. */
  endMs: number;
  /**
   * The output-token limit the request asked for, as its adapter reported it
   * (`SendReport.maxTokens`). Absent when the adapter reported none, as only
   * AnthropicAdapter and BedrockAdapter of the built-in adapters do.
   */
  maxTokens?: number;
  /** With a response: its usage. */
  usage?: AttemptUsage;
  ending: AttemptEnding;
}
