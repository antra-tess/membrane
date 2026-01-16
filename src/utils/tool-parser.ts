/**
 * Tool parsing utilities for XML-based tool calls
 *
 * Supports both plain and antml:-prefixed formats:
 *   <function_calls> or <function_calls>
 *   <invoke name="..."> or <invoke name="...">
 *   <parameter name="..."> or <parameter name="...">
 *
 * Also supports self-closing invoke tags:
 *   <invoke name="tool"/> or <invoke name="tool"/>
 */

import type { ToolCall, ToolResult, ParsedToolCalls, ContentBlock, ToolResultContentBlock } from '../types/index.js';

// ============================================================================
// Tool Call Parsing
// ============================================================================

// Regex patterns supporting both plain and antml: prefix
// Pattern matches: <function_calls> or <function_calls>
const FUNCTION_CALLS_REGEX = /<(antml:)?function_calls>([\s\S]*?)<\/(antml:)?function_calls>/g;

// Full invoke tags with content
const INVOKE_REGEX_FULL = /<(antml:)?invoke\s+name="([^"]+)">([\s\S]*?)<\/(antml:)?invoke>/g;

// Self-closing invoke tags (no parameters)
const INVOKE_REGEX_SELF_CLOSE = /<(antml:)?invoke\s+name="([^"]+)"\s*\/>/g;

// Parameter tags
const PARAMETER_REGEX = /<(antml:)?parameter\s+name="([^"]+)">([\s\S]*?)<\/(antml:)?parameter>/g;

// Check for function_results following a block
const FUNCTION_RESULTS_START = /<(antml:)?function_results>/;

/**
 * Parse tool calls from text containing XML function_calls blocks
 *
 * Uses "last-unexecuted-block" logic: finds the last function_calls block
 * that doesn't have function_results immediately following it.
 */
export function parseToolCalls(text: string): ParsedToolCalls | null {
  // Reset regex
  FUNCTION_CALLS_REGEX.lastIndex = 0;

  // Find all function_calls blocks and pick the last unexecuted one
  let blockMatch: RegExpExecArray | null = null;
  let lastUnexecutedMatch: RegExpExecArray | null = null;

  while ((blockMatch = FUNCTION_CALLS_REGEX.exec(text)) !== null) {
    // Check if this block already has results after it
    const afterPos = blockMatch.index + blockMatch[0].length;
    const textAfter = text.slice(afterPos, afterPos + 100); // Check next 100 chars

    if (!FUNCTION_RESULTS_START.test(textAfter.trimStart())) {
      // This block hasn't been executed yet - store it
      // Need to capture all properties since exec returns are reused
      lastUnexecutedMatch = {
        ...blockMatch,
        index: blockMatch.index,
        input: blockMatch.input,
      } as RegExpExecArray;
    }
  }

  if (!lastUnexecutedMatch) {
    return null;
  }

  const fullMatch = lastUnexecutedMatch[0];
  const innerContent = lastUnexecutedMatch[2] ?? ''; // Group 2 is content between tags
  const matchIndex = lastUnexecutedMatch.index;

  const beforeText = text.slice(0, matchIndex);
  const afterText = text.slice(matchIndex + fullMatch.length);

  const calls: ToolCall[] = [];

  // Parse full invoke tags (with content and closing tag)
  INVOKE_REGEX_FULL.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = INVOKE_REGEX_FULL.exec(innerContent)) !== null) {
    const toolName = invokeMatch[2] ?? ''; // Group 2 is the name
    const invokeContent = invokeMatch[3] ?? ''; // Group 3 is the content

    // Parse parameters
    const input: Record<string, unknown> = {};
    PARAMETER_REGEX.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = PARAMETER_REGEX.exec(invokeContent)) !== null) {
      const paramName = paramMatch[2] ?? ''; // Group 2 is the name
      const paramValue = paramMatch[3] ?? ''; // Group 3 is the value

      // Try to parse as JSON, fall back to string
      try {
        input[paramName] = JSON.parse(paramValue);
      } catch {
        input[paramName] = paramValue.trim();
      }
    }

    calls.push({
      id: generateToolId(),
      name: toolName,
      input,
    });
  }

  // Parse self-closing invoke tags (no parameters)
  INVOKE_REGEX_SELF_CLOSE.lastIndex = 0;
  let selfCloseMatch: RegExpExecArray | null;

  while ((selfCloseMatch = INVOKE_REGEX_SELF_CLOSE.exec(innerContent)) !== null) {
    const toolName = selfCloseMatch[2] ?? ''; // Group 2 is the name

    calls.push({
      id: generateToolId(),
      name: toolName,
      input: {}, // No parameters for self-closing tag
    });
  }

  return {
    calls,
    beforeText,
    afterText,
    fullMatch,
  };
}

/**
 * Check if text contains an unclosed function_calls block
 * Used for false-positive stop sequence detection
 * Supports both plain and antml: prefixed tags
 */
export function hasUnclosedToolBlock(text: string): boolean {
  // Use regex that matches both plain and antml: prefixed tags
  const openPattern = /<(antml:)?function_calls>/g;
  const closePattern = /<\/(antml:)?function_calls>/g;

  const openCount = (text.match(openPattern) || []).length;
  const closeCount = (text.match(closePattern) || []).length;
  return openCount > closeCount;
}

/**
 * Check if text ends with a partial/unclosed tool block
 * Supports both plain and antml: prefixed tags
 */
export function endsWithPartialToolBlock(text: string): boolean {
  // Check for partial opening tag (plain or antml:)
  if (/<(antml:)?function_calls[^>]*$/.test(text)) return true;
  if (/<(antml:)?invoke[^>]*$/.test(text)) return true;
  if (/<(antml:)?parameter[^>]*$/.test(text)) return true;

  // Check for unclosed block
  return hasUnclosedToolBlock(text);
}

// ============================================================================
// Tool Result Formatting
// ============================================================================

/**
 * Format tool results as XML for injection.
 * Handles both string content and structured content blocks (with images).
 */
export function formatToolResults(results: ToolResult[]): string {
  const parts: string[] = ['<function_results>'];

  for (const result of results) {
    const tagName = result.isError ? 'error' : 'result';
    parts.push(`<${tagName} tool_use_id="${result.toolUseId}">`);

    // Handle both string and array content
    if (typeof result.content === 'string') {
      parts.push(escapeXml(result.content));
    } else if (Array.isArray(result.content)) {
      // Structured content blocks
      for (const block of result.content) {
        if (block.type === 'text') {
          parts.push(escapeXml(block.text));
        } else if (block.type === 'image') {
          // For XML mode, we can't embed images directly
          // Add a note about the image for the model
          const sizeKb = Math.round((block.source.data.length * 0.75) / 1024);
          parts.push(`[Image: ${block.source.mediaType}, ~${sizeKb}KB]`);
        }
      }
    }

    parts.push(`</${tagName}>`);
  }

  parts.push('</function_results>');
  return parts.join('\n');
}

/**
 * Format a single tool result
 */
export function formatToolResult(result: ToolResult): string {
  return formatToolResults([result]);
}

// ============================================================================
// Tool Definition Formatting (for system prompt injection)
// ============================================================================

export interface ToolDefinitionForPrompt {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description?: string;
    required?: boolean;
    enum?: string[];
  }>;
}

/**
 * Format tool definitions as XML for system prompt
 */
export function formatToolDefinitions(tools: ToolDefinitionForPrompt[]): string {
  const parts: string[] = ['<tools>'];
  
  for (const tool of tools) {
    parts.push(`<tool name="${escapeXml(tool.name)}">`);
    parts.push(`<description>${escapeXml(tool.description)}</description>`);
    parts.push('<parameters>');
    
    for (const [paramName, param] of Object.entries(tool.parameters)) {
      const attrs: string[] = [`name="${escapeXml(paramName)}"`, `type="${param.type}"`];
      if (param.required) attrs.push('required="true"');
      if (param.enum) attrs.push(`enum="${param.enum.join(',')}"`);
      
      parts.push(`<parameter ${attrs.join(' ')}>`);
      if (param.description) {
        parts.push(escapeXml(param.description));
      }
      parts.push('</parameter>');
    }
    
    parts.push('</parameters>');
    parts.push('</tool>');
  }
  
  parts.push('</tools>');
  return parts.join('\n');
}

// ============================================================================
// Accumulated Text to ContentBlock[] Parsing
// ============================================================================

// Regex for matching thinking blocks (both plain and antml: prefixed)
const THINKING_BLOCK_REGEX = /<(antml:)?thinking>([\s\S]*?)<\/(antml:)?thinking>/g;

// Regex for matching function_calls blocks with their content
const FUNCTION_BLOCK_WITH_CONTENT_REGEX = /<(antml:)?function_calls>([\s\S]*?)<\/(antml:)?function_calls>/g;

// Regex for matching function_results blocks with their content
const FUNCTION_RESULTS_BLOCK_REGEX = /<(antml:)?function_results>([\s\S]*?)<\/(antml:)?function_results>/g;

// Regex for individual result/error within function_results
const RESULT_REGEX = /<result\s+tool_use_id="([^"]+)">([\s\S]*?)<\/result>/g;
const ERROR_REGEX = /<error\s+tool_use_id="([^"]+)">([\s\S]*?)<\/error>/g;

/**
 * Parse accumulated assistant text into structured ContentBlock[].
 * Extracts thinking blocks, tool calls, tool results, and plain text.
 *
 * @param text - The accumulated assistant output text
 * @returns Array of ContentBlock in order of appearance
 */
export function parseAccumulatedIntoBlocks(text: string): {
  blocks: ContentBlock[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
} {
  const blocks: ContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];

  // Track positions of all special blocks to extract plain text between them
  type BlockPosition = {
    start: number;
    end: number;
    block: ContentBlock | ContentBlock[];
  };
  const positions: BlockPosition[] = [];

  // Find all thinking blocks
  THINKING_BLOCK_REGEX.lastIndex = 0;
  let thinkingMatch: RegExpExecArray | null;
  while ((thinkingMatch = THINKING_BLOCK_REGEX.exec(text)) !== null) {
    positions.push({
      start: thinkingMatch.index,
      end: thinkingMatch.index + thinkingMatch[0].length,
      block: {
        type: 'thinking',
        thinking: thinkingMatch[2] ?? '',
      },
    });
  }

  // Find all function_calls blocks and parse their tool calls
  FUNCTION_BLOCK_WITH_CONTENT_REGEX.lastIndex = 0;
  let funcMatch: RegExpExecArray | null;
  while ((funcMatch = FUNCTION_BLOCK_WITH_CONTENT_REGEX.exec(text)) !== null) {
    const innerContent = funcMatch[2] ?? '';
    const blockToolCalls: ContentBlock[] = [];

    // Parse invoke tags in this block
    INVOKE_REGEX_FULL.lastIndex = 0;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = INVOKE_REGEX_FULL.exec(innerContent)) !== null) {
      const toolName = invokeMatch[2] ?? '';
      const invokeContent = invokeMatch[3] ?? '';
      const input: Record<string, unknown> = {};

      // Parse parameters
      PARAMETER_REGEX.lastIndex = 0;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = PARAMETER_REGEX.exec(invokeContent)) !== null) {
        const paramName = paramMatch[2] ?? '';
        const paramValue = paramMatch[3] ?? '';
        try {
          input[paramName] = JSON.parse(paramValue);
        } catch {
          input[paramName] = paramValue.trim();
        }
      }

      const id = generateToolId();
      const toolCall: ToolCall = { id, name: toolName, input };
      toolCalls.push(toolCall);
      blockToolCalls.push({
        type: 'tool_use',
        id,
        name: toolName,
        input,
      });
    }

    // Parse self-closing invoke tags
    INVOKE_REGEX_SELF_CLOSE.lastIndex = 0;
    let selfCloseMatch: RegExpExecArray | null;
    while ((selfCloseMatch = INVOKE_REGEX_SELF_CLOSE.exec(innerContent)) !== null) {
      const toolName = selfCloseMatch[2] ?? '';
      const id = generateToolId();
      const toolCall: ToolCall = { id, name: toolName, input: {} };
      toolCalls.push(toolCall);
      blockToolCalls.push({
        type: 'tool_use',
        id,
        name: toolName,
        input: {},
      });
    }

    if (blockToolCalls.length > 0) {
      positions.push({
        start: funcMatch.index,
        end: funcMatch.index + funcMatch[0].length,
        block: blockToolCalls,
      });
    }
  }

  // Find all function_results blocks and parse their results
  FUNCTION_RESULTS_BLOCK_REGEX.lastIndex = 0;
  let resultsMatch: RegExpExecArray | null;
  while ((resultsMatch = FUNCTION_RESULTS_BLOCK_REGEX.exec(text)) !== null) {
    const innerContent = resultsMatch[2] ?? '';
    const blockResults: ContentBlock[] = [];

    // Parse result tags
    RESULT_REGEX.lastIndex = 0;
    let resultMatch: RegExpExecArray | null;
    while ((resultMatch = RESULT_REGEX.exec(innerContent)) !== null) {
      const toolUseId = resultMatch[1] ?? '';
      const content = unescapeXml(resultMatch[2] ?? '');
      const result: ToolResult = { toolUseId, content, isError: false };
      toolResults.push(result);
      blockResults.push({
        type: 'tool_result',
        toolUseId,
        content,
        isError: false,
      });
    }

    // Parse error tags
    ERROR_REGEX.lastIndex = 0;
    let errorMatch: RegExpExecArray | null;
    while ((errorMatch = ERROR_REGEX.exec(innerContent)) !== null) {
      const toolUseId = errorMatch[1] ?? '';
      const content = unescapeXml(errorMatch[2] ?? '');
      const result: ToolResult = { toolUseId, content, isError: true };
      toolResults.push(result);
      blockResults.push({
        type: 'tool_result',
        toolUseId,
        content,
        isError: true,
      });
    }

    if (blockResults.length > 0) {
      positions.push({
        start: resultsMatch.index,
        end: resultsMatch.index + resultsMatch[0].length,
        block: blockResults,
      });
    }
  }

  // Sort positions by start index
  positions.sort((a, b) => a.start - b.start);

  // Build final blocks array, inserting text blocks between special blocks
  let lastEnd = 0;
  for (const pos of positions) {
    // Add text block for content before this special block
    if (pos.start > lastEnd) {
      const textContent = text.slice(lastEnd, pos.start).trim();
      if (textContent) {
        blocks.push({ type: 'text', text: textContent });
      }
    }

    // Add the special block(s)
    if (Array.isArray(pos.block)) {
      blocks.push(...pos.block);
    } else {
      blocks.push(pos.block);
    }

    lastEnd = pos.end;
  }

  // Add any remaining text after the last special block
  if (lastEnd < text.length) {
    const textContent = text.slice(lastEnd).trim();
    if (textContent) {
      blocks.push({ type: 'text', text: textContent });
    }
  }

  // Handle case where there are no special blocks at all
  if (positions.length === 0 && text.trim()) {
    blocks.push({ type: 'text', text: text.trim() });
  }

  return { blocks, toolCalls, toolResults };
}

// ============================================================================
// Tool Instructions (for manual placement)
// ============================================================================

import type { ToolDefinition } from '../types/index.js';

// Assembled to avoid triggering stop sequences in model output
const FUNC_CALLS_OPEN = '<' + 'function_calls>';
const FUNC_CALLS_CLOSE = '</' + 'function_calls>';
const INVOKE_OPEN = '<' + 'invoke name="';
const INVOKE_CLOSE = '</' + 'invoke>';
const PARAM_OPEN = '<' + 'parameter name="';
const PARAM_CLOSE = '</' + 'parameter>';

/**
 * Get tool instructions string for manual placement.
 * Use this when you want to control where tool instructions appear
 * (e.g., injected into conversation rather than system prompt).
 * 
 * @param tools - Tool definitions
 * @returns Complete instruction string with definitions and usage example
 */
export function getToolInstructions(tools: ToolDefinition[]): string {
  // Format definitions
  const definitions = tools.map((tool) => {
    const toolDef = {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
    };
    return `<function>${JSON.stringify(toolDef)}</function>`;
  });

  // Build instruction with example
  return `<functions>
${definitions.join('\n')}
</functions>

When making function calls using tools that accept array or object parameters ensure those are structured using JSON. For example:
${FUNC_CALLS_OPEN}
${INVOKE_OPEN}example_tool">
${PARAM_OPEN}parameter">[{"key": "value"}]${PARAM_CLOSE}
${INVOKE_CLOSE}
${FUNC_CALLS_CLOSE}`;
}

// ============================================================================
// Image Handling in Tool Results
// ============================================================================

/**
 * Provider image block format (Anthropic-style)
 */
export interface ProviderImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * Check if any tool result contains image content
 */
export function hasImageInToolResults(results: ToolResult[]): boolean {
  for (const result of results) {
    if (Array.isArray(result.content)) {
      if (result.content.some(block => block.type === 'image')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Result of separating tool result content for split-turn injection.
 *
 * When tool results contain images in prefill mode, we need to:
 * 1. Put text content in the assistant turn (as XML)
 * 2. Extract images into a separate user turn
 * 3. Continue assistant turn with closing XML
 */
export interface SplitTurnContent {
  /** XML up to and including text content, ending mid-result if images present */
  beforeImageXml: string;

  /** Images extracted from results (in provider format) */
  images: ProviderImageBlock[];

  /** Closing XML after images (closing result tags, function_results) */
  afterImageXml: string;

  /** Whether any images were found */
  hasImages: boolean;
}

/**
 * Format tool results for split-turn injection when images are present.
 *
 * This separates the XML into parts that go in the assistant turn (text)
 * and the user turn (images), with continuation XML for the next assistant turn.
 *
 * Structure when images present:
 * ```
 * Assistant: <function_results>
 *              <result tool_use_id="...">
 *                text content here
 *            [END - mid XML]
 *
 * User: [image blocks]
 *
 * Assistant (prefill): </result>
 *            </function_results>
 * ```
 */
export function formatToolResultsForSplitTurn(results: ToolResult[]): SplitTurnContent {
  const images: ProviderImageBlock[] = [];
  let beforeImageXml = '<function_results>\n';
  let afterImageXml = '';
  let imageInsertionPoint = -1; // Index of result where we found images

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const tagName = result.isError ? 'error' : 'result';

    // Check if this result has images
    let resultHasImages = false;
    let textParts: string[] = [];
    let resultImages: ProviderImageBlock[] = [];

    if (typeof result.content === 'string') {
      textParts.push(escapeXml(result.content));
    } else if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text') {
          textParts.push(escapeXml(block.text));
        } else if (block.type === 'image') {
          resultHasImages = true;
          resultImages.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.mediaType,
              data: block.source.data,
            },
          });
        }
      }
    }

    if (resultHasImages && imageInsertionPoint === -1) {
      // First result with images - split here
      imageInsertionPoint = i;
      images.push(...resultImages);

      // Add opening tag and text content (no closing tag yet)
      beforeImageXml += `<${tagName} tool_use_id="${result.toolUseId}">\n`;
      if (textParts.length > 0) {
        beforeImageXml += textParts.join('\n');
      }
      // Note: Intentionally NOT adding closing tag - split happens here

      // After image, we need to close this result and add remaining results
      afterImageXml = `</${tagName}>\n`;

      // Process remaining results into afterImageXml
      for (let j = i + 1; j < results.length; j++) {
        const remainingResult = results[j]!;
        afterImageXml += formatSingleResultXml(remainingResult);
      }
      afterImageXml += '</function_results>';

      // Stop processing - we've handled everything
      break;
    } else if (imageInsertionPoint === -1) {
      // No images yet - add full result to beforeImageXml
      beforeImageXml += `<${tagName} tool_use_id="${result.toolUseId}">\n`;
      beforeImageXml += textParts.join('\n');
      beforeImageXml += `\n</${tagName}>\n`;
    }
  }

  // If no images were found, complete the XML normally
  if (imageInsertionPoint === -1) {
    beforeImageXml += '</function_results>';
    return {
      beforeImageXml,
      images: [],
      afterImageXml: '',
      hasImages: false,
    };
  }

  return {
    beforeImageXml,
    images,
    afterImageXml,
    hasImages: true,
  };
}

/**
 * Format a single tool result as complete XML
 */
function formatSingleResultXml(result: ToolResult): string {
  const tagName = result.isError ? 'error' : 'result';
  let xml = `<${tagName} tool_use_id="${result.toolUseId}">\n`;

  if (typeof result.content === 'string') {
    xml += escapeXml(result.content);
  } else if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        xml += escapeXml(block.text);
      } else if (block.type === 'image') {
        // For remaining results after split, images become text placeholders
        const sizeKb = Math.round((block.source.data.length * 0.75) / 1024);
        xml += `[Image: ${block.source.mediaType}, ~${sizeKb}KB]`;
      }
    }
  }

  xml += `\n</${tagName}>\n`;
  return xml;
}

// ============================================================================
// Utilities
// ============================================================================

let toolIdCounter = 0;

function generateToolId(): string {
  toolIdCounter++;
  return `tool_${Date.now()}_${toolIdCounter}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}
