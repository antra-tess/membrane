/**
 * A prompt Gemini blocks before generation reaches the streaming endpoint as
 * frames carrying promptFeedback.blockReason with no candidates at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';

const zzStreamRequest = {
  model: 'zz-model-1',
  messages: [{ role: 'user', content: 'zz-prompt' }],
  maxTokens: 16,
};

const zzBlockedPromptPayload = {
  promptFeedback: { blockReason: 'PROHIBITED_CONTENT', safetyRatings: [] },
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 },
};

function sseResponse(frames: unknown[], endWithFrameTerminator = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      frames.forEach((frame, index) => {
        const isFinal = index === frames.length - 1;
        const terminator = isFinal && !endWithFrameTerminator ? '' : '\n\n';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}${terminator}`));
      });
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function streamFrames(frames: unknown[], endWithFrameTerminator = true) {
  vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames, endWithFrameTerminator)));
  const chunks: string[] = [];
  const adapter = new GeminiAdapter({ apiKey: 'zz-key-gemini' });
  return adapter
    .stream(zzStreamRequest as any, { onChunk: (chunk: string) => chunks.push(chunk) })
    .then(response => ({ response, chunks }));
}

function completePayload(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
  return new GeminiAdapter({ apiKey: 'zz-key-gemini' }).complete(zzStreamRequest as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gemini streaming surfaces a prompt blocked before generation', () => {
  it('reports a promptFeedback-only stream as a refusal, not a clean end_turn', async () => {
    const { response, chunks } = await streamFrames([zzBlockedPromptPayload]);
    expect(response.stopReason).toBe('refusal');
    expect(response.content).toEqual([]);
    expect(chunks).toEqual([]);
    expect(response.raw).toMatchObject({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  });

  it('reports the same block arriving as an unterminated final frame', async () => {
    const { response } = await streamFrames([zzBlockedPromptPayload], false);
    expect(response.stopReason).toBe('refusal');
    expect(response.raw).toMatchObject({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } });
  });

  it('maps a blocked prompt exactly as the non-streaming path maps the same payload', async () => {
    const { response: streamed } = await streamFrames([zzBlockedPromptPayload]);
    const completed = await completePayload(zzBlockedPromptPayload);
    expect({
      content: streamed.content,
      stopReason: streamed.stopReason,
      stopSequence: streamed.stopSequence,
      usage: streamed.usage,
      model: streamed.model,
    }).toEqual({
      content: completed.content,
      stopReason: completed.stopReason,
      stopSequence: completed.stopSequence,
      usage: completed.usage,
      model: completed.model,
    });
  });

  it('lets streamed candidates win when safety metadata rides beside real content', async () => {
    const { response, chunks } = await streamFrames([
      { promptFeedback: { blockReason: 'PROHIBITED_CONTENT', safetyRatings: [] } },
      { candidates: [{ content: { parts: [{ text: 'zz-answer' }] } }] },
      {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      },
    ]);
    expect(chunks).toEqual(['zz-answer']);
    expect(response.stopReason).toBe('end_turn');
    expect(response.content).toEqual([{ type: 'text', text: 'zz-answer' }]);
    expect(response.usage.outputTokens).toBe(3);
  });

  it('leaves an ordinary unblocked stream on end_turn', async () => {
    const { response, chunks } = await streamFrames([
      { candidates: [{ content: { parts: [{ text: 'zz-plain' }] } }] },
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
    ]);
    expect(chunks).toEqual(['zz-plain']);
    expect(response.stopReason).toBe('end_turn');
  });
});

// Gemini's API speaks proto3's JSON mapping, where a null field is unset.
describe('gemini reads a null blockReason and a candidate with no data as unset', () => {
  it('complete(): a null blockReason with no candidates is no block, so the empty response ends end_turn', async () => {
    const response = await completePayload({ promptFeedback: { blockReason: null }, usageMetadata: { promptTokenCount: 4 } });
    expect(response.stopReason).toBe('end_turn');
    expect(response.providerStopReason).toBeUndefined();
  });

  it('stream(): a null blockReason with no candidates ends no stream, which fails as one cut short', async () => {
    await expect(streamFrames([{ promptFeedback: { blockReason: null }, usageMetadata: { promptTokenCount: 4 } }]))
      .rejects.toThrow('Gemini stream ended before a terminal event');
  });

  it('a candidate with no data beside a block is a refusal on both paths', async () => {
    for (const candidate of [{}, { finishReason: null }, { content: null }, { content: null, finishReason: null }]) {
      const payload = { candidates: [candidate], promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 4 } };
      const completed = await completePayload(payload);
      const { response: streamed } = await streamFrames([payload]);
      for (const [path, response] of [['complete()', completed], ['stream()', streamed]] as const) {
        expect(response.stopReason, `${path} ${JSON.stringify(candidate)}`).toBe('refusal');
        expect(response.providerStopReason, `${path} ${JSON.stringify(candidate)}`).toBe('SAFETY');
      }
    }
  });

  it('a candidate with a finish reason beside a block wins over it on both paths', async () => {
    const payload = { candidates: [{ finishReason: 'STOP' }], promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 4 } };
    const completed = await completePayload(payload);
    const { response: streamed } = await streamFrames([payload]);
    for (const [path, response] of [['complete()', completed], ['stream()', streamed]] as const) {
      expect(response.stopReason, path).toBe('end_turn');
      expect(response.providerStopReason, path).toBe('STOP');
    }
  });

  it('a candidate with content and no finish reason beside a block wins over it, and a stream still needs its terminal event', async () => {
    const payload = {
      candidates: [{ content: { parts: [{ text: 'zz-answer' }] } }],
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 4 },
    };
    const completed = await completePayload(payload);
    expect(completed.stopReason).toBe('end_turn');
    expect(completed.content).toEqual([{ type: 'text', text: 'zz-answer' }]);
    expect(completed.providerStopReason).toBeUndefined();
    await expect(streamFrames([payload])).rejects.toThrow('Gemini stream ended before a terminal event');
  });

  it('stream(): a later frame with a null blockReason keeps the block an earlier frame gave', async () => {
    const { response } = await streamFrames([
      { promptFeedback: { blockReason: 'SAFETY' } },
      { promptFeedback: { blockReason: null }, usageMetadata: { promptTokenCount: 4 } },
    ]);
    expect(response.stopReason).toBe('refusal');
    expect(response.providerStopReason).toBe('SAFETY');
    expect(response.raw).toMatchObject({ promptFeedback: { blockReason: 'SAFETY' } });
  });
});
