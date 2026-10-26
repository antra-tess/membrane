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

export function rawSseResponse(bodyChunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const bodyChunk of bodyChunks) {
        controller.enqueue(encoder.encode(bodyChunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function stubFetchWithRawSse(bodyChunks: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(rawSseResponse(bodyChunks));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * A server or proxy that closes the connection right after writing the last
 * event can leave that event without its trailing newline.
 */
export function sseBodyWithUnterminatedTail(dataLines: string[]): string {
  const terminatedHead = dataLines.slice(0, -1).map((line) => `data: ${line}\n\n`).join('');
  return `${terminatedHead}data: ${dataLines[dataLines.length - 1]}`;
}

export function capturedRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '{}');
}
