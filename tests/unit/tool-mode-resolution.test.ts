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
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest, ToolDefinition, ToolMode } from '../../src/types/index.js';

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
