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

export function supportsAssistantPrefill(model: string): boolean {
  const id = stripRoutingPrefix(model).replace(/(\d)\.(\d)/g, '$1-$2');
  return !NO_ASSISTANT_PREFILL_MODELS.some(prefix => id.startsWith(prefix));
}

/**
 * Claude models that refuse a `system_change` block that changes tools or
 * system text: a request carrying one gets a 400 that `isSystemChangeRefusal`
 * knows. Sonnet 5, Opus 4.7, 4.6 and 4.5, Sonnet 4.6 and 4.5 and Haiku 4.5
 * refused one in runs in October 2026, and the Claude models before them are
 * taken to refuse, unrun. A model row names that model, its `-0` alias and
 * its dated, Vertex and gateway ids, but not a later minor version; a family
 * row names every model of its generation. A model that no row names is taken to take one,
 * so a new model is tried.
 */
const NO_TOOL_OR_SYSTEM_CHANGE_MODELS = [
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
];
const NO_TOOL_OR_SYSTEM_CHANGE_FAMILIES = ['claude-instant', 'claude-v1', 'claude-1', 'claude-2', 'claude-3'];

export function modelTakesToolOrSystemChanges(model: string): boolean {
  const id = stripRoutingPrefix(model).replace(/(\d)\.(\d)/g, '$1-$2');
  const after = (prefix: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : undefined);
  const namesModel = (prefix: string) => {
    const rest = after(prefix);
    if (rest === '') return true;
    if (rest === undefined || !/^[-@:]/.test(rest)) return false;
    const number = /^-(\d+)(?!\d)/.exec(rest)?.[1];
    return number === undefined || number === '0' || number.length === 8;
  };
  const namesFamily = (prefix: string) => {
    const rest = after(prefix);
    return rest === '' || (rest !== undefined && /^[-@:]/.test(rest));
  };
  return !NO_TOOL_OR_SYSTEM_CHANGE_MODELS.some(namesModel) && !NO_TOOL_OR_SYSTEM_CHANGE_FAMILIES.some(namesFamily);
}
