/**
 * Model capability heuristics that no provider SDK exposes.
 *
 * Same shape as the OpenAI adapter's sampling-parameter list
 * (`NO_TEMPERATURE_MODELS` in `providers/openai.ts`): a prefix table plus a
 * predicate, prefix-matched so dated snapshots are covered, and kept current
 * by hand as models launch. The Anthropic adapter's list of that name instead
 * names each model by its id, and an entry doesn't cover later versions.
 * Message adapters consult this shared table against their final built model
 * and body. Formatter/parser prefill on a text-prompt transport is separate.
 */

/**
 * Anthropic models that refuse an assistant message prefill: a conversation
 * whose last message is an assistant turn gets HTTP 400
 * `invalid_request_error`: "This model does not support assistant message
 * prefill. The conversation must end with a user message." The Mythos
 * entries are by family analogy, not measured. Older Claude (4.5 and
 * earlier, including 3.x) accepts prefill and must NOT be listed; Haiku 4.5
 * accepts it with thinking enabled too.
 */
const NO_ASSISTANT_PREFILL_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
];

/**
 * Gateways prefix the vendor's model id: `bedrock:claude-sonnet-4-6`,
 * `anthropic/claude-sonnet-4.6`, `us.anthropic.claude-sonnet-4-6-v1:0`. A
 * Bedrock application inference profile's ARN ends in an opaque profile id,
 * so it matches nothing and is treated as capable.
 */
function stripRoutingPrefix(model: string): string {
  const afterSlash = model.slice(model.lastIndexOf('/') + 1).replace(/^bedrock:/, '');
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
  const id = stripRoutingPrefix(model).replace(/(\d)\.(\d)/g, '$1-$2');
  return !NO_ASSISTANT_PREFILL_MODELS.some(prefix => id.startsWith(prefix));
}
