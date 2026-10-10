import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import type { ProviderRequest } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wire: ProviderRequest = { model: 'zz-review-model', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 };
function sse(frames: unknown[]) {
  return new Response(frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}

// ---------------------------------------------------------------------------
// A completions stream ended by the adapter's own end-of-turn token keeps the
// metadata the provider already sent in that frame.
// ---------------------------------------------------------------------------

describe('completions end-of-turn keeps its frame metadata', () => {
  const adapter = () => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' });
  const frame = (reason?: string, usage = true) => ({
    choices: [{ text: 'hello<|eot|>discard', ...(reason === undefined ? {} : { finish_reason: reason }) }],
    ...(usage ? { usage: { prompt_tokens: 7, completion_tokens: 2 } } : {}),
  });
  it.each(['length', 'stop'])('discloses a supplied %s token beside the local end_turn', async reason => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([frame(reason)])));
    const chunks: string[] = [];
    const response = await adapter().stream(wire, { onChunk: chunk => { chunks.push(chunk); } }) as any;
    expect(response).toMatchObject({ stopReason: 'end_turn', providerStopReason: reason, usage: { inputTokens: 7, outputTokens: 2 } });
    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(chunks.join('')).toBe('hello');
  });
  it('leaves an unsent token absent while keeping the frame usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([frame()])));
    const response = await adapter().stream(wire, { onChunk() {} }) as any;
    expect(response).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 2 } });
    expect(response.providerStopReason).toBeUndefined();
  });
  it('reports zero usage only when the ending frame carried none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([frame('length', false)])));
    const response = await adapter().stream(wire, { onChunk() {} }) as any;
    expect(response).toMatchObject({ stopReason: 'end_turn', providerStopReason: 'length', usage: { inputTokens: 0, outputTokens: 0 } });
  });
  it('stops reading at the token rather than waiting for later frames', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([frame(), { choices: [{ text: '', finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 9 } }])));
    const response = await adapter().stream(wire, { onChunk() {} }) as any;
    expect(response).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 2 } });
    expect(response.providerStopReason).toBeUndefined();
  });
});
