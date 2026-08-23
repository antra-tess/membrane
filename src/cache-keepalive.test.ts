import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CacheKeepalive,
  ineligibleReason,
  lineageKey,
  type KeepaliveEvent,
} from './cache-keepalive.js';

/** A wire request shaped like what buildRequest() produces for a real turn. */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-fable-5',
    max_tokens: 32000,
    stream: true,
    thinking: { type: 'adaptive' },
    system: [
      { type: 'text', text: 'You are a resident.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
      },
    ],
    ...overrides,
  };
}

const hit = { usage: { cache_read_input_tokens: 494_000, cache_creation_input_tokens: 0 } };

describe('ineligibleReason', () => {
  it('accepts a normal 1h-cached adaptive-thinking request', () => {
    expect(ineligibleReason(wire())).toBeNull();
  });

  it('rejects legacy budget_tokens thinking (max_tokens:0 is refused, and we must not disable thinking to fix it)', () => {
    expect(ineligibleReason(wire({ thinking: { type: 'enabled', budget_tokens: 8000 } })))
      .toBe('legacy-thinking-budget');
  });

  it('rejects forced tool_choice, which cannot be substituted without invalidating the messages cache', () => {
    expect(ineligibleReason(wire({ tool_choice: { type: 'any' } }))).toBe('forced-tool-choice');
    expect(ineligibleReason(wire({ tool_choice: { type: 'tool', name: 'x' } }))).toBe('forced-tool-choice');
    expect(ineligibleReason(wire({ tool_choice: { type: 'auto' } }))).toBeNull();
  });

  it('rejects structured output, which the API refuses with max_tokens:0', () => {
    expect(ineligibleReason(wire({ output_config: { format: { type: 'json_schema' } } })))
      .toBe('structured-output');
  });

  it('rejects a request with no cache_control at all (the compression lane today)', () => {
    const aux = wire({ system: undefined, messages: [{ role: 'user', content: 'compress this' }] });
    expect(ineligibleReason(aux)).toBe('no-cache-breakpoint');
  });

  it('rejects a 5m-only request: poking a 5m entry every few minutes costs more than it saves', () => {
    const short = wire({
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'h', cache_control: { type: 'ephemeral', ttl: '5m' } }] }],
    });
    expect(ineligibleReason(short)).toBe('no-1h-breakpoint');
  });
});

describe('lineageKey', () => {
  it('is stable across turns that only append messages', () => {
    const a = wire();
    const b = wire({ messages: [...(wire().messages as unknown[]), { role: 'assistant', content: 'hi' }] });
    expect(lineageKey(a)).toBe(lineageKey(b));
  });

  it('separates different agents, models, and tool sets', () => {
    expect(lineageKey(wire())).not.toBe(lineageKey(wire({ model: 'claude-opus-5' })));
    expect(lineageKey(wire())).not.toBe(
      lineageKey(wire({ system: [{ type: 'text', text: 'different agent' }] })),
    );
    expect(lineageKey(wire())).not.toBe(lineageKey(wire({ tools: [{ name: 't' }] })));
  });
});

describe('CacheKeepalive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (send: ReturnType<typeof vi.fn>, cfg = {}) => {
    const events: KeepaliveEvent[] = [];
    const ka = new CacheKeepalive(send as never, {
      refreshAfterMs: 45 * 60_000,
      checkIntervalMs: 5 * 60_000,
      maxIdleMs: 24 * 60 * 60_000,
      onEvent: (e) => events.push(e),
      ...cfg,
    });
    return { ka, events };
  };

  it('does nothing while real traffic keeps the entry warm (the busy-agent case)', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka } = setup(send);
    // A turn every 10 minutes for 2 hours: real requests refresh the TTL for
    // free, so the keepalive must never fire.
    for (let i = 0; i < 12; i++) {
      ka.record(wire(), undefined, 'stream');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    }
    expect(send).not.toHaveBeenCalled();
    ka.stop();
  });

  it('refreshes once the entry goes untouched past refreshAfterMs', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send);
    ka.record(wire(), undefined, 'stream');

    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'refreshed')).toBe(true);
    ka.stop();
  });

  it('replays max_tokens:0 without stream, and changes nothing else', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka } = setup(send);
    const original = wire();
    ka.record(original, { 'anthropic-beta': 'x' }, 'stream');
    await vi.advanceTimersByTimeAsync(50 * 60_000);

    const call = send.mock.calls[0]!;
    const payload = call[0] as Record<string, unknown>;
    const headers = call[1] as Record<string, string> | undefined;
    expect(payload.max_tokens).toBe(0);
    expect('stream' in payload).toBe(false);
    expect(headers).toEqual({ 'anthropic-beta': 'x' });
    // The cache-key-bearing fields must be untouched — this is the whole point.
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(payload.system).toBe(original.system);
    expect(payload.messages).toBe(original.messages);
    expect(payload.model).toBe('claude-fable-5');
    ka.stop();
  });

  it('stops refreshing after maxIdleMs measured from the last REAL request', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send, { maxIdleMs: 3 * 60 * 60_000 });
    ka.record(wire(), undefined, 'stream');

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + 60_000);
    // Pokes must not extend their own mandate: ~3 refreshes, then expiry.
    expect(events.some((e) => e.type === 'expired')).toBe(true);
    const before = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(send.mock.calls.length).toBe(before);
    ka.stop();
  });

  it('detects a poke that WROTE instead of read, and gives up on that lineage', async () => {
    // The silent-20x failure: a successful call that created a fresh 2x entry.
    const send = vi.fn().mockResolvedValue({
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 494_000 },
    });
    const { ka, events } = setup(send, { maxIneffective: 2 });
    ka.record(wire(), undefined, 'stream');

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await vi.advanceTimersByTimeAsync(50 * 60_000);

    const bad = events.filter((e) => e.type === 'ineffective');
    expect(bad.length).toBe(2);
    expect((bad[0] as { reason: string }).reason).toBe('wrote-instead-of-read');

    const after = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(send.mock.calls.length).toBe(after);
    ka.stop();
  });

  it('treats an absent usage field as "not a read" rather than assuming success', async () => {
    const send = vi.fn().mockResolvedValue({});
    const { ka, events } = setup(send);
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(events.some((e) => e.type === 'ineffective')).toBe(true);
    ka.stop();
  });

  it('hard-disables after consecutive errors instead of becoming a retry storm', async () => {
    // fable-cm, 2026-08-21: 1033 `400 invalid_request_error` in 3h from a
    // background lane. A keepalive must never be able to do that.
    const send = vi.fn().mockRejectedValue(new Error('400 invalid_request_error'));
    const { ka, events } = setup(send, { maxConsecutiveErrors: 3 });
    ka.record(wire(), undefined, 'stream');

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(send.mock.calls.length).toBe(3);
    expect(events.some((e) => e.type === 'disabled')).toBe(true);
    ka.stop();
  });

  it('ignores the aux lane by default', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka } = setup(send);
    ka.record(wire(), undefined, 'complete');
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(send).not.toHaveBeenCalled();
    ka.stop();
  });

  it('evicts the oldest lineage past maxLineages to bound memory', () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka } = setup(send, { maxLineages: 2 });
    ka.record(wire({ model: 'a' }), undefined, 'stream');
    ka.record(wire({ model: 'b' }), undefined, 'stream');
    ka.record(wire({ model: 'c' }), undefined, 'stream');
    expect(ka.getStatus().length).toBe(2);
    ka.stop();
  });

  it('drops a snapshot when the request shape stops being warmable', () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send);
    ka.record(wire(), undefined, 'stream');
    expect(ka.getStatus().length).toBe(1);
    // Same lineage (model/system/tools identical), now with forced tool choice.
    ka.record(wire({ tool_choice: { type: 'any' } }), undefined, 'stream');
    expect(ka.getStatus().length).toBe(0);
    expect(events.some((e) => e.type === 'skipped')).toBe(true);
    ka.stop();
  });

  it('is inert when disabled', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const ka = new CacheKeepalive(send as never, { enabled: false });
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(send).not.toHaveBeenCalled();
  });
});
