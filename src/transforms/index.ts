/**
 * Transform exports
 */

// Note: transformToPrefill was removed in v0.4.0
// Use formatter.buildMessages() instead (see PrefillFormatter interface)

export {
  transformToChat,
  type ChatTransformResult,
  type ChatTransformOptions,
  type ChatMessage,
  type ChatContent,
} from './chat.js';
