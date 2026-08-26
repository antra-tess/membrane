/**
 * One recount of the cache_control markers actually present on a wire
 * request, plus the clamp that keeps that count legal.
 *
 * Anthropic accepts at most 4 cache_control breakpoints per request and
 * rejects the fifth with a non-retryable 400 ("A maximum of 4 blocks with
 * cache_control may be provided. Found 5." — measured live 2026-08-25).
 * Markers arrive from many sites (context strategy breakpoints, block-level
 * passthrough on imported histories, the tools/system fallback, the floating
 * tool-loop marker, caller-marked system blocks, and any beforeRequest hook),
 * and every one of them is invisible to the others' running tallies. The
 * only trustworthy number is a recount of the constructed artifacts, so this
 * module owns it and every site calls it.
 *
 * A marker can also ride a block NESTED inside another block's content array
 * (`tool_result.content` is `string | ContentBlock[]`, passed through to the
 * wire verbatim), so discovery recurses. A belt that cannot see a marker
 * cannot clamp it, and a top-level-only count would report four while five
 * shipped — the request rejected outright with the belt's blessing.
 */

/** Anthropic's hard limit on cache_control breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * How many levels of nested `content` arrays marker discovery descends below
 * a top-level block.
 *
 * A marker can ride a block inside another block's own content array —
 * `ToolResultContent.content` is typed `string | ContentBlock[]` and every
 * builder passes it through verbatim, so a caller-built tool_result whose
 * members carry `cache_control` puts real markers on the wire. The API's own
 * nesting is one level deep; 4 is headroom for shapes it grows later, and it
 * is also what makes this walk TOTAL — a caller-built structure that points
 * back at itself terminates at the cap instead of hanging the request.
 * Markers below the cap are outside the belt's reach, by construction.
 */
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

/**
 * Every marker-bearing block on the request, in WIRE ORDER (tools, then
 * system blocks, then message blocks) and, within each, in DOCUMENT order —
 * a block before anything nested inside its own content. Order is what makes
 * "deepest" mean anything: a deeper marker caches a longer prefix.
 *
 * ONE walk serves both the count and the clamp's strip, so a marker the
 * counter can see is always a marker the clamp can strip. A collector that
 * stopped at the top level would count four while five rode to the wire, and
 * the provider would reject the request the belt just declared legal.
 */
function collectMarkedBlocks(surfaces: WireCacheSurfaces): Array<Record<string, unknown>> {
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
 * Take ownership of a system surface before it can reach the clamp.
 *
 * `request.system` accepts caller-marked blocks, and the builders pass that
 * array through by reference when they add no marker of their own. The clamp
 * strips markers IN PLACE at the wire boundary — correct for blocks membrane
 * built, catastrophic for the caller's own array, which a long-lived caller
 * reuses turn after turn: one over-budget request would silently delete the
 * caller's breakpoints for the life of that object. Copying the array and its
 * blocks at build time keeps the clamp's mutations inside the request.
 *
 * The copy descends exactly as far as marker discovery does: a shallow
 * `{...block}` leaves any nested `content` array shared with the caller, and
 * the clamp now strips markers at that grain, so ownership has to reach it
 * too or the leak just moves one level down.
 */
export function ownSystemBlocks(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
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
 * Bring a request inside the breakpoint budget, in place, at the last exit
 * before the adapter call. Two repairs, both loud:
 *
 *  1. a marker riding a thinking / redacted_thinking block is stripped — the
 *     API rejects those outright ("thinking.cache_control: Extra inputs are
 *     not permitted"), and the three builders' `lastCacheableBlockIndex`
 *     discipline is only as good as its last caller. This is the runtime
 *     assertion; a fourth builder can no longer repeat that history.
 *  2. markers past the limit are dropped SHALLOWEST-FIRST, keeping the 4
 *     deepest — the deepest marker caches the longest prefix, and every
 *     shallower prefix it subsumes.
 *
 * Dropping loudly beats a 400: the request still ships, cached less than the
 * caller asked for, with the overspend named.
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
