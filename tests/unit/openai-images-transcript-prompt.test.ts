import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesAdapter,
  DEFAULT_TRANSCRIPT_PREAMBLE,
} from '../../src/providers/openai-responses.js';
import type { ProviderRequest } from '../../src/types/index.js';

const PNG = 'iVBORw0KGgo=';

function img(data = PNG) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
}

function request(messages: unknown[], system?: string): ProviderRequest {
  return {
    model: 'gpt-image-2.5-flare',
    messages: messages as ProviderRequest['messages'],
    maxTokens: 1,
    ...(system ? { system } : {}),
  };
}

function imagesResponse() {
  return new Response(
    JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function capture(
  adapter: OpenAIResponsesAdapter,
  req: ProviderRequest
): Promise<{ url: string; prompt: string; images: number }> {
  const fetchMock = vi.fn().mockResolvedValue(imagesResponse());
  vi.stubGlobal('fetch', fetchMock);
  await adapter.complete(req);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  if (init.body instanceof FormData) {
    return {
      url,
      prompt: String(init.body.get('prompt')),
      images: init.body.getAll('image[]').length,
    };
  }
  const body = JSON.parse(String(init.body)) as { prompt: string };
  return { url, prompt: body.prompt, images: 0 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIResponsesAdapter promptFormat', () => {
  const conversation = [
    { role: 'user', content: [{ type: 'text', text: 'alice: draw a red teapot' }] },
    // A previous generation: image-only assistant message, exactly what the
    // bot's own posted image looks like when history is rebuilt.
    { role: 'assistant', content: [img('AAAA')] },
    { role: 'user', content: [{ type: 'text', text: 'bob: make it blue' }, img('BBBB')] },
  ];

  it('legacy (default) keeps the historical prompt shape and never mentions images', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const { url, prompt, images } = await capture(adapter, request(conversation, 'You draw.'));

    expect(url).toMatch(/images\/edits$/);
    expect(images).toBe(2);
    expect(prompt).toBe('You draw.\n\nUser: alice: draw a red teapot\n\nUser: bob: make it blue');
    expect(prompt).not.toContain('### ');
    expect(prompt).not.toContain('[Image');
  });

  it('transcript gives the image-only assistant message its own turn with a numbered reference', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript' });
    const { url, prompt, images } = await capture(adapter, request(conversation, 'You draw.'));

    expect(url).toMatch(/images\/edits$/);
    expect(images).toBe(2);
    expect(prompt).toBe(
      [
        'You draw.',
        DEFAULT_TRANSCRIPT_PREAMBLE,
        '### User\nalice: draw a red teapot\n\n### Assistant\n[Image 1]\n\n### User\nbob: make it blue\n[Image 2]',
        '### Assistant',
      ].join('\n\n')
    );
  });

  it('transcript text-only conversations use /generations and still end with an open assistant turn', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript' });
    const { url, prompt, images } = await capture(adapter, request([
      { role: 'user', content: [{ type: 'text', text: 'alice: a lighthouse at dusk' }] },
    ]));

    expect(url).toMatch(/images\/generations$/);
    expect(images).toBe(0);
    expect(prompt.endsWith('### User\nalice: a lighthouse at dusk\n\n### Assistant')).toBe(true);
  });

  it('transcript merges consecutive same-role messages under one header', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript', transcriptPreamble: '' });
    const { prompt } = await capture(adapter, request([
      { role: 'user', content: [{ type: 'text', text: 'alice: one' }] },
      { role: 'user', content: [{ type: 'text', text: 'bob: two' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [] },
    ]));

    expect(prompt).toBe('### User\nalice: one\nbob: two\n\n### Assistant\nok\n\n### Assistant');
  });

  it('transcript keeps the most recent images under the cap and marks the rest omitted; legacy keeps the first', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'first' }, img('1111')] },
      { role: 'assistant', content: [img('2222')] },
      { role: 'user', content: [{ type: 'text', text: 'third' }, img('3333')] },
    ];

    const transcript = new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript', maxInputImages: 2, transcriptPreamble: '' });
    const t = await capture(transcript, request(messages));
    expect(t.images).toBe(2);
    expect(t.prompt).toBe('### User\nfirst\n[Image omitted]\n\n### Assistant\n[Image 1]\n\n### User\nthird\n[Image 2]\n\n### Assistant');

    const legacyFetch = vi.fn().mockResolvedValue(imagesResponse());
    vi.stubGlobal('fetch', legacyFetch);
    const legacy = new OpenAIResponsesAdapter({ apiKey: 'sk-test', maxInputImages: 2 });
    await legacy.complete(request(messages));
    const form = (legacyFetch.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    const blobs = form.getAll('image[]') as Blob[];
    expect(blobs.length).toBe(2);
    expect(Buffer.from(await blobs[0]!.arrayBuffer()).toString('base64')).toBe('1111');
    expect(Buffer.from(await blobs[1]!.arrayBuffer()).toString('base64')).toBe('2222');
  });

  it('clamps maxInputImages to the API cap of 16', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript', maxInputImages: 99 });
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: [img(`${i}`.padStart(4, 'A'))] }));
    const { images, prompt } = await capture(adapter, request(messages));
    expect(images).toBe(16);
    expect((prompt.match(/\[Image omitted\]/g) ?? []).length).toBe(4);
    expect(prompt).toContain('[Image 16]');
  });
});
