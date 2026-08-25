/**
 * Shared SSE fixtures for provider-adapter stream tests.
 *
 * Each entry of `dataLines` becomes one `data: <line>\n\n` SSE event, which is
 * the wire shape every OpenAI-family and Gemini adapter parses.
 */
import { vi } from 'vitest';

export function sseResponse(dataLines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of dataLines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function stubFetchWithSseLines(dataLines: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(sseResponse(dataLines));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The single request body the stubbed fetch received, parsed. */
export function capturedRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '{}');
}
