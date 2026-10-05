/**
 * Bedrock prompt caching (Connectome issue #35).
 *
 * Two Bedrock-specific behaviors that together made caching unusable there:
 *
 * 1. Bedrock accepts `cache_control: { type: 'ephemeral' }` but rejects the
 *    direct-API `ttl` extension as an extra input. buildRequest must strip
 *    the ttl (keeping the marker) wherever a breakpoint can land: message
 *    content blocks, system array blocks, and tool entries.
 *
 * 2. The stream parser must surface cache_creation_input_tokens /
 *    cache_read_input_tokens. Before 2026-07-31 only complete() did, so
 *    streamed calls reported zero cache activity forever and there was no
 *    way to observe whether caching worked at all.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import type { ProviderRequest } from '../../src/types/index.js';

function adapter(): BedrockAdapter {
  return new BedrockAdapter({
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    region: 'us-west-2',
  });
}

function buildRequest(request: unknown): Record<string, any> {
  return (adapter() as unknown as {
    buildRequest(r: ProviderRequest): Record<string, any>;
  }).buildRequest(request as ProviderRequest);
}

// ── AWS event-stream frame crafting (same shape as
//    bedrock-stream-stop-sequence.test.ts; the adapter reads lengths and
//    headers but does not validate CRCs) ──

function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let o = 0;
  out[o++] = nameBytes.length;
  out.set(nameBytes, o); o += nameBytes.length;
  out[o++] = 7; // string type
  new DataView(out.buffer).setUint16(o, valueBytes.length, false); o += 2;
  out.set(valueBytes, o);
  return out;
}

function chunkFrame(event: unknown): Uint8Array {
  const inner = new TextEncoder().encode(JSON.stringify(event));
  const b64 = Buffer.from(inner).toString('base64');
  const payload = new TextEncoder().encode(JSON.stringify({ bytes: b64 }));
  const headers = stringHeader(':event-type', 'chunk');
  const totalLength = 12 + headers.length + payload.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.length, false);
  frame.set(headers, 12);
  frame.set(payload, 12 + headers.length);
  return frame;
}

function streamBody(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BedrockAdapter cache_control ttl strip', () => {
  it('preserves all four caller-owned message breakpoints and their order', () => {
    const body = buildRequest({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      maxTokens: 100,
      messages: Array.from({ length: 4 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{
          type: 'text',
          text: `marker-${index}`,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
      })),
      system: 'unmarked-system',
    });

    expect(body.messages.map((message: any) => message.content[0].text)).toEqual([
      'marker-0', 'marker-1', 'marker-2', 'marker-3',
    ]);
    expect(body.messages.flatMap((message: any) => message.content)
      .filter((block: any) => block.cache_control)).toHaveLength(4);
    expect(body.messages.every((message: any) =>
      message.content[0].cache_control?.ttl === undefined)).toBe(true);
  });

  it('strips ttl from message content blocks, keeping the marker', () => {
    const body = buildRequest({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'plain' },
            { type: 'text', text: 'marked', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        },
      ],
    });

    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[0].content[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips ttl from system array blocks and tool entries', () => {
    const body = buildRequest({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      maxTokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: 'sys a' },
        { type: 'text', text: 'sys b', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      tools: [
        { name: 'ping', description: 'd', input_schema: { type: 'object' } },
        {
          name: 'pong', description: 'd', input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    });

    expect(body.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].cache_control).toBeUndefined();
  });

  it('leaves ttl-less markers and string system prompts untouched', () => {
    const body = buildRequest({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'marked', cache_control: { type: 'ephemeral' } }],
        },
      ],
      system: 'plain string system',
    });

    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system).toBe('plain string system');
  });

  it('strips ttl alongside the image sourceUrl sanitization', () => {
    const body = buildRequest({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      maxTokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
              sourceUrl: 'https://example.com/x.png',
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
      ],
    });

    const block = body.messages[0].content[0];
    expect(block.sourceUrl).toBeUndefined();
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('BedrockAdapter streaming cache usage', () => {
  it('surfaces cache metrics from message_start', async () => {
    const frames = [
      chunkFrame({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 42,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 90000,
          },
        },
      }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      chunkFrame({ type: 'message_stop' }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody(frames),
    })));

    const result = await adapter().stream(
      {
        model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      } as any,
      { onChunk: () => {} }
    );

    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.cacheCreationTokens).toBe(1000);
    expect(result.usage.cacheReadTokens).toBe(90000);
  });

  it('treats message_delta cache metrics as authoritative', async () => {
    const frames = [
      chunkFrame({
        type: 'message_start',
        message: { usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2, cache_creation_input_tokens: 512, cache_read_input_tokens: 2048 },
      }),
      chunkFrame({ type: 'message_stop' }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody(frames),
    })));

    const result = await adapter().stream(
      {
        model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      } as any,
      { onChunk: () => {} }
    );

    expect(result.usage.cacheCreationTokens).toBe(512);
    expect(result.usage.cacheReadTokens).toBe(2048);
  });

  it('leaves cache metrics undefined when the stream never reports them', async () => {
    const frames = [
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      chunkFrame({ type: 'message_stop' }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody(frames),
    })));

    const result = await adapter().stream(
      {
        model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      } as any,
      { onChunk: () => {} }
    );

    expect(result.usage.cacheCreationTokens).toBeUndefined();
    expect(result.usage.cacheReadTokens).toBeUndefined();
  });
});
