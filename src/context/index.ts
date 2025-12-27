/**
 * Context management module
 * 
 * Handles rolling context, cache marker placement, and state management
 * for efficient prompt caching with LLMs.
 */

export { processContext } from './process.js';

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
  CacheMarker,
} from './types.js';
