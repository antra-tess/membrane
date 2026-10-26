import type { NormalizedMessage, NormalizedResponse, AbortedResponse, GenerationConfig, ToolDefinition } from '../types/index.js';

export interface CacheMarker {
  /** Message ID (from metadata.sourceId) */
  messageId: string;
  
  /** Index in the message array */
  messageIndex: number;
  
  /** Estimated tokens up to this point */
  tokenEstimate: number;
}

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
  
  /**
   * Hard limits, checked on every call. Truncation to meet them keeps at least
   * the newest message and doesn't split a tool call from its result where it
   * can avoid it, so the window can still exceed a limit, which
   * `ContextInfo.residualOverflow` then reports.
   */
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
    
    /** Number of cache points (default: 1); the module places at most 3 */
    points?: 1 | 2 | 3 | 4;
    
    /** Minimum tokens before caching (default: 1024) */
    minTokens?: number;
    
    /** Prefer user messages for cache markers (OpenRouter workaround) */
    preferUserMessages?: boolean;
  };
  
  /**
   * Participant name this deployment's assistant speaks as (membrane's own
   * `assistantParticipant`). Used by the `preferUserMessages` adjustment to
   * tell an assistant turn from a user turn. When unset, the legacy name
   * list (`claude`/`assistant`/`bot`/`ai`) is used.
   */
  assistantParticipant?: string;

  /** Custom token estimator (default: chars / 4) */
  tokenEstimator?: (message: NormalizedMessage) => number;
}

/**
 * Thrown by `processContext` when messages do not carry stable identity: the
 * module keys continuity detection, marker stability and the
 * `cachedStartMessageId` fetch anchor off `metadata.sourceId`.
 */
export class MembraneContextIdentityError extends Error {
  constructor(
    message: string,
    public readonly messageIndices: readonly number[]
  ) {
    super(message);
    this.name = 'MembraneContextIdentityError';
  }
}

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
  
  /**
   * First message ID of the cached window.
   *
   * Use this to anchor your message fetch window - fetch from this message ID
   * onwards to ensure cache stability. It changes when a roll occurs, and is
   * unset when a new conversation or branch switch resets the state, until the
   * next roll.
   */
  cachedStartMessageId?: string;
}

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

  /**
   * Set when the window still exceeds a limit after truncation. The kept
   * window is floored at one message, so a single oversize message cannot
   * be truncated away — it is reported here instead of shipping an empty
   * `messages` array.
   */
  residualOverflow?: {
    unit: 'characters' | 'tokens' | 'messages';
    limit: number;
    actual: number;
  };
  
  /** First message ID of the cached window. */
  cachedStartMessageId?: string;
}

export interface ContextOutput {
  /** The LLM response (may be aborted) */
  response: NormalizedResponse | AbortedResponse;

  /** Updated state (save this for next call) */
  state: ContextState;

  /** Info about what happened */
  info: ContextInfo;
}

import type { ToolCall, ToolResult, ToolContext } from '../types/tools.js';
import type { BasicUsage } from '../types/response.js';

/**
 * Callback for tool execution within processContext.
 * Return tool results to continue the stream; throw to abort.
 */
export type ContextToolCallback = (
  calls: ToolCall[],
  context: ToolContext
) => Promise<ToolResult[]>;

/**
 * Callback for pre-tool content notification.
 * Called with content that appeared before tool calls.
 */
export type ContextPreToolCallback = (content: string) => Promise<void> | void;

export interface ContextStreamOptions {
  /** Callback for streaming chunks */
  onChunk?: (chunk: string) => void;
  
  /** Abort signal */
  signal?: AbortSignal;
  
  /** 
   * Called when tool calls are detected; return results to continue.
   * If not provided, tool calls are not executed (stream stops at tool_use).
   */
  onToolCalls?: ContextToolCallback;
  
  /**
   * Called with content before tool calls (for UI preview / progressive display).
   */
  onPreToolContent?: ContextPreToolCallback;
  
  /**
   * Called with usage updates during streaming.
   */
  onUsage?: (usage: BasicUsage) => void;
  
  /** Maximum tool execution depth (default: 10). */
  maxToolDepth?: number;
}

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
    cachedStartMessageId: undefined,
  };
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_TOKENS = 1500;

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
      chars += ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
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
