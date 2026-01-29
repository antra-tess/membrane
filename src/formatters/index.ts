/**
 * Formatter exports
 */

// Export formatter-specific types only (avoid duplicates with types/streaming.js)
export type {
  PrefillFormatter,
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
export { CompletionsFormatter, type CompletionsFormatterConfig } from './completions.js';
