/**
 * Mid-turn message injection via provideToolResults(results, { injectedMessages }).
 *
 * A consumer (agent framework) can pass messages that arrived while a tool
 * round was executing; the next inference round's request must include them
 * as user-side content AFTER the round's tool_result envelope, without
 * disturbing tool_use → tool_result adjacency or the assistant turn.
 *
 * Also pins the ChatCompletions interloper fix: text sharing an envelope
 * with tool_results becomes a following user message instead of being
 * silently dropped (providers/openai.ts convertMessages).
 */

import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
  ToolDefinition,
  ToolResult,
} from '../../src/types/index.js';

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'A no-op tool used to force tool rounds.',
  inputSchema: { type: 'object', properties: {} },
};

// ---------------------------------------------------------------------------
// Scripted native-mode adapter: captures every provider request it receives
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  content: ProviderResponse['content'];
  stopReason: string;
}

class CapturingAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  requests: ProviderRequest[] = [];
  private turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    this.requests.push(JSON.parse(JSON.stringify(request)));
    const turn = this.turns.shift();
    if (!turn) throw new Error('no scripted turn left');
    for (const block of turn.content) {
      if ((block as any).type === 'text') callbacks.onChunk((block as any).text);
    }
    return {
      content: turn.content,
      stopReason: turn.stopReason as any,
      usage: { inputTokens: 10, outputTokens: 10 },
      raw: {},
    };
  }
}

function nativeRequest(): NormalizedRequest {
  return {
    messages: [
      { participant: 'User', content: [{ type: 'text', text: 'drive the robot' }] },
    ],
    config: { model: 'test-model', maxTokens: 1000 },
    tools: [noopTool],
    toolMode: 'native',
  };
}

function toolUseTurn(id: string): ScriptedTurn {
  return {
    content: [
      { type: 'text', text: 'moving' },
      { type: 'tool_use', id, name: 'noop', input: {} },
    ] as any,
    stopReason: 'tool_use',
  };
}

const finalTurn: ScriptedTurn = {
  content: [{ type: 'text', text: 'done.' }] as any,
  stopReason: 'end_turn',
};

/** Drive the stream, answering each tool round via the supplied callback. */
async function drive(
  membrane: Membrane,
  request: NormalizedRequest,
  onToolCalls: (stream: ReturnType<Membrane['streamYielding']>, event: any) => void
): Promise<StreamEvent[]> {
  const stream = membrane.streamYielding(request);
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'tool-calls') onToolCalls(stream, event);
  }
  return events;
}

function okResults(event: any): ToolResult[] {
  return event.calls.map((c: any) => ({ toolUseId: c.id, content: 'ok', isError: false }));
}

/** All text found in user-role envelopes of a captured request, in order. */
function userTexts(req: any): string[] {
  const texts: string[] = [];
  for (const msg of req.messages ?? []) {
    if (msg.role !== 'user') continue;
    for (const block of msg.content ?? []) {
      if (block.type === 'text') texts.push(block.text);
    }
  }
  return texts;
}

describe('native yielding: mid-turn injected messages', () => {
  it('injected message appears in the next round, after the tool_result', async () => {
    const adapter = new CapturingAdapter([toolUseTurn('tu_1'), finalTurn]);
    const membrane = new Membrane(adapter);

    const events = await drive(membrane, nativeRequest(), (stream, event) => {
      stream.provideToolResults(okResults(event), {
        injectedMessages: [
          { participant: 'Antra', content: [{ type: 'text', text: 'look left!' }] },
        ],
      });
    });

    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(adapter.requests.length).toBe(2);

    // Round 1 must NOT contain the injected message
    expect(userTexts(adapter.requests[0]).join('\n')).not.toContain('look left!');

    // Round 2: injected message present, with participant name prefix,
    // positioned AFTER the tool_result block
    const round2 = adapter.requests[1] as any;
    const flat: Array<{ kind: string; text?: string }> = [];
    for (const msg of round2.messages) {
      for (const block of msg.content ?? []) {
        if (block.type === 'tool_result') flat.push({ kind: 'tool_result' });
        else if (block.type === 'text') flat.push({ kind: 'text', text: block.text });
      }
    }
    const resultIdx = flat.findIndex((b) => b.kind === 'tool_result');
    const injectedIdx = flat.findIndex((b) => b.text?.includes('look left!'));
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(injectedIdx).toBeGreaterThan(resultIdx);
    expect(flat[injectedIdx]!.text).toContain('Antra: look left!');

    // tool_use → tool_result adjacency intact: assistant tool_use envelope
    // is immediately followed by a user envelope starting with tool_result
    const msgs = round2.messages;
    const tuIdx = msgs.findIndex((m: any) =>
      m.content?.some((b: any) => b.type === 'tool_use')
    );
    expect(tuIdx).toBeGreaterThanOrEqual(0);
    expect(msgs[tuIdx + 1].content[0].type).toBe('tool_result');
  });

  it('multiple injected messages survive across multiple rounds', async () => {
    const adapter = new CapturingAdapter([toolUseTurn('tu_1'), toolUseTurn('tu_2'), finalTurn]);
    const membrane = new Membrane(adapter);

    let round = 0;
    await drive(membrane, nativeRequest(), (stream, event) => {
      round++;
      stream.provideToolResults(okResults(event), {
        injectedMessages:
          round === 1
            ? [
                { content: [{ type: 'text', text: 'first interjection' }] },
                { participant: 'Skye', content: [{ type: 'text', text: 'second interjection' }] },
              ]
            : undefined,
      });
    });

    expect(adapter.requests.length).toBe(3);
    const round3Text = userTexts(adapter.requests[2]).join('\n');
    // Round-1 injections persist into every later round's conversation
    expect(round3Text).toContain('first interjection');
    expect(round3Text).toContain('Skye: second interjection');
  });

  it('omitting injectedMessages leaves the conversation shape unchanged', async () => {
    const adapter = new CapturingAdapter([toolUseTurn('tu_1'), finalTurn]);
    const membrane = new Membrane(adapter);

    await drive(membrane, nativeRequest(), (stream, event) => {
      stream.provideToolResults(okResults(event));
    });

    const round2 = adapter.requests[1] as any;
    // Only original user message text — no phantom user text appended
    const texts = userTexts(round2);
    expect(texts.filter((t) => !t.includes('drive the robot'))).toEqual([]);
  });

  it('strips tool blocks from injected messages instead of throwing (no wedge)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new CapturingAdapter([toolUseTurn('tu_1'), finalTurn]);
      const membrane = new Membrane(adapter);

      const events = await drive(membrane, nativeRequest(), (stream, event) => {
        stream.provideToolResults(okResults(event), {
          injectedMessages: [
            {
              content: [
                { type: 'tool_result', toolUseId: 'x', content: 'nope' } as any,
                { type: 'text', text: 'legit interjection' },
              ],
            },
          ],
        });
      });

      // Stream completed normally — a throw here would wedge the caller's turn
      expect(events.some((e) => e.type === 'complete')).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stripped 1 tool block'));

      // The text survived; the tool_result did not (exactly one tool_result
      // in round 2 — the real one for tu_1)
      const round2 = adapter.requests[1] as any;
      expect(userTexts(round2).join('\n')).toContain('legit interjection');
      const toolResultCount = round2.messages
        .flatMap((m: any) => m.content ?? [])
        .filter((b: any) => b.type === 'tool_result').length;
      expect(toolResultCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('empty-content injected messages are filtered out', async () => {
    const adapter = new CapturingAdapter([toolUseTurn('tu_1'), finalTurn]);
    const membrane = new Membrane(adapter);

    await drive(membrane, nativeRequest(), (stream, event) => {
      stream.provideToolResults(okResults(event), {
        injectedMessages: [{ content: [] }],
      });
    });

    const round2 = adapter.requests[1] as any;
    const texts = userTexts(round2);
    expect(texts.filter((t) => !t.includes('drive the robot'))).toEqual([]);
  });
});

describe('XML yielding: injectedMessages are ignored with a warning', () => {
  it('warns and completes normally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = new MockAdapter({
        streamChunkDelayMs: 0,
        completeDelayMs: 0,
        responseQueue: [
          `<function_calls><invoke name="noop"></invoke></function_calls>`,
          'done.',
        ],
      });
      const membrane = new Membrane(adapter);
      const request: NormalizedRequest = {
        messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
        config: { model: 'test-model', maxTokens: 1000 },
        tools: [noopTool],
        // This case is about the XML yielding path; native is the default
        // tool mode now, so the XML path is an explicit opt-in.
        toolMode: 'xml',
      };

      const events = await drive(membrane, request, (stream, event) => {
        stream.provideToolResults(okResults(event), {
          injectedMessages: [{ content: [{ type: 'text', text: 'mid-turn note' }] }],
        });
      });

      expect(events.some((e) => e.type === 'complete')).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('XML tool mode'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ChatCompletions-shaped convertMessages: tool_result envelope interlopers', () => {
  // mergeConsecutiveRoles folds the separately-pushed injected user message
  // into the tool_result envelope, so EVERY ChatCompletions-shaped converter
  // must split it back out instead of dropping it.
  const interloperEnvelope = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'text', text: 'Antra: look left!' },
    ],
  };
  const pureEnvelope = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
  };

  const converters: Array<[string, (messages: any[]) => any[]]> = [
    ['OpenAIAdapter', (m) => (new OpenAIAdapter({ apiKey: 'test' }) as any).convertMessages(m)],
    ['OpenRouterAdapter', (m) => (new OpenRouterAdapter({ apiKey: 'test' }) as any).convertMessages(m)],
    ['OpenAICompatibleAdapter', (m) =>
      (new OpenAICompatibleAdapter({ apiKey: 'test', baseURL: 'http://localhost' }) as any).convertMessages(m)],
  ];

  for (const [name, convert] of converters) {
    it(`${name}: emits co-mingled text as a following user message instead of dropping it`, () => {
      const out = convert([interloperEnvelope]);
      expect(out.length).toBe(2);
      expect(out[0].role).toBe('tool');
      expect(out[0].tool_call_id).toBe('tu_1');
      expect(out[1].role).toBe('user');
      const text = typeof out[1].content === 'string'
        ? out[1].content
        : JSON.stringify(out[1].content);
      expect(text).toContain('look left!');
    });

    it(`${name}: pure tool_result envelopes are unchanged`, () => {
      const out = convert([pureEnvelope]);
      expect(out.length).toBe(1);
      expect(out[0].role).toBe('tool');
    });

    it(`${name}: whitespace-only interloper text does not emit an empty user message`, () => {
      const out = convert([
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
            { type: 'text', text: '' },
          ],
        },
      ]);
      expect(out.length).toBe(1);
      expect(out[0].role).toBe('tool');
    });
  }
});
