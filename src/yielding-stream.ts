/**
 * YieldingStream implementation
 *
 * Provides an async iterator interface for streaming inference that yields
 * control back to the caller for tool execution.
 */

import type {
  StreamEvent,
  YieldingStream,
  YieldingStreamOptions,
  ToolCallsEvent,
  InjectedMessage,
  ProvideToolResultsOptions,
} from './types/yielding-stream.js';
import type { ToolResult } from './types/tools.js';

/**
 * Payload handed from provideToolResults() to the inference loop awaiting
 * requestToolExecution(): the round's tool results plus any mid-turn
 * messages the consumer wants the next inference round to see.
 */
export interface ToolResultsPayload {
  results: ToolResult[];
  injectedMessages?: InjectedMessage[];
}

// ============================================================================
// Internal State Types
// ============================================================================

type StreamState =
  | { status: 'idle' }
  | { status: 'streaming' }
  | { status: 'waiting_for_tools'; pendingCallIds: string[] }
  | { status: 'done' }
  | { status: 'error'; error: Error };

interface PendingToolResults {
  resolve: (payload: ToolResultsPayload) => void;
  reject: (error: Error) => void;
}

// ============================================================================
// YieldingStreamImpl
// ============================================================================

/**
 * Implementation of the YieldingStream interface.
 *
 * This class manages:
 * - An event queue for yielding events to the consumer
 * - A promise-based handshake for tool results
 * - Cancellation via AbortController
 * - State tracking for debugging and validation
 */
export class YieldingStreamImpl implements YieldingStream {
  private state: StreamState = { status: 'idle' };
  private eventQueue: StreamEvent[] = [];
  private pendingToolResults: PendingToolResults | null = null;
  private abortController: AbortController;
  private _toolDepth = 0;

  // Promise/resolver for the async iterator to wait on new events
  private eventWaiter: {
    resolve: () => void;
    promise: Promise<void>;
  } | null = null;

  // Flag indicating the stream producer is done
  private producerDone = false;

  // Set when the CONSUMER leaves — `for await … break` (iterator.return) or
  // iterator.throw. Nobody will read this stream again, so queued events are
  // dropped rather than accumulated for a reader that is never coming back.
  private consumerDeparted = false;

  // Held so the listener can be removed at terminal: a long-lived caller
  // signal shared across many streams otherwise accumulates one closure per
  // stream, none of which are ever released.
  private readonly onExternalAbort = () => {
    this.cancel();
  };

  constructor(
    private readonly options: YieldingStreamOptions,
    private readonly runInference: (stream: YieldingStreamImpl) => Promise<void>
  ) {
    this.abortController = new AbortController();

    // Link external signal if provided
    if (options.signal) {
      options.signal.addEventListener('abort', this.onExternalAbort, { once: true });
    }
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  get isWaitingForTools(): boolean {
    return this.state.status === 'waiting_for_tools';
  }

  get pendingToolCallIds(): string[] {
    if (this.state.status === 'waiting_for_tools') {
      return this.state.pendingCallIds;
    }
    return [];
  }

  get toolDepth(): number {
    return this._toolDepth;
  }

  /**
   * Get the abort signal for use in internal operations.
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  provideToolResults(results: ToolResult[], options?: ProvideToolResultsOptions): void {
    if (this.state.status !== 'waiting_for_tools') {
      throw new Error(
        `Cannot provide tool results: stream is not waiting for tools (status: ${this.state.status})`
      );
    }

    if (!this.pendingToolResults) {
      throw new Error('Internal error: no pending tool results promise');
    }

    // Validate that results match pending call IDs
    const pendingIds = new Set(this.state.pendingCallIds);
    const providedIds = new Set(results.map((r) => r.toolUseId));

    for (const id of pendingIds) {
      if (!providedIds.has(id)) {
        throw new Error(`Missing tool result for call ID: ${id}`);
      }
    }

    // Injected messages must be user-side content only — tool blocks here
    // would corrupt the tool-cycle structure the normalizer guarantees.
    // Offending BLOCKS are stripped (loudly) rather than thrown on: a throw
    // at this point would leave the stream parked in waiting_for_tools with
    // an unresolvable promise — wedging the caller's whole turn over a
    // notification is far worse than delivering it without its tool blocks.
    const injectedMessages = options?.injectedMessages
      ?.map((m) => {
        const clean = m.content.filter(
          (block) => block.type !== 'tool_use' && block.type !== 'tool_result'
        );
        if (clean.length !== m.content.length) {
          console.warn(
            `[membrane] provideToolResults: stripped ${m.content.length - clean.length} ` +
            `tool block(s) from an injected mid-turn message (user-side content only)`
          );
        }
        return { ...m, content: clean };
      })
      .filter((m) => m.content.length > 0);

    // Resolve the promise and transition state
    this.pendingToolResults.resolve({
      results,
      ...(injectedMessages && injectedMessages.length > 0 ? { injectedMessages } : {}),
    });
    this.pendingToolResults = null;
    this.state = { status: 'streaming' };
    this._toolDepth++;
  }

  cancel(): void {
    if (this.state.status === 'done' || this.state.status === 'error') {
      return; // Already terminated
    }

    this.abortController.abort();

    // If waiting for tools, reject the pending promise
    if (this.pendingToolResults) {
      this.pendingToolResults.reject(new Error('Stream cancelled'));
      this.pendingToolResults = null;
    }

    // Emit aborted event and wake the iterator so it can deliver it
    this.emit({ type: 'aborted', reason: 'user' });
    this.producerDone = true;
    this.state = { status: 'done' };
    this.releaseExternalSignal();
  }

  // ============================================================================
  // Async Iterator Implementation
  // ============================================================================

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    // Start the inference loop when iteration begins
    this.startInference();

    return {
      next: async (): Promise<IteratorResult<StreamEvent>> => {
        while (true) {
          // Check for queued events
          const event = this.eventQueue.shift();
          if (event) {
            // Check if this is a terminal event
            if (
              event.type === 'complete' ||
              event.type === 'error' ||
              event.type === 'aborted'
            ) {
              this.state = { status: 'done' };
            }
            return { value: event, done: false };
          }

          // If producer is done and queue is empty, we're done
          if (this.producerDone) {
            return { value: undefined as unknown as StreamEvent, done: true };
          }

          // Wait for more events
          await this.waitForEvent();
        }
      },

      // `for await … break`, `return` out of the loop body, and a throw in
      // the loop body all call return(). Without it the consumer walks away
      // and the producer keeps streaming, resuming and billing. Cancelling
      // here is the same act the consumer would perform by hand.
      return: async (): Promise<IteratorResult<StreamEvent>> => {
        this.departConsumer();
        return { value: undefined as unknown as StreamEvent, done: true };
      },

      // Reached through `yield*` delegation. Same departure, and reporting
      // done keeps a delegating generator from failing with a TypeError for
      // a missing method.
      throw: async (): Promise<IteratorResult<StreamEvent>> => {
        this.departConsumer();
        return { value: undefined as unknown as StreamEvent, done: true };
      },
    };
  }

  // ============================================================================
  // Internal Methods (called by the inference loop)
  // ============================================================================

  /**
   * Push an event to be yielded to the consumer.
   */
  emit(event: StreamEvent): void {
    // The consumer has left for good; queueing here would grow without bound
    // for a reader that cannot observe it.
    if (this.consumerDeparted) return;
    this.eventQueue.push(event);
    this.notifyEventWaiter();
  }

  /**
   * Request tool execution and wait for results.
   * Called by the inference loop when tool calls are detected.
   */
  async requestToolExecution(event: ToolCallsEvent): Promise<ToolResultsPayload> {
    // Emit the tool calls event
    this.emit(event);

    // Transition to waiting state
    this.state = {
      status: 'waiting_for_tools',
      pendingCallIds: event.calls.map((c) => c.id),
    };

    // Create a promise that will be resolved by provideToolResults()
    return new Promise<ToolResultsPayload>((resolve, reject) => {
      this.pendingToolResults = { resolve, reject };
    });
  }

  /**
   * Mark the producer as done (inference loop finished).
   */
  markDone(): void {
    this.producerDone = true;
    this.releaseExternalSignal();
    this.notifyEventWaiter();
  }

  /**
   * Check if the stream has been cancelled.
   */
  get isCancelled(): boolean {
    return this.abortController.signal.aborted;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * The consumer has stopped iterating for good: drop everything queued for
   * it, refuse further queueing, and cancel the producer.
   */
  private departConsumer(): void {
    this.consumerDeparted = true;
    this.eventQueue.length = 0;
    this.cancel();
    this.eventQueue.length = 0;
  }

  private releaseExternalSignal(): void {
    this.options.signal?.removeEventListener('abort', this.onExternalAbort);
  }

  private startInference(): void {
    if (this.state.status !== 'idle') {
      return; // Already started
    }

    this.state = { status: 'streaming' };

    // Run the inference loop in the background
    this.runInference(this)
      .then(() => {
        this.markDone();
      })
      .catch((error) => {
        if (!this.isCancelled) {
          this.emit({ type: 'error', error });
        }
        this.markDone();
      });
  }

  private waitForEvent(): Promise<void> {
    if (!this.eventWaiter) {
      let resolve: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.eventWaiter = { resolve: resolve!, promise };
    }
    return this.eventWaiter.promise;
  }

  private notifyEventWaiter(): void {
    if (this.eventWaiter) {
      this.eventWaiter.resolve();
      this.eventWaiter = null;
    }
  }
}
