/**
 * Context processing - main entry point
 */

import type { Membrane } from '../membrane.js';
import type { NormalizedMessage, NormalizedRequest } from '../types/index.js';
import type {
  ContextInput,
  ContextState,
  ContextOutput,
  ContextInfo,
  ContextConfig,
  ContextStreamOptions,
  CacheMarker,
} from './types.js';
import {
  createInitialState,
  defaultTokenEstimator,
  DEFAULT_CONTEXT_CONFIG,
} from './types.js';

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Process context and stream LLM response.
 * 
 * This function handles:
 * - Rolling/truncation based on thresholds
 * - Cache marker placement for prompt caching
 * - Hard limit enforcement
 * - State management
 * 
 * @param membrane - Configured Membrane instance
 * @param input - Messages, config, and context settings
 * @param state - Previous state (null for first call)
 * @param options - Stream options
 * @returns Response, updated state, and context info
 */
export async function processContext(
  membrane: Membrane,
  input: ContextInput,
  state: ContextState | null,
  options?: ContextStreamOptions
): Promise<ContextOutput> {
  // Merge config with defaults
  const contextConfig = mergeConfig(input.context);
  const tokenEstimator = contextConfig.tokenEstimator ?? defaultTokenEstimator;
  
  // Initialize or continue state
  let currentState = state ?? createInitialState();
  
  // Detect discontinuity (new conversation or branch switch)
  const isDiscontinuous = detectDiscontinuity(input.messages, currentState);
  if (isDiscontinuous) {
    currentState = createInitialState();
  }
  
  // Calculate tokens for all messages
  const messageTokens = input.messages.map(m => ({
    message: m,
    tokens: tokenEstimator(m),
    id: getMessageId(m),
  }));
  
  const totalTokens = messageTokens.reduce((sum, m) => sum + m.tokens, 0);
  const totalCharacters = calculateCharacters(input.messages);
  
  // Determine if we should roll
  const rollDecision = shouldRoll(
    currentState,
    input.messages.length,
    totalTokens,
    totalCharacters,
    contextConfig
  );
  
  // Apply rolling/truncation if needed
  let keptMessages = input.messages;
  let messagesDropped = 0;
  let didRoll = false;
  let hardLimitHit = false;
  
  if (rollDecision.shouldRoll) {
    const truncateResult = truncateMessages(
      messageTokens,
      rollDecision.targetTokens,
      rollDecision.targetMessages,
      contextConfig
    );
    
    keptMessages = truncateResult.kept.map(m => m.message);
    messagesDropped = truncateResult.dropped;
    didRoll = true;
    hardLimitHit = rollDecision.reason === 'hard_limit';
  }
  
  // Recalculate tokens after truncation
  const keptTokens = keptMessages.map(m => ({
    message: m,
    tokens: tokenEstimator(m),
    id: getMessageId(m),
  }));
  const keptTotalTokens = keptTokens.reduce((sum, m) => sum + m.tokens, 0);
  
  // Place cache markers
  const cacheMarkers = placeCacheMarkers(
    keptMessages,
    keptTokens,
    currentState,
    didRoll,
    contextConfig
  );
  
  // Apply cache markers to messages
  const messagesWithCache = applyCacheMarkers(keptMessages, cacheMarkers);
  
  // Calculate cached/uncached tokens
  const lastMarker = cacheMarkers[cacheMarkers.length - 1];
  const cachedTokens = lastMarker?.tokenEstimate ?? 0;
  const uncachedTokens = keptTotalTokens - cachedTokens;
  
  // Build request
  const request: NormalizedRequest = {
    messages: messagesWithCache,
    system: input.system,
    tools: input.tools,
    config: input.config,
  };
  
  // Stream response
  const response = await membrane.stream(request, {
    onChunk: options?.onChunk,
    signal: options?.signal,
  });
  
  // Update state
  const newState: ContextState = {
    cacheMarkers,
    windowMessageIds: keptMessages.map(m => getMessageId(m)),
    messagesSinceRoll: didRoll ? 1 : currentState.messagesSinceRoll + 1,
    tokensSinceRoll: didRoll ? keptTotalTokens : currentState.tokensSinceRoll + keptTotalTokens,
    inGracePeriod: rollDecision.enteredGrace || (currentState.inGracePeriod && !didRoll),
    lastRollTime: didRoll ? new Date().toISOString() : currentState.lastRollTime,
  };
  
  // Build info
  const info: ContextInfo = {
    didRoll,
    messagesDropped,
    messagesKept: keptMessages.length,
    cacheMarkers,
    cachedTokens,
    uncachedTokens,
    totalTokens: keptTotalTokens,
    hardLimitHit,
  };
  
  return { response, state: newState, info };
}

// ============================================================================
// Helper Functions
// ============================================================================

function mergeConfig(config: ContextConfig): ContextConfig {
  return {
    rolling: {
      ...DEFAULT_CONTEXT_CONFIG.rolling,
      ...config.rolling,
    },
    limits: {
      ...DEFAULT_CONTEXT_CONFIG.limits,
      ...config.limits,
    },
    cache: {
      ...DEFAULT_CONTEXT_CONFIG.cache,
      ...config.cache,
    },
    tokenEstimator: config.tokenEstimator,
  };
}

function getMessageId(message: NormalizedMessage): string {
  return message.metadata?.sourceId ?? `msg-${Math.random().toString(36).slice(2)}`;
}

function detectDiscontinuity(
  messages: NormalizedMessage[],
  state: ContextState
): boolean {
  if (state.windowMessageIds.length === 0) {
    return false; // First call, not a discontinuity
  }
  
  const currentIds = new Set(messages.map(m => getMessageId(m)));
  const overlap = state.windowMessageIds.filter(id => currentIds.has(id));
  
  // If less than 50% overlap, consider it a new conversation
  return overlap.length < state.windowMessageIds.length * 0.5;
}

function calculateCharacters(messages: NormalizedMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        chars += block.text.length;
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        chars += content.length;
      }
      // Images not counted for character limits
    }
  }
  return chars;
}

interface RollDecision {
  shouldRoll: boolean;
  reason?: 'threshold' | 'grace_exceeded' | 'hard_limit';
  targetTokens?: number;
  targetMessages?: number;
  enteredGrace: boolean;
}

function shouldRoll(
  state: ContextState,
  messageCount: number,
  totalTokens: number,
  totalCharacters: number,
  config: ContextConfig
): RollDecision {
  const { rolling, limits } = config;
  const unit = rolling.unit ?? 'messages';
  
  const threshold = rolling.threshold;
  const grace = rolling.grace ?? 0;
  const maxThreshold = threshold + grace;
  
  // Check hard limits first (always enforced)
  if (limits?.maxCharacters && totalCharacters > limits.maxCharacters) {
    return {
      shouldRoll: true,
      reason: 'hard_limit',
      targetTokens: limits.maxTokens,
      targetMessages: limits.maxMessages,
      enteredGrace: false,
    };
  }
  
  if (limits?.maxTokens && totalTokens > limits.maxTokens) {
    return {
      shouldRoll: true,
      reason: 'hard_limit',
      targetTokens: limits.maxTokens,
      targetMessages: limits.maxMessages,
      enteredGrace: false,
    };
  }
  
  if (limits?.maxMessages && messageCount > limits.maxMessages) {
    return {
      shouldRoll: true,
      reason: 'hard_limit',
      targetTokens: limits.maxTokens,
      targetMessages: limits.maxMessages,
      enteredGrace: false,
    };
  }
  
  // Check rolling threshold
  const current = unit === 'messages' ? state.messagesSinceRoll : state.tokensSinceRoll;
  
  if (current >= maxThreshold) {
    // Exceeded grace, must roll
    return {
      shouldRoll: true,
      reason: 'grace_exceeded',
      targetTokens: unit === 'tokens' ? threshold : undefined,
      targetMessages: unit === 'messages' ? threshold : undefined,
      enteredGrace: false,
    };
  }
  
  if (!state.inGracePeriod && current >= threshold) {
    // Just entered grace period
    return {
      shouldRoll: false,
      enteredGrace: true,
    };
  }
  
  return {
    shouldRoll: false,
    enteredGrace: false,
  };
}

interface MessageWithTokens {
  message: NormalizedMessage;
  tokens: number;
  id: string;
}

function truncateMessages(
  messages: MessageWithTokens[],
  targetTokens?: number,
  targetMessages?: number,
  config?: ContextConfig
): { kept: MessageWithTokens[]; dropped: number } {
  // Truncate from the beginning, keeping most recent
  
  if (targetMessages && messages.length > targetMessages) {
    const startIdx = messages.length - targetMessages;
    return {
      kept: messages.slice(startIdx),
      dropped: startIdx,
    };
  }
  
  if (targetTokens) {
    let tokenSum = 0;
    let startIdx = messages.length;
    
    // Count from end backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      tokenSum += messages[i]!.tokens;
      if (tokenSum > targetTokens) {
        startIdx = i + 1;
        break;
      }
      startIdx = i;
    }
    
    return {
      kept: messages.slice(startIdx),
      dropped: startIdx,
    };
  }
  
  // Default: use buffer from config
  const buffer = config?.rolling.buffer ?? 20;
  const unit = config?.rolling.unit ?? 'messages';
  
  if (unit === 'messages') {
    const targetCount = Math.max(buffer * 2, messages.length - buffer);
    if (messages.length > targetCount) {
      const startIdx = messages.length - targetCount;
      return {
        kept: messages.slice(startIdx),
        dropped: startIdx,
      };
    }
  }
  
  return { kept: messages, dropped: 0 };
}

function placeCacheMarkers(
  messages: NormalizedMessage[],
  messageTokens: MessageWithTokens[],
  state: ContextState,
  didRoll: boolean,
  config: ContextConfig
): CacheMarker[] {
  const cacheConfig = config.cache ?? {};
  
  if (cacheConfig.enabled === false) {
    return [];
  }
  
  const numPoints = cacheConfig.points ?? 1;
  const minTokens = cacheConfig.minTokens ?? 1024;
  const preferUser = cacheConfig.preferUserMessages ?? true;
  
  const totalTokens = messageTokens.reduce((sum, m) => sum + m.tokens, 0);
  
  // Not enough tokens for caching
  if (totalTokens < minTokens) {
    return [];
  }
  
  // If we didn't roll, try to keep existing markers stable
  if (!didRoll && state.cacheMarkers.length > 0) {
    const currentIds = new Set(messages.map(m => getMessageId(m)));
    const validMarkers = state.cacheMarkers.filter(m => currentIds.has(m.messageId));
    
    if (validMarkers.length > 0) {
      // Recalculate token estimates for valid markers
      return validMarkers.map(marker => {
        const idx = messages.findIndex(m => getMessageId(m) === marker.messageId);
        const tokenEstimate = messageTokens
          .slice(0, idx + 1)
          .reduce((sum, m) => sum + m.tokens, 0);
        
        return {
          messageId: marker.messageId,
          messageIndex: idx,
          tokenEstimate,
        };
      });
    }
  }
  
  // Place new markers using arithmetic positioning
  const markers: CacheMarker[] = [];
  const buffer = config.rolling.buffer ?? 20;
  
  // For single point: place at (length - buffer)
  // For multiple points: distribute evenly in cacheable portion
  const cacheableEnd = Math.max(0, messages.length - buffer);
  
  if (cacheableEnd === 0) {
    return []; // Nothing to cache
  }
  
  // Calculate step size for multiple cache points
  const step = Math.floor(cacheableEnd / numPoints);
  
  if (step === 0) {
    return []; // Not enough messages for requested cache points
  }
  
  let runningTokens = 0;
  let currentIdx = 0;
  
  for (let point = 1; point <= numPoints; point++) {
    const targetIdx = Math.min(point * step - 1, cacheableEnd - 1);
    
    // Accumulate tokens up to target
    while (currentIdx <= targetIdx && currentIdx < messageTokens.length) {
      runningTokens += messageTokens[currentIdx]!.tokens;
      currentIdx++;
    }
    
    let markerIdx = targetIdx;
    let markerTokens = runningTokens;
    
    // Adjust to user message if preferred
    if (preferUser) {
      const adjusted = findNearestUserMessage(messages, markerIdx, messageTokens);
      if (adjusted) {
        markerIdx = adjusted.index;
        markerTokens = adjusted.tokens;
      }
    }
    
    // Skip if below minimum
    if (markerTokens < minTokens) {
      continue;
    }
    
    // Skip if duplicate
    if (markers.some(m => m.messageIndex === markerIdx)) {
      continue;
    }
    
    markers.push({
      messageId: getMessageId(messages[markerIdx]!),
      messageIndex: markerIdx,
      tokenEstimate: markerTokens,
    });
  }
  
  return markers;
}

function findNearestUserMessage(
  messages: NormalizedMessage[],
  startIdx: number,
  messageTokens: MessageWithTokens[]
): { index: number; tokens: number } | null {
  // Search backwards for a user message (non-assistant participant)
  const maxSearch = 5;
  
  let tokens = messageTokens.slice(0, startIdx + 1).reduce((sum, m) => sum + m.tokens, 0);
  
  for (let i = startIdx; i >= Math.max(0, startIdx - maxSearch); i--) {
    const msg = messages[i]!;
    // Heuristic: if participant isn't a common assistant name, it's probably a user
    const participant = msg.participant.toLowerCase();
    const isUser = !['claude', 'assistant', 'bot', 'ai'].includes(participant);
    
    if (isUser) {
      return { index: i, tokens };
    }
    
    tokens -= messageTokens[i]!.tokens;
  }
  
  return null;
}

function applyCacheMarkers(
  messages: NormalizedMessage[],
  cacheMarkers: CacheMarker[]
): NormalizedMessage[] {
  if (cacheMarkers.length === 0) {
    return messages;
  }
  
  const markerIndices = new Set(cacheMarkers.map(m => m.messageIndex));
  
  return messages.map((msg, idx) => {
    if (markerIndices.has(idx)) {
      return {
        ...msg,
        metadata: {
          ...msg.metadata,
          cacheControl: { type: 'ephemeral' as const },
        },
      };
    }
    return msg;
  });
}
