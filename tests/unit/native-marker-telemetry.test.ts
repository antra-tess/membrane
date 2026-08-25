/**
 * `details.cache.markersInRequest` on the native tool paths.
 *
 * Both native builders hardcoded 0 while placing markers of their own —
 * including the floating tool-loop marker — so the ≤4-breakpoint discipline
 * was unauditable from response telemetry on exactly the paths that spend the
 * budget most aggressively. The number now comes from a recount of the
 * request that was actually built.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';

function markerCountingAdapter() {
  return {
    name: 'zz-marker-telemetry',
    supportsModel: () => true,
    complete: async () => ({
      content: [{ type: 'text', text: 'zz answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      raw: {},
    }),
    stream: async (_request: any, callbacks: any) => {
      callbacks.onChunk('zz answer');
      return {
        content: [{ type: 'text', text: 'zz answer' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        raw: {},
      };
    },
  };
}

function nativeRequest(): NormalizedRequest {
  return {
    messages: [
      { participant: 'zzOperator', content: [{ type: 'text', text: 'zz go' }], cacheBreakpoint: true },
    ],
    system: 'zz system prompt',
    config: { model: 'claude-haiku-4-5-20251001', maxTokens: 128 },
    tools: [{ name: 'zz_shell', description: 'zz run a command', inputSchema: { type: 'object' } }],
    toolMode: 'native',
    promptCaching: true,
    assistantParticipant: 'Claude',
  } as unknown as NormalizedRequest;
}

describe('native paths report the markers they placed', () => {
  it('streamWithNativeTools reports a non-zero markersInRequest', async () => {
    const membrane = new Membrane(markerCountingAdapter() as any);
    const response = await membrane.stream(nativeRequest(), { onChunk: () => {} });
    expect((response as any).details.cache.markersInRequest).toBe(1);
  });

  it('runNativeToolsYielding reports a non-zero markersInRequest', async () => {
    const membrane = new Membrane(markerCountingAdapter() as any);
    const events: StreamEvent[] = [];
    for await (const event of membrane.streamYielding(nativeRequest())) events.push(event);
    const complete = events.find((e) => e.type === 'complete') as any;
    expect(complete.response.details.cache.markersInRequest).toBe(1);
  });

  it('reports zero when prompt caching is off', async () => {
    const membrane = new Membrane(markerCountingAdapter() as any);
    const response = await membrane.stream(
      { ...nativeRequest(), promptCaching: false } as NormalizedRequest,
      { onChunk: () => {} }
    );
    expect((response as any).details.cache.markersInRequest).toBe(0);
  });
});
