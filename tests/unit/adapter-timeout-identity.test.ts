/**
 * Timeout identity through the REAL fetch-based adapters.
 *
 * The abort-lifecycle work pinned `reason: 'timeout'` with a mock adapter that
 * throws createCombinedSignal's DOMException directly. Every real
 * createCombinedSignal-based adapter catches that DOMException in its own
 * handleError and replaces it with abortError() — type 'abort', message
 * "Request was aborted" — so the timeout identity died inside the adapter and
 * Membrane's caller-signal > timeout > error ladder never saw it. These tests
 * drive the actual adapters with a fetch stub that behaves like the platform's
 * (rejecting with `signal.reason`, measured identity-preserving on both the
 * pre-headers and body-read paths).
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import type { Socket } from 'node:net';
import { Membrane } from '../../src/membrane.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { createCombinedSignal, isDeadlineAbort } from '../../src/providers/utils.js';
import { MembraneError, isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 16 },
};

const GEMINI_REQUEST: NormalizedRequest = {
  ...REQUEST,
  config: { model: 'gemini-zz-model', maxTokens: 16 },
};

const realFetch = globalThis.fetch;

/**
 * Stands in for a wedged connection: the request is accepted and then never
 * settles until the signal aborts, at which point it rejects with the signal's
 * own reason — exactly what undici and bun's fetch do.
 */
function installHangingFetch(): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
    state.calls++;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return state;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('deadline aborts keep their timeout identity through the real adapters', () => {
  it('OpenAIAdapter: stream() reports reason timeout, not error (XML path)', async () => {
    installHangingFetch();
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-not-a-key' }));

    const result = await membrane.stream(REQUEST, { timeoutMs: 5 });

    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('OpenAIAdapter: streamYielding() reports reason timeout', async () => {
    installHangingFetch();
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-not-a-key' }));

    const events: StreamEvent[] = [];
    for await (const event of membrane.streamYielding(REQUEST, { timeoutMs: 5 })) {
      events.push(event);
    }

    const aborted = events.find((e) => e.type === 'aborted');
    expect(aborted).toBeDefined();
    expect((aborted as { reason: string }).reason).toBe('timeout');
  });

  it('GeminiAdapter: stream() reports reason timeout', async () => {
    installHangingFetch();
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-not-a-key' }));

    const result = await membrane.stream(GEMINI_REQUEST, { timeoutMs: 5 });

    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('OpenAIAdapter: complete() rejects with a typed timeout, not a generic abort', async () => {
    installHangingFetch();
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-not-a-key' }));

    const error = await membrane
      .complete(REQUEST, { timeoutMs: 5 })
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).type).toBe('timeout');
    expect((error as MembraneError).retryable).toBe(false);
  });

  it("a caller's own cancellation still reports user, deadline or no deadline", async () => {
    installHangingFetch();
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-not-a-key' }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const result = await membrane.stream(REQUEST, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('user');
  });

  it('an abort that is neither the caller nor a deadline still reports error', async () => {
    // A stray AbortError with no caller signal and no deadline behind it: the
    // bottom rung of the ladder, and the guard against mapping every abort to
    // a timeout.
    globalThis.fetch = (() =>
      Promise.reject(new DOMException('Request was aborted', 'AbortError'))) as unknown as typeof fetch;
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-not-a-key' }));

    const result = await membrane.stream(REQUEST, {});

    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('error');
  });
});

describe('the deadline mark createCombinedSignal puts on its own abort', () => {
  it('marks the deadline abort and leaves a caller cancellation unmarked', async () => {
    const deadline = createCombinedSignal(undefined, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(deadline.signal!.aborted).toBe(true);
    expect(isDeadlineAbort(deadline.signal!.reason)).toBe(true);
    deadline.cleanup?.();

    const controller = new AbortController();
    const combined = createCombinedSignal(controller.signal, 60_000);
    controller.abort();
    expect(combined.signal!.aborted).toBe(true);
    expect(isDeadlineAbort(combined.signal!.reason)).toBe(false);
    combined.cleanup?.();
  });

  it('a caller cancellation that wins the race stays unmarked even after the deadline elapses', async () => {
    const controller = new AbortController();
    const combined = createCombinedSignal(controller.signal, 5);
    controller.abort(new DOMException('zz caller cancelled', 'AbortError'));
    await new Promise((r) => setTimeout(r, 20));

    expect(isDeadlineAbort(combined.signal!.reason)).toBe(false);
    expect((combined.signal!.reason as Error).message).toBe('zz caller cancelled');
    combined.cleanup?.();
  });

  it('nothing else answers to the mark', () => {
    expect(isDeadlineAbort(new DOMException('Request timed out', 'AbortError'))).toBe(false);
    expect(isDeadlineAbort(new Error('Request timed out'))).toBe(false);
    expect(isDeadlineAbort(undefined)).toBe(false);
    expect(isDeadlineAbort('Request timed out')).toBe(false);
  });
});

describe('the mark survives the platform fetch', () => {
  // The whole mechanism rests on fetch rejecting with the signal's own reason
  // object rather than a substitute. Pinned against a real loopback server so
  // a runtime that stops doing that is a red here, not a silent regression to
  // reason: 'error' in production.
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"zz":1}\n\n'); // headers land, body never finishes
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects with the marked reason on the body-read path', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const { signal, cleanup } = createCombinedSignal(undefined, 20);

    const error = await (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal });
        const reader = response.body!.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        return undefined;
      } catch (e) {
        return e;
      } finally {
        cleanup?.();
      }
    })();

    expect(error).toBeDefined();
    expect((error as Error).name).toBe('AbortError');
    expect(isDeadlineAbort(error)).toBe(true);
  });
});
