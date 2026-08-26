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

import type {
  ToolCall,
  ToolResult,
  ParsedToolCalls,
  ContentBlock,
  ToolResultContentBlock,
  ToolDefinition,
  ToolParameter,
} from '../types/index.js';
import { isAcceptedImageMediaType, strippedImagePlaceholder } from './image-media.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parsing context shared by the XML entry points.
 *
 * `tools` carries the declared schemas of the round's tools. When a parameter's
 * type is declared, the value is parsed according to that declaration instead
 * of guessed (see {@link parseParamValue}); without it the legacy guess stands,
 * so callers that cannot supply schemas keep their previous behaviour.
 */
export interface ToolParseOptions {
  tools?: ToolDefinition[];
}

/** JSON-shaped declarations: the value is JSON, not text. */
const JSON_TYPED_PARAMS = new Set(['object', 'array', 'number', 'integer', 'boolean']);

/** 16+ digits, no decimal: beyond Number.MAX_SAFE_INTEGER (Discord snowflakes). */
const LARGE_INT_RE = /^\d{16,}$/;

/** `$ref` spellings resolved against the tool's own inputSchema. */
const REF_PREFIXES = [
  { prefix: '#/definitions/', key: 'definitions' },
  { prefix: '#/$defs/', key: '$defs' },
] as const;

/** Hops of `$ref`/union indirection followed before a form is called unresolved. */
const MAX_SCHEMA_RESOLUTION_DEPTH = 3;

/**
 * Root-level combinator keys, in the order their variants are consulted.
 *
 * The order and the first-wins collision rule below deliberately MIRROR
 * `flattenRootSchemaUnion` (src/providers/anthropic-tool-schema.ts), which
 * merges the same root unions for the Anthropic wire. The parser and XML
 * instruction renderer both consume the collector below, so one order and one
 * collision rule govern all three surfaces.
 */
const ROOT_UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;

type ToolInputSchema = ToolDefinition['inputSchema'];

function refTarget(root: ToolInputSchema, ref: string): ToolParameter | undefined {
  for (const { prefix, key } of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    // Only flat names: a deeper JSON pointer (or one carrying ~0/~1 escapes)
    // is an unresolved form, and says so out loud rather than guessing.
    if (name.length === 0 || name.includes('/') || name.includes('~')) return undefined;
    return root[key]?.[name];
  }
  return undefined;
}

/**
 * Collapse one JSON Schema node to the single type name it declares, or
 * `undefined` when it declares none this parser can name.
 *
 *   - `type: 'string'`               → `'string'`
 *   - `type: ['string','null']`      → `'string'` (exactly one non-null member)
 *   - `anyOf`/`oneOf`                → the one branch that resolves to a
 *                                      non-null type, when every other branch
 *                                      is null-typed
 *   - `$ref: '#/definitions/X'`      → the definition's own resolution
 *
 * Recursion is depth-capped, so a `$ref` cycle terminates as unresolved
 * instead of overflowing the stack.
 */
export function resolveDeclaredType(
  schema: ToolParameter | undefined,
  root: ToolInputSchema,
  depth: number = 0
): string | undefined {
  if (!schema || depth > MAX_SCHEMA_RESOLUTION_DEPTH) return undefined;

  if (typeof schema.type === 'string') return schema.type;

  if (Array.isArray(schema.type)) {
    const nonNullMembers = schema.type.filter(member => member !== 'null');
    return nonNullMembers.length === 1 ? nonNullMembers[0] : undefined;
  }

  // Sibling `anyOf` and `oneOf` must both hold, which this parser does not
  // intersect: unresolved.
  if (schema.anyOf && schema.oneOf) return undefined;
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    let resolved: string | undefined;
    for (const branch of branches) {
      const branchType = resolveDeclaredType(branch, root, depth + 1);
      if (branchType === 'null') continue;
      if (branchType === undefined || resolved !== undefined) return undefined;
      resolved = branchType;
    }
    return resolved;
  }

  if (typeof schema.$ref === 'string') {
    return resolveDeclaredType(refTarget(root, schema.$ref), root, depth + 1);
  }

  return undefined;
}

export function collectDeclaredParameters(
  root: ToolInputSchema
): Record<string, ToolParameter> {
  const declaredParameters = { ...(root.properties ?? {}) };
  for (const key of ROOT_UNION_KEYS) {
    const variants = root[key];
    if (!variants) continue;
    for (const variant of variants) {
      for (const [paramName, schema] of Object.entries(variant.properties ?? {})) {
        if (!(paramName in declaredParameters)) declaredParameters[paramName] = schema;
      }
    }
  }
  return declaredParameters;
}

/** One warn per tool/parameter, so a repeated parse names the bound once. */
const warnedUnresolvedForms = new Set<string>();

function warnUnresolvedSchemaForm(
  toolName: string,
  paramName: string,
  schema: ToolParameter
): void {
  const key = `${toolName}\u0000${paramName}`;
  if (warnedUnresolvedForms.has(key)) return;
  warnedUnresolvedForms.add(key);
  let form: string;
  try {
    form = JSON.stringify(schema);
  } catch {
    // A schema object carrying a cycle of its own (not a `$ref` cycle).
    form = '[unserializable schema]';
  }
  const preview = form.length > 200 ? `${form.slice(0, 200)}…` : form;
  console.warn(
    `[membrane:tool-parser] tool "${toolName}" parameter "${paramName}" declares a schema ` +
      `form this parser cannot resolve to a single type: ${preview}. Legacy text parsing ` +
      'applies to it (value trimmed, then JSON-guessed), so whitespace-sensitive and ' +
      'JSON-looking string arguments may change before reaching the tool.'
  );
}

function declaredParamType(
  tools: ToolDefinition[] | undefined,
  toolName: string,
  paramName: string
): string | undefined {
  if (!tools) return undefined;
  const root = tools.find(t => t.name === toolName)?.inputSchema;
  if (!root) return undefined;
  // An UNDECLARED parameter keeps the legacy guess silently; only a parameter
  // the tool does declare, in a form that will not resolve, is worth a warn.
  const schema = collectDeclaredParameters(root)[paramName];
  if (!schema) return undefined;
  const resolved = resolveDeclaredType(schema, root);
  if (resolved === undefined) warnUnresolvedSchemaForm(toolName, paramName, schema);
  return resolved;
}

function jsonKindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function matchesDeclaredType(value: unknown, declaredType: string): boolean {
  if (declaredType === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return jsonKindOf(value) === declaredType;
}

function warnParamType(
  toolName: string,
  paramName: string,
  declaredType: string,
  detail: string,
  rawValue: string
): void {
  const preview = rawValue.length > 120 ? `${rawValue.slice(0, 120)}…` : rawValue;
  console.warn(
    `[membrane:tool-parser] tool "${toolName}" parameter "${paramName}" declares type ` +
      `"${declaredType}" but ${detail}. Raw value: ${JSON.stringify(preview)}`
  );
}

/**
 * Parse one XML parameter value.
 *
 * The wire bytes are taken as they arrive: this parser transforms no character
 * of a parameter value, so ordinary markup and entity text reach the tool
 * exactly as the model wrote them.
 *
 * What happens next depends on the DECLARED type:
 *   - `string`  → the text, RAW and UNTRIMMED. No JSON.parse, no trim:
 *                 an exact-match edit tool must be able to send leading and
 *                 trailing whitespace, and a string whose text happens to be
 *                 valid JSON must stay a string.
 *   - object/array/number/integer/boolean → JSON.parse, with a loud diagnostic
 *                 when the text does not parse (raw text passed through) or
 *                 parses to a different JSON kind than declared.
 *   - undeclared → the legacy guess: trim, then JSON.parse with the trimmed
 *                 text as fallback. Large integers stay strings so snowflake
 *                 ids keep their precision.
 *
 * "Declared" is decided by {@link resolveDeclaredType}, which reads every
 * spelling of a declaration this parser can collapse to one type name —
 * `type` scalar or array, a null-plus-one union, a `$ref`, and parameters
 * carried inside a root-level union. A declared parameter whose form does not
 * resolve falls to the legacy guess with ONE warn naming the form: the
 * divergence stays, but it stops being silent.
 */
function parseParamValue(
  value: string,
  context?: { toolName: string; paramName: string; tools?: ToolDefinition[] }
): unknown {
  const declaredType = context
    ? declaredParamType(context.tools, context.toolName, context.paramName)
    : undefined;

  if (declaredType === 'string') {
    return value;
  }

  const trimmed = value.trim();

  if (declaredType && JSON_TYPED_PARAMS.has(declaredType)) {
    if ((declaredType === 'number' || declaredType === 'integer') && LARGE_INT_RE.test(trimmed)) {
      return trimmed;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      warnParamType(
        context!.toolName,
        context!.paramName,
        declaredType,
        'the value is not valid JSON; passing the raw text through',
        value
      );
      return value;
    }
    if (!matchesDeclaredType(parsed, declaredType)) {
      warnParamType(
        context!.toolName,
        context!.paramName,
        declaredType,
        `the value parsed as ${jsonKindOf(parsed)}`,
        value
      );
    }
    return parsed;
  }

  // Legacy guess. Large integers (Discord snowflakes and the like) lose
  // precision as JavaScript numbers, so they stay strings.
  if (LARGE_INT_RE.test(trimmed)) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Parse the parameters of one invoke body. A self-closing invoke has no body
 * and therefore no parameters.
 *
 * `toolName` is the name the invoke actually dispatches under — for a
 * re-anchored head, the innermost one — so the schema consulted per parameter
 * is the schema of the tool that will receive it.
 */
function parseInvokeParameters(
  invokeBody: string | undefined,
  toolName: string,
  tools?: ToolDefinition[]
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (invokeBody === undefined) return input;

  PARAMETER_REGEX.lastIndex = 0;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = PARAMETER_REGEX.exec(invokeBody)) !== null) {
    const paramName = paramMatch[2] ?? '';
    input[paramName] = parseParamValue(paramMatch[3] ?? '', { toolName, paramName, tools });
  }
  return input;
}

// ============================================================================
// Tool Call Parsing
// ============================================================================

// Invoke tags, both forms in ONE alternation so a block that mixes them keeps
// document order (two sequential passes appended full-then-self-closing).
// The name may be single- or double-quoted and whitespace may precede the
// closing angle bracket; the quote character is backreferenced so the opposite
// quote stays legal inside the name.
// The name is at least one character and cannot contain its own quote, so a
// nameless invoke and a stray second attribute both fail to match rather than
// yielding a garbage tool name — a block that parses to no invokes is reported.
// Groups: 1 = antml prefix, 2 = quote char, 3 = name, 4 = body (full form only).
const INVOKE_REGEX =
  /<(antml:)?invoke\s+name=(["'])((?:(?!\2).)+)\2\s*(?:\/>|>([\s\S]*?)<\/(antml:)?invoke>)/g;

const INVOKE_NAME_GROUP = 3;
const INVOKE_BODY_GROUP = 4;
const INVOKE_CLOSER_PREFIX_GROUP = 5;

// Same pattern without /g, for the re-anchor read that runs INSIDE the outer
// iteration: sharing the /g instance would clobber its lastIndex. Built from
// the one source so the two can never drift apart.
const INVOKE_REANCHOR_REGEX = new RegExp(INVOKE_REGEX.source);

// An invoke OPENER on its own — the containment test one level below the
// block fix, since an opener that never closed is invisible to INVOKE_REGEX.
const INVOKE_OPEN_REGEX = /<(antml:)?invoke\s+name=/g;

const INVOKE_CLOSE_TAG = '</invoke>';

/**
 * The invokes one block's inner content dispatches, plus the heads it refused.
 *
 * The full-form alternative of INVOKE_REGEX is lazy, so an invoke the model
 * left OPEN pairs with the NEXT invoke's closing tag: the head matched, carried
 * the inner call's parameters as its own, and the inner call never parsed at
 * all — the same block-splice disease one level down. A match whose BODY holds
 * another opener is therefore refused as a dispatchable invoke and re-anchored
 * to the innermost opener inside it, which is where the live call begins. The
 * re-anchored text holds no further opener by construction, so this terminates.
 */
interface ParsedInvokes {
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  unclosedHeads: number;
}

/** Offsets of every invoke opener inside one matched invoke body. */
function invokeOpenerOffsets(invokeBody: string): number[] {
  const offsets: number[] = [];
  INVOKE_OPEN_REGEX.lastIndex = 0;
  let openerMatch: RegExpExecArray | null;
  while ((openerMatch = INVOKE_OPEN_REGEX.exec(invokeBody)) !== null) {
    offsets.push(openerMatch.index);
  }
  return offsets;
}

function collectInvokes(innerContent: string, tools?: ToolDefinition[]): ParsedInvokes {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let unclosedHeads = 0;

  INVOKE_REGEX.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = INVOKE_REGEX.exec(innerContent)) !== null) {
    const invokeBody = invokeMatch[INVOKE_BODY_GROUP];
    const swallowedOpenerOffsets = invokeBody === undefined ? [] : invokeOpenerOffsets(invokeBody);

    if (swallowedOpenerOffsets.length === 0) {
      const name = invokeMatch[INVOKE_NAME_GROUP] ?? '';
      calls.push({ name, input: parseInvokeParameters(invokeBody, name, tools) });
      continue;
    }

    // Every opener in the body is a head that never closed, and so is the
    // matched head itself; only the innermost one owns the closing tag.
    unclosedHeads += swallowedOpenerOffsets.length;

    const fullMatch = invokeMatch[0];
    const closerLength =
      INVOKE_CLOSE_TAG.length + (invokeMatch[INVOKE_CLOSER_PREFIX_GROUP]?.length ?? 0);
    const bodyOffset = fullMatch.length - closerLength - invokeBody!.length;
    const innermostOffset = swallowedOpenerOffsets[swallowedOpenerOffsets.length - 1]!;
    const reanchoredMatch = INVOKE_REANCHOR_REGEX.exec(fullMatch.slice(bodyOffset + innermostOffset));

    // A re-anchored head that still does not parse — a nameless invoke, say —
    // is refused like any other: counted above, dispatched never.
    if (reanchoredMatch) {
      const name = reanchoredMatch[INVOKE_NAME_GROUP] ?? '';
      calls.push({
        name,
        input: parseInvokeParameters(reanchoredMatch[INVOKE_BODY_GROUP], name, tools),
      });
    }
  }

  return { calls, unclosedHeads };
}

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
 *
 * `options.tools` supplies the round's declared schemas; parameter values of a
 * declared type are parsed by that type instead of guessed.
 */
export function parseToolCalls(text: string, options?: ToolParseOptions): ParsedToolCalls | null {
  // Pick the last unexecuted block among those that survive containment: a
  // block quoted inside thinking or echoed in a tool result is content, and
  // dispatching from it runs a call the model never made.
  let lastUnexecutedBlock: ResolvedToolBlock | null = null;

  for (const block of collectLiveToolBlocks(text)) {
    if (!isFollowedByResults(text, block.end)) {
      lastUnexecutedBlock = block;
    }
  }

  if (!lastUnexecutedBlock) {
    return null;
  }

  const { innerContent, fullMatch } = lastUnexecutedBlock;

  const beforeText = text.slice(0, lastUnexecutedBlock.start);
  const afterText = text.slice(lastUnexecutedBlock.end);

  const calls: ToolCall[] = collectInvokes(innerContent, options?.tools).calls.map((invoke) => ({
    id: generateToolId(),
    name: invoke.name,
    input: invoke.input,
  }));

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
    /**
     * The parameter's resolved type name, absent when its schema form does not
     * resolve to one. Absent renders NO type attribute: the model is better
     * served by a parameter with no stated type than by `type="undefined"`.
     */
    type?: string;
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
      const attrs: string[] = [`name="${escapeXml(paramName)}"`];
      if (param.type) attrs.push(`type="${escapeXml(param.type)}"`);
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

/**
 * One span the block sweeps found, before anything about it is registered.
 *
 * The sweeps are independent and their spans overlap: a function_calls block
 * quoted inside a thinking block is found by both. Containment decides which
 * spans are real, and it has to decide FIRST — every side effect downstream
 * (call sites, legacy-result claims, diagnostic counts) is scoped to the
 * survivors.
 */
type CandidateSpan =
  | { kind: 'thinking'; start: number; end: number; thinking: string }
  | { kind: 'calls'; start: number; end: number; resolvedBlock: ResolvedToolBlock }
  | { kind: 'results'; start: number; end: number; innerContent: string; rawXml: string };

/**
 * Keep the outermost spans, in document order. RETAINED SPANS NEVER OVERLAP:
 * a span whose START lies inside one already kept is refused, whether it ends
 * inside that container or crosses out past it.
 *
 * Sorted by start with the outermost first on a tie, a span that begins before
 * the furthest retained end begins INSIDE a container, and everything a
 * container encloses is its content — the model wrote it, it did not call it.
 * Testing only `end` let a crossing span through: a call opening inside a
 * thinking block or a tool result and closing after it was retained alongside
 * its container, so the quoted call dispatched and the overlapping source text
 * was emitted twice — once as thinking content, once as a real tool_use — while
 * the text cursor walked past the inner span, printing the container's own
 * closing tag as visible model text. A dangling closer left downstream by such
 * a refusal is what it looks like: ordinary text.
 *
 * The bound is unchanged: only a CLOSED container is visible here, so the
 * streaming stop-sequence path, where the text is cut at `</function_calls>`
 * before the enclosing `<thinking>` closes, is still outside this rule.
 */
function retainOutermostSpans(spans: CandidateSpan[]): CandidateSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const retained: CandidateSpan[] = [];
  let furthestRetainedEnd = -1;
  for (const span of sorted) {
    if (span.start < furthestRetainedEnd) continue;
    retained.push(span);
    furthestRetainedEnd = span.end;
  }
  return retained;
}

/**
 * The text left once every retained span is cut out — the document's own
 * structural level.
 *
 * Structural diagnostics read this rather than the raw text, because a tool
 * tag QUOTED inside a thinking block or a tool result is content, not
 * structure: counting it made a model that merely described an unclosed block
 * indistinguishable from one whose block was truncated mid-write.
 */
/**
 * Every span the three block sweeps find, unfiltered and unregistered.
 *
 * Both parse entry points read the document through this one census, so the
 * dispatch path and the block path can never disagree about which blocks are
 * real.
 */
function collectCandidateSpans(text: string): CandidateSpan[] {
  const spans: CandidateSpan[] = [];

  THINKING_BLOCK_REGEX.lastIndex = 0;
  let thinkingMatch: RegExpExecArray | null;
  while ((thinkingMatch = THINKING_BLOCK_REGEX.exec(text)) !== null) {
    spans.push({
      kind: 'thinking',
      start: thinkingMatch.index,
      end: thinkingMatch.index + thinkingMatch[0].length,
      thinking: thinkingMatch[2] ?? '',
    });
  }

  FUNCTION_BLOCK_WITH_CONTENT_REGEX.lastIndex = 0;
  let funcMatch: RegExpExecArray | null;
  while ((funcMatch = FUNCTION_BLOCK_WITH_CONTENT_REGEX.exec(text)) !== null) {
    // A spliced match (a stale opener joined to a later round's closer) is
    // rejected as a block and re-anchored to its innermost opener; see
    // resolveToolBlock. Containment reads the RESOLVED span, which is where
    // the live block actually begins.
    const resolvedBlock = resolveToolBlock(text, funcMatch);
    spans.push({
      kind: 'calls',
      start: resolvedBlock.start,
      end: resolvedBlock.end,
      resolvedBlock,
    });
  }

  FUNCTION_RESULTS_BLOCK_REGEX.lastIndex = 0;
  let resultsMatch: RegExpExecArray | null;
  while ((resultsMatch = FUNCTION_RESULTS_BLOCK_REGEX.exec(text)) !== null) {
    spans.push({
      kind: 'results',
      start: resultsMatch.index,
      end: resultsMatch.index + resultsMatch[0].length,
      innerContent: resultsMatch[2] ?? '',
      // Verbatim document text the harness placed — carried for exact replay
      // on the prefill path (membrane#36).
      rawXml: resultsMatch[0],
    });
  }

  return spans;
}

/**
 * The function_calls blocks that are structure rather than content: those that
 * survive containment, in document order.
 *
 * A block quoted inside a <thinking> block or echoed inside a tool result is
 * text the model wrote ABOUT a call, not a call. Selecting from the raw sweep
 * dispatched it — a model that named a tool and explicitly declined to use it
 * had it executed anyway.
 */
function collectLiveToolBlocks(text: string): ResolvedToolBlock[] {
  const live: ResolvedToolBlock[] = [];
  for (const span of retainOutermostSpans(collectCandidateSpans(text))) {
    if (span.kind === 'calls') live.push(span.resolvedBlock);
  }
  return live;
}

function textOutsideSpans(text: string, spans: CandidateSpan[]): string {
  let residue = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) residue += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  return residue + text.slice(cursor);
}

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
 * @param options.tools - Declared tool schemas, used to parse parameter values by declared type
 * @returns Array of ContentBlock in order of appearance
 */
export function parseAccumulatedIntoBlocks(
  text: string,
  options?: ToolParseOptions & { startInsideBlock?: 'thinking' | 'tool_call' | 'tool_result' }
): {
  blocks: ContentBlock[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  /**
   * The text ends inside a tool block — an opener with no closer, or a cut
   * mid-tag. The membrane loop does not resume on a length stop, so this is
   * what a max_tokens truncation leaves behind, and persisting it bare lets the
   * next round's closer splice onto the stale opener.
   */
  unclosedToolBlock: boolean;
  /**
   * function_calls blocks that yielded no invokes at all. Always a defect —
   * never how a well-formed block ends.
   */
  emptyToolBlocks: number;
  /**
   * Block matches that spanned another opener and were re-anchored to the
   * innermost one. Each is a truncated block that was persisted bare and is
   * being repaired at read time.
   */
  splicedToolBlocks: number;
  /**
   * `<invoke>` heads that were left open and swallowed a later invoke, so the
   * match was refused and re-anchored to the call it absorbed. Nothing was
   * dispatched under the head's name, and the head itself never ran.
   */
  unclosedInvokeHeads: number;
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
  let emptyToolBlocks = 0;
  let splicedToolBlocks = 0;
  let unclosedInvokeHeads = 0;

  // Track positions of all special blocks to extract plain text between them
  type BlockPosition = {
    start: number;
    end: number;
    block: ContentBlock | ContentBlock[];
    calls?: ToolCall[];
    results?: ToolResult[];
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

  // ── Pass 1: collect every candidate span, with NO side effects ───────────
  //
  // The three sweeps overlap by construction (a function_calls block quoted
  // inside a thinking block is found by both), so nothing may be registered —
  // no callSites entry, no legacy-result claim, no diagnostic count — until
  // containment has decided which spans are real. Registering first and
  // filtering after produced a call site that a legacy result could claim and
  // that the filter then deleted, leaving a tool_result addressed to a
  // tool_use no longer in the response.
  const candidateSpans = collectCandidateSpans(processedText);

  // ── Pass 2: containment ──────────────────────────────────────────────────
  //
  // Sorted by start, outermost span first on a tie: a span that BEGINS before
  // the furthest retained end begins inside a container, so it is content of
  // that container, not a sibling of it — retained spans never overlap, and a
  // span that crosses out past its container is refused with the rest of the
  // container's content. Zero-invoke and zero-result spans take part as
  // containers even though they contribute no block of their own — whether a
  // span holds anything parseable says nothing about whether it encloses the
  // text beneath it.
  const survivingSpans = retainOutermostSpans(candidateSpans);

  // ── Pass 3: register the survivors, in document order ────────────────────
  //
  // One ordered walk, so every call site preceding a results block is already
  // registered when that block claims — and no filtered span ever was.
  for (const span of survivingSpans) {
    if (span.kind === 'thinking') {
      positions.push({
        start: span.start,
        end: span.end,
        block: { type: 'thinking', thinking: span.thinking },
      });
      continue;
    }

    if (span.kind === 'calls') {
      const resolvedBlock = span.resolvedBlock;
      if (resolvedBlock.wasSpliced) splicedToolBlocks++;
      // Verbatim document text of the whole block — carried on each parsed
      // tool_use so prefill replay reproduces the generation exactly instead
      // of synthesizing a paraphrase (membrane#36).
      const rawXml = resolvedBlock.fullMatch;
      const blockToolCalls: ContentBlock[] = [];
      const blockCalls: ToolCall[] = [];

      // Parse invoke tags in this block (both forms, in document order); an
      // invoke left open is refused and re-anchored to the call it swallowed.
      const parsedInvokes = collectInvokes(resolvedBlock.innerContent, options?.tools);
      unclosedInvokeHeads += parsedInvokes.unclosedHeads;
      for (const invoke of parsedInvokes.calls) {
        const toolName = invoke.name;
        const input = invoke.input;

        const id = generateToolId();
        blockCalls.push({ id, name: toolName, input });
        callSites.push({ id, name: toolName, pos: resolvedBlock.start });
        blockToolCalls.push({
          type: 'tool_use',
          id,
          name: toolName,
          input,
          rawXml,
        });
      }

      if (blockToolCalls.length === 0) {
        emptyToolBlocks++;
      } else {
        positions.push({
          start: resolvedBlock.start,
          end: resolvedBlock.end,
          block: blockToolCalls,
          calls: blockCalls,
        });
      }
      continue;
    }

    const innerContent = span.innerContent;
    const rawXml = span.rawXml;
    const resultsStart = span.start;
    const blockResults: ContentBlock[] = [];
    const blockResultValues: ToolResult[] = [];

    // Parse result tags
    RESULT_REGEX.lastIndex = 0;
    let resultMatch: RegExpExecArray | null;
    while ((resultMatch = RESULT_REGEX.exec(innerContent)) !== null) {
      const toolUseId = resultMatch[1] ?? '';
      const content = unescapeXml(resultMatch[2] ?? '');
      pairedCallIds.add(toolUseId);
      blockResultValues.push({ toolUseId, content, isError: false });
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
      blockResultValues.push({ toolUseId, content, isError: true });
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
      const toolUseId = claimCall(resultsStart, toolName);
      blockResultValues.push({ toolUseId, toolName, content, isError: false });
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
      const toolUseId = claimCall(resultsStart);
      blockResultValues.push({ toolUseId, content, isError: true });
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
        start: span.start,
        end: span.end,
        block: blockResults,
        results: blockResultValues,
      });
    }
  }

  // Survivors are already in document order, so positions are too.
  for (const pos of positions) {
    if (pos.calls) toolCalls.push(...pos.calls);
    if (pos.results) toolResults.push(...pos.results);
  }

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

    lastEnd = Math.max(lastEnd, pos.end);
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

  return {
    blocks,
    toolCalls,
    toolResults,
    unclosedToolBlock: endsWithPartialToolBlock(textOutsideSpans(processedText, survivingSpans)),
    emptyToolBlocks,
    splicedToolBlocks,
    unclosedInvokeHeads,
  };
}

// ============================================================================
// Tool Instructions (for manual placement)
// ============================================================================

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
