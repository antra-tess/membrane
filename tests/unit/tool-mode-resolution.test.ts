/**
 * Tool-mode resolution is ONE decision, made by Membrane.resolveToolMode, and
 * both request paths must obey it identically.
 *
 * Before this suite, complete() never consulted resolveToolMode: it built
 * through AnthropicXmlFormatter's constructor-time config.toolMode, so a
 * request carrying toolMode: 'native' still got XML tool instructions injected
 * into the conversation and no native tool declarations on the wire, while the
 * same request through stream() got native tools.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type {
  ContentBlock,
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  ToolCall,
  ToolDefinition,
  ToolMode,
  ToolResult,
} from '../../src/types/index.js';

const zzDialTool: ToolDefinition = {
  name: 'zz_dial_tool',
  description: 'zz fixture tool for tool-mode resolution',
  inputSchema: {
    type: 'object' as const,
    properties: { zzarg1: { type: 'string', description: 'zz fixture argument' } },
    required: ['zzarg1'],
  },
};

function zzRequest(toolMode?: ToolMode): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz fixture prompt' }] }],
    tools: [zzDialTool],
    ...(toolMode ? { toolMode } : {}),
    config: { model: 'zz-model-1', maxTokens: 64 },
  };
}

/**
 * The two wire-visible consequences of the tool-mode decision: native tool
 * declarations on the provider request, and XML tool instructions injected
 * into the built conversation/system text.
 */
function toolModeEvidence(adapter: MockAdapter): { nativeToolNames: string[]; xmlInjected: boolean } {
  const lastRequest = adapter.getLastRequest() as unknown as {
    tools?: Array<{ name: string }>;
    messages: unknown;
    system?: unknown;
  };
  const builtText = JSON.stringify(lastRequest.messages) + JSON.stringify(lastRequest.system ?? '');
  return {
    nativeToolNames: (lastRequest.tools ?? []).map(tool => tool.name),
    xmlInjected: builtText.includes('zz_dial_tool'),
  };
}

async function evidenceFromComplete(membrane: Membrane, adapter: MockAdapter, toolMode?: ToolMode) {
  await membrane.complete(zzRequest(toolMode));
  return toolModeEvidence(adapter);
}

async function evidenceFromStream(membrane: Membrane, adapter: MockAdapter, toolMode?: ToolMode) {
  await membrane.stream(zzRequest(toolMode));
  return toolModeEvidence(adapter);
}

describe('complete() honors request.toolMode', () => {
  it('sends native tool declarations instead of XML instructions for toolMode: native', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter); // default AnthropicXmlFormatter (config.toolMode 'xml')

    const evidence = await evidenceFromComplete(membrane, adapter, 'native');

    expect(evidence.nativeToolNames).toEqual(['zz_dial_tool']);
    expect(evidence.xmlInjected).toBe(false);
  });

  it('injects XML instructions and declares no native tools for toolMode: xml', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new AnthropicXmlFormatter({ toolMode: 'native' }),
    });

    const evidence = await evidenceFromComplete(membrane, adapter, 'xml');

    expect(evidence.nativeToolNames).toEqual([]);
    expect(evidence.xmlInjected).toBe(true);
  });
});

describe('stream() and complete() resolve tool mode identically', () => {
  const requestModes: Array<ToolMode | undefined> = [undefined, 'auto', 'xml', 'native'];
  const formatterCases: Array<{ label: string; makeFormatter: () => AnthropicXmlFormatter | undefined }> = [
    { label: 'default formatter', makeFormatter: () => undefined },
    { label: 'formatter configured native', makeFormatter: () => new AnthropicXmlFormatter({ toolMode: 'native' }) },
    { label: 'formatter configured xml', makeFormatter: () => new AnthropicXmlFormatter({ toolMode: 'xml' }) },
  ];

  for (const formatterCase of formatterCases) {
    for (const requestMode of requestModes) {
      it(`${formatterCase.label} + request toolMode ${String(requestMode)}`, async () => {
        const completeAdapter = new MockAdapter();
        const formatterForComplete = formatterCase.makeFormatter();
        const completeMembrane = new Membrane(
          completeAdapter,
          formatterForComplete ? { formatter: formatterForComplete } : {}
        );
        const completeEvidence = await evidenceFromComplete(completeMembrane, completeAdapter, requestMode);

        const streamAdapter = new MockAdapter();
        const formatterForStream = formatterCase.makeFormatter();
        const streamMembrane = new Membrane(
          streamAdapter,
          formatterForStream ? { formatter: formatterForStream } : {}
        );
        const streamEvidence = await evidenceFromStream(streamMembrane, streamAdapter, requestMode);

        expect(completeEvidence).toEqual(streamEvidence);
      });
    }
  }
});

describe('per-request formatter override participates in resolution', () => {
  it('complete() with an options.formatter configured native declares native tools', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter); // instance formatter is XML-mode

    await membrane.complete(zzRequest(), {
      formatter: new AnthropicXmlFormatter({ toolMode: 'native' }),
    });

    const evidence = toolModeEvidence(adapter);
    expect(evidence.nativeToolNames).toEqual(['zz_dial_tool']);
    expect(evidence.xmlInjected).toBe(false);
  });

  it('stream() with an options.formatter configured native declares native tools', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter); // instance formatter is XML-mode

    await membrane.stream(zzRequest(), {
      formatter: new AnthropicXmlFormatter({ toolMode: 'native' }),
    });

    const evidence = toolModeEvidence(adapter);
    expect(evidence.nativeToolNames).toEqual(['zz_dial_tool']);
    expect(evidence.xmlInjected).toBe(false);
  });

  // The override cell of the symmetry table above: the same override, through
  // both entry points, for every request mode.
  for (const requestMode of [undefined, 'auto', 'xml', 'native'] as Array<ToolMode | undefined>) {
    it(`override formatter configured native + request toolMode ${String(requestMode)} resolves identically on both paths`, async () => {
      const completeAdapter = new MockAdapter();
      await new Membrane(completeAdapter).complete(zzRequest(requestMode), {
        formatter: new AnthropicXmlFormatter({ toolMode: 'native' }),
      });

      const streamAdapter = new MockAdapter();
      await new Membrane(streamAdapter).stream(zzRequest(requestMode), {
        formatter: new AnthropicXmlFormatter({ toolMode: 'native' }),
      });

      expect(toolModeEvidence(completeAdapter)).toEqual(toolModeEvidence(streamAdapter));
    });
  }
});

describe('resolution drives the stream tool loop, not just the wire', () => {
  it('a formatter configured native runs the native loop under an auto request', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new AnthropicXmlFormatter({ toolMode: 'native' }),
    });

    await membrane.stream(zzRequest());

    const lastRequest = adapter.getLastRequest() as unknown as { stopSequences?: string[] };
    // The XML tool loop stops the model on the closing tag; the native loop has
    // no such stop. Native tools on the wire with an XML stop sequence means the
    // loop and the request disagree about the mode.
    expect(lastRequest.stopSequences ?? []).not.toContain('</function_calls>');
  });
});

// ---------------------------------------------------------------------------
// One ACTIVE formatter per request: the loop, the build, and the mode
// resolution must all name the same formatter instance.
//
// The Responses transport keeps the configured Responses formatter
// authoritative over a per-request override (its input is a provider-native
// item array a generic override cannot produce). That authority rule used to
// live inside transformRequest alone, so the build honored it while
// resolveToolMode and buildNativeToolRequest resolved against a different
// formatter — the same split the suite above exists to prevent, one layer
// down.
// ---------------------------------------------------------------------------

interface ZzScriptedTurn {
  content: ContentBlock[];
  stopReason: string;
}

const zzToolUseTurn: ZzScriptedTurn = {
  content: [
    { type: 'text', text: 'zz preamble' },
    { type: 'tool_use', id: 'zztoolu1', name: 'zz_dial_tool', input: { zzarg1: 'zz value' } },
  ],
  stopReason: 'tool_use',
};

const zzFinalTurn: ZzScriptedTurn = {
  content: [{ type: 'text', text: 'zz closing text' }],
  stopReason: 'end_turn',
};

/**
 * Scripted adapter that records every provider request verbatim and answers
 * with native tool_use content — the tool loop's own shape, which the XML
 * parser cannot see. Its `name` is a constructor argument because the
 * Responses authority rule keys on the adapter name.
 */
class ZzScriptedToolAdapter implements ProviderAdapter {
  readonly name: string;
  readonly requests: ProviderRequest[] = [];
  private remainingTurns: ZzScriptedTurn[];

  constructor(adapterName: string, turns: ZzScriptedTurn[]) {
    this.name = adapterName;
    this.remainingTurns = [...turns];
  }

  supportsModel(): boolean {
    return true;
  }

  async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const response = this.takeTurn(request);
    options?.onRequest?.(request);
    return response;
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const response = this.takeTurn(request);
    options?.onRequest?.(request);
    for (const block of response.content as ContentBlock[]) {
      if (block.type === 'text') callbacks.onChunk(block.text);
    }
    return response;
  }

  private takeTurn(request: ProviderRequest): ProviderResponse {
    this.requests.push(JSON.parse(JSON.stringify(request)) as ProviderRequest);
    const turn = this.remainingTurns.shift();
    if (!turn) throw new Error('zz scripted adapter ran out of scripted turns');
    return {
      content: turn.content,
      stopReason: turn.stopReason,
      usage: { inputTokens: 11, outputTokens: 13 },
      model: 'zz-model-1',
      rawRequest: request,
      raw: {},
    };
  }
}

/** Answer every tool round, recording the calls the loop actually delivered. */
function zzToolRoundRecorder(): {
  rounds: ToolCall[][];
  onToolCalls: (calls: ToolCall[]) => Promise<ToolResult[]>;
} {
  const rounds: ToolCall[][] = [];
  return {
    rounds,
    onToolCalls: async (calls: ToolCall[]) => {
      rounds.push(calls);
      return calls.map(call => ({ toolUseId: call.id, content: 'zz tool result' }));
    },
  };
}

describe('the active formatter drives the loop, the build, and the mode together', () => {
  it('runs the native loop when Responses authority overrides a per-request formatter', async () => {
    // Sol's probe: instance Responses formatter on the Responses transport
    // (authoritative for the BUILD) plus an XML per-request override. Resolving
    // the mode against the override selected the XML loop over a request built
    // as Responses items: one provider call, zero tool rounds.
    const adapter = new ZzScriptedToolAdapter('openai-responses-api', [zzToolUseTurn, zzFinalTurn]);
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
    const recorder = zzToolRoundRecorder();

    await membrane.stream(zzRequest(), {
      formatter: new AnthropicXmlFormatter(),
      onToolCalls: recorder.onToolCalls,
    });

    expect(recorder.rounds.map(round => round.map(call => call.name))).toEqual([['zz_dial_tool']]);
    expect(adapter.requests.length).toBe(2);
  });

  it('builds the tool-loop request with the per-request override, not the instance formatter', async () => {
    // buildNativeToolRequest read `this.formatter` while resolveToolMode read
    // the override, so an override that selected the native loop still built
    // through the instance formatter's Anthropic-item path.
    const adapter = new ZzScriptedToolAdapter('zz-adapter-1', [zzToolUseTurn, zzFinalTurn]);
    const membrane = new Membrane(adapter); // instance formatter is the default XML one
    const recorder = zzToolRoundRecorder();

    await membrane.stream(zzRequest(), {
      formatter: new OpenAIResponsesFormatter(),
      onToolCalls: recorder.onToolCalls,
    });

    expect(recorder.rounds.length).toBe(1);
    // Responses items, not `{ role, content: [{ type: 'text', text: 'User: …' }] }`.
    expect(adapter.requests[0]?.messages).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'zz fixture prompt' }] },
    ]);
    expect(adapter.requests[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'zz_dial_tool',
        description: zzDialTool.description,
        parameters: zzDialTool.inputSchema,
      },
    ]);
  });
});
