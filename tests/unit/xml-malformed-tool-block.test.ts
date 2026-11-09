import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { parseAccumulatedIntoBlocks, parseToolCalls } from '../../src/utils/tool-parser.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type {
  ContentBlock,
  NormalizedMessage,
  MembraneLogger,
  NormalizedRequest,
  ToolCall,
  ToolDefinition,
} from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/provider.js';

const OPEN = '<' + 'function_calls>';
const CLOSE = '</' + 'function_calls>';
const block = (inner: string): string => `${OPEN}\n${inner}\n${CLOSE}`;

// What the parser escapes in a result (tool-parser.ts STRUCTURAL_TAG_RE): a reason must match none of it.
const STRUCTURAL_TAG = /<\/?(?:antml:)?(?:function_calls|function_results|invoke|result|stdout|error|tool_name)\b/;
const SECRET = 'zzsecretvalue';

const malformed: Array<[string, string, string[]]> = [
  [
    'a misspelled closing parameter tag that runs into the next parameter',
    `<invoke name="zz_write"><parameter name="path">a.txt</paramter>\n<parameter name="body">${SECRET}</parameter></invoke>`,
    ['zz_write'],
  ],
  [
    'a misspelled opening parameter tag',
    `<invoke name="zz_write"><paramter name="path">${SECRET}</parameter></invoke>`,
    ['zz_write'],
  ],
  [
    'a single-quoted parameter name',
    `<invoke name="zz_write"><parameter name='path'>${SECRET}</parameter></invoke>`,
    ['zz_write'],
  ],
  [
    'arguments written as bare prose inside an invoke',
    `<invoke name="zz_write">path is ${SECRET}</invoke>`,
    ['zz_write'],
  ],
  [
    'a stray tag between parameters',
    `<invoke name="zz_write"><parameter name="path">a.txt</parameter><zz_stray/><parameter name="body">${SECRET}</parameter></invoke>`,
    ['zz_write'],
  ],
  [
    'a parameter given twice',
    `<invoke name="zz_write"><parameter name="path">a.txt</parameter><parameter name="path">${SECRET}</parameter></invoke>`,
    ['zz_write'],
  ],
  [
    'an invoke left open, swallowing the invoke after it',
    `<invoke name="zz_head"><parameter name="fld1">${SECRET}</parameter>\n<invoke name="zz_inner"><parameter name="fld2">2</parameter></invoke>`,
    ['zz_head', 'zz_inner'],
  ],
  [
    'the last invoke left open',
    `<invoke name="zz_first"><parameter name="fld1">1</parameter></invoke>\n<invoke name="zz_last"><parameter name="fld2">${SECRET}</parameter>`,
    ['zz_first', 'zz_last'],
  ],
  [
    'a literal closing parameter tag inside a string value',
    `<invoke name="zz_write"><parameter name="body">${SECRET} </parameter> and more</parameter></invoke>`,
    ['zz_write'],
  ],
  [
    'a string value holding an invoke opener and closer',
    `<invoke name="zz_write"><parameter name="body">${SECRET} <invoke name="zz_rm"><parameter name="path">/</parameter></invoke> tail</parameter></invoke>`,
    ['zz_write', 'zz_rm'],
  ],
  [
    'a misspelled invoke opener between good invokes',
    `<invoke name="zz_first"/>\n<invok name="zz_lost"><parameter name="fld1">${SECRET}</parameter></invok>\n<invoke name="zz_third"/>`,
    ['zz_first', 'zz_third'],
  ],
  [
    'a block whose only invoke opener is misspelled',
    `<invok name="zz_lost"><parameter name="fld1">${SECRET}</parameter></invok>`,
    [''],
  ],
  [
    'a stray tag between invokes',
    `<invoke name="zz_first"/>\n<zz_stray>${SECRET}</zz_stray>\n<invoke name="zz_second"/>`,
    ['zz_first', 'zz_second'],
  ],
];

describe('a function_calls block whose tags break the format is refused whole', () => {
  for (const [title, inner, names] of malformed) {
    it(`${title}: every call is marked, with {} for input, the raw block, and a reason`, () => {
      const text = block(inner);
      const parsed = parseToolCalls(text);
      expect(parsed?.calls.map((c) => c.name)).toEqual(names);
      for (const call of parsed!.calls) {
        expect(call.input).toEqual({});
        expect(call.unparseableInput).toBe(text);
        expect(typeof call.unparseableReason).toBe('string');
        expect(call.unparseableReason).not.toMatch(STRUCTURAL_TAG);
        expect(call.unparseableReason).not.toContain('<');
        expect(call.unparseableReason).not.toContain(SECRET);
      }
      expect(new Set(parsed!.calls.map((c) => c.unparseableReason)).size).toBe(1);
    });

    it(`${title}: the stored blocks carry the same marks`, () => {
      const text = block(inner);
      const { blocks, toolCalls, malformedToolBlocks } = parseAccumulatedIntoBlocks(text);
      const uses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      expect(uses.map((u) => u.name)).toEqual(names);
      for (const use of uses) {
        expect(use.input).toEqual({});
        expect(use.unparseableInput).toBe(text);
        expect(use.unparseableReason).toBe(toolCalls[0]!.unparseableReason);
        expect(use.rawXml).toBe(text);
      }
      expect(toolCalls.every((c) => c.unparseableReason === toolCalls[0]!.unparseableReason)).toBe(true);
      expect(malformedToolBlocks).toHaveLength(1);
    });
  }

  it('names the parameter whose closing tag is missing', () => {
    const parsed = parseToolCalls(block(malformed[0]![1]));
    expect(parsed!.calls[0]!.unparseableReason).toContain('"path"');
  });

  it('repeats no invoke or parameter name that is not a plain identifier', () => {
    const parsed = parseToolCalls(block(`<invoke name="zz<b>x"><parameter name="p<q">v</paramter>\n<parameter name="r">s</parameter></invoke>`));
    expect(parsed!.calls.map((c) => c.name)).toEqual(['zz<b>x']);
    expect(parsed!.calls[0]!.unparseableReason).not.toContain('<');
    expect(parsed!.calls[0]!.unparseableReason).not.toContain('zz');
  });

  it('names a parameter given twice', () => {
    const parsed = parseToolCalls(block(malformed[5]![1]));
    expect(parsed!.calls[0]!.unparseableReason).toContain('"path"');
  });
});

describe('a well-formed block parses as before', () => {
  it('dispatches each invoke of a multi-invoke block with its own arguments', () => {
    const parsed = parseToolCalls(block(
      `<invoke name="zz_first">\n<parameter name="fld1">v1</parameter>\n</invoke>\n` +
        `<invoke name="zz_second">\n<parameter name="fld2">v2</parameter>\n<parameter name="fld3">3</parameter>\n</invoke>`
    ));
    expect(parsed!.calls.map((c) => [c.name, c.input])).toEqual([
      ['zz_first', { fld1: 'v1' }],
      ['zz_second', { fld2: 'v2', fld3: 3 }],
    ]);
    for (const call of parsed!.calls) {
      expect(call.unparseableInput).toBeUndefined();
      expect(call.unparseableReason).toBeUndefined();
    }
  });

  it('passes a string value holding other tags byte for byte', () => {
    const value = 'see <b>bold</b>, a </div> and an <img src="x"/>';
    const tools: ToolDefinition[] = [{
      name: 'zz_write',
      description: 'zz',
      inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
    }];
    const parsed = parseToolCalls(block(`<invoke name="zz_write"><parameter name="body">${value}</parameter></invoke>`), { tools });
    expect(parsed!.calls[0]!.input).toEqual({ body: value });
    expect(parsed!.calls[0]!.unparseableReason).toBeUndefined();
  });

  it('ignores prose between invokes, as before', () => {
    const parsed = parseToolCalls(block(`zz note\n<invoke name="zz_first"/>\nzz another note\n<invoke name="zz_second"/>`));
    expect(parsed!.calls.map((c) => c.name)).toEqual(['zz_first', 'zz_second']);
    expect(parsed!.calls.every((c) => c.unparseableReason === undefined)).toBe(true);
  });

  it('reads the prefixed forms and a self-closing invoke', () => {
    const A = 'antml:';
    const text = `<${A}function_calls>\n<${A}invoke name="zz_first"><${A}parameter name="fld1">v1</${A}parameter></${A}invoke>\n<invoke name="zz_second"/>\n</${A}function_calls>`;
    const parsed = parseToolCalls(text);
    expect(parsed!.calls.map((c) => [c.name, c.input])).toEqual([['zz_first', { fld1: 'v1' }], ['zz_second', {}]]);
    expect(parsed!.calls.every((c) => c.unparseableReason === undefined)).toBe(true);
  });

  it('still reports a block with no invoke and no stray tag as empty', () => {
    const parsed = parseAccumulatedIntoBlocks(block('zz just prose'));
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.emptyToolBlocks).toBe(1);
    expect(parsed.malformedToolBlocks).toEqual([]);
  });
});

class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'zz-scripted';
  private readonly texts: string[];

  constructor(texts: string[]) {
    this.texts = [...texts];
  }

  supportsModel(): boolean {
    return true;
  }

  private respond(request: ProviderRequest): ProviderResponse {
    const text = this.texts.shift();
    return {
      content: [{ type: 'text', text: text ?? 'zz done' }],
      stopReason: text === undefined ? 'end_turn' : 'stop_sequence',
      stopSequence: text === undefined ? undefined : CLOSE,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: request.model,
      rawRequest: request,
      raw: { scripted: true },
    };
  }

  async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    options?.onRequest?.(request);
    return this.respond(request);
  }

  async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    options?.onRequest?.(request);
    const response = this.respond(request);
    callbacks.onChunk((response.content[0] as { text: string }).text);
    return response;
  }
}

class RecordingLogger implements MembraneLogger {
  readonly warnings: string[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(): void {}
}

const write: ToolDefinition = { name: 'zz_write', description: 'zz', inputSchema: { type: 'object', properties: {} } };

function request(): NormalizedRequest {
  return {
    toolMode: 'xml',
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
    config: { model: 'zz-test-model', maxTokens: 64 },
    tools: [write],
  };
}

const refusedTurn = `zz calling\n${OPEN}\n<invoke name="zz_write"><parameter name="path">a.txt</paramter>\n<parameter name="body">${SECRET}</parameter></invoke>\n`;

describe('the XML tool loops hand a refused block to the host as an ordinary round', () => {
  it('onToolCalls receives the marked calls, and the warn line names the defect without the value', async () => {
    const logger = new RecordingLogger();
    const received: ToolCall[] = [];
    const response = await new Membrane(new ScriptedAdapter([refusedTurn]), { logger }).stream(request(), {
      onToolCalls: async (calls) => {
        received.push(...calls);
        return calls.map((c) => ({ toolUseId: c.id, content: 'zz refused', isError: true }));
      },
    });
    if (!('details' in response)) throw new Error('expected a completed response');
    expect(received.map((c) => c.name)).toEqual(['zz_write']);
    expect(received[0]!.input).toEqual({});
    expect(received[0]!.unparseableReason).toContain('"path"');
    expect(received[0]!.unparseableInput).toContain('zz_write');
    const warning = logger.warnings.find((w) => w.includes('well-formed'));
    expect(warning).toBeDefined();
    expect(warning).not.toContain(SECRET);
  });

  it('the event stream hands the marked calls to the host in its tool-calls event', async () => {
    const membrane = new Membrane(new ScriptedAdapter([refusedTurn]), { logger: new RecordingLogger() });
    const stream = membrane.streamYielding(request());
    const received: ToolCall[] = [];
    for await (const event of stream) {
      if (event.type === 'tool-calls') {
        received.push(...event.calls);
        stream.provideToolResults(event.calls.map((c) => ({ toolUseId: c.id, content: 'zz refused', isError: true })));
      }
    }
    expect(received.map((c) => c.name)).toEqual(['zz_write']);
    expect(received[0]!.input).toEqual({});
    expect(received[0]!.unparseableReason).toContain('"path"');
  });

  it('complete() returns the same marked calls', async () => {
    const response = await new Membrane(new ScriptedAdapter([`zz calling\n${OPEN}\n<invoke name="zz_write"><parameter name="path">a.txt</parameter><parameter name="path">b</parameter></invoke>\n`]), { logger: new RecordingLogger() }).complete(request());
    expect(response.toolCalls.map((c) => c.name)).toEqual(['zz_write']);
    expect(response.toolCalls[0]!.input).toEqual({});
    expect(response.toolCalls[0]!.unparseableReason).toContain('"path"');
  });
});

function render(content: ContentBlock[]): string {
  const messages: NormalizedMessage[] = [
    { participant: 'User', content: [{ type: 'text', text: 'zz go' }] },
    { participant: 'Agent', content },
    { participant: 'User', content: [{ type: 'text', text: 'zz next' }] },
    { participant: 'Agent', content: [] },
  ];
  return new AnthropicXmlFormatter().buildMessages(messages, { assistantParticipant: 'Agent' }).messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('stored turns replay as before', () => {
  for (const at of [6, 9, 11]) {
    const [title, inner] = malformed[at]!;
    it(`a stored refused block replays once, with its results: ${title}`, () => {
      const text = block(inner);
      const { blocks, toolCalls } = parseAccumulatedIntoBlocks(`zz calling\n${text}`);
      const results: ContentBlock[] = toolCalls.map((c) => ({ type: 'tool_result', toolUseId: c.id, content: `zz refused ${c.name}`, isError: true }));
      const rendered = render([...blocks, ...results]);
      expect(occurrences(rendered, text)).toBe(1);
      for (const c of toolCalls) expect(rendered).toContain(`zz refused ${c.name}`);
    });
  }

  it('a turn stored before the change, whose call the old parser re-anchored, replays its block once and unchanged', () => {
    const text = block(malformed[6]![1]);
    const stored: ContentBlock[] = [
      { type: 'text', text: 'zz calling' },
      { type: 'tool_use', id: 'zz_t1', name: 'zz_inner', input: { fld2: 2 }, rawXml: text },
      { type: 'tool_result', toolUseId: 'zz_t1', content: 'zz ran', isError: false, toolName: 'zz_inner' },
    ];
    const rendered = render(stored);
    expect(occurrences(rendered, text)).toBe(1);
    expect(rendered).toContain('zz ran');
  });
});
