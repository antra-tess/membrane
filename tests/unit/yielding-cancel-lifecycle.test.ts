/**
 * A yielding stream ends at its terminal event. After cancel(), the consumer
 * sees one aborted event and nothing after it, a loop that resumes anyway
 * finishes instead of parking on a tool wait, and a cancel that comes after
 * the loop's own terminal event adds no event of its own.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { YieldingStreamImpl } from '../../src/yielding-stream.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

type Mode = 'native' | 'xml';

const XML_CALL = 'zz checking\n<function_calls><invoke name="zz_noop"><parameter name="x">1</parameter></invoke></function_calls>';

const respond = (request: ProviderRequest, content: unknown[], stopReason: string): ProviderResponse => ({
  content, stopReason, usage: { inputTokens: 10, outputTokens: 5 }, model: request.model, rawRequest: request, raw: {},
}) as never;

/** One round that makes a tool call. A second call isn't expected and fails. */
class ToolRoundAdapter implements ProviderAdapter {
  readonly name = 'zz-tool-round';
  calls = 0;
  constructor(private readonly mode: Mode) {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls > 1) throw new Error('zz: a second provider call');
    if (this.mode === 'xml') {
      callbacks.onChunk(XML_CALL);
      return respond(request, [{ type: 'text', text: XML_CALL }], 'end_turn');
    }
    callbacks.onChunk('zz checking');
    return respond(request, [{ type: 'text', text: 'zz checking' }, { type: 'tool_use', id: 'zz-tu-1', name: 'zz_noop', input: { x: 1 } }], 'tool_use');
  }
}

/**
 * A response that had already come when the cancel arrived: the round streams
 * its text (and, for a tool call on the XML path, the call), waits for the
 * abort, then resolves anyway, as a provider whose last bytes crossed the
 * cancel would. `late` says what it resolves with: a tool call, or text only.
 */
class LateAdapter implements ProviderAdapter {
  readonly name = 'zz-late';
  calls = 0;
  private started!: () => void;
  readonly streaming = new Promise<void>((resolve) => { this.started = resolve; });
  constructor(private readonly mode: Mode, private readonly late: 'tool' | 'text') {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    const xmlCall = this.mode === 'xml' && this.late === 'tool';
    callbacks.onChunk(xmlCall ? XML_CALL : 'zz first ');
    const signal = options!.signal!;
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => resolve(), { once: true });
      this.started();
    });
    if (xmlCall) return respond(request, [{ type: 'text', text: XML_CALL }], 'end_turn');
    if (this.mode === 'native' && this.late === 'tool') {
      return respond(request, [{ type: 'text', text: 'zz first ' }, { type: 'tool_use', id: 'zz-late', name: 'zz_noop', input: { x: 2 } }], 'tool_use');
    }
    return respond(request, [{ type: 'text', text: 'zz first ' }], 'end_turn');
  }
}

const BASE: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
  tools: [{ name: 'zz_noop', description: 'zz no-op', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }],
};
const requestFor = (mode: Mode): NormalizedRequest => ({ ...BASE, toolMode: mode });

/** setImmediate runs after every pending microtask, so one turn lets a loop resuming from a settled wait run to its end when it awaits nothing on the way. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** The loop's builder as the stream holds it. markDone() releases it, so its absence shows the loop finished. */
const builderOf = (stream: unknown): unknown => (stream as { abortSnapshot?: unknown }).abortSnapshot;

describe('a yielding stream ends at its terminal event', () => {
  for (const mode of ['native', 'xml'] as const) {
    it(`results passed just before cancel() leave nothing after the aborted event (${mode})`, async () => {
      const adapter = new ToolRoundAdapter(mode);
      const stream = new Membrane(adapter).streamYielding(requestFor(mode), {});
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
        if (event.type === 'tool-calls') {
          expect(typeof builderOf(stream)).toBe('function');
          stream.provideToolResults(event.calls.map((call) => ({ toolUseId: call.id, content: 'zz ok' })));
          stream.cancel();
        }
        // Reading on while the loop resumes and runs to its next check.
        await turn();
      }
      await turn();
      expect(types[types.length - 1]).toBe('aborted');
      expect(types.filter((type) => type === 'aborted')).toHaveLength(1);
      expect(adapter.calls).toBe(1);
      expect(builderOf(stream)).toBeUndefined();
    });

    for (const late of ['tool', 'text'] as const) {
      it(`a response that resolves after the cancel, with ${late === 'tool' ? 'a tool call' : 'text only'}, brings nothing after aborted, and the loop finishes (${mode})`, async () => {
        const adapter = new LateAdapter(mode, late);
        const stream = new Membrane(adapter).streamYielding(requestFor(mode), {});
        void adapter.streaming.then(() => {
          expect(typeof builderOf(stream)).toBe('function');
          stream.cancel();
        });
        const events: StreamEvent[] = [];
        for await (const event of stream) {
          events.push(event);
          await turn();
        }
        await turn();

        expect(events.map((event) => event.type).filter((type) => type === 'aborted')).toHaveLength(1);
        expect(events[events.length - 1].type).toBe('aborted');
        // A late call was recorded after the event was built, so the event
        // doesn't gain it.
        expect((events[events.length - 1] as { toolCalls?: unknown[] }).toolCalls).toEqual([]);
        // The loop finished: it isn't parked on a tool wait, and markDone() ran.
        expect(stream.isWaitingForTools).toBe(false);
        expect(builderOf(stream)).toBeUndefined();
        expect(adapter.calls).toBe(1);
      });
    }
  }

  for (const terminal of [
    { type: 'complete', response: {} },
    { type: 'error', error: new Error('zz failed') },
    { type: 'aborted', reason: 'timeout' },
  ] as const) {
    it(`a cancel() after the loop's own ${terminal.type} adds nothing, and ${terminal.type} stays the last event`, async () => {
      let finished!: () => void;
      const done = new Promise<void>((resolve) => { finished = resolve; });
      const stream = new YieldingStreamImpl({}, async (running) => {
        running.emit(terminal as never);
        finished();
      });
      const iterator = stream[Symbol.asyncIterator]();
      await done;
      stream.cancel();
      const types: string[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        types.push(next.value.type);
      }
      expect(types).toEqual([terminal.type]);
    });
  }
});
