import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { chunkFrame } from '../helpers/bedrock-event-stream.js';

const thought = 'THOUGHT_SENTINEL';
const visible = 'VISIBLE <function_calls><invoke name="not_a_call"></invoke></function_calls>';
const text = (value: string) => ({ type: 'text' as const, text: value });
afterEach(() => vi.unstubAllGlobals());

function events(signatureOnly = false, xml = false) {
  const result: any[] = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  ];
  if (!xml) result.push(
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', ...(!signatureOnly ? { thinking: '' } : {}) } },
    ...(!signatureOnly ? [{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } }] : []),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_stop', index: 0 },
  );
  result.push(
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: xml ? '<thinking>FROM_XML</thinking>VISIBLE' : visible } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  );
  return result;
}

function setup(provider: string, mode: string, finish: string, signatureOnly = false, wire?: any[]) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const source = wire ?? events(signatureOnly, mode === 'xml');
    const abortAt = finish === 'thinking-abort'
      ? source.findIndex(event => event.delta?.type === 'thinking_delta')
      : finish === 'text-abort' ? source.findIndex(event => event.delta?.type === 'text_delta' && event.delta.text === visible) : -1;
    const frames = (abortAt >= 0 ? source.slice(0, abortAt + 1) : source).map(event => provider === 'anthropic'
      ? new TextEncoder().encode('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
      : chunkFrame(event));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const frame = frames.shift();
        if (frame) controller.enqueue(frame);
        else if (abortAt >= 0) controller.error(new DOMException('aborted by fixture', 'AbortError'));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }));
  const adapter = provider === 'anthropic'
    ? new AnthropicAdapter({ apiKey: 'test' })
    : new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-west-2' });
  // Partial fixtures end the actual transport after the selected typed delta.
  const formatter = mode === 'plain' ? new CompletionsFormatter() : mode === 'xml' ? new AnthropicXmlFormatter() : new NativeFormatter();
  if (mode === 'plain') {
    // A plain parser on a valid user-ended Messages body: transport semantics
    // are independent of the formatter label and parser's prefill convention.
    const build = formatter.buildMessages.bind(formatter);
    formatter.buildMessages = (messages, options) => ({
      ...build(messages, options), messages: [{ role: 'user', content: 'Question' }], assistantPrefill: undefined,
    });
  }
  return new Membrane(adapter, { formatter });
}

async function run(path: string, membrane: Membrane, mode: string, chunks: any[], blocks: any[] = [], extra: any = {}) {
  const request: any = {
    config: { model: 'claude-haiku-4-5', maxTokens: 2048, ...(mode !== 'xml' ? { thinking: { enabled: true, budgetTokens: 1024 } } : {}) },
    messages: [{ participant: 'User', content: [text('Question')] }],
    ...(mode === 'xml' ? { toolMode: 'xml' } : {}),
    ...extra,
  };
  if (path === 'stream') return membrane.stream(request, { onChunk: (chunk, meta) => chunks.push({ chunk, meta }), onBlock: event => blocks.push(event) });
  let result: any;
  for await (const event of membrane.streamYielding(request)) {
    if (event.type === 'block') blocks.push(event.event);
    if (event.type === 'tokens') chunks.push({ chunk: event.content, meta: event.meta });
    if (event.type === 'complete') result = event.response;
    if (event.type === 'aborted') result = event;
    if (event.type === 'error') throw event.error;
  }
  return result;
}

for (const provider of ['anthropic', 'bedrock']) {
  for (const mode of ['plain', 'native']) {
    describe(provider + ' typed thinking in ' + mode, () => {
      for (const finish of ['success', 'thinking-abort', 'text-abort']) {
        it.each(['stream', 'yielding'])(finish + ' via %s keeps thinking typed', async path => {
          const chunks: any[] = [];
          const blocks: any[] = [];
          const response: any = await run(path, setup(provider, mode, finish), mode, chunks, blocks);
          const content = finish === 'success' ? response.content : response.partialContent;
          expect(content).toBeDefined();
          expect(content.filter((block: any) => block.type === 'thinking')).toEqual([{
            type: 'thinking', thinking: thought, ...(finish !== 'thinking-abort' ? { signature: 'signature' } : {}),
          }]);
          expect(content.filter((block: any) => block.type === 'text')).toEqual(finish === 'thinking-abort' ? [] : [text(visible)]);
          expect(response.toolCalls ?? []).toEqual([]);
          expect(chunks.map(item => item.chunk).join('')).not.toContain('<thinking>');
          expect(blocks.map(event => [event.event, event.index, event.block.type])).toEqual([
            ['block_start', 0, 'thinking'],
            ...(finish !== 'thinking-abort' ? [['block_complete', 0, 'thinking'], ['block_start', 1, 'text']] : []),
            ...(finish === 'success' ? [['block_complete', 1, 'text']] : []),
          ]);
          const thinkingChunk = chunks.find(item => item.chunk === thought);
          expect(thinkingChunk?.meta).toMatchObject({ type: 'thinking', visible: false });
          expect(chunks.filter(item => item.meta?.visible).map(item => item.chunk).join('')).not.toContain(thought);
        });
      }
    });
  }
  it.each(['stream', 'yielding'])(provider + ' signature-only thinking survives partial %s', async path => {
    const response: any = await run(path, setup(provider, 'plain', 'text-abort', true), 'plain', []);
    expect(response.partialContent).toEqual([{ type: 'thinking', thinking: '', signature: 'signature' }, text(visible)]);
  });
}

it.each(['stream', 'yielding'])('explicit XML %s retains its textual protocol', async path => {
  const response: any = await run(path, setup('anthropic', 'xml', 'success'), 'xml', []);
  expect(response.content).toEqual([{ type: 'thinking', thinking: 'FROM_XML' }, text('VISIBLE')]);
});

for (const mode of ['plain', 'native']) {
  for (const finish of ['success', 'text-abort']) {
    it.each(['stream', 'yielding'])(mode + ' interleaved text/thinking ' + finish + ' via %s keeps order', async path => {
      const wire = events().map(event => event.index === undefined ? event : { ...event, index: event.index + 1 });
      wire.splice(1, 0,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'BEFORE ' } },
        { type: 'content_block_stop', index: 0 },
      );
      const response: any = await run(path, setup('anthropic', mode, finish, false, wire), mode, []);
      expect(finish === 'success' ? response.content : response.partialContent).toEqual([
        text('BEFORE '), { type: 'thinking', thinking: thought, signature: 'signature' }, text(visible),
      ]);
    });
  }
}
it.each(['stream', 'yielding'])('a stop delimiter in provider thinking does not stop plain %s', async path => {
  const wire = events().map(event => event.delta?.type === 'thinking_delta'
    ? { ...event, delta: { ...event.delta, thinking: thought + 'STOP' } } : event);
  const response: any = await run(path, setup('anthropic', 'plain', 'success', false, wire), 'plain', [], [], { stopSequences: ['STOP'] });
  expect(response.content).toEqual([{ type: 'thinking', thinking: thought + 'STOP', signature: 'signature' }, text(visible)]);
});
it.each(['stream', 'yielding'])('a local text stop in plain %s also bounds block completion', async path => {
  const wire = events().map(event => event.delta?.type === 'text_delta'
    ? { ...event, delta: { ...event.delta, text: 'KEEP STOP AFTER' } } : event);
  const blocks: any[] = [];
  const response: any = await run(path, setup('anthropic', 'plain', 'success', false, wire), 'plain', [], blocks, { stopSequences: ['STOP'] });
  expect(response.content).toEqual([{ type: 'thinking', thinking: thought, signature: 'signature' }, text('KEEP ')]);
  expect(blocks.filter(event => event.event === 'block_complete' && event.block.type === 'text').map(event => event.block.content)).toEqual(['KEEP ']);
});
for (const provider of ['anthropic', 'bedrock']) {
  it.each(['stream', 'yielding'])(provider + ' redacted thinking is retained in partial plain %s', async path => {
    const wire = events(true).filter(event => event.delta?.type !== 'signature_delta').map(event => event.type === 'content_block_start' && event.index === 0
      ? { ...event, content_block: { type: 'redacted_thinking', data: 'OPAQUE' } } : event);
    const response: any = await run(path, setup(provider, 'plain', 'text-abort', false, wire), 'plain', []);
    expect(response.partialContent).toEqual([{ type: 'redacted_thinking', data: 'OPAQUE' }, text(visible)]);
  });
}

it.each(['stream', 'yielding'])('plain %s respects a thinking type reported after an untyped prefix', async path => {
  const adapter: any = {
    name: 'mixed-callbacks', supportsModel: () => true,
    async stream(request: any, callbacks: any) {
      callbacks.onChunk('BEFORE ');
      callbacks.onContentBlock?.(1, { type: 'thinking', thinking: '' });
      callbacks.onChunk(thought);
      callbacks.onContentBlock?.(1, { type: 'thinking', thinking: thought, signature: 'signature' });
      callbacks.onChunk(visible);
      return { content: [text('BEFORE '), { type: 'thinking', thinking: thought, signature: 'signature' }, text(visible)],
        stopReason: 'end_turn', model: request.model, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const chunks: any[] = [];
  const response: any = await run(path, new Membrane(adapter, { formatter: new CompletionsFormatter() }), 'plain', chunks);
  expect(response.content).toEqual([text('BEFORE '), { type: 'thinking', thinking: thought, signature: 'signature' }, text(visible)]);
  expect(chunks.find(item => item.chunk === thought)?.meta).toMatchObject({ type: 'thinking', visible: false });
});
it.each(['stream', 'yielding'])('plain %s keeps finalized-only thinking callbacks in provider order', async path => {
  const adapter: any = {
    name: 'finalized-callbacks', supportsModel: () => true,
    async stream(request: any, callbacks: any) {
      callbacks.onChunk(visible);
      const content = [{ type: 'thinking', thinking: thought, signature: 'signature' }, text(visible)];
      content.forEach((block, index) => callbacks.onContentBlock?.(index, block));
      return { content, stopReason: 'end_turn', model: request.model, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const response: any = await run(path, new Membrane(adapter, { formatter: new CompletionsFormatter() }), 'plain', []);
  expect(response.content).toEqual([{ type: 'thinking', thinking: thought, signature: 'signature' }, text(visible)]);
});
