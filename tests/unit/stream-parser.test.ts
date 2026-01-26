/**
 * Unit tests for stream-parser.ts (IncrementalXmlParser)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IncrementalXmlParser } from '../../src/utils/stream-parser.js';

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

      // Note: function_calls maps to 'tool_call' block type
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
      // Simulate prefill that ends mid-thinking
      parser.push('<thinking>Started thinking...');

      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getCurrentBlockType()).toBe('thinking');

      // Simulate API continuation
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

      // We're inside function_results, so "\nUser:" would be a false positive
      expect(parser.isInsideBlock()).toBe(true);
    });

    it('should not flag false positive when outside blocks', () => {
      parser.push('Regular response text');

      expect(parser.isInsideBlock()).toBe(false);
    });
  });

  describe('chunk metadata accuracy', () => {
    it('should emit correct block type for content before closing tag in same chunk', () => {
      // First establish we're in a thinking block
      parser.processChunk('<thinking>');

      // Now process a chunk that contains content AND the closing tag
      const result = parser.processChunk('last thought</thinking>');

      // The "last thought" part should have type 'thinking', not 'text'
      const thinkingContent = result.content.filter(c => c.text.trim() && !c.text.includes('<'));
      expect(thinkingContent.length).toBeGreaterThan(0);
      expect(thinkingContent[0].meta.type).toBe('thinking');
    });

    it('should emit correct block type for content after closing tag in same chunk', () => {
      parser.processChunk('<thinking>thoughts');

      const result = parser.processChunk('</thinking>after text');

      // Content after closing tag should be 'text' type
      const textContent = result.content.filter(c => c.text === 'after text');
      expect(textContent.length).toBe(1);
      expect(textContent[0].meta.type).toBe('text');
    });

    it('should handle content+close+content in one chunk', () => {
      parser.processChunk('<thinking>');

      const result = parser.processChunk('thinking content</thinking>plain text');

      // Find thinking content
      const beforeClose = result.content.filter(c => c.text.includes('thinking content'));
      expect(beforeClose.length).toBe(1);
      expect(beforeClose[0].meta.type).toBe('thinking');

      // Find plain text content
      const afterClose = result.content.filter(c => c.text.includes('plain text'));
      expect(afterClose.length).toBe(1);
      expect(afterClose[0].meta.type).toBe('text');
    });
  });
});
