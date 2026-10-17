/**
 * A signed thinking block the provider refuses is `thinking_binding`, not
 * `invalid_request` (context-manager #155).
 *
 * Anthropic binds each thinking block to the conversation before it. One
 * minted in another conversation, or sent after its prefix changed, fails the
 * check, and under `prefix_mismatch_behavior: "error"` the request fails with
 * a 400 `invalid_request_error`. The request is well formed, so a consumer
 * that sheds or rewrites its newest message over `invalid_request`
 * (agent-framework's poison-history breaker) must not take it for one.
 *
 * Which fixtures are the API's own words: BINDING (a block minted in another
 * conversation, under "error") and ALTERED (a block whose signature was
 * altered) are messages from live probes on 2026-10-10 (Opus 5.5). The
 * envelopes around them are constructed: the redacted_thinking message is
 * matched by analogy and hasn't been seen, and OpenRouter's wrapper and
 * Bedrock's frames are built to their documented shapes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { MembraneError, errorFromProviderStatus } from '../../src/types/errors.js';
import type { ProviderRequest } from '../../src/types/provider.js';

const BINDING = 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
  + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". '
  + 'Content before this block differs from when it was created, first at `messages.0.content.0`.';
const ALTERED = 'messages.1.content.0: Invalid `signature` in `thinking` block';

const request: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

const anthropicBody = (message: string) => ({ type: 'error', error: { type: 'invalid_request_error', message } });

function anthropicHandled(status: number | undefined, body: unknown): MembraneError {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key-anthropic' });
  return (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(
    new Anthropic.APIError(status as never, body, undefined, undefined as never),
  );
}

async function rejection(call: Promise<unknown>): Promise<MembraneError> {
  return call.then(
    () => { throw new Error('expected the call to reject'); },
    (e: unknown) => e as MembraneError,
  );
}

/** OpenRouter's envelope around an upstream provider's error body. */
const openRouterEnvelope = (upstream: unknown) => ({
  error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'Anthropic', raw: JSON.stringify(upstream) } },
});

/** A Bedrock event-stream frame carrying one Anthropic stream event. */
function bedrockFrame(event: unknown): Uint8Array {
  const name = Buffer.from(':event-type'), value = Buffer.from('chunk');
  const headers = Buffer.alloc(1 + name.length + 1 + 2 + value.length);
  headers[0] = name.length; name.copy(headers, 1);
  headers[1 + name.length] = 7;
  headers.writeUInt16BE(value.length, 2 + name.length);
  value.copy(headers, 4 + name.length);
  const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') }));
  const frame = Buffer.alloc(16 + headers.length + payload.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length);
  return frame;
}

/** A Bedrock event-stream exception frame, as the stream sends a mid-response failure. */
function bedrockExceptionFrame(exceptionType: string, message: string): Uint8Array {
  const header = (name: string, value: string) => {
    const n = Buffer.from(name), v = Buffer.from(value);
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    out[0] = n.length; n.copy(out, 1);
    out[1 + n.length] = 7;
    out.writeUInt16BE(v.length, 2 + n.length);
    v.copy(out, 4 + n.length);
    return out;
  };
  const headers = Buffer.concat([header(':exception-type', exceptionType), header(':message-type', 'exception')]);
  const payload = Buffer.from(JSON.stringify({ message }));
  const frame = Buffer.alloc(16 + headers.length + payload.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length);
  return frame;
}

const bedrock = () => new BedrockAdapter({ accessKeyId: 'zz-access', secretAccessKey: 'zz-secret', region: 'us-east-1' });
const streamStart = { type: 'message_start', message: { id: 'zz', type: 'message', role: 'assistant', model: 'zz-model', content: [], usage: { input_tokens: 2, output_tokens: 0 } } };

afterEach(() => vi.unstubAllGlobals());

describe('a refused thinking block is thinking_binding', () => {
  it('anthropic: the binding 400, not retryable, with its status and code', () => {
    const error = anthropicHandled(400, anthropicBody(BINDING));
    expect(error.type).toBe('thinking_binding');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
    expect(error.providerErrorCode).toBe('invalid_request_error');
  });

  it("a block whose signature was altered: the first sentence alone", () => {
    const error = anthropicHandled(400, anthropicBody(ALTERED));
    expect(error.type).toBe('thinking_binding');
    expect(error.retryable).toBe(false);
  });

  it('anthropic mid-stream: no status, the 400 read from the body\'s error type', () => {
    // The SDK rethrows an SSE error event as an APIError with no status.
    const error = anthropicHandled(undefined, anthropicBody(BINDING));
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400, providerErrorCode: 'invalid_request_error' });
  });

  it("a redacted block's signature too, matched by analogy", () => {
    const error = errorFromProviderStatus({
      provider: 'anthropic', status: 400,
      body: anthropicBody('messages.3.content.0: Invalid `signature` in `redacted_thinking` block.'),
    });
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400 });
  });

  it('a 422 carrying the same refusal, as the neighbouring arms read one', () => {
    const error = errorFromProviderStatus({ provider: 'zz-gateway', status: 422, body: anthropicBody(BINDING) });
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 422 });
  });

  it("inside OpenRouter's wrapper, by the upstream body; the code is the router's own, so none", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(openRouterEnvelope(anthropicBody(BINDING))), { status: 400 })));
    const error = await rejection(new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }).complete(request));
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400 });
    expect(error.providerErrorCode).toBeUndefined();
  });

  it("a streamed OpenRouter error frame, by the upstream body it carries", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `data: ${JSON.stringify(openRouterEnvelope(anthropicBody(BINDING)))}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )));
    const error = await rejection(new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }).stream(request, { onChunk() {} }));
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400 });
    expect(error.providerErrorCode).toBeUndefined();
  });

  it("anthropic through a gateway: an aggregate carrying the refusal stays thinking_binding, not a retryable server error", () => {
    const body = { ...anthropicBody(BINDING), providerMetadata: { gateway: { routing: { attempts: 1 } } } };
    expect(anthropicHandled(422, body)).toMatchObject({ type: 'thinking_binding', retryable: false });
  });

  it("bedrock: the HTTP 400, named by its x-amzn-ErrorType", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: BINDING }), {
      status: 400, headers: { 'x-amzn-ErrorType': 'ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/' },
    })));
    const error = await rejection(bedrock().complete(request));
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400, providerErrorCode: 'ValidationException' });
  });

  it("bedrock mid-stream: Anthropic's error event, typed by its error.type", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.concat([
      bedrockFrame(streamStart), bedrockFrame({ type: 'error', error: { type: 'invalid_request_error', message: BINDING } }),
    ]))));
    const error = await rejection(bedrock().stream(request, { onChunk() {} }));
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400, providerErrorCode: 'invalid_request_error' });
  });

  it("bedrock mid-stream: a validationException frame", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.concat([
      bedrockFrame(streamStart), bedrockExceptionFrame('validationException', BINDING),
    ]))));
    const error = await rejection(bedrock().stream(request, { onChunk() {} }));
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false, httpStatus: 400, providerErrorCode: 'validationException' });
  });
});

describe('only that', () => {
  it('a 400 about the request stays invalid_request', () => {
    expect(anthropicHandled(400, anthropicBody('messages: roles must alternate between "user" and "assistant"')).type)
      .toBe('invalid_request');
  });

  it("a signature refused on another block, or a missing signature field, stays invalid_request", () => {
    for (const message of [
      'messages.1.content.0: Invalid `signature` in `tool_use` block',
      'messages.2.content.0.thinking.signature: Field required',
    ]) {
      expect(anthropicHandled(400, anthropicBody(message)).type, message).toBe('invalid_request');
    }
  });

  it('a 5xx whose text mentions it stays a retryable server error', () => {
    const error = errorFromProviderStatus({ provider: 'anthropic', status: 500, body: anthropicBody(`upstream said: ${BINDING}`) });
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
  });

  it('a refusal whose text also reads as an overflow is thinking_binding', () => {
    const error = errorFromProviderStatus({ provider: 'zz-gateway', status: 400, body: anthropicBody(`${ALTERED}. prompt is too long: 250000 tokens > 200000 maximum`) });
    expect(error).toMatchObject({ type: 'thinking_binding', retryable: false });
  });

  it('a context overflow is still context_length', () => {
    expect(anthropicHandled(400, anthropicBody('prompt is too long: 210123 tokens > 200000 maximum')).type).toBe('context_length');
  });
});
