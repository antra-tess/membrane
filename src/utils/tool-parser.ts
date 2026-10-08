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
  ToolCallNotice,
  TurnToolCallNotice,
} from '../types/index.js';
import { createHash } from 'node:crypto';
import { resolveImageMediaType, isAcceptedImageMediaType, strippedImagePlaceholder } from './image-media.js';
import { readToolSchema, type ParameterDeclaration, type ToolSchemaReading } from './tool-schema.js';
import { encodeCdata, readPayload } from './xml-payload.js';

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
 *
 * `historyLength` is how much of the text is history the turn did not write:
 * the prefill, in membrane's XML loops. A CDATA payload opened in history ends
 * where history ends, so a section someone left unterminated in an earlier turn
 * cannot swallow this turn's calls. Left out, the whole text is the turn's own.
 *
 * `harnessEnvelopes` are the `<function_results>` envelopes the caller itself
 * injected into this text, by offset: the evidence that an envelope is the
 * harness speaking. Markup alone can't establish a speaker — a model can write
 * a lookalike envelope, even right after its own block. Supplied (even
 * empty), only these envelopes speak for the harness: only they answer a
 * block (parseToolCalls selects among the blocks they have not answered), only
 * their results are tool results, and only their notices are read, their
 * recorded refusals deciding their block. Each is also a speaker boundary:
 * markup the model wrote before an envelope never pairs with a tag inside or
 * after it, so an opener the model left unclosed cannot swallow the call an
 * envelope answers, or the envelope. An offset pair that does not span exactly
 * one results element is not an envelope. Any other results span is the
 * model's own text, and the boundary rules decide every other block. Left
 * out, results spans are read as they always were — one directly after a block
 * answers it, its results are tool results — but no envelope carries notices
 * or authority; a caller that cannot say which envelopes it wrote gets the
 * legacy reading for what predates notices, and nothing it can't vouch for
 * beyond that. Membrane supplies them on every parse of its own.
 */
export interface ToolParseOptions {
  tools?: ToolDefinition[];
  historyLength?: number;
  harnessEnvelopes?: ReadonlyArray<{ start: number; end: number }>;
}

/** 16+ digits, no decimal: beyond Number.MAX_SAFE_INTEGER (Discord snowflakes). */
const LARGE_INT_RE = /^\d{16,}$/;

/** One tool's schema, read once per invoke. */
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

// ----------------------------------------------------------------------------
// Diagnostics
// ----------------------------------------------------------------------------

/**
 * Subjects already reported, so a repeated parse names the same bound once.
 * Keyed by CONTENT — tool, parameter and the schema form concerned — not by
 * tool and parameter name alone: two agents in one process whose servers
 * expose the same tool name with different schemas each hear about their own.
 * Stored as digests and bounded in number, so neither a large schema nor a
 * producer that mints a new schema per request can grow it without limit.
 */
const reportedSubjects = new Set<string>();
const MAX_REPORTED_SUBJECTS = 1024;

function stringifyForDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value) ?? `[${typeof value}]`;
  } catch {
    // A schema object carrying a cycle of its own (not a `$ref` cycle), or a BigInt.
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

/**
 * The mismatch diagnostic names COORDINATES ONLY — tool, parameter, declared
 * type, and what the value did — and never the value itself. Tool arguments
 * routinely carry credentials, tokens and private documents, and this path
 * fires exactly when a model formats such a value oddly, so echoing it would
 * copy secrets into stderr and any durable log downstream of it. The
 * coordinates are what a maintainer reproduces from locally.
 */
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

// ----------------------------------------------------------------------------
// Values
// ----------------------------------------------------------------------------

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
 * Write one parameter value so that the XML parser reads back exactly this
 * value, type included, under any declaration the value satisfies and when the
 * parameter is undeclared — written without the schema, by the value's own
 * type:
 *   - a string is CDATA (see {@link encodeCdata}), which every declaration reads
 *     as exactly its text: markup, edge whitespace, `null` and JSON-looking
 *     text included;
 *   - any other value is JSON with every `<` escaped as `\u003c`, so the text
 *     holds no markup and both schema-directed parsing and the legacy guess
 *     restore the value and its type. A top-level number whose JSON is a run
 *     of 16+ digits, which the snowflake guard keeps as text, is written in
 *     exponent form instead: the shortest exact spelling of the same number.
 * `undefined` is not a JSON value; such a parameter is left out, as the JSON
 * wire leaves it out. A value that contradicts its declaration — a number
 * stored under a declared string — cannot round-trip by any spelling: a
 * declared string always parses as a string.
 */
export function encodeParameterValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return encodeCdata(value);
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  if (typeof value === 'number' && LARGE_INT_RE.test(json)) return value.toExponential();
  return json.replace(/</g, '\\u003c');
}

/**
 * The legacy guess, for parameters with no usable declaration: trim, then
 * JSON.parse with the trimmed text as fallback. Large integers (Discord
 * snowflakes and the like) lose precision as JavaScript numbers, so they stay
 * strings.
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

/**
 * The layout newlines of a string parameter: ONE newline directly after the
 * opening tag and ONE directly before the closing tag, when present. This is
 * the convention tool results are written and read in (`<stdout>\n…\n</stdout>`,
 * see LEGACY_RESULT_REGEX), so a value framed the way the model sees every
 * result framed arrives as its content, and a value written inline arrives as
 * written. A value that itself begins or ends with a newline is written with
 * one more.
 */
function withoutFraming(value: string): string {
  const start = value.startsWith('\n') ? 1 : 0;
  const end = value.length > start && value.endsWith('\n') ? value.length - 1 : value.length;
  return value.slice(start, end);
}

/**
 * Parse one XML parameter value by its declaration.
 *
 * The wire bytes are taken as they arrive: this parser transforms no character
 * of a parameter value, so ordinary markup and entity text reach the tool
 * exactly as the model wrote them.
 *
 * What happens next depends on the parameter's declaration, as
 * {@link readToolSchema} reads it — the same reading the XML tool
 * instructions are rendered from:
 *   - typed `string` → the text as written, less one layout newline on each
 *                 side ({@link withoutFraming}). No JSON.parse, no trim: an
 *                 exact-match edit tool must be able to send leading and
 *                 trailing whitespace, and a string whose text happens to be
 *                 valid JSON must stay a string.
 *   - typed object/array/number/integer/boolean/null → JSON.parse, with a
 *                 loud diagnostic when the text does not parse (raw text
 *                 passed through) or parses to a different JSON kind than
 *                 declared.
 *   - nullable (the declaration also admits null) → the text `null`, trimmed,
 *                 is JSON null, whatever the other type.
 *   - untyped (`{}`), or undeclared → the legacy guess, silently.
 *   - unresolved (the declaration constrains the type, but not to one type)
 *                 → the legacy guess, with ONE warn per distinct schema form
 *                 naming it: the divergence stays, but it stops being silent.
 */
function parseParamValue(
  value: string,
  paramName: string,
  schema: InvokeSchema | undefined
): unknown {
  if (schema === undefined) return guessParamValue(value);

  const declaration = schema.reading.parameters.get(paramName);
  if (declaration === undefined) {
    // An UNDECLARED parameter keeps the legacy guess silently — unless the
    // schema has a root union this parser does not read, which may be exactly
    // where it is declared.
    if (schema.reading.unreadRootUnion.length > 0) warnUnreadRootUnion(schema, paramName);
    return guessParamValue(value);
  }
  if (declaration.status === 'untyped') return guessParamValue(value);
  if (declaration.status === 'unresolved' || declaration.type === undefined) {
    warnUnresolvedDeclaration(schema.toolName, paramName, declaration);
    return guessParamValue(value);
  }

  if (declaration.nullable && value.trim() === 'null') {
    return null;
  }

  if (declaration.type === 'string') {
    return withoutFraming(value);
  }

  return parseDeclaredJson(value, paramName, schema, declaration.type);
}

/**
 * The value of a CDATA-written parameter: literal text, unless the schema
 * declares a single non-string type.
 *
 * CDATA is the spelling a model reaches for when a value must arrive exactly,
 * so its payload is never trimmed, never stripped of framing newlines (those
 * sit outside the sections) and never guessed into another type: a declared,
 * nullable, undeclared, untyped or unresolved parameter receives the payload
 * as a string, and `null` stays the text "null". A parameter declared as a
 * non-string type parses its payload as JSON exactly as a raw value would.
 */
function parseCdataValue(
  payload: string,
  paramName: string,
  schema: InvokeSchema | undefined
): unknown {
  const declaration = schema?.reading.parameters.get(paramName);
  if (
    schema === undefined ||
    declaration === undefined ||
    declaration.status !== 'typed' ||
    declaration.type === undefined ||
    declaration.type === 'string'
  ) {
    return payload;
  }
  if (declaration.nullable && payload.trim() === 'null') return null;
  return parseDeclaredJson(payload, paramName, schema, declaration.type);
}

/** Schema-directed JSON parsing of a value declared as one non-string JSON type. */
function parseDeclaredJson(
  value: string,
  paramName: string,
  schema: InvokeSchema,
  declaredType: string
): unknown {
  const trimmed = value.trim();

  if (LARGE_INT_RE.test(trimmed)) {
    // Digits past Number.MAX_SAFE_INTEGER come back rounded from JSON.parse,
    // so they stay text, as they always have: for a number or integer
    // declaration that is the value in the only exact form it has, and for any
    // other declaration it is a kind mismatch on top.
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

// ----------------------------------------------------------------------------
// Parameter boundaries
// ----------------------------------------------------------------------------

/**
 * Text as the structural scans read it, beside text as it was written.
 *
 * `masked` is `original` with every CDATA payload's characters replaced (see
 * {@link structuralView}), so no tag inside a payload is ever structure; the
 * two have the same length, so an offset found in one reads the other.
 */
interface ScanText {
  masked: string;
  original: string;
}

function sliceScanText(text: ScanText, start: number, end: number): ScanText {
  return { masked: text.masked.slice(start, end), original: text.original.slice(start, end) };
}

/** What one invoke's parameters came to: its arguments, and anything wrong with their boundaries. */
interface ParsedParameters {
  input: Record<string, unknown>;
  /** Why the call must not be sent, when it must not. */
  refusal?: string;
  /** Oddities of a call that is kept as parsed. Empty when refused. */
  warnings: string[];
}

/** A boundary finding, located in the invoke body so the first one can be reported. */
interface BoundaryFinding {
  at: number;
  refusal?: string;
  warning?: string;
}

const CDATA_ADVICE = 'To send this text as data, write the value as CDATA.';

function refusalMessage(observation: string): string {
  return `${observation}; nothing was sent. ${CDATA_ADVICE}`;
}

function quoteStart(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// A closing tag for the parameter element in a namespace the parser does not
// recognize, at the end of the text before an absorbed opener (whitespace
// allowed between). `antml:` closers are recognized, so they end a value and
// can never be inside one.
const UNRECOGNIZED_PARAMETER_CLOSER_AT_END = /<\/([^\s<>/:]+):parameter>\s*$/;

/**
 * Parse the parameters of one invoke body, and check their boundaries.
 *
 * A raw value is read as it always was: lazily, up to the first recognized
 * closing tag. A value written as CDATA is its payload exactly (see
 * {@link parseCdataValue}). What would make the arguments differ from what the
 * caller wrote is found here, and the call is refused rather than sent:
 *   - a raw value holding a closing parameter tag in an unrecognized namespace
 *     followed by an opener for a declared parameter the call lacks (Linn's
 *     miskeyed close);
 *   - a raw value holding an opener for an unconditionally required parameter
 *     the call lacks (an unclosed or wrongly closed value swallowed it);
 *   - non-whitespace text after a parameter (a value cut at a literal closing
 *     tag, or a parameter never closed), markup before the first parameter
 *     (perhaps a parameter the parser doesn't read), or any text in a call
 *     with no parameter the parser reads;
 *   - text after a CDATA value's last section, before its closer.
 * A raw value holding an opener for an optional declared parameter the call
 * lacks keeps the call as parsed, with a warning that makes no claim about
 * intent. So does markup-free text before the first parameter, such as a
 * model's commentary: no value precedes it to have been cut, and it is not
 * passed to the tool.
 * CDATA payloads are never inspected: they are what the caller meant.
 *
 * `toolName` is the name the invoke actually dispatches under — for a
 * re-anchored head, the innermost one — so the schema consulted per parameter
 * is the schema of the tool that will receive it.
 */
function parseInvokeParameters(
  body: ScanText,
  toolName: string,
  tools?: ToolDefinition[]
): ParsedParameters {
  const input: Record<string, unknown> = {};
  const schema = invokeSchemaFor(tools, toolName);
  const rawValues: Array<{ name: string; at: number; text: string }> = [];
  const findings: BoundaryFinding[] = [];

  let gapStart = 0;
  let previous: string | undefined;
  PARAMETER_REGEX.lastIndex = 0;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = PARAMETER_REGEX.exec(body.masked)) !== null) {
    noteTextOutsideParameters(body, gapStart, paramMatch.index, previous, true, findings);

    const paramName = paramMatch[2] ?? '';
    const closerLength = `</${paramMatch[4] ?? ''}parameter>`.length;
    const valueEnd = paramMatch.index + paramMatch[0].length - closerLength;
    const valueStart = valueEnd - (paramMatch[3] ?? '').length;
    const payload = readPayload(body.original, valueStart, valueEnd);

    if (payload.kind === 'cdata') {
      const suffix = body.original.slice(payload.end, valueEnd);
      const suffixAt = suffix.search(/\S/);
      if (suffixAt !== -1) {
        findings.push({
          at: payload.end + suffixAt,
          refusal: refusalMessage(
            `the value of ${paramName} has text after its CDATA section, starting \`${quoteStart(suffix.slice(suffixAt))}\``
          ),
        });
      }
      input[paramName] = parseCdataValue(payload.payload, paramName, schema);
    } else if (payload.kind === 'unterminated') {
      // Only a payload bounded by history can arrive here: the walker masks a
      // live one to the end of the text, so its parameter never closes.
      findings.push({
        at: valueStart,
        refusal: refusalMessage(`the CDATA section in the value of ${paramName} never ends`),
      });
    } else {
      const text = body.original.slice(valueStart, valueEnd);
      input[paramName] = parseParamValue(text, paramName, schema);
      rawValues.push({ name: paramName, at: valueStart, text });
    }

    previous = paramName;
    gapStart = paramMatch.index + paramMatch[0].length;
  }
  noteTextOutsideParameters(body, gapStart, body.masked.length, previous, false, findings);

  if (schema !== undefined) {
    for (const value of rawValues) noteAbsorbedParameters(value, schema, input, findings);
  }

  findings.sort((a, b) => a.at - b.at);
  const refusal = findings.find(finding => finding.refusal !== undefined)?.refusal;
  const warnings = refusal === undefined
    ? findings.flatMap(finding => (finding.warning === undefined ? [] : [finding.warning]))
    : [];
  return { input, refusal, warnings };
}

// A `<` that can start a tag: a name's first character, or the `/`, `!` or `?`
// of a closer, a declaration or a processing instruction. Before a space, a
// digit or another symbol (`a < b`, `<-`) it is prose.
const TAG_START = /<[/!?:_\p{L}]/u;

/**
 * Non-whitespace text inside an invoke but outside every parameter.
 *
 * A parameter opener in it, wherever it stands in the text, is a parameter
 * never closed: an opener with a closer after it would have been read as a
 * parameter, so only the gap after the last parameter can hold one.
 *
 * After a parameter, the text can be the tail of a value cut short at a literal
 * closing tag, and commentary there can't be told apart from one: with the
 * real closer forgotten, even a cut's tail holds no markup. Refused.
 *
 * Before the first parameter, no value precedes it to have been cut. Text
 * there that holds no markup is taken as commentary and kept out of the call:
 * the call is sent as parsed, with a warning that makes no claim about intent.
 * Markup there may be a parameter the parser doesn't read (an element per
 * parameter, another namespace, a single-quoted name), whose value the call
 * would lose: refused.
 *
 * In a call with no parameter the parser reads, any text is refused: a value
 * written without its parameter tag reads just like commentary, and a tool
 * that declares no parameters may still accept some (an open object schema, a
 * root union the reading can't merge).
 */
function noteTextOutsideParameters(
  body: ScanText,
  from: number,
  to: number,
  previous: string | undefined,
  parameterFollows: boolean,
  findings: BoundaryFinding[]
): void {
  const offset = body.masked.slice(from, to).search(/\S/);
  if (offset === -1) return;
  const at = from + offset;
  const stray = body.original.slice(at, to);

  PARAMETER_OPEN_REGEX.lastIndex = 0;
  const unclosed = PARAMETER_OPEN_REGEX.exec(stray);
  if (unclosed) {
    findings.push({
      at,
      refusal: refusalMessage(`parameter ${unclosed[2] ?? ''} is not closed before the call ends`),
    });
    return;
  }
  const quoted = quoteStart(stray.trimEnd());
  if (previous !== undefined) {
    findings.push({
      at,
      refusal: refusalMessage(
        `the call has text after parameter ${previous} that is outside every parameter, starting \`${quoted}\`: ` +
          'a value was probably cut short at a literal closing tag'
      ),
    });
  } else if (!parameterFollows) {
    findings.push({
      at,
      refusal: refusalMessage(
        `the call has text outside every parameter, starting \`${quoted}\`, and no parameter the parser reads`
      ),
    });
  } else if (TAG_START.test(stray)) {
    findings.push({
      at,
      refusal: refusalMessage(
        `the call has text before its first parameter that is outside every parameter, starting \`${quoted}\`: ` +
          'it contains markup, but no parameter the parser reads'
      ),
    });
  } else {
    findings.push({
      at,
      warning:
        `the call has text before its first parameter, starting \`${quoted}\`, ` +
        'which is outside every parameter and was not passed to the tool',
    });
  }
}

/** Openers inside a raw value that name a declared parameter the call lacks. */
function noteAbsorbedParameters(
  value: { name: string; at: number; text: string },
  schema: InvokeSchema,
  input: Record<string, unknown>,
  findings: BoundaryFinding[]
): void {
  PARAMETER_OPEN_REGEX.lastIndex = 0;
  let opener: RegExpExecArray | null;
  while ((opener = PARAMETER_OPEN_REGEX.exec(value.text)) !== null) {
    const absorbed = opener[2] ?? '';
    if (Object.hasOwn(input, absorbed)) continue;
    const declaration = schema.reading.parameters.get(absorbed);
    if (declaration === undefined) continue;

    const at = value.at + opener.index;
    const closer = UNRECOGNIZED_PARAMETER_CLOSER_AT_END.exec(value.text.slice(0, opener.index));
    if (closer) {
      findings.push({
        at,
        refusal: refusalMessage(
          `the value of ${value.name} contains the closing tag \`${closer[0].trimEnd()}\`, which the parser ` +
            `doesn't recognize, followed by markup for parameter ${absorbed}, which is missing`
        ),
      });
    } else if (declaration.required) {
      findings.push({
        at,
        refusal: refusalMessage(
          `the value of ${value.name} contains markup for required parameter ${absorbed}, which is missing`
        ),
      });
    } else {
      findings.push({
        at,
        warning:
          `the value of ${value.name} contains markup for parameter ${absorbed}, ` +
          "which the call doesn't otherwise include",
      });
    }
  }
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

/** One invoke as parsed: its call, or why it must not be sent. */
interface ParsedInvoke {
  /** 0-based ordinal of this invoke's opener among every invoke opener in its block. */
  ordinal: number;
  name: string;
  input: Record<string, unknown>;
  /** Present when the call must not be sent; see {@link parseInvokeParameters}. */
  refusal?: string;
  warnings: string[];
}

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
  invokes: ParsedInvoke[];
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

/** Where an INVOKE_REGEX match's body begins, relative to the match. */
function invokeBodyOffset(invokeMatch: RegExpExecArray): number {
  const closerLength =
    INVOKE_CLOSE_TAG.length + (invokeMatch[INVOKE_CLOSER_PREFIX_GROUP]?.length ?? 0);
  return invokeMatch[0].length - closerLength - (invokeMatch[INVOKE_BODY_GROUP]?.length ?? 0);
}

function collectInvokes(inner: ScanText, tools?: ToolDefinition[]): ParsedInvokes {
  const invokes: ParsedInvoke[] = [];
  let unclosedHeads = 0;
  // Ordinals count every opener in the block, so a refused head and a
  // re-anchored call keep stable coordinates however the block parses.
  const ordinals = new Map(invokeOpenerOffsets(inner.masked).map((offset, ordinal) => [offset, ordinal]));

  const parseInvoke = (headAt: number, match: RegExpExecArray): ParsedInvoke => {
    const name = match[INVOKE_NAME_GROUP] ?? '';
    const body = match[INVOKE_BODY_GROUP];
    const ordinal = ordinals.get(headAt) ?? -1;
    if (body === undefined) return { ordinal, name, input: {}, warnings: [] };
    const bodyStart = headAt + invokeBodyOffset(match);
    const parsed = parseInvokeParameters(sliceScanText(inner, bodyStart, bodyStart + body.length), name, tools);
    return { ordinal, name, ...parsed };
  };

  INVOKE_REGEX.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = INVOKE_REGEX.exec(inner.masked)) !== null) {
    const invokeBody = invokeMatch[INVOKE_BODY_GROUP];
    const swallowedOpenerOffsets = invokeBody === undefined ? [] : invokeOpenerOffsets(invokeBody);

    if (swallowedOpenerOffsets.length === 0) {
      invokes.push(parseInvoke(invokeMatch.index, invokeMatch));
      continue;
    }

    // Every opener in the body is a head that never closed, and so is the
    // matched head itself; only the innermost one owns the closing tag.
    unclosedHeads += swallowedOpenerOffsets.length;

    const innermostAt =
      invokeMatch.index + invokeBodyOffset(invokeMatch) +
      swallowedOpenerOffsets[swallowedOpenerOffsets.length - 1]!;
    const reanchoredMatch = INVOKE_REANCHOR_REGEX.exec(
      inner.masked.slice(innermostAt, invokeMatch.index + invokeMatch[0].length)
    );

    // A re-anchored head that still does not parse — a nameless invoke, say —
    // is refused like any other: counted above, dispatched never.
    if (reanchoredMatch) {
      invokes.push(parseInvoke(innermostAt + reanchoredMatch.index, reanchoredMatch));
    }
  }

  return { invokes, unclosedHeads };
}

/** The notices a block's invokes carry, in document order. */
function noticesOf(invokes: ParsedInvoke[]): ToolCallNotice[] {
  return invokes.flatMap((invoke): ToolCallNotice[] =>
    invoke.refusal !== undefined
      ? [{ invoke: invoke.ordinal, toolName: invoke.name, kind: 'refused', message: invoke.refusal }]
      : invoke.warnings.map(message => ({ invoke: invoke.ordinal, toolName: invoke.name, kind: 'warning', message }))
  );
}

// Parameter tags. One source for the value extractor, the absorbed-markup
// check and the structural walker, so they can never disagree about what a
// parameter tag is. Groups: 1 = antml prefix, 2 = name, 3 = value,
// 4 = closer's antml prefix.
const PARAMETER_OPEN_SOURCE = String.raw`<(antml:)?parameter\s+name="([^"]+)">`;
const PARAMETER_CLOSE_SOURCE = String.raw`<\/(antml:)?parameter>`;
const PARAMETER_REGEX = new RegExp(`${PARAMETER_OPEN_SOURCE}([\\s\\S]*?)${PARAMETER_CLOSE_SOURCE}`, 'g');
const PARAMETER_OPEN_REGEX = new RegExp(PARAMETER_OPEN_SOURCE, 'g');
const PARAMETER_OPEN_AT_START = new RegExp(PARAMETER_OPEN_SOURCE, 'y');

// ============================================================================
// CDATA payloads: the structural walker
// ============================================================================

// What the walker looks for in each state. Every pattern is a tag the
// structural scans below recognize; the walker only adds where payloads are.
const WALK_TOP =
  /(?<calls><(?:antml:)?function_calls>)|<(?:antml:)?thinking>[\s\S]*?<\/(?:antml:)?thinking>|<(?:antml:)?function_results>[\s\S]*?<\/(?:antml:)?function_results>/g;
const WALK_BLOCK =
  /(?<blockClose><\/(?:antml:)?function_calls>)|(?<blockOpen><(?:antml:)?function_calls>)|(?<invokeOpen><(?:antml:)?invoke\s+name=)/g;
const WALK_INVOKE =
  /(?<invokeClose><\/(?:antml:)?invoke>)|(?<blockClose><\/(?:antml:)?function_calls>)|(?<blockOpen><(?:antml:)?function_calls>)|(?<invokeOpen><(?:antml:)?invoke\s+name=)|(?<paramOpen><(?:antml:)?parameter\s+name="[^"]+">)/g;
const WALK_VALUE =
  /(?<paramClose><\/(?:antml:)?parameter>)|(?<invokeClose><\/(?:antml:)?invoke>)|(?<blockClose><\/(?:antml:)?function_calls>)|(?<blockOpen><(?:antml:)?function_calls>)|(?<invokeOpen><(?:antml:)?invoke\s+name=)/g;
// What ends a value after its CDATA payload: a closer, and nothing else. An
// opener there is suffix text, so it starts no invoke and no block.
const WALK_SUFFIX = /(?<paramClose><\/(?:antml:)?parameter>)|(?<invokeClose><\/(?:antml:)?invoke>)|(?<blockClose><\/(?:antml:)?function_calls>)/g;
// An invoke head as INVOKE_REGEX accepts one, read where an opener was found.
const WALK_INVOKE_HEAD = /<(?:antml:)?invoke\s+name=(["'])((?:(?!\1).)+)\1\s*(\/?)>/y;

/** What the walker found: the data ranges, and an unterminated payload. */
interface PayloadScan {
  /** Each CDATA-led value's data: its payload and any suffix after it. */
  ranges: Array<{ start: number; end: number }>;
  /**
   * The payload the text ends inside, when one opened in the turn's own text
   * never terminates: its parameter, and the invoke that holds it (name, and
   * ordinal among its block's invoke openers).
   */
  unterminated?: { parameter: string; toolName: string; invoke: number };
}

/**
 * Where the CDATA-led values' data is: for every structural parameter whose
 * value begins with a CDATA payload, `[start, end)` from its first
 * `<![CDATA[` to the closer that ends the value, so the payload and anything
 * written after it.
 *
 * The walk reads the text in order, the way the structural scans will read it
 * once that data is masked: outside blocks, a closed thinking or results span
 * is a container and is skipped whole; inside a block, invokes; inside an
 * invoke, parameters; a raw value runs to the first recognized parameter
 * closer, and the openers it holds — parameter-looking or CDATA — are text. An
 * invoke opener inside a raw value or between parameters is a head that
 * swallowed the call after it, and a block opener inside a block re-anchors
 * there, as the scans resolve them.
 *
 * Text between a payload and the value's closer is its suffix, which refuses
 * the call (see {@link parseInvokeParameters}). It is masked with the payload,
 * so no opener in it re-anchors an invoke or a block: an invoke written after
 * a CDATA value is part of that value, refused with it, never a call of its
 * own. Only a closer ends the value — `</parameter>`, or the `</invoke>` or
 * `</function_calls>` that ends it unclosed.
 *
 * A payload with no terminator runs to the end of the text, so nothing after
 * it is structure: its block never closes and nothing in it is dispatched. A
 * value whose payload began in history (before `historyLength`) ends where
 * history ends instead, payload or suffix, and the turn's own text is read
 * afresh from there.
 */
function findPayloadRanges(text: string, historyLength = 0): PayloadScan {
  const ranges: Array<{ start: number; end: number }> = [];
  let unterminated: PayloadScan['unterminated'];
  let state: 'top' | 'block' | 'invoke' | 'value' = 'top';
  let cursor = 0;
  // Where the current invoke and parameter stand, for naming an unterminated
  // payload: openers are counted as invokeOpenerOffsets counts them.
  let invokeOrdinal = -1;
  let toolName = '';

  const next = (scan: RegExp): RegExpExecArray | null => {
    scan.lastIndex = cursor;
    return scan.exec(text);
  };
  const enterInvoke = (at: number): void => {
    invokeOrdinal++;
    WALK_INVOKE_HEAD.lastIndex = at;
    const head = WALK_INVOKE_HEAD.exec(text);
    if (!head) {
      // Not a head INVOKE_REGEX would accept: ordinary text.
      cursor = at + 1;
      return;
    }
    cursor = at + head[0].length;
    toolName = head[2] ?? '';
    state = head[3] === '/' ? 'block' : 'invoke';
  };
  const enterBlock = (): void => {
    state = 'block';
    invokeOrdinal = -1;
  };

  for (;;) {
    if (state === 'top') {
      const match = next(WALK_TOP);
      if (!match) break;
      cursor = match.index + match[0].length;
      if (match.groups?.calls !== undefined) enterBlock();
    } else if (state === 'block') {
      const match = next(WALK_BLOCK);
      if (!match) break;
      if (match.groups?.invokeOpen !== undefined) {
        enterInvoke(match.index);
      } else {
        cursor = match.index + match[0].length;
        if (match.groups?.blockClose !== undefined) state = 'top';
        else enterBlock();
      }
    } else if (state === 'invoke') {
      const match = next(WALK_INVOKE);
      if (!match) break;
      const groups = match.groups ?? {};
      if (groups.invokeOpen !== undefined) {
        enterInvoke(match.index);
        continue;
      }
      cursor = match.index + match[0].length;
      if (groups.invokeClose !== undefined) {
        state = 'block';
      } else if (groups.blockOpen !== undefined) {
        enterBlock();
      } else if (groups.blockClose !== undefined) {
        state = 'top';
      } else {
        // A parameter opener: its value may be a CDATA payload.
        const bound = cursor < historyLength ? historyLength : text.length;
        const payload = readPayload(text, cursor, bound);
        if (payload.kind === 'raw') {
          state = 'value';
        } else if (payload.kind === 'unterminated') {
          ranges.push({ start: payload.start, end: bound });
          if (bound === text.length) {
            PARAMETER_OPEN_AT_START.lastIndex = match.index;
            const parameter = PARAMETER_OPEN_AT_START.exec(text)?.[2] ?? '';
            unterminated = { parameter, toolName, invoke: invokeOrdinal };
            break;
          }
          cursor = bound;
          state = 'top';
        } else {
          // The value runs on from its payload to a closer; what lies between
          // is its suffix, data like the payload.
          WALK_SUFFIX.lastIndex = payload.end;
          const closer = WALK_SUFFIX.exec(text);
          if (closer === null || closer.index >= bound) {
            // No closer before the readable text ends: the value's data runs to
            // the end of the text, or to the end of history, which ends it.
            ranges.push({ start: payload.start, end: bound });
            if (bound === text.length) break;
            cursor = bound;
            state = 'top';
          } else {
            ranges.push({ start: payload.start, end: closer.index });
            cursor = closer.index + closer[0].length;
            if (closer.groups?.paramClose !== undefined) state = 'invoke';
            else if (closer.groups?.invokeClose !== undefined) state = 'block';
            else state = 'top';
          }
        }
      }
    } else {
      const match = next(WALK_VALUE);
      if (!match) break;
      const groups = match.groups ?? {};
      if (groups.invokeOpen !== undefined) {
        enterInvoke(match.index);
        continue;
      }
      cursor = match.index + match[0].length;
      if (groups.paramClose !== undefined) state = 'invoke';
      else if (groups.blockClose !== undefined) state = 'top';
      else if (groups.blockOpen !== undefined) enterBlock();
      else state = 'block';
    }
  }
  return { ranges, unterminated };
}

// What a payload's characters become in the masked text: not whitespace (so
// a masked payload is never mistaken for layout) and not `<` or `>` (so it can
// neither form nor end a tag).
const PAYLOAD_MASK = '\u0000';

/**
 * An envelope the caller injected (see ToolParseOptions.harnessEnvelopes),
 * checked against the text: exactly one results element spans its offsets.
 */
interface RecordedEnvelope {
  start: number;
  end: number;
  innerContent: string;
  rawXml: string;
}

// One results element, read where a recorded envelope says one begins.
const RESULTS_ELEMENT_AT = /<(?:antml:)?function_results>([\s\S]*?)<\/(?:antml:)?function_results>/y;

/**
 * The caller's recorded envelopes that are what they claim to be, in document
 * order: in range, not overlapping one another, and each exactly one results
 * element. Undefined when the caller supplied no provenance, which keeps the
 * legacy reading; an offset that names anything else is not an envelope.
 */
function recordedEnvelopes(
  text: string,
  harnessEnvelopes: ToolParseOptions['harnessEnvelopes']
): RecordedEnvelope[] | undefined {
  if (harnessEnvelopes === undefined) return undefined;
  const recorded: RecordedEnvelope[] = [];
  let previousEnd = 0;
  for (const { start, end } of [...harnessEnvelopes].sort((a, b) => a.start - b.start)) {
    if (start < previousEnd || end > text.length) continue;
    RESULTS_ELEMENT_AT.lastIndex = start;
    const element = RESULTS_ELEMENT_AT.exec(text);
    if (element === null || start + element[0].length !== end) continue;
    const innerStart = start + element[0].indexOf('>') + 1;
    recorded.push({
      start,
      end,
      innerContent: text.slice(innerStart, innerStart + (element[1] ?? '').length),
      rawXml: element[0],
    });
    previousEnd = end;
  }
  return recorded;
}

/**
 * The model's own text between the recorded envelopes, as `[start, end)`
 * ranges; the whole text when there are none.
 *
 * An injected envelope is a speaker boundary: whatever the model's markup
 * opens before one, it cannot close inside or after it. So every structural
 * reading — the payload walk, and the thinking, calls and results sweeps —
 * runs within these segments, and an opener the model left unclosed (a
 * lookalike results opener, an unclosed thinking) stays inside its own
 * segment instead of pairing with a closer the harness wrote, or one the model
 * wrote after the harness spoke.
 */
function modelSegments(length: number, envelopes: readonly RecordedEnvelope[] = []): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const envelope of envelopes) {
    segments.push({ start: cursor, end: envelope.start });
    cursor = envelope.end;
  }
  segments.push({ start: cursor, end: length });
  return segments;
}

/**
 * The text twice: as written, and with every CDATA-led value's data masked
 * (see {@link findPayloadRanges}), at the same offsets. Every structural scan
 * runs on the masked text, so a tag inside a payload or its suffix is never
 * structure; every value, block and quote is read from the written text.
 *
 * With recorded envelopes, the walk runs within each model segment (see
 * {@link modelSegments}); the envelopes themselves are not walked. Only the
 * last segment's unterminated payload is reported: that is where the text ends.
 */
function structuralView(
  text: string,
  historyLength = 0,
  envelopes?: readonly RecordedEnvelope[]
): ScanText & Pick<PayloadScan, 'unterminated'> {
  const ranges: Array<{ start: number; end: number }> = [];
  let unterminated: PayloadScan['unterminated'];
  for (const segment of modelSegments(text.length, envelopes)) {
    const segmentHistory = Math.min(Math.max(historyLength - segment.start, 0), segment.end - segment.start);
    const scan = findPayloadRanges(text.slice(segment.start, segment.end), segmentHistory);
    for (const range of scan.ranges) ranges.push({ start: range.start + segment.start, end: range.end + segment.start });
    unterminated = scan.unterminated;
  }
  if (ranges.length === 0) return { masked: text, original: text, unterminated };
  let masked = '';
  let cursor = 0;
  for (const range of ranges) {
    masked += text.slice(cursor, range.start) + PAYLOAD_MASK.repeat(range.end - range.start);
    cursor = range.end;
  }
  return { masked: masked + text.slice(cursor), original: text, unterminated };
}

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
  /** The block's inner content, masked and as written. */
  inner: ScanText;
  /** The whole block exactly as written: what a tool_use's rawXml replays. */
  fullMatch: string;
  wasSpliced: boolean;
}

/** `blockMatch` is a FUNCTION_BLOCK_WITH_CONTENT_REGEX match on `view.masked`. */
function resolveToolBlock(view: ScanText, blockMatch: RegExpExecArray): ResolvedToolBlock {
  const end = blockMatch.index + blockMatch[0].length;
  const innerMasked = blockMatch[2] ?? '';
  const innerStart = blockMatch.index + blockMatch[0].indexOf('>') + 1;
  const innerEnd = innerStart + innerMasked.length;

  FUNCTION_CALLS_OPEN_REGEX.lastIndex = 0;
  let innermostOpener: RegExpExecArray | null = null;
  let nestedMatch: RegExpExecArray | null;
  while ((nestedMatch = FUNCTION_CALLS_OPEN_REGEX.exec(innerMasked)) !== null) {
    innermostOpener = nestedMatch;
  }

  if (!innermostOpener) {
    return {
      start: blockMatch.index,
      end,
      inner: sliceScanText(view, innerStart, innerEnd),
      fullMatch: view.original.slice(blockMatch.index, end),
      wasSpliced: false,
    };
  }

  const reanchoredStart = innerStart + innermostOpener.index;
  return {
    start: reanchoredStart,
    end,
    inner: sliceScanText(view, reanchoredStart + innermostOpener[0].length, innerEnd),
    fullMatch: view.original.slice(reanchoredStart, end),
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
  return resultsOpenerAfter(text, afterPos) !== undefined;
}

/** Where the `<function_results>` opener directly after `afterPos` (whitespace allowed) begins, if one does. */
function resultsOpenerAfter(text: string, afterPos: number): number | undefined {
  let scan = afterPos;
  while (scan < text.length && SINGLE_WHITESPACE_REGEX.test(text[scan]!)) scan++;
  return FUNCTION_RESULTS_START_ANCHORED.test(text.slice(scan, scan + FUNCTION_RESULTS_OPENER_MAX_LENGTH))
    ? scan
    : undefined;
}

/**
 * Whether results already answered the block ending at `blockEnd`.
 *
 * With provenance (recorded envelopes, even none), only an envelope the
 * caller injected answers a block: a lookalike the model wrote after its own
 * call leaves the call pending, so it is neither hidden nor lost. Without
 * provenance, any results span directly after the block answers it — the
 * reading raw transcripts have always had, kept for callers that cannot say
 * which envelopes they wrote; a lookalike can hide a call from them.
 */
function isAnswered(
  masked: string,
  blockEnd: number,
  envelopes: readonly RecordedEnvelope[] | undefined
): boolean {
  const opener = resultsOpenerAfter(masked, blockEnd);
  if (opener === undefined) return false;
  return envelopes === undefined || envelopes.some((envelope) => envelope.start === opener);
}

/**
 * Parse tool calls from text containing XML function_calls blocks
 *
 * Uses "last-unexecuted-block" logic: finds the last function_calls block
 * that doesn't have function_results immediately following it.
 *
 * `options.tools` supplies the round's declared schemas; parameter values of a
 * declared type are parsed by that type instead of guessed, and the boundary
 * rules that need a schema (an absorbed declared parameter) can apply.
 *
 * The block's refused invokes are not among `calls`; they and its warned ones
 * are `notices`. A block whose every invoke was refused is still returned, with
 * no calls, so the caller can answer it.
 */
export function parseToolCalls(text: string, options?: ToolParseOptions): ParsedToolCalls | null {
  const envelopes = recordedEnvelopes(text, options?.harnessEnvelopes);
  const view = structuralView(text, options?.historyLength, envelopes);

  // Pick the last unexecuted block among those that survive containment: a
  // block quoted inside thinking or echoed in a tool result is content, and
  // dispatching from it runs a call the model never made. A block that ends in
  // history was the business of the turn that wrote it — answered then or not,
  // it is never this turn's to dispatch (a stray closer in the live text must
  // not re-run an earlier turn's call).
  const historyLength = options?.historyLength ?? 0;
  let lastUnexecutedBlock: ResolvedToolBlock | null = null;

  for (const block of collectLiveToolBlocks(view, envelopes)) {
    if (block.end <= historyLength) continue;
    if (!isAnswered(view.masked, block.end, envelopes)) {
      lastUnexecutedBlock = block;
    }
  }

  if (!lastUnexecutedBlock) {
    return null;
  }

  const beforeText = text.slice(0, lastUnexecutedBlock.start);
  const afterText = text.slice(lastUnexecutedBlock.end);

  const { invokes } = collectInvokes(lastUnexecutedBlock.inner, options?.tools);
  const calls: ToolCall[] = invokes
    .filter((invoke) => invoke.refusal === undefined)
    .map((invoke) => ({
      id: generateToolId(),
      name: invoke.name,
      input: invoke.input,
    }));

  return {
    calls,
    notices: noticesOf(invokes),
    beforeText,
    afterText,
    fullMatch: lastUnexecutedBlock.fullMatch,
  };
}

/**
 * Check if text contains an unclosed function_calls block
 * Used for false-positive stop sequence detection
 * Supports both plain and antml: prefixed tags
 *
 * Tags inside a CDATA payload are data, not structure, so they are not
 * counted; a payload that never ends leaves its block unclosed.
 */
export function hasUnclosedToolBlock(text: string): boolean {
  return countsUnclosedBlock(structuralView(text).masked);
}

function countsUnclosedBlock(masked: string): boolean {
  // Use regex that matches both plain and antml: prefixed tags
  const openPattern = /<(antml:)?function_calls>/g;
  const closePattern = /<\/(antml:)?function_calls>/g;

  const openCount = (masked.match(openPattern) || []).length;
  const closeCount = (masked.match(closePattern) || []).length;
  return openCount > closeCount;
}

/**
 * Check if text ends with a partial/unclosed tool block
 * Supports both plain and antml: prefixed tags
 */
export function endsWithPartialToolBlock(text: string): boolean {
  return maskedEndsWithPartialToolBlock(structuralView(text).masked);
}

function maskedEndsWithPartialToolBlock(masked: string): boolean {
  // Check for partial opening tag (plain or antml:)
  if (/<(antml:)?function_calls[^>]*$/.test(masked)) return true;
  if (/<(antml:)?invoke[^>]*$/.test(masked)) return true;
  if (/<(antml:)?parameter[^>]*$/.test(masked)) return true;

  // Check for unclosed block
  return countsUnclosedBlock(masked);
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
 *
 * `notices` are the parser's notices about the block these results answer
 * (refused invokes, and warnings about calls that ran). They follow every
 * result, one element each, so that when the turn continues the model reads
 * why a call it made has no result; see {@link formatToolCallNotice}. An
 * envelope may hold notices only, when every invoke was refused.
 */
export function formatToolResults(results: ToolResult[], notices: readonly ToolCallNotice[] = []): string {
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

  for (const notice of notices) parts.push(formatToolCallNotice(notice));

  parts.push('</function_results>');
  return parts.join('\n');
}

/**
 * One parser notice as the model reads it inside <function_results>:
 * `<tool_call_notice invoke="N" tool="NAME" kind="refused|warning">MESSAGE</tool_call_notice>`.
 *
 * It is the harness speaking, not a tool: it sits after every result, so
 * positional result pairing never sees it. Every `<`, `>` and `&` in the
 * message and tool name is escaped — unlike result content, which is escaped
 * only when it holds a structural tag — so a message quoting
 * `</tool_call_notice>` or `</function_results>` stays inside its own element.
 * Quotes are left alone in the message, where they need no escaping, so the
 * model reads plain prose rather than entities it might imitate.
 */
export function formatToolCallNotice(notice: ToolCallNotice): string {
  return (
    `<tool_call_notice invoke="${notice.invoke}" tool="${escapeXmlText(notice.toolName).replace(/"/g, '&quot;')}" ` +
    `kind="${notice.kind}">${escapeXmlText(notice.message)}</tool_call_notice>`
  );
}

/** Escape the characters that could form or end markup in element text. */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parser notices as attributed plain text, for formatters whose wire has no
 * <function_results> envelope (native tool use, Responses items). The text is
 * the harness speaking and is placed on the harness's side of the turn, after
 * any tool results.
 */
export function toolCallNoticesText(notices: readonly ToolCallNotice[]): string {
  return notices
    .map((notice) => `[tool-call notice] ${notice.toolName} (invoke ${notice.invoke}, ${notice.kind}): ${notice.message}`)
    .join('\n');
}

const TOOL_CALL_NOTICE_REGEX =
  /<tool_call_notice invoke="(\d+)" tool="([^"<]*)" kind="(refused|warning)">([^<]*)<\/tool_call_notice>/g;

/**
 * The notices recorded in one <function_results> envelope's inner content.
 *
 * Membrane writes notices after every result and error, so only the text past
 * the last result or error element is read: a lookalike element inside some
 * tool's output is never taken for one.
 */
function decodeToolCallNotices(resultsInner: string): ToolCallNotice[] {
  let after = 0;
  for (const elementRegex of [RESULT_REGEX, ERROR_REGEX, LEGACY_RESULT_REGEX, LEGACY_ERROR_REGEX]) {
    elementRegex.lastIndex = 0;
    let element: RegExpExecArray | null;
    while ((element = elementRegex.exec(resultsInner)) !== null) {
      after = Math.max(after, element.index + element[0].length);
    }
  }
  const notices: ToolCallNotice[] = [];
  TOOL_CALL_NOTICE_REGEX.lastIndex = after;
  let match: RegExpExecArray | null;
  while ((match = TOOL_CALL_NOTICE_REGEX.exec(resultsInner)) !== null) {
    notices.push({
      invoke: Number(match[1]),
      toolName: unescapeXml(match[2] ?? ''),
      kind: match[3] as ToolCallNotice['kind'],
      message: unescapeXml(match[4] ?? ''),
    });
  }
  return notices;
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
     * The parameter's type name, absent when its declaration does not admit
     * exactly one JSON type. Absent renders NO type attribute: the model is
     * better served by a parameter with no stated type than by
     * `type="undefined"` or a type the parser will not apply.
     */
    type?: string;
    /** The declaration also admits null: renders `nullable="true"`. */
    nullable?: boolean;
    description?: string;
    required?: boolean;
    enum?: string[];
  }>;
}

/**
 * A tool definition as the XML tool instructions present it, read from its
 * input schema by the same reading the XML parameter parser applies
 * ({@link readToolSchema}): the type the model is told a parameter has is the
 * type its value is parsed by, and a parameter the parser cannot type states
 * none.
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
          nullable: declaration.nullable || undefined,
          description: declaration.description,
          required: declaration.required,
          enum: declaration.enum,
        },
      ])
    ),
  };
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
      if (param.nullable) attrs.push('nullable="true"');
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
 * Every span the three block sweeps find, unfiltered and unregistered.
 *
 * Both parse entry points read the document through this one census, so the
 * dispatch path and the block path can never disagree about which blocks are
 * real.
 *
 * With recorded envelopes, each one is a results span exactly where it was
 * injected, and the sweeps run only within the model's text between them (see
 * {@link modelSegments}): no span the model's markup forms can cross an
 * envelope, so an opener the model left unclosed can neither swallow the call
 * an envelope answers nor hide the envelope itself.
 */
function collectCandidateSpans(view: ScanText, envelopes?: readonly RecordedEnvelope[]): CandidateSpan[] {
  const spans: CandidateSpan[] = [];
  for (const segment of modelSegments(view.masked.length, envelopes)) {
    const segmentView = sliceScanText(view, segment.start, segment.end);
    for (const span of sweepSpans(segmentView)) spans.push(shiftSpan(span, segment.start));
  }
  for (const envelope of envelopes ?? []) {
    spans.push({
      kind: 'results',
      start: envelope.start,
      end: envelope.end,
      innerContent: envelope.innerContent,
      rawXml: envelope.rawXml,
    });
  }
  return spans;
}

/** A span found in a segment, placed at its offset in the whole text. */
function shiftSpan(span: CandidateSpan, by: number): CandidateSpan {
  if (by === 0) return span;
  if (span.kind !== 'calls') return { ...span, start: span.start + by, end: span.end + by };
  return {
    ...span,
    start: span.start + by,
    end: span.end + by,
    resolvedBlock: { ...span.resolvedBlock, start: span.resolvedBlock.start + by, end: span.resolvedBlock.end + by },
  };
}

/** The three block sweeps over one stretch of text. */
function sweepSpans(view: ScanText): CandidateSpan[] {
  const spans: CandidateSpan[] = [];
  // Spans are found in the masked text, so no tag inside a CDATA payload or
  // its suffix opens or closes one; what a span holds is read from the text as
  // written.
  const text = view.masked;

  THINKING_BLOCK_REGEX.lastIndex = 0;
  let thinkingMatch: RegExpExecArray | null;
  while ((thinkingMatch = THINKING_BLOCK_REGEX.exec(text)) !== null) {
    const start = thinkingMatch.index;
    const end = start + thinkingMatch[0].length;
    const innerStart = start + thinkingMatch[0].indexOf('>') + 1;
    spans.push({
      kind: 'thinking',
      start,
      end,
      thinking: view.original.slice(innerStart, innerStart + (thinkingMatch[2] ?? '').length),
    });
  }

  FUNCTION_BLOCK_WITH_CONTENT_REGEX.lastIndex = 0;
  let funcMatch: RegExpExecArray | null;
  while ((funcMatch = FUNCTION_BLOCK_WITH_CONTENT_REGEX.exec(text)) !== null) {
    // A spliced match (a stale opener joined to a later round's closer) is
    // rejected as a block and re-anchored to its innermost opener; see
    // resolveToolBlock. Containment reads the RESOLVED span, which is where
    // the live block actually begins.
    const resolvedBlock = resolveToolBlock(view, funcMatch);
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
    const start = resultsMatch.index;
    const end = start + resultsMatch[0].length;
    const innerStart = start + resultsMatch[0].indexOf('>') + 1;
    spans.push({
      kind: 'results',
      start,
      end,
      innerContent: view.original.slice(innerStart, innerStart + (resultsMatch[2] ?? '').length),
      // Verbatim document text the harness placed — carried for exact replay
      // on the prefill path (membrane#36).
      rawXml: view.original.slice(start, end),
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
function collectLiveToolBlocks(view: ScanText, envelopes?: readonly RecordedEnvelope[]): ResolvedToolBlock[] {
  const live: ResolvedToolBlock[] = [];
  for (const span of retainOutermostSpans(collectCandidateSpans(view, envelopes))) {
    if (span.kind === 'calls') live.push(span.resolvedBlock);
  }
  return live;
}

/**
 * Where a `function_calls` block that the text ends inside begins: the
 * innermost opener, after the last resolved block and outside every retained
 * span, that an invoke head follows. Every opener a closer follows resolved to
 * a block or lies inside a span, so this one never closed, and the invoke head
 * makes it a call rather than a mention: a bare opener quoted in prose or
 * thought stays text. An earlier unmatched opener, before a block that
 * re-anchored past it, is that block's splice. Spans after the opener, such as
 * a thinking element quoted in the unfinished value, are inside the attempt.
 */
function unclosedTailStart(masked: string, spans: CandidateSpan[]): number | undefined {
  const afterBlocks = spans.reduce((end, span) => (span.kind === 'calls' ? Math.max(end, span.end) : end), 0);
  const outside = (at: number): boolean => !spans.some((span) => span.start <= at && at < span.end);
  const matchesFrom = (source: string): number[] => {
    const pattern = new RegExp(source, 'g');
    pattern.lastIndex = afterBlocks;
    const found: number[] = [];
    for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
      if (outside(match.index)) found.push(match.index);
    }
    return found;
  };
  const openers = matchesFrom(FUNCTION_CALLS_OPEN_REGEX.source);
  const heads = matchesFrom(INVOKE_OPEN_REGEX.source);
  for (const [index, opener] of openers.entries()) {
    const head = heads.find((at) => at > opener);
    if (head === undefined) return undefined;
    const next = openers[index + 1];
    if (next === undefined || next > head) return opener;
  }
  return undefined;
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
  /**
   * Every block's refused and warned invokes, located by block. For a block
   * that results already answer, these are the notices that envelope recorded
   * — what the model was told then, whatever the present schemas say. For a
   * block nothing has answered yet, the parser's rules decide.
   */
  notices: TurnToolCallNotice[];
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
  const notices: TurnToolCallNotice[] = [];
  let callsBlockCount = 0;
  // The envelopes the caller injected, in processedText's offsets, and those
  // found answering a block.
  const prepended = processedText.length - text.length;
  const envelopes = recordedEnvelopes(
    processedText,
    options?.harnessEnvelopes?.map((envelope) => ({ start: envelope.start + prepended, end: envelope.end + prepended }))
  );
  const harnessEnvelopeStarts = new Map((envelopes ?? []).map((envelope) => [envelope.start, envelope.end]));
  const isHarnessEnvelope = (span: CandidateSpan): boolean => harnessEnvelopeStarts.get(span.start) === span.end;
  const provenanceSupplied = envelopes !== undefined;
  const harnessAnswers = new Set<CandidateSpan>();

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
  // tool_use no longer in the response. Recorded envelopes bound every sweep
  // (see collectCandidateSpans), the payload walk included.
  const view = structuralView(processedText, options?.historyLength, envelopes);
  const candidateSpans = collectCandidateSpans(view, envelopes);

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
  for (const [spanIndex, span] of survivingSpans.entries()) {
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
      const blockIndex = callsBlockCount++;
      if (resolvedBlock.wasSpliced) splicedToolBlocks++;
      // Verbatim document text of the whole block — carried on each parsed
      // tool_use so prefill replay reproduces the generation exactly instead
      // of synthesizing a paraphrase (membrane#36).
      const rawXml = resolvedBlock.fullMatch;
      const blockToolCalls: ContentBlock[] = [];
      const blockCalls: ToolCall[] = [];

      // Parse invoke tags in this block (both forms, in document order); an
      // invoke left open is refused and re-anchored to the call it swallowed.
      const parsedInvokes = collectInvokes(resolvedBlock.inner, options?.tools);
      unclosedInvokeHeads += parsedInvokes.unclosedHeads;

      // The harness already answered this block: the notices recorded in the
      // envelope it injected are what happened — exactly the invokes it
      // refused were not sent, whatever the present schemas would say. Only an
      // envelope the caller vouches for counts (see harnessEnvelopes);
      // otherwise the rules decide, as they did when the block was live.
      const following = survivingSpans[spanIndex + 1];
      const answeredBy =
        following?.kind === 'results' &&
        isFollowedByResults(view.masked, resolvedBlock.end) &&
        isHarnessEnvelope(following)
          ? following
          : undefined;
      if (answeredBy) harnessAnswers.add(answeredBy);
      const blockNotices = answeredBy
        ? decodeToolCallNotices(answeredBy.innerContent)
        : noticesOf(parsedInvokes.invokes);
      const refusedOrdinals = new Set(
        blockNotices.filter((notice) => notice.kind === 'refused').map((notice) => notice.invoke)
      );
      for (const notice of blockNotices) notices.push({ ...notice, block: blockIndex, answered: answeredBy !== undefined });

      for (const invoke of parsedInvokes.invokes) {
        if (refusedOrdinals.has(invoke.ordinal)) continue;
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

      if (blockToolCalls.length > 0) {
        positions.push({
          start: resolvedBlock.start,
          end: resolvedBlock.end,
          block: blockToolCalls,
          calls: blockCalls,
        });
      } else if (refusedOrdinals.size > 0) {
        // Every invoke was refused: the attempt is the model's own text, kept
        // as written, but it is neither a call nor prose.
        positions.push({
          start: resolvedBlock.start,
          end: resolvedBlock.end,
          block: { type: 'tool_attempt', rawXml },
        });
      } else {
        emptyToolBlocks++;
      }
      continue;
    }

    // With provenance, a results span the caller didn't inject is the model's
    // own writing — its results are not tool output, so it stays text.
    if (provenanceSupplied && !isHarnessEnvelope(span)) continue;

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

    // The harness's notices close the envelope after every result. The span
    // is consumed whole even when they are all it holds, so nothing the
    // harness wrote falls through as the assistant's text. Notices are read
    // only from an envelope the harness injected in answer to a block; any
    // other span's lookalike stays whatever it is.
    const envelopeNotices = harnessAnswers.has(span) ? decodeToolCallNotices(innerContent) : [];
    if (envelopeNotices.length > 0) {
      blockResults.push({ type: 'tool_notice', notices: envelopeNotices });
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

  // A payload this text opened and never ended: its block never closed, so
  // nothing in it was dispatched. Its call is reported refused, located as the
  // block after every closed one, so a caller can tell the model why.
  if (view.unterminated) {
    notices.push({
      block: callsBlockCount,
      invoke: view.unterminated.invoke,
      toolName: view.unterminated.toolName,
      kind: 'refused',
      message: refusalMessage(`the CDATA section in the value of ${view.unterminated.parameter} never ends`),
      answered: false,
    });
  }

  // A block the text ends inside never closed: nothing in it was dispatched,
  // and it is no more prose than a refused block — the model's own attempt,
  // from its opener to the end of the text (the turn's own text, when the
  // opener was the prefill's), spans inside it included. An earlier opener
  // that a later block re-anchored past is that block's splice, and stays as
  // it was.
  const openTail = unclosedTailStart(view.masked, survivingSpans);
  if (openTail !== undefined) {
    for (let index = positions.length - 1; index >= 0; index--) {
      if (positions[index]!.start >= openTail) positions.splice(index, 1);
    }
    positions.push({
      start: openTail,
      end: processedText.length,
      block: { type: 'tool_attempt', rawXml: processedText.slice(Math.max(openTail, prepended)) },
    });
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
    unclosedToolBlock: maskedEndsWithPartialToolBlock(textOutsideSpans(view.masked, survivingSpans)),
    emptyToolBlocks,
    splicedToolBlocks,
    unclosedInvokeHeads,
    notices,
  };
}

// ============================================================================
// Tool Instructions (for manual placement)
// ============================================================================

/**
 * The one line every XML tool instruction carries about the literal spelling
 * (see utils/xml-payload.ts): a value written as CDATA is taken exactly.
 */
export const CDATA_INSTRUCTION =
  'A parameter value that contains markup can be written as CDATA directly after its opening tag, ' +
  '<![CDATA[like this]]>, and is then taken exactly as written; consecutive sections join, ' +
  'so a literal ]]> is written ]]]]><![CDATA[>.';

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
${FUNC_CALLS_CLOSE}
${CDATA_INSTRUCTION}`;
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
export function formatToolResultsForSplitTurn(
  results: ToolResult[],
  notices: readonly ToolCallNotice[] = []
): SplitTurnContent {
  // The block's parser notices close the envelope, after every result, as in
  // formatToolResults.
  const noticesXml = notices.map(notice => `${formatToolCallNotice(notice)}\n`).join('');
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
          const mediaType = resolveImageMediaType(block.source.data, block.source.mediaType);
          if (!isAcceptedImageMediaType(mediaType)) {
            textParts.push(strippedImagePlaceholder(mediaType).text);
          } else {
            resultHasImages = true;
            resultImages.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType!,
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
      afterImageXml += `${noticesXml}</function_results>`;

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
    beforeImageXml += `${noticesXml}</function_results>`;
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
