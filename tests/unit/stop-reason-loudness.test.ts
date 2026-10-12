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
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse, StreamCallbacks } from '../../src/types/provider.js';

class FixedStopReasonAdapter extends MockAdapter {
  constructor(private providerStopReason: string) {
    super();
  }

  override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const response = await super.complete(request, options);
    return { ...response, stopReason: this.providerStopReason, providerStopReason: this.providerStopReason };
  }

  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const response = await super.stream(request, callbacks, options);
    return { ...response, stopReason: this.providerStopReason, providerStopReason: this.providerStopReason };
  }
}

/** The console.warn calls that name this stop reason (printed as a JSON string). */
function warningsNaming(warn: ReturnType<typeof vi.spyOn>, reason: string): number {
  return warn.mock.calls.filter(args => String(args[0]).includes(JSON.stringify(reason))).length;
}

async function streamed(membrane: Membrane, request: NormalizedRequest): Promise<NormalizedResponse> {
  const result = await membrane.stream(request);
  if (isAbortedResponse(result)) throw new Error('aborted');
  return result;
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
    expect(warningsNaming(warn, 'zz_future_reason')).toBe(1);
  });

  it('logs an unmapped reason once per reason, not on every response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(new FixedStopReasonAdapter('zz_repeated_reason'));
    await membrane.complete(zzRequest);
    const second = await membrane.complete(zzRequest);
    expect(second.details.stop.reason).toBe('end_turn');
    expect(second.details.stop.providerReason).toBe('zz_repeated_reason');
    expect(warningsNaming(warn, 'zz_repeated_reason')).toBe(1);
    await new Membrane(new FixedStopReasonAdapter('zz_other_reason')).complete(zzRequest);
    expect(warningsNaming(warn, 'zz_other_reason')).toBe(1);
  });

  it('prints a server-chosen token as a JSON string, cut to a token\'s length', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forged = 'zz_reason\n[membrane] forged line ' + 'x'.repeat(300);
    const response = await new Membrane(new FixedStopReasonAdapter(forged)).complete(zzRequest);
    expect(response.details.stop.providerReason).toBe(forged);
    const lines = warn.mock.calls.map(args => String(args[0])).filter(line => line.includes('zz_reason'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain(JSON.stringify(forged.slice(0, 128) + '…'));
  });

  it('carries pause_turn through on stream() too', async () => {
    const response = await streamed(new Membrane(new FixedStopReasonAdapter('pause_turn')), zzRequest);
    expect(response.stopReason).toBe('pause_turn');
    expect(response.details.stop.providerReason).toBe('pause_turn');
  });

  it('records an unmapped reason on stream() too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await streamed(new Membrane(new FixedStopReasonAdapter('zz_stream_reason')), zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBe('zz_stream_reason');
    expect(warningsNaming(warn, 'zz_stream_reason')).toBe(1);
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
    expect(response.details.stop.providerReason).toBe('BLOCKLIST');
  });
});

describe('the OpenAI-family adapters pass an unrecognized finish_reason through', () => {
  const adapters: Array<[string, () => ProviderAdapter]> = [
    ['openai', () => new OpenAIAdapter({ apiKey: 'zz-key' })],
    ['openai-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz-compatible.invalid/v1' })],
    ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' })],
  ];
  for (const [name, create] of adapters) {
    for (const entry of ['complete', 'stream'] as const) {
      it(`${name} ${entry}: the token reaches membrane, which logs it`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reason = `zz_${name.replace('-', '_')}_${entry}_reason`;
        vi.stubGlobal('fetch', vi.fn(async () => entry === 'complete'
          ? new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'zz-partial' }, finish_reason: reason }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }))
          : new Response(
            [{ choices: [{ delta: { content: 'zz-partial' }, finish_reason: reason }] }, '[DONE]']
              .map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )));
        const membrane = new Membrane(create());
        const response = entry === 'complete' ? await membrane.complete(zzRequest) : await streamed(membrane, zzRequest);
        expect(response.stopReason).toBe('end_turn');
        expect(response.details.stop.providerReason).toBe(reason);
        expect(warningsNaming(warn, reason)).toBe(1);
      });
    }
  }
});

describe('the Responses adapter reads every incomplete reason', () => {
  const incomplete = (reason: string) => ({
    id: 'zz-resp', status: 'incomplete', incomplete_details: { reason }, output: [],
    usage: { input_tokens: 3, output_tokens: 0 },
  });
  const wire: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

  it('a content_filter stop is a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(incomplete('content_filter')))));
    const response = await new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }).complete(wire);
    expect(response.stopReason).toBe('refusal');
    expect(response.providerStopReason).toBe('content_filter');
  });

  it('another incomplete reason travels as its own token, and membrane logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(incomplete('zz_incomplete_reason')))));
    const response = await new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' })).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBe('zz_incomplete_reason');
    expect(warningsNaming(warn, 'zz_incomplete_reason')).toBe(1);
  });
});

describe('gemini: a prompt blocked before generation is a refusal whatever the reason', () => {
  for (const blockReason of ['OTHER', 'BLOCK_REASON_UNSPECIFIED', 'zz_future_block_reason']) {
    for (const entry of ['complete', 'stream'] as const) {
      it(`${blockReason} on ${entry}()`, async () => {
        const body = { promptFeedback: { blockReason }, usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 0 } };
        vi.stubGlobal('fetch', vi.fn(async () => entry === 'complete'
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response('data: ' + JSON.stringify(body) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })));
        const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
        const response = entry === 'complete' ? await membrane.complete(zzRequest) : await streamed(membrane, zzRequest);
        expect(response.stopReason).toBe('refusal');
        expect(response.details.stop.providerReason).toBe(blockReason);
      });
    }
  }
});
