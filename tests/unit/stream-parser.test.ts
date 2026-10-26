import { describe, it, expect, beforeEach } from 'vitest';
import { IncrementalXmlParser, hasUnclosedXmlBlock } from '../../src/utils/stream-parser.js';

describe('IncrementalXmlParser', () => {
  let parser: IncrementalXmlParser;

  beforeEach(() => {
    parser = new IncrementalXmlParser();
  });

  describe('basic accumulation', () => {
    it('should accumulate plain text chunks', () => {
      parser.push('Hello ');
      parser.push('world');

      expect(parser.getAccumulated()).toBe('Hello world');
    });

    it('should start with empty accumulator', () => {
      expect(parser.getAccumulated()).toBe('');
    });

    it('should reset accumulator', () => {
      parser.push('Some text');
      parser.reset();

      expect(parser.getAccumulated()).toBe('');
    });
  });

  describe('block type detection', () => {
    it('should detect text type for plain content', () => {
      parser.push('Plain text');

      expect(parser.getCurrentBlockType()).toBe('text');
    });

    it('should detect thinking type inside thinking tags', () => {
      parser.push('<thinking>');

      expect(parser.getCurrentBlockType()).toBe('thinking');
      expect(parser.isInsideBlock()).toBe(true);
    });

    it('should return to text after closing thinking tag', () => {
      parser.push('<thinking>thoughts</thinking>');

      expect(parser.getCurrentBlockType()).toBe('text');
      expect(parser.isInsideBlock()).toBe(false);
    });

    it('should detect function_calls block', () => {
      parser.push('<function_calls>');

      expect(parser.getCurrentBlockType()).toBe('tool_call');
      expect(parser.isInsideBlock()).toBe(true);
    });

    it('should detect function_results block', () => {
      parser.push('<function_results>');

      expect(parser.getCurrentBlockType()).toBe('tool_result');
      expect(parser.isInsideBlock()).toBe(true);
    });
  });

  describe('nested content detection', () => {
    it('should track nesting through incremental chunks', () => {
      parser.push('<func');
      parser.push('tion_calls>');

      expect(parser.isInsideBlock()).toBe(true);
    });

    it('should handle tags split across chunks', () => {
      parser.push('<think');
      parser.push('ing>content</thin');
      parser.push('king>');

      expect(parser.isInsideBlock()).toBe(false);
      expect(parser.getAccumulated()).toBe('<thinking>content</thinking>');
    });
  });

  describe('processChunk', () => {
    it('should return content with metadata', () => {
      const result = parser.processChunk('Hello');

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe('Hello');
      expect(result.content[0].meta.type).toBe('text');
      expect(result.content[0].meta.visible).toBe(true);
    });

    it('should mark thinking content as not visible', () => {
      parser.push('<thinking>');
      const result = parser.processChunk('internal thoughts');

      expect(result.content[0].meta.type).toBe('thinking');
      expect(result.content[0].meta.visible).toBe(false);
    });

    it('should emit block events for tag transitions', () => {
      const result = parser.processChunk('<thinking>');

      expect(result.blockEvents.length).toBeGreaterThan(0);
      const startEvent = result.blockEvents.find(e => e.event === 'block_start');
      expect(startEvent).toBeDefined();
      expect(startEvent?.block.type).toBe('thinking');
    });
  });

  describe('prefill initialization', () => {
    it('should handle prefill with open thinking tag', () => {
      parser.push('<thinking>Started thinking...');

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getCurrentBlockType()).toBe('thinking');

      parser.push('more thoughts</thinking>Done.');

      expect(parser.isInsideBlock()).toBe(false);
    });

    it('should track prefill length for content extraction', () => {
      const prefill = 'User: Hello\nClaude: ';
      parser.push(prefill);
      const prefillLength = parser.getAccumulated().length;

      parser.push('New content from API');

      const fullAccumulated = parser.getAccumulated();
      const newContent = fullAccumulated.slice(prefillLength);

      expect(newContent).toBe('New content from API');
    });
  });

  describe('false positive stop sequence detection', () => {
    it('should detect when inside XML block (stop sequence would be false positive)', () => {
      parser.push('<function_results><result>User: said something');

      expect(parser.isInsideBlock()).toBe(true);
    });

    it('should not flag false positive when outside blocks', () => {
      parser.push('Regular response text');

      expect(parser.isInsideBlock()).toBe(false);
    });
  });

  describe('emission interleaving', () => {
    it('should emit content before block_complete when content precedes closing tag', () => {
      parser.processChunk('<thinking>');

      const result = parser.processChunk('final thought</thinking>');

      const contentIdx = result.emissions.findIndex(e => e.kind === 'content' && e.text === 'final thought');
      const completeIdx = result.emissions.findIndex(e => e.kind === 'blockEvent' && e.event.event === 'block_complete');

      expect(contentIdx).toBeGreaterThanOrEqual(0);
      expect(completeIdx).toBeGreaterThanOrEqual(0);
      expect(contentIdx).toBeLessThan(completeIdx);
    });

    it('should emit block_start before content when content follows closing tag', () => {
      parser.processChunk('<thinking>thought</thinking>');

      const result = parser.processChunk('after text');

      const startIdx = result.emissions.findIndex(e => e.kind === 'blockEvent' && e.event.event === 'block_start');
      const contentIdx = result.emissions.findIndex(e => e.kind === 'content' && e.text === 'after text');

      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(contentIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeLessThan(contentIdx);
    });

    it('should emit in correct order for content+close+content in single chunk', () => {
      parser.processChunk('<thinking>');

      const result = parser.processChunk('last thought</thinking>new text');

      const emissions = result.emissions;

      const lastThoughtIdx = emissions.findIndex(e => e.kind === 'content' && e.text === 'last thought');
      const completeIdx = emissions.findIndex(e => e.kind === 'blockEvent' && e.event.event === 'block_complete');
      const startIdx = emissions.findIndex(e => e.kind === 'blockEvent' && e.event.event === 'block_start');
      const newTextIdx = emissions.findIndex(e => e.kind === 'content' && e.text === 'new text');

      expect(lastThoughtIdx).toBeLessThan(completeIdx);
      expect(completeIdx).toBeLessThan(startIdx);
      expect(startIdx).toBeLessThan(newTextIdx);
    });
  });

  describe('tool call content emission', () => {
    it('should emit tool call content correctly', () => {
      const result = parser.processChunk('<function_calls><invoke name="test"><parameter name="p">value</parameter></invoke></function_calls>');

      const contentEmissions = result.emissions.filter(e =>
        e.kind === 'content' && !e.text.includes('<')
      );

      const valueContent = result.emissions.find(e =>
        e.kind === 'content' && e.text === 'value'
      );
      expect(valueContent).toBeDefined();
      if (valueContent?.kind === 'content') {
        expect(valueContent.meta.type).toBe('tool_call');
      }
    });

    it('should NOT emit closing tag as content', () => {
      parser.processChunk('<function_calls><invoke name="t"><parameter name="p">v</parameter></invoke>');
      const result = parser.processChunk('</function_calls>');

      const closingTagContent = result.emissions.find(e =>
        e.kind === 'content' && e.text.includes('</function_calls>')
      );
      expect(closingTagContent).toBeUndefined();

      const completeEvent = result.emissions.find(e =>
        e.kind === 'blockEvent' && e.event.event === 'block_complete'
      );
      expect(completeEvent).toBeDefined();
    });

    it('should NOT emit opening tag as content', () => {
      const result = parser.processChunk('<function_calls>');

      const openingTagContent = result.emissions.find(e =>
        e.kind === 'content' && e.text.includes('<function_calls>')
      );
      expect(openingTagContent).toBeUndefined();

      const startEvent = result.emissions.find(e =>
        e.kind === 'blockEvent' && e.event.event === 'block_start'
      );
      expect(startEvent).toBeDefined();
    });

    it('should handle empty tool call block (model hallucination scenario)', () => {
      const result = parser.processChunk('<function_calls></function_calls>');

      const closingTagContent = result.emissions.find(e =>
        e.kind === 'content' && e.text.includes('</function_calls>')
      );
      expect(closingTagContent).toBeUndefined();

      const startEvent = result.blockEvents.find(e => e.event === 'block_start' && e.block.type === 'tool_call');
      const completeEvent = result.blockEvents.find(e => e.event === 'block_complete' && e.block.type === 'tool_call');
      expect(startEvent).toBeDefined();
      expect(completeEvent).toBeDefined();
    });

    it('should handle content after closing tag (hallucination scenario)', () => {
      parser.processChunk('<function_calls><invoke name="t"></invoke>');
      const result = parser.processChunk('</function_calls>antra_tessera: hallucinated content');

      const hallucinatedContent = result.emissions.find(e =>
        e.kind === 'content' && e.text.includes('antra_tessera')
      );
      expect(hallucinatedContent).toBeDefined();
      if (hallucinatedContent?.kind === 'content') {
        expect(hallucinatedContent.meta.type).toBe('text');
      }

      const closingTag = result.emissions.find(e =>
        e.kind === 'content' && e.text.includes('</function_calls>')
      );
      expect(closingTag).toBeUndefined();
    });

    it('should keep only parameter values, not invoke or parameter tags, in a tool call block\'s content', () => {
      parser.processChunk('<function_calls>');
      parser.processChunk('<invoke name="config_read">');
      parser.processChunk('<parameter name="key">value</parameter>');
      parser.processChunk('</invoke>');
      const result = parser.processChunk('</function_calls>');

      const completeEvent = result.blockEvents.find(e => e.event === 'block_complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.block.content).toBeDefined();
      expect(completeEvent?.block.content).toBe('value');
    });

    it('should capture raw XML in accumulated for tool parsing', () => {
      parser.processChunk('<function_calls>');
      parser.processChunk('<invoke name="config_read">');
      parser.processChunk('<parameter name="key">value</parameter>');
      parser.processChunk('</invoke>');
      parser.processChunk('</function_calls>');

      const accumulated = parser.getAccumulated();
      expect(accumulated).toContain('<function_calls>');
      expect(accumulated).toContain('<invoke name="config_read">');
      expect(accumulated).toContain('<parameter name="key">value</parameter>');
      expect(accumulated).toContain('</invoke>');
      expect(accumulated).toContain('</function_calls>');
    });
  });

  describe('hallucination scenarios', () => {
    it('should handle model outputting closing tag followed by hallucinated conversation', () => {
      parser.processChunk('<function_calls>');
      parser.processChunk('<invoke name="config_read">');
      parser.processChunk('<parameter name="key">settings</parameter>');
      parser.processChunk('</invoke>');

      const result = parser.processChunk('</function_calls>\nantra_tessera: <@StrangeOpus4.5>\nStrangeOpus4.5: I see config...');

      const textContent = result.emissions.filter(e =>
        e.kind === 'content' && e.meta.type === 'text'
      );
      expect(textContent.length).toBeGreaterThan(0);
      expect(textContent.some(e => e.kind === 'content' && e.text.includes('antra_tessera'))).toBe(true);

      const allContent = result.emissions
        .filter(e => e.kind === 'content')
        .map(e => (e as any).text)
        .join('');
      expect(allContent).not.toContain('</function_calls>');
    });

    it('should track correct block types through complex hallucination', () => {
      let result = parser.processChunk('<thinking>Let me check tools</thinking>');

      expect(result.blockEvents.some(e => e.event === 'block_complete' && e.block.type === 'thinking')).toBe(true);

      result = parser.processChunk('<function_calls></function_calls>');

      expect(result.blockEvents.some(e => e.event === 'block_complete' && e.block.type === 'tool_call')).toBe(true);

      expect(parser.getCurrentBlockType()).toBe('text');
      expect(parser.isInsideBlock()).toBe(false);
    });

    it('should not leak closing tags to content even with malformed input', () => {
      const testCases = [
        '<function_calls><invoke name="t"></invoke></function_calls>',
        '<function_calls></function_calls>',
        '<function_calls>  </function_calls>',
        '<function_calls>\n\n</function_calls>',
      ];

      for (const testCase of testCases) {
        const p = new IncrementalXmlParser();
        const result = p.processChunk(testCase);

        const allContent = result.emissions
          .filter(e => e.kind === 'content')
          .map(e => (e as any).text)
          .join('');

        expect(allContent).not.toContain('</function_calls>');
        expect(allContent).not.toContain('<function_calls>');
      }
    });
  });

  describe('chunk metadata accuracy', () => {
    it('should emit correct block type for content before closing tag in same chunk', () => {
      parser.processChunk('<thinking>');

      const result = parser.processChunk('last thought</thinking>');

      const thinkingContent = result.content.filter(c => c.text.trim() && !c.text.includes('<'));
      expect(thinkingContent.length).toBeGreaterThan(0);
      expect(thinkingContent[0].meta.type).toBe('thinking');
    });

    it('should emit correct block type for content after closing tag in same chunk', () => {
      parser.processChunk('<thinking>thoughts');

      const result = parser.processChunk('</thinking>after text');

      const textContent = result.content.filter(c => c.text === 'after text');
      expect(textContent.length).toBe(1);
      expect(textContent[0].meta.type).toBe('text');
    });

    it('should handle content+close+content in one chunk', () => {
      parser.processChunk('<thinking>');

      const result = parser.processChunk('thinking content</thinking>plain text');

      const beforeClose = result.content.filter(c => c.text.includes('thinking content'));
      expect(beforeClose.length).toBe(1);
      expect(beforeClose[0].meta.type).toBe('thinking');

      const afterClose = result.content.filter(c => c.text.includes('plain text'));
      expect(afterClose.length).toBe(1);
      expect(afterClose[0].meta.type).toBe('text');
    });
  });

  describe('prefill thinking tag poisoning (continuation loop bug)', () => {
    it('should detect unclosed thinking tags from conversation prefill', () => {
      const prefill = [
        'QA-Tester: hey whats up',
        'kappa: <thinking> *beams* Hi there! How are you doing today?',
        'QA-Tester: doing great!',
        'Claude3Sonnet: <thinking> The user seems happy. Let me respond warmly.',
        'QA-Tester: tell me a joke',
        'kappa: <thinking> <thinking> <thinking> okay let me think of something funny',
      ].join('\n');

      parser.push(prefill);

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getDepths().thinking).toBe(5);
    });

    it('should persist poisoned depth across resetForNewIteration', () => {
      const prefill = 'kappa: <thinking> hello\nuser: hi\nbot: <thinking> thinking about it';
      parser.push(prefill);

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getDepths().thinking).toBe(2);

      parser.resetForNewIteration();

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getDepths().thinking).toBe(2);
    });

    it('should simulate the full continuation loop scenario', () => {
      const prefill = [
        'user: hello everyone',
        'kappa: <thinking> *waves* hi there!',
        'user: how are you',
        'Sonnet: <thinking> they seem friendly, let me engage',
        'user: nyan',
      ].join('\n');

      parser.push(prefill);
      const prefillLength = parser.getAccumulated().length;

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getDepths().thinking).toBe(2);

      // A provider's response leaves out the stop sequence it matched.
      const modelResponse = ' I aim to be helpful. Is there something I can help with?';
      parser.push(modelResponse);

      expect(parser.isInsideBlock()).toBe(true);

      parser.push('\nuser:');
      parser.resetForNewIteration();

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getDepths().thinking).toBe(2);

      parser.push(' What does it feel like?');
      expect(parser.isInsideBlock()).toBe(true);
    });

    it('should NOT be poisoned by balanced thinking tags in prefill', () => {
      const prefill = [
        'user: hello',
        'bot: <thinking>let me think</thinking> Here is my response!',
        'user: thanks',
        'bot: <thinking>they appreciated it</thinking> You are welcome!',
      ].join('\n');

      parser.push(prefill);

      expect(parser.isInsideBlock()).toBe(false);
      expect(parser.getDepths().thinking).toBe(0);
    });

    it('should be poisoned even by a single unclosed thinking tag in a long prefill', () => {
      const prefill = [
        'user: hey',
        'bot1: <thinking>hmm</thinking> Hello!',
        'bot2: <thinking>interesting</thinking> Hi there!',
        'bot3: <thinking> ooh a new user, let me say hi',
        'user: whats up',
        'bot1: Not much! Just chatting.',
      ].join('\n');

      parser.push(prefill);

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getDepths().thinking).toBe(1);
    });
  });

  describe('a closing tag with no block in progress', () => {
    const tags = [
      ['thinking', 'thinking'],
      ['function_calls', 'tool_call'],
      ['function_results', 'tool_result'],
    ] as const;
    const zero = { functionCalls: 0, functionResults: 0, thinking: 0 };

    it.each(tags)('</%s> on a fresh parser sends nothing, leaves every depth at 0, and takes no index', (tag, type) => {
      expect(parser.processChunk(`</${tag}>`).blockEvents).toEqual([]);
      expect(parser.getDepths()).toEqual(zero);
      expect(parser.processChunk(`<${tag}>x</${tag}>y`).blockEvents).toEqual([
        { event: 'block_start', index: 0, block: { type } },
        { event: 'block_complete', index: 0, block: { type, content: 'x' } },
        { event: 'block_start', index: 1, block: { type: 'text' } },
      ]);
      expect(parser.getDepths()).toEqual(zero);
    });

    it.each(tags)('</%s> after its block was flushed sends nothing, and leaves every depth at 0', (tag, type) => {
      parser.processChunk(`<${tag}>x`);
      expect(parser.flush().blockEvents).toEqual([{ event: 'block_complete', index: 0, block: { type, content: 'x' } }]);
      expect(parser.processChunk(`</${tag}>`).blockEvents).toEqual([]);
      expect(parser.getDepths()).toEqual(zero);
    });
  });

  describe('antml: tag prefix', () => {
    it('recognizes antml-prefixed function_calls open and close', () => {
      parser.push('<' + 'antml:function_calls>');
      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.isInsideFunctionCalls()).toBe(true);
      parser.push('</' + 'antml:function_calls>');
      expect(parser.isInsideBlock()).toBe(false);
    });
  });

  describe('getContext', () => {
    it("reports 'none' when outside all blocks", () => {
      expect(parser.getContext()).toBe('none');
    });

    it('reports the open block stack and empties on close', () => {
      parser.push('<function_calls>');
      expect(parser.getContext()).toContain('function_calls');
      parser.push('<function_results>');
      expect(parser.getContext()).toContain('function_calls');
      expect(parser.getContext()).toContain('function_results');
      parser.push('</function_results></function_calls>');
      expect(parser.getContext()).toBe('none');
    });
  });

  describe('hasUnclosedXmlBlock utility', () => {
    it('detects unclosed blocks and ignores balanced or plain text', () => {
      expect(hasUnclosedXmlBlock('Hello world')).toBe(false);
      expect(hasUnclosedXmlBlock('<function_calls>')).toBe(true);
      expect(hasUnclosedXmlBlock('<function_calls></function_calls>')).toBe(false);
      expect(hasUnclosedXmlBlock('<function_results><result>')).toBe(true);
      expect(hasUnclosedXmlBlock('<thinking>thoughts')).toBe(true);
    });
  });
});
