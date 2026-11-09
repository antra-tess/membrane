/**
 * A change of `output_config.effort` at the top of a request rewrites the whole cached prefix.
 *
 * In the Anthropic API, under the beta `mid-conversation-output-config-2026-07-01`: a `role: 'system'`
 * message with empty content and `output_config: { effort }` changes the effort: for the reply to the user turn
 * it directly follows, when that turn holds new input, and otherwise from the next user turn with new input
 * (Anthropic's effort documentation, "Change effort mid-conversation").
 * Claude Opus 5.5 took one before the last user turn, before a tool result, and with no top-level effort;
 * Claude Opus 5 took one before the last user turn. Fable 5, Haiku 4.5 and Sonnet 4.6 refused it with a 400
 * saying "output_config.effort requires a model that supports per-turn effort; this model does not", and
 * without the beta the API refused it as "messages.2.output_config: Extra inputs are not permitted".
 * Opus 5.5 took one at the end after a user turn, and as the first message. Sonnet 5.5 with
 * `thinking: between_tools` and Haiku 5.5 with thinking disabled refused one that differs from the level in
 * effect, saying "effort cannot change when thinking is disabled on this model". Opus 5.5 refused a request
 * ending with one after an assistant turn as an assistant prefill.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicAdapter, isSystemChangeRefusal } from '../../src/providers/anthropic.js';
import { MembraneError } from '../../src/types/errors.js';
import { stripEmptyTextMessages } from '../../src/utils/empty-text.js';
import * as membraneModule from '../../src/index.js';
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
const tool = (name: string): ToolDefinition => ({ name, description: `Tool ${name}.`, inputSchema: schema });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const user = (t: string): NormalizedMessage => ({ participant: 'User', content: [text(t)] });
const reply = (...content: ContentBlock[]): NormalizedMessage => ({ participant: 'Claude', content });
const change = (c: Omit<SystemChangeContent, 'type'>): SystemChangeContent => ({ type: 'system_change', ...c });
const changes = (...blocks: SystemChangeContent[]): NormalizedMessage => ({ participant: 'Harness', content: blocks });
const effort = (level: NonNullable<SystemChangeContent['effort']>): NormalizedMessage => changes(change({ effort: level }));
const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'get_time', input: { city: 'Paris' } });
const result = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'noon' });

const options = { participantMode: 'simple' as const, assistantParticipant: 'Claude', humanParticipant: 'User', tools: [tool('get_time')] };
const build = (messages: NormalizedMessage[], extra: Record<string, unknown> = {}) =>
  new NativeFormatter().buildMessages(messages, { ...options, ...extra });
const roles = (built: { messages: Array<{ role: string }> }) => built.messages.map((m) => m.role);
const marker = (level: string) => ({ role: 'system', content: [], output_config: { effort: level } });

describe('NativeFormatter: an effort-only system change', () => {
  it('goes as a role "system" message with empty content and the effort as output_config', () => {
    const built = build([user('u0'), reply(text('a1')), effort('low'), user('u3')]);
    expect(roles(built)).toEqual(['user', 'assistant', 'system', 'user']);
    expect(built.messages[2]).toEqual(marker('low'));
  });

  it('goes where the caller puts it, before the user turn after it, where a tool change goes after that turn', () => {
    expect(roles(build([user('u0'), reply(text('a1')), effort('high'), user('u3'), reply(text('a4'))])))
      .toEqual(['user', 'assistant', 'system', 'user', 'assistant']);
    expect(roles(build([user('u0'), reply(text('a1')), changes(change({ addSystem: ['s'] })), user('u3'), reply(text('a4'))])))
      .toEqual(['user', 'assistant', 'user', 'system', 'assistant']);
  });

  it('between a tool call and its result, goes before the result', () => {
    const built = build([user('u0'), reply(call('t1')), effort('medium'), { participant: 'User', content: [result('t1')] }]);
    expect(roles(built)).toEqual(['user', 'assistant', 'system', 'user']);
    expect(built.messages[2]).toEqual(marker('medium'));
  });

  it('inside a run of user messages that merge, goes before the run', () => {
    const built = build([user('u0'), reply(text('a1')), user('u2'), effort('max'), user('u4')]);
    expect(roles(built)).toEqual(['user', 'assistant', 'system', 'user']);
  });

  it('at the end after a user turn, goes at the end', () => {
    const built = build([user('u0'), reply(text('a1')), user('u2'), effort('xhigh')]);
    expect(roles(built)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(built.messages[3]).toEqual(marker('xhigh'));
  });

  it('at the end after an assistant turn, which would end the request on that turn, is refused before sending, flagged', () => {
    let thrown: unknown;
    try {
      build([user('u0'), reply(text('a1')), effort('xhigh')]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ systemChangeRefused: true, retryable: false });
  });

  it('keeps its place beside a tool change: each goes where its own rule puts it, and two that land together keep their order', () => {
    const kinds = (messages: NormalizedMessage[]) => build(messages).messages
      .map((m) => m.role === 'system' ? ((m as { output_config?: unknown }).output_config ? 'effort' : 'change') : m.role);
    const s = changes(change({ addSystem: ['s'] }));
    expect(kinds([user('u0'), reply(text('a1')), s, effort('low'), user('u4'), reply(text('a5'))]))
      .toEqual(['user', 'assistant', 'effort', 'user', 'change', 'assistant']);
    expect(kinds([user('u0'), effort('low'), s, reply(text('a3'))])).toEqual(['user', 'effort', 'change', 'assistant']);
    expect(kinds([user('u0'), s, effort('low'), reply(text('a3'))])).toEqual(['user', 'change', 'effort', 'assistant']);
    expect(kinds([user('u0'), s, effort('low')])).toEqual(['user', 'change', 'effort']);
    expect(kinds([user('u0'), effort('low'), s])).toEqual(['user', 'effort', 'change']);
  });

  it('carries nothing else: a block with effort and another change, or a message with an effort block beside another, is refused, unflagged', () => {
    for (const messages of [
      [user('u0'), changes(change({ effort: 'low', addSystem: ['s'] })), user('u2')],
      [user('u0'), changes(change({ effort: 'low', removeTools: ['get_time'] })), user('u2')],
      [user('u0'), changes(change({ effort: 'low' }), change({ addSystem: ['s'] })), user('u2')],
    ]) {
      let thrown: unknown;
      try {
        build(messages);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MembraneError);
      expect((thrown as MembraneError).systemChangeRefused).toBeUndefined();
    }
  });

  it('a breakpoint on it, or a boundary at it, goes on the last block before it, which it carries none of its own to hold', () => {
    const marked = (built: { messages: Array<{ role: string; content: unknown }> }) =>
      built.messages.flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b.cache_control).map((b) => `${m.role}:${b.text}`));
    expect(marked(build([user('u0'), reply(text('a1')), { ...effort('low'), cacheBreakpoint: true }, user('u3')], { promptCaching: true })))
      .toEqual(['assistant:a1']);
    expect(marked(build([user('u0'), reply(text('a1')), effort('low'), user('u3')], {
      promptCaching: true,
      hasCacheMarker: (_m: NormalizedMessage, index: number) => index === 2,
    }))).toEqual(['assistant:a1']);
  });
});

describe('the empty-text cleanup and an effort-only system message', () => {
  it('keeps it, though its content is empty', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'u0' }] }, marker('low'), { role: 'user', content: [{ type: 'text', text: 'u2' }] }];
    expect(stripEmptyTextMessages(messages)).toEqual(messages);
  });

  it('still drops a system message with empty content and no effort', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'u0' }] }, { role: 'system', content: [] }, { role: 'user', content: [{ type: 'text', text: 'u2' }] }];
    expect(stripEmptyTextMessages(messages)).toEqual([messages[0], messages[2]]);
  });
});

describe('AnthropicAdapter and an effort-only system message', () => {
  const ok = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };

  it('adds the mid-conversation output_config beta when a message carries output_config, beside the others, and not otherwise', async () => {
    const seen: Array<{ headers?: Record<string, string>; body: any }> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } });
    (adapter as any).client = { messages: { create: async (body: any, opts: { headers?: Record<string, string> }) => {
      seen.push({ headers: opts.headers, body });
      return ok;
    } } };
    const base = { model: 'claude-opus-5-5', maxTokens: 100 };
    const hello = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
    await adapter.complete({ ...base, messages: [hello, marker('low'), hello] } as any);
    await adapter.complete({ ...base, messages: [hello, { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'x' } }] }, marker('low'), hello] } as any);
    await adapter.complete({ ...base, messages: [hello] } as any);
    expect(seen.map((s) => s.headers?.['anthropic-beta'])).toEqual([
      'oauth-2025-04-20,mid-conversation-output-config-2026-07-01',
      'oauth-2025-04-20,inline-tools-2026-09-15,mid-conversation-output-config-2026-07-01',
      undefined,
    ]);
    expect(seen[0]!.body.messages[1]).toEqual(marker('low'));
  });

  it('marks the API\'s refusal of per-turn effort, and not the refusal of a top-level effort, which the same request without the change meets too', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const classify = (message: string) =>
      (adapter as any).handleError(new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers()), { model: 'm' });
    for (const wording of [
      'output_config.effort requires a model that supports per-turn effort; this model does not',
      "messages.2: output_config.effort 'low' differs from the 'high' in effect before it; effort cannot change when thinking is disabled on this model. Use effort 'high', or enable thinking.",
    ]) {
      expect(classify(wording)).toMatchObject({ type: 'invalid_request', httpStatus: 400, retryable: false, systemChangeRefused: true });
    }
    expect(classify('This model does not support the effort parameter.').systemChangeRefused).toBeUndefined();
    expect(isSystemChangeRefusal({ error: { message: 'output_config.effort requires a model that supports per-turn effort; this model does not' } })).toBe(true);
  });
});

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

describe('Membrane: a request carrying an effort-only system change', () => {
  const messages = [user('u0'), reply(text('a1')), effort('low'), user('u3')];

  it('through an adapter that does not send system changes, such as Bedrock\'s, is refused before sending, flagged', async () => {
    const adapter = new RecordingAdapter(false);
    await expect(new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request(messages)))
      .rejects.toMatchObject({ systemChangeRefused: true, retryable: false });
    expect(adapter.requests).toEqual([]);
  });

  it('through NativeFormatter and the real AnthropicAdapter: goes as the effort-only message with the beta, and the API\'s refusal reaches the caller marked', async () => {
    const calls: Array<{ body: any; headers?: Record<string, string> }> = [];
    let refuse = false;
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: {
      create: async (body: unknown, opts: { headers?: Record<string, string> }) => {
        calls.push({ body, headers: opts?.headers });
        if (refuse) {
          throw new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort requires a model that supports per-turn effort; this model does not' } }, undefined, new Headers());
        }
        return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
      },
      stream: () => { throw new Error('not used'); },
    } };
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    await membrane.complete(request(messages));
    expect(calls[0]!.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'system', 'user']);
    expect(calls[0]!.body.messages[2]).toEqual(marker('low'));
    expect(calls[0]!.headers?.['anthropic-beta']).toBe('mid-conversation-output-config-2026-07-01');
    refuse = true;
    await expect(membrane.complete(request(messages))).rejects.toMatchObject({ systemChangeRefused: true, httpStatus: 400 });
  });
});

describe('the package', () => {
  it('declares that its system change carries effort', () => {
    expect(membraneModule.SYSTEM_CHANGE_EFFORT).toBe(true);
  });
});
