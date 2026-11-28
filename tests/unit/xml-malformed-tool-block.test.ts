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
  [
    'misspelled closing parameter and invoke tags',
    `<invoke name="zz_write"><parameter name="path">${SECRET}</param></invok>`,
    ['zz_write'],
  ],
  [
    'a value holding a self-closing invoke in single quotes',
    `<invoke name="zz_write"><parameter name="body">one <invoke name='zz_rm'/> ${SECRET}</parameter></invoke>`,
    ['zz_write', 'zz_rm'],
  ],
  [
    'a parameter left open before the next parameter opens',
    `<invoke name="zz_write"><parameter name="path">a.txt\n<parameter name="body">${SECRET}</parameter></invoke>`,
    ['zz_write'],
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

  it('says a parameter with no closing tag leaves its invoke with none either', () => {
    const parsed = parseToolCalls(block(`<invoke name="zz_t"><parameter name="p">x</param></invok>`));
    expect(parsed!.calls[0]!.unparseableReason).toBe('parameter "p" of invoke 1 (zz_t) has no closing parameter tag, and the invoke no closing invoke tag');
  });

  it('calls a tag whose name only begins with invoke a stray tag, not an invoke opener', () => {
    const parsed = parseToolCalls(block(`<invoke-other/>\n<invoke name="zz_a"/>`));
    expect(parsed!.calls.map((c) => c.name)).toEqual(['zz_a']);
    expect(parsed!.calls[0]!.unparseableReason).toBe('a less-than sign stands outside every invoke, before the first invoke');
  });

  it('repeats no invoke or parameter name that is not a plain identifier', () => {
    const parsed = parseToolCalls(block(`<invoke name="zz b&amp;x"><parameter name="p q">v</paramter>\n<parameter name="r">s</parameter></invoke>`));
    expect(parsed!.calls.map((c) => c.name)).toEqual(['zz b&amp;x']);
    expect(parsed!.calls[0]!.unparseableReason).toMatch(/^a parameter of invoke 1 holds/);
    expect(parsed!.calls[0]!.unparseableReason).not.toContain('&');
    expect(parsed!.calls[0]!.unparseableReason).not.toContain('zz');
  });

  it("says an invoke opener can't be read, rather than calling it a stray tag", () => {
    const parsed = parseToolCalls(block(`<invoke name="zz_first"/>\n<invoke name="">\n</invoke>`));
    expect(parsed!.calls.map((c) => c.name)).toEqual(['zz_first']);
    expect(parsed!.calls[0]!.unparseableReason).toBe("invoke 2's opening tag can't be read");
  });

  it('names a parameter given twice', () => {
    const parsed = parseToolCalls(block(malformed[5]![1]));
    expect(parsed!.calls[0]!.unparseableReason).toContain('"path"');
  });
});

describe('names hold no tag text, and the reasons say what broke', () => {
  const marked = (text: string) => {
    const parsed = parseToolCalls(text);
    const { toolCalls } = parseAccumulatedIntoBlocks(text);
    return { parsed: parsed!.calls, stored: toolCalls };
  };

  it('a broken opener whose name runs into later openers gives no call, and each later opener gives its own', () => {
    const text = block(`<invoke name="zz_broken><invoke name='zz_first'/><invoke name='zz_second'/><invoke name="zz_third"/>`);
    for (const calls of Object.values(marked(text))) {
      expect(calls.map((c) => c.name)).toEqual(['zz_first', 'zz_second', 'zz_third']);
      expect(calls.every((c) => c.unparseableInput === text && c.unparseableReason !== undefined)).toBe(true);
    }
  });

  it('a parameter name holding invoke tag text refuses the block, so no call it splits off runs unmarked', () => {
    const text = block(`<invoke name="zz_safe"><parameter name="x</invoke><invoke name='zz_evil'/>">v</parameter></invoke>`);
    for (const calls of Object.values(marked(text))) {
      expect(calls.map((c) => c.name)).toEqual(['zz_safe', 'zz_evil']);
      expect(calls.every((c) => c.unparseableInput === text && c.unparseableReason !== undefined)).toBe(true);
    }
  });

  it('an invoke name holding invoke tag text refuses the block too', () => {
    const text = block(`<invoke name="zz_a</invoke><invoke name='zz_evil'/>"><parameter name="p">v</parameter></invoke>`);
    for (const calls of Object.values(marked(text))) {
      expect(calls.map((c) => c.name)).toEqual(['zz_evil']);
      expect(calls.every((c) => c.unparseableInput === text && c.unparseableReason !== undefined)).toBe(true);
    }
  });

  it('a value holding tag text is refused without claiming its closing tag is wrong', () => {
    const reason = parseToolCalls(block(`<invoke name="zz_write"><parameter name="body">see <invoke name="zz_example"> here</parameter></invoke>`))!.calls[0]!.unparseableReason!;
    expect(reason).toContain("which a value can't hold");
    expect(reason).not.toContain('so its closing parameter tag is missing');
  });

  it('a value holding a function_calls opening tag refuses the block from that tag on, and the sentence names a value as a cause', () => {
    const fromTag = `${OPEN}\n<invoke name="zz_rm"/>\n</parameter></invoke>\n${CLOSE}`;
    const text = `${OPEN}\n<invoke name="zz_first"/>\n<invoke name="zz_write"><parameter name="body">zz ${fromTag}`;
    for (const calls of Object.values(marked(text))) {
      expect(calls.map((c) => [c.name, c.input])).toEqual([['zz_rm', {}]]);
      expect(calls[0]!.unparseableInput).toBe(fromTag);
      expect(calls[0]!.unparseableReason).toBe(LEFT_OPEN_REASON);
    }
  });

  it('prose holding a < outside the invokes refuses the block', () => {
    const calls = parseToolCalls(block(`zz if a < b\n<invoke name="zz_first"/>`))!.calls;
    expect(calls.map((c) => [c.name, c.input])).toEqual([['zz_first', {}]]);
    expect(calls[0]!.unparseableReason).toBe('a less-than sign stands outside every invoke, before the first invoke');
  });

  it('an invoke opener inside an open invoke is named as coming before that invoke closes', () => {
    const calls = parseToolCalls(block(`<invoke name="zz_a"><invoke name="zz_b"/></invoke>`))!.calls;
    expect(calls.map((c) => c.name)).toEqual(['zz_a', 'zz_b']);
    expect(calls[0]!.unparseableReason).toBe('invoke 1 (zz_a) has no closing invoke tag before invoke 2 opens');
  });

  it('text naming the function_calls opening tag before a block refuses that block, and the sentence names text as a cause', () => {
    const later = block('<invoke name="zz_run"/>');
    for (const calls of Object.values(marked(`zz I will write the ${OPEN} tag now.\n${later}`))) {
      expect(calls.map((c) => [c.name, c.input])).toEqual([['zz_run', {}]]);
      expect(calls[0]!.unparseableInput).toBe(later);
      expect(calls[0]!.unparseableReason).toBe(LEFT_OPEN_REASON);
    }
  });

  it('every block re-anchored past an earlier opening tag is refused, whatever that earlier block held', () => {
    for (const earlier of ['<invok name="zz_lost"/>', '<invoke-other/>', '']) {
      const text = `${OPEN}\n${earlier}\n${block('<invoke name="zz_run"/>')}`;
      for (const calls of Object.values(marked(text))) {
        expect(calls.map((c) => [c.name, c.input])).toEqual([['zz_run', {}]]);
        expect(calls[0]!.unparseableReason).toBe(LEFT_OPEN_REASON);
      }
    }
  });

  it('an invoke name holding a line terminator refuses the block, so no later call runs in its place', () => {
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      const text = block(`<invoke name="zz_a${terminator}b"/>\n<invoke name="zz_second"/>`);
      for (const calls of Object.values(marked(text))) {
        expect(calls.map((c) => c.name)).toEqual(['zz_second']);
        expect(calls[0]!.unparseableInput).toBe(text);
      }
    }
  });

  it('an opener the parser can\'t read is named by its place among the invoke openers', () => {
    const calls = parseToolCalls(block(`<invoke name="zz_foo" zz_extra="x"><parameter name="a">1</parameter></invoke>`))!.calls;
    expect(calls.map((c) => c.name)).toEqual(['zz_foo']);
    expect(calls[0]!.unparseableReason).toBe("invoke 1's opening tag can't be read");
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

  for (const [title, value] of [
    ['a TestNG parameter element', '<suite name="s"><test name="t"><parameter name="browser" value="chrome"/></test></suite>'],
    ['a BPEL invoke element', '<sequence><invoke partnerLink="p" operation="o"/></sequence>'],
    ['an invoke element with a name and another attribute', '<flow><invoke name="x" partnerLink="p"/></flow>'],
    ['a parameter opening tag with no name', 'one<parameter>two'],
    ['an invoke opening tag with no name', 'one <invoke/> two'],
  ]) {
    it(`passes a string value holding ${title} whole, since the block's own tags aren't written that way`, () => {
      const tools: ToolDefinition[] = [{
        name: 'zz_write',
        description: 'zz',
        inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
      }];
      const parsed = parseToolCalls(block(`<invoke name="zz_write"><parameter name="body">${value}</parameter></invoke>`), { tools });
      expect(parsed!.calls.map((c) => [c.name, c.input])).toEqual([['zz_write', { body: value }]]);
      expect(parsed!.calls[0]!.unparseableReason).toBeUndefined();
    });
  }

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

class AbortingAdapter extends ScriptedAdapter {
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    if (options?.signal?.aborted) throw options.signal.reason;
    return super.stream(request, callbacks, options);
  }
}

class RequestRecordingAdapter extends ScriptedAdapter {
  readonly requests: ProviderRequest[] = [];

  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.requests.push(request);
    return super.stream(request, callbacks, options);
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

const LEFT_OPEN_REASON = 'a function_calls opening tag came before an earlier one was closed: an earlier block was cut off, a value held the tag, or text before the block named it';

const refusedInvoke = `<invoke name="zz_write"><parameter name="path">a.txt</paramter>\n<parameter name="body">${SECRET}</parameter></invoke>`;
const refusedTurn = `zz calling\n${OPEN}\n${refusedInvoke}\n`;

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
    const warning = logger.warnings.find((w) => w.includes('were refused'));
    expect(warning).toBeDefined();
    expect(warning).toContain('(tag-in-value)');
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
    expect(received[0]!.unparseableInput).toBe(block(refusedInvoke));
    expect(received[0]!.unparseableReason).toContain('"path"');
  });

  it('complete() refuses a block that opens inside an earlier one left open in an invoke, and warns naming it', async () => {
    const logger = new RecordingLogger();
    const response = await new Membrane(new ScriptedAdapter([`zz calling\n${OPEN}\n<invoke name="zz_write"><parameter name="body">zz ${OPEN}\n<invoke name="zz_rm"/>\n`]), { logger }).complete(request());
    expect(response.toolCalls.map((c) => [c.name, c.input])).toEqual([['zz_rm', {}]]);
    expect(response.toolCalls[0]!.unparseableInput).toBe(block('<invoke name="zz_rm"/>'));
    expect(response.toolCalls[0]!.unparseableReason).toBe(LEFT_OPEN_REASON);
    expect(logger.warnings.some((w) => w.includes('were refused (left-open-block)'))).toBe(true);
  });

  it('complete() reads its text only through the first closing function_calls tag, where the streams stop, so no later block runs', async () => {
    const first = `${OPEN}<invoke name="zz_a"><parameter name="p">x${CLOSE}`;
    const response = await new Membrane(new ScriptedAdapter([`zz calling\n${first}${OPEN}<invoke name="zz_rm"/>\n`]), { logger: new RecordingLogger() }).complete(request());
    expect(response.toolCalls.map((c) => [c.name, c.input, c.unparseableInput])).toEqual([['zz_a', {}, first]]);
  });

  const afterCutTurn = (): NormalizedRequest => ({
    toolMode: 'xml',
    messages: [
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Agent', content: [{ type: 'text', text: `zz writing\n${OPEN}\n<invoke name="zz_write"><parameter name="body">zz cut mid` }] },
      { participant: 'User', content: [{ type: 'text', text: 'go on' }] },
    ],
    config: { model: 'zz-test-model', maxTokens: 64 },
    tools: [write],
  });
  const marksOf = (calls: Array<{ name: string; input: unknown; unparseableInput?: string; unparseableReason?: string }>) =>
    calls.map((c) => [c.name, c.input, c.unparseableInput ?? null, c.unparseableReason ?? null]);
  const usesOf = (content: ContentBlock[]) => marksOf(content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'));
  const refuseAll = (calls: ToolCall[]) => calls.map((c) => ({ toolUseId: c.id, content: 'zz refused', isError: true }));
  const viaStream = async (req: NormalizedRequest, texts: string[]) => {
    const received: ToolCall[] = [];
    const response = await new Membrane(new ScriptedAdapter(texts), { logger: new RecordingLogger() }).stream(req, {
      onToolCalls: async (calls) => {
        received.push(...calls);
        return refuseAll(calls);
      },
    });
    if (!('details' in response)) throw new Error('expected a completed response');
    return { received, content: response.content };
  };
  const viaEvents = async (req: NormalizedRequest, texts: string[]) => {
    const stream = new Membrane(new ScriptedAdapter(texts), { logger: new RecordingLogger() }).streamYielding(req);
    const received: ToolCall[] = [];
    let content: ContentBlock[] | undefined;
    for await (const event of stream) {
      if (event.type === 'tool-calls') {
        received.push(...event.calls);
        stream.provideToolResults(refuseAll(event.calls));
      }
      if (event.type === 'complete') content = event.response.content;
    }
    if (content === undefined) throw new Error('expected a complete event');
    return { received, content };
  };
  const abortAfterDispatch = async (path: string, req: NormalizedRequest, texts: string[]) => {
    const controller = new AbortController();
    const membrane = new Membrane(new AbortingAdapter(texts), { logger: new RecordingLogger() });
    const received: ToolCall[] = [];
    if (path === 'stream()') {
      const response = await membrane.stream(req, {
        signal: controller.signal,
        onToolCalls: async (calls) => {
          received.push(...calls);
          controller.abort();
          return refuseAll(calls);
        },
      });
      if (!('aborted' in response)) throw new Error('expected an aborted response');
      return { received, content: response.partialContent ?? [] };
    }
    const stream = membrane.streamYielding(req, { signal: controller.signal });
    let content: ContentBlock[] | undefined;
    for await (const event of stream) {
      if (event.type === 'tool-calls') {
        received.push(...event.calls);
        stream.provideToolResults(refuseAll(event.calls));
        controller.abort();
      }
      if (event.type === 'aborted') content = event.partialContent ?? [];
    }
    if (content === undefined) throw new Error('expected an aborted event');
    return { received, content };
  };
  const thinkingTurn = (): NormalizedRequest => ({
    toolMode: 'xml',
    messages: [{ participant: 'User', content: [{ type: 'text', text: `zz what does ${OPEN} mean? then write a file` }] }],
    config: { model: 'zz-test-model', maxTokens: 64, thinking: { enabled: true, budgetTokens: 1024 } },
    tools: [write],
  });
  const thoughtThenCall = `zz thought</thinking>\nzz ok\n${OPEN}\n<invoke name="zz_write"><parameter name="path">zz.txt</parameter></invoke>\n`;
  const continuedTurn = (partial: string): NormalizedRequest => ({
    toolMode: 'xml',
    messages: [
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Claude', content: [{ type: 'text', text: partial }] },
    ],
    config: { model: 'zz-test-model', maxTokens: 64 },
    tools: [write],
  });

  for (const [path, run] of [['stream()', viaStream], ['the event stream', viaEvents]] as const) {
    it(`continuing a turn inside a block whose earlier part holds a stray tag, ${path} stores the call as dispatch marked it`, async () => {
      const { received, content } = await run(continuedTurn(`zz calling\n${OPEN}\n<invoke name="zz_a"/>\n<zz_bad/>\n`), [`<invoke name="zz_b"/>\n`]);
      expect(received.map((c) => c.name)).toEqual(['zz_a', 'zz_b']);
      expect(received.every((c) => c.unparseableReason !== undefined)).toBe(true);
      expect(usesOf(content)).toEqual(marksOf(received.filter((c) => c.name === 'zz_b')));
    });

    it(`continuing a turn inside a block whose earlier part holds a stray tag, ${path} aborted after dispatch keeps the call as dispatch marked it`, async () => {
      const { received, content } = await abortAfterDispatch(path, continuedTurn(`zz calling\n${OPEN}\n<invoke name="zz_a"/>\n<zz_bad/>\n`), [`<invoke name="zz_b"/>\n`]);
      expect(received.map((c) => c.name)).toEqual(['zz_a', 'zz_b']);
      expect(usesOf(content)).toEqual(marksOf(received.filter((c) => c.name === 'zz_b')));
    });

    it(`continuing a refused block whose every invoke opened before the prefill's end, ${path} stores no call, since none opened after it`, async () => {
      const { received, content } = await run(continuedTurn(`zz calling\n${OPEN}\n<invoke name="zz_a"/>\n<zz_bad/>\n`), [`zz\n`]);
      expect(received.map((c) => [c.name, c.unparseableReason !== undefined])).toEqual([['zz_a', true]]);
      expect(usesOf(content)).toEqual([]);
    });

    it(`continuing a refused block with no named invoke, opened before the prefill's end, ${path} stores no nameless call`, async () => {
      const { received, content } = await run(continuedTurn(`zz calling\n${OPEN}\n<zz_bad/>\n`), [`zz\n`]);
      expect(received.map((c) => [c.name, c.unparseableReason !== undefined])).toEqual([['', true]]);
      expect(usesOf(content)).toEqual([]);
    });

    it(`with a thinking prefill and a user message naming the opening tag, ${path} stores the model's block as dispatch marked it`, async () => {
      const { received, content } = await run(thinkingTurn(), [thoughtThenCall]);
      expect(received.map((c) => [c.name, c.unparseableReason ?? null])).toEqual([['zz_write', LEFT_OPEN_REASON]]);
      expect(usesOf(content)).toEqual(marksOf(received));
    });

    it(`with a thinking prefill and a user message naming the opening tag, ${path} aborted after dispatch keeps the block as dispatch marked it`, async () => {
      const { received, content } = await abortAfterDispatch(path, thinkingTurn(), [thoughtThenCall]);
      expect(received.map((c) => [c.name, c.unparseableReason ?? null])).toEqual([['zz_write', LEFT_OPEN_REASON]]);
      expect(usesOf(content)).toEqual(marksOf(received));
    });

    it(`continuing a block an earlier turn left open with nothing wrong in it, ${path} stores no refusal dispatch didn't make`, async () => {
      const { received, content } = await run(continuedTurn(`zz calling\n${OPEN}\n`), [`<invoke name="zz_write"><parameter name="path">zz.txt</parameter></invoke>\n`]);
      expect(marksOf(received)).toEqual([['zz_write', { path: 'zz.txt' }, null, null]]);
      expect(usesOf(content)).toEqual(marksOf(received));
    });

    it(`continuing a block whose earlier part holds a whole invoke, ${path} stores the calls opened after the prefill as dispatch read them`, async () => {
      const { received, content } = await run(continuedTurn(`zz calling\n${OPEN}\n<invoke name="zz_a"/>\n`), [`<invoke name="zz_write"><parameter name="path">zz.txt</parameter></invoke>\n`]);
      expect(marksOf(received)).toEqual([['zz_a', {}, null, null], ['zz_write', { path: 'zz.txt' }, null, null]]);
      expect(usesOf(content)).toEqual(marksOf(received.filter((c) => c.name === 'zz_write')));
    });

    it(`continuing a block re-anchored at an opening tag before the prefill's end, ${path} stores the call as dispatch marked it`, async () => {
      const { received, content } = await run(continuedTurn(`zz calling\n${OPEN}\n${OPEN}\n`), [`<invoke name="zz_write"><parameter name="path">zz.txt</parameter></invoke>\n`]);
      expect(received.map((c) => [c.name, c.unparseableReason !== undefined])).toEqual([['zz_write', true]]);
      expect(usesOf(content)).toEqual(marksOf(received));
    });
  }

  it('after a turn cut inside an invoke, the refusal goes back to the model and its resend runs', async () => {
    const adapter = new RequestRecordingAdapter([`zz again\n${OPEN}\n<invoke name="zz_rm"/>\n`, `zz resend\n${OPEN}\n<invoke name="zz_rm"/>\n`]);
    const rounds: ToolCall[][] = [];
    await new Membrane(adapter, { logger: new RecordingLogger() }).stream(afterCutTurn(), {
      onToolCalls: async (calls) => {
        rounds.push(calls);
        return calls.map((c) => ({ toolUseId: c.id, content: c.unparseableReason === undefined ? 'zz ran' : 'zz refused', isError: c.unparseableReason !== undefined }));
      },
    });
    expect(rounds.map((calls) => marksOf(calls).map(([name, , , reason]) => [name, reason]))).toEqual([[['zz_rm', LEFT_OPEN_REASON]], [['zz_rm', null]]]);
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(adapter.requests[1])).toContain('zz refused');
  });

  it('after an earlier turn cut inside an invoke, stream() marks the call in its content as dispatch marked it', async () => {
    const received: ToolCall[] = [];
    const response = await new Membrane(new ScriptedAdapter([`zz again\n${OPEN}\n<invoke name="zz_rm"/>\n`]), { logger: new RecordingLogger() }).stream(afterCutTurn(), {
      onToolCalls: async (calls) => {
        received.push(...calls);
        return calls.map((c) => ({ toolUseId: c.id, content: 'zz refused', isError: true }));
      },
    });
    if (!('details' in response)) throw new Error('expected a completed response');
    expect(received.map((c) => [c.name, c.unparseableReason ?? null])).toEqual([['zz_rm', LEFT_OPEN_REASON]]);
    expect(usesOf(response.content)).toEqual(marksOf(received));
  });

  it('after an earlier turn cut inside an invoke, the event stream marks the call in its final content as its tool-calls event did', async () => {
    const stream = new Membrane(new ScriptedAdapter([`zz again\n${OPEN}\n<invoke name="zz_rm"/>\n`]), { logger: new RecordingLogger() }).streamYielding(afterCutTurn());
    const received: ToolCall[] = [];
    let content: ContentBlock[] = [];
    for await (const event of stream) {
      if (event.type === 'tool-calls') {
        received.push(...event.calls);
        stream.provideToolResults(event.calls.map((c) => ({ toolUseId: c.id, content: 'zz refused', isError: true })));
      }
      if (event.type === 'complete') content = event.response.content;
    }
    expect(received.map((c) => [c.name, c.unparseableReason ?? null])).toEqual([['zz_rm', LEFT_OPEN_REASON]]);
    expect(usesOf(content)).toEqual(marksOf(received));
  });

  it('complete() returns the same marked calls', async () => {
    const response = await new Membrane(new ScriptedAdapter([`zz calling\n${OPEN}\n<invoke name="zz_write"><parameter name="path">a.txt</parameter><parameter name="path">b</parameter></invoke>\n`]), { logger: new RecordingLogger() }).complete(request());
    expect(response.toolCalls.map((c) => c.name)).toEqual(['zz_write']);
    expect(response.toolCalls[0]!.input).toEqual({});
    expect(response.toolCalls[0]!.unparseableInput).toBe(block(`<invoke name="zz_write"><parameter name="path">a.txt</parameter><parameter name="path">b</parameter></invoke>`));
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

  it('a block the old parser stored more calls from than the new one gives replays once', () => {
    const text = block(`<invoke name="zz_a<b"/>\n<invoke name="zz_c<d"/>`);
    const stored: ContentBlock[] = [
      { type: 'tool_use', id: 'zz_t1', name: 'zz_a<b', input: {}, rawXml: text },
      { type: 'tool_use', id: 'zz_t2', name: 'zz_c<d', input: {}, rawXml: text },
      { type: 'tool_result', toolUseId: 'zz_t1', content: 'zz ran 1', isError: false },
      { type: 'tool_result', toolUseId: 'zz_t2', content: 'zz ran 2', isError: false },
    ];
    expect(occurrences(render(stored), text)).toBe(1);
  });

  it('a refused block after one left open replays once', () => {
    const later = block(`<invoke name="zz_x\ny"/>\n<invoke name="zz_b"/>`);
    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(`zz calling\n${OPEN}\n<invoke name="zz_old"/>\n${later}`);
    const results: ContentBlock[] = toolCalls.map((c) => ({ type: 'tool_result', toolUseId: c.id, content: `zz refused ${c.name}`, isError: true }));
    expect(occurrences(render([...blocks, ...results]), later)).toBe(1);
  });

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
