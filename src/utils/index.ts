/**
 * Utility exports
 */

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

export { calculateCost } from './cost.js';
export type { CostableUsage } from './cost.js';

export {
  BAD_REQUEST_TEMPLATES,
  REQUEST_FIELD_NAMES,
  classifyBadRequest,
  type BadRequestTemplate,
} from './bad-request.js';
