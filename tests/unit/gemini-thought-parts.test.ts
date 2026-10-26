/**
 * Gemini returns its reasoning as ordinary text parts flagged `thought: true`.
 * Google's own samples read the answer as the text of parts where `thought` is
 * not set (long-decode guide, `if p.text and not p.thought`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiAdapter, fromGeminiParts, toGeminiParts } from '../../src/providers/gemini.js';
import { Membrane } from '../../src/membrane.js';
import type { ContentBlock, NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';

const THOUGHT_1 = 'zz-thought-one: the user asked a question. ';
const THOUGHT_2 = 'zz-thought-two: draft an answer.';
const ANSWER_1 = 'zz-answer-part-one ';
const ANSWER_2 = 'zz-answer-part-two';

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 20, totalTokenCount: 34 };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Every request body the stubbed fetch received, parsed. */
let sentBodies: any[] = [];

function stubComplete(parts: unknown[]): void {
  sentBodies = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: USAGE }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
}

/** One SSE frame per inner array of parts, then a terminal frame. */
function stubStream(framesOfParts: unknown[][]): void {
  sentBodies = [];
  const frames = [
    ...framesOfParts.map(parts => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] })}\n\n`),
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: USAGE })}\n\n`,
  ];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;
}

const REQUEST = { model: 'gemini-4-argon', maxTokens: 256, messages: [{ role: 'user', content: 'zz-prompt' }] } as any;

type GeminiTestPart = { text?: string; thought?: boolean };

function textOf(content: ContentBlock[]): string {
  return content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
}

function thinkingOf(content: ContentBlock[]): string {
  return content.filter(b => b.type === 'thinking').map(b => (b as { thinking: string }).thinking).join('');
}

describe('GeminiAdapter thought parts', () => {
  it('complete(): keeps thought parts out of the answer, in a thinking block first', async () => {
    stubComplete([
      { text: THOUGHT_1, thought: true },
      { text: THOUGHT_2, thought: true },
      { text: ANSWER_1 },
      { text: ANSWER_2, thoughtSignature: 'zz-sig' },
    ]);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(REQUEST);

    expect(textOf(response.content)).toBe(ANSWER_1 + ANSWER_2);
    expect(thinkingOf(response.content)).toBe(THOUGHT_1 + THOUGHT_2);
    expect(response.content[0]).toEqual({ type: 'thinking', thinking: THOUGHT_1 + THOUGHT_2 });
    expect(response.content.filter(b => b.type === 'thinking')).toHaveLength(1);
  });

  it('stream(): does not send thought text through onChunk', async () => {
    stubStream([
      [{ text: THOUGHT_1, thought: true }],
      [{ text: THOUGHT_2, thought: true }],
      [{ text: ANSWER_1 }],
      [{ text: ANSWER_2 }],
    ]);
    const chunks: string[] = [];
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(REQUEST, { onChunk: c => chunks.push(c) });

    expect(chunks).toEqual([ANSWER_1, ANSWER_2]);
    expect(textOf(response.content)).toBe(ANSWER_1 + ANSWER_2);
    expect(response.content[0]).toEqual({ type: 'thinking', thinking: THOUGHT_1 + THOUGHT_2 });
  });

  // Recent Gemini models can think again after starting an answer.
  it('stream(): separates interleaved thought and answer parts, including within one frame', async () => {
    stubStream([
      [{ text: THOUGHT_1, thought: true }, { text: ANSWER_1 }],
      [{ text: THOUGHT_2, thought: true }],
      [{ text: ANSWER_2 }],
    ]);
    const chunks: string[] = [];
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(REQUEST, { onChunk: c => chunks.push(c) });

    expect(chunks.join('')).toBe(ANSWER_1 + ANSWER_2);
    expect(textOf(response.content)).toBe(ANSWER_1 + ANSWER_2);
    expect(thinkingOf(response.content)).toBe(THOUGHT_1 + THOUGHT_2);
  });

  // An all-thinking response (Argon can spend a whole hop on reasoning) has no
  // answer: it must not come back as a text block holding the reasoning.
  it('a response of only thought parts has no text block', async () => {
    stubStream([[{ text: THOUGHT_1, thought: true }]]);
    const chunks: string[] = [];
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(REQUEST, { onChunk: c => chunks.push(c) });

    expect(chunks).toEqual([]);
    expect(response.content).toEqual([{ type: 'thinking', thinking: THOUGHT_1 }]);
  });

  it('a response without thought parts is unchanged: no thinking block', async () => {
    stubComplete([{ text: ANSWER_1 }]);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(REQUEST);

    expect(response.content).toEqual([{ type: 'text', text: ANSWER_1 }]);
  });

  // A thinking block in a prior assistant turn is never sent back as answer
  // text: the model would read its own reasoning as something it said aloud.
  // Whether it goes back at all, flagged as a thought, is left open; today
  // convertMessages drops it.
  it('does not send a prior turn\'s thinking block back to the model as answer text', async () => {
    stubComplete([{ text: ANSWER_2 }]);
    await new GeminiAdapter({ apiKey: 'zz-key' }).complete({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'zz-prompt' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: THOUGHT_1 }, { type: 'text', text: ANSWER_1 }] },
        { role: 'user', content: 'zz-follow-up' },
      ],
    });

    const sentParts = sentBodies[0].contents.flatMap((c: { parts: GeminiTestPart[] }) => c.parts);
    expect(sentParts.some((p: GeminiTestPart) => p.text?.includes(ANSWER_1))).toBe(true);
    expect(sentParts.filter((p: GeminiTestPart) => !p.thought && p.text?.includes(THOUGHT_1))).toEqual([]);
  });

  it('fromGeminiParts maps a thought part to a thinking block', () => {
    expect(fromGeminiParts([{ text: THOUGHT_1, thought: true }, { text: ANSWER_1 }] as any)).toEqual([
      { type: 'thinking', thinking: THOUGHT_1 },
      { type: 'text', text: ANSWER_1 },
    ]);
  });

  // The helper is per part, as it always was for text: unlike the adapter's
  // response, it neither joins the thoughts nor moves them to the front.
  it('fromGeminiParts keeps interleaved thought and answer parts in order', () => {
    expect(fromGeminiParts([
      { text: THOUGHT_1, thought: true },
      { text: ANSWER_1 },
      { text: THOUGHT_2, thought: true },
      { text: ANSWER_2 },
    ] as any)).toEqual([
      { type: 'thinking', thinking: THOUGHT_1 },
      { type: 'text', text: ANSWER_1 },
      { type: 'thinking', thinking: THOUGHT_2 },
      { type: 'text', text: ANSWER_2 },
    ]);
  });

  // fromGeminiParts now makes thinking blocks; its inverse must not send one
  // back as answer text (it fell through to String(block): "[object Object]").
  it('toGeminiParts does not turn a thinking block into answer text', () => {
    const parts = toGeminiParts(fromGeminiParts([{ text: THOUGHT_1, thought: true }, { text: ANSWER_1 }] as any));

    expect(parts.filter(p => !p.thought && p.text !== ANSWER_1)).toEqual([]);
    expect(parts).toContainEqual({ text: ANSWER_1 });
  });

  // Live, Argon's tool rounds start with a thought, then the call.
  it('complete(): a thought before a function call is a thinking block, and the call still parses', async () => {
    stubComplete([{ text: THOUGHT_1, thought: true }, { functionCall: { name: 'zz_tool', args: { q: 1 } } }]);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(REQUEST);

    expect(response.content.map(b => b.type)).toEqual(['thinking', 'tool_use']);
    expect(response.content[0]).toEqual({ type: 'thinking', thinking: THOUGHT_1 });
    expect(response.content[1]).toMatchObject({ type: 'tool_use', name: 'zz_tool', input: { q: 1 } });
  });

  it('stream(): a thought before a function call is a thinking block, and the call still parses', async () => {
    stubStream([[{ text: THOUGHT_1, thought: true }], [{ functionCall: { name: 'zz_tool', args: { q: 1 } } }]]);
    const chunks: string[] = [];
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(REQUEST, { onChunk: c => chunks.push(c) });

    expect(chunks).toEqual([]);
    expect(response.content.map(b => b.type)).toEqual(['thinking', 'tool_use']);
    expect(response.content[1]).toMatchObject({ type: 'tool_use', name: 'zz_tool', input: { q: 1 } });
  });

  // From the house's review. Live, gemini-3.5-flash-lite returned a thought
  // part whose text was empty; a thought part may also carry no text.
  it('a thought part with empty or no text adds nothing, to the answer or the thinking', async () => {
    const parts = [{ text: '', thought: true }, { thought: true, thoughtSignature: 'zz-sig' }, { text: ANSWER_1 }];
    stubComplete(parts);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(REQUEST);

    expect(response.content).toEqual([{ type: 'text', text: ANSWER_1 }]);
    expect(fromGeminiParts(parts as any)).toEqual([{ type: 'text', text: ANSWER_1 }]);

    stubStream([[parts[0]], [parts[1]], [parts[2]]]);
    const chunks: string[] = [];
    const streamed = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(REQUEST, { onChunk: c => chunks.push(c) });

    expect(chunks).toEqual([ANSWER_1]);
    expect(streamed.content).toEqual([{ type: 'text', text: ANSWER_1 }]);
  });

  it('complete(): a response of only thought parts has a thinking block and no text block', async () => {
    stubComplete([{ text: THOUGHT_1, thought: true }]);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(REQUEST);

    expect(response.content).toEqual([{ type: 'thinking', thinking: THOUGHT_1 }]);
  });

  // An image model's interim "thought images" are flagged thought, as its
  // thought text is (Google's image-generation guide).
  const THOUGHT_IMAGE = { inlineData: { mimeType: 'image/png', data: 'zz-draft' }, thought: true };
  const FINAL_IMAGE = { inlineData: { mimeType: 'image/png', data: 'zz-final' } };
  const IMAGES = [{ type: 'generated_image', data: 'zz-final', mimeType: 'image/png' }];

  it('complete(): a thought image is not one of the answer\'s images', async () => {
    stubComplete([THOUGHT_IMAGE, FINAL_IMAGE]);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(REQUEST);

    expect(response.content.filter(b => b.type === 'generated_image')).toEqual(IMAGES);
  });

  it('stream(): a thought image is not one of the answer\'s images', async () => {
    stubStream([[THOUGHT_IMAGE], [FINAL_IMAGE]]);
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(REQUEST, { onChunk: () => {} });

    expect(response.content.filter(b => b.type === 'generated_image')).toEqual(IMAGES);
  });

  it('toGeminiParts sends only text and tool calls, not a redacted_thinking block or an image as answer text', () => {
    const parts = toGeminiParts([
      { type: 'redacted_thinking', data: 'zz-redacted' },
      { type: 'generated_image', data: 'zz-final', mimeType: 'image/png' },
      { type: 'text', text: ANSWER_1 },
      { type: 'tool_use', id: 'zz-id', name: 'zz_tool', input: { q: 1 } },
    ] as ContentBlock[]);

    expect(parts).toEqual([{ text: ANSWER_1 }, { functionCall: { name: 'zz_tool', args: { q: 1 } } }]);
  });
});

const MEMBRANE_REQUEST = {
  config: { model: 'gemini-4-argon', maxTokens: 256 },
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

describe('Gemini thought parts through Membrane', () => {
  it('stream(): the answer text, rawAssistantText and chunks carry no thought text', async () => {
    stubStream([
      [{ text: THOUGHT_1, thought: true }],
      [{ text: ANSWER_1 }],
      [{ text: THOUGHT_2, thought: true }],
      [{ text: ANSWER_2 }],
    ]);
    const chunks: string[] = [];
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key' }));
    const response = await membrane.stream(MEMBRANE_REQUEST, { onChunk: (c: string) => chunks.push(c) }) as NormalizedResponse;

    for (const leaked of [THOUGHT_1, THOUGHT_2]) {
      expect(textOf(response.content)).not.toContain(leaked);
      expect(response.rawAssistantText ?? '').not.toContain(leaked);
      expect(chunks.join('')).not.toContain(leaked);
    }
    expect(textOf(response.content)).toContain(ANSWER_1);
    expect(textOf(response.content)).toContain(ANSWER_2);
    expect(thinkingOf(response.content)).toBe(THOUGHT_1 + THOUGHT_2);
    // The answer itself reaches both channels, so the checks above can't pass
    // on a channel that carries nothing.
    expect(response.rawAssistantText).toBe(ANSWER_1 + ANSWER_2);
    expect(chunks.join('')).toBe(ANSWER_1 + ANSWER_2);
  });

  it('complete(): the answer text carries no thought text', async () => {
    stubComplete([{ text: THOUGHT_1, thought: true }, { text: ANSWER_1 }]);
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key' }));
    const response = await membrane.complete(MEMBRANE_REQUEST);

    expect(textOf(response.content)).not.toContain(THOUGHT_1);
    expect(textOf(response.content)).toContain(ANSWER_1);
    expect(thinkingOf(response.content)).toBe(THOUGHT_1);
  });
});
