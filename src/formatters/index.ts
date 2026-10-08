/**
 * Formatter exports
 */

// Export formatter-specific types only (avoid duplicates with types/streaming.js)
export type {
  PrefillFormatter,
  ContentParseContext,
  StreamParser,
  FormatterConfig,
  BuildOptions,
  BuildResult,
  ParseResult,
  BlockType,
  ProviderMessage,
} from './types.js';

export { AnthropicXmlFormatter, type AnthropicXmlFormatterConfig } from './anthropic-xml.js';
export { NativeFormatter, type NativeFormatterConfig } from './native.js';
export {
  OpenAIResponsesFormatter,
  OPENAI_RESPONSES_ITEMS_METADATA_KEY,
} from './openai-responses.js';
export { CompletionsFormatter, type CompletionsFormatterConfig } from './completions.js';

export {
  normalizeToolPairs,
  assertToolPairsValid,
  MembraneNormalizerError,
  type NormalizeOptions,
  type NormalizeResult,
  type ProviderBlock,
} from './normalize-tool-pairs.js';
export type { NormalizeEvent } from './types.js';
