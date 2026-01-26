/**
 * Unit tests for tool-parser.ts
 *
 * These tests would have caught the duplicate text block bug (v0.1.6)
 */

import { describe, it, expect } from 'vitest';
import { parseAccumulatedIntoBlocks, parseToolCalls, formatToolResults } from '../../src/utils/tool-parser.js';

describe('parseAccumulatedIntoBlocks', () => {
  describe('plain text (no special blocks)', () => {
    it('should return exactly one text block for plain text', () => {
      const { blocks } = parseAccumulatedIntoBlocks('Hello world');

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should not duplicate text blocks for longer plain text', () => {
      const text = 'This is a longer response with multiple sentences. It has no special XML blocks at all. Just plain text content that the model generated.';
      const { blocks } = parseAccumulatedIntoBlocks(text);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      expect((blocks[0] as any).text).toBe(text);
    });

    it('should trim whitespace from plain text', () => {
      const { blocks } = parseAccumulatedIntoBlocks('  Hello world  \n\n');

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should return empty array for whitespace-only text', () => {
      const { blocks } = parseAccumulatedIntoBlocks('   \n\n   ');

      expect(blocks).toHaveLength(0);
    });

    it('should return empty array for empty string', () => {
      const { blocks } = parseAccumulatedIntoBlocks('');

      expect(blocks).toHaveLength(0);
    });
  });

  describe('thinking blocks', () => {
    it('should parse a single thinking block', () => {
      const text = '<thinking>Let me think about this...</thinking>';
      const { blocks } = parseAccumulatedIntoBlocks(text);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('thinking');
      expect((blocks[0] as any).thinking).toBe('Let me think about this...');
    });

    it('should parse thinking block with text before', () => {
      const text = 'Here is my response:\n<thinking>Internal thoughts</thinking>';
      const { blocks } = parseAccumulatedIntoBlocks(text);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('thinking');
    });

    it('should parse thinking block with text after', () => {
      const text = '<thinking>Internal thoughts</thinking>\nHere is my answer.';
      const { blocks } = parseAccumulatedIntoBlocks(text);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('thinking');
      expect(blocks[1].type).toBe('text');
    });

    it('should parse thinking block with text before and after', () => {
      const text = 'Preamble\n<thinking>Thoughts</thinking>\nConclusion';
      const { blocks } = parseAccumulatedIntoBlocks(text);

      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('thinking');
      expect(blocks[2].type).toBe('text');
    });
  });

  describe('function_calls blocks', () => {
    it('should parse a single tool call', () => {
      const text = `<function_calls>
<invoke name="get_weather">
<parameter name="city">London</parameter>
</invoke>
</function_calls>`;

      const { blocks, toolCalls } = parseAccumulatedIntoBlocks(text);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe('get_weather');
      expect(toolCalls[0].input).toEqual({ city: 'London' });

      // Should have tool_use block
      const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');
      expect(toolUseBlocks).toHaveLength(1);
    });

    it('should parse multiple tool calls in one block', () => {
      const text = `<function_calls>
<invoke name="tool_a">
<parameter name="x">1</parameter>
</invoke>
<invoke name="tool_b">
<parameter name="y">2</parameter>
</invoke>
</function_calls>`;

      const { blocks, toolCalls } = parseAccumulatedIntoBlocks(text);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].name).toBe('tool_a');
      expect(toolCalls[1].name).toBe('tool_b');
    });

    it('should parse self-closing invoke tags', () => {
      const text = `<function_calls>
<invoke name="no_params_tool"/>
</function_calls>`;

      const { toolCalls } = parseAccumulatedIntoBlocks(text);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe('no_params_tool');
      expect(toolCalls[0].input).toEqual({});
    });

    it('should parse text before function_calls', () => {
      const text = `Let me help you with that.
<function_calls>
<invoke name="helper"/>
</function_calls>`;

      const { blocks } = parseAccumulatedIntoBlocks(text);

      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks[0].type).toBe('text');
      expect((blocks[0] as any).text).toContain('Let me help');
    });
  });

  describe('function_results blocks', () => {
    it('should parse tool results', () => {
      const text = `<function_results>
<result tool_use_id="123">Success!</result>
</function_results>`;

      const { blocks, toolResults } = parseAccumulatedIntoBlocks(text);

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolUseId).toBe('123');
      expect(toolResults[0].content).toBe('Success!');
      expect(toolResults[0].isError).toBe(false);
    });

    it('should parse error results', () => {
      const text = `<function_results>
<error tool_use_id="456">Something went wrong</error>
</function_results>`;

      const { toolResults } = parseAccumulatedIntoBlocks(text);

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolUseId).toBe('456');
      expect(toolResults[0].isError).toBe(true);
    });
  });

  describe('complex mixed content', () => {
    it('should parse thinking + text + tool call sequence', () => {
      const text = `<thinking>I should check the weather</thinking>
Let me look that up for you.
<function_calls>
<invoke name="get_weather">
<parameter name="city">Paris</parameter>
</invoke>
</function_calls>`;

      const { blocks } = parseAccumulatedIntoBlocks(text);

      // Should have: thinking, text, tool_use
      const types = blocks.map(b => b.type);
      expect(types).toContain('thinking');
      expect(types).toContain('text');
      expect(types).toContain('tool_use');
    });

    it('should handle full tool execution cycle', () => {
      const text = `<thinking>Need to fetch data</thinking>
<function_calls>
<invoke name="fetch_data">
<parameter name="id">42</parameter>
</invoke>
</function_calls>
<function_results>
<result tool_use_id="abc">{"value": 100}</result>
</function_results>
Based on the data, the value is 100.`;

      const { blocks, toolCalls, toolResults } = parseAccumulatedIntoBlocks(text);

      expect(toolCalls).toHaveLength(1);
      expect(toolResults).toHaveLength(1);

      // Should have text at the end
      const lastBlock = blocks[blocks.length - 1];
      expect(lastBlock.type).toBe('text');
      expect((lastBlock as any).text).toContain('value is 100');
    });
  });

  describe('block count invariants', () => {
    it('INVARIANT: text block count should not exceed text regions', () => {
      // Plain text = 1 region = 1 block
      const plain = parseAccumulatedIntoBlocks('Just text');
      expect(plain.blocks.filter(b => b.type === 'text')).toHaveLength(1);

      // Text + thinking + text = 2 text regions = 2 text blocks
      const mixed = parseAccumulatedIntoBlocks('Before\n<thinking>Middle</thinking>\nAfter');
      expect(mixed.blocks.filter(b => b.type === 'text')).toHaveLength(2);
    });

    it('INVARIANT: total blocks should equal special blocks + text regions', () => {
      const text = `Text1
<thinking>Think</thinking>
Text2
<function_calls><invoke name="x"/></function_calls>
Text3`;

      const { blocks } = parseAccumulatedIntoBlocks(text);

      const thinkingCount = blocks.filter(b => b.type === 'thinking').length;
      const toolUseCount = blocks.filter(b => b.type === 'tool_use').length;
      const textCount = blocks.filter(b => b.type === 'text').length;

      expect(thinkingCount).toBe(1);
      expect(toolUseCount).toBe(1);
      expect(textCount).toBe(3); // Text1, Text2, Text3
      expect(blocks.length).toBe(5);
    });
  });
});

describe('parseToolCalls', () => {
  it('should return null for text without tool calls', () => {
    const result = parseToolCalls('Just some regular text');
    expect(result).toBeNull();
  });

  it('should parse the last unexecuted tool call block', () => {
    const text = `<function_calls>
<invoke name="first"/>
</function_calls>
<function_results>
<result tool_use_id="1">done</result>
</function_results>
<function_calls>
<invoke name="second"/>
</function_calls>`;

    const result = parseToolCalls(text);

    expect(result).not.toBeNull();
    expect(result!.calls).toHaveLength(1);
    expect(result!.calls[0].name).toBe('second');
  });

  it('should return null if all tool calls have results', () => {
    const text = `<function_calls>
<invoke name="tool"/>
</function_calls>
<function_results>
<result tool_use_id="1">done</result>
</function_results>`;

    const result = parseToolCalls(text);
    expect(result).toBeNull();
  });
});

describe('formatToolResults', () => {
  it('should format a single result', () => {
    const results = [{ toolUseId: 'abc', content: 'Success', isError: false }];
    const xml = formatToolResults(results);

    expect(xml).toContain('<function_results>');
    expect(xml).toContain('</function_results>');
    expect(xml).toContain('tool_use_id="abc"');
    expect(xml).toContain('Success');
  });

  it('should format error results with error tag', () => {
    const results = [{ toolUseId: 'xyz', content: 'Failed', isError: true }];
    const xml = formatToolResults(results);

    expect(xml).toContain('<error');
    expect(xml).toContain('Failed');
  });

  it('should format multiple results', () => {
    const results = [
      { toolUseId: 'a', content: 'Result A', isError: false },
      { toolUseId: 'b', content: 'Result B', isError: false },
    ];
    const xml = formatToolResults(results);

    expect(xml).toContain('tool_use_id="a"');
    expect(xml).toContain('tool_use_id="b"');
  });
});
