export { processContext } from './process.js';

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
  MembraneContextIdentityError,
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
