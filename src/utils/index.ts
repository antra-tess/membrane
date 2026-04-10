/**
 * Utility exports
 */

export {
  parseToolCalls,
  formatToolResults,
  formatToolResult,
  formatToolDefinitions,
  getToolInstructions,
  hasUnclosedToolBlock,
  endsWithPartialToolBlock,
  unescapeXml,
  type ToolDefinitionForPrompt,
} from './tool-parser.js';

export { calculateCost } from './cost.js';
