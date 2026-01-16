/**
 * Tool definition and execution types
 */

// ============================================================================
// Tool Definition
// ============================================================================

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

// ============================================================================
// Tool Execution
// ============================================================================

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  /**
   * Result content - can be string or structured content blocks (for images).
   * For XML mode, images are noted in text. For native mode, passed as content blocks.
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

// ============================================================================
// Tool Context (passed to execution callback)
// ============================================================================

export interface ToolContext {
  /** The raw text that contained the tool calls */
  rawText: string;
  
  /** Text before the tool calls (already streamed to user) */
  preamble: string;
  
  /** Current depth in tool execution loop */
  depth: number;
  
  /** Previous tool results in this execution chain */
  previousResults: ToolResult[];
  
  /** Accumulated output so far */
  accumulated: string;
}

// ============================================================================
// Tool Parsing
// ============================================================================

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
