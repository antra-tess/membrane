/**
 * Model capability heuristics that no provider SDK exposes.
 *
 * Same shape as the sampling-parameter lists in the provider adapters
 * (`NO_TEMPERATURE_MODELS` in `providers/anthropic.ts` and
 * `providers/openai.ts`): a prefix table plus a predicate, prefix-matched so
 * dated snapshots are covered, and kept current by hand as models launch.
 * This one lives in the registry rather than in an adapter because request
 * shaping in `Membrane` consults it before any adapter is involved.
 */

/**
 * Anthropic models that REFUSE an assistant message prefill outright.
 *
 * Sending a conversation whose last message is an assistant turn returns
 * HTTP 400 `invalid_request_error`: "This model does not support assistant
 * message prefill. The conversation must end with a user message."
 *
 * Measured live against api.anthropic.com on 2026-08-25 (max_tokens 8,
 * two-message conversation ending in an assistant turn):
 *
 *   - REFUSED (400): claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-7,
 *     claude-opus-4-8, claude-sonnet-5, claude-fable-5.
 *   - ACCEPTED (200): claude-haiku-4-5-20251001, claude-sonnet-4-5. Haiku 4.5
 *     also accepted prefill combined with `thinking.type: 'enabled'` (200),
 *     so the prefill/thinking incompatibility is per-model too, not API law.
 *
 * `claude-opus-5` and `claude-mythos-*` were not reachable on the probe key
 * (404 model not found) and are listed by family with the measured 5-series
 * members. If one of them turns out to accept prefill, delete its prefix —
 * a wrong entry here costs a capable path, not correctness.
 *
 * Older Claude (4.5 and earlier, including 3.x) accepts prefill and must NOT
 * be listed. Nothing outside Anthropic belongs here: the OpenAI, Gemini and
 * Bedrock surfaces have their own prefill stories, and an unlisted model is
 * treated as capable.
 */
const NO_ASSISTANT_PREFILL_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
];

/**
 * Strip the routing prefixes that gateways bolt onto the vendor's own model
 * id, so one prefix table covers direct, OpenRouter and Bedrock spellings:
 * `anthropic/claude-sonnet-4-6` and `us.anthropic.claude-sonnet-4-6-v1:0`
 * both reduce to `claude-sonnet-4-6…`.
 */
function stripRoutingPrefix(model: string): string {
  const afterSlash = model.slice(model.lastIndexOf('/') + 1);
  const vendorMarker = afterSlash.lastIndexOf('anthropic.');
  return vendorMarker === -1
    ? afterSlash
    : afterSlash.slice(vendorMarker + 'anthropic.'.length);
}

/**
 * Whether this model accepts a conversation that ends in an assistant turn.
 *
 * Unknown models are reported as capable: the prefill paths are the legacy
 * default and a false negative would break a working deployment, while a
 * false positive degrades to the raw provider 400 we had before.
 */
export function supportsAssistantPrefill(model: string): boolean {
  const id = stripRoutingPrefix(model);
  return !NO_ASSISTANT_PREFILL_MODELS.some(prefix => id.startsWith(prefix));
}
