/**
 * Tool result image handling test
 * Tests the split-turn injection for images in tool results (prefill mode)
 * Run with: npx tsx test/tool-result-images.test.ts
 */

import {
  hasImageInToolResults,
  formatToolResultsForSplitTurn,
  formatToolResults,
} from '../src/utils/tool-parser.js';
import type { ToolResult, ToolResultContentBlock } from '../src/types/index.js';

// Test helpers
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

// Sample image data (1x1 red pixel PNG)
const sampleImageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function createTextResult(toolUseId: string, text: string): ToolResult {
  return { toolUseId, content: text };
}

function createImageResult(
  toolUseId: string,
  text: string,
  imageData: string = sampleImageData
): ToolResult {
  const content: ToolResultContentBlock[] = [
    { type: 'text', text },
    { type: 'image', source: { type: 'base64', data: imageData, mediaType: 'image/png' } },
  ];
  return { toolUseId, content };
}

function createMultiImageResult(
  toolUseId: string,
  text: string,
  imageCount: number = 2
): ToolResult {
  const content: ToolResultContentBlock[] = [{ type: 'text', text }];
  for (let i = 0; i < imageCount; i++) {
    content.push({
      type: 'image',
      source: { type: 'base64', data: sampleImageData, mediaType: 'image/png' },
    });
  }
  return { toolUseId, content };
}

// ============================================================================
// Test 1: hasImageInToolResults - Detection
// ============================================================================

console.log('\n--- Test 1: hasImageInToolResults Detection ---');

{
  // Text-only result
  const textResults = [createTextResult('tool_1', 'Hello world')];
  assert(!hasImageInToolResults(textResults), 'Text-only results should return false');

  // Result with image
  const imageResults = [createImageResult('tool_1', 'Image result')];
  assert(hasImageInToolResults(imageResults), 'Result with image should return true');

  // Mixed results (text first, then image)
  const mixedResults = [
    createTextResult('tool_1', 'Text result'),
    createImageResult('tool_2', 'Image result'),
  ];
  assert(hasImageInToolResults(mixedResults), 'Mixed results with image should return true');

  // Empty content array
  const emptyArrayResult: ToolResult = { toolUseId: 'tool_1', content: [] };
  assert(!hasImageInToolResults([emptyArrayResult]), 'Empty array content should return false');
}

// ============================================================================
// Test 2: formatToolResults - Text-only (existing behavior)
// ============================================================================

console.log('\n--- Test 2: formatToolResults Text-only ---');

{
  const textResults = [createTextResult('tool_1', 'Hello world')];
  const xml = formatToolResults(textResults);

  assert(xml.includes('<function_results>'), 'Should have opening tag');
  assert(xml.includes('</function_results>'), 'Should have closing tag');
  assert(xml.includes('tool_use_id="tool_1"'), 'Should have tool_use_id');
  assert(xml.includes('Hello world'), 'Should contain result text');
}

// ============================================================================
// Test 3: formatToolResults - With Images (placeholder mode)
// ============================================================================

console.log('\n--- Test 3: formatToolResults With Images (placeholder) ---');

{
  const imageResults = [createImageResult('tool_1', 'Screenshot taken')];
  const xml = formatToolResults(imageResults);

  assert(xml.includes('<function_results>'), 'Should have opening tag');
  assert(xml.includes('Screenshot taken'), 'Should contain text portion');
  assert(xml.includes('[Image: image/png'), 'Should have image placeholder');
  assert(xml.includes('</function_results>'), 'Should have closing tag');
}

// ============================================================================
// Test 4: formatToolResultsForSplitTurn - No Images
// ============================================================================

console.log('\n--- Test 4: formatToolResultsForSplitTurn No Images ---');

{
  const textResults = [createTextResult('tool_1', 'Hello world')];
  const split = formatToolResultsForSplitTurn(textResults);

  assert(!split.hasImages, 'hasImages should be false');
  assert(split.images.length === 0, 'images array should be empty');
  assert(split.afterImageXml === '', 'afterImageXml should be empty');
  assert(split.beforeImageXml.includes('<function_results>'), 'Should have complete XML');
  assert(split.beforeImageXml.includes('</function_results>'), 'Should have closing tag');
}

// ============================================================================
// Test 5: formatToolResultsForSplitTurn - Single Result With Image
// ============================================================================

console.log('\n--- Test 5: formatToolResultsForSplitTurn Single Image ---');

{
  const imageResults = [createImageResult('tool_1', 'Screenshot taken')];
  const split = formatToolResultsForSplitTurn(imageResults);

  assert(split.hasImages, 'hasImages should be true');
  assert(split.images.length === 1, 'Should have exactly one image');

  // Before image: opening tags + text content
  assert(split.beforeImageXml.includes('<function_results>'), 'Before should have opening tag');
  assert(split.beforeImageXml.includes('tool_use_id="tool_1"'), 'Before should have tool_use_id');
  assert(split.beforeImageXml.includes('Screenshot taken'), 'Before should have text content');
  assert(!split.beforeImageXml.includes('</result>'), 'Before should NOT have closing result tag');

  // After image: closing tags
  assert(split.afterImageXml.includes('</result>'), 'After should have closing result tag');
  assert(split.afterImageXml.includes('</function_results>'), 'After should have closing function_results');

  // Image format
  const img = split.images[0];
  assert(img?.type === 'image', 'Image should have type image');
  assert(img?.source.type === 'base64', 'Image source should be base64');
  assert(img?.source.media_type === 'image/png', 'Image should have correct media_type');
}

// ============================================================================
// Test 6: formatToolResultsForSplitTurn - Multiple Results, First Has Image
// ============================================================================

console.log('\n--- Test 6: formatToolResultsForSplitTurn Multiple Results, First Image ---');

{
  const mixedResults = [
    createImageResult('tool_1', 'First result with image'),
    createTextResult('tool_2', 'Second result text only'),
  ];
  const split = formatToolResultsForSplitTurn(mixedResults);

  assert(split.hasImages, 'hasImages should be true');
  assert(split.images.length === 1, 'Should have one image from first result');

  // Before image: first result's text
  assert(split.beforeImageXml.includes('tool_use_id="tool_1"'), 'Before should have first tool_use_id');
  assert(split.beforeImageXml.includes('First result with image'), 'Before should have first text');

  // After image: closing of first result + complete second result
  assert(split.afterImageXml.includes('</result>'), 'After should close first result');
  assert(split.afterImageXml.includes('tool_use_id="tool_2"'), 'After should have second result');
  assert(split.afterImageXml.includes('Second result text only'), 'After should have second text');
  assert(split.afterImageXml.includes('</function_results>'), 'After should close function_results');
}

// ============================================================================
// Test 7: formatToolResultsForSplitTurn - Multiple Results, Second Has Image
// ============================================================================

console.log('\n--- Test 7: formatToolResultsForSplitTurn Multiple Results, Second Image ---');

{
  const mixedResults = [
    createTextResult('tool_1', 'First result text only'),
    createImageResult('tool_2', 'Second result with image'),
  ];
  const split = formatToolResultsForSplitTurn(mixedResults);

  assert(split.hasImages, 'hasImages should be true');
  assert(split.images.length === 1, 'Should have one image from second result');

  // Before image: complete first result + second result's text
  assert(split.beforeImageXml.includes('tool_use_id="tool_1"'), 'Before should have first tool_use_id');
  assert(split.beforeImageXml.includes('First result text only'), 'Before should have first text');
  assert(split.beforeImageXml.includes('</result>'), 'Before should close first result');
  assert(split.beforeImageXml.includes('tool_use_id="tool_2"'), 'Before should have second tool_use_id');
  assert(split.beforeImageXml.includes('Second result with image'), 'Before should have second text');

  // After image: closing of second result
  assert(split.afterImageXml.includes('</result>'), 'After should close second result');
  assert(split.afterImageXml.includes('</function_results>'), 'After should close function_results');
}

// ============================================================================
// Test 8: formatToolResultsForSplitTurn - Multiple Images in One Result
// ============================================================================

console.log('\n--- Test 8: formatToolResultsForSplitTurn Multiple Images in One Result ---');

{
  const multiImageResults = [createMultiImageResult('tool_1', 'Multiple screenshots', 3)];
  const split = formatToolResultsForSplitTurn(multiImageResults);

  assert(split.hasImages, 'hasImages should be true');
  assert(split.images.length === 3, 'Should have all 3 images');

  // All images should be in the user turn
  for (const img of split.images) {
    assert(img.type === 'image', 'Each should be image type');
    assert(img.source.type === 'base64', 'Each should be base64');
  }
}

// ============================================================================
// Test 9: formatToolResultsForSplitTurn - Error Result With Image
// ============================================================================

console.log('\n--- Test 9: formatToolResultsForSplitTurn Error Result ---');

{
  const errorResult: ToolResult = {
    toolUseId: 'tool_1',
    content: [
      { type: 'text', text: 'Error occurred' },
      { type: 'image', source: { type: 'base64', data: sampleImageData, mediaType: 'image/png' } },
    ],
    isError: true,
  };
  const split = formatToolResultsForSplitTurn([errorResult]);

  assert(split.hasImages, 'hasImages should be true');
  assert(split.beforeImageXml.includes('<error'), 'Should use error tag');
  assert(split.afterImageXml.includes('</error>'), 'Should close with error tag');
}

// ============================================================================
// Test 10: XML Structure Integrity
// ============================================================================

console.log('\n--- Test 10: XML Structure Integrity ---');

{
  const imageResult = createImageResult('tool_1', 'Test content');
  const split = formatToolResultsForSplitTurn([imageResult]);

  // Combine all parts and verify XML is well-formed
  const fullXml = split.beforeImageXml + '[IMAGE]' + split.afterImageXml;

  // Count opening and closing tags
  const functionResultsOpen = (fullXml.match(/<function_results>/g) || []).length;
  const functionResultsClose = (fullXml.match(/<\/function_results>/g) || []).length;
  assert(functionResultsOpen === 1, 'Should have exactly one opening function_results');
  assert(functionResultsClose === 1, 'Should have exactly one closing function_results');

  const resultOpen = (fullXml.match(/<result /g) || []).length;
  const resultClose = (fullXml.match(/<\/result>/g) || []).length;
  assert(resultOpen === resultClose, 'Result tags should be balanced');
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
