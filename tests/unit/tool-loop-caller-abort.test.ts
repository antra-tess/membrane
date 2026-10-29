import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, ToolCall, ToolDefinition, ToolResult } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StreamCallbacks } from '../../src/types/provider.js';

const OPEN = '<' + 'function_calls>';
type Turn = { content: ProviderResponse['content']; chunk: string; stopReason: string; stopSequence?: string };

class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'zz-scripted';
  calls = 0;
  constructor(private readonly turns: Turn[]) {}
  supportsModel(): boolean { return true; }
  private next(): Turn {
    return this.turns.shift() ?? { content: [{ type: 'text', text: 'zz done' }], chunk: 'zz done', stopReason: 'end_turn' };
  }
  private respond(request: ProviderRequest, turn: Turn): ProviderResponse {
    return { content: turn.content, stopReason: turn.stopReason, stopSequence: turn.stopSequence, usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
  }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    return this.respond(request, this.next());
  }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    this.calls += 1;
    const turn = this.next();
    callbacks.onChunk(turn.chunk);
    return this.respond(request, turn);
  }
}

const tool: ToolDefinition = { name: 'zz_tool', description: 'zz tool', inputSchema: { type: 'object', properties: {} } };
const request = (toolMode: 'xml' | 'native'): NormalizedRequest => ({
  toolMode,
  tools: [tool],
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
  config: { model: 'claude-sonnet-4-5', maxTokens: 64 },
});
const toolTurn = (toolMode: 'xml' | 'native', id = 'zz-call-1'): Turn => {
  if (toolMode === 'native') {
    return {
      content: [{ type: 'text', text: 'zz before' }, { type: 'tool_use', id, name: 'zz_tool', input: {} } as never],
      chunk: 'zz before',
      stopReason: 'tool_use',
    };
  }
  const text = `zz before\n${OPEN}\n<invoke name="zz_tool">\n</invoke>\n`;
  return { content: [{ type: 'text', text }], chunk: text, stopReason: 'stop_sequence', stopSequence: '</function_calls>' };
};
const answer = (calls: ToolCall[]): ToolResult[] => calls.map((call) => ({ toolUseId: call.id, content: 'zz ok' }));

describe.each(['xml', 'native'] as const)("stream()'s %s tool loop and the caller's signal", (toolMode) => {
  it('runs the round and goes on when nothing aborts', async () => {
    const adapter = new ScriptedAdapter([toolTurn(toolMode)]);
    const ran: string[] = [];
    const response = await new Membrane(adapter).stream(request(toolMode), {
      signal: new AbortController().signal,
      onPreToolContent: async () => { ran.push('pre'); },
      onToolCalls: async (calls) => { ran.push('tools'); return answer(calls); },
    });
    expect(isAbortedResponse(response)).toBe(false);
    expect(ran).toEqual(['pre', 'tools']);
    expect(adapter.calls).toBe(2);
  });

  const triggers = toolMode === 'xml'
    ? (['onChunk', 'onPreToolContent', 'the tool_call block event'] as const)
    : (['onChunk', 'onPreToolContent'] as const);
  it.each(triggers)('runs none of a round\'s tools once the signal fires in %s, and ends as the caller\'s abort listing only the rounds that ran', async (trigger) => {
    const adapter = new ScriptedAdapter([toolTurn(toolMode, 'zz-call-1'), toolTurn(toolMode, 'zz-call-2')]);
    const caller = new AbortController();
    const abortInRound2 = (where: typeof trigger) => { if (trigger === where && adapter.calls === 2) caller.abort(); };
    const ran: string[] = [];
    const ranCalls: ToolCall[] = [];
    const answered: ToolResult[] = [];
    const response = await new Membrane(adapter).stream(request(toolMode), {
      signal: caller.signal,
      onChunk: () => { abortInRound2('onChunk'); },
      onBlock: (event) => {
        if (event.event === 'block_complete' && event.block.type === 'tool_call') abortInRound2('the tool_call block event');
      },
      ...(trigger === 'onChunk' ? {} : {
        onPreToolContent: async () => { ran.push(`pre ${adapter.calls}`); abortInRound2('onPreToolContent'); },
      }),
      onToolCalls: async (calls) => {
        ran.push(`tools ${adapter.calls}`);
        ranCalls.push(...calls);
        const results = answer(calls);
        answered.push(...results);
        return results;
      },
    });
    expect(ran).toEqual(trigger === 'onChunk' ? ['tools 1'] : ['pre 1', 'tools 1', 'pre 2']);
    expect(response).toMatchObject({ aborted: true, reason: 'user' });
    const { toolCalls, toolResults } = response as { toolCalls?: ToolCall[]; toolResults?: ToolResult[] };
    expect(toolCalls).toEqual(ranCalls);
    expect(toolResults).toEqual(answered);
    expect(adapter.calls).toBe(2);
  });
});

