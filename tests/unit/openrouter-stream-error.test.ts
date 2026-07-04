/**
 * Mid-stream SSE error events must surface as errors, not truncate silently.
 *
 * OpenRouter delivers upstream failures (e.g. provider 429s) as a data line
 * with an `error` payload inside an HTTP-200 SSE stream. Ignoring it produced
 * a fake-successful empty completion (content: null, finish: stop, usage: 0),
 * which downstream consumers can't distinguish from the model saying nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function streamOnce(adapter: OpenRouterAdapter, chunks: string[]): Promise<unknown> {
  return adapter.stream(
    { model: 'xiaomi/mimo-v2.5', maxTokens: 64, messages: [{ role: 'user', content: 'hi' }] } as any,
    { onChunk: (c: string) => chunks.push(c) } as any,
  );
}

describe('OpenRouterAdapter stream error events', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws on a mid-stream error event (upstream 429)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      '{"error":{"message":"xiaomi/mimo-v2.5 is temporarily rate-limited upstream","code":429}}',
    ])));
    const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
    await expect(streamOnce(adapter, [])).rejects.toThrow(/OpenRouter stream error \(429\).*rate-limited/);
  });

  it('throws even after content chunks already arrived', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      '{"choices":[{"delta":{"content":"partial "}}]}',
      '{"error":{"message":"provider fell over","code":502}}',
    ])));
    const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
    const chunks: string[] = [];
    await expect(streamOnce(adapter, chunks)).rejects.toThrow(/OpenRouter stream error \(502\)/);
    expect(chunks).toEqual(['partial ']);
  });

  it('still completes a normal stream (regression)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      '{"choices":[{"delta":{"content":"hello"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      '[DONE]',
    ])));
    const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
    const chunks: string[] = [];
    const res: any = await streamOnce(adapter, chunks);
    expect(chunks).toEqual(['hello']);
    expect(res.choices?.[0]?.message?.content ?? res.content?.[0]?.text ?? res.rawText ?? 'hello').toBeTruthy();
  });
});
