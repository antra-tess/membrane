import { describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { ContentBlock, NormalizedRequest } from '../../src/types/index.js';

const invalidText = ['', ' \t\n', undefined, null, 0, false, {}];
const emptyBlocks = () => invalidText.map(text => ({ type: 'text', text }));
const text = (value: string) => ({ type: 'text', text: value });
const image = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
};
const thinking = { type: 'thinking', thinking: '', signature: 'opaque-signature' };
const base = { model: 'claude-sonnet-4-5', maxTokens: 64 };

function makeAdapter(kind: string): any {
  return kind === 'Anthropic'
    ? new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: false })
    : new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-west-2' });
}

describe.each(['Anthropic', 'Bedrock'])('%s empty text at the wire boundary', kind => {
  it('drops empty, whitespace and non-string text blocks and empty messages without mutating input', () => {
    const valid = { ...text('  keep whitespace around real text \n'), cache_control: { type: 'ephemeral' } };
    const request = {
      ...base,
      messages: [
        { role: 'user', content: emptyBlocks() },
        { role: 'assistant', content: [] },
        { role: 'user', content: ' \n\t' },
        { role: 'assistant', content: '' },
        { role: 'user', content: [...emptyBlocks(), valid, image] },
        { role: 'assistant', content: [thinking, ...emptyBlocks()] },
      ],
    };
    const before = structuredClone(request);
    const built = makeAdapter(kind).buildRequest(request);
    expect(built.messages).toEqual([
      { role: 'user', content: [valid, image] },
      { role: 'assistant', content: [thinking] },
    ]);
    expect(request).toEqual(before);
    // Applying the wire pass again preserves the same payload.
    expect(makeAdapter(kind).buildRequest({ ...base, messages: built.messages }).messages).toEqual(built.messages);
  });

  it('strips text inside tool results but preserves empty tool results and the tool cycle', () => {
    const request = {
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: {} }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call', content: [...emptyBlocks(), text('ok'), image] },
          { type: 'tool_result', tool_use_id: 'empty-array', content: emptyBlocks(), is_error: true },
          { type: 'tool_result', tool_use_id: 'empty-string', content: '' },
        ] },
      ],
    };
    const built = makeAdapter(kind).buildRequest(request);
    expect(built.messages[0]).toEqual(request.messages[0]);
    expect(built.messages[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call', content: [text('ok'), image] },
      { type: 'tool_result', tool_use_id: 'empty-array', content: [], is_error: true },
      { type: 'tool_result', tool_use_id: 'empty-string', content: '' },
    ]);
  });

  it('filters system blocks while retaining valid text and its cache marker', () => {
    const valid = { ...text('  system \n'), cache_control: { type: 'ephemeral' } };
    const built = makeAdapter(kind).buildRequest({
      ...base, messages: [{ role: 'user', content: 'hello' }],
      system: [...emptyBlocks(), valid],
    });
    expect(built.system).toEqual([valid]);
  });

  it('sanitizes system text before the Bedrock legacy Sonnet flattening path', () => {
    const built = makeAdapter(kind).buildRequest({
      ...base, messages: [{ role: 'user', content: 'hello' }],
      system: [...emptyBlocks(), text('system')],
    }, 'anthropic.claude-3-sonnet-20240229-v1:0');
    expect(built.system).toEqual(kind === 'Bedrock' ? 'system' : [text('system')]);
  });

  it.each(['', ' \t\n', [], emptyBlocks()].map(system => ({ system })))('omits an empty system prompt: $system', ({ system }) => {
    const built = makeAdapter(kind).buildRequest({
      ...base, messages: [{ role: 'user', content: 'hello' }], system,
    });
    expect(built).not.toHaveProperty('system');
  });

  it('applies the same boundary to message and system overrides in extra', () => {
    const built = makeAdapter(kind).buildRequest({
      ...base, messages: [{ role: 'user', content: 'original' }], system: 'original',
      extra: {
        messages: [{ role: 'user', content: [...emptyBlocks(), text('override')] }],
        system: emptyBlocks(),
      },
    });
    expect(built.messages).toEqual([{ role: 'user', content: [text('override')] }]);
    expect(built).not.toHaveProperty('system');
  });

  it('does not invent content when every message is empty', () => {
    const built = makeAdapter(kind).buildRequest({
      ...base, messages: [{ role: 'user', content: emptyBlocks() }],
    });
    expect(built.messages).toEqual([]);
  });

  it.each(['complete', 'stream'])('sanitizes before %s transport and onRequest observation', async lane => {
    const adapter = makeAdapter(kind);
    const sent: any[] = [];
    const raw = {
      model: base.model, content: [text('ok')], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (kind === 'Anthropic') {
      adapter.client = { messages: {
        create: async (request: any) => { sent.push(request); return raw; },
        stream: async (request: any) => {
          sent.push(request);
          return (async function* () {
            yield { type: 'message_start', message: { ...raw, content: [] } };
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: raw.usage };
            yield { type: 'message_stop' };
          })();
        },
      } };
    } else {
      adapter.invokeModel = async (_model: string, request: any) => {
        sent.push(request);
        return raw;
      };
      adapter.invokeModelWithStream = async (_model: string, request: any) => {
        sent.push(request);
        return { content: raw.content, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: base.model };
      };
    }
    const onRequest = vi.fn();
    const request = { ...base, messages: [{ role: 'user', content: [...emptyBlocks(), text('hello')] }] };
    if (lane === 'complete') await adapter.complete(request, { onRequest });
    else await adapter.stream(request, { onChunk() {} }, { onRequest });
    expect(sent).toHaveLength(1);
    expect(sent[0].messages).toEqual([{ role: 'user', content: [text('hello')] }]);
    expect(onRequest.mock.calls[0]?.[0].messages).toEqual(sent[0].messages);
  });
});

describe('filter before native participant prefixes', () => {
  const messages = [
    { participant: 'User', content: [...emptyBlocks(), text('hello')] as ContentBlock[] },
    { participant: 'User', content: emptyBlocks() as ContentBlock[] },
    { participant: 'Claude', content: [...emptyBlocks(), text('answer')] as ContentBlock[] },
  ];

  it('NativeFormatter drops invalid text instead of turning it into participant labels', () => {
    const built = new NativeFormatter().buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'Claude',
    });
    expect(built.messages).toEqual([
      { role: 'user', content: [text('User: hello')] },
      { role: 'assistant', content: [text('answer')] },
    ]);
  });

  it('native tool requests drop invalid text before prefixing', () => {
    const membrane = new Membrane(new MockAdapter());
    const request: NormalizedRequest = { messages, config: { model: 'test', maxTokens: 64 } };
    const built = (membrane as any).buildNativeToolRequest(request, messages);
    expect(built.messages).toEqual([
      { role: 'user', content: [text('User: hello')] },
      { role: 'assistant', content: [text('answer')] },
    ]);
  });

  it('the exported Anthropic converter filters both top-level and nested text', () => {
    const blocks = [
      ...emptyBlocks(), text(' real text '), thinking,
      { type: 'tool_result', toolUseId: 'call', content: [...emptyBlocks(), text('ok')] },
    ] as ContentBlock[];
    expect(toAnthropicContent(blocks)).toEqual([
      text(' real text '), thinking,
      { type: 'tool_result', tool_use_id: 'call', content: [text('ok')], is_error: undefined },
    ]);
  });
});
