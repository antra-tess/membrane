/**
 * A signed thinking block the provider refuses is `thinking_binding`, not
 * `invalid_request` (context-manager #155).
 *
 * Anthropic binds each thinking block to the conversation before it. One
 * minted in another conversation, or sent after its prefix changed, fails the
 * check, and under the default (or `prefix_mismatch_behavior: "error"`) the
 * request fails with a 400 `invalid_request_error`. The request is well
 * formed, so a consumer that sheds or rewrites its newest message over
 * `invalid_request` (agent-framework's poison-history breaker) must not take
 * it for one. The messages below are the API's, from live probes on
 * 2026-10-10 (Opus 5.5): a block minted in another conversation, under
 * `"error"`, and a block whose signature was altered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { MembraneError, errorFromProviderStatus } from '../../src/types/errors.js';
import type { ProviderRequest } from '../../src/types/provider.js';

const BINDING = 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
  + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". '
  + 'Content before this block differs from when it was created, first at `messages.0.content.0`.';

const anthropicBody = (message: string) => ({ type: 'error', error: { type: 'invalid_request_error', message } });

function anthropicHandled(status: number, body: unknown): MembraneError {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key-anthropic' });
  return (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(
    new Anthropic.APIError(status as never, body, undefined, undefined as never),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('a refused thinking block is thinking_binding', () => {
  it('anthropic: the binding 400, not retryable, with its status and code', () => {
    const error = anthropicHandled(400, anthropicBody(BINDING));
    expect(error.type).toBe('thinking_binding');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
    expect(error.providerErrorCode).toBe('invalid_request_error');
  });

  it('a block whose signature was altered, refused under every behavior', () => {
    // The API's message, live (Opus 5.5, 2026-10-10): the same under "error",
    // "drop_block" and the account's default.
    const error = anthropicHandled(400, anthropicBody('messages.1.content.0: Invalid `signature` in `thinking` block'));
    expect(error.type).toBe('thinking_binding');
    expect(error.retryable).toBe(false);
  });

  it('a redacted block\'s signature too', () => {
    const error = errorFromProviderStatus({
      provider: 'anthropic', status: 400,
      body: anthropicBody('messages.3.content.0: Invalid `signature` in `redacted_thinking` block.'),
    });
    expect(error.type).toBe('thinking_binding');
  });

  it('inside OpenRouter\'s wrapper, by the upstream body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'Anthropic', raw: JSON.stringify(anthropicBody(BINDING)) } },
    }), { status: 400 })));
    const request: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };
    const error = await new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }).complete(request).then(
      () => { throw new Error('expected the call to reject'); },
      (e: unknown) => e as MembraneError,
    );
    expect(error.type).toBe('thinking_binding');
    expect(error.httpStatus).toBe(400);
  });
});

describe('only that', () => {
  it('a 400 about the request stays invalid_request', () => {
    expect(anthropicHandled(400, anthropicBody('messages: roles must alternate between "user" and "assistant"')).type)
      .toBe('invalid_request');
  });

  it('a 5xx whose text mentions it stays a retryable server error', () => {
    const error = errorFromProviderStatus({ provider: 'anthropic', status: 500, body: anthropicBody(`upstream said: ${BINDING}`) });
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
  });

  it('a context overflow is still context_length', () => {
    expect(anthropicHandled(400, anthropicBody('prompt is too long: 210123 tokens > 200000 maximum')).type).toBe('context_length');
  });
});
