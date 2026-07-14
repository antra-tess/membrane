import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesAPIAdapter,
  type OpenAIResponsesOutputItem,
} from '../../src/providers/openai-responses-api.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import type { ProviderRequest } from '../../src/types/index.js';
import { MembraneError } from '../../src/types/index.js';

function providerRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'gpt-5.6',
    messages: [],
    maxTokens: 8192,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIResponsesAPIAdapter', () => {
  it('keeps the provider-native formatter when a caller requests a generic native override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_auxiliary',
        model: 'gpt-5.6',
        status: 'completed',
        output: [{
          type: 'message',
          id: 'msg_auxiliary',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'summary' }],
        }],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }),
      { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Sol' },
    );

    await membrane.complete({
      messages: [{ participant: 'Context Manager', content: [{ type: 'text', text: 'Summarize.' }] }],
      config: { model: 'gpt-5.6', maxTokens: 100 },
    }, { formatter: new NativeFormatter() });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Summarize.' }],
    }]);
  });

  it('sends provider-native input items verbatim with stateless encrypted reasoning', async () => {
    const input = [
      { type: 'message', role: 'user', content: 'Inspect this repository.' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        encrypted_content: 'encrypted-reasoning-1',
      },
      {
        type: 'message',
        id: 'msg_commentary',
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        content: [{ type: 'output_text', text: 'I am checking.', annotations: [] }],
      },
      { type: 'function_call', id: 'fc_item_1', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'file data' },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'encrypted-compaction' },
    ];
    const output: OpenAIResponsesOutputItem[] = [
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [],
        encrypted_content: 'encrypted-reasoning-2',
        status: 'completed',
      },
      {
        type: 'compaction',
        id: 'cmp_2',
        encrypted_content: 'encrypted-compaction-2',
        created_by: 'server',
      },
      {
        type: 'message',
        id: 'msg_2',
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Calling a tool.', annotations: [] }],
      },
      {
        type: 'function_call',
        id: 'fc_item_2',
        call_id: 'call_2',
        name: 'patch',
        arguments: '{"path":"src/a.ts"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        id: 'fco_2',
        call_id: 'call_2',
        output: 'patched',
        status: 'completed',
      },
      {
        type: 'message',
        id: 'msg_3',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
      },
    ];

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_1',
        model: 'gpt-5.6-2026-07-01',
        status: 'completed',
        output,
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          input_tokens_details: { cached_tokens: 40 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    let rawRequest: any;
    const adapter = new OpenAIResponsesAPIAdapter({
      apiKey: 'sk-test',
      organization: 'org_test',
      project: 'proj_test',
    });
    const result = await adapter.complete(
      providerRequest({
        messages: input,
        system: 'Follow repository instructions.',
        tools: [{ name: 'patch', description: 'Patch a file', inputSchema: { type: 'object' } }],
        extra: {
          store: true,
          input: [{ type: 'message', role: 'user', content: 'wrong' }],
          include: ['message.output_text.logprobs'],
          reasoning: { effort: 'high', context: 'all_turns' },
        },
      }),
      { onRequest: (request) => { rawRequest = request; } }
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'OpenAI-Organization': 'org_test',
      'OpenAI-Project': 'proj_test',
    });

    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual(input);
    expect(rawRequest.input).toBe(input);
    expect(body.store).toBe(false);
    expect(body.include).toEqual([
      'message.output_text.logprobs',
      'reasoning.encrypted_content',
    ]);
    expect(body.instructions).toBe('Follow repository instructions.');
    expect(body.tools).toEqual([{ type: 'function', name: 'patch', description: 'Patch a file', parameters: { type: 'object' } }]);
    expect(body.reasoning).toEqual({ effort: 'high', context: 'all_turns' });

    // The native array is the lossless continuation surface: IDs, phases,
    // encrypted payloads, and ordering are untouched.
    expect(result.outputItems).toEqual(output);
    expect(result.outputItems.map((item) => item.id)).toEqual([
      'rs_2', 'cmp_2', 'msg_2', 'fc_item_2', 'fco_2', 'msg_3',
    ]);
    expect(result.outputItems[2]?.phase).toBe('commentary');
    expect(result.outputItems[5]?.phase).toBe('final_answer');

    expect(result.content.map((block) => block.type)).toEqual([
      'redacted_thinking',
      'compaction',
      'text',
      'tool_use',
      'tool_result',
      'text',
    ]);
    expect(result.content[0]).toMatchObject({
      type: 'redacted_thinking', data: 'encrypted-reasoning-2', itemId: 'rs_2', outputIndex: 0,
    });
    expect(result.content[1]).toMatchObject({
      type: 'compaction', encryptedContent: 'encrypted-compaction-2', id: 'cmp_2', outputIndex: 1,
    });
    expect(result.content[2]).toMatchObject({
      type: 'text', text: 'Calling a tool.', itemId: 'msg_2', phase: 'commentary', outputIndex: 2,
    });
    expect(result.content[3]).toMatchObject({
      type: 'tool_use', id: 'call_2', itemId: 'fc_item_2', name: 'patch', input: { path: 'src/a.ts' },
    });
    expect(result.content[4]).toMatchObject({
      type: 'tool_result', toolUseId: 'call_2', itemId: 'fco_2', content: 'patched',
    });
    expect(result.content[5]).toMatchObject({ phase: 'final_answer', itemId: 'msg_3' });
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 });
    expect(result.model).toBe('gpt-5.6-2026-07-01');
  });

  it('preserves ordered output items and text deltas when streaming', async () => {
    const output: OpenAIResponsesOutputItem[] = [
      {
        type: 'reasoning',
        id: 'rs_stream',
        summary: [],
        encrypted_content: 'stream-secret',
        status: 'completed',
      },
      {
        type: 'message',
        id: 'msg_stream',
        role: 'assistant',
        phase: 'final_answer',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
      },
    ];
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_stream', summary: [], status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_stream', role: 'assistant', phase: 'final_answer', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'msg_stream', delta: 'Hello ' },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'msg_stream', delta: 'world' },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      {
        type: 'response.completed',
        response: {
          id: 'resp_stream', model: 'gpt-5.6', status: 'completed', output,
          usage: { input_tokens: 12, output_tokens: 3 },
        },
      },
    ];
    const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split in the middle of JSON to exercise the cross-chunk SSE parser.
        controller.enqueue(bytes.slice(0, 137));
        controller.enqueue(bytes.slice(137));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const chunks: string[] = [];
    const blocks: unknown[] = [];
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const result = await adapter.stream(
      providerRequest({ messages: [{ type: 'message', role: 'user', content: 'Hi' }] }),
      {
        onChunk: (chunk) => chunks.push(chunk),
        onContentBlock: (_index, block) => blocks.push(block),
      }
    );

    expect(chunks).toEqual(['Hello ', 'world']);
    expect(result.outputItems).toEqual(output);
    expect(result.outputItems.map((item) => item.id)).toEqual(['rs_stream', 'msg_stream']);
    expect(result.content).toMatchObject([
      { type: 'redacted_thinking', data: 'stream-secret', itemId: 'rs_stream', outputIndex: 0 },
      { type: 'text', text: 'Hello world', itemId: 'msg_stream', phase: 'final_answer', outputIndex: 1 },
    ]);
    expect(blocks).toEqual(result.content);
    expect(result.stopReason).toBe('end_turn');
  });

  it('raises a retryable error when the stream ends without a terminal event', async () => {
    // Deltas arrive, then the connection closes cleanly (proxy/LB drop) with
    // no response.completed / response.incomplete / response.failed / error
    // event. This must NOT be fabricated into a 'completed' response — that
    // would permanently persist a truncated turn with end_turn and 0/0 usage.
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_cut', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_cut', delta: 'Partial ans' },
    ];
    const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close(); // clean EOF, no terminal event
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    const chunks: string[] = [];
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const promise = adapter.stream(
      providerRequest({ messages: [{ type: 'message', role: 'user', content: 'Hi' }] }),
      { onChunk: (chunk) => chunks.push(chunk) }
    );

    await expect(promise).rejects.toBeInstanceOf(MembraneError);
    const error = await promise.catch((e: MembraneError) => e);
    expect(error.type).toBe('network');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/stream ended before a terminal response event/);
    // The deltas were still surfaced live before the drop was detected.
    expect(chunks).toEqual(['Partial ans']);
  });

  it('maps incomplete max-output responses without losing their items', async () => {
    const output: OpenAIResponsesOutputItem[] = [{
      type: 'message',
      id: 'msg_partial',
      role: 'assistant',
      phase: 'commentary',
      status: 'incomplete',
      content: [{ type: 'output_text', text: 'Partial', annotations: [] }],
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'gpt-5.6',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output,
    }), { status: 200 })));

    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const result = await adapter.complete(providerRequest());

    expect(result.stopReason).toBe('max_tokens');
    expect(result.outputItems).toEqual(output);
    expect(result.content[0]).toMatchObject({ phase: 'commentary', itemId: 'msg_partial' });
  });
});
