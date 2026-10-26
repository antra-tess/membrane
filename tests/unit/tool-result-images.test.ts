import { describe, it, expect } from 'vitest';
import {
  hasImageInToolResults,
  formatToolResultsForSplitTurn,
  formatToolResults,
} from '../../src/utils/tool-parser.js';
import type { ToolResult, ToolResultContentBlock } from '../../src/types/index.js';

const sampleImageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function createTextResult(toolUseId: string, text: string): ToolResult {
  return { toolUseId, toolName: `name_${toolUseId}`, content: text };
}

function createImageResult(toolUseId: string, text: string): ToolResult {
  const content: ToolResultContentBlock[] = [
    { type: 'text', text },
    { type: 'image', source: { type: 'base64', data: sampleImageData, mediaType: 'image/png' } },
  ];
  return { toolUseId, toolName: `name_${toolUseId}`, content };
}

function createMultiImageResult(toolUseId: string, text: string, imageCount: number): ToolResult {
  const content: ToolResultContentBlock[] = [{ type: 'text', text }];
  for (let i = 0; i < imageCount; i++) {
    content.push({
      type: 'image',
      source: { type: 'base64', data: sampleImageData, mediaType: 'image/png' },
    });
  }
  return { toolUseId, toolName: `name_${toolUseId}`, content };
}

describe('hasImageInToolResults', () => {
  it('detects images the request will send, across result shapes', () => {
    expect(hasImageInToolResults([createTextResult('tool_1', 'Hello world')])).toBe(false);
    expect(hasImageInToolResults([createImageResult('tool_1', 'Image result')])).toBe(true);
    expect(
      hasImageInToolResults([
        createTextResult('tool_1', 'Text result'),
        createImageResult('tool_2', 'Image result'),
      ]),
    ).toBe(true);
    expect(hasImageInToolResults([{ toolUseId: 'tool_1', content: [] }])).toBe(false);
    const notAnImage = Buffer.from('not an image').toString('base64');
    expect(hasImageInToolResults([{
      toolUseId: 'tool_1',
      content: [{ type: 'image', source: { type: 'base64', data: notAnImage, mediaType: 'image/png' } }],
    }])).toBe(false);
  });
});

describe('formatToolResults image placeholder mode', () => {
  it('renders images as bracketed placeholders inside the XML', () => {
    const xml = formatToolResults([createImageResult('tool_1', 'Screenshot taken')]);
    expect(xml).toContain('<function_results>');
    expect(xml).toContain('Screenshot taken');
    expect(xml).toMatch(/\[Image: image\/png, ~\d+KB, not shown to you\]/);
    expect(xml).toContain('</function_results>');
  });
});

describe('formatToolResultsForSplitTurn', () => {
  it('degrades to complete XML with no images', () => {
    const split = formatToolResultsForSplitTurn([createTextResult('tool_1', 'Hello world')]);
    expect(split.hasImages).toBe(false);
    expect(split.images).toEqual([]);
    expect(split.afterImageXml).toBe('');
    expect(split.beforeImageXml).toContain('<function_results>');
    expect(split.beforeImageXml).toContain('</function_results>');
  });

  it('splits a single image result around the image', () => {
    const split = formatToolResultsForSplitTurn([createImageResult('tool_1', 'Screenshot taken')]);
    expect(split.hasImages).toBe(true);
    expect(split.images).toHaveLength(1);
    expect(split.beforeImageXml).toContain('<function_results>');
    expect(split.beforeImageXml).toContain('<tool_name>name_tool_1</tool_name>');
    expect(split.beforeImageXml).toContain('Screenshot taken');
    expect(split.beforeImageXml).not.toContain('</result>');
    expect(split.beforeImageXml).not.toContain('</stdout>');
    expect(split.afterImageXml).toContain('</stdout>');
    expect(split.afterImageXml).toContain('</result>');
    expect(split.afterImageXml).toContain('</function_results>');
    const img = split.images[0];
    expect(img?.type).toBe('image');
    expect(img?.source.type).toBe('base64');
    expect(img?.source.media_type).toBe('image/png');
  });

  it('a result after the split point renders its image as the note, which says it is not shown', () => {
    const split = formatToolResultsForSplitTurn([
      createImageResult('tool_1', 'First result with image'),
      createImageResult('tool_2', 'Second result with image'),
    ]);
    expect(split.images).toHaveLength(1);
    expect(split.afterImageXml).toContain('<tool_name>name_tool_2</tool_name>');
    expect(split.afterImageXml).toMatch(/\[Image: image\/png, ~\d+KB, not shown to you\]/);
    expect(split.beforeImageXml).not.toContain('not shown to you');
  });

  it('splits at the first image when the FIRST of two results carries it', () => {
    const split = formatToolResultsForSplitTurn([
      createImageResult('tool_1', 'First result with image'),
      createTextResult('tool_2', 'Second result text only'),
    ]);
    expect(split.hasImages).toBe(true);
    expect(split.images).toHaveLength(1);
    expect(split.beforeImageXml).toContain('<tool_name>name_tool_1</tool_name>');
    expect(split.beforeImageXml).toContain('First result with image');
    expect(split.afterImageXml).toContain('</result>');
    expect(split.afterImageXml).toContain('<tool_name>name_tool_2</tool_name>');
    expect(split.afterImageXml).toContain('Second result text only');
    expect(split.afterImageXml).toContain('</function_results>');
  });

  it('splits at the image when the SECOND of two results carries it', () => {
    const split = formatToolResultsForSplitTurn([
      createTextResult('tool_1', 'First result text only'),
      createImageResult('tool_2', 'Second result with image'),
    ]);
    expect(split.hasImages).toBe(true);
    expect(split.images).toHaveLength(1);
    expect(split.beforeImageXml).toContain('<tool_name>name_tool_1</tool_name>');
    expect(split.beforeImageXml).toContain('First result text only');
    expect(split.beforeImageXml).toContain('</result>');
    expect(split.beforeImageXml).toContain('<tool_name>name_tool_2</tool_name>');
    expect(split.beforeImageXml).toContain('Second result with image');
    expect(split.afterImageXml).toContain('</result>');
    expect(split.afterImageXml).toContain('</function_results>');
  });

  it('carries all images of a multi-image result', () => {
    const split = formatToolResultsForSplitTurn([
      createMultiImageResult('tool_1', 'Multiple screenshots', 3),
    ]);
    expect(split.hasImages).toBe(true);
    expect(split.images).toHaveLength(3);
    for (const img of split.images) {
      expect(img.type).toBe('image');
      expect(img.source.type).toBe('base64');
    }
  });

  it('uses the error tag for error results with images', () => {
    const errorResult: ToolResult = {
      toolUseId: 'tool_1',
      content: [
        { type: 'text', text: 'Error occurred' },
        { type: 'image', source: { type: 'base64', data: sampleImageData, mediaType: 'image/png' } },
      ],
      isError: true,
    };
    const split = formatToolResultsForSplitTurn([errorResult]);
    expect(split.hasImages).toBe(true);
    expect(split.beforeImageXml).toContain('<error');
    expect(split.afterImageXml).toContain('</error>');
  });

  it('reassembles into balanced XML around the image slot', () => {
    const split = formatToolResultsForSplitTurn([createImageResult('tool_1', 'Test content')]);
    const fullXml = split.beforeImageXml + '[IMAGE]' + split.afterImageXml;
    expect(fullXml.match(/<function_results>/g)).toHaveLength(1);
    expect(fullXml.match(/<\/function_results>/g)).toHaveLength(1);
    expect((fullXml.match(/<result>/g) || []).length).toBe(
      (fullXml.match(/<\/result>/g) || []).length,
    );
  });
});
