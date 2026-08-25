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
  MembraneContextIdentityError,
} from './types.js';

/**
 * Ceiling on markers this module places, regardless of `cache.points`.
 *
 * Anthropic accepts at most 4 `cache_control` blocks per request, and the
 * request builders spend from that same budget (a system/tools fallback
 * block, the floating tool-loop marker). Nothing reconciles those spends
 * against `cache.points`, so the module keeps one slot free rather than
 * risk a 400 on the default XML path, which always marks the system block.
 */
const MAX_MODULE_CACHE_POINTS = 3;

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
  
  // Stable identity is a precondition, not a nicety: without it every call
  // looks like a new conversation and rolling/caching silently stop working.
  assertStableMessageIds(input.messages);
  
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
      contextConfig,
      rollDecision.targetCharacters
    );
    
    keptMessages = truncateResult.kept.map(m => m.message);
    messagesDropped = truncateResult.dropped;
    // A roll that dropped nothing is not a roll: reporting it as one both
    // lies to the caller and resets the roll counters every call, which is
    // exactly when threshold rolling is needed most.
    didRoll = messagesDropped > 0;
    hardLimitHit = rollDecision.reason === 'hard_limit';
  }
  
  // Recalculate tokens after truncation
  const keptTokens = keptMessages.map(m => ({
    message: m,
    tokens: tokenEstimator(m),
    id: getMessageId(m),
  }));
  const keptTotalTokens = keptTokens.reduce((sum, m) => sum + m.tokens, 0);
  
  // Re-assert the hard limits against the truncated window. The window is
  // floored at one message, so a single oversize message survives every
  // truncation - the caller is told rather than handed an empty array.
  const residualOverflow = measureResidualOverflow(
    keptMessages,
    keptTotalTokens,
    contextConfig
  );
  
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
  
  // Stream response - pass through all options
  const response = await membrane.stream(request, {
    onChunk: options?.onChunk,
    signal: options?.signal,
    onToolCalls: options?.onToolCalls,
    onPreToolContent: options?.onPreToolContent,
    onUsage: options?.onUsage,
    maxToolDepth: options?.maxToolDepth,
  });
  
  // Determine cachedStartMessageId
  // - On roll: use first message ID after truncation (anchor for stable fetches)
  // - No roll: keep existing (maintains fetch window stability)
  const cachedStartMessageId = didRoll
    ? (keptMessages.length > 0 ? getMessageId(keptMessages[0]!) : undefined)
    : currentState.cachedStartMessageId;
  
  // Update state
  const newState: ContextState = {
    cacheMarkers,
    windowMessageIds: keptMessages.map(m => getMessageId(m)),
    messagesSinceRoll: didRoll ? 1 : currentState.messagesSinceRoll + 1,
    tokensSinceRoll: didRoll ? keptTotalTokens : currentState.tokensSinceRoll + keptTotalTokens,
    inGracePeriod: rollDecision.enteredGrace || (currentState.inGracePeriod && !didRoll),
    lastRollTime: didRoll ? new Date().toISOString() : currentState.lastRollTime,
    cachedStartMessageId,
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
    cachedStartMessageId,
    ...(residualOverflow ? { residualOverflow } : {}),
  };
  
  return { response, state: newState, info };
}

// ============================================================================
// Helper Functions
// ============================================================================

function mergeConfig(config: ContextConfig): ContextConfig {
  // The caller's config is the base, so a top-level field is carried through
  // by default and only the three sub-objects that have defaults are merged.
  // Enumerating the survivors instead silently dropped assistantParticipant:
  // every helper test passed a config straight in, so the loss was invisible
  // until an end-to-end call classified the configured assistant as a user.
  return {
    ...config,
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
  };
}

function getMessageId(message: NormalizedMessage): string {
  return message.metadata?.sourceId ?? `msg-${Math.random().toString(36).slice(2)}`;
}

function assertStableMessageIds(messages: NormalizedMessage[]): void {
  const messageIndicesWithoutSourceId: number[] = [];
  
  messages.forEach((message, index) => {
    const sourceId = message.metadata?.sourceId;
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      messageIndicesWithoutSourceId.push(index);
    }
  });
  
  if (messageIndicesWithoutSourceId.length === 0) {
    return;
  }
  
  const shown = messageIndicesWithoutSourceId.slice(0, 10).join(', ');
  const ellipsis = messageIndicesWithoutSourceId.length > 10 ? ', ...' : '';
  throw new MembraneContextIdentityError(
    `processContext requires stable message identity: ` +
    `${messageIndicesWithoutSourceId.length} of ${messages.length} messages carry no ` +
    `metadata.sourceId (indices ${shown}${ellipsis}). Without it every call is detected ` +
    `as a new conversation, so the roll threshold never accumulates, cache markers never ` +
    `stay stable, and cachedStartMessageId is meaningless. Populate metadata.sourceId ` +
    `with the originating system's message id.`,
    messageIndicesWithoutSourceId
  );
}

function measureResidualOverflow(
  keptMessages: NormalizedMessage[],
  keptTotalTokens: number,
  config: ContextConfig
): ContextInfo['residualOverflow'] {
  const limits = config.limits;
  if (!limits) {
    return undefined;
  }
  
  if (limits.maxCharacters) {
    const keptCharacters = calculateCharacters(keptMessages);
    if (keptCharacters > limits.maxCharacters) {
      return { unit: 'characters', limit: limits.maxCharacters, actual: keptCharacters };
    }
  }
  
  if (limits.maxTokens && keptTotalTokens > limits.maxTokens) {
    return { unit: 'tokens', limit: limits.maxTokens, actual: keptTotalTokens };
  }
  
  if (limits.maxMessages && keptMessages.length > limits.maxMessages) {
    return { unit: 'messages', limit: limits.maxMessages, actual: keptMessages.length };
  }
  
  return undefined;
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

export function calculateCharacters(messages: NormalizedMessage[]): number {
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

export interface RollDecision {
  shouldRoll: boolean;
  reason?: 'threshold' | 'grace_exceeded' | 'hard_limit';
  targetTokens?: number;
  targetMessages?: number;
  /** Character budget the kept window must fit (set by the maxCharacters limit). */
  targetCharacters?: number;
  enteredGrace: boolean;
}

export function shouldRoll(
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
      targetCharacters: limits.maxCharacters,
      enteredGrace: false,
    };
  }
  
  if (limits?.maxTokens && totalTokens > limits.maxTokens) {
    return {
      shouldRoll: true,
      reason: 'hard_limit',
      targetTokens: limits.maxTokens,
      targetMessages: limits.maxMessages,
      targetCharacters: limits.maxCharacters,
      enteredGrace: false,
    };
  }
  
  if (limits?.maxMessages && messageCount > limits.maxMessages) {
    return {
      shouldRoll: true,
      reason: 'hard_limit',
      targetTokens: limits.maxTokens,
      targetMessages: limits.maxMessages,
      targetCharacters: limits.maxCharacters,
      enteredGrace: false,
    };
  }
  
  // Check rolling threshold against the MEASURED window. state.messagesSinceRoll
  // counts calls (not messages) and state.tokensSinceRoll re-adds the whole
  // window every call, so both cross any threshold as a function of call count
  // alone; they stay as telemetry and no longer decide the roll.
  const current = unit === 'messages' ? messageCount : totalTokens;
  
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

export interface MessageWithTokens {
  message: NormalizedMessage;
  tokens: number;
  id: string;
}

export function truncateMessages(
  messages: MessageWithTokens[],
  targetTokens?: number,
  targetMessages?: number,
  config?: ContextConfig,
  targetCharacters?: number
): { kept: MessageWithTokens[]; dropped: number } {
  // Truncate from the beginning, keeping most recent.
  // Every supplied target contributes a candidate start index; the window has
  // to satisfy all of them, so the deepest cut wins.
  
  if (messages.length === 0) {
    return { kept: messages, dropped: 0 };
  }
  
  const candidateStartIndices: number[] = [];
  
  if (targetMessages !== undefined && messages.length > targetMessages) {
    candidateStartIndices.push(messages.length - targetMessages);
  }
  
  if (targetTokens !== undefined) {
    candidateStartIndices.push(
      startIndexForBudget(messages, targetTokens, m => m.tokens)
    );
  }
  
  if (targetCharacters !== undefined) {
    candidateStartIndices.push(
      startIndexForBudget(messages, targetCharacters, m => calculateCharacters([m.message]))
    );
  }
  
  if (candidateStartIndices.length === 0) {
    // Default: use buffer from config
    const buffer = config?.rolling.buffer ?? 20;
    const unit = config?.rolling.unit ?? 'messages';
    
    if (unit === 'messages') {
      const targetCount = Math.max(buffer * 2, messages.length - buffer);
      if (messages.length > targetCount) {
        candidateStartIndices.push(messages.length - targetCount);
      }
    }
  }
  
  if (candidateStartIndices.length === 0) {
    return { kept: messages, dropped: 0 };
  }
  
  let startIdx = Math.max(0, ...candidateStartIndices);
  
  // Never open the window on a tool_result whose tool_use was just dropped:
  // the wire-level normalizer only covers two of the four request builders,
  // and the default (XML prefill) path ships the orphan verbatim.
  startIdx = snapStartIndexToCycleBoundary(messages, startIdx);
  
  // Floor the kept window at one message. An empty messages[] is rejected by
  // every provider; residual overflow is reported through ContextInfo instead.
  startIdx = Math.min(startIdx, messages.length - 1);
  
  return {
    kept: messages.slice(startIdx),
    dropped: startIdx,
  };
}

/**
 * Walk backwards from the newest message, accumulating cost, and return the
 * first index whose window fits the budget. Mirrors the original token walk:
 * the message that tips the sum past the budget is excluded.
 */
function startIndexForBudget(
  messages: MessageWithTokens[],
  budget: number,
  costOf: (message: MessageWithTokens) => number
): number {
  let sum = 0;
  let startIdx = messages.length;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    sum += costOf(messages[i]!);
    if (sum > budget) {
      return i + 1;
    }
    startIdx = i;
  }
  
  return startIdx;
}

/**
 * Advance a truncation start index past any message that would open the kept
 * window with an unmatched tool_result, so the cut lands on a clean
 * tool-cycle boundary. Only the head can be orphaned by a front cut, so the
 * scan stops at the first message that references no unseen tool_use.
 */
function snapStartIndexToCycleBoundary(
  messages: MessageWithTokens[],
  startIdx: number
): number {
  if (startIdx <= 0 || startIdx >= messages.length) {
    return startIdx;
  }
  
  let idx = startIdx;
  
  while (idx < messages.length && opensWithOrphanToolResult(messages[idx]!.message)) {
    idx++;
  }
  
  return idx;
}

function opensWithOrphanToolResult(message: NormalizedMessage): boolean {
  const toolUseIdsSeenInMessage = new Set<string>();
  
  for (const block of message.content) {
    if (block.type === 'tool_use') {
      toolUseIdsSeenInMessage.add(block.id);
    }
    if (block.type === 'tool_result' && !toolUseIdsSeenInMessage.has(block.toolUseId)) {
      return true;
    }
  }
  
  return false;
}

export function placeCacheMarkers(
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
  
  const numPoints = Math.min(cacheConfig.points ?? 1, MAX_MODULE_CACHE_POINTS);
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
      const adjusted = findNearestUserMessage(
        messages,
        markerIdx,
        messageTokens,
        config.assistantParticipant
      );
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

/** Assistant names assumed when the deployment configures none. */
const LEGACY_ASSISTANT_PARTICIPANTS = ['claude', 'assistant', 'bot', 'ai'];

function findNearestUserMessage(
  messages: NormalizedMessage[],
  startIdx: number,
  messageTokens: MessageWithTokens[],
  assistantParticipant?: string
): { index: number; tokens: number } | null {
  // Search backwards for a user message (non-assistant participant)
  const maxSearch = 5;
  
  // A deployment whose assistant is named anything else (Sol, a persona name)
  // had every assistant turn classified as a user turn by the legacy list.
  const assistantNames = assistantParticipant
    ? [assistantParticipant.toLowerCase()]
    : LEGACY_ASSISTANT_PARTICIPANTS;
  
  let tokens = messageTokens.slice(0, startIdx + 1).reduce((sum, m) => sum + m.tokens, 0);
  
  for (let i = startIdx; i >= Math.max(0, startIdx - maxSearch); i--) {
    const msg = messages[i]!;
    // Heuristic: if participant isn't a known assistant name, it's probably a
    // user. A message with no participant at all (role-shaped producers) falls
    // through the same way rather than crashing the whole call.
    const participant = typeof msg.participant === 'string'
      ? msg.participant.toLowerCase()
      : '';
    const isUser = !assistantNames.includes(participant);
    
    if (isUser) {
      return { index: i, tokens };
    }
    
    tokens -= messageTokens[i]!.tokens;
  }
  
  return null;
}

export function applyCacheMarkers(
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
        // cacheBreakpoint is the field every request builder reads; the
        // metadata.cacheControl write has no reader inside membrane and is
        // kept only for external consumers that may already read it.
        cacheBreakpoint: true,
        metadata: {
          ...msg.metadata,
          cacheControl: { type: 'ephemeral' as const },
        },
      };
    }
    return msg;
  });
}
