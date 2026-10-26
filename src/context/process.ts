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

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;
const CACHE_CONTROL_SLOTS_LEFT_TO_REQUEST_BUILDERS = 1;
const MAX_MODULE_CACHE_POINTS = ANTHROPIC_CACHE_CONTROL_LIMIT - CACHE_CONTROL_SLOTS_LEFT_TO_REQUEST_BUILDERS;

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
  const contextConfig = mergeConfig(input.context);
  const tokenEstimator = contextConfig.tokenEstimator ?? defaultTokenEstimator;
  
  assertStableMessageIds(input.messages);
  
  let currentState = state ?? createInitialState();
  
  const isDiscontinuous = detectDiscontinuity(input.messages, currentState);
  if (isDiscontinuous) {
    currentState = createInitialState();
  }
  
  const messageTokens = input.messages.map(m => ({
    message: m,
    tokens: tokenEstimator(m),
    id: getMessageId(m),
  }));
  
  const totalTokens = messageTokens.reduce((sum, m) => sum + m.tokens, 0);
  const totalCharacters = calculateCharacters(input.messages);
  
  const rollDecision = shouldRoll(
    currentState,
    input.messages.length,
    totalTokens,
    totalCharacters,
    contextConfig
  );
  
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
    didRoll = messagesDropped > 0;
    hardLimitHit = rollDecision.reason === 'hard_limit';
  }
  
  const keptTokens = keptMessages.map(m => ({
    message: m,
    tokens: tokenEstimator(m),
    id: getMessageId(m),
  }));
  const keptTotalTokens = keptTokens.reduce((sum, m) => sum + m.tokens, 0);
  
  const residualOverflow = measureResidualOverflow(
    keptMessages,
    keptTotalTokens,
    contextConfig
  );
  
  const cacheMarkers = placeCacheMarkers(
    keptMessages,
    keptTokens,
    currentState,
    didRoll,
    contextConfig
  );
  
  const messagesWithCache = applyCacheMarkers(keptMessages, cacheMarkers);
  
  const lastMarker = cacheMarkers[cacheMarkers.length - 1];
  const cachedTokens = lastMarker?.tokenEstimate ?? 0;
  const uncachedTokens = keptTotalTokens - cachedTokens;
  
  const request: NormalizedRequest = {
    messages: messagesWithCache,
    system: input.system,
    tools: input.tools,
    config: input.config,
  };
  
  const response = await membrane.stream(request, {
    onChunk: options?.onChunk,
    signal: options?.signal,
    onToolCalls: options?.onToolCalls,
    onPreToolContent: options?.onPreToolContent,
    onUsage: options?.onUsage,
    maxToolDepth: options?.maxToolDepth,
  });
  
  const cachedStartMessageId = didRoll
    ? (keptMessages.length > 0 ? getMessageId(keptMessages[0]!) : undefined)
    : currentState.cachedStartMessageId;
  
  const newState: ContextState = {
    cacheMarkers,
    windowMessageIds: keptMessages.map(m => getMessageId(m)),
    messagesSinceRoll: didRoll ? 1 : currentState.messagesSinceRoll + 1,
    tokensSinceRoll: didRoll ? keptTotalTokens : currentState.tokensSinceRoll + keptTotalTokens,
    inGracePeriod: rollDecision.enteredGrace || (currentState.inGracePeriod && !didRoll),
    lastRollTime: didRoll ? new Date().toISOString() : currentState.lastRollTime,
    cachedStartMessageId,
  };
  
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

function mergeConfig(config: ContextConfig): ContextConfig {
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
    return false;
  }
  
  const currentIds = new Set(messages.map(m => getMessageId(m)));
  const overlap = state.windowMessageIds.filter(id => currentIds.has(id));
  
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
    }
  }
  return chars;
}

export interface RollDecision {
  shouldRoll: boolean;
  reason?: 'threshold' | 'grace_exceeded' | 'hard_limit';
  targetTokens?: number;
  targetMessages?: number;
  /** Character budget the kept window is truncated toward (the maxCharacters limit). */
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
  
  const current = unit === 'messages' ? messageCount : totalTokens;
  
  if (current >= maxThreshold) {
    return {
      shouldRoll: true,
      reason: 'grace_exceeded',
      targetTokens: unit === 'tokens' ? threshold : undefined,
      targetMessages: unit === 'messages' ? threshold : undefined,
      enteredGrace: false,
    };
  }
  
  if (!state.inGracePeriod && current >= threshold) {
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
  
  const startIdx = resolveWindowStart(messages, Math.max(0, ...candidateStartIndices));
  
  return {
    kept: messages.slice(startIdx),
    dropped: startIdx,
  };
}

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

function resolveWindowStart(
  messages: MessageWithTokens[],
  desiredStartIdx: number
): number {
  const lastIdx = messages.length - 1;
  
  if (desiredStartIdx <= 0) {
    return 0;
  }
  
  const windowIsCleanAt = markCleanWindowStarts(messages);
  const cappedStartIdx = Math.min(desiredStartIdx, lastIdx);
  
  for (let idx = cappedStartIdx; idx <= lastIdx; idx++) {
    if (windowIsCleanAt[idx]) {
      return idx;
    }
  }
  
  for (let idx = cappedStartIdx - 1; idx >= 0; idx--) {
    if (windowIsCleanAt[idx]) {
      return idx;
    }
  }
  
  return cappedStartIdx;
}

function markCleanWindowStarts(messages: MessageWithTokens[]): boolean[] {
  const windowIsCleanAt = new Array<boolean>(messages.length).fill(false);
  const resultIdsAwaitingTheirCall = new Set<string>();
  
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const callIdsInMessage = new Set<string>();
    const resultIdsNeedingAnEarlierCall: string[] = [];
    
    for (const block of messages[idx]!.message.content) {
      if (block.type === 'tool_use') {
        callIdsInMessage.add(block.id);
      } else if (block.type === 'tool_result' && !callIdsInMessage.has(block.toolUseId)) {
        resultIdsNeedingAnEarlierCall.push(block.toolUseId);
      }
    }
    
    for (const callId of callIdsInMessage) {
      resultIdsAwaitingTheirCall.delete(callId);
    }
    for (const resultId of resultIdsNeedingAnEarlierCall) {
      resultIdsAwaitingTheirCall.add(resultId);
    }
    
    windowIsCleanAt[idx] = resultIdsAwaitingTheirCall.size === 0;
  }
  
  return windowIsCleanAt;
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
  
  if (totalTokens < minTokens) {
    return [];
  }
  
  if (!didRoll && state.cacheMarkers.length > 0) {
    const currentIds = new Set(messages.map(m => getMessageId(m)));
    const validMarkers = state.cacheMarkers.filter(m => currentIds.has(m.messageId));
    
    if (validMarkers.length > 0) {
      const retainedMarkers = validMarkers
        .map(marker => {
          const idx = messages.findIndex(m => getMessageId(m) === marker.messageId);
          const tokenEstimate = messageTokens
            .slice(0, idx + 1)
            .reduce((sum, m) => sum + m.tokens, 0);
          
          return {
            messageId: marker.messageId,
            messageIndex: idx,
            tokenEstimate,
          };
        })
        .sort((a, b) => a.messageIndex - b.messageIndex);
      
      return retainedMarkers.slice(-MAX_MODULE_CACHE_POINTS);
    }
  }
  
  const markers: CacheMarker[] = [];
  const buffer = config.rolling.buffer ?? 20;
  
  const cacheableEnd = Math.max(0, messages.length - buffer);
  
  if (cacheableEnd === 0) {
    return [];
  }
  
  const step = Math.floor(cacheableEnd / numPoints);
  
  if (step === 0) {
    return [];
  }
  
  let runningTokens = 0;
  let currentIdx = 0;
  
  for (let point = 1; point <= numPoints; point++) {
    const targetIdx = Math.min(point * step - 1, cacheableEnd - 1);
    
    while (currentIdx <= targetIdx && currentIdx < messageTokens.length) {
      runningTokens += messageTokens[currentIdx]!.tokens;
      currentIdx++;
    }
    
    let markerIdx = targetIdx;
    let markerTokens = runningTokens;
    
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
    
    if (markerTokens < minTokens) {
      continue;
    }
    
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

const LEGACY_ASSISTANT_PARTICIPANTS = ['claude', 'assistant', 'bot', 'ai'];

function findNearestUserMessage(
  messages: NormalizedMessage[],
  startIdx: number,
  messageTokens: MessageWithTokens[],
  assistantParticipant?: string
): { index: number; tokens: number } | null {
  const maxSearch = 5;
  
  const assistantNames = assistantParticipant
    ? [assistantParticipant.toLowerCase()]
    : LEGACY_ASSISTANT_PARTICIPANTS;
  
  let tokens = messageTokens.slice(0, startIdx + 1).reduce((sum, m) => sum + m.tokens, 0);
  
  for (let i = startIdx; i >= Math.max(0, startIdx - maxSearch); i--) {
    const msg = messages[i]!;
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
