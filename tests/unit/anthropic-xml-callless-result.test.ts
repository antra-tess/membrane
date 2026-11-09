import { describe, expect, it } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';
import { parseAccumulatedIntoBlocks } from '../../src/utils/tool-parser.js';
import type { ContentBlock, NormalizedMessage } from '../../src/types/index.js';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } });
const result = (id: string, content: string, rawXml?: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content, ...(rawXml ? { rawXml } : {}) }) as ContentBlock;
const named = (id: string, name: string): ContentBlock => ({ type: 'tool_use', id, name, input: {} });
const namedResult = (id: string, toolName: string, content: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, toolName, content }) as ContentBlock;

function build(messages: NormalizedMessage[], promptCaching = false) {
  const fidelity = new FidelityNotes();
  const events: unknown[] = [];
  const built = new AnthropicXmlFormatter().buildMessages(messages, {
    assistantParticipant: 'Agent', promptCaching, cacheMarkers: 'cm-owned', fidelity, onNormalize: (event: unknown) => events.push(event),
  } as any);
  const rendered = built.messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  return { built, rendered, altered: [...fidelity.altered].sort((a, b) => a - b), events };
}

describe('AnthropicXmlFormatter: a tool result that answers no call', () => {
  it('is left out of the transcript, as a result and as text, and its message reported', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Tool', content: [result('call_9', 'zz-ghost')] },
      { participant: 'User', content: [text('more')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).not.toContain('zz-ghost');
    expect(rendered).not.toContain('function_results');
    expect(rendered).toContain('more');
    expect(altered).toEqual([1]);
  });

  it('pairs a result with the call its id names, so a second result for one call is left out though another call still waits', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), call('b')] },
      { participant: 'Tool', content: [result('a', 'zz-a'), result('a', 'zz-again'), result('b', 'zz-b')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-a');
    expect(rendered).toContain('zz-b');
    expect(rendered).not.toContain('zz-again');
    expect(altered).toEqual([2]);
  });

  it('pairs a result whose id names no call by position, within its own message only, as a generation parsed from its text holds its calls and results', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [text('reading'), call('generated_1'), result('id_from_the_text', 'zz-paired'), text('read')] },
      { participant: 'Agent', content: [call('generated_2')] },
      { participant: 'Tool', content: [result('id_from_elsewhere', 'zz-elsewhere')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-paired');
    expect(rendered).not.toContain('zz-elsewhere');
    expect(altered).toEqual([3]);
  });

  it('does not answer a call that comes after it', () => {
    const { rendered, altered } = build([
      { participant: 'Tool', content: [result('call_1', 'zz-early')] },
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).not.toContain('zz-early');
    expect(altered).toEqual([0]);
  });

  it('renders a kept result that shared its raw text from its own fields, since the raw text holds the dropped one too', () => {
    const raw = '<function_results>\n<result tool_use_id="a">zz-kept</result>\n<result tool_use_id="b">zz-dropped</result>\n</function_results>';
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a')] },
      { participant: 'Tool', content: [result('a', 'zz-kept', raw), result('b', 'zz-dropped', raw)] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-kept');
    expect(rendered).not.toContain('zz-dropped');
    expect(altered).toEqual([2]);
  });

  it('keeps the breakpoint of a message it empties, marking what came before it', () => {
    const { built } = build([
      { participant: 'User', content: [text('go')] },
      { participant: 'Agent', content: [text('zz-ok')] },
      { participant: 'Tool', cacheBreakpoint: true, content: [result('call_9', 'zz-ghost')] },
      { participant: 'User', content: [text('next')] },
      { participant: 'Agent', content: [] },
    ], true);
    const marked = built.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block: any) => block.cache_control);
    expect(marked).toHaveLength(1);
    expect((marked[0] as any).text).toContain('zz-ok');
    expect((marked[0] as any).text).not.toContain('next');
    expect(JSON.stringify(built.messages)).not.toContain('zz-ghost');
  });

  it('asks the caller\'s cache-marker check about the message as the caller gave it, a result it leaves out included', () => {
    const marked = (message: NormalizedMessage) => message.content.some((block: any) => block.cache_control);
    const fidelity = new FidelityNotes();
    const built = new AnthropicXmlFormatter().buildMessages([
      { participant: 'User', content: [text('go')] },
      { participant: 'Agent', content: [text('zz-ok')] },
      { participant: 'Tool', content: [{ ...result('call_9', 'zz-ghost'), cache_control: { type: 'ephemeral' } } as ContentBlock] },
      { participant: 'User', content: [text('next')] },
      { participant: 'Agent', content: [] },
    ], { assistantParticipant: 'Agent', promptCaching: true, cacheMarkers: 'cm-owned', fidelity, hasCacheMarker: marked } as any);
    const blocks = built.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((block: any) => block.cache_control);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text).toContain('zz-ok');
    expect(JSON.stringify(built.messages)).not.toContain('zz-ghost');
  });

  it('leaves a call to the result that names it by id, so a result whose id names no call before it in the message is left out rather than taking that call', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), result('id_from_nowhere', 'zz-stray-in-place'), result('a', 'zz-a')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-a');
    expect(rendered).not.toContain('zz-stray-in-place');
    expect(altered).toEqual([1]);
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'id_from_nowhere' }]);
  });

  it('leaves a call to a result in a later message that names it, so a result whose id names no call is left out rather than taking that call', () => {
    const { rendered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), result('id_from_nowhere', 'zz-stray-in-place')] },
      { participant: 'Tool', content: [result('a', 'zz-a')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-a');
    expect(rendered).not.toContain('zz-stray-in-place');
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'id_from_nowhere' }]);
  });

  it('tells the host through onNormalize, naming the result: one that answers no call as an orphan, a second for an answered call as a stray', () => {
    const { events } = build([
      { participant: 'Agent', content: [call('a')] },
      { participant: 'Tool', content: [result('a', 'one'), result('a', 'two'), result('zz', 'three')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(events).toEqual([
      { kind: 'stray_tool_result_dropped', toolUseId: 'a', reason: 'answered' },
      { kind: 'orphan_tool_result_dropped', toolUseId: 'zz' },
    ]);
  });

  it('leaves out a result that would stand in another call\'s place: the k-th result after a calls block answers its k-th call', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), call('b')] },
      { participant: 'Tool', content: [result('b', 'zz-b')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).not.toContain('zz-b');
    expect(altered).toEqual([2]);
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'b' }]);
  });

  it('moves results stored as their tools finished into their calls\' places, rendered from their fields, and reports the message', () => {
    const raw = '<function_results>\n<result tool_use_id="b">zz-b</result>\n<result tool_use_id="a">zz-a</result>\n</function_results>';
    for (const shared of [undefined, raw]) {
      const { rendered, altered, events } = build([
        { participant: 'User', content: [text('look')] },
        { participant: 'Agent', content: [call('a'), call('b')] },
        { participant: 'Tool', content: [result('b', 'zz-b', shared), result('a', 'zz-a', shared)] },
        { participant: 'Agent', content: [] },
      ]);
      expect(rendered.indexOf('zz-a')).toBeGreaterThan(-1);
      expect(rendered.indexOf('zz-b')).toBeGreaterThan(rendered.indexOf('zz-a'));
      expect(rendered).not.toContain('tool_use_id="b">zz-b');
      expect(altered).toEqual([2]);
      expect(events).toEqual([]);
    }
  });

  it('keeps the host\'s order for results that name different tools, as a host that leads with one result stores them', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), named('f', 'subagent--fork')] },
      { participant: 'Tool', content: [namedResult('f', 'subagent--fork', 'zz-f'), namedResult('a', 'read_file', 'zz-a')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered.indexOf('zz-f')).toBeGreaterThan(-1);
    expect(rendered.indexOf('zz-a')).toBeGreaterThan(rendered.indexOf('zz-f'));
    expect(altered).toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps a result that names its tool though an earlier call of another tool is unanswered', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), named('s', 'search')] },
      { participant: 'Tool', content: [namedResult('s', 'search', 'zz-s')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('<tool_name>search</tool_name>');
    expect(rendered).toContain('zz-s');
    expect(altered).toEqual([]);
    expect(events).toEqual([]);
  });

  it('moves a result the model can\'t tell apart after the results of the calls before its own, leaving a result that names its tool where the host put it', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), named('s', 'search'), named('l', 'list')] },
      { participant: 'Tool', content: [
        namedResult('l', 'list', 'zz-l'),
        { type: 'tool_result', toolUseId: 's', toolName: 'search', content: 'zz-s-failed', isError: true } as ContentBlock,
        namedResult('a', 'read_file', 'zz-a'),
      ] },
      { participant: 'Agent', content: [] },
    ]);
    const at = (s: string) => rendered.indexOf(s);
    expect(at('zz-l')).toBeGreaterThan(-1);
    expect(at('zz-a')).toBeGreaterThan(at('zz-l'));
    expect(at('zz-s-failed')).toBeGreaterThan(at('zz-a'));
    expect(altered).toEqual([2]);
    expect(events).toEqual([]);
  });

  it('reads an error by its place, since it goes out without its tool\'s name', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), named('s', 'search')] },
      { participant: 'Tool', content: [{ type: 'tool_result', toolUseId: 's', toolName: 'search', content: 'zz-s-failed', isError: true } as ContentBlock] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).not.toContain('zz-s-failed');
    expect(altered).toEqual([2]);
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 's' }]);
  });

  it('sends a result that names a tool other than its call\'s without the name, so it reads back as its own call\'s answer', () => {
    const { built, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), named('s', 'search')] },
      { participant: 'Tool', content: [namedResult('a', 'search', 'zz-a'), namedResult('s', 'search', 'zz-s')] },
      { participant: 'Agent', content: [] },
    ]);
    const wire = built.messages
      .map((m) => (typeof m.content === 'string' ? m.content : (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')))
      .join('\n');
    const { toolCalls, toolResults } = parseAccumulatedIntoBlocks(wire);
    const toolOf = new Map(toolCalls.map((c) => [c.id, c.name]));
    expect(toolResults.map((r) => [r.content, toolOf.get(r.toolUseId)])).toEqual([['zz-a', 'read_file'], ['zz-s', 'search']]);
    expect(altered).toEqual([2]);
  });

  it('leaves out a second result for a call a result in an earlier message answered', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), call('b')] },
      { participant: 'Tool', content: [namedResult('a', 'read_file', 'zz-first')] },
      { participant: 'Tool', content: [namedResult('a', 'read_file', 'zz-again'), namedResult('b', 'read_file', 'zz-b')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-first');
    expect(rendered).toContain('zz-b');
    expect(rendered).not.toContain('zz-again');
    expect(altered).toEqual([3]);
    expect(events).toEqual([{ kind: 'stray_tool_result_dropped', toolUseId: 'a', reason: 'answered' }]);
  });

  it('moves results of one tool, each naming it, into call order', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), call('b')] },
      { participant: 'Tool', content: [namedResult('b', 'read_file', 'zz-b'), namedResult('a', 'read_file', 'zz-a')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered.indexOf('zz-a')).toBeGreaterThan(-1);
    expect(rendered.indexOf('zz-b')).toBeGreaterThan(rendered.indexOf('zz-a'));
    expect(altered).toEqual([2]);
  });

  it('keeps a sorted run only up to the first place nothing answers', () => {
    const { rendered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), call('b'), call('c')] },
      { participant: 'Tool', content: [result('c', 'zz-c'), result('a', 'zz-a')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-a');
    expect(rendered).not.toContain('zz-c');
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'c' }]);
  });

  it('reads calls split by text, with no result between, as one block\'s calls', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), text('and then'), call('b')] },
      { participant: 'Tool', content: [result('a', 'zz-a'), result('b', 'zz-b')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-a');
    expect(rendered).toContain('zz-b');
    expect(altered).toEqual([]);
  });

  it('starts new places at a calls block after results, so a call left unanswered takes no later result', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a'), call('b')] },
      { participant: 'Tool', content: [result('a', 'zz-a')] },
      { participant: 'Agent', content: [call('c')] },
      { participant: 'Tool', content: [result('c', 'zz-c')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-a');
    expect(rendered).toContain('zz-c');
    expect(altered).toEqual([]);
  });

  it('runs a group of calls on past a results block whose results are all left out, as the wire shows it', () => {
    for (const [tool, kept] of [['read_file', false], ['search', true]] as const) {
      const { rendered, events } = build([
        { participant: 'User', content: [text('look')] },
        { participant: 'Agent', content: [call('a'), call('b')] },
        { participant: 'Tool', content: [namedResult('b', 'read_file', 'zz-b')] },
        { participant: 'Agent', content: [named('c', tool)] },
        { participant: 'Tool', content: [namedResult('c', tool, 'zz-c')] },
        { participant: 'Agent', content: [] },
      ]);
      expect(rendered).not.toContain('zz-b');
      if (kept) {
        expect(rendered).toContain('zz-c');
        expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'b' }]);
      } else {
        expect(rendered).not.toContain('zz-c');
        expect(events).toEqual([
          { kind: 'orphan_tool_result_dropped', toolUseId: 'b' },
          { kind: 'orphan_tool_result_dropped', toolUseId: 'c' },
        ]);
      }
    }
  });

  it('reports a result left out for its place as an orphan, though an earlier cycle answered its id', () => {
    const { rendered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('q')] },
      { participant: 'Tool', content: [result('q', 'zz-first')] },
      { participant: 'Agent', content: [call('p'), call('q')] },
      { participant: 'Tool', content: [result('q', 'zz-second')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-first');
    expect(rendered).not.toContain('zz-second');
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'q' }]);
  });

  it('sends a result for each cycle that reuses a call id', () => {
    const { rendered, altered, events } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a')] },
      { participant: 'Tool', content: [result('a', 'zz-first')] },
      { participant: 'Agent', content: [call('a')] },
      { participant: 'Tool', content: [result('a', 'zz-second'), result('a', 'zz-third')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-first');
    expect(rendered).toContain('zz-second');
    expect(rendered).not.toContain('zz-third');
    expect(altered).toEqual([4]);
    expect(events).toEqual([{ kind: 'stray_tool_result_dropped', toolUseId: 'a', reason: 'answered' }]);
  });

  it('lets a result before its call keep that call from no later result in its message', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [result('a', 'zz-early'), call('a'), result('id_from_the_text', 'zz-parsed')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).not.toContain('zz-early');
    expect(rendered).toContain('zz-parsed');
    expect(altered).toEqual([1]);
  });

  it('renders a kept result from its own fields when a result dropped in another message shared its raw text', () => {
    const raw = '<function_results>\n<result tool_use_id="a">zz-kept</result>\n<result tool_use_id="b">zz-dropped</result>\n</function_results>';
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('a')] },
      { participant: 'Tool', content: [result('a', 'zz-kept', raw)] },
      { participant: 'Tool', content: [result('b', 'zz-dropped', raw)] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-kept');
    expect(rendered).not.toContain('zz-dropped');
    expect(altered).toEqual([2, 3]);
  });

  it('keeps a final assistant message whose turn a drop left with text alone', () => {
    const { rendered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [text('zz-reading'), result('call_9', 'zz-ghost')] },
      { participant: 'Agent', content: [text('zz-final')] },
    ]);
    expect(rendered).toContain('zz-reading');
    expect(rendered).toContain('zz-final');
    expect(rendered).not.toContain('zz-ghost');
  });
});
