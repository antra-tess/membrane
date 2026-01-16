/**
 * Context management types
 */

import type { NormalizedMessage, NormalizedResponse, AbortedResponse, GenerationConfig, ToolDefinition } from '../types/index.js';

// ============================================================================
// Cache Marker
// ============================================================================

export interface CacheMarker {
  /** Message ID (from metadata.sourceId) */
  messageId: string;
  
  /** Index in the message array */
  messageIndex: number;
  
  /** Estimated tokens up to this point */
  tokenEstimate: number;
}

// ============================================================================
// Context Config (per-call)
// ============================================================================

export interface ContextConfig {
  /** Rolling configuration */
  rolling: {
    /** Threshold before roll triggers */
    threshold: number;
    
    /** Buffer to leave uncached after roll */
    buffer: number;
    
    /** Grace period before forced roll (optional) */
    grace?: number;
    
    /** Unit for threshold/buffer/grace (default: 'messages') */
    unit?: 'messages' | 'tokens';
  };
  
  /** Hard limits (always enforced) */
  limits?: {
    /** Maximum characters (default: 500000) */
    maxCharacters?: number;
    
    /** Maximum tokens */
    maxTokens?: number;
    
    /** Maximum messages */
    maxMessages?: number;
  };
  
  /** Cache settings */
  cache?: {
    /** Enable caching (default: true) */
    enabled?: boolean;
    
    /** Number of cache points (default: 1, max: 4 for Anthropic) */
    points?: 1 | 2 | 3 | 4;
    
    /** Minimum tokens before caching (default: 1024) */
    minTokens?: number;
    
    /** Prefer user messages for cache markers (OpenRouter workaround) */
    preferUserMessages?: boolean;
  };
  
  /** Custom token estimator (default: chars / 4) */
  tokenEstimator?: (message: NormalizedMessage) => number;
}

// ============================================================================
// Context State (persisted between calls)
// ============================================================================

export interface ContextState {
  /** Current cache markers */
  cacheMarkers: CacheMarker[];
  
  /** Message IDs in current window (for continuity detection) */
  windowMessageIds: string[];
  
  /** Messages since last roll */
  messagesSinceRoll: number;
  
  /** Tokens since last roll */
  tokensSinceRoll: number;
  
  /** Whether we're in grace period */
  inGracePeriod: boolean;
  
  /** Last roll timestamp (ISO string) */
  lastRollTime?: string;
}

// ============================================================================
// Context Input (per-call request)
// ============================================================================

export interface ContextInput {
  /** Conversation messages */
  messages: NormalizedMessage[];
  
  /** System prompt */
  system?: string;
  
  /** Tool definitions */
  tools?: ToolDefinition[];
  
  /** Generation config (model, maxTokens, etc.) */
  config: GenerationConfig;
  
  /** Context management config */
  context: ContextConfig;
}

// ============================================================================
// Context Info (what happened this call)
// ============================================================================

export interface ContextInfo {
  /** Whether a roll occurred */
  didRoll: boolean;
  
  /** Number of messages dropped in roll */
  messagesDropped: number;
  
  /** Number of messages kept */
  messagesKept: number;
  
  /** Current cache markers */
  cacheMarkers: CacheMarker[];
  
  /** Estimated cached tokens */
  cachedTokens: number;
  
  /** Estimated uncached tokens */
  uncachedTokens: number;
  
  /** Total estimated tokens */
  totalTokens: number;
  
  /** Whether hard limit was hit */
  hardLimitHit: boolean;
}

// ============================================================================
// Context Output (result of processContext)
// ============================================================================

export interface ContextOutput {
  /** The LLM response (may be aborted) */
  response: NormalizedResponse | AbortedResponse;

  /** Updated state (save this for next call) */
  state: ContextState;

  /** Info about what happened */
  info: ContextInfo;
}

// ============================================================================
// Stream Options
// ============================================================================

export interface ContextStreamOptions {
  /** Callback for streaming chunks */
  onChunk?: (chunk: string) => void;
  
  /** Abort signal */
  signal?: AbortSignal;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create initial empty state
 */
export function createInitialState(): ContextState {
  return {
    cacheMarkers: [],
    windowMessageIds: [],
    messagesSinceRoll: 0,
    tokensSinceRoll: 0,
    inGracePeriod: false,
  };
}

/**
 * Default token estimator (chars / 4)
 */
export function defaultTokenEstimator(message: NormalizedMessage): number {
  let chars = 0;
  for (const block of message.content) {
    if (block.type === 'text') {
      chars += block.text.length;
    } else if (block.type === 'tool_result') {
      const content = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      chars += content.length;
    } else if (block.type === 'image') {
      // Images: ~1500 tokens regardless of size (Anthropic)
      chars += 6000; // 1500 * 4
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Default context config
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  rolling: {
    threshold: 50,
    buffer: 20,
    unit: 'messages',
  },
  limits: {
    maxCharacters: 500000,
  },
  cache: {
    enabled: true,
    points: 1,
    minTokens: 1024,
    preferUserMessages: true,
  },
};
