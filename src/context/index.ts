/**
 * Context management module
 * 
 * Handles rolling context, cache marker placement, and state management
 * for efficient prompt caching with LLMs.
 */

export { processContext } from './process.js';

// Rolling helpers - can be used standalone by callers doing their own transforms
export {
  shouldRoll,
  truncateMessages,
  placeCacheMarkers,
  applyCacheMarkers,
  calculateCharacters,
} from './process.js';

export type {
  RollDecision,
  MessageWithTokens,
} from './process.js';

export {
  createInitialState,
  defaultTokenEstimator,
  DEFAULT_CONTEXT_CONFIG,
} from './types.js';

export type {
  ContextInput,
  ContextOutput,
  ContextState,
  ContextConfig,
  ContextInfo,
  ContextStreamOptions,
  ContextToolCallback,
  ContextPreToolCallback,
  CacheMarker,
} from './types.js';
