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

/**
 * Walk one candidate block and everything nested under it, in document order
 * (a block before its own content), applying `visitBlock` to each object.
 *
 * This is the single traversal law: marker discovery and the ownership copy
 * that protects caller-owned blocks from it both descend exactly here, so
 * the clamp can never reach a grain that ownership did not copy.
 */
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

/**
 * The one rule for what counts as nested content: an array-valued `content`
 * on a block, while still above the depth cap. Discovery and the ownership
 * copy both ask here, so neither can descend where the other does not.
 */
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

/**
 * Omit empty system arrays and take ownership of nonempty system surfaces
 * before they can reach the clamp. All request builders use the same rule.
 *
 * A caller's own system array can carry caller-marked blocks, whether it
 * comes as a formatter's `systemPrompt` or as `request.system` passed untyped
 * (the field is typed as a string), and a builder that adds no marker of its
 * own can pass its blocks through by reference (`NativeFormatter` does). The
 * clamp strips markers IN PLACE at the wire boundary — correct for blocks
 * membrane built, catastrophic for the caller's own array, which a long-lived
 * caller reuses turn after turn: one over-budget request would silently delete
 * the caller's breakpoints for the life of that object. Copying the array and its
 * blocks at build time keeps the clamp's mutations inside the request.
 *
 * The copy descends exactly as far as marker discovery does: a shallow
 * `{...block}` leaves any nested `content` array shared with the caller, and
 * the clamp now strips markers at that grain, so ownership has to reach it
 * too or the leak just moves one level down.
 */
export function ownSystemBlocks(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
  if (system.length === 0) return undefined;
  return system.map((block) => copyBlockTree(block, 0));
}

/**
 * Shallow-copy a block and, recursively, its nested content blocks, to the
 * same depth marker discovery walks. Non-objects pass through untouched.
 */
function copyBlockTree(candidate: unknown, depth: number): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const copy = { ...(candidate as Record<string, unknown>) };
  const nested = nestedContentBlocks(copy, depth);
  if (nested) copy.content = nested.map((child) => copyBlockTree(child, depth + 1));
  return copy;
}

/** How many cache_control markers this request would actually put on the wire. */
export function countWireCacheMarkers(surfaces: WireCacheSurfaces): number {
  return collectMarkedBlocks(surfaces).length;
}

/**
 * Validate a caller-owned marker layout without changing it.
 *
 * In `cm-owned` mode the caller has deliberately allocated the complete
 * breakpoint set. Silently stripping or reordering those markers would make
 * the cache receipt describe a request that was never sent, so invalid
 * layouts fail before submission instead of using the legacy repair clamp.
 */
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
