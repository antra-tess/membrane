/**
 * A server can end a choice or candidate with `finish_reason: null` (or
 * Gemini's `finishReason: null`). Vitest runs each file in a module of its
 * own, so these are the first stop reasons this process logs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { isAbortedResponse } from '../../src/types/index.js';
import { MembraneError } from '../../src/types/errors.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse, StreamCallbacks } from '../../src/types/provider.js';

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

const adapterRequest: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

function json(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

function sse(frames: unknown[]) {
  return vi.fn(async () => new Response(
    frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  ));
}

async function streamed(membrane: Membrane): Promise<NormalizedResponse> {
  const result = await membrane.stream(zzRequest);
  if (isAbortedResponse(result)) throw new Error('aborted');
  return result;
}

/** The console.warn lines membrane printed for an unmapped stop reason. */
function unmappedWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map(args => String(args[0])).filter(line => line.includes('Unmapped adapter stop reason'));
}

const completions = () => new OpenAICompletionsAdapter({ apiKey: 'zz-key-completions', baseURL: 'https://zz-completions.invalid/v1' });
const gemini = () => new GeminiAdapter({ apiKey: 'zz-key-gemini' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a null finish reason is no finish reason', () => {
  it('openai-completions complete()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', json({
      id: 'zz-cmpl-1',
      model: 'zz-model-1',
      choices: [{ text: 'zz-done', finish_reason: null, index: 0 }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }));
    const adapter = completions();
    // The adapter's own reading, which no other test's logged set can hide.
    expect((await adapter.complete(adapterRequest)).stopReason).toBe('end_turn');
    const response = await new Membrane(adapter).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBeUndefined();
    expect(unmappedWarnings(warn)).toEqual([]);
  });

  it('gemini complete()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', json({
      candidates: [{ content: { parts: [{ text: 'zz-done' }] }, finishReason: null }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    }));
    const adapter = gemini();
    expect((await adapter.complete(adapterRequest)).stopReason).toBe('end_turn');
    const response = await new Membrane(adapter).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBeUndefined();
    expect(unmappedWarnings(warn)).toEqual([]);
  });

  // The same guard reads a missing finish reason, which a case of its own
  // handled before.
  it('gemini complete() with no finish reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', json({
      candidates: [{ content: { parts: [{ text: 'zz-done' }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    }));
    const adapter = gemini();
    expect((await adapter.complete(adapterRequest)).stopReason).toBe('end_turn');
    const response = await new Membrane(adapter).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBeUndefined();
    expect(unmappedWarnings(warn)).toEqual([]);
  });

  // A control: the stream reads a finish reason only when it's truthy, so a
  // null one never reached the mapper there. After [DONE] the mapper reads the
  // missing one, which pins the guard's undefined half for this adapter.
  it('openai-completions stream(), which skips a null finish reason and maps the missing one after [DONE]', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', sse([
      { id: 'zz-cmpl-1', choices: [{ text: 'zz-done', finish_reason: null, index: 0 }] },
      '[DONE]',
    ]));
    const response = await streamed(new Membrane(completions()));
    expect(response.stopReason).toBe('end_turn');
    expect(unmappedWarnings(warn)).toEqual([]);
  });

  // Gemini's stream reads a finish reason the same way, and there a finish
  // reason is what ends the stream: one that gives only null ones never ended.
  it('gemini stream() whose frames give only a null finish reason fails as a dropped connection', async () => {
    vi.stubGlobal('fetch', sse([
      { candidates: [{ content: { parts: [{ text: 'zz-half' }] }, finishReason: null }] },
      { candidates: [{ content: { parts: [{ text: ' a turn' }] }, finishReason: null }] },
    ]));
    const failure = await gemini().stream(adapterRequest, { onChunk: () => {} } as unknown as StreamCallbacks).then(
      (value) => { throw new Error(`expected a dropped connection, resolved with ${JSON.stringify(value)}`); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MembraneError);
    expect((failure as MembraneError).message).toMatch(/stream ended before a terminal event/);
    expect((failure as MembraneError).retryable).toBe(true);
  });
});

/**
 * An adapter whose stop reason is whatever `stopReason` returns on each call,
 * outside its type, as one written in JavaScript could give.
 */
function adapterGiving(stopReason: () => unknown) {
  return new (class extends MockAdapter {
    override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      return { ...(await super.complete(request, options)), stopReason: stopReason() as string };
    }
    override async stream(
      request: ProviderRequest,
      callbacks: StreamCallbacks,
      options?: ProviderRequestOptions,
    ): Promise<ProviderResponse> {
      return { ...(await super.stream(request, callbacks, options)), stopReason: stopReason() as string };
    }
  })();
}

/** What the line says details.stop.providerReason carries, the same for every stop reason. */
const disclosed = "details.stop.providerReason carries the adapter's providerStopReason if that's a non-empty string, " +
  "else this stop reason if it's one; logged once per reason)";

// Each case prints its stop reason differently, so each is the first time this
// file's process logs it.
describe("membrane's log of an unmapped stop reason", () => {
  it('prints null rather than failing the call, once, and leaves providerReason unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(adapterGiving(() => null));
    const first = await membrane.complete(zzRequest);
    const second = await membrane.complete(zzRequest);
    expect(first.stopReason).toBe('end_turn');
    expect(second.stopReason).toBe('end_turn');
    expect(first.details.stop.providerReason).toBeUndefined();
    expect(unmappedWarnings(warn)).toEqual([
      `[membrane] Unmapped adapter stop reason null (not a string) normalized to end_turn (${disclosed}`,
    ]);
  });

  it('prints undefined from a stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await streamed(new Membrane(adapterGiving(() => undefined)));
    expect(response.stopReason).toBe('end_turn');
    expect(unmappedWarnings(warn)).toEqual([
      `[membrane] Unmapped adapter stop reason undefined (not a string) normalized to end_turn (${disclosed}`,
    ]);
  });

  it('prints a number by its value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await new Membrane(adapterGiving(() => 5)).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(unmappedWarnings(warn)).toEqual([
      `[membrane] Unmapped adapter stop reason 5 (not a string) normalized to end_turn (${disclosed}`,
    ]);
  });

  it('prints a bigint by its kind rather than failing the call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await new Membrane(adapterGiving(() => 5n)).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(unmappedWarnings(warn)).toEqual([
      `[membrane] Unmapped adapter stop reason bigint (not a string) normalized to end_turn (${disclosed}`,
    ]);
  });

  it('prints an object by its kind, once though each call gives a fresh one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(adapterGiving(() => ({ reason: 'zz' })));
    for (let call = 0; call < 3; call++) {
      expect((await membrane.complete(zzRequest)).stopReason).toBe('end_turn');
    }
    expect(unmappedWarnings(warn)).toEqual([
      `[membrane] Unmapped adapter stop reason object (not a string) normalized to end_turn (${disclosed}`,
    ]);
  });

  it('prints a token as a JSON string, which providerReason carries when the adapter gives no providerStopReason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await new Membrane(adapterGiving(() => 'zz_unmapped_token')).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBe('zz_unmapped_token');
    expect(unmappedWarnings(warn)).toEqual([
      `[membrane] Unmapped adapter stop reason "zz_unmapped_token" normalized to end_turn (${disclosed}`,
    ]);
  });
});
