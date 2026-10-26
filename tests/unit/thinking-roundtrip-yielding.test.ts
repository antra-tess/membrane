import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { toAnthropicContent, fromAnthropicContent } from '../../src/providers/anthropic.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
  ContentBlock,
} from '../../src/types/index.js';

interface ScriptedTurn {
  chunks: string[];
  content: ProviderResponse['content'];
}

class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  lastStreamOptions: ProviderRequestOptions | undefined;
  private turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }

  async stream(
    _request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    this.lastStreamOptions = options;
    const turn = this.turns.shift();
    if (!turn) throw new Error('no scripted turn left');
    for (const chunk of turn.chunks) {
      callbacks.onChunk(chunk);
    }
    return {
      content: turn.content,
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
      raw: {},
    };
  }
}

function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
    config: { model: 'test-model', maxTokens: 1000, thinking: { enabled: true, budgetTokens: 1024 } },
    toolMode: 'xml',
  };
}

async function runYielding(membrane: Membrane): Promise<ContentBlock[]> {
  const stream = membrane.streamYielding(request());
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  const complete = events.find((e) => e.type === 'complete') as any;
  expect(complete).toBeDefined();
  return complete.response.content as ContentBlock[];
}

describe('runXmlToolsYielding: signed thinking round-trip', () => {
  it('asks the provider to wrap native thinking deltas', async () => {
    const adapter = new ScriptedAdapter([
      { chunks: ['Answer'], content: [{ type: 'text', text: 'Answer' }] },
    ]);
    const membrane = new Membrane(adapter);
    await runYielding(membrane);
    expect((adapter.lastStreamOptions as any)?.wrapThinkingTags).toBe(true);
  });

  it('merges provider signatures into parser-derived thinking blocks', async () => {
    const adapter = new ScriptedAdapter([
      {
        chunks: ['<thinking>let me reason</thinking>', 'Answer'],
        content: [
          { type: 'thinking', thinking: 'let me reason', signature: 'sig_abc' },
          { type: 'text', text: 'Answer' },
        ] as any,
      },
    ]);
    const membrane = new Membrane(adapter);
    const content = await runYielding(membrane);

    const thinking = content.filter((b) => b.type === 'thinking') as any[];
    expect(thinking.length).toBe(1);
    expect(thinking[0].thinking).toContain('let me reason');
    expect(thinking[0].signature).toBe('sig_abc');
  });

  it('prepends signature-only thinking blocks (display: omitted)', async () => {
    const adapter = new ScriptedAdapter([
      {
        // display:'omitted' → no thinking text ever streams; the provider
        // returns an empty thinking block that carries only the signature.
        chunks: ['Answer'],
        content: [
          { type: 'thinking', thinking: '', signature: 'sig_encrypted' },
          { type: 'text', text: 'Answer' },
        ] as any,
      },
    ]);
    const membrane = new Membrane(adapter);
    const content = await runYielding(membrane);

    const first = content[0] as any;
    expect(first.type).toBe('thinking');
    expect(first.thinking).toBe('');
    expect(first.signature).toBe('sig_encrypted');
    expect(content.some((b) => b.type === 'text')).toBe(true);
  });

  it('passes redacted_thinking through verbatim with data', async () => {
    const adapter = new ScriptedAdapter([
      {
        chunks: ['Answer'],
        content: [
          { type: 'redacted_thinking', data: 'ENCRYPTED_PAYLOAD' },
          { type: 'text', text: 'Answer' },
        ] as any,
      },
    ]);
    const membrane = new Membrane(adapter);
    const content = await runYielding(membrane);

    const redacted = content.find((b) => b.type === 'redacted_thinking') as any;
    expect(redacted).toBeDefined();
    expect(redacted.data).toBe('ENCRYPTED_PAYLOAD');
  });
});

describe('Anthropic converters: redacted_thinking data', () => {
  it('fromAnthropicContent preserves the encrypted data field', () => {
    const result = fromAnthropicContent([
      { type: 'redacted_thinking', data: 'ENC123' } as any,
      { type: 'text', text: 'hi' } as any,
    ]);
    const redacted = result.find((b) => b.type === 'redacted_thinking') as any;
    expect(redacted).toBeDefined();
    expect(redacted.data).toBe('ENC123');
  });

  it('toAnthropicContent round-trips redacted_thinking verbatim', () => {
    const result = toAnthropicContent([
      { type: 'redacted_thinking', data: 'ENC456' } as any,
      { type: 'text', text: 'hi' } as any,
    ]);
    const redacted = (result as any[]).find((b) => b.type === 'redacted_thinking');
    expect(redacted).toBeDefined();
    expect(redacted.data).toBe('ENC456');
  });
});
