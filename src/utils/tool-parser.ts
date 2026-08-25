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
import { isAcceptedImageMediaType, strippedImagePlaceholder } from './image-media.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse a parameter value, handling JSON and large integers safely.
 * Discord snowflake IDs and similar large integers lose precision when
 * parsed as JavaScript numbers, so we keep them as strings.
 */
function parseParamValue(value: string): unknown {
  const trimmed = value.trim();

  // Check if it looks like a large integer (16+ digits, no decimal)
  // JavaScript can only safely represent integers up to 2^53 - 1 (about 9 quadrillion)
  const looksLikeLargeInt = /^\d{16,}$/.test(trimmed);
  if (looksLikeLargeInt) {
    // Keep as string to preserve precision
    return trimmed;
  }

  // Try to parse as JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Parse the parameters of one invoke body. A self-closing invoke has no body
 * and therefore no parameters.
 */
function parseInvokeParameters(invokeBody: string | undefined): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (invokeBody === undefined) return input;

  PARAMETER_REGEX.lastIndex = 0;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = PARAMETER_REGEX.exec(invokeBody)) !== null) {
    input[paramMatch[2] ?? ''] = parseParamValue(paramMatch[3] ?? '');
  }
  return input;
}

// ============================================================================
// Tool Call Parsing
// ============================================================================

// Regex patterns supporting both plain and antml: prefix
// Pattern matches: <function_calls> or <function_calls>
const FUNCTION_CALLS_REGEX = /<(antml:)?function_calls>([\s\S]*?)<\/(antml:)?function_calls>/g;

// Invoke tags, both forms in ONE alternation so a block that mixes them keeps
// document order (two sequential passes appended full-then-self-closing).
// The name may be single- or double-quoted and whitespace may precede the
// closing angle bracket; the quote character is backreferenced so the opposite
// quote stays legal inside the name.
// Groups: 1 = antml prefix, 2 = quote char, 3 = name, 4 = body (full form only).
const INVOKE_REGEX = /<(antml:)?invoke\s+name=(["'])(.*?)\2\s*(?:\/>|>([\s\S]*?)<\/(antml:)?invoke>)/g;

const INVOKE_NAME_GROUP = 3;
const INVOKE_BODY_GROUP = 4;

// Parameter tags
const PARAMETER_REGEX = /<(antml:)?parameter\s+name="([^"]+)">([\s\S]*?)<\/(antml:)?parameter>/g;

const FUNCTION_CALLS_OPEN_REGEX = /<(antml:)?function_calls>/g;

/**
 * One <function_calls> block, resolved to the span its calls may be read from.
 *
 * The block regexes are flat: first opener to first closer, with no nesting
 * check. When a max_tokens truncation leaves an unclosed block in the persisted
 * turn, the next round's closer splices onto that stale opener and the match
 * spans two rounds — so the stale invoke pairs with the NEW round's `</invoke>`
 * and one call is dispatched bearing the stale tool's name and everything
 * between as its argument, including intervening user text.
 *
 * A match whose inner content holds another opener is therefore REJECTED as a
 * block: no dispatch ever crosses an opener. The span is then re-anchored to
 * the innermost (last) opener inside it, which is where the live block actually
 * begins, so the real call still runs and the stale half falls out as ordinary
 * preceding text. Re-anchoring terminates: the re-anchored inner content holds
 * no opener by construction.
 */
interface ResolvedToolBlock {
  start: number;
  end: number;
  innerContent: string;
  fullMatch: string;
  wasSpliced: boolean;
}

function resolveToolBlock(text: string, blockMatch: RegExpExecArray): ResolvedToolBlock {
  const end = blockMatch.index + blockMatch[0].length;
  const innerContent = blockMatch[2] ?? '';
  const innerStart = blockMatch.index + blockMatch[0].indexOf('>') + 1;

  FUNCTION_CALLS_OPEN_REGEX.lastIndex = 0;
  let innermostOpener: RegExpExecArray | null = null;
  let nestedMatch: RegExpExecArray | null;
  while ((nestedMatch = FUNCTION_CALLS_OPEN_REGEX.exec(innerContent)) !== null) {
    innermostOpener = nestedMatch;
  }

  if (!innermostOpener) {
    return {
      start: blockMatch.index,
      end,
      innerContent,
      fullMatch: blockMatch[0],
      wasSpliced: false,
    };
  }

  const reanchoredStart = innerStart + innermostOpener.index;
  return {
    start: reanchoredStart,
    end,
    innerContent: innerContent.slice(innermostOpener.index + innermostOpener[0].length),
    fullMatch: text.slice(reanchoredStart, end),
    wasSpliced: true,
  };
}

// Openers that mark a block as already executed, when one is the very next
// token after it
const FUNCTION_RESULTS_START_ANCHORED = /^<(antml:)?function_results>/;

// Longest opener the anchored test can match, so the slice it reads is bounded
const FUNCTION_RESULTS_OPENER_MAX_LENGTH = '<function_results>'.length + 'antml:'.length;

const SINGLE_WHITESPACE_REGEX = /\s/;

/**
 * Has this block already been executed? True only when the next NON-WHITESPACE
 * token after it is a function_results opener. The previous test — "a
 * function_results opener appears anywhere in the next 100 characters" — was
 * wrong in both directions: padding past 100 characters re-selected a block
 * that had already run, and a results block belonging to some later exchange
 * marked a live call as spent.
 */
function isFollowedByResults(text: string, afterPos: number): boolean {
  let scan = afterPos;
  while (scan < text.length && SINGLE_WHITESPACE_REGEX.test(text[scan]!)) scan++;
  return FUNCTION_RESULTS_START_ANCHORED.test(
    text.slice(scan, scan + FUNCTION_RESULTS_OPENER_MAX_LENGTH)
  );
}

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
  let lastUnexecutedBlock: ResolvedToolBlock | null = null;

  while ((blockMatch = FUNCTION_CALLS_REGEX.exec(text)) !== null) {
    const afterPos = blockMatch.index + blockMatch[0].length;

    if (!isFollowedByResults(text, afterPos)) {
      lastUnexecutedBlock = resolveToolBlock(text, blockMatch);
    }
  }

  if (!lastUnexecutedBlock) {
    return null;
  }

  const { innerContent, fullMatch } = lastUnexecutedBlock;

  const beforeText = text.slice(0, lastUnexecutedBlock.start);
  const afterText = text.slice(lastUnexecutedBlock.end);

  const calls: ToolCall[] = [];

  INVOKE_REGEX.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = INVOKE_REGEX.exec(innerContent)) !== null) {
    calls.push({
      id: generateToolId(),
      name: invokeMatch[INVOKE_NAME_GROUP] ?? '',
      input: parseInvokeParameters(invokeMatch[INVOKE_BODY_GROUP]),
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
 * Structural tags of the XML tool convention. Result content containing any
 * of these must be escaped or it would desync the document/stream parser;
 * everything else rides raw (legacy convention — full escapeXml put `&quot;`
 * entities in front of the model, which Claude-3-era models then reproduce
 * in their own output).
 */
const STRUCTURAL_TAG_RE =
  /<\/?(?:antml:)?(?:function_calls|function_results|invoke|result|stdout|error|tool_name)\b/;

function renderResultContentString(result: ToolResult): string {
  if (typeof result.content === 'string') {
    return result.content;
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      // For XML mode, we can't embed images directly
      // Add a note about the image for the model
      const sizeKb = Math.round((block.source.data.length * 0.75) / 1024);
      parts.push(`[Image: ${block.source.mediaType}, ~${sizeKb}KB]`);
    }
  }
  return parts.join('\n');
}

/**
 * Format tool results as XML for injection — the LEGACY Anthropic tool
 * convention Claude-3-era models were trained on:
 *
 *   <function_results>
 *   <result>
 *   <tool_name>NAME</tool_name>
 *   <stdout>
 *   content
 *   </stdout>
 *   </result>
 *   </function_results>
 *
 * Errors render as <error>…</error> inside <function_results>. No
 * tool_use_id attributes on the wire (a Messages-API concept — the
 * store keeps the linkage on the blocks); content rides raw unless it
 * contains structural tags (then escaped, see STRUCTURAL_TAG_RE).
 */
export function formatToolResults(results: ToolResult[]): string {
  const parts: string[] = ['<function_results>'];

  for (const result of results) {
    if (result.isError) {
      parts.push('<error>');
      parts.push(guardResultContent(renderResultContentString(result)));
      parts.push('</error>');
    } else {
      parts.push('<result>');
      if (result.toolName) {
        parts.push(`<tool_name>${result.toolName}</tool_name>`);
      }
      parts.push('<stdout>');
      parts.push(guardResultContent(renderResultContentString(result)));
      parts.push('</stdout>');
      parts.push('</result>');
    }
  }

  parts.push('</function_results>');
  return parts.join('\n');
}

/** Escape result content only when it would desync the structural parse. */
function guardResultContent(s: string): string {
  return STRUCTURAL_TAG_RE.test(s) ? escapeXml(s) : s;
}

/** Opening XML of one result, up to where its content begins. */
function resultOpenXml(result: ToolResult): string {
  if (result.isError) return '<error>\n';
  let xml = '<result>\n';
  if (result.toolName) xml += `<tool_name>${result.toolName}</tool_name>\n`;
  xml += '<stdout>\n';
  return xml;
}

/** Closing XML of one result, after its content. */
function resultCloseXml(result: ToolResult): string {
  return result.isError ? '\n</error>\n' : '\n</stdout>\n</result>\n';
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

// Legacy Anthropic convention — no ids on the wire; results pair
// positionally with the preceding unmatched tool calls in document order
// (optionally disambiguated by <tool_name>).
const LEGACY_RESULT_REGEX =
  /<result>\s*(?:<tool_name>([\s\S]*?)<\/tool_name>\s*)?<stdout>\n?([\s\S]*?)\n?<\/stdout>\s*<\/result>/g;
const LEGACY_ERROR_REGEX = /<error>\n?([\s\S]*?)\n?<\/error>/g;

/**
 * Parse accumulated assistant text into structured ContentBlock[].
 * Extracts thinking blocks, tool calls, tool results, and plain text.
 *
 * @param text - The accumulated assistant output text
 * @param options - Optional parsing context
 * @param options.startInsideBlock - Block type we're starting inside (from prefill context)
 * @returns Array of ContentBlock in order of appearance
 */
export function parseAccumulatedIntoBlocks(
  text: string,
  options?: { startInsideBlock?: 'thinking' | 'tool_call' | 'tool_result' }
): {
  blocks: ContentBlock[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
} {
  // If we're starting inside a block from prefill, prepend a synthetic opening tag
  // so the regex can match the closing tag properly
  let processedText = text;
  if (options?.startInsideBlock === 'thinking') {
    processedText = '<thinking>' + text;
  } else if (options?.startInsideBlock === 'tool_call') {
    processedText = '<function_calls>' + text;
  } else if (options?.startInsideBlock === 'tool_result') {
    processedText = '<function_results>' + text;
  }
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

  // Call sites in document order, for pairing legacy-shaped results
  // (no tool_use_id on the wire) with the calls they answer.
  const callSites: Array<{ id: string; name: string; pos: number }> = [];
  const pairedCallIds = new Set<string>();
  const claimCall = (beforePos: number, name?: string): string => {
    for (const site of callSites) {
      if (site.pos >= beforePos) break;
      if (pairedCallIds.has(site.id)) continue;
      if (name && site.name !== name) continue;
      pairedCallIds.add(site.id);
      return site.id;
    }
    return generateToolId();
  };

  // Find all thinking blocks
  THINKING_BLOCK_REGEX.lastIndex = 0;
  let thinkingMatch: RegExpExecArray | null;
  while ((thinkingMatch = THINKING_BLOCK_REGEX.exec(processedText)) !== null) {
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
  while ((funcMatch = FUNCTION_BLOCK_WITH_CONTENT_REGEX.exec(processedText)) !== null) {
    // A spliced match (a stale opener joined to a later round's closer) is
    // rejected as a block and re-anchored to its innermost opener; see
    // resolveToolBlock.
    const resolvedBlock = resolveToolBlock(processedText, funcMatch);
    const innerContent = resolvedBlock.innerContent;
    // Verbatim document text of the whole block — carried on each parsed
    // tool_use so prefill replay reproduces the generation exactly instead
    // of synthesizing a paraphrase (membrane#36).
    const rawXml = resolvedBlock.fullMatch;
    const blockToolCalls: ContentBlock[] = [];

    // Parse invoke tags in this block (both forms, in document order)
    INVOKE_REGEX.lastIndex = 0;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = INVOKE_REGEX.exec(innerContent)) !== null) {
      const toolName = invokeMatch[INVOKE_NAME_GROUP] ?? '';
      const input = parseInvokeParameters(invokeMatch[INVOKE_BODY_GROUP]);

      const id = generateToolId();
      const toolCall: ToolCall = { id, name: toolName, input };
      toolCalls.push(toolCall);
      callSites.push({ id, name: toolName, pos: resolvedBlock.start });
      blockToolCalls.push({
        type: 'tool_use',
        id,
        name: toolName,
        input,
        rawXml,
      });
    }

    if (blockToolCalls.length > 0) {
      positions.push({
        start: resolvedBlock.start,
        end: resolvedBlock.end,
        block: blockToolCalls,
      });
    }
  }

  // Find all function_results blocks and parse their results
  FUNCTION_RESULTS_BLOCK_REGEX.lastIndex = 0;
  let resultsMatch: RegExpExecArray | null;
  while ((resultsMatch = FUNCTION_RESULTS_BLOCK_REGEX.exec(processedText)) !== null) {
    const innerContent = resultsMatch[2] ?? '';
    // Verbatim document text the harness placed — carried for exact replay
    // on the prefill path (membrane#36).
    const rawXml = resultsMatch[0];
    const blockResults: ContentBlock[] = [];

    // Parse result tags
    RESULT_REGEX.lastIndex = 0;
    let resultMatch: RegExpExecArray | null;
    while ((resultMatch = RESULT_REGEX.exec(innerContent)) !== null) {
      const toolUseId = resultMatch[1] ?? '';
      const content = unescapeXml(resultMatch[2] ?? '');
      pairedCallIds.add(toolUseId);
      const result: ToolResult = { toolUseId, content, isError: false };
      toolResults.push(result);
      blockResults.push({
        type: 'tool_result',
        toolUseId,
        content,
        isError: false,
        rawXml,
      });
    }

    // Parse error tags
    ERROR_REGEX.lastIndex = 0;
    let errorMatch: RegExpExecArray | null;
    while ((errorMatch = ERROR_REGEX.exec(innerContent)) !== null) {
      const toolUseId = errorMatch[1] ?? '';
      const content = unescapeXml(errorMatch[2] ?? '');
      pairedCallIds.add(toolUseId);
      const result: ToolResult = { toolUseId, content, isError: true };
      toolResults.push(result);
      blockResults.push({
        type: 'tool_result',
        toolUseId,
        content,
        isError: true,
        rawXml,
      });
    }

    // Legacy-shaped results/errors (no ids on the wire): pair positionally
    // with the preceding unclaimed calls, disambiguated by <tool_name>.
    LEGACY_RESULT_REGEX.lastIndex = 0;
    let legacyResultMatch: RegExpExecArray | null;
    while ((legacyResultMatch = LEGACY_RESULT_REGEX.exec(innerContent)) !== null) {
      const toolName = legacyResultMatch[1]?.trim() || undefined;
      const content = unescapeXml(legacyResultMatch[2] ?? '');
      const toolUseId = claimCall(resultsMatch.index, toolName);
      toolResults.push({ toolUseId, toolName, content, isError: false });
      blockResults.push({
        type: 'tool_result',
        toolUseId,
        toolName,
        content,
        isError: false,
        rawXml,
      });
    }
    LEGACY_ERROR_REGEX.lastIndex = 0;
    let legacyErrorMatch: RegExpExecArray | null;
    while ((legacyErrorMatch = LEGACY_ERROR_REGEX.exec(innerContent)) !== null) {
      const content = unescapeXml(legacyErrorMatch[1] ?? '');
      const toolUseId = claimCall(resultsMatch.index);
      toolResults.push({ toolUseId, content, isError: true });
      blockResults.push({
        type: 'tool_result',
        toolUseId,
        content,
        isError: true,
        rawXml,
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
  // Use processedText for slicing since positions are relative to it
  let lastEnd = 0;
  for (const pos of positions) {
    // Add text block for content before this special block
    if (pos.start > lastEnd) {
      const textContent = processedText.slice(lastEnd, pos.start).trim();
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
  // This also handles the case where there are no special blocks at all
  // (lastEnd stays 0, so we slice from 0 to get all text)
  if (lastEnd < processedText.length) {
    const textContent = processedText.slice(lastEnd).trim();
    if (textContent) {
      blocks.push({ type: 'text', text: textContent });
    }
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

    // Check if this result has images
    let resultHasImages = false;
    let textParts: string[] = [];
    let resultImages: ProviderImageBlock[] = [];

    if (typeof result.content === 'string') {
      textParts.push(guardResultContent(result.content));
    } else if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === 'text') {
          textParts.push(guardResultContent(block.text));
        } else if (block.type === 'image') {
          if (!isAcceptedImageMediaType(block.source.mediaType)) {
            textParts.push(strippedImagePlaceholder(block.source.mediaType).text);
          } else {
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
    }

    if (resultHasImages && imageInsertionPoint === -1) {
      // First result with images - split here
      imageInsertionPoint = i;
      images.push(...resultImages);

      // Add opening tags and text content (no closing tags yet)
      beforeImageXml += resultOpenXml(result);
      if (textParts.length > 0) {
        beforeImageXml += textParts.join('\n');
      }
      // Note: Intentionally NOT adding closing tags - split happens here

      // After image, we need to close this result and add remaining results
      afterImageXml = resultCloseXml(result);

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
      beforeImageXml += resultOpenXml(result);
      beforeImageXml += textParts.join('\n');
      beforeImageXml += resultCloseXml(result);
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
  let xml = resultOpenXml(result);

  if (typeof result.content === 'string') {
    xml += guardResultContent(result.content);
  } else if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        xml += guardResultContent(block.text);
      } else if (block.type === 'image') {
        // For remaining results after split, images become text placeholders
        const sizeKb = Math.round((block.source.data.length * 0.75) / 1024);
        xml += `[Image: ${block.source.mediaType}, ~${sizeKb}KB]`;
      }
    }
  }

  xml += resultCloseXml(result);
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
