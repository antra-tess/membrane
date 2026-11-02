/**
 * One JSON Schema node inside a tool's inputSchema.
 *
 * `type` is optional and may be an array because JSON Schema spells the same
 * declaration several ways: `{type:'string'}`, `{type:['string','null']}`,
 * `{anyOf:[{type:'string'},{type:'null'}]}` and `{$ref:'#/$defs/X'}` all
 * declare a parameter.
 */
export interface ToolParameter {
  type?: string | string[];
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  anyOf?: ToolParameter[];
  oneOf?: ToolParameter[];
  allOf?: ToolParameter[];
  $ref?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, ToolParameter>;
    required?: string[];
    /** Root-level unions: the params live inside the variants, not in `properties`. */
    anyOf?: ToolParameter[];
    oneOf?: ToolParameter[];
    allOf?: ToolParameter[];
    /** `$ref` targets, both spellings. */
    definitions?: Record<string, ToolParameter>;
    $defs?: Record<string, ToolParameter>;
  };
  /**
   * Whether the API streams this tool's input as the model writes it: the
   * Anthropic adapter sends it as `eager_input_streaming`, and no other
   * adapter sends it. False or unset, the API buffers and validates each
   * parameter's value and sends it once complete; an unset tool also streams
   * as written if the request carries Anthropic's legacy
   * `fine-grained-tool-streaming-2025-05-14` beta header, and false keeps it
   * buffered even then. True, the API doesn't validate this tool's input, so
   * its fragments and its finished call can be partial or invalid JSON, and
   * input the SDK's stream parser can't recover fails the turn. For a tool an
   * agent speaks through, that failure lands on its main way of speaking.
   * The Anthropic adapter sends the field on every native-mode request whose
   * `tools` carry the tool, streamed or not; a tool added mid-conversation
   * through `defineTools` can't set it, and is refused if it does. Anthropic
   * documents it only for streamed requests. It's part of the tool's
   * definition, so setting or changing it rewrites the prompt cache from the
   * tools onward: set it per agent and keep it. `emitToolInputDeltas` passes
   * the fragments on.
   */
  eagerInputStreaming?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * The call's tool_use block's marker (ToolUseContent.unparseableInput):
   * present, even as the empty string, when `input` isn't the model's
   * arguments. It holds the arguments as they came, as JSON when they came as
   * a value, or, on a call marked because its stream broke the API's block
   * order, as JSON when they had parsed. An executor can answer the model
   * with an error result instead of
   * running the call with `{}`.
   */
  unparseableInput?: string;
}

export interface ToolResult {
  toolUseId: string;
  /**
   * Tool name, for the legacy XML result rendering
   * (`<result><tool_name>…</tool_name><stdout>…</stdout></result>`).
   * Optional: XML paths backfill it from the round's parsed calls when the
   * executor didn't supply it.
   */
  toolName?: string;
  /**
   * Result content - can be string or structured content blocks (for images).
   * In an XML tool loop, the first result of a round with images that can be
   * sent has them sent as images, in a user turn of their own (see
   * ToolResultContent.rawXmlImagesAt); other images are noted in text. For
   * native mode, passed as content blocks.
   */
  content: string | ToolResultContentBlock[];
  isError?: boolean;
}

/**
 * Content block types allowed in tool results
 */
export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; mediaType: string } };

export interface ToolContext {
  /** The raw text that contained the tool calls */
  rawText: string;

  /** Text before the tool calls (already streamed to user) */
  preamble: string;

  /**
   * XML mode only: THIS round's model-authored text — the slice of the
   * turn between the end of the previous round's injected results and this
   * round's <function_calls> opener. Unlike `preamble` (cumulative: the
   * whole turn so far, including harness-injected <function_results> XML),
   * this never repeats earlier rounds and never contains injected results.
   * Consumers persisting per-round assistant text must prefer this field —
   * persisting the cumulative `preamble` per round stores each round's text
   * N times and re-persists injected results as model text.
   */
  roundPreamble?: string;

  /** Current depth in tool execution loop */
  depth: number;

  /** Previous tool results in this execution chain */
  previousResults: ToolResult[];

  /** Accumulated output so far */
  accumulated: string;

  /**
   * Normalized content blocks of the current assistant round, in provider
   * order (thinking / redacted_thinking / text / tool_use). Present on the
   * native-tools yielding path. Consumers persisting the assistant turn
   * should use these verbatim instead of rebuilding from `preamble` +
   * `calls`, which drops thinking blocks and their signatures and reorders
   * what survives.
   *
   * Provider order is a content-correctness requirement, not something
   * today's API enforces: preserve it. A signature validates against the
   * content that produced it, and stricter validation has existed in earlier
   * Anthropic generations and in vendor front-ends (Bedrock and gateway
   * variants).
   */
  roundContent?: import('./content.js').ContentBlock[];

  /**
   * Yielding paths: whether this path can carry `injectedMessages` supplied
   * in reply to this event, if another round starts. A capability, not a
   * promise of a next request: the round report (`UsageEvent.round`) says
   * what a round actually carried. True on the native path, false on the XML
   * prefill path.
   */
  supportsInjectedMessages?: boolean;
}

export interface ParsedToolCalls {
  /** Parsed tool calls */
  calls: ToolCall[];
  
  /** Text before the tool calls block */
  beforeText: string;
  
  /** Text after the tool calls block */
  afterText: string;
  
  /** The full matched tool calls XML block */
  fullMatch: string;
}
