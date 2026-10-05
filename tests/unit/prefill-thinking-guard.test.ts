/**
 * Prefill/thinking guard: the API rejects extended thinking combined with an
 * assistant prefill, so prefill-shaped builds drop the thinking param. The
 * guard used to delete only the TOP-LEVEL field while `extra` (spread from
 * `providerParams`) carried a smuggled copy straight into the adapter's
 * `Object.assign(params, rest)` — the exact bypass the sibling sampling gate
 * was hardened against. `thinkingEnabled` reads both channels, so the guard
 * must strip both.
 *
 * Note the underlying API premise is model-dependent as of 2026-08-25:
 * claude-haiku-4-5 ACCEPTS prefill (with thinking), while sonnet-4-6 /
 * opus-4-8 / sonnet-5 refuse assistant prefill outright. The guard stays: on
 * the models that take a prefill at all, thinking + prefill is still a 400.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { thinkingEnabled } from '../../src/providers/anthropic.js';
import type { NormalizedRequest } from '../../src/types/index.js';

function membraneWithXmlPrefill() {
  return new Membrane({ name: 'zz-fake-adapter' } as any);
}

function requestWithSmuggledThinking(): NormalizedRequest {
  return {
    messages: [{ participant: 'zzOperator', content: [{ type: 'text', text: 'zz hello' }] }],
    system: 'zz system prompt',
    config: { model: 'claude-haiku-4-5-20251001', maxTokens: 4096, thinking: { enabled: true, budgetTokens: 1024 } },
    providerParams: { thinking: { type: 'enabled', budget_tokens: 1024 } },
    assistantParticipant: 'Claude',
  } as unknown as NormalizedRequest;
}

describe('prefill guard: thinking is stripped from BOTH channels', () => {
  it('strips extra.thinking when the built request ends in an assistant prefill', () => {
    const membrane = membraneWithXmlPrefill();
    const { providerRequest, prefillResult } = (membrane as any).transformRequest(
      requestWithSmuggledThinking()
    );

    expect(prefillResult.assistantPrefill).toBeDefined();
    expect(providerRequest.thinking).toBeUndefined();
    expect(providerRequest.extra?.thinking).toBeUndefined();
    // The resolver the adapter's sampling gate and beta header share.
    expect(thinkingEnabled(providerRequest)).toBe(false);
  });

  it('leaves the caller providerParams object unmutated', () => {
    const membrane = membraneWithXmlPrefill();
    const request = requestWithSmuggledThinking();
    (membrane as any).transformRequest(request);
    expect((request as any).providerParams.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it('strips both channels on a plain continuation (always a prefill)', () => {
    const membrane = membraneWithXmlPrefill();
    const request = requestWithSmuggledThinking();
    const { prefillResult } = (membrane as any).transformRequest(request);
    const continuation = (membrane as any).buildContinuationRequest(
      request,
      prefillResult,
      'zz partial answer'
    );

    expect(continuation.thinking).toBeUndefined();
    expect(continuation.extra?.thinking).toBeUndefined();
    expect(thinkingEnabled(continuation)).toBe(false);
    expect((request as any).providerParams.thinking).toBeDefined();
  });

  it('strips both channels on a split-turn image continuation', () => {
    const membrane = membraneWithXmlPrefill();
    const request = requestWithSmuggledThinking();
    const { prefillResult } = (membrane as any).transformRequest(request);
    const continuation = (membrane as any).buildContinuationRequestWithImages(
      request,
      prefillResult,
      'zz partial answer',
      [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'zzdata' } }],
      '</result></function_results>'
    );

    expect(continuation.thinking).toBeUndefined();
    expect(continuation.extra?.thinking).toBeUndefined();
    expect(thinkingEnabled(continuation)).toBe(false);
    expect((request as any).providerParams.thinking).toBeDefined();
  });

  it('keeps a caller-supplied extra.thinking when the build is NOT a prefill', () => {
    // Native/chat-shaped builds legitimately combine thinking with the request.
    const membrane = new Membrane({ name: 'zz-fake-adapter' } as any);
    const request = requestWithSmuggledThinking();
    const providerRequest = (membrane as any).buildNativeToolRequest(request, request.messages, false);
    expect(providerRequest.extra?.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
});
