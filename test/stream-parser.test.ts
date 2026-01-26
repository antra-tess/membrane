/**
 * IncrementalXmlParser test
 * Tests the incremental XML parser for streaming
 * Run with: npx tsx test/stream-parser.test.ts
 */

import { IncrementalXmlParser, hasUnclosedXmlBlock } from '../src/utils/stream-parser.js';

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

// ============================================================================
// Test 1: Basic Nesting Tracking - function_calls
// ============================================================================

console.log('\n--- Test 1: Basic Nesting Tracking - function_calls ---');

{
  const parser = new IncrementalXmlParser();

  parser.push('Hello ');
  assert(!parser.isInsideBlock(), 'Plain text should not be inside block');

  parser.push('<function_calls>');
  assert(parser.isInsideBlock(), 'Should be inside block after opening tag');
  assert(parser.isInsideFunctionCalls(), 'Should specifically be inside function_calls');

  parser.push('<invoke name="test">');
  assert(parser.isInsideBlock(), 'Should still be inside block');

  parser.push('</invoke>');
  assert(parser.isInsideBlock(), 'Should still be inside after closing invoke');

  parser.push('</function_calls>');
  assert(!parser.isInsideBlock(), 'Should not be inside block after closing tag');
}

// ============================================================================
// Test 2: Basic Nesting Tracking - function_results
// ============================================================================

console.log('\n--- Test 2: Basic Nesting Tracking - function_results ---');

{
  const parser = new IncrementalXmlParser();

  parser.push('<function_results>');
  assert(parser.isInsideBlock(), 'Should be inside block after opening tag');
  assert(parser.isInsideFunctionResults(), 'Should specifically be inside function_results');

  parser.push('<result tool_use_id="123">');
  parser.push('Some result content');
  assert(parser.isInsideBlock(), 'Should still be inside block');

  parser.push('</result>');
  assert(parser.isInsideBlock(), 'Should still be inside function_results');

  parser.push('</function_results>');
  assert(!parser.isInsideBlock(), 'Should not be inside block after closing tag');
}

// ============================================================================
// Test 3: Basic Nesting Tracking - thinking
// ============================================================================

console.log('\n--- Test 3: Basic Nesting Tracking - thinking ---');

{
  const parser = new IncrementalXmlParser();

  parser.push('<thinking>');
  assert(parser.isInsideBlock(), 'Should be inside block after opening thinking tag');

  parser.push('Complex reasoning here...');
  assert(parser.isInsideBlock(), 'Should still be inside thinking block');

  parser.push('</thinking>');
  assert(!parser.isInsideBlock(), 'Should not be inside block after closing tag');
}

// ============================================================================
// Test 4: False Positive Detection - User: inside function_results
// ============================================================================

console.log('\n--- Test 4: False Positive Detection - User: inside results ---');

{
  const parser = new IncrementalXmlParser();

  parser.push('<function_results>');
  parser.push('<result tool_use_id="123">');
  parser.push('File contents:\n');
  parser.push('User: Hello world');  // This would trigger "\nUser:" stop sequence

  assert(parser.isInsideBlock(), 'Should detect we are inside a block');
  assert(parser.isInsideFunctionResults(), 'Should detect we are inside function_results');

  // The streaming loop would check this and resume instead of stopping
}

// ============================================================================
// Test 5: False Positive Detection - Multiple stop sequences
// ============================================================================

console.log('\n--- Test 5: False Positive Detection - Multiple scenarios ---');

{
  // Scenario: Stop sequence in tool result content
  const parser1 = new IncrementalXmlParser();
  parser1.push('<function_results><result tool_use_id="1">');
  parser1.push('\nAlice: Said something');
  assert(parser1.isInsideBlock(), 'Alice: inside results should be detected');

  // Scenario: Stop sequence after proper close
  const parser2 = new IncrementalXmlParser();
  parser2.push('<function_results><result tool_use_id="1">Done</result></function_results>');
  parser2.push('\nUser:');
  assert(!parser2.isInsideBlock(), 'User: after closed results should not be inside');
}

// ============================================================================
// Test 6: Nested Blocks
// ============================================================================

console.log('\n--- Test 6: Nested Blocks ---');

{
  const parser = new IncrementalXmlParser();

  // Simulate: response -> tool call -> tool result -> another tool call
  parser.push('Let me help you.\n');
  parser.push('<function_calls>');
  assert(parser.isInsideBlock(), 'Inside first function_calls');

  parser.push('<invoke name="search">');
  parser.push('<parameter name="query">test</parameter>');
  parser.push('</invoke>');
  parser.push('</function_calls>');
  assert(!parser.isInsideBlock(), 'Outside after first function_calls closes');

  parser.push('<function_results>');
  assert(parser.isInsideBlock(), 'Inside function_results');

  parser.push('<result tool_use_id="1">Found 5 results</result>');
  parser.push('</function_results>');
  assert(!parser.isInsideBlock(), 'Outside after function_results closes');

  // Another round
  parser.push('\nLet me search more.\n');
  parser.push('<function_calls>');
  assert(parser.isInsideBlock(), 'Inside second function_calls');

  parser.push('</function_calls>');
  assert(!parser.isInsideBlock(), 'Outside after second function_calls closes');
}

// ============================================================================
// Test 7: antml: Prefix Support
// ============================================================================

console.log('\n--- Test 7: antml: Prefix Support ---');

{
  const parser = new IncrementalXmlParser();

  // Use string concat to avoid XML interpretation
  const openTag = '<' + 'antml:function_calls>';
  const closeTag = '</' + 'antml:function_calls>';

  parser.push(openTag);
  assert(parser.isInsideBlock(), 'Should recognize antml:function_calls');
  assert(parser.isInsideFunctionCalls(), 'Should be inside function_calls with antml prefix');

  parser.push(closeTag);
  assert(!parser.isInsideBlock(), 'Should close with antml prefix');
}

// ============================================================================
// Test 8: Chunked Input (streaming simulation)
// ============================================================================

console.log('\n--- Test 8: Chunked Input (streaming simulation) ---');

{
  const parser = new IncrementalXmlParser();

  // Simulate streaming where tags come in pieces
  parser.push('<func');
  assert(!parser.isInsideBlock(), 'Partial tag should not trigger');

  parser.push('tion_calls>');
  assert(parser.isInsideBlock(), 'Complete tag should trigger');

  parser.push('</function_');
  assert(parser.isInsideBlock(), 'Partial close should not close');

  parser.push('calls>');
  assert(!parser.isInsideBlock(), 'Complete close should close');
}

// ============================================================================
// Test 9: getAccumulated
// ============================================================================

console.log('\n--- Test 9: getAccumulated ---');

{
  const parser = new IncrementalXmlParser();

  parser.push('Hello ');
  parser.push('World');
  parser.push('!');

  assert(parser.getAccumulated() === 'Hello World!', 'Should accumulate all text');

  parser.push('<function_calls>test</function_calls>');
  assert(
    parser.getAccumulated() === 'Hello World!<function_calls>test</function_calls>',
    'Should accumulate including tags'
  );
}

// ============================================================================
// Test 10: getDepths
// ============================================================================

console.log('\n--- Test 10: getDepths ---');

{
  const parser = new IncrementalXmlParser();

  let depths = parser.getDepths();
  assert(depths.functionCalls === 0, 'Initial function_calls depth should be 0');
  assert(depths.functionResults === 0, 'Initial function_results depth should be 0');
  assert(depths.thinking === 0, 'Initial thinking depth should be 0');

  parser.push('<function_calls>');
  depths = parser.getDepths();
  assert(depths.functionCalls === 1, 'function_calls depth should be 1');

  parser.push('<function_results>');
  depths = parser.getDepths();
  assert(depths.functionCalls === 1, 'function_calls depth should still be 1');
  assert(depths.functionResults === 1, 'function_results depth should be 1');

  parser.push('</function_results>');
  depths = parser.getDepths();
  assert(depths.functionResults === 0, 'function_results depth should be 0 after close');
  assert(depths.functionCalls === 1, 'function_calls depth should still be 1');
}

// ============================================================================
// Test 11: getContext
// ============================================================================

console.log('\n--- Test 11: getContext ---');

{
  const parser = new IncrementalXmlParser();

  assert(parser.getContext() === 'none', 'Empty context should return none');

  parser.push('<function_calls>');
  assert(parser.getContext().includes('function_calls'), 'Context should include function_calls');

  parser.push('<function_results>');
  assert(parser.getContext().includes('function_calls'), 'Context should still include function_calls');
  assert(parser.getContext().includes('function_results'), 'Context should include function_results');

  parser.push('</function_results></function_calls>');
  assert(parser.getContext() === 'none', 'Context should be none after all closed');
}

// ============================================================================
// Test 12: reset
// ============================================================================

console.log('\n--- Test 12: reset ---');

{
  const parser = new IncrementalXmlParser();

  parser.push('<function_calls>some content');
  assert(parser.isInsideBlock(), 'Should be inside before reset');
  assert(parser.getAccumulated().length > 0, 'Should have content before reset');

  parser.reset();
  assert(!parser.isInsideBlock(), 'Should not be inside after reset');
  assert(parser.getAccumulated() === '', 'Should have no content after reset');
}

// ============================================================================
// Test 13: hasUnclosedXmlBlock utility
// ============================================================================

console.log('\n--- Test 13: hasUnclosedXmlBlock utility ---');

{
  assert(!hasUnclosedXmlBlock('Hello world'), 'Plain text has no unclosed block');
  assert(hasUnclosedXmlBlock('<function_calls>'), 'Unclosed function_calls');
  assert(!hasUnclosedXmlBlock('<function_calls></function_calls>'), 'Closed function_calls');
  assert(hasUnclosedXmlBlock('<function_results><result>'), 'Unclosed function_results');
  assert(hasUnclosedXmlBlock('<thinking>thoughts'), 'Unclosed thinking');
}

// ============================================================================
// Test 14: Complex realistic scenario
// ============================================================================

console.log('\n--- Test 14: Complex realistic scenario ---');

{
  const parser = new IncrementalXmlParser();

  // Simulate a full conversation turn with tools
  const chunks = [
    'Let me search for that information.\n',
    '<function_calls>\n',
    '<invoke name="web_search">\n',
    '<parameter name="query">weather today</parameter>\n',
    '</invoke>\n',
    '</function_calls>',  // Tool call complete
  ];

  for (const chunk of chunks) {
    parser.push(chunk);
  }
  assert(!parser.isInsideBlock(), 'Should be outside after complete tool call');

  // Now add tool results
  parser.push('<function_results>\n');
  parser.push('<result tool_use_id="tool_1">\n');
  parser.push('Weather: Sunny, 72F\n');
  parser.push('User: What about tomorrow?');  // False positive trigger!

  assert(parser.isInsideBlock(), 'Should detect false positive scenario');
  assert(parser.isInsideFunctionResults(), 'Should be inside function_results');

  // Complete the results
  parser.push('</result>\n');
  parser.push('</function_results>');

  assert(!parser.isInsideBlock(), 'Should be outside after results close');

  // Verify accumulated text
  const accumulated = parser.getAccumulated();
  assert(accumulated.includes('Let me search'), 'Should have preamble');
  assert(accumulated.includes('web_search'), 'Should have tool name');
  assert(accumulated.includes('Weather: Sunny'), 'Should have result');
  assert(accumulated.includes('User: What about'), 'Should have false positive text');
}

// ============================================================================
// Test 15: processChunk - Basic text streaming
// ============================================================================

console.log('\n--- Test 15: processChunk - Basic text streaming ---');

{
  const parser = new IncrementalXmlParser();

  const result = parser.processChunk('Hello world');

  assert(result.content.length > 0, 'Should have content');
  assert(result.blockEvents.length === 1, 'Should have block_start event');
  assert(result.blockEvents[0].event === 'block_start', 'First event should be block_start');

  // Check metadata
  const firstContent = result.content[0];
  assert(firstContent.meta.type === 'text', 'Should be text type');
  assert(firstContent.meta.visible === true, 'Text should be visible');
  assert(firstContent.meta.blockIndex === 0, 'Should be block index 0');
}

// ============================================================================
// Test 16: processChunk - Thinking block
// ============================================================================

console.log('\n--- Test 16: processChunk - Thinking block ---');

{
  const parser = new IncrementalXmlParser();

  // First some text
  let result = parser.processChunk('Hello ');
  assert(result.content.some(c => c.text === 'Hello '), 'Should emit Hello');

  // Opening thinking tag - should NOT be emitted as content
  result = parser.processChunk('<thinking>');
  const hasThinkingTag = result.content.some(c => c.text.includes('<thinking>'));
  assert(!hasThinkingTag, 'Opening tag should NOT be emitted as content');
  assert(result.blockEvents.some(e => e.event === 'block_complete'), 'Should complete text block');
  assert(result.blockEvents.some(e => e.event === 'block_start' && e.block.type === 'thinking'), 'Should start thinking block');

  // Thinking content
  result = parser.processChunk('Let me think...');
  assert(result.content.some(c => c.meta.type === 'thinking'), 'Content should be thinking type');
  assert(result.content.some(c => c.meta.visible === false), 'Thinking should not be visible');

  // Closing thinking tag
  result = parser.processChunk('</thinking>');
  const hasClosingTag = result.content.some(c => c.text.includes('</thinking>'));
  assert(!hasClosingTag, 'Closing tag should NOT be emitted as content');
  assert(result.blockEvents.some(e => e.event === 'block_complete'), 'Should complete thinking block');
}

// ============================================================================
// Test 17: processChunk - Tool call block
// ============================================================================

console.log('\n--- Test 17: processChunk - Tool call block ---');

{
  const parser = new IncrementalXmlParser();

  // Opening function_calls tag
  let result = parser.processChunk('<function_calls>');
  const hasFunctionCallsTag = result.content.some(c => c.text.includes('<function_calls>'));
  assert(!hasFunctionCallsTag, 'function_calls tag should NOT be emitted');
  assert(result.blockEvents.some(e => e.event === 'block_start' && e.block.type === 'tool_call'), 'Should start tool_call block');

  // Content inside (invoke tags etc)
  result = parser.processChunk('<invoke name="search">');
  // invoke tags are structural but inside function_calls

  result = parser.processChunk('</invoke>');
  result = parser.processChunk('</function_calls>');
  assert(result.blockEvents.some(e => e.event === 'block_complete'), 'Should complete tool_call block');
}

// ============================================================================
// Test 18: processChunk - Partial tag buffering
// ============================================================================

console.log('\n--- Test 18: processChunk - Partial tag buffering ---');

{
  const parser = new IncrementalXmlParser();

  // Send partial tag
  let result = parser.processChunk('Hello <th');
  // Should emit Hello, but buffer <th
  assert(result.content.some(c => c.text === 'Hello '), 'Should emit text before partial tag');
  assert(!result.content.some(c => c.text.includes('<th')), 'Should buffer partial tag');

  // Complete the tag
  result = parser.processChunk('inking>');
  // Should NOT emit the tag itself
  assert(!result.content.some(c => c.text.includes('<thinking>')), 'Complete tag should not be emitted');
  assert(result.blockEvents.some(e => e.block.type === 'thinking'), 'Should trigger thinking block');
}

// ============================================================================
// Test 19: processChunk - Non-membrane tag passthrough
// ============================================================================

console.log('\n--- Test 19: processChunk - Non-membrane tag passthrough ---');

{
  const parser = new IncrementalXmlParser();

  // HTML tags should pass through as content
  const result = parser.processChunk('Hello <b>bold</b> world');

  // All text including <b> tags should be emitted
  const fullText = result.content.map(c => c.text).join('');
  assert(fullText.includes('<b>'), 'HTML tag should be emitted');
  assert(fullText.includes('</b>'), 'HTML closing tag should be emitted');
  assert(fullText.includes('bold'), 'Content should be emitted');
}

// ============================================================================
// Test 20: processChunk - flush at end
// ============================================================================

console.log('\n--- Test 20: processChunk - flush at end ---');

{
  const parser = new IncrementalXmlParser();

  // Start some content
  parser.processChunk('Hello world');

  // Flush should complete the block
  const result = parser.flush();
  assert(result.blockEvents.some(e => e.event === 'block_complete'), 'Flush should complete current block');

  // Check the block has content
  const completeEvent = result.blockEvents.find(e => e.event === 'block_complete');
  if (completeEvent && completeEvent.event === 'block_complete') {
    assert(completeEvent.block.content?.includes('Hello'), 'Complete block should have content');
  }
}

// ============================================================================
// Test 21: processChunk - Block indices increment
// ============================================================================

console.log('\n--- Test 21: processChunk - Block indices increment ---');

{
  const parser = new IncrementalXmlParser();

  // Text block
  parser.processChunk('Hello');

  // Thinking block
  parser.processChunk('<thinking>thoughts</thinking>');

  // More text
  const result = parser.processChunk('World');

  // Check blockIndex increments
  assert(result.content.some(c => c.meta.blockIndex >= 2), 'Block index should have incremented');
}

// ============================================================================
// Test 22: getCurrentBlockType
// ============================================================================

console.log('\n--- Test 22: getCurrentBlockType ---');

{
  const parser = new IncrementalXmlParser();

  assert(parser.getCurrentBlockType() === 'text', 'Initial type should be text');

  parser.processChunk('<thinking>');
  assert(parser.getCurrentBlockType() === 'thinking', 'Should be thinking inside thinking tag');

  parser.processChunk('</thinking>');
  assert(parser.getCurrentBlockType() === 'text', 'Should be text after thinking closes');

  parser.processChunk('<function_calls>');
  assert(parser.getCurrentBlockType() === 'tool_call', 'Should be tool_call inside function_calls');

  parser.processChunk('</function_calls>');
  assert(parser.getCurrentBlockType() === 'text', 'Should be text after function_calls closes');

  parser.processChunk('<function_results>');
  assert(parser.getCurrentBlockType() === 'tool_result', 'Should be tool_result inside function_results');
}

// ============================================================================
// Test 23: processChunk - Visibility metadata
// ============================================================================

console.log('\n--- Test 23: processChunk - Visibility metadata ---');

{
  const parser = new IncrementalXmlParser();

  // Text is visible
  let result = parser.processChunk('Visible text');
  assert(result.content.every(c => c.meta.visible === true), 'Text should be visible');

  // Thinking is not visible
  parser.processChunk('<thinking>');
  result = parser.processChunk('Hidden thinking');
  assert(result.content.every(c => c.meta.visible === false), 'Thinking should not be visible');
  parser.processChunk('</thinking>');

  // Tool calls not visible
  parser.processChunk('<function_calls>');
  result = parser.processChunk('Tool content');
  assert(result.content.every(c => c.meta.visible === false), 'Tool call should not be visible');
  parser.processChunk('</function_calls>');

  // Tool results not visible
  parser.processChunk('<function_results>');
  result = parser.processChunk('Result content');
  assert(result.content.every(c => c.meta.visible === false), 'Tool result should not be visible');
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
