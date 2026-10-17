/**
 * A cancelled streamYielding() turn reports what it had. The aborted event
 * that cancel() emits, for the consumer's cancel and for the caller's
 * AbortSignal alike, carries partialContent, rawAssistantText, toolCalls and
 * toolResults, as a provider or deadline abort's does (#142).
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { YieldingStreamImpl } from '../../src/yielding-stream.js';
import { abortError } from '../../src/types/errors.js';
import { deadlineTimeoutError, isDeadlineAbort } from '../../src/providers/utils.js';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

type Mode = 'native' | 'xml';

const XML_CALL = 'zz checking\n<function_calls><invoke name="zz_noop"><parameter name="x">1</parameter></invoke></function_calls>';

/**
 * Round one makes one tool call. Round two streams some text and then waits
 * until its signal aborts, failing as an adapter does: a deadline abort as a
 * timeout, anything else as an abort.
 */
class TwoRoundAdapter implements ProviderAdapter {
  readonly name = 'zz-two-rounds';
  calls = 0;
  private enteredSecond!: () => void;
  readonly secondRound = new Promise<void>((resolve) => { this.enteredSecond = resolve; });
  constructor(private readonly mode: Mode) {}

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }

  async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls === 1) {
      if (this.mode === 'xml') {
        callbacks.onChunk(XML_CALL);
        return { content: [{ type: 'text', text: XML_CALL }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, model: request.model, rawRequest: request, raw: {} } as never;
      }
      callbacks.onChunk('zz checking');
      return {
        content: [{ type: 'text', text: 'zz checking' }, { type: 'tool_use', id: 'zz-tu-1', name: 'zz_noop', input: { x: 1 } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: request.model,
        rawRequest: request,
        raw: {},
      } as never;
    }
    options?.onProgress?.();
    callbacks.onChunk('zz second ');
    const signal = options!.signal!;
    await new Promise<never>((_, reject) => {
      const fail = (): void => reject(isDeadlineAbort(signal.reason) ? deadlineTimeoutError(signal.reason) : abortError('Request aborted'));
      if (signal.aborted) { fail(); return; }
      signal.addEventListener('abort', fail, { once: true });
      this.enteredSecond();
    });
    throw new Error('unreachable');
  }
}

const BASE: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
  tools: [{ name: 'zz_noop', description: 'zz no-op', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }],
};
const requestFor = (mode: Mode): NormalizedRequest => ({ ...BASE, toolMode: mode });

/** Answers the tool round, then runs `stop` once round two is under way; returns every event. */
async function drive(stream: YieldingStream, adapter: TwoRoundAdapter, stop: () => void): Promise<StreamEvent[]> {
  void adapter.secondRound.then(stop);
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'tool-calls') {
      stream.provideToolResults(event.calls.map((call) => ({ toolUseId: call.id, content: 'zz ok' })));
    }
  }
  return events;
}

/** The fields an aborted event carries beside its type and reason. */
function partOf(events: StreamEvent[]): Record<string, unknown> {
  const aborted = events.filter((event) => event.type === 'aborted');
  expect(aborted).toHaveLength(1);
  const { type: _type, reason: _reason, ...rest } = aborted[0] as unknown as Record<string, unknown>;
  return rest;
}

/** The same, with the ids the XML parser mints for each run (`tool_<ms>_<n>`) made alike. */
function comparable(part: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(part).replace(/tool_\d+_\d+/g, 'tool_id'));
}

describe('a cancelled streamYielding() turn reports what it had', () => {
  for (const mode of ['native', 'xml'] as const) {
    it(`cancel() after a completed tool round carries that round and the next round's text (${mode})`, async () => {
      const adapter = new TwoRoundAdapter(mode);
      const stream = new Membrane(adapter).streamYielding(requestFor(mode), {});
      const events = await drive(stream, adapter, () => stream.cancel());

      const aborted = events.find((event) => event.type === 'aborted') as { reason: string };
      expect(aborted.reason).toBe('user');
      const part = partOf(events);
      expect(part.toolCalls).toEqual([expect.objectContaining({ name: 'zz_noop', input: { x: 1 } })]);
      expect(part.toolResults).toEqual([expect.objectContaining({ content: 'zz ok' })]);
      // Both rounds' text: the recorded round's and the open round's so far.
      expect(String(part.rawAssistantText)).toContain('zz checking');
      expect(String(part.rawAssistantText)).toContain('zz second ');
      const blocks = part.partialContent as Array<{ type: string }>;
      expect(blocks.map((block) => block.type)).toEqual(['text', 'tool_use', 'tool_result', 'text']);
      expect(JSON.stringify(blocks[0])).toContain('zz checking');
      // The XML path parses its blocks from the text, and that parse gives
      // this one as "zz second", without the trailing space.
      expect(JSON.stringify(blocks[3])).toContain('zz second');
    });

    it(`cancel() while the round's tools are running carries its calls with no results (${mode})`, async () => {
      const adapter = new TwoRoundAdapter(mode);
      const stream = new Membrane(adapter).streamYielding(requestFor(mode), {});
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'tool-calls') stream.cancel();
      }
      const part = partOf(events);
      expect(part.toolCalls).toEqual([expect.objectContaining({ name: 'zz_noop', input: { x: 1 } })]);
      expect(part.toolResults).toEqual([]);
      expect(String(part.rawAssistantText)).toContain('zz checking');
      const blocks = part.partialContent as Array<{ type: string }>;
      expect(blocks.map((block) => block.type)).toEqual(['text', 'tool_use']);
      expect(adapter.calls).toBe(1);
    });

    it(`cancel() carries what a deadline abort at the same point carries (${mode})`, async () => {
      const cancelled = new TwoRoundAdapter(mode);
      const cancelledStream = new Membrane(cancelled).streamYielding(requestFor(mode), {});
      const byCancel = partOf(await drive(cancelledStream, cancelled, () => cancelledStream.cancel()));

      // The deadline lets round one run, then expires while round two waits.
      const expired = new TwoRoundAdapter(mode);
      const expiredStream = new Membrane(expired).streamYielding(requestFor(mode), { progressTimeoutMs: 200 });
      const events = await drive(expiredStream, expired, () => {});
      expect((events.find((event) => event.type === 'aborted') as { reason: string }).reason).toBe('timeout');

      expect(comparable(byCancel)).toEqual(comparable(partOf(events)));
    });

    it(`a caller's AbortSignal carries the same (${mode})`, async () => {
      const adapter = new TwoRoundAdapter(mode);
      const caller = new AbortController();
      const stream = new Membrane(adapter).streamYielding(requestFor(mode), { signal: caller.signal });
      const events = await drive(stream, adapter, () => caller.abort());

      expect((events.find((event) => event.type === 'aborted') as { reason: string }).reason).toBe('user');
      const part = partOf(events);
      expect(part.toolResults).toEqual([expect.objectContaining({ content: 'zz ok' })]);
      expect(String(part.rawAssistantText)).toContain('zz second ');
    });
  }

  for (const mode of ['native', 'xml'] as const) {
    it(`results provided just before the cancel are not in it, and stay out once the loop runs on (${mode})`, async () => {
      const adapter = new TwoRoundAdapter(mode);
      const stream = new Membrane(adapter).streamYielding(requestFor(mode), {});
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'tool-calls') {
          stream.provideToolResults(event.calls.map((call) => ({ toolUseId: call.id, content: 'zz ok' })));
          stream.cancel();
        }
        // Still reading when the loop resumes and records those results: it
        // records them as soon as its wait resolves, with no await between,
        // so one turn of the event loop is enough.
        await new Promise((resolve) => setImmediate(resolve));
      }
      const part = partOf(events);
      expect(part.toolCalls).toEqual([expect.objectContaining({ name: 'zz_noop' })]);
      expect(part.toolResults).toEqual([]);
    });
  }

  it('a cancel whose snapshot throws still ends the stream with one bare aborted', async () => {
    const started = new YieldingStreamImpl({}, async (running) => {
      running.setAbortSnapshot(() => { throw new Error('zz snapshot failed'); });
      running.emit({ type: 'tokens', content: 'zz', meta: { visible: true } } as never);
      await new Promise<void>((resolve) => running.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const seen: StreamEvent[] = [];
    for await (const event of started) {
      seen.push(event);
      if (event.type === 'tokens') expect(() => started.cancel()).not.toThrow();
    }
    expect(seen.filter((event) => event.type === 'aborted')).toEqual([{ type: 'aborted', reason: 'user' }]);
  });

  it('a consumer that leaves early does not run the builder, and one that cancels does', async () => {
    const counted = (count: { built: number }) => new YieldingStreamImpl({}, async (running) => {
      running.setAbortSnapshot(() => { count.built++; return {}; });
      running.emit({ type: 'tokens', content: 'zz', meta: { visible: true } } as never);
      await new Promise<void>((resolve) => running.signal.addEventListener('abort', () => resolve(), { once: true }));
    });

    const left = { built: 0 };
    for await (const event of counted(left)) {
      if (event.type === 'tokens') break;
    }
    expect(left.built).toBe(0);

    const cancelled = { built: 0 };
    const stream = counted(cancelled);
    for await (const event of stream) {
      if (event.type === 'tokens') stream.cancel();
    }
    expect(cancelled.built).toBe(1);
  });

  it('a finished stream lets go of its loop\'s builder', async () => {
    const stream = new YieldingStreamImpl({}, async (running) => {
      running.setAbortSnapshot(() => ({ rawAssistantText: 'zz' }));
    });
    for await (const _event of stream) { /* the loop ends at once */ }
    expect((stream as unknown as { abortSnapshot?: unknown }).abortSnapshot).toBeUndefined();
  });
});
