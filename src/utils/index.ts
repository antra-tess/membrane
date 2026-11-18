export {
  parseToolCalls,
  formatToolResults,
  formatToolResult,
  formatToolDefinitions,
  toolDefinitionForPrompt,
  getToolInstructions,
  hasUnclosedToolBlock,
  endsWithPartialToolBlock,
  unescapeXml,
  type ToolDefinitionForPrompt,
  type ToolParseOptions,
} from './tool-parser.js';

export { calculateCost, promptTokens, ratesFor } from './cost.js';
export type { CostableUsage } from './cost.js';
