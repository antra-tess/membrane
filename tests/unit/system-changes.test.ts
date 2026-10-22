/**
 * System changes (SystemChangeContent): a message of `system_change` blocks
 * goes out as a mid-conversation `role: 'system'` message, so a caller can
 * change the tools and system text the model is offered without editing the
 * request's `tools` or `system`, which would rewrite the whole cached prefix.
 *
 * Wire shapes and rules are the Anthropic API's, as live runs showed them,
 * Oct 19 and 20 2026: `tool_removal` with a
 * `tool_reference` and `tool_addition` with a `tool_definition` (Opus 5.5,
 * Haiku 5.5), text blocks (Haiku 5.5, Sonnet 5), the inline-tools beta for
 * tool changes, a cache marker taken on any of those blocks (Haiku 5.5), and a
 * 400 with one of three wordings on a model without them (Opus 4.6, Haiku 4.5,
 * Sonnet 5 for tool changes). Placement follows the API's page: after a
 * user turn, a tool-result turn included, and before an assistant turn or at
 * the end.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { AnthropicAdapter, isSystemChangeRefusal } from '../../src/providers/anthropic.js';
import { MembraneError } from '../../src/types/errors.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';
import { toolsOffered } from '../../src/utils/tool-names.js';
import { stripEmptyTextMessages } from '../../src/utils/empty-text.js';
import type {
  ContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  SystemChangeContent,
  ToolDefinition,
} from '../../src/types/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const schema = { type: 'object' as const, properties: { city: { type: 'string' as const } }, required: ['city'] };
const tool = (name: string, description = `Tool ${name}.`): ToolDefinition => ({ name, description, inputSchema: schema });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const user = (t: string): NormalizedMessage => ({ participant: 'User', content: [text(t)] });
const reply = (...content: ContentBlock[]): NormalizedMessage => ({ participant: 'Claude', content });
const change = (c: Omit<SystemChangeContent, 'type'>): SystemChangeContent => ({ type: 'system_change', ...c });
const changes = (...blocks: SystemChangeContent[]): NormalizedMessage => ({ participant: 'Harness', content: blocks });
const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'get_time', input: { city: 'Paris' } });
const result = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'noon' });

const options = { participantMode: 'simple' as const, assistantParticipant: 'Claude', humanParticipant: 'User', tools: [tool('get_time')] };
const build = (messages: NormalizedMessage[], extra: Record<string, unknown> = {}) =>
  new NativeFormatter().buildMessages(messages, { ...options, ...extra });
const roles = (built: { messages: Array<{ role: string }> }) => built.messages.map((m) => m.role);
/** Each built message's first text, or its role for one with none: enough to see where a system message went. */
const shape = (built: { messages: Array<{ role: string; content: unknown }> }) => built.messages.map((m) => {
  const first = (m.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  return `${m.role}:${first?.text ?? (m.content as Array<{ type: string }>)[0]?.type}`;
});

describe('NativeFormatter: a message of system changes', () => {
  it('goes as a role "system" message: removals, then definitions in their native form, then text, block after block', () => {
    const built = build([
      user('hello'),
      changes(
        change({ removeTools: ['get_time'], defineTools: [tool('srv:get_weather', 'Weather.')], addSystem: ['Use metric units.', ''] }),
        change({ addSystem: ['Answer briefly.'], removeTools: ['srv:get_weather'] }),
      ),
    ]);
    expect(roles(built)).toEqual(['user', 'system']);
    expect(built.messages[1]!.content).toEqual([
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'get_time' } },
      { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'srv__get_weather', description: 'Weather.', input_schema: schema } } },
      { type: 'text', text: 'Use metric units.' },
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'srv__get_weather' } },
      { type: 'text', text: 'Answer briefly.' },
    ]);
  });

  it('is read by its blocks, not its participant, even in simple mode', () => {
    const built = build([user('hello'), { participant: 'Nobody', content: [change({ addSystem: ['Note.'] })] }]);
    expect(roles(built)).toEqual(['user', 'system']);
  });

  it('carrying nothing is skipped, as an empty message is', () => {
    expect(roles(build([user('hello'), changes(change({ addSystem: [''] }), change({}))]))).toEqual(['user']);
  });

  it('refuses a message mixing a system change with other blocks', () => {
    expect(() => build([user('hello'), { participant: 'User', content: [text('hi'), change({ addSystem: ['x'] })] }]))
      .toThrow(/holds a system_change block beside other blocks/);
  });

  it('refuses a definition whose wire name is another tool\'s, and takes a redefinition by the same name', () => {
    expect(() => build([user('hello'), changes(change({ defineTools: [tool('get:time')] }))], { tools: [tool('get__time')] }))
      .toThrow(/collide after colon escaping/);
    expect(() => build([user('hello'), changes(change({ removeTools: ['get:time'] }))], { tools: [tool('get__time')] }))
      .toThrow(/collide after colon escaping/);
    expect(roles(build([user('hello'), changes(change({ defineTools: [tool('get_time', 'Redefined.')] }))]))).toEqual(['user', 'system']);
  });
});

describe('NativeFormatter: where a system message goes', () => {
  it('stays between a user turn and the assistant turn after it', () => {
    expect(shape(build([user('u0'), changes(change({ addSystem: ['s1'] })), reply(text('a2'))])))
      .toEqual(['user:u0', 'system:s1', 'assistant:a2']);
  });

  it('stays at the end after a user turn', () => {
    expect(shape(build([user('u0'), changes(change({ addSystem: ['s1'] }))]))).toEqual(['user:u0', 'system:s1']);
  });

  it('between a tool call and its result, goes after the result', () => {
    const built = build([user('u0'), reply(call('t1')), changes(change({ addSystem: ['s2'] })), { participant: 'User', content: [result('t1')] }, reply(text('a4'))]);
    expect(roles(built)).toEqual(['user', 'assistant', 'user', 'system', 'assistant']);
    expect((built.messages[2]!.content as Array<{ type: string }>)[0]!.type).toBe('tool_result');
  });

  it('between two user turns, goes after both, which merge', () => {
    const built = build([user('u0'), changes(change({ addSystem: ['s1'] })), user('u2'), reply(text('a3'))]);
    expect(roles(built)).toEqual(['user', 'system', 'assistant']);
    expect((built.messages[0]!.content as Array<{ text: string }>).map((b) => b.text)).toEqual(['u0', 'u2']);
  });

  it('first, goes after the first user turn', () => {
    expect(shape(build([changes(change({ addSystem: ['s0'] })), user('u1'), reply(text('a2'))])))
      .toEqual(['user:u1', 'system:s0', 'assistant:a2']);
  });

  it('after an assistant turn, goes after the next user turn, never before a turn that came before it', () => {
    const built = build([user('u0'), reply(text('a1')), changes(change({ addSystem: ['s2'] })), reply(text('a3')), user('u4'), reply(text('a5'))]);
    expect(shape(built)).toEqual(['user:u0', 'assistant:a1', 'user:u4', 'system:s2', 'assistant:a5']);
  });

  it('keeps adjacent system messages in their order', () => {
    expect(shape(build([user('u0'), changes(change({ addSystem: ['s1'] })), changes(change({ addSystem: ['s2'] })), reply(text('a3'))])))
      .toEqual(['user:u0', 'system:s1', 'system:s2', 'assistant:a3']);
  });

  it('goes after the user turn before it when a contextPrefix opens the conversation', () => {
    const built = build([user('u0'), changes(change({ addSystem: ['s1'] })), reply(text('a2'))], { contextPrefix: 'Seed.' });
    const at = built.messages.findIndex((m) => m.role === 'system');
    expect(shape(built).slice(at - 1, at + 2)).toEqual(['user:u0', 'system:s1', 'assistant:a2']);
  });

  it('with no point at or after its place, as after a final assistant turn, is refused before sending', () => {
    let thrown: unknown;
    try {
      build([user('u0'), reply(text('a1')), changes(change({ addSystem: ['s2'] }))]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MembraneError);
    expect(thrown).toMatchObject({ type: 'unsupported', retryable: false, systemChangeRefused: true });
  });
});

describe('NativeFormatter: cache markers and system messages', () => {
  const caching = { promptCaching: true };
  it('a breakpoint on a message of system changes goes on its last block', () => {
    const marked = { ...changes(change({ removeTools: ['get_time'], defineTools: [tool('get_weather')] })), cacheBreakpoint: true };
    const built = build([user('u0'), marked, reply(text('a2'))], caching);
    const blocks = built.messages[1]!.content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.cache_control)).toEqual([undefined, { type: 'ephemeral' }]);
  });

  it('a boundary goes where it would with the changes left out, never on a system message, which can land past later turns', () => {
    const s = changes(change({ addSystem: ['s'] }));
    const marked = (messages: NormalizedMessage[], at: number) => build(messages, {
      ...caching,
      hasCacheMarker: (_m: NormalizedMessage, index: number) => index === at,
    }).messages.flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b.cache_control).map((b) => `${m.role}:${b.text}`));
    // The change lands after u4, past a3: the boundary before a3 stays after a1, as without the change.
    expect(marked([user('u0'), reply(text('a1')), s, reply(text('a3')), user('u4'), reply(text('a5'))], 3)).toEqual(['assistant:a1']);
    expect(marked([user('u0'), reply(text('a1')), reply(text('a3')), user('u4'), reply(text('a5'))], 2)).toEqual(['assistant:a1']);
    // Landing right before the boundary's message, it still takes none.
    expect(marked([user('u0'), s, reply(text('a2'))], 2)).toEqual(['user:u0']);
    expect(marked([user('u0'), reply(text('a1')), s, user('u2'), reply(text('a3'))], 4)).toEqual(['user:u2']);
  });
});

/** A native adapter that records each request, and says whether it sends system changes. */
class RecordingAdapter implements ProviderAdapter {
  readonly name = 'recording';
  requests: ProviderRequest[] = [];
  constructor(readonly sendsSystemChanges?: boolean) {}
  supportsModel(): boolean {
    return true;
  }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, raw: {} };
  }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    callbacks.onChunk('ok');
    return this.complete(request);
  }
}

const request = (messages: NormalizedMessage[]): NormalizedRequest => ({
  messages,
  config: { model: 'claude-opus-5-5', maxTokens: 100 },
  tools: [tool('get_time')],
  toolMode: 'native',
});

describe('Membrane: a request carrying a system change', () => {
  const messages = [user('u0'), changes(change({ defineTools: [tool('get_weather')] }))];

  it.each([
    ['the default formatter (AnthropicXmlFormatter)', undefined, true],
    ['NativeFormatter through an adapter that does not send them', new NativeFormatter(), false],
  ] as const)('through %s is refused before sending', async (_label, formatter, sends) => {
    const adapter = new RecordingAdapter(sends);
    const membrane = new Membrane(adapter, formatter ? { formatter } : {});
    for (const run of [() => membrane.complete(request(messages)), () => membrane.stream(request(messages), {})]) {
      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ systemChangeRefused: true, retryable: false });
    }
    expect(adapter.requests).toEqual([]);
  });

  it('through NativeFormatter and an adapter that sends them, goes as a role "system" message', async () => {
    const adapter = new RecordingAdapter(true);
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request(messages));
    expect(adapter.requests[0]!.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'system']);
    expect(new AnthropicXmlFormatter().rendersSystemChanges).toBeUndefined();
  });

  it('a request carrying none goes through an adapter that doesn\'t send them', async () => {
    const adapter = new RecordingAdapter(false);
    await new Membrane(adapter).complete(request([user('u0')]));
    expect(adapter.requests).toHaveLength(1);
  });
});

describe('AnthropicAdapter and system changes', () => {
  const ok = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };

  it('declares that it sends them', () => {
    expect(new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } }).sendsSystemChanges).toBe(true);
  });

  it('adds the inline-tools beta when a system message changes tools, beside a default beta, and not for system text alone', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } });
    (adapter as any).client = { messages: { create: async (_body: unknown, opts: { headers?: Record<string, string> }) => {
      seen.push(opts.headers);
      return ok;
    } } };
    const base = { model: 'claude-opus-5-5', maxTokens: 100 };
    const hello = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
    await adapter.complete({ ...base, messages: [hello, { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'x' } }] }] } as any);
    await adapter.complete({ ...base, messages: [hello, { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'y' } } }] }] } as any);
    await adapter.complete({ ...base, messages: [hello, { role: 'system', content: [{ type: 'text', text: 'Note.' }] }] } as any);
    expect(seen.map((h) => h?.['anthropic-beta'])).toEqual([
      'oauth-2025-04-20,inline-tools-2026-09-15',
      'oauth-2025-04-20,inline-tools-2026-09-15',
      undefined,
    ]);
  });

  it('marks a 400 refusing the system change, keeping its classification, and no other 400', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const classify = (message: string, status = 400) =>
      (adapter as any).handleError(new Anthropic.APIError(status, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers()), { model: 'm' });
    for (const wording of [
      "role 'system' is not supported on this model",
      'tool_addition/tool_removal requires a model that supports mid-conversation system content; this model does not',
      'tool_addition/tool_removal is not supported on this model',
    ]) {
      const error = classify(wording);
      expect(error).toBeInstanceOf(MembraneError);
      expect(error).toMatchObject({ type: 'invalid_request', httpStatus: 400, retryable: false, systemChangeRefused: true });
      expect(error.toErrorInfo().systemChangeRefused).toBe(true);
    }
    expect(classify('messages.1: a system message must follow a user turn').systemChangeRefused).toBeUndefined();
    expect(classify("role 'system' is not supported on this model", 500).systemChangeRefused).toBeUndefined();
    // Only the provider's own message counts, not a rendering of the request.
    expect(isSystemChangeRefusal({ error: { message: 'max_tokens: too large' }, request: "role 'system' is not supported on this model" })).toBe(false);
  });
});

describe('system changes: placement edges, markers, names, the beta and refusals', () => {
  const caching = { promptCaching: true };
  const anyOfSchema = {
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
    ],
  };
  const anyOfSnapshot = structuredClone(anyOfSchema);

  it('a change carrying only whitespace text is skipped, as the API refuses whitespace text', () => {
    expect(roles(build([user('hello'), changes(change({ addSystem: ['  ', '\n'] }))]))).toEqual(['user']);
  });

  it('a removal frees its wire name, so a later definition that sanitizes to it is taken', () => {
    const built = build([user('hello'), changes(change({ removeTools: ['a:b'] }), change({ defineTools: [tool('a__b')] }))], { tools: [tool('a:b')] });
    expect(roles(built)).toEqual(['user', 'system']);
  });

  it('two definitions through system changes whose wire names collide are refused', () => {
    expect(() => build([user('hello'), changes(change({ defineTools: [tool('x:y')] })), changes(change({ defineTools: [tool('x__y')] }))]))
      .toThrow(/collide after colon escaping/);
  });

  it('a turn the empty-text cleanup drops is no point: the change goes at the end after the next user turn', () => {
    const built = build([user('u0'), changes(change({ addSystem: ['s1'] })), reply(text('   ')), user('u3')]);
    expect(roles(built)).toEqual(['user', 'assistant', 'user', 'system']);
  });

  it('a turn server-block pairing empties, an unpaired server call alone, is no point: its user neighbours merge and the change follows them', () => {
    const carrier = (item: unknown): ContentBlock => ({ type: 'text', text: '', rawItem: item } as ContentBlock);
    const serverUse = { type: 'server_tool_use', id: 'srvtoolu_x1', name: 'web_search', input: { query: 'x' } };
    const built = build([user('ask'), changes(change({ addSystem: ['s1'] })), reply(carrier(serverUse)), user('next'), reply(text('a4'))], { anthropicServerBlocks: true });
    expect(shape(built)).toEqual(['user:ask', 'system:s1', 'assistant:a4']);
  });

  it('a boundary on the message of system changes itself goes on the message before it', () => {
    const built = build([user('u0'), changes(change({ addSystem: ['s1'] })), reply(text('a2'))], {
      ...caching,
      hasCacheMarker: (_m: NormalizedMessage, index: number) => index === 1,
    });
    expect((built.messages[0]!.content as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect((built.messages[1]!.content as Array<Record<string, unknown>>)[0]!.cache_control).toBeUndefined();
  });

  it('a marker on a system message counts: it suppresses the system fallback, and counts toward the budget of four', () => {
    const marked = (t: string) => ({ ...changes(change({ addSystem: [t] })), cacheBreakpoint: true });
    const one = build([user('u0'), marked('s1')], { ...caching, systemPrompt: 'Sys.' });
    expect(JSON.stringify(one.systemContent)).not.toContain('cache_control');
    expect(() => build([user('u0'), marked('s1'), marked('s2'), marked('s3'), marked('s4'), marked('s5')], { ...caching, cacheMarkers: 'cm-owned' }))
      .toThrow(/cache_control limit exceeded: 5 markers \(maximum 4\)/);
  });

  it('registers the system message\'s blocks as its own, so an adapter\'s report names it', () => {
    const fidelity = new FidelityNotes();
    const built = build([user('u0'), changes(change({ addSystem: ['s1'] }))], { fidelity });
    const block = (built.messages[1]!.content as object[])[0];
    expect(fidelity.ownerOf(block)).toBe(1);
  });

  it('flattens a definition\'s root union in the adapter, as it does for tools', async () => {
    const bodies: any[] = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async (body: unknown) => {
      bodies.push(body);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const definition = { name: 'pick', description: 'Pick.', input_schema: anyOfSchema };
    await adapter.complete({ model: 'claude-opus-5-5', maxTokens: 100, messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition } }] },
    ] } as any);
    const sent = bodies[0].messages[1].content[0].tool.definition.input_schema;
    expect(sent.anyOf).toBeUndefined();
    expect(sent.type).toBe('object');
    expect(Object.keys(sent.properties).sort()).toEqual(['a', 'b']);
    expect(definition.input_schema).toBe(anyOfSchema);
    expect(anyOfSchema).toEqual(anyOfSnapshot);
  });

  /** An adapter that sends system changes and answers with a call to `srv__get_weather`. */
  class CallingAdapter extends RecordingAdapter {
    override async complete(request: ProviderRequest): Promise<ProviderResponse> {
      this.requests.push(request);
      return {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'srv__get_weather', input: { city: 'Paris' } }],
        stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, raw: {},
      } as ProviderResponse;
    }
  }

  it('a call to a tool a change defined comes back under the name the change gave it', async () => {
    const messages = [user('u0'), changes(change({ defineTools: [tool('srv:get_weather')] }))];
    const membrane = new Membrane(new CallingAdapter(true), { formatter: new NativeFormatter() });
    const completed = await membrane.complete(request(messages));
    expect(completed.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'srv:get_weather' });
    const streamed = await membrane.stream(request(messages), {});
    expect(streamed.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'srv:get_weather' });
  });

  it('tools a change defines count as tools when the tool mode is chosen, and that refusal comes first, unflagged', async () => {
    // An adapter that doesn't send system changes, so its flagged refusal would come if the tool-mode check didn't come first.
    const membrane = new Membrane(new RecordingAdapter(false), { formatter: new NativeFormatter() });
    const xml: NormalizedRequest = { ...request([user('u0'), changes(change({ defineTools: [tool('get_weather')] }))]), tools: undefined, toolMode: 'xml' };
    let thrown: unknown;
    try {
      await membrane.complete(xml);
    } catch (error) {
      thrown = error;
    }
    expect(String((thrown as Error).message)).toMatch(/cannot carry xml tool definitions/);
    expect((thrown as { systemChangeRefused?: boolean }).systemChangeRefused).toBeUndefined();
  });

  it('through streamYielding, a refusal before sending comes as the stream\'s error', async () => {
    const adapter = new RecordingAdapter(false);
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const events: Array<{ type: string; error?: unknown }> = [];
    for await (const event of membrane.streamYielding(request([user('u0'), changes(change({ addSystem: ['s1'] }))]), {})) events.push(event as never);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]!.error).toMatchObject({ systemChangeRefused: true });
    expect(adapter.requests).toEqual([]);
  });

  it('through Membrane and the real AnthropicAdapter: the change goes as a system message with the beta, and the API\'s refusal reaches the caller marked', async () => {
    const calls: Array<{ body: any; headers?: Record<string, string> }> = [];
    let refuse = false;
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: {
      create: async (body: unknown, opts: { headers?: Record<string, string> }) => {
        calls.push({ body, headers: opts?.headers });
        if (refuse) {
          throw new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: "role 'system' is not supported on this model" } }, undefined, new Headers());
        }
        return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
      },
      stream: () => { throw new Error('not used'); },
    } };
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const messages = [user('u0'), changes(change({ defineTools: [tool('get_weather')], addSystem: ['Metric.'] }))];
    await membrane.complete(request(messages));
    expect(calls[0]!.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'system']);
    expect(calls[0]!.headers?.['anthropic-beta']).toBe('inline-tools-2026-09-15');
    refuse = true;
    await expect(membrane.complete(request(messages))).rejects.toMatchObject({ systemChangeRefused: true, httpStatus: 400 });
  });
});

describe('system changes: the empty-text cleanup, alterations, and the tools a request offers', () => {
  const ws = (t = '   '): ContentBlock => text(t);

  describe('placement reads the turns the empty-text cleanup leaves', () => {
    it('a user turn the cleanup drops leaves the assistant turn after it no point', () => {
      // u0, a1, S, uWS, a4, u5: the cleanup drops uWS, and a1 and a4 are one assistant turn.
      expect(roles(build([user('u0'), reply(text('a1')), changes(change({ addSystem: ['s'] })), user('   '), reply(text('a4')), user('u5')])))
        .toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'system']);
    });

    it('a final user turn the cleanup drops is no end point', () => {
      expect(() => build([user('u0'), reply(text('a1')), changes(change({ addSystem: ['s'] })), user('   ')]))
        .toThrow(/has no place the API takes one/);
    });

    it('a run of dropped turns is skipped: the previous surviving turn decides', () => {
      // u0, S, aWS, uWS, a4: after cleanup u0 then a4, so S goes before a4.
      expect(roles(build([user('u0'), changes(change({ addSystem: ['s'] })), reply(ws()), user('   '), reply(text('a4'))])))
        .toEqual(['user', 'assistant', 'user', 'system', 'assistant']);
    });

    it('a turn is dated by the blocks that survive the cleanup', () => {
      // aWS and a3 merge into one assistant turn; its surviving block is a3's, after S.
      expect(shape(build([user('u0'), reply(ws()), changes(change({ addSystem: ['s'] })), reply(text('a3')), user('u4')])))
        .toEqual(['user:u0', 'system:s', 'assistant:   ', 'user:u4']);
    });
  });

  it('whitespace system text left out reports its message altered; an empty one does not', () => {
    const altered = (addSystem: string[]) => {
      const fidelity = new FidelityNotes();
      build([user('u0'), changes(change({ addSystem }))], { fidelity });
      return [...fidelity.altered];
    };
    expect(altered(['  ', 'Keep this.'])).toEqual([1]);
    expect(altered(['', 'Keep this.'])).toEqual([]);
  });

  it('the adapter reports a flattened definition as an alteration of its message', async () => {
    const altered: unknown[] = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }) } };
    const definition = { name: 'pick', description: 'Pick.', input_schema: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] } };
    const flattened = { type: 'tool_addition', tool: { type: 'tool_definition', definition } };
    const plain = { type: 'tool_addition', tool: { type: 'tool_definition', definition: { ...definition, input_schema: schema } } };
    await adapter.complete({ model: 'claude-opus-5-5', maxTokens: 100, messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [flattened, plain] },
    ] } as any, { onContentAltered: (block?: unknown) => altered.push(block) } as any);
    // The block itself: a report is attributed by looking its block up by identity.
    expect(altered).toHaveLength(1);
    expect(altered[0]).toBe(flattened);
  });

  describe('the tools a request offers', () => {
    it('takes several definitions, across blocks, with removals and redefinitions in order', () => {
      const offered = toolsOffered({
        tools: [tool('a'), tool('b')],
        messages: [
          changes(change({ defineTools: [tool('c'), tool('d')] }), change({ removeTools: ['a'], defineTools: [tool('b', 'B again.')] })),
          user('u'),
          changes(change({ removeTools: ['c'] })),
        ],
      });
      expect(offered.map((t) => t.name).sort()).toEqual(['b', 'd']);
      expect((offered.find((t) => t.name === 'b') as ToolDefinition).description).toBe('B again.');
    });

    it('a reply restores against them: a removed tool no longer holds a wire name a later definition takes', async () => {
      class Replying extends RecordingAdapter {
        override async complete(req: ProviderRequest): Promise<ProviderResponse> {
          this.requests.push(req);
          return { content: [{ type: 'tool_use', id: 'toolu_1', name: 'p__q', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
        }
      }
      const membrane = new Membrane(new Replying(true), { formatter: new NativeFormatter() });
      const response = await membrane.complete({ ...request([user('u0'), changes(change({ removeTools: ['p__q'], defineTools: [tool('p:q')] }))]), tools: [tool('p__q')] });
      expect(response.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'p:q' });
    });
  });

  /** Replies in script order through stream(), announcing each block as a provider does. */
  class Scripted extends RecordingAdapter {
    constructor(private readonly replies: ContentBlock[][]) { super(true); }
    override async stream(req: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
      this.requests.push(req);
      const content = this.replies[this.requests.length - 1] ?? [text('done')];
      content.forEach((block, index) => {
        callbacks.onContentBlock?.(index, block);
        callbacks.onContentBlock?.(index, block);
      });
      const toolUse = content.some((b) => b.type === 'tool_use');
      return { content, stopReason: toolUse ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
    }
  }
  const wireCall = (id: string, name: string): ContentBlock => ({ type: 'tool_use', id, name, input: {} });

  it('stream(): a block event names a change-defined tool as the caller does', async () => {
    const events: Array<{ event: string; block?: { toolName?: string } }> = [];
    const membrane = new Membrane(new Scripted([[wireCall('t1', 'srv__get_weather')]]), { formatter: new NativeFormatter() });
    await membrane.stream(request([user('u0'), changes(change({ defineTools: [tool('srv:get_weather')] }))]), {
      onBlock: (event: any) => events.push(event),
      onToolCalls: async (calls: Array<{ id: string }>) => calls.map((c) => ({ toolUseId: c.id, content: 'ok' })),
    } as any);
    expect(events.filter((e) => e.event === 'block_complete').map((e) => e.block?.toolName)).toContain('srv:get_weather');
  });

  it('streamYielding(): tool calls and block events name a change-defined tool, and a change injected mid-turn counts in the next round', async () => {
    const adapter = new Scripted([[wireCall('t1', 'srv__get_weather')], [wireCall('t2', 'srv__later')]]);
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const stream = membrane.streamYielding(request([user('u0'), changes(change({ defineTools: [tool('srv:get_weather')] }))]), { emitBlocks: true } as any);
    const calls: string[] = [];
    const blockNames: string[] = [];
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'block' && event.event.event === 'block_complete' && event.event.block.toolName) blockNames.push(event.event.block.toolName);
      if (event.type === 'tool-calls') {
        calls.push(...event.calls.map((c: { name: string }) => c.name));
        const results = event.calls.map((c: { id: string }) => ({ toolUseId: c.id, content: 'ok' }));
        if (calls.length === 1) {
          stream.provideToolResults(results, { injectedMessages: [{ participant: 'Harness', content: [change({ defineTools: [tool('srv:later')] })] }] } as any);
        } else {
          stream.provideToolResults(results);
        }
      }
    }
    expect(calls).toEqual(['srv:get_weather', 'srv:later']);
    expect(blockNames).toEqual(['srv:get_weather', 'srv:later']);
  });
});

describe('system changes: turns as the API reads them, the float, and withdrawn tools', () => {
  const ws = (t = '   '): ContentBlock => text(t);
  const s = changes(change({ addSystem: ['s'] }));

  describe('placement reads the turns the API reads after the cleanup', () => {
    it('an assistant turn joined across a dropped user turn is dated by all its blocks, a contextPrefix\'s included', () => {
      // Begin., Seed., uWS, a2: the cleanup drops uWS, and Seed. and a2 are one assistant turn after
      // Begin., dated by a2. S came before a2, so it goes before that turn.
      expect(shape(build([user('   '), s, reply(text('a2'))], { contextPrefix: 'Seed.', prefillUserMessage: 'Begin.' })))
        .toEqual(['user:Begin.', 'system:s', 'assistant:Seed.', 'user:   ', 'assistant:a2']);
    });

    it('a trailing assistant turn the cleanup drops leaves the end a point', () => {
      expect(shape(build([user('u0'), s, reply(ws())]))).toEqual(['user:u0', 'assistant:   ', 'system:s']);
    });

    it('goes before an assistant turn of tool calls only', () => {
      expect(roles(build([user('u0'), s, reply(call('t1')), { participant: 'User', content: [result('t1')] }])))
        .toEqual(['user', 'system', 'assistant', 'user']);
    });

    it('an assistant turn of another provider\'s unsigned thinking alone is no point, since the adapter leaves the block out (#191)', () => {
      // u0, aU, u2, a3: the adapter leaves aU out, so u0 and u2 are one user turn, and S goes before a3.
      // Placed before aU, S would sit between u0 and u2 once aU is gone, where the API refuses a system message.
      const unsigned: ContentBlock = { type: 'thinking', thinking: 'reasoning from another provider' };
      expect(shape(build([user('u0'), s, reply(unsigned), user('u2'), reply(text('a3'))])))
        .toEqual(['user:u0', 'assistant:thinking', 'user:u2', 'system:s', 'assistant:a3']);
    });

    it('an unsigned thinking block doesn\'t date the turn it shares with later blocks', () => {
      // u0, aU, S, a3, u4: aU and a3 are one assistant turn, dated by a3 since the adapter leaves aU
      // out, so S goes before that turn, as it does for a whitespace block in its place.
      const unsigned: ContentBlock = { type: 'thinking', thinking: 'reasoning from another provider' };
      expect(roles(build([user('u0'), reply(unsigned), s, reply(text('a3')), user('u4')])))
        .toEqual(['user', 'system', 'assistant', 'user']);
    });

    it('a trailing turn of unsigned thinking alone leaves the end a point, as a trailing turn of whitespace does', () => {
      const unsigned: ContentBlock = { type: 'thinking', thinking: 'reasoning from another provider' };
      expect(shape(build([user('u0'), s, reply(unsigned)]))).toEqual(['user:u0', 'assistant:thinking', 'system:s']);
    });
  });

  it('through the real AnthropicAdapter, whitespace the cleanup drops is left out of what is sent, and the change keeps its place', async () => {
    const sent: Array<{ messages: Array<{ role: string }> }> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async (body: { messages: Array<{ role: string }> }) => {
      sent.push(body);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    // u0, aWS, S, a3, u4: aWS and a3 are one assistant turn, dated by a3, after S.
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request([user('u0'), reply(ws()), s, reply(text('a3')), user('u4')]));
    expect(sent[0]!.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    // The whitespace block merged into a3's message, and the cleanup took it out of what is sent.
    const assistantTexts = (sent[0]!.messages[2] as unknown as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === 'text').map((b) => b.text);
    expect(assistantTexts).toEqual(['a3']);
  });

  it('through the real AnthropicAdapter, a turn of unsigned thinking alone is left out, and the change goes before the next assistant turn (#191)', async () => {
    const sent: Array<{ messages: Array<{ role: string }> }> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async (body: { messages: Array<{ role: string }> }) => {
      sent.push(body);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const unsigned: ContentBlock = { type: 'thinking', thinking: 'reasoning from another provider' };
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request([user('u0'), s, reply(unsigned), user('u2'), reply(text('a3')), user('u4')]));
    expect(sent[0]!.messages.map((m) => m.role)).toEqual(['user', 'user', 'system', 'assistant', 'user']);
  });

  it('through the real AnthropicAdapter, a trailing turn of unsigned thinking alone with a change after the last user turn is dropped, not refused (#191)', async () => {
    // The change ends the request after the trailing turn, so leaving the turn out doesn't change
    // the final role, as for a trailing turn of whitespace.
    const sent: Array<{ messages: Array<{ role: string }> }> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async (body: { messages: Array<{ role: string }> }) => {
      sent.push(body);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const unsigned: ContentBlock = { type: 'thinking', thinking: 'reasoning from another provider' };
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request([user('u0'), s, reply(unsigned)]));
    expect(sent[0]!.messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('the previous round\'s endpoint the float marks is the message before the assistant turn that made the round\'s calls, a change injected at the end included', async () => {
    class ToolOnce extends RecordingAdapter {
      override async stream(req: ProviderRequest): Promise<ProviderResponse> {
        this.requests.push(req);
        const content: ContentBlock[] = this.requests.length === 1 ? [call('t1')] : [text('done')];
        return { content, stopReason: this.requests.length === 1 ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
      }
    }
    const adapter = new ToolOnce(true);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request([user('u0')]));
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'tool-calls') {
        stream.provideToolResults(event.calls.map((c: { id: string }) => ({ toolUseId: c.id, content: 'noon' })), {
          injectedMessages: [{ participant: 'Harness', content: [change({ addSystem: ['later'] })] }],
        } as any);
      }
    }
    const second = adapter.requests[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
    const marked = second.map((m) => m.content.some((b) => b.cache_control !== undefined));
    expect(marked).toEqual([true, false, false, true]);
  });

  it('a change withdrawing the last tool leaves no tools, so no tool-mode refusal comes first', async () => {
    const withdrawn = [user('u0'), changes(change({ removeTools: ['get_time'] }))];
    // CompletionsFormatter carries no tools: with one offered, its tool-mode refusal would come first, unflagged.
    let thrown: unknown;
    try {
      await new Membrane(new RecordingAdapter(true), { formatter: new CompletionsFormatter() }).complete({ ...request(withdrawn), toolMode: 'auto' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ systemChangeRefused: true });
  });

  describe('the tools a request offers', () => {
    const names = (offered: readonly ToolDefinition[]) => offered.map((t) => t.name).sort();
    it('an initial tool nothing touches stays', () => {
      expect(names(toolsOffered({ tools: [tool('a')], messages: [changes(change({ defineTools: [tool('b')] }))] }))).toEqual(['a', 'b']);
    });
    it('several definitions in one block all stay', () => {
      expect(names(toolsOffered({ tools: [], messages: [changes(change({ defineTools: [tool('c'), tool('d'), tool('e')] }))] }))).toEqual(['c', 'd', 'e']);
    });
    it('a removal and a redefinition of one tool in one change leave the redefinition', () => {
      const offered = toolsOffered({ tools: [tool('a')], messages: [changes(change({ removeTools: ['a'], defineTools: [tool('a', 'A again.')] }))] });
      expect(offered.map((t) => [t.name, t.description])).toEqual([['a', 'A again.']]);
    });
  });
});

describe('system changes: whole messages the cleanup empties, and the float\'s second target', () => {
  const ws = (t = '   '): ContentBlock => text(t);
  const s = changes(change({ addSystem: ['s'] }));
  const firstText = (m: { content: unknown }) =>
    typeof m.content === 'string' ? m.content : (m.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text;
  const realAdapter = () => {
    const sent: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async (body: { messages: Array<{ role: string; content: unknown }> }) => {
      sent.push(body);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    return { adapter, sent };
  };

  it('through the real AnthropicAdapter, a whole message the cleanup empties is left out, and the change goes after the user turn it leaves', async () => {
    const { adapter, sent } = realAdapter();
    // u0, S, aWS, u2, a4, u5: Membrane names a user message's participant, so only an assistant message
    // empties. aWS sits between two user messages, so no merge takes it: the cleanup drops it whole, u0 and
    // u2 are one user turn, and S, which came before aWS, goes after u2, before a4. Placed before aWS, it
    // would sit between two user messages once aWS is gone.
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request([user('u0'), s, reply(ws()), user('u2'), reply(text('a4')), user('u5')]));
    expect(sent[0]!.messages.map((m) => m.role)).toEqual(['user', 'user', 'system', 'assistant', 'user']);
    expect(sent[0]!.messages.map(firstText)).toEqual(['User: u0', 'User: u2', 's', 'a4', 'User: u5']);
  });

  describe('the formatter\'s placement, then the adapter\'s empty-text cleanup (utils/empty-text.ts)', () => {
    // Simple participant mode adds no name, so a user message of whitespace empties too.
    const sentAfterCleanup = (messages: NormalizedMessage[]) => stripEmptyTextMessages(build(messages).messages);

    it('whole messages of either role the cleanup empties are left out, and the change goes between the turns that survive', () => {
      // u0, aWS, uWS, S, a3, u4: the cleanup drops aWS and uWS, so S follows u0 and comes before a3.
      const cleaned = sentAfterCleanup([user('u0'), reply(ws()), user('   '), s, reply(text('a3')), user('u4')]);
      expect(cleaned.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
      expect(cleaned.map(firstText)).toEqual(['u0', 's', 'a3', 'u4']);
    });

    it('a change after a user turn whose later turns the cleanup empties goes at the end, and the cleanup\'s final-role check passes', () => {
      const cleaned = sentAfterCleanup([user('u0'), reply(ws()), user('   '), s]);
      expect(cleaned.map((m) => m.role)).toEqual(['user', 'system']);
      expect(cleaned.map(firstText)).toEqual(['u0', 's']);
    });
  });

  it('an assistant turn with no surviving user turn before it is no point: the change is refused, flagged', () => {
    let thrown: unknown;
    try {
      build([user('   '), s, reply(text('a2'))]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ systemChangeRefused: true });
    expect(String((thrown as Error).message)).toMatch(/has no place the API takes one/);
  });

  it('the float\'s second target is a change placed before a later round\'s assistant turn, when the previous request ended there', async () => {
    class ToolTwice extends RecordingAdapter {
      override async stream(req: ProviderRequest): Promise<ProviderResponse> {
        this.requests.push(req);
        const n = this.requests.length;
        const content: ContentBlock[] = n < 3 ? [call(`t${n}`)] : [text('done')];
        return { content, stopReason: n < 3 ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
      }
    }
    const adapter = new ToolTwice(true);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request([user('u0')]));
    let round = 0;
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'tool-calls') {
        round++;
        stream.provideToolResults(event.calls.map((c: { id: string }) => ({ toolUseId: c.id, content: 'noon' })), {
          injectedMessages: [{ participant: 'Harness', content: [change({ addSystem: [`s${round}`] })] }],
        } as any);
      }
    }
    // Round 3: u0, A1, R1, S1, A2, R2, S2. Round 2 ended at S1, which now sits before A2.
    const third = adapter.requests[2]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system', 'assistant', 'user', 'system']);
    expect(third.map((m) => m.content.some((b) => b.cache_control !== undefined))).toEqual([false, false, false, true, false, false, true]);
  });

  it('the float\'s second target walks back over consecutive assistant messages, for a formatter that leaves them unmerged', async () => {
    // A formatter that sends an assistant message's blocks as one message each, as a custom formatter may.
    class SplittingFormatter extends NativeFormatter {
      override buildMessages(messages: NormalizedMessage[], opts: Parameters<NativeFormatter['buildMessages']>[1]) {
        const built = super.buildMessages(messages, opts);
        built.messages = built.messages.flatMap((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.length > 1
          ? (m.content as unknown[]).map((block) => ({ ...m, content: [block] }))
          : [m]) as typeof built.messages;
        return built;
      }
    }
    class TalkThenCall extends RecordingAdapter {
      override async stream(req: ProviderRequest): Promise<ProviderResponse> {
        this.requests.push(req);
        const first = this.requests.length === 1;
        const content: ContentBlock[] = first ? [text('let me check'), call('t1')] : [text('done')];
        return { content, stopReason: first ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
      }
    }
    const adapter = new TalkThenCall(true);
    const stream = new Membrane(adapter, { formatter: new SplittingFormatter() }).streamYielding(request([user('u0')]));
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'tool-calls') stream.provideToolResults(event.calls.map((c: { id: string }) => ({ toolUseId: c.id, content: 'noon' })));
    }
    // Round 2: u0, A1a (text), A1b (call), R1. Round 1 ended at u0, before both assistant messages.
    const second = adapter.requests[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
    expect(second.map((m) => m.content.some((b) => b.cache_control !== undefined))).toEqual([true, false, false, true]);
  });

  it('the float\'s second target is the previous request\'s last message when an assistant-role message is injected with the results, with no change in the request', async () => {
    class ToolOnce extends RecordingAdapter {
      override async stream(req: ProviderRequest): Promise<ProviderResponse> {
        this.requests.push(req);
        const first = this.requests.length === 1;
        const content: ContentBlock[] = first ? [call('t1')] : [text('done')];
        return { content, stopReason: first ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
      }
    }
    const adapter = new ToolOnce(true);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request([user('u0'), reply(text('a0')), user('u1')]));
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'tool-calls') {
        stream.provideToolResults(event.calls.map((c: { id: string }) => ({ toolUseId: c.id, content: 'noon' })), {
          injectedMessages: [{ participant: 'Claude', content: [text('a note')] }],
        } as any);
      }
    }
    // Round 2: u0, a0, u1, A1 (call), R1, the injected note. Round 1 ended at u1, before the turn that made the call;
    // the note is the newest assistant message, and the results are the message before it.
    const second = adapter.requests[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(second.map((m) => m.content.some((b) => b.cache_control !== undefined))).toEqual([false, false, true, false, false, true]);
  });

  it('the float\'s second target, when the previous request ended with an assistant message, is the message before the turn that message joined', async () => {
    class ToolThrice extends RecordingAdapter {
      override async stream(req: ProviderRequest): Promise<ProviderResponse> {
        this.requests.push(req);
        const n = this.requests.length;
        const content: ContentBlock[] = n < 4 ? [call(`t${n}`)] : [text('done')];
        return { content, stopReason: n < 4 ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, raw: {} } as ProviderResponse;
      }
    }
    const adapter = new ToolThrice(true);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request([user('u0'), reply(text('a0')), user('u1')]));
    let round = 0;
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === 'tool-calls') {
        round++;
        stream.provideToolResults(event.calls.map((c: { id: string }) => ({ toolUseId: c.id, content: 'noon' })), round < 3
          ? { injectedMessages: [{ participant: 'Claude', content: [text(`note ${round}`)] }] } as any
          : undefined);
      }
    }
    type Wire = Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const marked = (messages: Wire) => messages.map((m) => m.content.some((b) => b.cache_control !== undefined));
    // Round 2: u0, a0, u1, A1, R1, N1: the previous request's last message (u1) and the newest; R1 is left unmarked.
    expect(marked(adapter.requests[1]!.messages as Wire)).toEqual([false, false, true, false, false, true]);
    // Round 3: u0, a0, u1, A1, R1, [N1 A2], R2, N2. Round 2 ended at N1, which NativeFormatter merges into the turn that
    // made round 2's call, so the second mark goes on R1, the message before that turn (main's rule marked the turn).
    const third = adapter.requests[2]!.messages as Wire;
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(marked(third)).toEqual([false, false, false, false, true, false, false, true]);
    // Round 4: ..., R1, [N1 A2], R2, [N2 A3], R3, with nothing injected in round 3: R2, as main's rule marked too.
    const fourth = adapter.requests[3]!.messages as Wire;
    expect(fourth.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(marked(fourth)).toEqual([false, false, false, false, false, false, true, false, true]);
  });
});
