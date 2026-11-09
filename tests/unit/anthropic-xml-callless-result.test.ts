import { describe, expect, it } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';
import type { ContentBlock, NormalizedMessage } from '../../src/types/index.js';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } });
const result = (id: string, content: string, rawXml?: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content, ...(rawXml ? { rawXml } : {}) }) as ContentBlock;

function build(messages: NormalizedMessage[], promptCaching = false) {
  const fidelity = new FidelityNotes();
  const built = new AnthropicXmlFormatter().buildMessages(messages, {
    assistantParticipant: 'Agent', promptCaching, cacheMarkers: 'cm-owned', fidelity,
  } as any);
  const rendered = built.messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  return { built, rendered, altered: [...fidelity.altered].sort((a, b) => a - b) };
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

  it('answers a call before it as the model reads the transcript, whatever its id, and leaves out a second for the same call', () => {
    const { rendered, altered } = build([
      { participant: 'User', content: [text('look')] },
      { participant: 'Agent', content: [call('generated_1')] },
      { participant: 'Tool', content: [result('call_from_the_text', 'zz-first'), result('call_from_the_text', 'zz-again')] },
      { participant: 'Agent', content: [] },
    ]);
    expect(rendered).toContain('zz-first');
    expect(rendered).not.toContain('zz-again');
    expect(altered).toEqual([2]);
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
});
