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
    for await (const _event of stream) {
    }

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.normalized.messages[0]?.content).toEqual([
      { type: 'text', text: 'via yielding' },
    ]);
  });

  it('honors a hook that returns a mutated provider request', async () => {
    let observed: { messages?: unknown[] } | undefined;
    adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseGenerator: (req) => {
        observed = req as unknown as { messages?: unknown[] };
        return 'ok';
      },
    });
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (_request, rawRequest) => {
          return { ...(rawRequest as object), __mutated_by_hook: true };
        },
      },
    });

    await membrane.complete(createRequest('mutate me'));

    expect((observed as Record<string, unknown> | undefined)?.__mutated_by_hook).toBe(true);
  });

  it('is a no-op when no hook is configured', async () => {
    const membrane = new Membrane(adapter);
    const response = await membrane.complete(createRequest('plain'));
    expect(response.rawAssistantText).toBeTypeOf('string');
  });
});
