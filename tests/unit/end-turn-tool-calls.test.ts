/**
 * The API occasionally reports stop_reason 'end_turn' for a response that
 * ends in complete tool_use blocks (seen on claude-opus-5: thinking + one
 * fully-formed call, far under max_tokens). The native yielding path gated
 * dispatch on stop_reason === 'tool_use' alone, so those calls were written
 * into history and never run — the agent's message simply vanished.
 */
import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { parseToolArguments } from '../../src/providers/utils.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/provider.js';
import type { NormalizedRequest, ToolResult } from '../../src/types/index.js';

/** Replies with `first` on the first call, then a plain text end_turn. */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'zz-scripted';
  calls = 0;
  constructor(private first: ProviderResponse) {}

  private next(): ProviderResponse {
    this.calls++;
    if (this.calls === 1) return this.first;
    return {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 1 },
      raw: {},
    } as unknown as ProviderResponse;
  }

  async complete(_r: ProviderRequest, _o?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.next();
  }

  async stream(_r: ProviderRequest, callbacks: StreamCallbacks, _o?: ProviderRequestOptions): Promise<ProviderResponse> {
    callbacks.onChunk?.('');
    return this.next();
  }
}

function toolResponse(stopReason: string, extra: Record<string, unknown> = {}): ProviderResponse {
  return {
    content: [
      { type: 'thinking', thinking: 'zz', signature: 'zz-sig' },
      { type: 'tool_use', id: 'toolu_zz1', name: 'zz_send', input: { content: 'hello' }, ...extra },
    ],
    stopReason,
    usage: { inputTokens: 2, outputTokens: 3828 },
    raw: {},
  } as unknown as ProviderResponse;
}

function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz prompt' }] }],
    toolMode: 'native',
    tools: [{ name: 'zz_send', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
    config: { model: 'zz-model-1', maxTokens: 32768 },
  } as NormalizedRequest;
}

async function dispatchedCalls(first: ProviderResponse): Promise<string[]> {
  const membrane = new Membrane(new ScriptedAdapter(first));
  const names: string[] = [];
  const stream = membrane.streamYielding(request());
  for await (const event of stream) {
    if (event.type === 'tool-calls') {
      names.push(...event.calls.map((c) => c.name));
      const results: ToolResult[] = event.calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false }));
      stream.provideToolResults(results);
    } else if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
      break;
    }
  }
  return names;
}

describe('native tool dispatch vs stop_reason', () => {
  it("dispatches complete tool_use blocks even when stop_reason is 'end_turn'", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await dispatchedCalls(toolResponse('end_turn'))).toEqual(['zz_send']);
      expect(warn.mock.calls.filter(([m]) => String(m).includes("stop_reason 'end_turn'"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("still dispatches the normal stop_reason 'tool_use' case", async () => {
    expect(await dispatchedCalls(toolResponse('tool_use'))).toEqual(['zz_send']);
  });

  it('does not dispatch a truncated (max_tokens) call', async () => {
    expect(await dispatchedCalls(toolResponse('max_tokens'))).toEqual([]);
  });

  it("does not dispatch an 'end_turn' call whose arguments failed to parse", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await dispatchedCalls(toolResponse('end_turn', { unparseableInput: '{"content":"hel' }))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseToolArguments (OpenAI-family adapters)', () => {
  it('marks malformed argument JSON instead of passing it off as an empty call', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseToolArguments('{"content":"hel')).toEqual({ input: {}, unparseableInput: '{"content":"hel' });
    } finally {
      warn.mockRestore();
    }
    expect(parseToolArguments('{"content":"hello"}')).toEqual({ input: { content: 'hello' } });
    expect(parseToolArguments('')).toEqual({ input: {} });
    expect(parseToolArguments(undefined)).toEqual({ input: {} });
  });

  it('a malformed call from such an adapter is not rescued under end_turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fields = parseToolArguments('{"content":"hel');
      const response = {
        content: [{ type: 'tool_use', id: 'call_1', name: 'zz_send', ...fields }],
        stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 10 },
        raw: {},
      } as unknown as ProviderResponse;
      expect(await dispatchedCalls(response)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
