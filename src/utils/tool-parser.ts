/**
 * Tool parsing utilities for XML-based tool calls
 * 
 * Format:
 * <function_calls>
 * <invoke name="tool_name">
 * <parameter name="param_name">value</parameter>
 * </invoke>
 * </function_calls>
 */

import type { ToolCall, ToolResult, ParsedToolCalls } from '../types/index.js';

// ============================================================================
// Tool Call Parsing
// ============================================================================

const FUNCTION_CALLS_REGEX = /<function_calls>([\s\S]*?)<\/function_calls>/g;
const INVOKE_REGEX = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
const PARAMETER_REGEX = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;

/**
 * Parse tool calls from text containing XML function_calls blocks
 */
export function parseToolCalls(text: string): ParsedToolCalls | null {
  // Reset regex
  FUNCTION_CALLS_REGEX.lastIndex = 0;
  
  const match = FUNCTION_CALLS_REGEX.exec(text);
  if (!match) {
    return null;
  }
  
  const fullMatch = match[0];
  const innerContent = match[1] ?? '';
  const matchIndex = match.index;
  
  const beforeText = text.slice(0, matchIndex);
  const afterText = text.slice(matchIndex + fullMatch.length);
  
  const calls: ToolCall[] = [];
  
  // Parse invocations
  INVOKE_REGEX.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;
  
  while ((invokeMatch = INVOKE_REGEX.exec(innerContent)) !== null) {
    const toolName = invokeMatch[1] ?? '';
    const invokeContent = invokeMatch[2] ?? '';
    
    // Parse parameters
    const input: Record<string, unknown> = {};
    PARAMETER_REGEX.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    
    while ((paramMatch = PARAMETER_REGEX.exec(invokeContent)) !== null) {
      const paramName = paramMatch[1] ?? '';
      const paramValue = paramMatch[2] ?? '';
      
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
 */
export function hasUnclosedToolBlock(text: string): boolean {
  const openCount = (text.match(/<function_calls>/g) || []).length;
  const closeCount = (text.match(/<\/function_calls>/g) || []).length;
  return openCount > closeCount;
}

/**
 * Check if text ends with a partial/unclosed tool block
 */
export function endsWithPartialToolBlock(text: string): boolean {
  // Check for partial opening tag
  if (/<function_calls[^>]*$/.test(text)) return true;
  if (/<invoke[^>]*$/.test(text)) return true;
  if (/<parameter[^>]*$/.test(text)) return true;
  
  // Check for unclosed block
  return hasUnclosedToolBlock(text);
}

// ============================================================================
// Tool Result Formatting
// ============================================================================

/**
 * Format tool results as XML for injection
 */
export function formatToolResults(results: ToolResult[]): string {
  const parts: string[] = ['<function_results>'];
  
  for (const result of results) {
    if (result.isError) {
      parts.push(`<error tool_use_id="${result.toolUseId}">`);
      parts.push(escapeXml(result.content));
      parts.push('</error>');
    } else {
      parts.push(`<result tool_use_id="${result.toolUseId}">`);
      parts.push(escapeXml(result.content));
      parts.push('</result>');
    }
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
