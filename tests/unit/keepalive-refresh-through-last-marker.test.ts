/** Anthropic caches a request's prefix only up to its last cache marker, so rounds after it are under no marker. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';

const MODEL = 'claude-opus-4-1';

function fakeStream(events: unknown[]) {
  return {
    controller: { abort() { /* the stub has no connection */ } },
    [Symbol.asyncIterator]() {
      let index = 0;
      return { async next() { return index < events.length ? { value: events[index++], done: false } : { value: undefined, done: true }; } };
    },
  };
}

const startUsage = { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const toolUseRound = (id: string) => [
  { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: startUsage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"notes.md"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
];
const finalRound = () => [
  { type: 'message_start', message: { id: 'msg_final', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: startUsage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
];

function request(cacheMarkers: 'cm-owned' | 'membrane-system', breakpoints: number[]) {
  const messages = Array.from({ length: 9 }, (_, index) => ({
    participant: index % 2 === 0 ? 'Operator' : 'Resident',
    content: [{ type: 'text' as const, text: `history message ${index}` }],
    ...(breakpoints.includes(index) ? { cacheBreakpoint: true } : {}),
  }));
  return {
    messages,
    system: 'You are Resident.',
    tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'] } }],
    config: { model: MODEL, maxTokens: 4096 },
    promptCaching: true,
    cacheTtl: '1h' as const,
    cacheMarkers,
    toolMode: 'native' as const,
    assistantParticipant: 'Resident',
  } as any;
}

function rig() {
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
  const sent: any[] = [];
  const refreshes: any[] = [];
  const rounds = [toolUseRound('toolu_1'), toolUseRound('toolu_2'), finalRound()];
  const client: any = {
    messages: {
      stream: vi.fn(async (body: any) => { sent.push(JSON.parse(JSON.stringify(body))); return fakeStream(rounds.shift() ?? finalRound()); }),
      create: vi.fn(async (body: any) => {
        refreshes.push(JSON.parse(JSON.stringify(body)));
        return { id: 'refresh', content: [], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } };
      }),
    },
  };
  client.withOptions = () => client;
  (adapter as any).client = client;
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter(), assistantParticipant: 'Resident' });
  return { adapter, membrane, sent, refreshes };
}

async function runTurn(membrane: Membrane, req: unknown) {
  const stream = membrane.streamYielding(req as any, {});
  for await (const event of stream) {
    if (event.type === 'tool-calls') {
      stream.provideToolResults(event.calls.map((call) => ({ toolUseId: call.id, content: 'r'.repeat(2_000), isError: false })));
    }
  }
}

const marked = (message: any): boolean => JSON.stringify(message).includes('"cache_control"');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-19T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('a keepalive refresh after a tool-using turn', () => {
  it("replays only the compiled messages when the context manager holds every marker, leaving out the turn's rounds", async () => {
    const { adapter, membrane, sent, refreshes } = rig();
    await runTurn(membrane, request('cm-owned', [2, 4, 6, 8]));
    // The premise: three rounds, the last carrying the compiled nine messages and then two rounds under no marker.
    expect(sent).toHaveLength(3);
    expect(sent[2].messages).toHaveLength(13);
    expect(sent[2].messages.slice(9).some(marked)).toBe(false);

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].max_tokens).toBe(0);
    // Through the last marker, on the ninth message, a user message: what the first round sent.
    expect(JSON.stringify(refreshes[0].messages)).toBe(JSON.stringify(sent[2].messages.slice(0, 9)));
    expect(JSON.stringify(refreshes[0].messages)).toBe(JSON.stringify(sent[0].messages));
    adapter.cacheKeepalive!.stop();
  });

  it("replays every message when membrane's float marks each round's newest one", async () => {
    const { adapter, membrane, sent, refreshes } = rig();
    await runTurn(membrane, request('membrane-system', [2, 5, 8]));
    expect(sent).toHaveLength(3);
    expect(marked(sent[2].messages.at(-1))).toBe(true);

    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(refreshes).toHaveLength(1);
    expect(JSON.stringify(refreshes[0].messages)).toBe(JSON.stringify(sent[2].messages));
    adapter.cacheKeepalive!.stop();
  });
});
