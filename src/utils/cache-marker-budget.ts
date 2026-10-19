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
 * (`tool_result.content` is `string | ContentBlock[]`), so discovery recurses.
 * A belt that cannot see a marker cannot clamp it, and a top-level-only count
 * would report four while five shipped — the request rejected outright with
 * the belt's blessing. A document's content source holds blocks too
 * (`source.content`), and the API takes a marker on its last one and counts
 * it toward the four, so discovery descends there as well. The
 * Anthropic-family adapters leave out a nested marker where the API doesn't
 * take one (utils/anthropic-wire-blocks.ts), so a marker counted here may not
 * ship.
 */

/** Anthropic's hard limit on cache_control breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * How many levels of nested content marker discovery descends below a
 * top-level block: `content` arrays, and documents' content sources.
 *
 * A marker can ride a block inside another block's own content array —
 * `ToolResultContent.content` is typed `string | ContentBlock[]`, so a
 * caller-built tool_result whose members carry `cache_control` can put real
 * markers on the wire. The API's own nesting is two levels deep at most (a
 * tool_result's document's content source); 4 is headroom for shapes it
 * grows later, and it is also what makes this walk TOTAL — a caller-built
 * structure that points back at itself terminates at the cap instead of
 * hanging the request.
 * Markers below the cap are outside the belt's reach, by construction.
 */
export const MAX_NESTED_CONTENT_DEPTH = 4;

/**
 * Walk one candidate block and everything nested under it, in document order
 * (a block before its own content), applying `visitBlock` to each object.
 *
 * This is the single traversal law: marker discovery and the ownership copy
 * that protects caller-owned blocks from it both descend exactly here, so
 * the clamp can never reach a grain that ownership did not copy. Readers of
 * a request's breakpoints elsewhere reach it through collectMarkedBlocks and
 * blockCacheMarker. A block in a message's content is at depth 0.
 */
function walkBlockTree(
  candidate: unknown,
  depth: number,
  visitBlock: (block: Record<string, unknown>) => void
): void {
  if (!candidate || typeof candidate !== 'object') return;
  const block = candidate as Record<string, unknown>;
  visitBlock(block);
  const nested = nestedContent(block, depth);
  if (!nested) return;
  for (const child of nested.blocks) walkBlockTree(child, depth + 1, visitBlock);
}

/**
 * The one rule for what counts as nested content, and where it sits, while
 * still above the depth cap: a document's blocks are its content source's
 * (`source.content`), and any other block's are an array-valued `content`.
 * A document has no `content` of its own on the wire, so one there is
 * nothing the API reads. Discovery and the ownership copy both ask here, so
 * neither can descend where the other does not.
 */
function nestedContent(
  block: Record<string, unknown>,
  depth: number
): { blocks: unknown[]; inSource: boolean } | undefined {
  if (depth >= MAX_NESTED_CONTENT_DEPTH) return undefined;
  if (block.type === 'document') {
    const source = block.source as Record<string, unknown> | null | undefined;
    return source && typeof source === 'object' && source.type === 'content' && Array.isArray(source.content)
      ? { blocks: source.content, inSource: true }
      : undefined;
  }
  return Array.isArray(block.content) ? { blocks: block.content, inSource: false } : undefined;
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
 * the provider would reject the request the belt just declared legal. The
 * Anthropic adapter's keepalive reads a request's breakpoints through it too.
 */
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
 * too or the leak just moves one level down. A tool_result's content takes
 * the same copy where the native formatter builds it
 * (toolResultContentForRequest).
 */
export function ownSystemBlocks(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
  if (system.length === 0) return undefined;
  return system.map((block) => copyBlockTree(block, 0));
}

/**
 * The cache breakpoint `block` carries: its own `cache_control`, else the last
 * one the walk finds inside it. Where membrane removes a block and carries its
 * breakpoint onto what stays (a tool_result the tool-pair normalizer turns into
 * text, an unpaired server block), and where a reader asks whether a block
 * holds one (cm-owned's import guard, the cache-wire receipt), it asks this,
 * so a nested breakpoint counts as it does in the budget.
 */
export function blockCacheMarker(block: unknown): unknown {
  if (!block || typeof block !== 'object') return undefined;
  const own = (block as Record<string, unknown>).cache_control;
  if (own) return own;
  let last: unknown;
  walkBlockTree(block, 0, (inner) => {
    if (inner.cache_control) last = inner.cache_control;
  });
  return last;
}

/**
 * A copy of `block`, as deep as the walk reaches, with no `cache_control` at
 * any of those depths: for a block whose breakpoints aren't the request's,
 * such as an Anthropic server block replayed from history.
 */
export function withoutCacheMarkers(block: unknown): unknown {
  const copy = copyBlockTree(block, 0);
  walkBlockTree(copy, 0, (inner) => {
    delete inner.cache_control;
  });
  return copy;
}

/**
 * Shallow-copy a block and, recursively, its nested content blocks, to the
 * same depth marker discovery walks: `depth` is the block's own, 0 at the top
 * of a message. Non-objects pass through untouched.
 */
export function copyBlockTree(candidate: unknown, depth: number): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const copy = { ...(candidate as Record<string, unknown>) };
  const nested = nestedContent(copy, depth);
  if (!nested) return copy;
  const blocks = nested.blocks.map((child) => copyBlockTree(child, depth + 1));
  if (nested.inSource) copy.source = { ...(copy.source as Record<string, unknown>), content: blocks };
  else copy.content = blocks;
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
