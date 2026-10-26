/**
 * When signed thinking sits in an assistant turn with Anthropic server-tool
 * blocks (web search, web fetch, code execution, tool search, the MCP
 * connector, `container_upload`), the API refuses the turn sent back with
 * the blocks left out ("thinking ... blocks in the latest assistant message
 * cannot be modified"), and a model replayed without its search results no
 * longer has them.
 */

import type { ContentBlock } from '../types/content.js';
import { isRawItemCarrier } from './fidelity.js';

/**
 * The response block types for server tools that membrane has no normalized
 * block for, as the Anthropic SDK 0.115.0 publishes them: its `ContentBlock`
 * union's server blocks, and the MCP connector's two, from its beta types.
 * The SDK this package builds against, 0.52.0, defines six of them (the first
 * two in its stable types; code execution's result, `container_upload` and
 * the MCP connector's two in its beta types); the other four are 0.115.0's.
 */
export const ANTHROPIC_SERVER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'container_upload',
  'mcp_tool_use',
  'mcp_tool_result',
]);

/** A block whose `type` is one of {@link ANTHROPIC_SERVER_BLOCK_TYPES}, as the API sent it. */
export type AnthropicServerBlock = { type: string } & Record<string, unknown>;

/** An object whose `type` is one of {@link ANTHROPIC_SERVER_BLOCK_TYPES}. */
export function isAnthropicServerBlock(item: unknown): item is AnthropicServerBlock {
  return (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    ANTHROPIC_SERVER_BLOCK_TYPES.has((item as { type?: unknown }).type as string)
  );
}

/**
 * The Anthropic server-tool block that `block` is, or that it carries as a
 * zero-width carrier; undefined for every other block, including a carrier
 * holding another provider's item.
 */
function serverBlockOf(block: unknown): AnthropicServerBlock | undefined {
  const item = isAnthropicServerBlock(block)
    ? block
    : block !== null && typeof block === 'object' && isRawItemCarrier(block as ContentBlock)
      ? (block as { rawItem?: unknown }).rawItem
      : undefined;
  return isAnthropicServerBlock(item) ? item : undefined;
}

/** True for an Anthropic server-tool block, or a zero-width carrier holding one. */
export function carriesAnthropicServerBlock(block: unknown): boolean {
  return serverBlockOf(block) !== undefined;
}

/**
 * A `cache_control` stored on a server block or its carrier isn't sent: the
 * request's markers are its builder's, and Anthropic takes at most four.
 */
export function anthropicServerBlockFor(block: unknown): AnthropicServerBlock | undefined {
  const item = serverBlockOf(block);
  if (item === undefined) return undefined;
  const { cache_control: _stored, unparseableInput: _marker, ...sent } = item;
  return sent as AnthropicServerBlock;
}

/** The server-tool call types: a result's `tool_use_id` names a call's `id`. */
const ANTHROPIC_SERVER_CALL_TYPES: ReadonlySet<string> = new Set(['server_tool_use', 'mcp_tool_use']);

/**
 * The API refuses a server call that has no result after it in its turn,
 * and a result whose call isn't before it in its turn, so a request that
 * replays either alone fails, and so does every later request that replays
 * the turn. Ids must be unique per assistant turn: a second call with a
 * call's id, or a second result for one call, is refused. It refuses a call
 * whose `id`, or a result whose `tool_use_id`, isn't a string, in any turn,
 * and `container_upload` in any assistant turn. A paused turn
 * (`pause_turn`) is resumed by sending it back as it is, as the request's
 * final message, where the API takes a lone call.
 */
export function unpairedServerBlocks(turn: readonly unknown[], lastTurn: boolean): Set<unknown> {
  const unpaired = new Set<unknown>();
  // The first call of each id, and whether a result has paired with it yet.
  const calls = new Map<string, { block: unknown; answered: boolean }>();
  for (const block of turn) {
    if (!isAnthropicServerBlock(block)) continue;
    if (block.type === 'container_upload') {
      unpaired.add(block);
    } else if (ANTHROPIC_SERVER_CALL_TYPES.has(block.type)) {
      if (typeof block.id !== 'string' || calls.has(block.id)) unpaired.add(block);
      else calls.set(block.id, { block, answered: false });
    } else {
      const call = typeof block.tool_use_id === 'string' ? calls.get(block.tool_use_id) : undefined;
      if (call === undefined || call.answered) unpaired.add(block);
      else call.answered = true;
    }
  }
  if (!lastTurn) {
    for (const call of calls.values()) if (!call.answered) unpaired.add(call.block);
  }
  // In the turn's order, as the blocks are found.
  return new Set(turn.filter((block) => unpaired.has(block)));
}
