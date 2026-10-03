import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import type { ContentBlock } from '../../src/types/index.js';

const text = (value: unknown) => ({ type: 'text', text: value });
const base = { model: 'claude-sonnet-4-5', maxTokens: 64 };
function adapter(kind: string): any {
  return kind === 'Anthropic'
    ? new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } })
    : new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-west-2' });
}
afterEach(() => vi.restoreAllMocks());

describe.each(['Anthropic', 'Bedrock'])('%s empty-text guardrails', kind => {
  it.each(['user', 'assistant'])('rejects cleanup that changes an empty final %s turn into the other role', async role => {
    const opposite = role === 'user' ? 'assistant' : 'user';
    for (const content of [' \n', [text(' \n')], [text(null)], []]) {
      const request = { ...base, messages: [
        { role: 'user', content: 'start' },
        { role: opposite, content: [text('retained')] },
        { role, content },
      ] };
      const before = structuredClone(request);
      expect(() => adapter(kind).buildRequest(request)).toThrow(expect.objectContaining({
        type: 'invalid_request', retryable: false, message: expect.stringMatching(/final.*role/i),
      }));
      expect(request).toEqual(before);
    }
  });

  it('drops an empty final message when the final role is preserved', () => {
    const built = adapter(kind).buildRequest({ ...base, messages: [
      { role: 'user', content: 'retained' },
      { role: 'user', content: [text(' \n')] },
    ] });
    expect(built.messages).toEqual([{ role: 'user', content: 'retained' }]);
  });

  it('warns when cleanup removes marked text without logging its content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marked = { ...text(' \n'), cache_control: { type: 'ephemeral' } };
    const built = adapter(kind).buildRequest({ ...base, messages: [
      { role: 'user', content: [text('hello'), marked] },
    ] });
    expect(built.messages[0].content).toEqual([text('hello')]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/removed 1 cache_control marker/));
  });

  it('warns for marked empty text inside tool results and the system', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marked = { ...text(' \n'), cache_control: { type: 'ephemeral' } };
    const built = adapter(kind).buildRequest({
      ...base, system: [marked, text('system')],
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [marked] }] }],
    });
    expect(built.system).toEqual([text('system')]);
    expect(built.messages[0].content[0].content).toEqual([]);
    expect(warn.mock.calls.map(call => call[0]).join(' ')).toMatch(/removed 1 cache_control marker/);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('conversion and native formatting boundaries', () => {
  it('reports loss of a marked invalid text block in the exported Anthropic converter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = toAnthropicContent([
      { ...text(' \n'), cache_control: { type: 'ephemeral' } },
      text('real text'),
    ] as ContentBlock[]);
    expect(result).toEqual([text('real text')]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/removed 1 cache_control marker/));
  });

  it.each(['complete', 'stream', 'yielding'])('strips a later whitespace block after NativeFormatter on %s', async entry => {
    const wire: any[] = [];
    const raw = { model: base.model, content: [text('ok')], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    const a = adapter('Anthropic');
    a.client = { messages: {
      create: async (request: any) => { wire.push(request); return raw; },
      stream: async (request: any) => {
        wire.push(request);
        return (async function* () {
          yield { type: 'message_start', message: { ...raw, content: [] } };
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: raw.usage };
          yield { type: 'message_stop' };
        })();
      },
    } };
    const membrane = new Membrane(a, { formatter: new NativeFormatter() });
    const request: any = {
      messages: [{ participant: 'User', content: [text('hello'), text('\n')] }],
      config: { model: base.model, maxTokens: 64 }, toolMode: 'native',
    };
    if (entry === 'complete') await membrane.complete(request);
    else if (entry === 'stream') await membrane.stream(request);
    else for await (const event of membrane.streamYielding(request)) {
      if (event.type === 'error') throw event.error;
    }
    expect(wire[0].messages[0].content).toEqual([text('User: hello')]);
  });

  it('preserves the exact valid legacy Bedrock system string', () => {
    const built = adapter('Bedrock').buildRequest({
      ...base, messages: [{ role: 'user', content: 'hello' }],
      system: [text('Rules A'), text(''), text('Rules B')],
    }, 'anthropic.claude-3-sonnet-20240229-v1:0');
    expect(built.system).toBe('Rules A\n\n\n\nRules B');
  });
});
