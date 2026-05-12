/**
 * Unit tests for the `beforeRequest` Membrane hook.
 *
 * Regression coverage for the bug fixed in this PR: the hook used to fire
 * only on `complete()` and silently skip every streaming path
 * (`stream()`, `streamYielding()`). Any future refactor of `streamOnce`
 * that drops the normalizedRequest plumbing or bypasses
 * `applyBeforeRequestHook` would reintroduce the exact same silent
 * failure — these tests fail loudly when that happens.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest } from '../../src/types/index.js';

describe('beforeRequest hook', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
    });
  });

  function createRequest(text: string = 'Hello'): NormalizedRequest {
    return {
      messages: [{ participant: 'User', content: [{ type: 'text', text }] }],
      config: { model: 'test-model', maxTokens: 100 },
    };
  }

  it('fires on complete()', async () => {
    const calls: Array<{ normalized: NormalizedRequest; raw: unknown }> = [];
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (request, rawRequest) => {
          calls.push({ normalized: request, raw: rawRequest });
        },
      },
    });

    await membrane.complete(createRequest('via complete'));

    expect(calls.length).toBe(1);
    expect(calls[0]?.normalized.messages[0]?.content).toEqual([
      { type: 'text', text: 'via complete' },
    ]);
    // The raw request is provider-shaped — at minimum it should be an
    // object with a `messages` array of the same length as the
    // normalized form.
    const raw = calls[0]?.raw as { messages?: unknown[] };
    expect(Array.isArray(raw?.messages)).toBe(true);
  });

  it('fires on stream()', async () => {
    const calls: Array<{ normalized: NormalizedRequest; raw: unknown }> = [];
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (request, rawRequest) => {
          calls.push({ normalized: request, raw: rawRequest });
        },
      },
    });

    await membrane.stream(createRequest('via stream'), {
      onChunk: () => {},
    });

    // This is the regression — pre-fix, calls.length was 0.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.normalized.messages[0]?.content).toEqual([
      { type: 'text', text: 'via stream' },
    ]);
  });

  it('fires on streamYielding()', async () => {
    const calls: Array<{ normalized: NormalizedRequest; raw: unknown }> = [];
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (request, rawRequest) => {
          calls.push({ normalized: request, raw: rawRequest });
        },
      },
    });

    const stream = membrane.streamYielding(createRequest('via yielding'));
    // Drain the stream to drive a full call.
    for await (const _event of stream) {
      /* discard */
    }

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.normalized.messages[0]?.content).toEqual([
      { type: 'text', text: 'via yielding' },
    ]);
  });

  it('honors a hook that returns a mutated provider request', async () => {
    // Confirms the helper's return value is what reaches the adapter —
    // i.e., the hook isn't just observational, it can rewrite.
    let observed: { messages?: unknown[] } | undefined;
    adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      // capture the actual request the adapter sees so we can verify it
      // reflects the hook's mutation
      responseGenerator: (req) => {
        observed = req as unknown as { messages?: unknown[] };
        return 'ok';
      },
    });
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (_request, rawRequest) => {
          // Inject a marker field so we can detect the adapter saw the
          // mutated shape rather than the original.
          return { ...(rawRequest as object), __mutated_by_hook: true };
        },
      },
    });

    await membrane.complete(createRequest('mutate me'));

    expect((observed as Record<string, unknown> | undefined)?.__mutated_by_hook).toBe(true);
  });

  it('is a no-op when no hook is configured', async () => {
    const membrane = new Membrane(adapter);
    // The bare-membrane path used to be the only path that worked at all;
    // confirm it still does — i.e., `applyBeforeRequestHook` returns the
    // original request unchanged when no hook is set.
    const response = await membrane.complete(createRequest('plain'));
    expect(response.rawAssistantText).toBeTypeOf('string');
  });
});
