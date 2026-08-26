/**
 * Split-turn image continuations (A3 BLOCKER-1) and the continuation
 * builders' `extra` contract (A3 MINOR-5).
 *
 * When a tool result carries an image in XML prefill mode, membrane splits
 * the assistant turn — assistant(text) / user([image]) / assistant(closing
 * XML) — because the API only accepts images in user turns. The split has to
 * be PERSISTED: every later continuation rebuilds its messages from the
 * turn's build result, so a split that lives only in one request vanishes on
 * the next round while the accumulated document still claims a screenshot
 * came back.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, ToolResult, ToolResultContentBlock } from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

// 1x1 red pixel PNG — the only base64 in this file, so a grep for it lands here.
const ZZ_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

interface ScriptedRound {
  text: string;
  stopReason: string;
  stopSequence?: string;
}

/** Records every provider request and plays a fixed script of stream rounds. */
class RecordingXmlAdapter implements ProviderAdapter {
  readonly name = 'zz-recording';
  readonly requests: ProviderRequest[] = [];
  streamCalls = 0;

  constructor(private script: ScriptedRound[]) {}

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('zz-recording adapter: complete() is not used by these tests');
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.requests.push(request);
    const round = this.script[Math.min(this.streamCalls, this.script.length - 1)]!;
    this.streamCalls++;
    callbacks.onChunk(round.text);
    return {
      content: [{ type: 'text', text: round.text }],
      stopReason: round.stopReason,
      stopSequence: round.stopSequence,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz please shoot' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};

const CALL_XML =
  '<function_calls>\n<invoke name="zz_shot">\n<parameter name="fld1">ite1</parameter>\n</invoke>';

/** Two tool rounds then a natural finish; round 1's result carries an image. */
const SCRIPT: ScriptedRound[] = [
  { text: `zz preamble one\n${CALL_XML}`, stopReason: 'stop_sequence', stopSequence: '</function_calls>' },
  { text: `zz preamble two\n${CALL_XML}`, stopReason: 'stop_sequence', stopSequence: '</function_calls>' },
  { text: 'zz final answer', stopReason: 'end_turn' },
];

function imageResult(toolUseId: string): ToolResult {
  const content: ToolResultContentBlock[] = [
    { type: 'text', text: 'zz shot ok' },
    { type: 'image', source: { type: 'base64', data: ZZ_PIXEL, mediaType: 'image/png' } },
  ];
  return { toolUseId, toolName: 'zz_shot', content };
}

function textResult(toolUseId: string): ToolResult {
  return { toolUseId, toolName: 'zz_shot', content: 'zz plain ok' };
}

/** `role:kind` census of one request's messages — the A3 red fixture's shape. */
function roleCensus(request: ProviderRequest): string[] {
  return (request.messages as Array<{ role: string; content: unknown }>).map((m) => {
    if (typeof m.content === 'string') return `${m.role}:text`;
    if (Array.isArray(m.content)) {
      const types = m.content.map((b: any) => b?.type ?? 'unknown');
      return `${m.role}:[${types.join(',')}]`;
    }
    return `${m.role}:other`;
  });
}

function serialize(request: ProviderRequest): string {
  return JSON.stringify(request.messages);
}

async function runTwoToolRounds() {
  const adapter = new RecordingXmlAdapter(SCRIPT);
  const membrane = new Membrane(adapter);
  let round = 0;
  const response = await membrane.stream(REQUEST, {
    onToolCalls: async (calls) => {
      round++;
      return round === 1 ? [imageResult(calls[0]!.id)] : [textResult(calls[0]!.id)];
    },
  });
  return { adapter, response };
}

describe('split-turn image continuation persistence', () => {
  it('keeps the image user-turn on every continuation after the image round', async () => {
    const { adapter } = await runTwoToolRounds();

    expect(adapter.streamCalls).toBe(3);

    // Request 1 (the immediate image continuation) carries the split turn.
    expect(roleCensus(adapter.requests[1]!)).toEqual([
      'user:text',
      'assistant:text',
      'user:[image]',
      'assistant:text',
    ]);
    expect(serialize(adapter.requests[1]!)).toContain(ZZ_PIXEL);

    // Request 2 is a plain continuation built AFTER the image round. The
    // model is still being shown a <function_results> block asserting a
    // screenshot came back, so the image turn must still be on the wire.
    expect(serialize(adapter.requests[2]!)).toContain(ZZ_PIXEL);
    expect(roleCensus(adapter.requests[2]!)).toEqual([
      'user:text',
      'assistant:text',
      'user:[image]',
      'assistant:text',
    ]);
  });

  it('does not duplicate the pre-image assistant text across the split', async () => {
    const { adapter } = await runTwoToolRounds();

    const messages = adapter.requests[2]!.messages as Array<{ role: string; content: unknown }>;
    const preImage = messages[1]!.content as string;
    const postImage = messages[3]!.content as string;

    // The pre-image assistant turn ends at the image seam; the post-image
    // turn carries the closers and everything the model wrote after them.
    expect(preImage).toContain('zz preamble one');
    expect(postImage).not.toContain('zz preamble one');
    expect(postImage).toContain('zz preamble two');
    expect(postImage.trimStart().startsWith('</stdout>')).toBe(true);
  });

  it('reports the whole turn in rawAssistantText regardless of the split', async () => {
    const { response } = await runTwoToolRounds();
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('zz preamble one');
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('zz preamble two');
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('zz final answer');
  });
});

describe('a second image round composes onto the first', () => {
  it('stacks both image turns without duplicating text across the seams', async () => {
    const adapter = new RecordingXmlAdapter([
      { text: `zz preamble one\n${CALL_XML}`, stopReason: 'stop_sequence', stopSequence: '</function_calls>' },
      { text: `zz preamble two\n${CALL_XML}`, stopReason: 'stop_sequence', stopSequence: '</function_calls>' },
      { text: 'zz final answer', stopReason: 'end_turn' },
    ]);
    const membrane = new Membrane(adapter);
    await membrane.stream(REQUEST, {
      onToolCalls: async (calls) => [imageResult(calls[0]!.id)],
    });

    expect(adapter.streamCalls).toBe(3);
    expect(roleCensus(adapter.requests[2]!)).toEqual([
      'user:text',
      'assistant:text',
      'user:[image]',
      'assistant:text',
      'user:[image]',
      'assistant:text',
    ]);

    const messages = adapter.requests[2]!.messages as Array<{ role: string; content: unknown }>;
    const firstAssistant = messages[1]!.content as string;
    const secondAssistant = messages[3]!.content as string;
    const thirdAssistant = messages[5]!.content as string;

    expect(firstAssistant).toContain('zz preamble one');
    expect(secondAssistant).not.toContain('zz preamble one');
    expect(secondAssistant).toContain('zz preamble two');
    expect(thirdAssistant).not.toContain('zz preamble two');
  });
});

describe('continuation builders carry the transformRequest extra contract', () => {
  it('supplies normalizedMessages on every continuation, and prompt on both builders', async () => {
    const { adapter } = await runTwoToolRounds();

    for (const [index, request] of adapter.requests.entries()) {
      const extra = request.extra as Record<string, unknown> | undefined;
      expect(extra, `request ${index} has no extra`).toBeDefined();
      expect(extra!.normalizedMessages, `request ${index} dropped normalizedMessages`).toBeDefined();
    }

    // The image builder (request 1) previously supplied neither, dropping a
    // completions-style adapter onto serializeToPrompt over provider-shaped
    // messages.
    expect((adapter.requests[1]!.extra as Record<string, unknown>).prompt).toEqual(
      expect.stringContaining('zz preamble one'),
    );
    expect((adapter.requests[2]!.extra as Record<string, unknown>).prompt).toEqual(
      expect.stringContaining('zz preamble two'),
    );
  });
});
