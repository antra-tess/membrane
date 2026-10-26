import type {
  ToolCall,
  ToolResult,
  ParsedToolCalls,
  ContentBlock,
  ToolResultContent,
  ToolResultContentBlock,
  ToolDefinition,
} from '../types/index.js';
import { createHash } from 'node:crypto';
import { dataUrlImage, imageForRequest, isAcceptedImage, linkImageNote, type RasterImageMediaType } from './image-media.js';
import { readToolSchema, type ParameterDeclaration, type ToolSchemaReading } from './tool-schema.js';

/**
 * Parsing context shared by the XML entry points.
 *
 * `tools` carries the declared schemas of the round's tools. When a parameter's
 * type is declared, the value is parsed according to that declaration instead
 * of guessed; without it the legacy guess stands.
 */
export interface ToolParseOptions {
  tools?: ToolDefinition[];
}

/** 16 digits or more, no decimal: the first length that can pass Number.MAX_SAFE_INTEGER, as Discord snowflakes do. */
const LARGE_INT_RE = /^\d{16,}$/;

interface InvokeSchema {
  toolName: string;
  inputSchema: unknown;
  reading: ToolSchemaReading;
}

function invokeSchemaFor(
  tools: ToolDefinition[] | undefined,
  toolName: string
): InvokeSchema | undefined {
  if (!Array.isArray(tools)) return undefined;
  const tool = tools.find(candidate => candidate?.name === toolName);
  if (!tool) return undefined;
  const reading = readToolSchema(tool.inputSchema);
  if (reading.failure !== undefined) {
    warnOnce(['failure', toolName, reading.failure], () =>
      `[membrane:tool-parser] tool "${toolName}": its input schema could not be read ` +
        `(${reading.failure}), so every parameter of it gets legacy text parsing ` +
        '(value trimmed, then JSON-guessed).'
    );
    return undefined;
  }
  return { toolName, inputSchema: tool.inputSchema, reading };
}

const reportedSubjects = new Set<string>();
const MAX_REPORTED_SUBJECTS = 1024;

function stringifyForDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value) ?? `[${typeof value}]`;
  } catch {
    return '[unserializable schema]';
  }
}

function warnOnce(subject: readonly string[], message: () => string): void {
  const key = createHash('sha256').update(subject.join('\u0000')).digest('base64');
  if (reportedSubjects.has(key)) return;
  if (reportedSubjects.size >= MAX_REPORTED_SUBJECTS) reportedSubjects.clear();
  reportedSubjects.add(key);
  console.warn(message());
}

function previewOf(form: string): string {
  return form.length > 200 ? `${form.slice(0, 200)}…` : form;
}

function warnUnresolvedDeclaration(
  toolName: string,
  paramName: string,
  declaration: ParameterDeclaration
): void {
  const form = stringifyForDiagnostic(
    declaration.declaredBy.length === 1 ? declaration.declaredBy[0] : declaration.declaredBy
  );
  const spelled =
    declaration.declaredBy.length === 1
      ? `declares ${previewOf(form)}`
      : `is declared by ${declaration.declaredBy.length} schema nodes, ${previewOf(form)}`;
  warnOnce(['unresolved', toolName, paramName, form], () =>
    `[membrane:tool-parser] tool "${toolName}" parameter "${paramName}" ${spelled}, which ` +
      'this parser cannot read as a single JSON type. Legacy text parsing applies to it ' +
      '(value trimmed, then JSON-guessed), so whitespace-sensitive and JSON-looking string ' +
      'arguments may change before reaching the tool.'
  );
}

function warnUnreadRootUnion(schema: InvokeSchema, paramName: string): void {
  const combinators = schema.reading.unreadRootUnion.join('/');
  warnOnce(
    ['unread-root-union', schema.toolName, paramName, stringifyForDiagnostic(schema.inputSchema)],
    () =>
      `[membrane:tool-parser] tool "${schema.toolName}" parameter "${paramName}" is not among ` +
        `the parameters read from its schema: the root ${combinators} has a variant that is ` +
        'not an object schema, so no variant is read as parameters (the Anthropic native ' +
        'wire falls back the same way). Legacy text parsing applies to it (value trimmed, ' +
        'then JSON-guessed).'
  );
}

function warnParamType(
  toolName: string,
  paramName: string,
  declaredType: string,
  detail: string
): void {
  console.warn(
    `[membrane:tool-parser] tool "${toolName}" parameter "${paramName}" declares type ` +
      `"${declaredType}" but ${detail} (the value itself is not logged: tool arguments ` +
      'can carry secrets).'
  );
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

/**
 * Unsigned integers of 16 digits or more (Discord snowflakes and the like)
 * can lose precision as JavaScript numbers, so they stay strings.
 */
function guessParamValue(value: string): unknown {
  const trimmed = value.trim();
  if (LARGE_INT_RE.test(trimmed)) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function withoutFraming(value: string): string {
  const start = value.startsWith('\n') ? 1 : 0;
  const end = value.length > start && value.endsWith('\n') ? value.length - 1 : value.length;
  return value.slice(start, end);
}

function parseParamValue(
  value: string,
  paramName: string,
  schema: InvokeSchema | undefined
): unknown {
  if (schema === undefined) return guessParamValue(value);

  const declaration = schema.reading.parameters.get(paramName);
  if (declaration === undefined) {
    if (schema.reading.unreadRootUnion.length > 0) warnUnreadRootUnion(schema, paramName);
    return guessParamValue(value);
  }
  if (declaration.status === 'untyped') return guessParamValue(value);
  if (declaration.status === 'unresolved' || declaration.type === undefined) {
    warnUnresolvedDeclaration(schema.toolName, paramName, declaration);
    return guessParamValue(value);
  }

  const declaredType = declaration.type;
  const trimmed = value.trim();

  if (declaration.nullable && trimmed === 'null') {
    return null;
  }

  if (declaredType === 'string') {
    return withoutFraming(value);
  }

  if (LARGE_INT_RE.test(trimmed)) {
    // JSON.parse rounds digits past Number.MAX_SAFE_INTEGER, so they stay text.
    if (declaredType !== 'number' && declaredType !== 'integer') {
      warnParamType(
        schema.toolName,
        paramName,
        declaredType,
        'the value is an integer too large to represent exactly; passing its digits through as text'
      );
    }
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    warnParamType(
      schema.toolName,
      paramName,
      declaredType,
      'the value is not valid JSON; passing the raw text through'
    );
    return value;
  }
  if (!matchesDeclaredType(parsed, declaredType)) {
    warnParamType(schema.toolName, paramName, declaredType, `the value parsed as ${jsonKindOf(parsed)}`);
  }
  return parsed;
}

function parseInvokeParameters(
  invokeBody: string | undefined,
  toolName: string,
  tools?: ToolDefinition[]
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (invokeBody === undefined) return input;

  const schema = invokeSchemaFor(tools, toolName);
  PARAMETER_REGEX.lastIndex = 0;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = PARAMETER_REGEX.exec(invokeBody)) !== null) {
    const paramName = paramMatch[2] ?? '';
    input[paramName] = parseParamValue(paramMatch[3] ?? '', paramName, schema);
  }
  return input;
}

const INVOKE_REGEX =
  /<(antml:)?invoke\s+name=(["'])((?:(?!\2).)+)\2\s*(?:\/>|>([\s\S]*?)<\/(antml:)?invoke>)/g;

const INVOKE_NAME_GROUP = 3;
const INVOKE_BODY_GROUP = 4;
const INVOKE_CLOSER_PREFIX_GROUP = 5;

// Without /g: a /g regex's exec moves its lastIndex, and this read runs inside
// the outer one's iteration.
const INVOKE_REANCHOR_REGEX = new RegExp(INVOKE_REGEX.source);

const INVOKE_OPEN_REGEX = /<(antml:)?invoke\s+name=/g;

const INVOKE_CLOSE_TAG = '</invoke>';

interface ParsedInvokes {
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  unclosedHeads: number;
}

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

    unclosedHeads += swallowedOpenerOffsets.length;

    const fullMatch = invokeMatch[0];
    const closerLength =
      INVOKE_CLOSE_TAG.length + (invokeMatch[INVOKE_CLOSER_PREFIX_GROUP]?.length ?? 0);
    const bodyOffset = fullMatch.length - closerLength - invokeBody!.length;
    const innermostOffset = swallowedOpenerOffsets[swallowedOpenerOffsets.length - 1]!;
    const reanchoredMatch = INVOKE_REANCHOR_REGEX.exec(fullMatch.slice(bodyOffset + innermostOffset));

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

const PARAMETER_REGEX = /<(antml:)?parameter\s+name="([^"]+)">([\s\S]*?)<\/(antml:)?parameter>/g;

const FUNCTION_CALLS_OPEN_REGEX = /<(antml:)?function_calls>/g;

/**
 * A max_tokens truncation can leave an unclosed <function_calls> block in a
 * stored turn, whose stale opener the next round's closer would then match.
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

const FUNCTION_RESULTS_START_ANCHORED = /^<(antml:)?function_results>/;

const FUNCTION_RESULTS_OPENER_MAX_LENGTH = '<function_results>'.length + 'antml:'.length;

const SINGLE_WHITESPACE_REGEX = /\s/;

function isFollowedByResults(text: string, afterPos: number): boolean {
  let scan = afterPos;
  while (scan < text.length && SINGLE_WHITESPACE_REGEX.test(text[scan]!)) scan++;
  return FUNCTION_RESULTS_START_ANCHORED.test(
    text.slice(scan, scan + FUNCTION_RESULTS_OPENER_MAX_LENGTH)
  );
}

/**
 * Parse tool calls from text containing XML function_calls blocks: the last
 * function_calls block that doesn't have function_results immediately
 * following it.
 *
 * `options.tools` supplies the round's declared schemas; parameter values of a
 * declared type are parsed by that type instead of guessed.
 */
export function parseToolCalls(text: string, options?: ToolParseOptions): ParsedToolCalls | null {
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
 * Supports both plain and antml: prefixed tags
 */
export function hasUnclosedToolBlock(text: string): boolean {
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
  if (/<(antml:)?function_calls[^>]*$/.test(text)) return true;
  if (/<(antml:)?invoke[^>]*$/.test(text)) return true;
  if (/<(antml:)?parameter[^>]*$/.test(text)) return true;

  return hasUnclosedToolBlock(text);
}

/**
 * Results matching this are entity-escaped. Escaping every result would put
 * `&quot;` entities in front of the model, which Claude-3-era models
 * reproduce in their own output.
 */
const STRUCTURAL_TAG_RE =
  /<\/?(?:antml:)?(?:function_calls|function_results|invoke|result|stdout|error|tool_name)\b/;

/** A `data:` URL holds its image inline; any other URL's image is at the URL. */
export function toolResultImage(block: unknown): { data: unknown; declared: unknown } {
  const b = block as { source?: { type?: unknown; url?: unknown; data?: unknown; mediaType?: unknown; media_type?: unknown }; data?: unknown; mimeType?: unknown };
  if (!b.source) return { data: b.data, declared: b.mimeType };
  if (b.source.type === 'url') {
    const inline = dataUrlImage(b.source.url);
    return { data: inline?.data, declared: inline?.declared };
  }
  return { data: b.source.data, declared: b.source.mediaType ?? b.source.media_type };
}

function xmlResultImage(
  block: unknown,
): { mediaType: RasterImageMediaType; data: string; note?: undefined } | { note: { type: 'text'; text: string } } {
  const { data, declared } = toolResultImage(block);
  const source = (block as { source?: unknown }).source;
  if (data === undefined && typeof source === 'object' && source !== null && (source as { type?: unknown }).type === 'url') {
    return { note: linkImageNote((source as { url?: unknown }).url) };
  }
  const image = imageForRequest(data, declared);
  return image.placeholder ? { note: image.placeholder } : { mediaType: image.mediaType, data: data as string };
}

function imageNote(block: Extract<ToolResultContentBlock, { type: 'image' }>): string {
  const image = xmlResultImage(block);
  if (image.note) return image.note.text;
  const sizeKb = Math.round((image.data.length * 0.75) / 1024);
  return `[Image: ${image.mediaType}, ~${sizeKb}KB, not shown to you]`;
}

function renderResultContentString(result: ToolResult): string {
  if (typeof result.content === 'string') {
    return result.content;
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      // An XML result's text can't carry an image.
      parts.push(imageNote(block));
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
 * contains structural tags (then escaped).
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

function guardResultContent(s: string): string {
  return STRUCTURAL_TAG_RE.test(s) ? escapeXml(s) : s;
}

function resultOpenXml(result: ToolResult): string {
  if (result.isError) return '<error>\n';
  let xml = '<result>\n';
  if (result.toolName) xml += `<tool_name>${result.toolName}</tool_name>\n`;
  xml += '<stdout>\n';
  return xml;
}

function resultCloseXml(result: ToolResult): string {
  return result.isError ? '\n</error>\n' : '\n</stdout>\n</result>\n';
}

/**
 * Format a single tool result
 */
export function formatToolResult(result: ToolResult): string {
  return formatToolResults([result]);
}

export interface ToolDefinitionForPrompt {
  name: string;
  description: string;
  parameters: Record<string, {
    type?: string;
    nullable?: boolean;
    description?: string;
    required?: boolean;
    enum?: string[];
  }>;
}

/**
 * A tool definition as the XML tool instructions present it, read from its
 * input schema by the same reading the XML parameter parser applies: the
 * type the model is told a parameter has is the type its value is parsed by,
 * and a parameter the parser cannot type states none. Its null mark leaves
 * out a null the schema's other keywords leave out, though the parse admits
 * null (antra-tess/membrane#150), and its `enum` lists the values the reading
 * finds behind `$ref`s, in branches and across root alternatives as well as
 * on the declaring node.
 */
export function toolDefinitionForPrompt(tool: ToolDefinition): ToolDefinitionForPrompt {
  const { parameters } = readToolSchema(tool.inputSchema);
  return {
    name: tool.name,
    description: tool.description,
    parameters: Object.fromEntries(
      [...parameters].map(([name, declaration]) => [
        name,
        {
          type: declaration.type,
          nullable: declaration.instructedNullable || undefined,
          description: declaration.description,
          required: declaration.required,
          enum: declaration.enum?.map(String),
        },
      ])
    ),
  };
}

function listsExactly(values: readonly string[]): boolean {
  return (
    values.length > 0 &&
    values.every(
      value => value !== '' && value === value.trim() && !/[",\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
    )
  );
}

/**
 * Format tool definitions as XML for system prompt.
 *
 * A parameter's `enum` values print raw, unlike its name and type, since the
 * parser doesn't decode entities in a value the model writes: an entity shown
 * here, such as `&quot;`, would be copied into the call and kept. Where the
 * attribute can't show every value exactly, the parameter's line has no
 * `enum` at all, rather than a list the model would split wrongly.
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
      if (param.nullable) attrs.push('nullable="true"');
      if (param.required) attrs.push('required="true"');
      // `String` prints a null member as `null`, where `join` alone prints an empty item.
      const values = param.enum?.map(String);
      if (values && listsExactly(values)) attrs.push(`enum="${values.join(',')}"`);
      
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

const THINKING_BLOCK_REGEX = /<(antml:)?thinking>([\s\S]*?)<\/(antml:)?thinking>/g;

type CandidateSpan =
  | { kind: 'thinking'; start: number; end: number; thinking: string }
  | { kind: 'calls'; start: number; end: number; resolvedBlock: ResolvedToolBlock }
  | { kind: 'results'; start: number; end: number; innerContent: string; rawXml: string };

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
      rawXml: resultsMatch[0],
    });
  }

  return spans;
}

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

const FUNCTION_BLOCK_WITH_CONTENT_REGEX = /<(antml:)?function_calls>([\s\S]*?)<\/(antml:)?function_calls>/g;

const FUNCTION_RESULTS_BLOCK_REGEX = /<(antml:)?function_results>([\s\S]*?)<\/(antml:)?function_results>/g;

const RESULT_REGEX = /<result\s+tool_use_id="([^"]+)">([\s\S]*?)<\/result>/g;
const ERROR_REGEX = /<error\s+tool_use_id="([^"]+)">([\s\S]*?)<\/error>/g;

// The legacy Anthropic convention has no ids on the wire: a result answers
// the preceding unmatched call, in document order (optionally by <tool_name>).
const LEGACY_RESULT_REGEX =
  /<result>\s*(?:<tool_name>([\s\S]*?)<\/tool_name>\s*)?<stdout>\n?([\s\S]*?)\n?<\/stdout>\s*<\/result>/g;
const LEGACY_ERROR_REGEX = /<error>\n?([\s\S]*?)\n?<\/error>/g;

export function parseAccumulatedIntoBlocks(
  text: string,
  options?: ToolParseOptions & { startInsideBlock?: 'thinking' | 'tool_call' | 'tool_result' }
): {
  blocks: ContentBlock[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  unclosedToolBlock: boolean;
  emptyToolBlocks: number;
  splicedToolBlocks: number;
  unclosedInvokeHeads: number;
  resultSpans: ResultSpan[];
} {
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

  type BlockPosition = {
    start: number;
    end: number;
    block: ContentBlock | ContentBlock[];
    calls?: ToolCall[];
    results?: ToolResult[];
  };
  const positions: BlockPosition[] = [];

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

  const candidateSpans = collectCandidateSpans(processedText);

  const survivingSpans = retainOutermostSpans(candidateSpans);

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
      // Carried on each tool_use for verbatim prefill replay (antra-tess/membrane#36).
      const rawXml = resolvedBlock.fullMatch;
      const blockToolCalls: ContentBlock[] = [];
      const blockCalls: ToolCall[] = [];

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

  const firstResult = new Map<BlockPosition, number>();
  for (const pos of positions) {
    if (pos.calls) toolCalls.push(...pos.calls);
    if (pos.results) {
      firstResult.set(pos, toolResults.length);
      toolResults.push(...pos.results);
    }
  }

  const syntheticOpenerLength = processedText.length - text.length;
  const resultSpans: ResultSpan[] = [];

  let lastEnd = 0;
  for (const pos of positions) {
    if (pos.start > lastEnd) {
      const textContent = processedText.slice(lastEnd, pos.start).trim();
      if (textContent) {
        blocks.push({ type: 'text', text: textContent });
      }
    }

    const result = firstResult.get(pos);
    if (result !== undefined && Array.isArray(pos.block)) {
      resultSpans.push({ at: pos.start - syntheticOpenerLength, block: blocks.length, result, count: pos.block.length });
    }
    if (Array.isArray(pos.block)) {
      blocks.push(...pos.block);
    } else {
      blocks.push(pos.block);
    }

    lastEnd = Math.max(lastEnd, pos.end);
  }

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
    resultSpans,
  };
}

export interface ResultSpan {
  at: number;
  block: number;
  result: number;
  count: number;
}

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
  const definitions = tools.map((tool) => {
    const toolDef = {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
    };
    return `<function>${JSON.stringify(toolDef)}</function>`;
  });

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

export interface ProviderImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export function hasImageInToolResults(results: ToolResult[]): boolean {
  return results.some((result) => Array.isArray(result.content)
    && result.content.some((block) => block.type === 'image' && isAcceptedImage(toolResultImage(block).data)));
}

export interface SplitTurnContent {
  beforeImageXml: string;

  images: ProviderImageBlock[];

  afterImageXml: string;

  hasImages: boolean;

  imageResult: number;
}

export function formatToolResultsForSplitTurn(results: ToolResult[]): SplitTurnContent {
  const images: ProviderImageBlock[] = [];
  let beforeImageXml = '<function_results>\n';
  let afterImageXml = '';
  let imageInsertionPoint = -1;

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;

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
          const image = xmlResultImage(block);
          if (image.note) {
            textParts.push(guardResultContent(image.note.text));
          } else {
            resultHasImages = true;
            resultImages.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data,
              },
            });
          }
        }
      }
    }

    if (resultHasImages && imageInsertionPoint === -1) {
      imageInsertionPoint = i;
      images.push(...resultImages);

      beforeImageXml += resultOpenXml(result);
      if (textParts.length > 0) {
        beforeImageXml += textParts.join('\n');
      }

      afterImageXml = resultCloseXml(result);

      for (let j = i + 1; j < results.length; j++) {
        const remainingResult = results[j]!;
        afterImageXml += formatSingleResultXml(remainingResult);
      }
      afterImageXml += '</function_results>';

      break;
    } else if (imageInsertionPoint === -1) {
      beforeImageXml += resultOpenXml(result);
      beforeImageXml += textParts.join('\n');
      beforeImageXml += resultCloseXml(result);
    }
  }

  if (imageInsertionPoint === -1) {
    beforeImageXml += '</function_results>';
    return {
      beforeImageXml,
      images: [],
      afterImageXml: '',
      hasImages: false,
      imageResult: -1,
    };
  }

  return {
    beforeImageXml,
    images,
    afterImageXml,
    hasImages: true,
    imageResult: imageInsertionPoint,
  };
}

function formatSingleResultXml(result: ToolResult): string {
  let xml = resultOpenXml(result);

  if (typeof result.content === 'string') {
    xml += guardResultContent(result.content);
  } else if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        xml += guardResultContent(block.text);
      } else if (block.type === 'image') {
        xml += guardResultContent(imageNote(block));
      }
    }
  }

  xml += resultCloseXml(result);
  return xml;
}

export interface SplitResultsRound {
  xml: string;
  docAt: number;
  at: number;
  imageResult: number;
  results: readonly ToolResult[];
}

export function attachSplitResults(
  parsed: { blocks: ContentBlock[]; toolResults: ToolResult[]; resultSpans: readonly ResultSpan[] },
  rounds: readonly SplitResultsRound[],
): { blocks: ContentBlock[]; toolResults: ToolResult[] } {
  let blocks: ContentBlock[] | null = null;
  let toolResults: ToolResult[] | null = null;
  for (const round of rounds) {
    const span = parsed.resultSpans.find((s) => s.at === round.docAt);
    if (!span) continue;
    const group = parsed.blocks.slice(span.block, span.block + span.count) as ToolResultContent[];
    if (group[0]?.rawXml !== round.xml) continue;
    const results = round.results.filter((r) => !r.isError);
    const errors = round.results.filter((r) => r.isError);
    const parsedErrors = group.filter((block) => block.isError).length;
    if (parsedErrors !== errors.length || group.length - parsedErrors !== results.length) continue;
    const sent = round.results[round.imageResult];
    if (!sent) continue;
    let r = 0;
    let e = 0;
    for (let i = 0; i < group.length; i++) {
      const block = group[i]!;
      if ((block.isError ? errors[e++] : results[r++]) !== sent) continue;
      blocks ??= [...parsed.blocks];
      blocks[span.block + i] = { ...block, content: copyResultContent(sent.content), rawXmlImagesAt: round.at };
      toolResults ??= [...parsed.toolResults];
      const entry = parsed.toolResults[span.result + i]!;
      toolResults[span.result + i] = { ...entry, content: copyResultContent(sent.content) as ToolResult['content'] };
    }
  }
  return { blocks: blocks ?? parsed.blocks, toolResults: toolResults ?? parsed.toolResults };
}

function copyResultContent(content: ToolResult['content']): ToolResultContent['content'] {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    const source = (block as { source?: object }).source;
    return (source ? { ...block, source: { ...source } } : { ...block }) as ContentBlock;
  });
}

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
