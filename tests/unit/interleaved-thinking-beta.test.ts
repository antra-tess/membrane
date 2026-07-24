/**
 * Interleaved-thinking beta gating: which models need the
 * `interleaved-thinking-2025-05-14` flag when thinking is enabled.
 * Native from Opus/Sonnet 4.6 onward; beta-only on earlier Claude 4.
 *
 * Also covers the delivery mechanics on both adapters: the Anthropic
 * adapter's per-request header (including the oauth default-beta re-carry —
 * the SDK REPLACES same-key default headers rather than merging, so dropping
 * the default there breaks subscription auth) and the Bedrock adapter's
 * `anthropic_beta` body field.
 */

import { describe, it, expect } from 'vitest';
import {
  AnthropicAdapter,
  needsInterleavedThinkingBeta,
} from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import type { ProviderRequest } from '../../src/types/index.js';

const INTERLEAVED = 'interleaved-thinking-2025-05-14';
const OAUTH_BETA = 'oauth-2025-04-20';

function thinkingRequest(model: string, thinking = true): ProviderRequest {
  return {
    model,
    messages: [],
    maxTokens: 1024,
    ...(thinking ? { thinking: { type: 'enabled', budget_tokens: 512 } } : {}),
  } as unknown as ProviderRequest;
}

/** Build the per-request headers through a constructed adapter, so the test
 *  exercises the real defaultHeaders extraction path too. */
function headersFor(
  defaultHeaders: unknown,
  request: ProviderRequest,
): Record<string, string> | undefined {
  const adapter = new AnthropicAdapter({
    apiKey: 'test-key',
    defaultHeaders: defaultHeaders as never,
  });
  return (
    adapter as unknown as {
      betaHeaders(r: ProviderRequest): Record<string, string> | undefined;
    }
  ).betaHeaders(request);
}

/** Build a Bedrock request body via a constructed adapter. */
function bedrockBody(request: ProviderRequest): { anthropic_beta?: string[] } {
  const adapter = new BedrockAdapter({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret',
  });
  return (
    adapter as unknown as {
      buildRequest(r: ProviderRequest): { anthropic_beta?: string[] };
    }
  ).buildRequest(request);
}

describe('needsInterleavedThinkingBeta', () => {
  it('flags pre-4.6 Claude 4 models', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4-5')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-opus-4-1-20250805')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-5-20250929')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('treats bare and date-only ids as 4.0 (flagged)', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-opus-4-20250514')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-20250514')).toBe(true);
  });

  it('does not flag 4.6+ models (native interleaved thinking)', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4-6')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-opus-4-6-20260115')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-6')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-opus-4-7')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-opus-4-8')).toBe(false);
  });

  it('does not flag Claude 3.x (no interleaved support at all) or the 5-series', () => {
    expect(needsInterleavedThinkingBeta('claude-3-7-sonnet-20250219')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-3-5-haiku-20241022')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-fable-5')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-sonnet-5')).toBe(false);
  });

  it('matches gateway-prefixed ids', () => {
    expect(needsInterleavedThinkingBeta('anthropic/claude-opus-4-5')).toBe(true);
    expect(needsInterleavedThinkingBeta('anthropic/claude-opus-4-6')).toBe(false);
    expect(needsInterleavedThinkingBeta('anthropic/claude-opus-4')).toBe(true);
  });

  it('matches Bedrock model / inference-profile ids', () => {
    expect(needsInterleavedThinkingBeta('anthropic.claude-opus-4-1-20250805-v1:0')).toBe(true);
    expect(needsInterleavedThinkingBeta('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe(true);
    expect(needsInterleavedThinkingBeta('apac.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(true);
    expect(needsInterleavedThinkingBeta('us.anthropic.claude-sonnet-4-6-v1:0')).toBe(false);
    expect(needsInterleavedThinkingBeta('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(false);
  });

  it('matches Vertex @-dated ids', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4-1@20250805')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-opus-4@20250514')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-6@20260115')).toBe(false);
  });

  it('ignores non-Claude / unrelated ids', () => {
    expect(needsInterleavedThinkingBeta('gpt-4o')).toBe(false);
    expect(needsInterleavedThinkingBeta('')).toBe(false);
  });
});

describe('AnthropicAdapter.betaHeaders (oauth default-beta re-carry)', () => {
  const request = thinkingRequest('claude-opus-4-1-20250805');

  it('re-carries a default beta alongside the interleaved beta', () => {
    expect(headersFor({ 'anthropic-beta': OAUTH_BETA }, request)).toEqual({
      'anthropic-beta': `${OAUTH_BETA},${INTERLEAVED}`,
    });
  });

  it('emits just the interleaved beta when no default is configured', () => {
    expect(headersFor(undefined, request)).toEqual({ 'anthropic-beta': INTERLEAVED });
    expect(headersFor({ 'x-unrelated': 'v' }, request)).toEqual({
      'anthropic-beta': INTERLEAVED,
    });
  });

  it('returns undefined when thinking is off or the model needs no flag', () => {
    expect(
      headersFor({ 'anthropic-beta': OAUTH_BETA }, thinkingRequest('claude-opus-4-1', false)),
    ).toBeUndefined();
    expect(
      headersFor({ 'anthropic-beta': OAUTH_BETA }, thinkingRequest('claude-opus-4-6')),
    ).toBeUndefined();
    expect(
      headersFor({ 'anthropic-beta': OAUTH_BETA }, thinkingRequest('claude-fable-5')),
    ).toBeUndefined();
  });

  it('reads the default beta from a Headers instance', () => {
    expect(headersFor(new Headers({ 'anthropic-beta': OAUTH_BETA }), request)).toEqual({
      'anthropic-beta': `${OAUTH_BETA},${INTERLEAVED}`,
    });
  });

  it('reads the default beta from an entries array, case-insensitively', () => {
    expect(headersFor([['Anthropic-Beta', OAUTH_BETA]], request)).toEqual({
      'anthropic-beta': `${OAUTH_BETA},${INTERLEAVED}`,
    });
  });

  it('does not duplicate an interleaved beta already in the defaults', () => {
    expect(headersFor({ 'anthropic-beta': `${OAUTH_BETA},${INTERLEAVED}` }, request)).toEqual({
      'anthropic-beta': `${OAUTH_BETA},${INTERLEAVED}`,
    });
  });
});

describe('BedrockAdapter anthropic_beta body field', () => {
  it('adds the interleaved beta for a pre-4.6 Claude 4 model with thinking on', () => {
    expect(bedrockBody(thinkingRequest('claude-opus-4-1-20250805')).anthropic_beta).toEqual([
      INTERLEAVED,
    ]);
    expect(
      bedrockBody(thinkingRequest('us.anthropic.claude-opus-4-1-20250805-v1:0')).anthropic_beta,
    ).toEqual([INTERLEAVED]);
  });

  it('omits the field when thinking is off or the model needs no flag', () => {
    expect(bedrockBody(thinkingRequest('claude-opus-4-1-20250805', false)).anthropic_beta)
      .toBeUndefined();
    expect(bedrockBody(thinkingRequest('us.anthropic.claude-sonnet-4-6-v1:0')).anthropic_beta)
      .toBeUndefined();
    expect(
      bedrockBody(thinkingRequest('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).anthropic_beta,
    ).toBeUndefined();
  });

  it('merges (deduped) with a consumer-supplied anthropic_beta from extra', () => {
    const request = {
      ...thinkingRequest('claude-opus-4-1-20250805'),
      extra: { anthropic_beta: ['some-other-beta', INTERLEAVED] },
    } as unknown as ProviderRequest;
    expect(bedrockBody(request).anthropic_beta).toEqual(['some-other-beta', INTERLEAVED]);
  });
});
