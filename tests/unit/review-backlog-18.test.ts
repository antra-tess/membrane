import { describe, expect, it } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { BuildResult } from '../../src/formatters/types.js';
import type { NormalizedRequest, ProviderAdapter, ProviderRequest, ProviderResponse } from '../../src/types/index.js';

const messages: NormalizedRequest['messages'] = [
  { participant: 'Alice', content: [
    { type: 'text', text: '' },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'World' },
  ] },
  { participant: 'Bob', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'there' }] },
  { participant: 'Claude', content: [{ type: 'text', text: 'Answer' }, { type: 'text', text: 'continued' }] },
];

function request(): NormalizedRequest {
  return {
    messages: structuredClone(messages),
    config: { model: 'test-model', maxTokens: 1000 },
    promptCaching: false,
    toolMode: 'native',
    tools: [{ name: 'noop', description: 'does nothing', inputSchema: { type: 'object' } }],
  };
}

function recordingAdapter(toolRound = false): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    name: 'backlog-test',
    requests,
    supportsModel: () => true,
    async complete(req) {
      requests.push(structuredClone(req));
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    },
    async stream(req, callbacks) {
      requests.push(structuredClone(req));
      const call = toolRound && requests.length === 1;
      const content = call
        ? [{ type: 'tool_use', id: 'call-1', name: 'noop', input: {} }]
        : [{ type: 'text', text: 'done' }];
      if (!call) callbacks.onChunk('done');
      return { content, stopReason: call ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} } as ProviderResponse;
    },
  };
}

function textBlocks(wireMessages: unknown): Array<{ text: string; cache_control?: unknown }> {
  return (wireMessages as Array<{ content: Array<{ type: string; text: string }> }>)
    .flatMap(m => m.content).filter(b => b.type === 'text');
}

describe('participant prefixes (#18)', () => {
  it('prefixes the first retained text block of each multiuser message only', () => {
    const built = new NativeFormatter({ nameFormat: '[{name}] ' }).buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'Claude', promptCaching: false,
    });
    expect(textBlocks(built.messages).map(b => b.text)).toEqual(['[Alice] Hello', 'World', '[Bob] Hi', 'there', 'Answer', 'continued']);
    expect(textBlocks(built.messages)[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[0].content[2]).toMatchObject({ text: 'Hello' });
  });

  it('keeps simple-mode text unprefixed', () => {
    const built = new NativeFormatter({ nameFormat: '[{name}] ' }).buildMessages([messages[0]], {
      participantMode: 'simple', humanParticipant: 'Alice', assistantParticipant: 'Claude', promptCaching: false,
    });
    expect(textBlocks(built.messages).map(b => b.text)).toEqual(['Hello', 'World']);
  });

  it.each(['complete', 'stream', 'yielding'] as const)('uses the active formatter name format on %s', async (entry) => {
    const adapter = recordingAdapter();
    // Yielding uses the instance formatter; complete/stream also support an override.
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter({ nameFormat: entry === 'yielding' ? '@{name}: ' : 'WRONG {name}: ' }) });
    const req = request();
    const options = { formatter: new NativeFormatter({ nameFormat: '@{name}: ' }) };
    if (entry === 'complete') {
      await membrane.complete(req, options);
    } else if (entry === 'stream') {
      await membrane.stream(req, options);
    } else {
      for await (const event of membrane.streamYielding(req)) {
        if (event.type === 'error') throw event.error;
      }
    }
    expect(textBlocks(adapter.requests[0].messages).map(b => b.text)).toEqual(['@Alice: Hello', 'World', '@Bob: Hi', 'there', 'Answer', 'continued']);
  });

  it.each(['stream', 'yielding'] as const)('retains the default prefix for the default formatter on %s', async (entry) => {
    const adapter = recordingAdapter();
    const membrane = new Membrane(adapter);
    if (entry === 'stream') await membrane.stream(request(), {});
    else for await (const event of membrane.streamYielding(request())) {
      if (event.type === 'error') throw event.error;
    }
    expect(textBlocks(adapter.requests[0].messages).map(b => b.text)).toEqual(['Alice: Hello', 'World', 'Bob: Hi', 'there', 'Answer', 'continued']);
  });
});

describe('beforeRequest original-turn contract (#18)', () => {
  it.each(['stream', 'yielding'] as const)('keeps normalized input stable while raw %s requests advance', async (entry) => {
    const adapter = recordingAdapter(true);
    const seen: Array<{ normalized: NormalizedRequest; raw: ProviderRequest }> = [];
    const membrane = new Membrane(adapter, {
      hooks: { beforeRequest: (normalized, raw) => { seen.push({ normalized, raw: structuredClone(raw) as ProviderRequest }); } },
    });
    const req = request();
    const originalMessages = structuredClone(req.messages);
    const result = { toolUseId: 'call-1', content: 'TOOL_RESULT_MARKER' };
    if (entry === 'stream') {
      await membrane.stream(req, { onToolCalls: async () => [result] });
    } else {
      const stream = membrane.streamYielding(req);
      for await (const event of stream) {
        if (event.type === 'tool-calls') stream.provideToolResults([result]);
        if (event.type === 'error') throw event.error;
      }
    }
    expect(seen).toHaveLength(2);
    expect(seen[0].normalized).toBe(req);
    expect(seen[1].normalized).toBe(req);
    expect(req.messages).toEqual(originalMessages);
    expect(JSON.stringify(seen[0].raw)).not.toContain('TOOL_RESULT_MARKER');
    expect(JSON.stringify(seen[1].raw)).toContain('TOOL_RESULT_MARKER');
  });
});

describe('empty-system continuation omission (#18)', () => {
  it.each(['plain', 'images'] as const)('omits an empty system array in %s continuations and copies nonempty blocks', (kind) => {
    const membrane = new Membrane(recordingAdapter()) as any;
    const build = (systemContent: unknown) => {
      const result: BuildResult = { messages: [{ role: 'user', content: 'hello' }], stopSequences: [], systemContent };
      return kind === 'plain'
        ? membrane.buildContinuationRequest(request(), result, 'answer')
        : membrane.buildContinuationRequestWithImages(request(), result, 'answer', [], 'closing');
    };
    expect(build([]).system).toBeUndefined();
    expect(build(undefined).system).toBeUndefined();
    expect(build('rules').system).toBe('rules');
    const system = [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }];
    const built = build(system);
    expect(built.system).toEqual(system);
    expect(built.system).not.toBe(system);
    expect(built.system[0]).not.toBe(system[0]);
  });
});
