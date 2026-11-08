import type { OpenAIResponsesAPIRequest, OpenAIResponsesInputItem } from './openai-responses-api.js';
import { invalidRequestError } from '../types/errors.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Enumerable request-local data survives spread, structuredClone and JSON-copy
// hooks. Unlike identity-keyed provenance it remains on the post-hook item.
// Reserved internally: stripped before routing/serialization, never caller-mutated.
const cacheMark = '__membraneResponsesCacheMark';

export function hasResponsesCacheMark(source: unknown): boolean {
  // Only the caller's message-level flag counts. cache_control can have been
  // synthesized by Membrane's Anthropic formatting, so it is not provenance.
  return object(source) && (source[cacheMark] === true || source.cacheBreakpoint === true);
}

export function rememberResponsesCacheMark(source: unknown, items: unknown[], start = 0): void {
  if (!hasResponsesCacheMark(source)) return;
  const last = items[items.length - 1];
  if (items.length <= start || !object(last)) {
    reportSkippedMarks(1);
    return;
  }
  items[items.length - 1] = { ...last, [cacheMark]: true };
}

/** Drop only the private carrier for routing and intermediate expansion items.
 * Caller metadata stays intact until final wire cleanup. */
export function withoutResponsesCacheCarrier<T>(item: T): T {
  if (!object(item) || !(cacheMark in item)) return item;
  const { [cacheMark]: internal, ...head } = item;
  void internal;
  return head as T;
}

function reportSkippedMarks(count: number): void {
  if (count > 0) console.warn(`[membrane:responses-prompt-cache] skipped marks: ${count}`);
}

/** Operator-reported wire extensions, not live-verified. Reserve one of four
 * writes for the implicit tail; conservatively allow message-type items only.
 * A tool/reasoning tail falls back to the latest eligible stable-prefix item. */
function responsesPromptCacheInput(items: OpenAIResponsesInputItem[]): OpenAIResponsesInputItem[] {
  const eligible = new Set<number>();
  let latest = -1;
  let skipped = 0;
  items.forEach((item, index) => {
    if (object(item) && (item.type === 'message' ||
      (item.type === undefined && typeof item.role === 'string'))) latest = index;
    if (!object(item) || item[cacheMark] !== true) return;
    if (latest < 0) skipped++;
    else eligible.add(latest);
  });
  reportSkippedMarks(skipped);
  const chosen = new Set([...eligible].sort((a, b) => a - b).slice(-3));
  return items.map((item, index) => {
    if (!object(item)) return item;
    const clean = stripCacheMetadata(item);
    if (Array.isArray(clean.content)) clean.content = clean.content.map(part => object(part) ? stripCacheMetadata(part) : part);
    if (Array.isArray(clean.output)) clean.output = clean.output.map(part => object(part) ? stripCacheMetadata(part) : part);
    // The opt-in owns these fields, including the write budget, not raw items.
    delete clean.prompt_cache_breakpoint;
    if (chosen.has(index)) clean.prompt_cache_breakpoint = { mode: 'explicit' };
    return clean;
  });
}

function stripCacheMetadata(value: JsonObject): JsonObject {
  const { [cacheMark]: internal, cacheBreakpoint, cache_control, ...clean } = value;
  void internal;
  void cacheBreakpoint;
  void cache_control;
  return clean;
}

export function responsesPromptCacheOptions(ttl: unknown): JsonObject | undefined {
  if (ttl === undefined) return undefined;
  // Positive integral durations in seconds/minutes/hours/days, no coercion or
  // whitespace. Do not invent a provider-specific maximum offline.
  if (typeof ttl !== 'string' || !/^[1-9][0-9]*[smhd]$/.test(ttl)) {
    throw invalidRequestError('OpenAI Responses prompt cache TTL must be a positive integer duration (e.g. "12h").');
  }
  return { prompt_cache_options: { ttl } };
}

/** Apply after routing has read the unannotated head. */
export function applyResponsesPromptCache(request: OpenAIResponsesAPIRequest, options: JsonObject | undefined): void {
  request.input = responsesPromptCacheInput(request.input);
  delete request.prompt_cache_options;
  Object.assign(request, options);
}
