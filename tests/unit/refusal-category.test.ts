/**
 * A refusal's category, from the provider's response to the caller.
 *
 * Anthropic names why it refused in `stop_details.category` (such as
 * 'cyber'). The adapter reports it as `ProviderResponse.refusalCategory`, and
 * membrane's re-issue announces it on `RetryingEvent.category`. Until this
 * field, core read the category from `raw.response.stop_details`, a shape no
 * built-in adapter's raw response has (the Anthropic adapter's raw carries
 * `stop_details` at its top level), so a real refusal's retrying event never
 * carried its category. These tests run the real AnthropicAdapter over a
 * scripted SDK stream, and over a scripted `messages.create` for complete().
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { NormalizedRequest, ProviderRequest, StreamEvent } from '../../src/types/index.js';

const MODEL = 'claude-zz-1';

/** The SDK's MessageStream as the adapter uses it: async-iterable events and a controller. */
function fakeAnthropicStream(events: unknown[]) {
  return {
    controller: { abort() { /* noop */ } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** One response: some text, then the message_delta that stops it with `stop`. */
function round(stop: Record<string, unknown>) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_zz', type: 'message', role: 'assistant', model: MODEL, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: stop, usage: { output_tokens: 5 } },
  ];
}

function scriptedStreams(rounds: unknown[][]) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  let call = 0;
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => {
        const events = rounds[call++];
        if (!events) throw new Error(`unscripted provider call ${call}`);
        return fakeAnthropicStream(events);
      },
    },
  };
  return { adapter, calls: () => call };
}

function scriptedCreate(message: Record<string, unknown>) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };
  return adapter;
}

function normalizedRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
    config: { model: MODEL, maxTokens: 64 },
    toolMode: 'native',
    tools: [{ name: 'zz_lookup', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
  };
}

function providerRequest(): ProviderRequest {
  return { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: 'zz go' }] };
}

const REFUSED_CYBER = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } };

describe('refusal category: streamYielding re-issue through the real AnthropicAdapter', () => {
  it("announces the refused attempt's category on its retrying event", async () => {
    const { adapter, calls } = scriptedStreams([round(REFUSED_CYBER), round({ stop_reason: 'end_turn' })]);
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

    const events: StreamEvent[] = [];
    for await (const event of membrane.streamYielding(normalizedRequest(), { refusalRetries: 1 })) events.push(event);

    expect(calls()).toBe(2);
    expect(events.filter((e) => e.type === 'retrying')).toEqual([
      { type: 'retrying', attempt: 1, maxAttempts: 1, reason: 'refusal', category: 'cyber' },
    ]);
  });
});

describe('refusal category: AnthropicAdapter.stream()', () => {
  it.each([
    ['a refusal with a category', REFUSED_CYBER, 'cyber'],
    ['a refusal whose stop_details is null', { stop_reason: 'refusal', stop_details: null }, undefined],
    ['a refusal with no stop_details', { stop_reason: 'refusal' }, undefined],
    ['a refusal whose stop_details has no category', { stop_reason: 'refusal', stop_details: { type: 'refusal' } }, undefined],
    ['a refusal whose category is not a string', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 7 } }, undefined],
    ['a refusal whose category is empty', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: '' } }, undefined],
    ['another stop that carries a category', { stop_reason: 'end_turn', stop_details: { type: 'refusal', category: 'cyber' } }, undefined],
  ])('%s', async (_name, stop, expected) => {
    const { adapter } = scriptedStreams([round(stop)]);
    const response = await adapter.stream(providerRequest(), { onChunk: () => {} });

    expect(response.refusalCategory).toBe(expected);
    expect('refusalCategory' in response).toBe(expected !== undefined);
  });
});

describe('refusal category: AnthropicAdapter.complete()', () => {
  function message(stop: Record<string, unknown>) {
    return {
      id: 'msg_zz_c', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text: 'zz' }], stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...stop,
    };
  }

  it.each([
    ['a refusal with a category', REFUSED_CYBER, 'cyber'],
    ['a refusal whose stop_details is null', { stop_reason: 'refusal', stop_details: null }, undefined],
    ['a refusal whose category is not a string', { stop_reason: 'refusal', stop_details: { category: ['cyber'] } }, undefined],
    ['another stop that carries a category', { stop_reason: 'end_turn', stop_details: { type: 'refusal', category: 'cyber' } }, undefined],
  ])('%s', async (_name, stop, expected) => {
    const response = await scriptedCreate(message(stop)).complete(providerRequest());

    expect(response.refusalCategory).toBe(expected);
    expect('refusalCategory' in response).toBe(expected !== undefined);
  });
});
