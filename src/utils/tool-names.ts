import { isSystemChangeContent, type ContentBlock } from '../types/content.js';

// Underscores are valid in wire tool names, so a caller's literal `__` stays as it is.
export function sanitizeToolName(name: string): string {
  return name.replace(/:/g, '__');
}

export function restoreToolName(name: string, tools?: readonly { name: string }[]): string {
  return tools?.find(tool => tool.name === name)?.name
    ?? tools?.find(tool => sanitizeToolName(tool.name) === name)?.name
    ?? name;
}

export function toolsOffered(request: {
  tools?: readonly { name: string }[];
  messages: readonly { content: readonly ContentBlock[] }[];
}): readonly { name: string }[] {
  const offered = new Map<string, { name: string }>();
  for (const tool of request.tools ?? []) offered.set(tool.name, tool);
  for (const message of request.messages) {
    for (const block of message.content) {
      if (!isSystemChangeContent(block)) continue;
      for (const name of block.removeTools ?? []) offered.delete(name);
      for (const tool of block.defineTools ?? []) {
        offered.delete(tool.name);
        offered.set(tool.name, tool);
      }
    }
  }
  return [...offered.values()];
}
