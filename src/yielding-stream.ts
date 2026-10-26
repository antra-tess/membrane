import type {
  AbortedEvent,
  StreamEvent,
  YieldingStream,
  YieldingStreamOptions,
  ToolCallsEvent,
  InjectedMessage,
  ProvideToolResultsOptions,
} from './types/yielding-stream.js';
import { isTerminalEvent } from './types/yielding-stream.js';
import type { ToolResult } from './types/tools.js';

type AbortedSnapshot = Omit<AbortedEvent, 'type' | 'reason'>;

export interface ToolResultsPayload {
  results: ToolResult[];
  injected?: InjectedBatch;
}

export interface InjectedBatch {
  size: number;
  messages: Array<{ index: number; message: InjectedMessage }>;
  altered: number[];
}

function cleanInjectedBatch(supplied: InjectedMessage[]): InjectedBatch {
  const batch: InjectedBatch = { size: supplied.length, messages: [], altered: [] };
  supplied.forEach((m, index) => {
    const clean = m.content.filter(
      (block) => block.type !== 'tool_use' && block.type !== 'tool_result'
    );
    if (clean.length !== m.content.length) {
      console.warn(
        `[membrane] provideToolResults: stripped ${m.content.length - clean.length} ` +
        `tool block(s) from an injected mid-turn message (user-side content only)`
      );
      batch.altered.push(index);
    }
    if (clean.length > 0) batch.messages.push({ index, message: { ...m, content: clean } });
  });
  return batch;
}

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

export class YieldingStreamImpl implements YieldingStream {
  private state: StreamState = { status: 'idle' };
  private eventQueue: StreamEvent[] = [];
  private pendingToolResults: PendingToolResults | null = null;
  private abortController: AbortController;
  private _toolDepth = 0;

  private eventWaiter: {
    resolve: () => void;
    promise: Promise<void>;
  } | null = null;

  private producerDone = false;

  private consumerDeparted = false;

  private terminalQueued = false;

  private readonly onExternalAbort = () => {
    this.cancel();
  };

  private abortSnapshot: (() => AbortedSnapshot) | undefined;

  constructor(
    private readonly options: YieldingStreamOptions,
    private readonly runInference: (stream: YieldingStreamImpl) => Promise<void>
  ) {
    this.abortController = new AbortController();

    // A signal that has already fired never dispatches 'abort' again.
    if (options.signal?.aborted) {
      this.cancel();
    } else if (options.signal) {
      options.signal.addEventListener('abort', this.onExternalAbort, { once: true });
    }
  }

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

    const pendingIds = new Set(this.state.pendingCallIds);
    const providedIds = new Set(results.map((r) => r.toolUseId));

    for (const id of pendingIds) {
      if (!providedIds.has(id)) {
        throw new Error(`Missing tool result for call ID: ${id}`);
      }
    }

    const supplied = options?.injectedMessages;
    const injected = supplied && supplied.length > 0 ? cleanInjectedBatch(supplied) : undefined;

    this.pendingToolResults.resolve({ results, ...(injected ? { injected } : {}) });
    this.pendingToolResults = null;
    this.state = { status: 'streaming' };
    this._toolDepth++;
  }

  cancel(): void {
    if (this.state.status === 'done' || this.state.status === 'error') {
      return;
    }

    let partial: AbortedSnapshot = {};
    try {
      if (!this.consumerDeparted) partial = this.abortSnapshot?.() ?? {};
    } catch {
    }

    this.abortController.abort();

    if (this.pendingToolResults) {
      this.pendingToolResults.reject(new Error('Stream cancelled'));
      this.pendingToolResults = null;
    }

    this.emit({ type: 'aborted', reason: 'user', ...partial });
    this.producerDone = true;
    this.state = { status: 'done' };
    this.releaseExternalSignal();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.startInference();

    return {
      next: async (): Promise<IteratorResult<StreamEvent>> => {
        while (true) {
          const event = this.eventQueue.shift();
          if (event) {
            if (isTerminalEvent(event)) {
              this.state = { status: 'done' };
            }
            return { value: event, done: false };
          }

          if (this.producerDone) {
            return { value: undefined as unknown as StreamEvent, done: true };
          }

          await this.waitForEvent();
        }
      },

      // `for await … break`, `return` out of the loop body, and a throw in the loop
      // body all call return().
      return: async (): Promise<IteratorResult<StreamEvent>> => {
        this.departConsumer();
        return { value: undefined as unknown as StreamEvent, done: true };
      },

      // Reached through `yield*` delegation, or a direct `.throw(e)`. Reporting
      // `done: true` would swallow the error: a `yield*` would resume after the
      // delegation, and `.throw(e)` would resolve. So it rethrows, as an async
      // generator with no handler of its own does.
      throw: async (error?: unknown): Promise<IteratorResult<StreamEvent>> => {
        this.departConsumer();
        throw error;
      },
    };
  }

  emit(event: StreamEvent): void {
    if (this.consumerDeparted) return;
    if (this.terminalQueued) return;
    if (isTerminalEvent(event)) this.terminalQueued = true;
    this.eventQueue.push(event);
    this.notifyEventWaiter();
  }

  async requestToolExecution(event: ToolCallsEvent): Promise<ToolResultsPayload> {
    if (this.isCancelled) {
      throw new Error('Stream cancelled');
    }

    this.emit(event);

    this.state = {
      status: 'waiting_for_tools',
      pendingCallIds: event.calls.map((c) => c.id),
    };

    return new Promise<ToolResultsPayload>((resolve, reject) => {
      this.pendingToolResults = { resolve, reject };
    });
  }

  setAbortSnapshot(build: () => AbortedSnapshot): void {
    this.abortSnapshot = build;
  }

  markDone(): void {
    this.producerDone = true;
    this.abortSnapshot = undefined;
    this.releaseExternalSignal();
    this.notifyEventWaiter();
  }

  get isCancelled(): boolean {
    return this.abortController.signal.aborted;
  }

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
      return;
    }

    this.state = { status: 'streaming' };

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
