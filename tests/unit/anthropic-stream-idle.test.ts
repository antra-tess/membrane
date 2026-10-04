import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { ProviderRequest } from '../../src/types/index.js';

/**
 * Idle-watchdog regressions through the real SDK SSE parser. The SDK drops
 * `ping` events before the adapter sees them, so a body that only carries
 * keepalives must still count as live transport. Timings are scaled fixture
 * inputs only: the ratios (pings every ~IDLE/5, runs of 4x IDLE) are wide so
 * loaded machines do not turn them into races.
 */
const IDLE_MS = 150;
const PING_MS = 30;
const LIVE_MS = 4 * IDLE_MS;

const request: ProviderRequest = {
  model: 'claude-sonnet-4-6', maxTokens: 32,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: request.model,
  content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 0 },
};

const frame = (event: string, data: object): string =>
  `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
const ping = (): string => frame('ping', {});
const messageStart = (): string => frame('message_start', { message });
const answer = (): string[] => [
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello back' } }),
  frame('content_block_stop', { index: 0 }),
  frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
  frame('message_stop', {}),
];

interface Io {
  emit(text: string): void;
  sleep(ms: number): Promise<void>;
  close(): void;
  isDone(): boolean;
  untilDone(): Promise<void>;
}
interface Probe { torn: boolean }

const probes: Probe[] = [];

/** A live SSE body the test scripts byte by byte; records transport teardown. */
function liveResponse(init: RequestInit | undefined, script: (io: Io) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const probe: Probe = { torn: false };
  probes.push(probe);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const stop = (error?: Error): void => {
    if (done) return;
    done = true;
    release();
    try { if (error) controller.error(error); else controller.close(); } catch { /* already settled */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { probe.torn = true; done = true; release(); },
  });
  init?.signal?.addEventListener('abort', () => {
    probe.torn = true;
    stop(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
  }, { once: true });
  void script({
    emit: text => { if (!done) { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } } },
    sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
    close: () => stop(),
    isDone: () => done,
    untilDone: () => released,
  }).catch(() => {});
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
}

/** Keepalives only, at PING_MS intervals, for about `ms`. */
async function keepalives(io: Io, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !io.isDone(); elapsed += PING_MS) {
    io.emit(ping());
    await io.sleep(PING_MS);
  }
}

function stubFetch(respond: (init: RequestInit, call: number) => Response | Promise<Response>): RequestInit[] {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    calls.push(init);
    return respond(init, calls.length - 1);
  });
  return calls;
}

const newAdapter = (extra: ConstructorParameters<typeof AnthropicAdapter>[0] = {}): AnthropicAdapter =>
  new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, ...extra });
const timing = { idleTimeoutMs: IDLE_MS, firstEventTimeoutMs: IDLE_MS };

afterEach(() => {
  vi.unstubAllGlobals();
  probes.length = 0;
});

describe('Anthropic stream idle watchdog with live transport', () => {
  it('does not time out a body carrying only keepalives after message_start', async () => {
    stubFetch(init => liveResponse(init, async io => {
      io.emit(messageStart());
      await keepalives(io, LIVE_MS);
      for (const part of answer()) io.emit(part);
      io.close();
    }));
    const chunks: string[] = [];
    const result = await newAdapter().stream(request, { onChunk: chunk => chunks.push(chunk) }, timing);
    expect(result.stopReason).toBe('end_turn');
    expect(result.content).toMatchObject([{ type: 'text', text: 'hello back' }]);
    expect(chunks).toEqual(['hello back']);
  });

  it('does not hit the first-event deadline while only keepalives precede message_start', async () => {
    stubFetch(init => liveResponse(init, async io => {
      await keepalives(io, LIVE_MS);
      io.emit(messageStart());
      for (const part of answer()) io.emit(part);
      io.close();
    }));
    const result = await newAdapter().stream(request, { onChunk: () => {} }, timing);
    expect(result.stopReason).toBe('end_turn');
    expect(result.content).toMatchObject([{ type: 'text', text: 'hello back' }]);
  });

  it('still classifies real silence after message_start as the typed idle timeout', async () => {
    stubFetch(init => liveResponse(init, async io => {
      io.emit(messageStart());
      await io.untilDone();
    }));
    await expect(newAdapter().stream(request, { onChunk: () => {} }, timing)).rejects.toMatchObject({
      type: 'timeout', retryable: true, message: expect.stringMatching(/idle timeout/),
    });
    expect(probes[0]?.torn).toBe(true);
  });

  it('still classifies silence before any byte as the first-event timeout', async () => {
    stubFetch(init => liveResponse(init, io => io.untilDone()));
    await expect(newAdapter().stream(request, { onChunk: () => {} }, timing)).rejects.toMatchObject({
      type: 'timeout', retryable: true, message: expect.stringMatching(/first-event timeout/),
    });
    expect(probes[0]?.torn).toBe(true);
  });

  it('does not promote a keepalive-live stream that closes without a terminal event', async () => {
    stubFetch(init => liveResponse(init, async io => {
      io.emit(messageStart());
      io.emit(frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
      io.emit(frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }));
      await keepalives(io, LIVE_MS);
      io.close();
    }));
    await expect(newAdapter().stream(request, { onChunk: () => {} }, timing)).rejects.toMatchObject({
      retryable: true, message: expect.stringMatching(/stream ended before a terminal event/),
    });
  });

  it('classifies a caller abort during live keepalives as abort, not timeout', async () => {
    stubFetch(init => liveResponse(init, async io => {
      io.emit(messageStart());
      await keepalives(io, 10 * LIVE_MS);
    }));
    const caller = new AbortController();
    const pending = newAdapter().stream(request, { onChunk: () => {} }, { ...timing, signal: caller.signal });
    setTimeout(() => caller.abort(), 2 * IDLE_MS);
    await expect(pending).rejects.toMatchObject({ type: 'abort' });
    expect(probes[0]?.torn).toBe(true);
  });

  it('keeps concurrent streams independent: one aborted, one completed', async () => {
    stubFetch((init) => {
      const text = JSON.parse(String(init.body)).messages[0].content[0].text as string;
      return liveResponse(init, async io => {
        io.emit(messageStart());
        if (text === 'abort me') { await keepalives(io, 10 * LIVE_MS); return; }
        await keepalives(io, LIVE_MS);
        for (const part of answer()) io.emit(part);
        io.close();
      });
    });
    const adapter = newAdapter();
    const aborted = new AbortController();
    const withText = (text: string): ProviderRequest => ({ ...request, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
    const results = Promise.allSettled([
      adapter.stream(withText('abort me'), { onChunk: () => {} }, { ...timing, signal: aborted.signal }),
      adapter.stream(withText('finish'), { onChunk: () => {} }, timing),
    ]);
    setTimeout(() => aborted.abort(), 2 * IDLE_MS);
    const [first, second] = await results;
    expect(first).toMatchObject({ status: 'rejected', reason: { type: 'abort' } });
    expect(second).toMatchObject({ status: 'fulfilled', value: { stopReason: 'end_turn' } });
  });

  it('composes with the single credential refresh after HTTP 401', async () => {
    const flags: boolean[] = [];
    const calls = stubFetch((init, call) => call === 0
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired token' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      })
      : liveResponse(init, async io => {
        io.emit(messageStart());
        await keepalives(io, LIVE_MS);
        for (const part of answer()) io.emit(part);
        io.close();
      }));
    const adapter = newAdapter({
      credentials: ({ forceRefresh }) => { flags.push(forceRefresh); return { token: forceRefresh ? 'fresh' : 'expired' }; },
    });
    const result = await adapter.stream(request, { onChunk: () => {} }, timing);
    expect(result.stopReason).toBe('end_turn');
    expect(flags).toEqual([false, true]);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1]?.headers).get('authorization')).toBe('Bearer fresh');
  });
});
