/**
 * Anthropic accepts at most 4 cache_control breakpoints per request and
 * rejects the fifth with a non-retryable 400 ("A maximum of 4 blocks with
 * cache_control may be provided. Found 5."). A marker can also ride a block
 * nested in another block's content (`tool_result.content`), which reaches
 * the wire as it is.
 */

/** Anthropic's hard limit on cache_control breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** The API's own content nesting is one level deep; this cap is above it. */
export const MAX_NESTED_CONTENT_DEPTH = 4;

function walkBlockTree(
  candidate: unknown,
  depth: number,
  visitBlock: (block: Record<string, unknown>) => void
): void {
  if (!candidate || typeof candidate !== 'object') return;
  const block = candidate as Record<string, unknown>;
  visitBlock(block);
  const nested = nestedContentBlocks(block, depth);
  if (!nested) return;
  for (const child of nested) walkBlockTree(child, depth + 1, visitBlock);
}

function nestedContentBlocks(block: Record<string, unknown>, depth: number): unknown[] | undefined {
  if (depth >= MAX_NESTED_CONTENT_DEPTH) return undefined;
  return Array.isArray(block.content) ? block.content : undefined;
}

export interface WireCacheSurfaces {
  messages?: unknown;
  system?: unknown;
  tools?: unknown;
}

/** Anthropic's cache prefix runs tools, then system, then messages, so a deeper marker caches a longer prefix. */
export function collectMarkedBlocks(surfaces: WireCacheSurfaces): Array<Record<string, unknown>> {
  const marked: Array<Record<string, unknown>> = [];
  const collectIfMarked = (candidate: unknown) =>
    walkBlockTree(candidate, 0, (block) => {
      if (block.cache_control) marked.push(block);
    });

  if (Array.isArray(surfaces.tools)) {
    for (const tool of surfaces.tools) collectIfMarked(tool);
  }
  if (Array.isArray(surfaces.system)) {
    for (const block of surfaces.system) collectIfMarked(block);
  }
  if (Array.isArray(surfaces.messages)) {
    for (const message of surfaces.messages) {
      const content = (message as { content?: unknown } | null)?.content;
      if (Array.isArray(content)) {
        for (const block of content) collectIfMarked(block);
      } else {
        collectIfMarked(content);
      }
    }
  }
  return marked;
}

export function ownSystemBlocks(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
  if (system.length === 0) return undefined;
  return system.map((block) => copyBlockTree(block, 0));
}

function copyBlockTree(candidate: unknown, depth: number): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const copy = { ...(candidate as Record<string, unknown>) };
  const nested = nestedContentBlocks(copy, depth);
  if (nested) copy.content = nested.map((child) => copyBlockTree(child, depth + 1));
  return copy;
}

export function countWireCacheMarkers(surfaces: WireCacheSurfaces): number {
  return collectMarkedBlocks(surfaces).length;
}

export function assertCacheMarkersWithinLimit(
  surfaces: WireCacheSurfaces,
  site: string
): number {
  const marked = collectMarkedBlocks(surfaces);
  const invalidThinking = marked.filter(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking'
  ).length;
  if (invalidThinking > 0) {
    throw new Error(
      `${site}: caller-owned cache_control cannot be attached to thinking/redacted_thinking blocks`
    );
  }
  if (marked.length > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `${site}: cache_control limit exceeded: ${marked.length} markers (maximum ${MAX_CACHE_BREAKPOINTS})`
    );
  }
  return marked.length;
}

/**
 * The API rejects `cache_control` on thinking and redacted_thinking blocks
 * ("thinking.cache_control: Extra inputs are not permitted"), and the deepest
 * marker caches the longest prefix.
 */
export function clampCacheMarkers(
  surfaces: WireCacheSurfaces,
  site: string
): { total: number; dropped: number; strippedFromThinking: number } {
  const marked = collectMarkedBlocks(surfaces);

  let strippedFromThinking = 0;
  const cacheable: Array<Record<string, unknown>> = [];
  for (const block of marked) {
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      delete block.cache_control;
      strippedFromThinking++;
      continue;
    }
    cacheable.push(block);
  }

  let dropped = 0;
  if (cacheable.length > MAX_CACHE_BREAKPOINTS) {
    for (const block of cacheable.slice(0, cacheable.length - MAX_CACHE_BREAKPOINTS)) {
      delete block.cache_control;
      dropped++;
    }
  }

  if (strippedFromThinking > 0) {
    console.warn(
      `[membrane] ${site}: stripped ${strippedFromThinking} cache_control marker(s) from ` +
      `thinking blocks — the API rejects cache_control on thinking/redacted_thinking.`
    );
  }
  if (dropped > 0) {
    console.warn(
      `[membrane] ${site}: ${cacheable.length} cache_control markers exceed the limit of ` +
      `${MAX_CACHE_BREAKPOINTS} — dropped the ${dropped} shallowest and kept the deepest ` +
      `${MAX_CACHE_BREAKPOINTS}. The request would otherwise have been rejected outright.`
    );
  }

  return { total: cacheable.length - dropped, dropped, strippedFromThinking };
}
