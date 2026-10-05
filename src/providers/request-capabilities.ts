import type { ProviderRequest, ProviderRequestOptions } from '../types/index.js';
import { unsupportedError } from '../types/errors.js';
import { supportsAssistantPrefill } from '../registry/model-capabilities.js';

/** Called by message transports on their final converted body/model, after
 * native overrides. Parser prefill on a prompt transport is a different fact. */
export function assertMessagePrefillSupported(
  model: unknown,
  messages: unknown,
  options: ProviderRequestOptions | undefined,
  provider: string,
  rawRequest: unknown,
): void {
  const context = options?.requestContext;
  const assistantEnded = Array.isArray(messages) && messages.at(-1)?.role === 'assistant';
  if (!(assistantEnded || context?.requiresAssistantPrefill) || typeof model !== 'string') return;
  if (supportsAssistantPrefill(model)) return;
  const source = context ? 'Formatter "' + context.formatterName + '"' : 'Direct provider input';
  const reason = context?.requiresAssistantPrefill
    ? 'selects an XML continuation protocol that requires assistant prefill'
    : 'produces a request ending in an assistant message';
  throw unsupportedError(
    'Model "' + model + '" does not support assistant prefill on ' + provider + '. '
    + source + ' ' + reason + '. Use native tool mode with a native-capable formatter '
    + '(NativeFormatter or AnthropicXmlFormatter), or choose a prefill-capable model. '
    + 'Native mode preserves caller-authored assistant-ended history; such a history '
    + 'needs a genuine user turn or a prefill-capable model.',
    rawRequest,
  );
}

/** Prompt adapters must not silently discard native tool definitions. A
 * context-bearing XML tool request uses an explicit caller-owned prompt;
 * ordinary normalized-message serialization bypasses formatter tool encoding. */
export function assertPromptToolSupport(
  request: ProviderRequest,
  options: ProviderRequestOptions | undefined,
  provider: string,
  hasExplicitXmlPrompt = false,
): void {
  const context = options?.requestContext;
  const native = Array.isArray(request.tools) && request.tools.length > 0;
  const discarded = context?.toolsDeclared
    && !(context.toolMode === 'xml' && hasExplicitXmlPrompt);
  if (!native && !discarded) return;
  const source = context ? 'Formatter "' + context.formatterName + '"' : 'Direct provider input';
  throw unsupportedError(
    source + ' declares ' + (native ? 'native' : context?.toolMode ?? 'native')
    + ' tools for the ' + provider + ' text-prompt transport. Native tool fields are '
    + 'unsupported; XML tool requests require an explicit prompt with an XML-capable '
    + 'formatter. Use that carrier, a tool-capable transport, or omit tool definitions.',
    request,
  );
}
