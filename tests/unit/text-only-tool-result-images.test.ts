/**
 * The text-only fallback from #84 stays intact for non-normalized image
 * payloads. Normalized source images now use native/adjacent media parts;
 * tool-result-request-images.test.ts covers those transport paths.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenRouterAdapter, toOpenRouterMessages } from '../../src/providers/openrouter.js';
import { OpenAICompatibleAdapter, toOpenAIMessages } from '../../src/providers/openai-compatible.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import {
  TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER,
  textOnlyToolResultContent,
} from '../../src/providers/utils.js';
import type { ContentBlock, NormalizedMessage, ProviderAdapter } from '../../src/types/index.js';

// PNG signature followed by ~300KB of base64 payload: a realistic screenshot size.
const PNG_HEADER = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
const BIG_PNG = PNG_HEADER + 'A'.repeat(300_000);
const PAYLOAD_PROBE = 'A'.repeat(1_000);

const imageBlock = (data = BIG_PNG): ContentBlock => ({
  type: 'image', source: { type: 'base64', data, mediaType: 'image/png' },
});

function history(resultContent: ContentBlock[]): NormalizedMessage[] {
  return [
    { participant: 'User', content: [{ type: 'text', text: 'Take a screenshot' }] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot_1', name: 'shot', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot_1', content: resultContent }] },
    { participant: 'User', content: [{ type: 'text', text: 'What do you see?' }] },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('textOnlyToolResultContent', () => {
  it('passes strings through unchanged', () => {
    expect(textOnlyToolResultContent('plain result')).toBe('plain result');
  });

  it.each([
    ['text-only array', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]],
    ['object', { ok: true, n: 3 }],
    ['empty array', []],
    ['null', null],
  ])('serializes %s byte-identically to JSON.stringify', (_name, content) => {
    expect(textOnlyToolResultContent(content)).toBe(JSON.stringify(content));
  });

  it('replaces blocks carrying inline image data with the placeholder, keeping other blocks', () => {
    const content = [
      { type: 'text', text: 'Screenshot' },
      imageBlock(),
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_PNG } },
      { type: 'image', data: BIG_PNG, mimeType: 'image/png' },
      { type: 'generated_image', data: BIG_PNG, mimeType: 'image/png' },
    ];
    const original = structuredClone(content);
    const out = textOnlyToolResultContent(content);
    const placeholder = { type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER };
    expect(JSON.parse(out)).toEqual([
      { type: 'text', text: 'Screenshot' }, placeholder, placeholder, placeholder, placeholder,
    ]);
    expect(out).not.toContain(PAYLOAD_PROBE);
    expect(content).toEqual(original);
  });

  it.each([
    ['URL-source image', [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]],
    ['image-typed tool data without a payload', [{ type: 'image', url: 'https://img.example/cat.jpg', title: 'Cat', width: 640 }]],
    ['image with a non-string source', [{ type: 'image', source: null }]],
  ])('leaves %s serialized exactly as before', (_name, content) => {
    expect(textOnlyToolResultContent(content)).toBe(JSON.stringify(content));
  });
});

const chatCompletion = () => new Response(JSON.stringify({
  id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'I see it.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { 'content-type': 'application/json' } });

const geminiResponse = () => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text: 'I see it.' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
}), { headers: { 'content-type': 'application/json' } });

const adapters: Array<[string, () => ProviderAdapter, string, () => Response]> = [
  ['OpenAI', () => new OpenAIAdapter({ apiKey: 'test-key' }), 'gpt-4o', chatCompletion],
  ['OpenRouter', () => new OpenRouterAdapter({ apiKey: 'test-key' }), 'openai/gpt-4o', chatCompletion],
  ['OpenAI-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'test-key', baseURL: 'http://localhost:9999/v1' }), 'local-model', chatCompletion],
  ['Gemini', () => new GeminiAdapter({ apiKey: 'test-key' }), 'gemini-2.5-flash', geminiResponse],
];

describe.each(adapters)('%s adapter: Membrane.complete with tool-result image history', (_name, create, model, respond) => {
  async function sentBody(resultContent: ContentBlock[]): Promise<string> {
    const fetchMock = vi.fn().mockImplementation(async () => respond());
    vi.stubGlobal('fetch', fetchMock);
    await new Membrane(create(), { formatter: new NativeFormatter() }).complete({
      messages: history(resultContent),
      assistantParticipant: 'Claude',
      config: { model, maxTokens: 32 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return fetchMock.mock.calls[0]![1].body as string;
  }

  it('keeps the omission fallback for a generated_image payload', async () => {
    const body = await sentBody([{ type: 'text', text: 'Screenshot taken' }, { type: 'generated_image', data: BIG_PNG, mimeType: 'image/png' } as ContentBlock]);
    expect(body).not.toContain(PAYLOAD_PROBE);
    expect(body).toContain('Screenshot taken');
    // The placeholder sits inside a JSON string that is itself JSON-encoded.
    expect(body).toContain('tool results reach this model as text only');
    expect(body.length).toBeLessThan(5_000);
  });

  it('keeps text-only tool results exactly as JSON.stringify produced them', async () => {
    const resultContent: ContentBlock[] = [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }];
    const body = await sentBody(resultContent);
    expect(body).toContain(JSON.stringify(JSON.stringify(resultContent)));
  });
});

describe('exported ChatCompletions converters', () => {
  it.each([
    ['toOpenRouterMessages', toOpenRouterMessages],
    ['toOpenAIMessages', toOpenAIMessages],
  ] as const)('%s keeps non-normalized generated-image omission', (_name, convert) => {
    const out = convert([{ role: 'user', content: [
      { type: 'tool_result', toolUseId: 'shot_1', content: [{ type: 'text', text: 'Screenshot' }, { type: 'generated_image', data: BIG_PNG, mimeType: 'image/png' }] },
    ] as ContentBlock[] }]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(PAYLOAD_PROBE);
    expect(serialized).toContain('tool results reach this model as text only');
    expect(serialized).toContain('Screenshot');
  });
});
