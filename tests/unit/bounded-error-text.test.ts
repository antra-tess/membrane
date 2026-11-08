/**
 * A provider's error body is remote text, and some providers echo the whole
 * rejected request in it. What membrane puts in an error's message and
 * rawError travels into stack traces, onError hooks, logs and the failure
 * notice a framework stores in an agent's context, so each is bounded where
 * every error passes, and a wait stated in prose is read only from the
 * provider's own words.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheKeepalive, type KeepaliveEvent } from '../../src/cache-keepalive.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { MembraneError, classifyError, errorFromProviderStatus, isOverloadedError } from '../../src/types/errors.js';
import type { ProviderRequest } from '../../src/types/provider.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const echo = (chars: number) => JSON.stringify({ model: 'zz-model', messages: [{ role: 'user', content: 'z'.repeat(chars) }] });

describe("a MembraneError's message", () => {
  it('keeps at most 2,000 characters, its head and tail around a marker saying how much was left out', () => {
    const text = `HEAD ${'m'.repeat(10_000)} TAIL`;
    const { message } = new MembraneError({ type: 'invalid_request', message: text, retryable: false });
    expect(message.length).toBeLessThanOrEqual(2_000);
    expect(message.startsWith('HEAD ')).toBe(true);
    expect(message.endsWith(' TAIL')).toBe(true);
    const marker = message.match(/ …\[(\d+) of (\d+) characters omitted\]… /);
    expect(marker).not.toBeNull();
    expect(Number(marker![2])).toBe(text.length);
    expect(message.length - marker![0].length + Number(marker![1])).toBe(text.length);
  });

  it('is unchanged within the bound', () => {
    const text = 'n'.repeat(2_000);
    expect(new MembraneError({ type: 'server', message: text, retryable: true }).message).toBe(text);
  });

  it('never holds half of a surrogate pair where it cuts, at the head or the tail', () => {
    for (let before = 0; before < 2; before++) {
      for (let after = 0; after < 2; after++) {
        const text = 'a'.repeat(before) + '😀'.repeat(3_000) + 'b'.repeat(after);
        const { message } = new MembraneError({ type: 'unknown', message: text, retryable: false });
        expect(message.length).toBeLessThanOrEqual(2_000);
        expect(message).not.toMatch(LONE_SURROGATE);
      }
    }
  });

  it('is no overload for the counts its marker states, as when 529 characters were left out', () => {
    let text = '';
    for (let length = 2_001; length < 4_000 && !text; length++) {
      const bounded = new MembraneError({ type: 'server', message: 'v'.repeat(length), retryable: true }).message;
      if (/\[529 of /.test(bounded)) text = 'v'.repeat(length);
    }
    expect(text).not.toBe('');
    const error = new MembraneError({ type: 'server', message: text, retryable: true });
    expect(isOverloadedError(error.toErrorInfo())).toBe(false);
  });

  it('is no overload for the counts of any marker it holds, as when a bounded message is bounded again', () => {
    const earlier = ' …[10 of 2010 characters omitted]… ';
    let text = '';
    for (let length = 2_001; length < 4_000 && !text; length++) {
      const bounded = new MembraneError({ type: 'server', message: earlier + 'v'.repeat(length), retryable: true }).message;
      if (bounded.includes(earlier) && /\[529 of /.test(bounded)) text = earlier + 'v'.repeat(length);
    }
    expect(text).not.toBe('');
    const error = new MembraneError({ type: 'server', message: text, retryable: true });
    expect(isOverloadedError(error.toErrorInfo())).toBe(false);
  });

  it("bounds a provider's message that echoes the request", () => {
    const body = { error: { type: 'invalid_request_error', message: `Bad request; you sent ${echo(1_700_000)}` } };
    const error = errorFromProviderStatus({ provider: 'OpenAI', status: 400, body });
    expect(error.message.length).toBeLessThanOrEqual(2_000);
    expect(error.message.startsWith('OpenAI API error 400: Bad request; you sent ')).toBe(true);
    expect(error.type).toBe('invalid_request');
  });
});

describe("a MembraneError's rawError", () => {
  it('is a summary with the size, sha256 and head of a JSON value past 16 KiB', () => {
    const body = { echo: 'q'.repeat(40_000) };
    const json = JSON.stringify(body);
    const error = new MembraneError({ type: 'invalid_request', message: 'x', retryable: false, rawError: body });
    expect(error.rawError).toEqual({
      truncated: true,
      jsonBytes: Buffer.byteLength(json, 'utf8'),
      sha256: createHash('sha256').update(json).digest('hex'),
      head: expect.any(String),
    });
    expect((error.rawError as { head: string }).head).toBe(json.slice(0, 2_048));
    expect(JSON.stringify(error.rawError).length).toBeLessThan(16 * 1024);
  });

  it('is a summary with the bytes, sha256 and head of a string past 16 KiB', () => {
    const raw = 'é'.repeat(10_000);
    const error = new MembraneError({ type: 'server', message: 'x', retryable: true, rawError: raw });
    expect(error.rawError).toMatchObject({
      truncated: true,
      bytes: Buffer.byteLength(raw, 'utf8'),
      sha256: createHash('sha256').update(raw).digest('hex'),
      head: raw.slice(0, 2_048),
    });
  });

  it('is kept as given within the bound', () => {
    const body = { error: { message: 'small' } };
    expect(new MembraneError({ type: 'server', message: 'x', retryable: true, rawError: body }).rawError).toBe(body);
  });

  it('is kept as given when it has no JSON form, rather than the bound throwing', () => {
    const cyclic: Record<string, unknown> = { big: 'c'.repeat(40_000) };
    cyclic.self = cyclic;
    const error = new MembraneError({ type: 'server', message: 'x', retryable: true, rawError: cyclic });
    expect(error.rawError).toBe(cyclic);
  });
});

describe('classifyError', () => {
  it("bounds the message it returns for a thrown value, and classifies by the whole text", () => {
    const info = classifyError(new Error(`${'w'.repeat(5_000)} 429 too many requests ${'w'.repeat(5_000)}`));
    expect(info.message).not.toContain('429');
    expect(info.message.length).toBeLessThanOrEqual(2_000);
    expect(info.type).toBe('rate_limit');
  });

  it("returns a thrown error's echoed body as a summary in its rawError", () => {
    const thrown = Object.assign(new Error('400 Bad request'), { status: 400, error: { echo: 'e'.repeat(40_000) } });
    const info = classifyError(thrown);
    expect(info.rawError).toMatchObject({ truncated: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(info.rawError).length).toBeLessThan(16 * 1024);
  });
});

describe('a wait stated in prose', () => {
  it("is read from the provider's own message", () => {
    const error = errorFromProviderStatus({
      provider: 'OpenAI', status: 429, body: { error: { message: 'Rate limited. Please retry after 7 seconds.' } },
    });
    expect(error.retryAfterMs).toBe(7_000);
  });

  it("isn't read from a body with no message field, which can echo the request", () => {
    const error = errorFromProviderStatus({
      provider: 'OpenAI', status: 429, body: { request: { messages: [{ content: 'please retry after 30 seconds.' }] } },
    });
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("isn't read from the caller's rendering of a body whose own message states none", () => {
    const body = { error: { message: 'Rate limited.' }, request: { content: 'retry after 30 seconds.' } };
    const error = errorFromProviderStatus({ provider: 'Anthropic', status: 429, body, message: `429 ${JSON.stringify(body)}` });
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("is read from the caller's message when the body is null, as when there's none", () => {
    const error = errorFromProviderStatus({ provider: 'OpenAI', status: 429, body: null, message: 'Please retry after 80 seconds.' });
    expect(error.retryAfterMs).toBe(80_000);
  });

  it("isn't read from membrane's rendering of a Bedrock stream error event that carries no message", async () => {
    const event = { type: 'error', error: { type: 'rate_limit_error' }, request: { content: 'please retry after 80 seconds.' } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody([chunkFrame(event)]) })));
    try {
      const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' });
      const request: ProviderRequest = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'zz hello' }], maxTokens: 64 };
      const error = await adapter.stream(request, { onChunk: () => {} }).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).providerErrorCode).toBe('rate_limit_error');
      expect((error as MembraneError).httpStatus).toBe(429);
      expect((error as MembraneError).retryAfterMs).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('a null body', () => {
  it("counts as none in classifying the error, so the caller's message is read", () => {
    const message = 'prompt is too long: 250000 tokens > 200000 maximum';
    expect(errorFromProviderStatus({ provider: 'Anthropic', status: 400, message }).type).toBe('context_length');
    expect(errorFromProviderStatus({ provider: 'Anthropic', status: 400, body: null, message }).type).toBe('context_length');
  });
});

describe("the cache keepalive's own error text", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is bounded in its error event and its stop reason, while the receipt keeps the error as thrown', async () => {
    const thrown = new Error(`400 ${echo(50_000)}`);
    const send = vi.fn().mockRejectedValue(thrown);
    const events: KeepaliveEvent[] = [];
    const calls: { error?: unknown }[] = [];
    const ka = new CacheKeepalive(send as never, {
      refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 10_000, maxConsecutiveErrors: 1,
      onEvent: (event) => events.push(event), onCall: (call) => calls.push(call),
    });
    ka.record({
      model: 'claude-fable-5', max_tokens: 1024,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
    }, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(300);
    const error = events.find((event) => event.type === 'error') as { error: string } | undefined;
    const disabled = events.find((event) => event.type === 'disabled') as { reason: string } | undefined;
    expect(error?.error.length).toBeLessThanOrEqual(2_000);
    expect(disabled?.reason).toBe(`1 consecutive keepalive failures; last: ${error?.error}`);
    expect(calls[0]?.error).toBe(thrown);
    ka.stop();
  });
});
