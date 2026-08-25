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
 */

/** Anthropic's hard limit on cache_control breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

export interface WireCacheSurfaces {
  messages?: unknown;
  system?: unknown;
  tools?: unknown;
}

/**
 * Every marker-bearing block on the request, in WIRE ORDER (tools, then
 * system blocks, then message blocks). Order is what makes "deepest" mean
 * anything: a deeper marker caches a longer prefix.
 */
function collectMarkedBlocks(surfaces: WireCacheSurfaces): Array<Record<string, unknown>> {
  const marked: Array<Record<string, unknown>> = [];
  const pushIfMarked = (candidate: unknown) => {
    if (candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).cache_control) {
      marked.push(candidate as Record<string, unknown>);
    }
  };

  if (Array.isArray(surfaces.tools)) {
    for (const tool of surfaces.tools) pushIfMarked(tool);
  }
  if (Array.isArray(surfaces.system)) {
    for (const block of surfaces.system) pushIfMarked(block);
  }
  if (Array.isArray(surfaces.messages)) {
    for (const message of surfaces.messages) {
      const content = (message as { content?: unknown } | null)?.content;
      if (Array.isArray(content)) {
        for (const block of content) pushIfMarked(block);
      } else {
        pushIfMarked(content);
      }
    }
  }
  return marked;
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
