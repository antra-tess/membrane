/**
 * Utility exports
 */

export {
  parseToolCalls,
  formatToolResults,
  formatToolResult,
  formatToolDefinitions,
  resolveDeclaredType,
  getToolInstructions,
  hasUnclosedToolBlock,
  endsWithPartialToolBlock,
  unescapeXml,
  type ToolDefinitionForPrompt,
  type ToolParseOptions,
} from './tool-parser.js';

export { calculateCost } from './cost.js';
export type { CostableUsage } from './cost.js';
