/**
 * A stop reason nobody mapped used to become `end_turn` — the value that
 * also means "the model finished cleanly" — with nothing logged and
 * `wasTruncated: false`. A paused turn the caller is expected to resume, an
 * openai-completions content filter, and every Gemini safety enum outside
 * SAFETY/RECITATION all landed there silently.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';

class FixedStopReasonAdapter extends MockAdapter {
  constructor(private providerStopReason: string) {
    super();
  }

  override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const response = await super.complete(request, options);
    return { ...response, stopReason: this.providerStopReason };
  }
}

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

function geminiFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('membrane stop-reason mapping is loud', () => {
  it('carries pause_turn through as its own stop reason', async () => {
    const membrane = new Membrane(new FixedStopReasonAdapter('pause_turn'));
    const response = await membrane.complete(zzRequest);
    expect(response.stopReason).toBe('pause_turn');
    expect(response.details.stop.reason).toBe('pause_turn');
  });

  it('records an unmapped provider reason instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(new FixedStopReasonAdapter('zz_future_reason'));
    const response = await membrane.complete(zzRequest);
    expect(response.details.stop.providerReason).toBe('zz_future_reason');
    expect(warn).toHaveBeenCalled();
  });

  it('leaves a mapped reason unwarned but still discloses the provider token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(new FixedStopReasonAdapter('max_tokens'));
    const response = await membrane.complete(zzRequest);
    expect(response.details.stop.reason).toBe('max_tokens');
    expect(response.details.stop.providerReason).toBe('max_tokens');
    expect(response.details.stop.wasTruncated).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('openai-completions maps content_filter like its siblings', () => {
  it('reports a filtered completion as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'zz-cmpl-1',
            model: 'zz-model-1',
            choices: [{ text: 'zz-partial', finish_reason: 'content_filter', index: 0 }],
            usage: { prompt_tokens: 4, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
      ),
    );
    const adapter = new OpenAICompletionsAdapter({
      apiKey: 'zz-key-completions',
      baseURL: 'https://zz-completions.invalid/v1',
    });
    const response = await adapter.complete({
      model: 'zz-model-1',
      messages: [{ role: 'user', content: 'zz-prompt' }],
      maxTokens: 16,
    });
    expect(response.stopReason).toBe('refusal');
  });
});

describe('gemini surfaces the safety enums it used to drop', () => {
  const geminiAdapter = () => new GeminiAdapter({ apiKey: 'zz-key-gemini' });

  for (const finishReason of ['PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']) {
    it(`maps ${finishReason} to a refusal`, async () => {
      vi.stubGlobal(
        'fetch',
        geminiFetch({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 },
        }),
      );
      const response = await geminiAdapter().complete({
        model: 'zz-model-1',
        messages: [{ role: 'user', content: 'zz-prompt' }],
        maxTokens: 16,
      });
      expect(response.stopReason).toBe('refusal');
    });
  }

  it('passes MALFORMED_FUNCTION_CALL through as the provider token, not end_turn', async () => {
    vi.stubGlobal(
      'fetch',
      geminiFetch({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 },
      }),
    );
    const response = await geminiAdapter().complete({
      model: 'zz-model-1',
      messages: [{ role: 'user', content: 'zz-prompt' }],
      maxTokens: 16,
    });
    expect(response.stopReason).toBe('MALFORMED_FUNCTION_CALL');
  });

  it('surfaces a prompt blocked before generation', async () => {
    vi.stubGlobal(
      'fetch',
      geminiFetch({
        promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 },
      }),
    );
    const response = await geminiAdapter().complete({
      model: 'zz-model-1',
      messages: [{ role: 'user', content: 'zz-prompt' }],
      maxTokens: 16,
    });
    expect(response.stopReason).toBe('refusal');
    expect(response.raw).toMatchObject({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  });

  it('a blocked prompt reaches the caller as a refusal end to end', async () => {
    vi.stubGlobal(
      'fetch',
      geminiFetch({
        promptFeedback: { blockReason: 'BLOCKLIST' },
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 0 },
      }),
    );
    const membrane = new Membrane(geminiAdapter());
    const response = await membrane.complete(zzRequest);
    expect(response.stopReason).toBe('refusal');
    expect(response.details.stop.providerReason).toBe('refusal');
  });
});
