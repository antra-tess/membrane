import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CacheKeepalive,
  ineligibleReason,
  lineageKey,
  messagesForRefresh,
  credentialField,
  type KeepaliveEvent,
} from './cache-keepalive.js';
import { countWireCacheMarkers } from './utils/cache-marker-budget.js';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('accepts a request whose only one-hour marker is on its system prompt', () => {
    expect(ineligibleReason(wire({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }))).toBeNull();
  });

  it('accepts a request whose only one-hour marker is on its last tool', () => {
    expect(ineligibleReason(wire({
      system: [{ type: 'text', text: 'You are a resident.' }],
      tools: [
        { name: 'a', input_schema: { type: 'object' } },
        { name: 'b', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }))).toBeNull();
  });

  it("treats a request whose only one-hour marker is inside a document's source content as membrane's marker budget does", () => {
    const document = {
      type: 'document',
      source: { type: 'content', content: [{ type: 'text', text: 'page', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    };
    const surfaces = {
      system: [{ type: 'text', text: 'You are a resident.' }],
      messages: [{ role: 'user', content: [document] }],
    };
    const counted = countWireCacheMarkers(surfaces) > 0;
    expect(ineligibleReason(wire(surfaces))).toBe(counted ? null : 'no-cache-breakpoint');
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

describe('messagesForRefresh', () => {
  const hour = { type: 'ephemeral', ttl: '1h' };
  const fiveMinutes = { type: 'ephemeral' };
  const text = (body: string, cacheControl?: object) => ({
    type: 'text', text: body, ...(cacheControl ? { cache_control: cacheControl } : {}),
  });
  const user = (...content: object[]) => ({ role: 'user', content });
  const assistant = (...content: object[]) => ({ role: 'assistant', content });

  it('ends on the user message that holds the last one-hour marker', () => {
    const messages = [user(text('a', hour)), assistant(text('b')), user(text('c', hour)), assistant(text('d')), user(text('e'))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 3));
  });

  it("leaves out an assistant message after the user message holding the last one-hour marker, though no user message follows it", () => {
    const messages = [user(text('a')), assistant(text('b')), user(text('c', hour)), assistant(text('a prefill'))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 3));
  });

  it('runs on through the next user message when the last one-hour marker is on an assistant message', () => {
    const messages = [user(text('a')), assistant(text('b', hour)), user(text('c')), assistant(text('d')), user(text('e'))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 3));
  });

  it('keeps the messages through the first user message when only system or tools carry a marker', () => {
    const messages = [assistant(text('a context prefix')), user(text('a')), assistant(text('b')), user(text('c'))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 2));
  });

  it('keeps every message when the last one carries the last one-hour marker', () => {
    const messages = [user(text('a')), assistant(text('b')), user(text('c', hour))];
    expect(messagesForRefresh(messages)).toEqual(messages);
  });

  it('keeps every message when the last one-hour marker is on an assistant message with no user message after it', () => {
    const messages = [user(text('a')), assistant(text('b', hour))];
    expect(messagesForRefresh(messages)).toEqual(messages);
  });

  it("keeps the assistant messages after the marker's too, when the marker is on an assistant message with no user message after it", () => {
    const messages = [user(text('a')), assistant(text('b', hour)), assistant(text('c'))];
    expect(messagesForRefresh(messages)).toEqual(messages);
  });

  it("takes every user message of the turn that closes the run, so a tool call's results aren't split", () => {
    const messages = [
      user(text('a')),
      assistant({ type: 'tool_use', id: 't1', name: 'read', input: {} }, { type: 'tool_use', id: 't2', name: 'read', input: {}, cache_control: hour }),
      user({ type: 'tool_result', tool_use_id: 't1', content: 'one' }),
      user({ type: 'tool_result', tool_use_id: 't2', content: 'two' }),
      assistant(text('d')),
      user(text('e')),
    ];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 4));
  });

  it('takes the closing turn to the end of the request, through each of its user messages', () => {
    const messages = [
      user(text('a')),
      assistant(
        { type: 'tool_use', id: 't1', name: 'read', input: {} },
        { type: 'tool_use', id: 't2', name: 'read', input: {} },
        { type: 'tool_use', id: 't3', name: 'read', input: {}, cache_control: hour },
      ),
      user({ type: 'tool_result', tool_use_id: 't1', content: 'one' }),
      user({ type: 'tool_result', tool_use_id: 't2', content: 'two' }),
      user({ type: 'tool_result', tool_use_id: 't3', content: 'three' }),
    ];
    expect(messagesForRefresh(messages)).toEqual(messages);
  });

  it("finds a one-hour marker on a message's second block", () => {
    const messages = [user(text('a', hour)), assistant(text('b')), user(text('c'), text('d', hour)), assistant(text('e')), user(text('f'))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 3));
  });

  it("doesn't take a cache_control in a tool's input for a marker", () => {
    const messages = [
      user(text('a', hour)),
      assistant({ type: 'tool_use', id: 't', name: 'send', input: { body: { cache_control: hour } } }),
      user({ type: 'tool_result', tool_use_id: 't', content: 'sent' }),
      assistant(text('d')),
      user(text('e')),
    ];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 1));
  });

  it('leaves out a five-minute marker after the last one-hour marker', () => {
    const messages = [user(text('a', hour)), assistant(text('b')), user(text('c', fiveMinutes))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 1));
  });

  it('finds a one-hour marker nested in a tool result', () => {
    const messages = [
      user(text('a')),
      assistant({ type: 'tool_use', id: 't', name: 'read', input: {} }),
      user({ type: 'tool_result', tool_use_id: 't', content: [text('r', hour)] }),
      assistant(text('d')),
      user(text('e')),
    ];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 3));
  });

  it("reads a marker inside a document's source content as membrane's marker budget does", () => {
    const document = { type: 'document', source: { type: 'content', content: [text('page', hour)] } };
    const messages = [user(text('a', hour)), assistant(text('b')), user(document), assistant(text('d')), user(text('e'))];
    const counted = countWireCacheMarkers({ messages: [user(document)] }) > 0;
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, counted ? 3 : 1));
  });

  it('finds a one-hour marker on a document block itself', () => {
    const document = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'page' }, cache_control: hour };
    const messages = [user(text('a', hour)), assistant(text('b')), user(document), assistant(text('d')), user(text('e'))];
    expect(messagesForRefresh(messages)).toEqual(messages.slice(0, 3));
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

  it('replays max_tokens:0 without stream, and changes nothing else when nothing follows the last one-hour marker', async () => {
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
    // Cache identity depends on serialized bytes, not JavaScript references.
    expect(payload.thinking).toEqual({ type: 'adaptive' });
    expect(JSON.stringify(payload.system)).toBe(JSON.stringify(original.system));
    expect(JSON.stringify(payload.messages)).toBe(JSON.stringify(original.messages));
    const expected: Record<string, unknown> = { ...original, max_tokens: 0 };
    delete expected.stream;
    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected));
    expect(payload.model).toBe('claude-fable-5');
    ka.stop();
  });

  it('replays only through the last one-hour marker, leaving every message it keeps as recorded', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const receipts: Array<{ request: Record<string, unknown> }> = [];
    const { ka } = setup(send, { onCall: (call: { request: Record<string, unknown> }) => { receipts.push(call); } });
    const marked = { role: 'user', content: [{ type: 'text', text: 'the compiled window', cache_control: { type: 'ephemeral', ttl: '1h' } }] };
    const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }] };
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(5_000) }] };
    const original = wire({ messages: [marked, call, result] });
    ka.record(original, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(50 * 60_000);

    const payload = send.mock.calls[0]![0] as Record<string, unknown>;
    const expected: Record<string, unknown> = { ...original, messages: [marked], max_tokens: 0 };
    delete expected.stream;
    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(receipts[0]!.request)).toBe(JSON.stringify(expected));
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(JSON.stringify(send.mock.calls[1]![0])).toBe(JSON.stringify(expected));
    ka.stop();
  });

  it('stops refreshing after maxIdleMs measured from the last REAL request', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send, { maxIdleMs: 3 * 60 * 60_000 });
    ka.record(wire(), undefined, 'stream');

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + 60_000);
    expect(events.some((e) => e.type === 'expired')).toBe(true);
    const before = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(send.mock.calls.length).toBe(before);
    ka.stop();
  });

  it('detects a poke that WROTE instead of read, and gives up on that lineage', async () => {
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

describe('CacheKeepalive statePath (across restarts)', () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'keepalive-'));
    statePath = join(dir, 'cache-keepalive.json');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (send: ReturnType<typeof vi.fn>, cfg = {}) => {
    const events: KeepaliveEvent[] = [];
    const ka = new CacheKeepalive(send as never, {
      refreshAfterMs: 45 * 60_000,
      checkIntervalMs: 5 * 60_000,
      maxIdleMs: 24 * 60 * 60_000,
      statePath,
      onEvent: (e) => events.push(e),
      ...cfg,
    });
    return { ka, events };
  };

  it('a new process takes up the lineage and replays the recorded bytes, with no new real request', async () => {
    const first = make(vi.fn().mockResolvedValue(hit));
    const original = wire();
    first.ka.record(original, { 'anthropic-beta': 'x' }, 'stream');
    // The old instance is left running, unstopped, as a crashed process would
    // leave it; the new one takes the file over, and only the file carries over.

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send);
    expect(events.some((e) => e.type === 'restored')).toBe(true);
    expect(ka.getStatus().length).toBe(1);

    // Without the file the new process would have nothing to refresh, and the
    // entry would expire an hour after the last real request.
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, headers] = send.mock.calls[0] as [Record<string, unknown>, Record<string, string>];
    const expected: Record<string, unknown> = { ...original, max_tokens: 0 };
    delete expected.stream;
    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected));
    expect(headers).toEqual({ 'anthropic-beta': 'x' });
    expect(events.some((e) => e.type === 'refreshed')).toBe(true);
    first.ka.stop();
    ka.stop();
  });

  it('refreshes at once when the restart lands late in the entry\'s hour', async () => {
    const first = make(vi.fn().mockResolvedValue(hit));
    first.ka.record(wire(), undefined, 'stream');
    first.ka.stop(); // the process goes down
    await vi.advanceTimersByTimeAsync(57 * 60_000);
    const send = vi.fn().mockResolvedValue(hit);
    const { ka } = make(send);
    // One checkIntervalMs (5m) later would be past the hour: the replay
    // would pay a write.
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    ka.stop();
  });

  it('does not restore a lineage whose entry expired while the process was down', async () => {
    const first = make(vi.fn().mockResolvedValue(hit));
    first.ka.record(wire(), undefined, 'stream');
    first.ka.stop(); // the process goes down
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send);
    expect(ka.getStatus().length).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'skipped', reason: 'cache-expired-while-stopped' }));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(send).not.toHaveBeenCalled();
    ka.stop();
  });

  it('does not restore past maxIdleMs since the last real request', async () => {
    const first = make(vi.fn().mockResolvedValue(hit), { maxIdleMs: 2 * 60 * 60_000 });
    first.ka.record(wire(), undefined, 'stream');
    // Kept warm by refreshes, so the entry is fresh, but the agent has been idle too long.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 - 60_000);
    first.ka.stop();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send, { maxIdleMs: 2 * 60 * 60_000 });
    expect(ka.getStatus().length).toBe(0);
    expect(events.some((e) => e.type === 'expired')).toBe(true);
    ka.stop();
  });

  it('keeps the refresh baseline current in the file, so a restart after a refresh waits for the next one', async () => {
    const first = make(vi.fn().mockResolvedValue(hit));
    first.ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(50 * 60_000); // one refresh at ~45-50m
    first.ka.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000); // 70m after the real request
    const send = vi.fn().mockResolvedValue(hit);
    const { ka } = make(send);
    // Restored (the refresh kept the entry alive), not yet due again.
    expect(ka.getStatus().length).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    ka.stop();
  });

  it('stop() leaves the file for the next process', () => {
    const { ka } = make(vi.fn().mockResolvedValue(hit));
    ka.record(wire(), undefined, 'stream');
    ka.stop();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.lineages.length).toBe(1);
  });

  it('saves only the anthropic-beta and anthropic-version headers, and the file is private', () => {
    const { ka } = make(vi.fn().mockResolvedValue(hit));
    ka.record(wire(), {
      'Anthropic-Beta': 'x',
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer secret',
      'x-api-key': 'sk-ant-secret',
      'anthropic-api-key': 'sk-ant-secret2',
      'Anthropic-Auth-Token': 'secret3',
    }, 'stream');
    const text = readFileSync(statePath, 'utf8');
    expect(text).not.toContain('secret');
    expect(JSON.parse(text).lineages[0].headers).toEqual({ 'Anthropic-Beta': 'x', 'anthropic-version': '2023-06-01' });
    if (process.platform !== 'win32') expect(statSync(statePath).mode & 0o777).toBe(0o600);
    ka.stop();
  });

  it('starts empty and says so when the file is unreadable', () => {
    writeFileSync(statePath, '{not json');
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send);
    expect(ka.getStatus().length).toBe(0);
    expect(events.some((e) => e.type === 'persist-error' && e.op === 'load')).toBe(true);
    // Still works in memory, and the next change replaces the bad file.
    ka.record(wire(), undefined, 'stream');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lineages.length).toBe(1);
    ka.stop();
  });

  it('keeps a request holding a credential out of the file, and still refreshes it', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send);
    const withToken = wire({
      system: [{ type: 'text', text: 'other agent', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      mcp_servers: [{ type: 'url', url: 'https://mcp.example', name: 'x', authorization_token: 'secret-token' }],
    });
    ka.record(withToken, undefined, 'stream');
    ka.record(wire(), undefined, 'stream');
    const text = readFileSync(statePath, 'utf8');
    expect(text).not.toContain('secret-token');
    expect(JSON.parse(text).lineages.length).toBe(1);
    expect(events.filter((e) => e.type === 'not-persisted')).toEqual([
      { type: 'not-persisted', key: lineageKey(withToken), reason: 'request holds mcp_servers[0].authorization_token' },
    ]);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    ka.stop();
  });

  it('credentialField looks outside the conversation only', () => {
    expect(credentialField(wire())).toBeNull();
    expect(credentialField(wire({ messages: [{ role: 'user', content: [{ type: 'text', text: 'my api_key', api_key: 'x' }] }] }))).toBeNull();
    expect(credentialField(wire({ metadata: { user_id: 'u' } }))).toBeNull();
    expect(credentialField(wire({ metadata: { session_token: 't' } }))).toBe('metadata.session_token');
    expect(credentialField(wire({ apiKey: 'k' }))).toBe('apiKey');
  });

  it('a failed refresh does not move the saved last touch', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network down'));
    const { ka } = make(send, { maxConsecutiveErrors: 10 });
    ka.record(wire(), undefined, 'stream');
    const before = JSON.parse(readFileSync(statePath, 'utf8')).lineages[0].touchedAt;
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(send).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lineages[0].touchedAt).toBe(before);
    ka.stop();
    // 61 minutes after the real request the entry is gone, whatever was tried.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    const next = make(vi.fn().mockResolvedValue(hit));
    expect(next.ka.getStatus().length).toBe(0);
    expect(next.events).toContainEqual(expect.objectContaining({ reason: 'cache-expired-while-stopped' }));
    next.ka.stop();
  });

  it('saves the removal when a lineage is dropped as ineffective, or expires', async () => {
    const miss = { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    const dropped = make(vi.fn().mockResolvedValue(miss), { maxIneffective: 1 });
    dropped.ka.record(wire(), undefined, 'stream');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lineages.length).toBe(1);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(dropped.ka.getStatus().length).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lineages.length).toBe(0);
    dropped.ka.stop();

    rmSync(statePath);
    const idle = make(vi.fn().mockResolvedValue(hit), { maxIdleMs: 30 * 60_000 });
    idle.ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    expect(idle.events.some((e) => e.type === 'expired')).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lineages.length).toBe(0);
    idle.ka.stop();
  });

  it('stops saving once another keepalive has written the file', () => {
    const first = make(vi.fn().mockResolvedValue(hit));
    first.ka.record(wire(), undefined, 'stream');
    const second = make(vi.fn().mockResolvedValue(hit));
    second.ka.record(wire({ system: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } }] }), undefined, 'stream');
    const written = readFileSync(statePath, 'utf8');
    first.ka.record(wire({ system: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral', ttl: '1h' } }] }), undefined, 'stream');
    expect(readFileSync(statePath, 'utf8')).toBe(written);
    expect(first.events).toContainEqual(expect.objectContaining({ type: 'persist-error', op: 'save' }));
    first.ka.stop();
    second.ka.stop();
  });

  it('restores from a hand-written file: checks each entry and keeps the newest maxLineages', () => {
    const now = Date.now();
    const sys = (text: string) => [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    const entry = (text: string, extra: Record<string, unknown> = {}) => ({
      wire: wire({ system: sys(text) }), lane: 'stream', lastRealAt: now - 60_000, touchedAt: now - 60_000, ineffective: 0, ...extra,
    });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      lineages: [
        entry('a'),
        entry('b'),
        entry('c'),
        entry('future', { touchedAt: now + 60 * 60_000 }),
        entry('bad-time', { touchedAt: 'soon' }),
        { wire: 'nope', lane: 'stream' },
        entry('bad-headers', { headers: { 'anthropic-beta': 1 } }),
        entry('other-lane', { lane: 'complete' }),
        entry('d'),
      ],
    }));
    const { ka, events } = make(vi.fn().mockResolvedValue(hit), { maxLineages: 3 });
    const restored = events.filter((e) => e.type === 'restored').map((e) => (e as { key: string }).key);
    expect(restored).toEqual(['b', 'c', 'd'].map((t) => lineageKey(wire({ system: sys(t) }))));
    expect(ka.getStatus().length).toBe(3);
    expect(events).toContainEqual(expect.objectContaining({ type: 'skipped', reason: 'clock-went-back' }));
    expect(events).toContainEqual({ type: 'persist-error', op: 'load', error: '3 malformed lineage(s) left out' });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lineages.length).toBe(3);
    ka.stop();
  });

  it('when disabled, leaves an existing file alone and restores nothing', async () => {
    const first = make(vi.fn().mockResolvedValue(hit));
    first.ka.record(wire(), undefined, 'stream');
    first.ka.stop();
    const before = readFileSync(statePath, 'utf8');
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send, { enabled: false });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(events).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(ka.getStatus().length).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('reports a failed save and carries on in memory', async () => {
    statePath = join(dir, 'no-such-dir', 'cache-keepalive.json');
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = make(send);
    ka.record(wire(), undefined, 'stream');
    expect(events).toContainEqual(expect.objectContaining({ type: 'persist-error', op: 'save' }));
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    ka.stop();
  });

  it('writes no file without statePath, and none when disabled', () => {
    const plain = new CacheKeepalive(vi.fn() as never, {});
    plain.record(wire(), undefined, 'stream');
    plain.stop();
    const off = new CacheKeepalive(vi.fn() as never, { enabled: false, statePath });
    off.record(wire(), undefined, 'stream');
    expect(existsSync(statePath)).toBe(false);
  });
});
