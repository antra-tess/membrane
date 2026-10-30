import { restoreToolName, toolsOffered } from './utils/tool-names.js';
import { toolUseInputFromValue } from './providers/utils.js';
import { StreamedThinking } from './utils/streamed-thinking.js';
import { LocalStopSequences, firstStop, membraneBlockType } from './utils/local-stop-sequences.js';

import type {
  NormalizedRequest,
  NormalizedResponse,
  AbortedResponse,
  ContentBlock,
  ProviderAdapter,
  ProviderResponse,
  ProviderInputTransformation,
  NormalizedMessage,
  StreamCallbacks,
  ModelRegistry,
  MembraneConfig,
  MembraneLogger,
  StreamOptions,
  CompleteOptions,
  BasicUsage,
  DetailedUsage,
  DiscardedAttemptsUsage,
  StopReason,
  StopInfo,
  ResponseAnomaly,
  TimingInfo,
  CacheInfo,
  ToolCall,
  ToolResult,
  ToolContext,
  ToolUseContent,
  RetryConfig,
  ToolDefinition,
  ErrorInfo,
} from './types/index.js';
import { lastCacheableBlockIndex } from './formatters/native.js';
import {
  sameThinkingText,
  findSpanningProviderRun,
  thinkingCarrierKey,
  stripThinkingForPrefill,
} from './utils/thinking-carriers.js';
import {
  assertCacheMarkersWithinLimit,
  collectMarkedBlocks,
  countWireCacheMarkers,
  clampCacheMarkers,
  ownMessageBlocks,
  ownSystemBlocks,
  wireBlocksInOrder,
  MAX_CACHE_BREAKPOINTS,
} from './utils/cache-marker-budget.js';
import {
  DEFAULT_RETRY_CONFIG,
  MembraneError,
  MembraneNotReadyError,
  classifyError,
  isTypedAbortError,
  withRawRequest,
  isTimeoutAbortError,
  isTextContent,
  isAbortedResponse,
  unsupportedError,
} from './types/index.js';
import type { BuildResult } from './formatters/types.js';
import { computeCacheWireReceipt } from './cache-wire-receipt.js';
import { awaitCallerCode, runCallerCode, isDeadlineExpiry, errorFromThrown, systemChangeRefusedError } from './types/errors.js';
import { createProgressDeadline, setLongTimeout } from './providers/utils.js';
import { resolveProgressBounds, type ProgressBounds } from './progress-bounds.js';
import {
  parseToolCalls,
  formatToolResults,
  parseAccumulatedIntoBlocks,
  endsWithPartialToolBlock,
  hasImageInToolResults,
  formatToolResultsForSplitTurn,
  attachSplitResults,
  type ProviderImageBlock,
  type SplitResultsRound,
} from './utils/tool-parser.js';
import { IncrementalXmlParser, type ProcessChunkResult } from './utils/stream-parser.js';
import type { ChunkMeta, BlockEvent, MembraneBlockType, MembraneBlock } from './types/streaming.js';
import type {
  YieldingStream,
  YieldingStreamOptions,
  StreamEvent,
  ToolCallsEvent,
  RoundReport,
  RoundUsage,
  ThinkingBindingEntry,
} from './types/yielding-stream.js';
import type { PrefillFormatter, StreamParser } from './formatters/types.js';
import { AnthropicXmlFormatter } from './formatters/anthropic-xml.js';
import {
  normalizeToolPairs,
  mergeConsecutiveRoles,
  MembraneNormalizerError,
  PREFIX_REWRITING_NORMALIZE_EVENT_KINDS,
} from './formatters/normalize-tool-pairs.js';
import { YieldingStreamImpl } from './yielding-stream.js';
import { classifyFailure, membraneRetrySettings, retryDecision, type RetrySettings } from './retry.js';
import { calculateCost, warnUnpricedModel } from './utils/cost.js';
import { isAnthropicServerBlock } from './utils/anthropic-server-blocks.js';
import {
  TurnUsageAccumulator,
  calculateCacheHitRatio,
  normalizeUsageToCacheExcluded,
  warnUnconvertibleProviderItem,
} from './utils/usage.js';
import {
  shedImagesToFitByteBudget, assertWithinByteBudget,
} from './utils/image-media.js';
import { convertMcpMedia } from './utils/mcp-media.js';
import { getDefaultPricing } from './registry/default-pricing.js';
import { FidelityNotes, isRawItemCarrier, requestFingerprint, type MessageOrigin } from './utils/fidelity.js';

/** Anthropic's thinking-binding controls, as a thinking config carries them. */
type BlockBindingParam = { prefix_mismatch_behavior: 'error' | 'drop_block' };
type ThinkingDisplay = 'summarized' | 'omitted' | 'updates';

interface ReceivedBlock {
  index?: number;
  start?: Record<string, unknown>;
  final?: unknown;
  streamed: string;
  signature?: string;
}

class NativeBlockTracker {
  currentType: MembraneBlockType = 'text';
  blockIndex = 0;
  private readonly started = new Map<number, MembraneBlockType>();
  private readonly completed = new Set<number>();
  private readonly lastSeen = new Map<number, unknown>();
  private received: ReceivedBlock[] = [];
  private readonly receivedByIndex = new Map<number, ReceivedBlock>();

  constructor(
    private readonly emit: ((event: BlockEvent) => void) | undefined,
    private readonly restoreName?: (name: string) => string,
  ) {}

  onProviderBlock(index: number, block: unknown): void {
    const type = (block as { type?: string } | undefined)?.type;
    if (type === 'image' || type === 'generated_image') {
      this.record(index, block, true);
      return;
    }
    this.lastSeen.set(index, block);
    if (!this.started.has(index)) {
      const mbType = membraneBlockType(type);
      this.started.set(index, mbType);
      this.currentType = mbType;
      this.blockIndex = index;
      this.record(index, block, false);
      this.emit?.({ event: 'block_start', index, block: { type: mbType } });
      return;
    }
    this.record(index, block, true);
    this.complete(index, block);
  }

  onThinkingSignature(index: number, signature: string): void {
    const entry = this.receivedByIndex.get(index);
    if (entry && entry.final === undefined) entry.signature = signature;
  }

  onChunk(chunk: string): void {
    const open = this.started.has(this.blockIndex) && !this.completed.has(this.blockIndex)
      ? this.receivedByIndex.get(this.blockIndex)
      : undefined;
    if (open) {
      open.streamed += chunk;
      return;
    }
    const last = this.received[this.received.length - 1];
    if (last && last.index === undefined) last.streamed += chunk;
    else this.received.push({ streamed: chunk });
  }

  partialContent(): unknown[] {
    const blocks: unknown[] = [];
    for (const entry of this.received) {
      if (entry.final !== undefined) {
        blocks.push(entry.final);
      } else if (entry.index === undefined) {
        if (entry.streamed) blocks.push({ type: 'text', text: entry.streamed });
      } else if (entry.start?.type === 'text') {
        if (entry.streamed) blocks.push({ ...entry.start, text: entry.streamed });
      } else if (entry.start?.type === 'thinking') {
        blocks.push({
          ...entry.start,
          ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
          thinking: entry.streamed,
        });
      } else if (entry.start?.type === 'redacted_thinking') {
        blocks.push({ ...entry.start });
      }
    }
    return blocks;
  }

  flushAfterProviderReturn(): void {
    for (const index of this.started.keys()) {
      if (!this.completed.has(index)) this.complete(index, this.lastSeen.get(index));
    }
  }

  reset(): void {
    this.currentType = 'text';
    this.blockIndex = 0;
    this.started.clear();
    this.completed.clear();
    this.lastSeen.clear();
    this.received = [];
    this.receivedByIndex.clear();
  }

  private record(index: number, block: unknown, finished: boolean): void {
    const payload = block && typeof block === 'object' ? { ...(block as Record<string, unknown>) } : undefined;
    let entry = this.receivedByIndex.get(index);
    if (!entry) {
      entry = { index, streamed: '' };
      this.receivedByIndex.set(index, entry);
      this.received.push(entry);
    }
    if (finished) entry.final = payload ?? block;
    else entry.start = payload;
  }

  private complete(index: number, block: unknown): void {
    if (this.completed.has(index)) return;
    this.completed.add(index);
    const mbType = this.started.get(index) ?? membraneBlockType((block as { type?: string } | undefined)?.type);
    const apiBlock = block as {
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    } | undefined;
    const mb: MembraneBlock = { type: mbType };
    if (mbType === 'text') mb.content = apiBlock?.text;
    else if (mbType === 'thinking') mb.content = apiBlock?.thinking;
    else if (mbType === 'tool_call') {
      mb.toolId = apiBlock?.id;
      mb.toolName = apiBlock?.name !== undefined && this.restoreName ? this.restoreName(apiBlock.name) : apiBlock?.name;
      mb.input = apiBlock?.input as Record<string, unknown> | undefined;
    }
    this.emit?.({ event: 'block_complete', index, block: mb });
    if (this.blockIndex === index) this.currentType = 'text';
  }
}

function toolCallOf(block: ToolUseContent): ToolCall {
  return {
    id: block.id,
    name: block.name,
    input: block.input,
    ...(block.unparseableInput !== undefined ? { unparseableInput: block.unparseableInput } : {}),
  };
}

function isBuildRefusal(error: unknown): error is MembraneError {
  return error instanceof MembraneNotReadyError || error instanceof MembraneNormalizerError;
}

function holdsToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => (block as { type?: unknown } | null)?.type === 'tool_use');
}

/**
 * The marker a float on `target` carries, or undefined where none fits: a
 * longer TTL may not follow a shorter one, and a marker with no ttl is 5m.
 */
function floatControlAt(
  request: { messages: unknown; system?: unknown; tools?: unknown },
  target: Record<string, unknown>,
  cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' },
): { type: 'ephemeral'; ttl?: '5m' | '1h' } | undefined {
  const blocks = wireBlocksInOrder(request);
  const at = blocks.indexOf(target);
  const long = (block: Record<string, unknown>) => (block.cache_control as { ttl?: unknown }).ttl === '1h';
  const isLong = cacheControl.ttl === '1h' && blocks.slice(0, at).every((block) => !block.cache_control || long(block));
  if (!isLong && blocks.slice(at + 1).some((block) => block.cache_control && long(block))) return undefined;
  return isLong || !cacheControl.ttl ? cacheControl : { ...cacheControl, ttl: '5m' };
}

function placeFloatingMarker(
  request: { messages: Array<{ role?: string; content?: unknown }>; system?: unknown; tools?: unknown },
  cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' },
  takeEarliest: boolean,
  markableBlockTypes: readonly string[] | undefined,
): number | undefined {
  const messages = request.messages;
  const wireMarkers = countWireCacheMarkers(request);
  let residuum = MAX_CACHE_BREAKPOINTS - wireMarkers;
  const unmarkedEnd = (mi: number): Record<string, unknown> | undefined => {
    const content = messages[mi]?.content;
    if (!Array.isArray(content) || content.length === 0) return undefined;
    const bpIdx = lastCacheableBlockIndex(content as Array<Record<string, unknown>>);
    if (bpIdx < 0) return undefined;
    const block = content[bpIdx] as Record<string, unknown>;
    if (markableBlockTypes && !markableBlockTypes.includes(String(block.type))) return undefined;
    return block.cache_control ? undefined : block;
  };
  const newestEnd = unmarkedEnd(messages.length - 1);
  const newest = newestEnd && floatControlAt(request, newestEnd, cacheControl) ? newestEnd : undefined;
  if (newest && residuum <= 0 && takeEarliest) {
    const earliest = collectMarkedBlocks({ messages })[0];
    if (earliest) {
      delete earliest.cache_control;
      residuum++;
    }
  }
  if (residuum <= 0) return newest || !takeEarliest ? wireMarkers : undefined;
  let callingTurn = messages.length - 1;
  while (callingTurn >= 0 && !(messages[callingTurn]?.role === 'assistant' && holdsToolUse(messages[callingTurn]?.content))) callingTurn--;
  while (callingTurn > 0 && messages[callingTurn - 1]?.role === 'assistant') callingTurn--;
  for (const block of [newest, callingTurn > 0 ? unmarkedEnd(callingTurn - 1) : undefined]) {
    if (!block || residuum <= 0) continue;
    const control = floatControlAt(request, block, cacheControl);
    if (!control) continue;
    block.cache_control = control;
    residuum--;
  }
  return undefined;
}

function deliverCacheWireReceipt(request: NormalizedRequest, described: unknown): void {
  const consumer = request.onCacheWireReceipt;
  if (!consumer) return;
  const receipt = computeCacheWireReceipt(described);
  runCallerCode(() => consumer.call(request, receipt));
}

const warnedStopReasons = new Set<string>();
const MAX_LOGGED_STOP_REASONS = 64;
const MAX_LOGGED_STOP_REASON_CHARS = 128;

function shownStopReason(reason: unknown): string {
  if (typeof reason === 'string') {
    return JSON.stringify(
      reason.length > MAX_LOGGED_STOP_REASON_CHARS ? `${reason.slice(0, MAX_LOGGED_STOP_REASON_CHARS)}…` : reason
    );
  }
  const byValue = reason == null || typeof reason === 'number';
  return `${byValue ? String(reason) : typeof reason} (not a string)`;
}

function isStopToken(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function parseUpToStop(
  parser: StreamParser,
  chunk: string,
  checkFrom: number,
  stops: readonly string[],
): { found: { stop: string; at: number } | undefined; head: string; emissions: ProcessChunkResult['emissions'] } {
  const before = parser.getAccumulated();
  const text = before + chunk;
  // A provider applying the request's stops ends at the earliest one, whatever
  // order they're listed in.
  const found = firstStop(text.slice(checkFrom), stops);
  if (!found) return { found, head: text, emissions: parser.processChunk(chunk).emissions };
  const cut = checkFrom + found.at;
  const taken = chunk.slice(0, Math.max(0, cut - before.length));
  return { found, head: text.slice(0, cut), emissions: taken ? parser.processChunk(taken).emissions : [] };
}

function resolveRetryConfig(given: MembraneConfig['retry']): RetryConfig {
  const { overloaded, ...base } = given ?? {};
  const { overloaded: overloadedDefaults, ...baseDefaults } = DEFAULT_RETRY_CONFIG;
  return {
    ...resolveRetryFields(baseDefaults, base, 'retry'),
    overloaded: resolveRetryFields(overloadedDefaults, overloaded, 'retry.overloaded'),
  };
}

function resolveRetryFields<T extends { [K in keyof T]: number }>(
  defaults: T,
  given: Partial<T> | undefined,
  path: string,
): T {
  const resolved = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value: unknown = given?.[key];
    if (value === undefined) continue;
    if (typeof value !== 'number') {
      throw new TypeError(`[membrane] ${path}.${key} must be a number, got ${value === null ? 'null' : typeof value}`);
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`[membrane] ${path}.${key} must be a finite number of at least 0, got ${value}`);
    }
    resolved[key] = value as T[typeof key];
  }
  return resolved;
}

function refusalBudget(asked: number | undefined): number {
  return typeof asked === 'number' && Number.isFinite(asked) ? Math.max(0, asked) : 0;
}

function persistImageSplit(prefillResult: BuildResult, messages: BuildResult['messages'], seam: number): void {
  prefillResult.messages = messages;
  prefillResult.accumulatedBaseOffset = seam;
}

export class Membrane {
  private adapter: ProviderAdapter;
  private registry?: ModelRegistry;
  private retrySettings: RetrySettings;
  private config: MembraneConfig;
  private formatter: PrefillFormatter;

  constructor(
    adapter: ProviderAdapter,
    config: MembraneConfig = {}
  ) {
    this.adapter = adapter;
    this.registry = config.registry;
    this.retrySettings = membraneRetrySettings(resolveRetryConfig(config.retry));
    this.config = config;
    this.formatter = config.formatter ?? new AnthropicXmlFormatter();
  }

  /**
   * Complete a request (non-streaming)
   */
  async complete(
    request: NormalizedRequest,
    options: CompleteOptions = {}
  ): Promise<NormalizedResponse> {
    const startTime = Date.now();
    let attempts = 0;
    let tries = 0;
    let rawRequest: unknown;
    let refusalRetriesUsed = 0;
    // A refused attempt is a completed, billed HTTP call.
    let discardedUsage: DiscardedAttemptsUsage | undefined;
    const retryDelaysMs: number[] = [];

    const activeFormatter = this.resolveActiveFormatter(options.formatter);

    while (true) {
      attempts++;
      tries++;

      try {
        const { providerRequest, prefillResult, toolMode } = this.transformRequest(request, activeFormatter);
        const xmlToolProtocol = toolMode === 'xml' && activeFormatter.supportsXmlTools;

        const finalRequest = (await this.applyBeforeRequestHook(request, providerRequest)) as typeof providerRequest;

        let markersInRequest = request.cacheMarkers === 'cm-owned'
          ? assertCacheMarkersWithinLimit(finalRequest, 'complete')
          : clampCacheMarkers(finalRequest, 'complete').total;
        const useWireReceipt = this.adapter.cacheReceiptBasis === 'wire-request';
        let receiptEmitted = false;
        if (!useWireReceipt) deliverCacheWireReceipt(request, finalRequest);
        const receiptGuard = useWireReceipt && request.onCacheWireReceipt
          ? this.wireReceiptGuard(options.signal)
          : undefined;

        // A non-streaming call reports no progress before its response, so the
        // progress deadline bounds the whole call.
        const progress = createProgressDeadline(
          receiptGuard ? receiptGuard.signal : options.signal,
          options.progressTimeoutMs,
        );
        let rawProviderResponse: ProviderResponse;
        try {
          const adapterCall = this.adapter.complete(finalRequest, {
            requestContext: {
              formatterName: activeFormatter.name,
              toolMode,
              toolsDeclared: Boolean(request.tools?.length),
              requiresAssistantPrefill: false,
            },
            signal: progress.signal,
            timeoutMs: options.timeoutMs,
            ...(progress.onProgress ? { onProgress: progress.onProgress } : {}),
            onRequest: (req) => {
              rawRequest = req;
              if (useWireReceipt) {
                markersInRequest = countWireCacheMarkers(req as Parameters<typeof countWireCacheMarkers>[0]);
                if (!receiptEmitted) {
                  receiptEmitted = true;
                  receiptGuard?.emit(() => deliverCacheWireReceipt(request, req));
                }
              }
              runCallerCode(() => options.onRequest?.(req));
            },
          });
          rawProviderResponse = receiptGuard ? await receiptGuard.settle(adapterCall) : await adapterCall;
        } finally {
          progress.cleanup();
        }
        const providerResponse: ProviderResponse = {
          ...rawProviderResponse,
          providerStopReason: this.providerReasonFor(rawProviderResponse),
          usage: normalizeUsageToCacheExcluded(
            rawProviderResponse.usage,
            this.adapter.name,
            this.adapter.usageCacheConvention,
          ),
        };

        runCallerCode(() => options.onResponse?.(providerResponse.raw));

        const response = this.transformResponse(
          providerResponse,
          request,
          { ...prefillResult, cacheMarkersApplied: markersInRequest },
          startTime,
          attempts,
          xmlToolProtocol,
          rawRequest
        );

        if (
          response.stopReason === 'refusal' &&
          refusalRetriesUsed < refusalBudget(options.refusalRetries)
        ) {
          refusalRetriesUsed++;
          tries = 0;
          discardedUsage = this.mergeDiscardedAttempts(
            discardedUsage,
            this.discardedAttemptFrom(response.usage)
          );
          continue;
        }

        if (discardedUsage) {
          response.details.usage.discardedAttempts =
            this.pricedDiscardedAttempts(discardedUsage, request.config.model);
        }
        if (retryDelaysMs.length > 0) response.details.timing.retryDelaysMs = retryDelaysMs;

        const hooks = this.config.hooks;
        if (hooks?.afterResponse) {
          return await awaitCallerCode(() => hooks.afterResponse!(response, providerResponse.raw));
        }

        return response;

      } catch (error) {
        // The caller's signal fired, whatever the in-flight error is named:
        // AbortSignal.timeout() rejects with a TimeoutError.
        if (options.signal?.aborted) {
          const cancelled = isTypedAbortError(error)
            ? this.attachRawRequest(error, rawRequest)
            : new MembraneError({
                type: 'abort',
                message: 'Request was aborted',
                retryable: false,
                rawError: error,
                rawRequest,
              });
          throw cancelled;
        }
        if (isBuildRefusal(error)) throw error;
        const classifiedError = this.attachRawRequest(error, rawRequest);
        const errorInfo = classifyError(classifiedError);

        const plan = this.retryPlan(errorInfo, tries, isDeadlineExpiry(classifiedError), options.retry);

        if (plan.retry) {
          const hooks = this.config.hooks;
          if (hooks?.onError) {
            const decision = await awaitCallerCode(() => hooks.onError!(errorInfo, tries));
            if (decision === 'abort') {
              throw classifiedError;
            }
          }

          const delay = plan.delayMs;
          retryDelaysMs.push(delay);
          try {
            await this.sleep(delay, options.signal);
          } catch (sleepError) {
            const ended = options.signal?.aborted
              ? new MembraneError({
                  type: 'abort',
                  message: 'Request was aborted',
                  retryable: false,
                  rawError: sleepError,
                  rawRequest,
                })
              : this.attachRawRequest(sleepError, rawRequest);
            throw ended;
          }
          continue;
        }

        throw classifiedError;
      }
    }
  }

  /**
   * Stream a request with inline tool execution.
   *
   * Returns either a complete NormalizedResponse or an AbortedResponse
   * if the request was cancelled via the abort signal. Use `isAbortedResponse()`
   * to check which type was returned.
   *
   * @example
   * ```typescript
   * const result = await membrane.stream(request, { signal: controller.signal });
   * if (isAbortedResponse(result)) {
   *   console.log('Aborted:', result.rawAssistantText);
   *   // Use rawAssistantText as prefill to continue, or toolCalls/toolResults to rebuild state
   * } else {
   *   console.log('Complete:', result.content);
   * }
   * ```
   */
  async stream(
    request: NormalizedRequest,
    options: StreamOptions = {}
  ): Promise<NormalizedResponse | AbortedResponse> {
    resolveProgressBounds(options.progressBounds);
    if (request.streaming === false) {
      if (options.onToolCalls) {
        throw unsupportedError(
          'stream() cannot execute tools with streaming: false — the non-streaming ' +
          'fallback routes to complete(), which has no tool loop, so onToolCalls ' +
          'would never run. Leave streaming enabled (or drive the loop yourself ' +
          'with complete() per round).'
        );
      }
      let response: NormalizedResponse;
      try {
        response = await this.complete(request, options);
      } catch (error) {
        if (this.isCancellation(error, options.signal)) {
          return this.buildAbortedResponse(
            '',
            { inputTokens: 0, outputTokens: 0 },
            [],
            [],
            this.abortOutcome(error, options.signal),
            []
          );
        }
        throw error;
      }
      if (options.onChunk && 'content' in response) {
        for (let i = 0; i < response.content.length; i++) {
          const block = response.content[i]!;
          if (block.type === 'text' && block.text) {
            runCallerCode(() => options.onChunk!(block.text, {
              type: 'text',
              visible: true,
              blockIndex: i,
            }));
          }
        }
      }
      return response;
    }

    const activeFormatter = this.resolveActiveFormatter(options.formatter);
    const toolMode = this.resolveToolMode(request, activeFormatter);

    const callerCode = <A extends unknown[], R>(fn?: (...args: A) => R) =>
      fn && ((...args: A): R => runCallerCode(() => fn(...args)));
    const awaitedCallerCode = <A extends unknown[], R>(fn?: (...args: A) => Promise<R> | R) =>
      fn && ((...args: A): Promise<R> => awaitCallerCode(() => fn(...args)));
    const callerOptions: StreamOptions = {
      ...options,
      onChunk: callerCode(options.onChunk),
      onContentBlockUpdate: callerCode(options.onContentBlockUpdate),
      onToolCalls: awaitedCallerCode(options.onToolCalls),
      onPreToolContent: awaitedCallerCode(options.onPreToolContent),
      onUsage: callerCode(options.onUsage),
      onBlock: callerCode(options.onBlock),
      onResponse: callerCode(options.onResponse),
      onRequest: callerCode(options.onRequest),
    };

    return toolMode === 'native'
      ? this.streamWithNativeTools(request, callerOptions, activeFormatter)
      : this.streamWithXmlTools(request, callerOptions, activeFormatter);
  }

  /**
   * A per-request formatter override wins, except over a Responses formatter on
   * an adapter that needs native Responses input: that input is a native item
   * array, and the Responses API rejects the
   * Anthropic-style `{ role, content: [{ type: 'text' }] }` envelopes a generic
   * formatter builds, before inference. Subscription mode accepts them.
   */
  private resolveActiveFormatter(requestFormatter?: PrefillFormatter): PrefillFormatter {
    const requiresNativeInput = this.adapter.requiresNativeResponsesInput
      ?? this.adapter.name === 'openai-responses-api';
    if (requiresNativeInput && this.formatter.name === 'openai-responses') {
      return this.formatter;
    }
    return requestFormatter ?? this.formatter;
  }

  private resolveToolMode(
    request: NormalizedRequest,
    formatter: PrefillFormatter = this.formatter
  ): 'xml' | 'native' {
    for (const field of ['supportsNativeTools', 'supportsXmlTools'] as const) {
      if (typeof formatter[field] !== 'boolean') {
        throw unsupportedError(`Formatter "${formatter.name}" must declare ${field} as a boolean.`);
      }
    }
    const mode = request.toolMode && request.toolMode !== 'auto' ? request.toolMode
      : formatter.configuredToolMode ?? (formatter.supportsNativeTools ? 'native' : 'xml');
    if (toolsOffered(request).length && !(mode === 'native' ? formatter.supportsNativeTools : formatter.supportsXmlTools)) {
      throw unsupportedError(`Formatter "${formatter.name}" cannot carry ${mode} tool definitions. Choose a formatter supporting that carrier, or leave out the tools (those in tools and those a system change's defineTools offers).`);
    }
    return mode;
  }

  private async streamWithXmlTools(
    request: NormalizedRequest,
    options: StreamOptions,
    activeFormatter: PrefillFormatter = this.resolveActiveFormatter(options.formatter)
  ): Promise<NormalizedResponse | AbortedResponse> {
    const startTime = Date.now();
    const {
      onChunk,
      onContentBlockUpdate,
      onToolCalls,
      onPreToolContent,
      onUsage,
      onBlock,
      onRequest,
      onResponse,
      maxToolDepth = 10,
      signal,
      timeoutMs,
      idleTimeoutMs,
      progressTimeoutMs,
      progressBounds,
      retry,
    } = options;

    const formatter = activeFormatter;
    const xmlToolProtocol = formatter.supportsXmlTools;
    const streamedThinking = new StreamedThinking();

    const parser = formatter.createStreamParser();
    let toolDepth = 0;
    const turnUsage = new TurnUsageAccumulator(
      request.config.model,
      (servedModel) => this.resolvePricing(request.config.model, servedModel),
    );
    let providerCalls = 0;
    let rounds = 0;
    const retryDelaysMs: number[] = [];
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let lastProviderStopReason: string | undefined;
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];
    const splitRounds: SplitResultsRound[] = [];

    const providerImageBlocks: ContentBlock[] = [];

    const providerThinkingBlocks: ContentBlock[] = [];

    let { providerRequest, prefillResult } = this.transformRequest(request, formatter, 'xml');

    let initialPrefillLength = 0;
    let roundStartLen = 0;
    let initialBlockType: 'thinking' | 'tool_call' | 'tool_result' | null = null;
    if (prefillResult.assistantPrefill) {
      parser.push(prefillResult.assistantPrefill);
      initialPrefillLength = prefillResult.assistantPrefill.length;
      roundStartLen = initialPrefillLength;
      if (parser.isInsideBlock()) {
        const blockType = parser.getCurrentBlockType();
        if (blockType === 'thinking' || blockType === 'tool_call' || blockType === 'tool_result') {
          initialBlockType = blockType;
        }
      }
    }

    const prefillDepths = parser.getDepths();

    const MIN_ROUND_PROGRESS_CHARS = 16;
    const MAX_CONSECUTIVE_STALLED_RESUMPTIONS = 3;
    const RESUMPTION_WARN_ROUNDS = 5;
    const maxResumptionRounds = options.maxResumptionRounds ?? 24;
    let resumptionRounds = 0;
    let consecutiveStalledResumptions = 0;
    let enteredViaResumption = false;
    let prevRoundStopSequence: string | undefined;
    const warnLog = this.warnLogger();

    const registerResumptionRound = (): boolean => {
      resumptionRounds++;
      if (resumptionRounds === RESUMPTION_WARN_ROUNDS) {
        warnLog.warn(
          `[membrane] automatic resumption at round ${resumptionRounds} ` +
          `(${turnUsage.total.inputTokens} input tokens so far this turn) — ` +
          `a spin shows up here before it shows up on the bill`
        );
      }
      if (resumptionRounds > maxResumptionRounds) {
        warnLog.warn(
          `[membrane] automatic resumption cap (${maxResumptionRounds}) reached — ` +
          `ending turn with stopReason 'round_limit'. ` +
          `${turnUsage.total.inputTokens} input tokens spent this turn.`
        );
        return false;
      }
      return true;
    };

    try {
      while (toolDepth <= maxToolDepth) {

        // The provider doesn't always stop at a stop sequence.
        let detectedStopSequence: string | null = null;
        let truncatedAccumulated: string | null = null;

        const streamedFrom = parser.getAccumulated().length;

        let typedCallbacks = false;
        let sawChunk = false;
        const textStarts = new Map<number, number>();
        streamedThinking.beginRound(parser.getAccumulated().length - initialPrefillLength);
        const tracker = new NativeBlockTracker((event) => { if (typedCallbacks) onBlock?.(event); });
        const forward = (emissions: ProcessChunkResult['emissions']) => {
          for (const emission of emissions) {
            if (emission.kind === 'blockEvent') {
              if (!typedCallbacks) onBlock?.(emission.event);
            } else {
              onChunk?.(emission.text, typedCallbacks ? { ...emission.meta, blockIndex: tracker.blockIndex } : emission.meta);
            }
          }
        };
        const forwardOwn = (emissions: ProcessChunkResult['emissions']) => {
          if (!typedCallbacks) forward(emissions);
        };
        const onProviderBlock = (index: number, block: unknown) => {
          if (!xmlToolProtocol && (!detectedStopSequence || textStarts.has(index))) {
            const type = (block as { type?: string } | undefined)?.type;
            if (!sawChunk && (type === 'text' || type === 'thinking' || type === 'redacted_thinking')) typedCallbacks = true;
            const accepted = truncatedAccumulated ?? parser.getAccumulated();
            const offset = accepted.length - initialPrefillLength;
            let reported = block;
            if (type === 'text') {
              const start = textStarts.get(index);
              if (start === undefined) textStarts.set(index, offset);
              else reported = { ...(block as object), text: accepted.slice(initialPrefillLength + start) };
            }
            streamedThinking.onBlock(index, reported, offset);
            tracker.onProviderBlock(index, reported);
          }
          onContentBlockUpdate?.(index, block as ContentBlock);
        };

        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (detectedStopSequence) {
                return;
              }

              sawChunk = true;
              if (!xmlToolProtocol && tracker.currentType === 'thinking') {
                streamedThinking.onThinkingChunk(tracker.blockIndex, chunk);
                onChunk?.(chunk, { type: 'thinking', visible: false, blockIndex: tracker.blockIndex });
                return;
              }
              const { found, head, emissions } = parseUpToStop(parser, chunk, streamedFrom, prefillResult.stopSequences);
              if (found) {
                detectedStopSequence = found.stop;
                truncatedAccumulated = head;
              }
              forward(emissions);
            },
            onContentBlock: onProviderBlock,
            onThinkingSignature: (index, signature) => streamedThinking.onSignature(index, signature),
          },
          {
            signal,
            timeoutMs,
            idleTimeoutMs,
            progressTimeoutMs,
            progressBounds,
            retry,
            normalizedRequest: request,
            formatterName: formatter.name,
            requiresAssistantPrefill: true,
            wrapThinkingTags: xmlToolProtocol,
            onWireCacheMarkers: (count) => { prefillResult.cacheMarkersApplied = count; },
            onRequest: (req) => {
              rawRequest = req;
              onRequest?.(req);
            },
          }
        );

        if (typedCallbacks) tracker.flushAfterProviderReturn();
        rounds++;
        providerCalls += streamResult.providerCalls;
        retryDelaysMs.push(...streamResult.retryDelaysMs);

        if (detectedStopSequence && truncatedAccumulated !== null) {
          if (parser.getAccumulated() !== truncatedAccumulated) {
            parser.reset();
            parser.push(truncatedAccumulated);
          }
          streamResult.stopReason = 'stop_sequence';
          streamResult.stopSequence = detectedStopSequence;
        }

        if (Array.isArray(streamResult.content)) {
          this.captureProviderImageBlocks(streamResult.content, providerImageBlocks);
          // A native thinking block's signature is its encrypted full reasoning, which
          // a consumer sends back on later turns.
          this.captureProviderThinkingBlocks(streamResult.content, providerThinkingBlocks);
        }

        rawResponse = streamResult.raw;

        onResponse?.(rawResponse);

        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastProviderStopReason = streamResult.providerStopReason;
        lastStopSequence = streamResult.stopSequence ?? undefined;

        // Not inlined into the optional call: `onUsage?.(addRound())` skips
        // evaluating its argument when no callback is set.
        const usageSoFar = turnUsage.addRound(streamResult.model, streamResult.usage);
        onUsage?.(usageSoFar);

        forwardOwn(parser.flush().emissions);

        const accumulated = parser.getAccumulated();

        const streamedThisRound = accumulated.length - streamedFrom;
        if (
          enteredViaResumption &&
          lastStopReason === 'stop_sequence' &&
          streamedThisRound < MIN_ROUND_PROGRESS_CHARS &&
          lastStopSequence === prevRoundStopSequence
        ) {
          consecutiveStalledResumptions++;
          if (consecutiveStalledResumptions >= MAX_CONSECUTIVE_STALLED_RESUMPTIONS) {
            warnLog.warn(
              `[membrane] ${consecutiveStalledResumptions} consecutive automatic resumptions ` +
              `made no progress (${streamedThisRound} chars this round, stop ` +
              `${JSON.stringify(lastStopSequence ?? null)} repeated) — ending turn with ` +
              `stopReason 'no_progress'. ${turnUsage.total.inputTokens} input tokens spent this turn.`
            );
            lastStopReason = 'no_progress';
            break;
          }
        } else {
          consecutiveStalledResumptions = 0;
        }
        prevRoundStopSequence = lastStopSequence;
        enteredViaResumption = false;

        if (xmlToolProtocol && onToolCalls && streamResult.stopSequence === '</function_calls>') {
          const closeTag = '</function_calls>';
          parser.push(closeTag);

          const parsed = parseToolCalls(parser.getAccumulated(), { tools: request.tools });

          if (parsed && parsed.calls.length > 0) {
            const preToolNew = parsed.beforeText.slice(initialPrefillLength);
            if (onPreToolContent && preToolNew.trim()) {
              await onPreToolContent(preToolNew);
            }

            for (const call of parsed.calls) {
              const toolCallBlockIndex = parser.getBlockIndex();
              onBlock?.({
                event: 'block_start',
                index: toolCallBlockIndex,
                block: { type: 'tool_call' },
              });
              onBlock?.({
                event: 'block_complete',
                index: toolCallBlockIndex,
                block: {
                  type: 'tool_call',
                  toolId: call.id,
                  toolName: call.name,
                  input: call.input,
                },
              });
              parser.incrementBlockIndex();
            }

            signal?.throwIfAborted();
            executedToolCalls.push(...parsed.calls);

            const context: ToolContext = {
              rawText: parsed.fullMatch,
              preamble: parsed.beforeText.slice(initialPrefillLength),
              roundPreamble: parsed.beforeText.slice(roundStartLen),
              depth: toolDepth,
              previousResults: executedToolResults,
              accumulated: parser.getAccumulated().slice(initialPrefillLength),
            };

            const results = await onToolCalls(parsed.calls, context);
            if (!Array.isArray(results)) {
              throw new Error(
                `onToolCalls must return an array of ToolResult, got ${typeof results}`
              );
            }

            const callNames = new Map(parsed.calls.map((c) => [c.id, c.name]));
            for (const r of results) {
              if (!r.toolName) r.toolName = callNames.get(r.toolUseId);
            }

            executedToolResults.push(...results);

            const splitContent = hasImageInToolResults(results) ? formatToolResultsForSplitTurn(results) : null;
            if (splitContent?.hasImages) {
              splitRounds.push({
                xml: splitContent.beforeImageXml + splitContent.afterImageXml,
                docAt: parser.getAccumulated().length - initialPrefillLength,
                at: splitContent.beforeImageXml.length,
                imageResult: splitContent.imageResult,
                results,
              });

              const toolResultBlockIndex = parser.getBlockIndex();
              onBlock?.({
                event: 'block_start',
                index: toolResultBlockIndex,
                block: { type: 'tool_result' },
              });

              parser.push(splitContent.beforeImageXml);

              for (const result of results) {
                const resultContent = typeof result.content === 'string'
                  ? result.content
                  : JSON.stringify(result.content);
                const toolResultMeta: ChunkMeta = {
                  type: 'tool_result',
                  visible: false,
                  blockIndex: parser.getBlockIndex(),
                  toolId: result.toolUseId,
                };
                onChunk?.(resultContent, toolResultMeta);
                onBlock?.({
                  event: 'block_complete',
                  index: parser.getBlockIndex(),
                  block: {
                    type: 'tool_result',
                    toolId: result.toolUseId,
                    content: resultContent,
                    isError: result.isError,
                  },
                });
                parser.incrementBlockIndex();
              }

              let afterImageXml = splitContent.afterImageXml;
              if (request.config.thinking?.enabled) {
                afterImageXml += '\n<thinking>';
              }

              providerRequest = this.buildContinuationRequestWithImages(
                request,
                prefillResult,
                parser.getAccumulated(),
                splitContent.images,
                afterImageXml
              );

              parser.push(afterImageXml);
              prefillResult.assistantPrefill = parser.getAccumulated();

              parser.resetForNewIteration();
            } else {
              const resultsXml = splitContent ? splitContent.beforeImageXml : formatToolResults(results);

              const toolResultBlockIndex = parser.getBlockIndex();
              onBlock?.({
                event: 'block_start',
                index: toolResultBlockIndex,
                block: { type: 'tool_result' },
              });

              parser.push(resultsXml);

              for (const result of results) {
                const resultContent = typeof result.content === 'string'
                  ? result.content
                  : JSON.stringify(result.content);
                const toolResultMeta: ChunkMeta = {
                  type: 'tool_result',
                  visible: false,
                  blockIndex: parser.getBlockIndex(),
                  toolId: result.toolUseId,
                };
                onChunk?.(resultContent, toolResultMeta);
                onBlock?.({
                  event: 'block_complete',
                  index: parser.getBlockIndex(),
                  block: {
                    type: 'tool_result',
                    toolId: result.toolUseId,
                    content: resultContent,
                    isError: result.isError,
                  },
                });
                parser.incrementBlockIndex();
              }

              if (request.config.thinking?.enabled) {
                parser.push('\n<thinking>');
              }

              prefillResult.assistantPrefill = parser.getAccumulated();
              providerRequest = this.buildContinuationRequest(
                request,
                prefillResult,
                parser.getAccumulated()
              );
            }

            roundStartLen = parser.getAccumulated().length;

            parser.resetForNewIteration();
            toolDepth++;
            continue;
          }
        }

        const currentDepths = parser.getDepths();
        const modelOpenedNewBlock =
          currentDepths.functionCalls > prefillDepths.functionCalls ||
          currentDepths.functionResults > prefillDepths.functionResults ||
          currentDepths.thinking > prefillDepths.thinking;

        if (lastStopReason === 'stop_sequence' && modelOpenedNewBlock) {
          if (streamResult.stopSequence) {
            const type = parser.getCurrentBlockType();
            const putBack = parser.processChunk(streamResult.stopSequence).emissions;
            if (typedCallbacks) {
              onChunk?.(streamResult.stopSequence, { type, visible: type === 'text', blockIndex: 0 });
            } else {
              forward(putBack);
            }
          }

          toolDepth++;
          if (toolDepth > maxToolDepth) {
            forwardOwn(parser.flush().emissions);
            break;
          }
          if (!registerResumptionRound()) {
            lastStopReason = 'round_limit';
            forwardOwn(parser.flush().emissions);
            break;
          }
          enteredViaResumption = true;
          prefillResult.assistantPrefill = parser.getAccumulated();
          providerRequest = this.buildContinuationRequest(
            request,
            prefillResult,
            parser.getAccumulated()
          );
          continue;
        }

        break;
      }

      const fullAccumulated = parser.getAccumulated();
      const newContent = fullAccumulated.slice(initialPrefillLength);

      const response = this.buildFinalResponse(
        newContent,
        xmlToolProtocol ? contentBlocks : streamedThinking.content(newContent, (value, context) => formatter.parseContentBlocks(value, request.tools, context)),
        lastStopReason,
        turnUsage,
        request,
        xmlToolProtocol,
        prefillResult,
        startTime,
        providerCalls,
        rawRequest,
        rawResponse,
        executedToolCalls,
        executedToolResults,
        initialBlockType,
        lastStopSequence,
        lastProviderStopReason,
        splitRounds
      );

      if (providerImageBlocks.length > 0) {
        response.content.push(...providerImageBlocks);
      }

      this.mergeProviderThinkingBlocks(response.content, providerThinkingBlocks);

      response.details.timing.rounds = rounds;
      if (retryDelaysMs.length > 0) response.details.timing.retryDelaysMs = retryDelaysMs;

      return response;
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        const fullAccumulated = parser.getAccumulated();
        const newContent = fullAccumulated.slice(initialPrefillLength);

        return this.buildAbortedResponse(
          newContent,
          turnUsage.total,
          executedToolCalls,
          executedToolResults,
          this.abortOutcome(error, signal),
          xmlToolProtocol
            ? attachSplitResults(parseAccumulatedIntoBlocks(newContent, { tools: request.tools, ...(initialBlockType ? { startInsideBlock: initialBlockType } : {}) }), splitRounds).blocks
            : streamedThinking.content(newContent, (value, context) => formatter.parseContentBlocks(value, request.tools, context))
        );
      }
      throw this.attachRawRequest(error, rawRequest);
    }
  }

  private async streamWithNativeTools(
    request: NormalizedRequest,
    options: StreamOptions,
    activeFormatter: PrefillFormatter = this.resolveActiveFormatter(options.formatter)
  ): Promise<NormalizedResponse | AbortedResponse> {
    const startTime = Date.now();
    const {
      onChunk,
      onContentBlockUpdate,
      onBlock,
      onToolCalls,
      onPreToolContent,
      onUsage,
      onRequest,
      onResponse,
      maxToolDepth = 10,
      signal,
      timeoutMs,
      idleTimeoutMs,
      progressTimeoutMs,
      progressBounds,
      retry,
    } = options;

    let toolDepth = 0;
    const turnUsage = new TurnUsageAccumulator(
      request.config.model,
      (servedModel) => this.resolvePricing(request.config.model, servedModel),
    );
    let providerCalls = 0;
    let rounds = 0;
    const retryDelaysMs: number[] = [];
    let lastStopReason: StopReason = 'end_turn';
    const anomalies: ResponseAnomaly[] = [];
    let lastProviderStopReason: string | undefined;
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    let allTextAccumulated = '';

    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

    let messages = [...request.messages];
    let allContentBlocks: ContentBlock[] = [];
    let roundReceived: (() => ContentBlock[]) | undefined;
    let markersInLastRequest = 0;

    try {
      while (toolDepth <= maxToolDepth) {
        const providerRequest = this.buildNativeToolRequest(request, messages, toolDepth > 0, activeFormatter);

        let textAccumulated = '';
        const offered = toolsOffered({ tools: request.tools, messages });
        const tracker = new NativeBlockTracker(onBlock ? (event) => onBlock(event) : undefined, (name) => restoreToolName(name, offered));
        roundReceived = () => this.parseProviderContent(tracker.partialContent(), offered);
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              tracker.onChunk(chunk);
              const visible = tracker.currentType === 'text';
              if (visible) {
                textAccumulated += chunk;
                allTextAccumulated += chunk;
              }
              const meta: ChunkMeta = {
                type: tracker.currentType,
                visible,
                blockIndex: tracker.blockIndex,
              };
              onChunk?.(chunk, meta);
            },
            onContentBlock: (index: number, block: unknown) => {
              tracker.onProviderBlock(index, block);
              onContentBlockUpdate?.(index, block as ContentBlock);
            },
            onThinkingSignature: (index, signature) => tracker.onThinkingSignature(index, signature),
          },
          {
            signal,
            timeoutMs,
            idleTimeoutMs,
            progressTimeoutMs,
            progressBounds,
            retry,
            normalizedRequest: request,
            formatterName: activeFormatter.name,
            requiresAssistantPrefill: false,
            promptMessages: messages,
            onRequest: (req) => {
              rawRequest = req;
              onRequest?.(req);
            },
            onWireCacheMarkers: (markerCount) => {
              markersInLastRequest = markerCount;
            },
          }
        );

        const responseBlocks = this.parseProviderContent(streamResult.content, offered);
        roundReceived = () => responseBlocks;

        tracker.flushAfterProviderReturn();
        rounds++;
        providerCalls += streamResult.providerCalls;
        retryDelaysMs.push(...streamResult.retryDelaysMs);

        rawResponse = streamResult.raw;

        onResponse?.(rawResponse);

        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastProviderStopReason = streamResult.providerStopReason;
        lastStopSequence = streamResult.stopSequence ?? undefined;
        const endTurnTools = this.toolUseWithEndTurn(responseBlocks, lastStopReason, streamResult, rounds - 1);
        if (endTurnTools) {
          anomalies.push(endTurnTools);
          if (endTurnTools.treatedAsToolUse) lastStopReason = 'tool_use';
        }

        const usageSoFar = turnUsage.addRound(streamResult.model, streamResult.usage);
        onUsage?.(usageSoFar);

        allContentBlocks.push(...responseBlocks);
        roundReceived = undefined;

        const toolUseBlocks = responseBlocks.filter(
          (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use'
        );

        if (onToolCalls && toolUseBlocks.length > 0 && lastStopReason === 'tool_use') {
          const textBlocks = responseBlocks.filter(b => b.type === 'text');
          if (onPreToolContent && textBlocks.length > 0) {
            const preToolText = textBlocks.map(b => (b as any).text).join('');
            if (preToolText.trim()) {
              await onPreToolContent(preToolText);
            }
          }

          const toolCalls: ToolCall[] = toolUseBlocks.map(toolCallOf);

          signal?.throwIfAborted();
          executedToolCalls.push(...toolCalls);

          const context: ToolContext = {
            rawText: JSON.stringify(toolUseBlocks),
            preamble: textAccumulated,
            depth: toolDepth,
            previousResults: executedToolResults,
            accumulated: allTextAccumulated,
          };

          const results = await onToolCalls(toolCalls, context);
          if (!Array.isArray(results)) {
            throw new Error(
              `onToolCalls must return an array of ToolResult, got ${typeof results}`
            );
          }

          executedToolResults.push(...results);

          for (const result of results) {
            allContentBlocks.push({
              type: 'tool_result',
              toolUseId: result.toolUseId,
              content: result.content,
              isError: result.isError,
            });
          }

          const asstName = request.assistantParticipant
            ?? this.config.assistantParticipant ?? 'Claude';
          messages.push({
            participant: asstName,
            content: responseBlocks,
          });

          messages.push({
            participant: asstName === 'Claude' ? 'User' : 'user',
            content: results.map(r => ({
              type: 'tool_result' as const,
              toolUseId: r.toolUseId,
              content: r.content,
              isError: r.isError,
            })),
          });

          toolDepth++;
          continue;
        }

        break;
      }

      const durationMs = Date.now() - startTime;
      const totalUsage = turnUsage.total;

      return {
        content: allContentBlocks,
        rawAssistantText: allTextAccumulated,
        toolCalls: executedToolCalls,
        toolResults: executedToolResults,
        stopReason: lastStopReason,
        usage: totalUsage,
        details: {
          stop: this.buildStopInfo(lastStopReason, lastProviderStopReason, lastStopSequence),
          usage: { ...totalUsage },
          timing: {
            totalDurationMs: durationMs,
            attempts: providerCalls,
            rounds,
            ...(retryDelaysMs.length > 0 ? { retryDelaysMs } : {}),
          },
          model: {
            requested: request.config.model,
            actual: turnUsage.lastServedModel || request.config.model,
            provider: this.adapter.name,
            perRound: turnUsage.perRound,
          },
          cache: {
            markersInRequest: markersInLastRequest,
            tokensCreated: totalUsage.cacheCreationTokens ?? 0,
            tokensRead: totalUsage.cacheReadTokens ?? 0,
            hitRatio: this.calculateCacheHitRatio(totalUsage),
          },
          ...(anomalies.length ? { anomalies } : {}),
        },
        raw: {
          request: rawRequest,
          response: rawResponse,
        },
      };
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        return this.buildAbortedResponse(
          allTextAccumulated,
          turnUsage.total,
          executedToolCalls,
          executedToolResults,
          this.abortOutcome(error, signal),
          [...allContentBlocks, ...(roundReceived?.() ?? [])]
        );
      }
      throw this.attachRawRequest(error, rawRequest);
    }
  }

  private readonly floatsAfterHook = new WeakMap<object, { type: 'ephemeral'; ttl?: '5m' | '1h' }>();
  private floatBudgetWarnState = { lastWarnedAtMs: 0, suppressedSinceWarn: 0 };
  private static readonly FLOAT_BUDGET_WARN_INTERVAL_MS = 60_000;

  private warnFloatBudgetExhausted(wireMarkers: number): void {
    const now = Date.now();
    const state = this.floatBudgetWarnState;
    const elapsed = now - state.lastWarnedAtMs;
    if (state.lastWarnedAtMs !== 0 && elapsed < Membrane.FLOAT_BUDGET_WARN_INTERVAL_MS) {
      state.suppressedSinceWarn++;
      return;
    }
    const suppressed = state.suppressedSinceWarn;
    state.lastWarnedAtMs = now;
    state.suppressedSinceWarn = 0;
    console.warn(
      `[membrane] floating cache marker withheld: upstream markers already ` +
      `occupy all ${MAX_CACHE_BREAKPOINTS} cache_control slots (${wireMarkers} on the wire). ` +
      `Tool-round suffixes will not cache incrementally.` +
      (suppressed > 0 ? ` (${suppressed} further occurrences suppressed since the last warning.)` : '')
    );
  }

  private buildNativeToolRequest(
    request: NormalizedRequest,
    messages: typeof request.messages,
    toolLoopRebuild = false,
    activeFormatter: PrefillFormatter = this.formatter,
    fidelity?: FidelityNotes,
  ): any {
    const { providerRequest, prefixRewritten } = this.transformRequest(request, activeFormatter, 'native', messages, fidelity);
    if (activeFormatter.name === 'openai-responses') return providerRequest;

    const mergedMessages = providerRequest.messages;
    const system = providerRequest.system;
    const tools = providerRequest.tools;
    const promptCaching = request.promptCaching ?? this.config.defaultPromptCaching ?? true;
    const membraneOwned = (request.cacheMarkers ?? 'membrane-system') === 'membrane-system';
    const floatControl = promptCaching
      ? { type: 'ephemeral' as const, ...(request.cacheTtl ? { ttl: request.cacheTtl } : {}) }
      : undefined;
    const cacheControl = membraneOwned ? floatControl : undefined;
    const upstreamWireMarkers = countWireCacheMarkers({ messages: mergedMessages, system: request.system });
    if (cacheControl && upstreamWireMarkers === 0 && Array.isArray(tools) && tools.length) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: cacheControl };
    }

    // Anthropic allows 4 cache_control markers, tools and system included, and
    // looks for a cache entry only so far back from a marker.
    const floatingAsked = request.floatingCacheMarker ?? this.config.defaultFloatingCacheMarker;
    const floatingEnabled = membraneOwned ? floatingAsked ?? true : floatingAsked === true;
    if (toolLoopRebuild && floatingEnabled && floatControl && !prefixRewritten) {
      if (membraneOwned) {
        const withheldAt = placeFloatingMarker({ messages: mergedMessages, system, tools }, floatControl, false, this.adapter.sendsCacheMarkersOn);
        if (withheldAt !== undefined) this.warnFloatBudgetExhausted(withheldAt);
      } else {
        this.floatsAfterHook.set(providerRequest, floatControl);
      }
    }

    return providerRequest;
  }

  private parseProviderContent(content: unknown, tools?: readonly { name: string }[]): ContentBlock[] {
    if (!content) return [];
    
    if (Array.isArray(content)) {
      const blocks: ContentBlock[] = [];
      for (const item of content) {
        if (item.type === 'text') {
          blocks.push({
            type: 'text', text: item.text,
            ...(item.rawItem ? { rawItem: item.rawItem } : {}),
          });
        } else if (item.type === 'tool_use') {
          blocks.push({
            type: 'tool_use',
            id: item.id,
            name: restoreToolName(item.name, tools),
            ...toolUseInputFromValue(item.input),
            ...(item.unparseableInput !== undefined ? { unparseableInput: item.unparseableInput } : {}),
            ...(item.rawItem ? { rawItem: item.rawItem } : {}),
          });
        } else if (item.type === 'thinking') {
          blocks.push({
            type: 'thinking',
            thinking: item.thinking ?? '',
            ...(item.signature ? { signature: item.signature } : {}),
            ...(item.rawItem ? { rawItem: item.rawItem } : {}),
          });
        } else if (item.type === 'redacted_thinking') {
          // A redacted_thinking block's encrypted `data` goes back as it is.
          blocks.push({ ...item } as ContentBlock);
        } else if (item.type === 'image') {
          blocks.push({ ...item } as ContentBlock);
        } else if (item.type === 'generated_image') {
          blocks.push({
            type: 'generated_image',
            data: item.data,
            mimeType: item.mimeType,
          });
        } else if (item.rawItem || item.type) {
          blocks.push(providerItemCarrier(item));
        }
      }
      return blocks;
    }

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    return [];
  }

  private captureProviderImageBlocks(providerContent: unknown, sink: ContentBlock[]): void {
    if (!Array.isArray(providerContent)) return;
    for (const block of providerContent) {
      if (block?.type === 'image' || block?.type === 'generated_image') {
        sink.push({ ...block } as ContentBlock);
      }
    }
  }

  /**
   * With display:'omitted' a thinking block's text is empty: it carries only
   * its signature.
   */
  private captureProviderThinkingBlocks(
    providerContent: unknown,
    sink: ContentBlock[]
  ): void {
    if (!Array.isArray(providerContent)) return;
    for (const block of providerContent) {
      if (block?.type === 'thinking') {
        sink.push({
          type: 'thinking',
          thinking: (block as any).thinking ?? '',
          ...((block as any).signature ? { signature: (block as any).signature } : {}),
        } as ContentBlock);
      } else if (block?.type === 'redacted_thinking') {
        sink.push({ ...(block as any) } as ContentBlock);
      }
    }
  }

  /**
   * Signature-only thinking (display:'omitted') never appears in the text
   * stream. Anthropic checks a thinking block's signature against its text on
   * the next turn, so a signature on text it wasn't made for fails validation.
   */
  private mergeProviderThinkingBlocks(
    content: ContentBlock[],
    providerThinkingBlocks: ContentBlock[]
  ): void {
    if (providerThinkingBlocks.length === 0) return;

    const providerThinking = providerThinkingBlocks.filter(
      (b) => b.type === 'thinking'
    ) as Array<{ type: 'thinking'; thinking?: string; signature?: string }>;
    const redacted = providerThinkingBlocks.filter((b) => b.type === 'redacted_thinking');

    const pairedProviderBlocks = new Set<number>();
    const claimedParsedIndices = new Set<number>();
    const parsedThinkingIndices = () =>
      content.reduce<number[]>((acc, block, index) => {
        if (block.type === 'thinking') acc.push(index);
        return acc;
      }, []);

    for (let p = 0; p < providerThinking.length; p++) {
      const providerText = providerThinking[p]!.thinking ?? '';
      if (providerText === '') continue;
      const match = parsedThinkingIndices().find(
        (index) =>
          !claimedParsedIndices.has(index) &&
          sameThinkingText((content[index] as { thinking?: string }).thinking ?? '', providerText)
      );
      if (match === undefined) continue;
      const signature = providerThinking[p]!.signature;
      if (signature) (content[match] as { signature?: string }).signature = signature;
      claimedParsedIndices.add(match);
      pairedProviderBlocks.add(p);
    }

    for (const parsedIndex of parsedThinkingIndices().reverse()) {
      if (claimedParsedIndices.has(parsedIndex)) continue;
      const parsedText = (content[parsedIndex] as { thinking?: string }).thinking ?? '';
      if (parsedText === '') continue;
      const run = findSpanningProviderRun(providerThinking, pairedProviderBlocks, parsedText);
      if (!run) continue;
      content.splice(
        parsedIndex,
        1,
        ...run.map((p) => {
          pairedProviderBlocks.add(p);
          const block = providerThinking[p]!;
          return {
            type: 'thinking',
            thinking: block.thinking ?? '',
            ...(block.signature ? { signature: block.signature } : {}),
          } as ContentBlock;
        })
      );
      claimedParsedIndices.add(parsedIndex);
    }

    const seen = new Set(content.map((block) => thinkingCarrierKey(block)));
    const leftover: ContentBlock[] = [];
    for (let p = 0; p < providerThinking.length; p++) {
      if (pairedProviderBlocks.has(p)) continue;
      const block = providerThinking[p]! as unknown as ContentBlock;
      const key = thinkingCarrierKey(block);
      if (seen.has(key)) continue;
      seen.add(key);
      leftover.push(block);
    }
    for (const block of redacted) {
      const key = thinkingCarrierKey(block);
      if (seen.has(key)) continue;
      seen.add(key);
      leftover.push(block);
    }

    if (leftover.length > 0) content.unshift(...leftover);
  }

  private warnLogger(): Pick<MembraneLogger, 'warn'> {
    const logger = this.config.logger;
    if (!logger) return console;
    return { warn: (...args) => runCallerCode(() => logger.warn(...args)) };
  }

  private wireReceiptGuard(callerSignal: AbortSignal | undefined) {
    const controller = new AbortController();
    const state: { failure?: { error: unknown } } = {};
    return {
      signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
      emit(send: () => void): void {
        try {
          send();
        } catch (error) {
          state.failure = { error };
          controller.abort(error);
          throw error;
        }
      },
      async settle<T>(call: Promise<T>): Promise<T> {
        let result: T;
        try {
          result = await call;
        } catch (error) {
          throw state.failure ? state.failure.error : error;
        }
        if (state.failure) throw state.failure.error;
        return result;
      },
    };
  }

  private async applyBeforeRequestHook(
    normalizedRequest: NormalizedRequest,
    providerRequest: unknown,
  ): Promise<unknown> {
    const hooks = this.config.hooks;
    if (!hooks?.beforeRequest) return providerRequest;
    const result = await awaitCallerCode(() => hooks.beforeRequest!(normalizedRequest, providerRequest));
    return result ?? providerRequest;
  }

  private getBaseProviderParams(config: NormalizedRequest['config']) {
    const alwaysOnThinking = Membrane.isAlwaysThinkingModel(config.model);
    const thinking = this.buildThinkingParam(config);
    // Anthropic requires temperature=1 when extended thinking is enabled
    const temperature = alwaysOnThinking ? undefined : (thinking ? 1 : config.temperature);
    return {
      model: config.model,
      maxTokens: config.maxTokens,
      temperature,
      topP: alwaysOnThinking ? undefined : config.topP,
      topK: alwaysOnThinking ? undefined : config.topK,
      presencePenalty: config.presencePenalty,
      frequencyPenalty: config.frequencyPenalty,
      repetitionPenalty: config.repetitionPenalty,
      thinking,
    };
  }

  /**
   * The Claude Fable/Mythos family thinks always, and has refused sampling
   * params (`temperature`, `top_p`, `top_k`) and a thinking config with a 400,
   * except `{ type: 'adaptive' }` carrying `block_binding`, `display` or both.
   * Without `display: 'updates'` these models return their progress notes
   * between tool calls empty.
   */
  private static isAlwaysThinkingModel(model: string | undefined): boolean {
    return /\b(fable|mythos)\b/i.test(model ?? '');
  }

  /**
   * For type 'enabled', the API requires max_tokens > budget_tokens and a
   * budget of at least 1024.
   */
  private buildThinkingParam(config: NormalizedRequest['config']):
    | { type: 'adaptive'; display?: ThinkingDisplay; block_binding?: BlockBindingParam }
    | { type: 'enabled'; budget_tokens: number; display?: ThinkingDisplay; block_binding?: BlockBindingParam }
    | undefined {
    const blockBinding = config.thinking?.blockBinding;
    const binding = blockBinding
      ? { block_binding: { prefix_mismatch_behavior: blockBinding.prefixMismatchBehavior } }
      : {};
    const display = config.thinking?.display;
    if (Membrane.isAlwaysThinkingModel(config.model)) {
      return blockBinding || display === 'updates'
        ? { type: 'adaptive', ...(display ? { display } : {}), ...binding }
        : undefined;
    }
    if (!config.thinking?.enabled) return undefined;

    if ((config.thinking.type ?? 'enabled') === 'adaptive') {
      return { type: 'adaptive', ...(display ? { display } : {}), ...binding };
    }

    const requested = config.thinking.budgetTokens ?? 5000;
    const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : undefined;
    const budget = maxTokens !== undefined ? Math.min(requested, maxTokens - 1024) : requested;
    if (budget < 1024) {
      return undefined;
    }
    return { type: 'enabled', budget_tokens: budget, ...(display ? { display } : {}), ...binding };
  }

  private transformRequest(
    request: NormalizedRequest,
    activeFormatter: PrefillFormatter = this.formatter,
    toolMode: 'xml' | 'native' = this.resolveToolMode(request, activeFormatter),
    nativeLoopMessages?: NormalizedRequest['messages'],
    fidelity?: FidelityNotes,
  ): {
    providerRequest: any;
    prefillResult: BuildResult;
    prefixRewritten: boolean;
    toolMode: 'xml' | 'native';
  } {
    if (fidelity && !activeFormatter.reportsAlterations) fidelity.uninstrumented = true;
    const messages = convertMcpMedia(nativeLoopMessages ?? request.messages);
    if (
      !(activeFormatter.rendersSystemChanges && this.adapter.sendsSystemChanges) &&
      messages.some((message) => message.content.some((block) => block.type === 'system_change'))
    ) {
      throw systemChangeRefusedError(
        `A system_change block goes only through a formatter that renders it (NativeFormatter) and an adapter that sends it (AnthropicAdapter); ` +
        `this request has formatter "${activeFormatter.name}" and adapter "${this.adapter.name}". ` +
        'Send it through those two, or make the change in the request\'s tools and system instead.'
      );
    }
    const additionalStopSequences = Array.isArray(request.stopSequences)
      ? request.stopSequences
      : request.stopSequences?.sequences ?? [];

    const maxParticipantsForStop = request.maxParticipantsForStop
      ?? this.config.maxParticipantsForStop
      ?? 10;

    let prefixRewritten = false;
    const buildResult = activeFormatter.buildMessages(messages, {
      onNormalize: event => {
        if (PREFIX_REWRITING_NORMALIZE_EVENT_KINDS.has(event.kind)) prefixRewritten = true;
        runCallerCode(() => this.config.hooks?.onNormalize?.(event));
      },
      deferCacheBudgetCheck: true,
      participantMode: 'multiuser',
      assistantParticipant: request.assistantParticipant ?? this.config.assistantParticipant ?? 'Claude',
      tools: request.tools,
      toolMode,
      thinking: request.config.thinking,
      systemPrompt: request.system,
      promptCaching: request.promptCaching ?? this.config.defaultPromptCaching ?? true,
      cacheMarkers: request.cacheMarkers ?? 'membrane-system',
      cacheTtl: request.cacheTtl,
      additionalStopSequences,
      maxParticipantsForStop,
      contextPrefix: request.contextPrefix,
      prefillUserMessage: request.prefillUserMessage,
      anthropicServerBlocks: this.adapter.replaysAnthropicServerBlocks === true,
      ...(fidelity ? { fidelity } : {}),
    });

    if (buildResult.ready === false) {
      throw new MembraneNotReadyError(activeFormatter.name);
    }

    if (request.shedOversizeImages) {
      const shed = shedImagesToFitByteBudget(buildResult.messages, undefined, 'transformRequest');
      if (shed > 0 && fidelity) fidelity.unattributed = true;
    } else {
      assertWithinByteBudget(buildResult.messages, undefined, 'transformRequest');
    }

    const providerRequest = {
      ...this.getBaseProviderParams(request.config),
      messages: buildResult.messages,
      system: ownSystemBlocks(buildResult.systemContent),
      stopSequences: buildResult.stopSequences,
      tools: buildResult.nativeTools,
      extra: nativeLoopMessages && activeFormatter.name !== 'openai-responses'
        ? request.providerParams
        : { ...request.providerParams, normalizedMessages: messages },
    };

    // Some models refuse a thinking config on a request that ends in an
    // assistant prefill.
    if (buildResult.assistantPrefill) {
      stripThinkingForPrefill(providerRequest);
    }

    return { providerRequest, prefillResult: buildResult, prefixRewritten, toolMode };
  }

  private static roundReport(input: {
    index: number;
    stopReason: StopReason;
    usage: DetailedUsage | undefined;
    unreported?: ReadonlyArray<'inputTokens' | 'outputTokens'>;
    fidelity: FidelityNotes;
    origins?: readonly MessageOrigin[];
    injectedAlterations?: ReadonlyArray<readonly [number, number]>;
    injectedBatch?: { batch: number; applied: number };
    thinking?: { entries: readonly ProviderInputTransformation[]; messages: readonly NormalizedMessage[] };
  }): RoundReport {
    const messages: number[] = [];
    const injected = new Map<string, [number, number]>();
    const alterInjected = (batch: number, index: number) => injected.set(`${batch}:${index}`, [batch, index]);
    for (const [batch, index] of input.injectedAlterations ?? []) alterInjected(batch, index);
    for (const at of input.fidelity.altered) {
      const origin: MessageOrigin = input.origins ? (input.origins[at] ?? { kind: 'own' }) : { kind: 'input', index: at };
      if (origin.kind === 'input') messages.push(origin.index);
      else if (origin.kind === 'injected') alterInjected(origin.batch, origin.index);
    }
    messages.sort((a, b) => a - b);
    const injectedPairs = [...injected.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const usage: RoundUsage = {};
    const counts = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'thinkingTokens'] as const;
    for (const field of counts) {
      const value = input.usage?.[field];
      if (typeof value === 'number' && !(input.unreported as readonly string[] | undefined)?.includes(field)) usage[field] = value;
    }
    return {
      index: input.index,
      stopReason: input.stopReason,
      usage,
      ...(input.injectedBatch ? { injectedBatch: input.injectedBatch } : {}),
      altered: { messages, injected: injectedPairs },
      fidelity: input.fidelity.established ? 'established' : 'unknown',
      ...(input.thinking
        ? { thinking: Membrane.thinkingReport(input.thinking.entries, input.fidelity, input.origins, input.thinking.messages) }
        : {}),
    };
  }

  private static thinkingReport(
    entries: readonly ProviderInputTransformation[],
    fidelity: FidelityNotes,
    origins: readonly MessageOrigin[] | undefined,
    messages: readonly NormalizedMessage[],
  ): NonNullable<RoundReport['thinking']> {
    const dropped: ThinkingBindingEntry[] = [];
    const mismatchAllowed: ThinkingBindingEntry[] = [];
    for (const entry of entries) {
      const list = entry.type === 'thinking_dropped' ? dropped
        : entry.type === 'thinking_mismatch_allowed' ? mismatchAllowed
          : undefined;
      if (!list) continue;
      const placed: ThinkingBindingEntry = { reason: entry.reason ?? '', path: entry.path ?? '' };
      const at = fidelity.ownerOf(entry.block);
      if (at !== undefined) {
        const origin: MessageOrigin = origins ? (origins[at] ?? { kind: 'own' }) : { kind: 'input', index: at };
        if (origin.kind === 'input') placed.message = origin.index;
        else if (origin.kind === 'injected') placed.injected = [origin.batch, origin.index];
        else if (origin.round !== undefined) placed.round = origin.round;
        const index = Membrane.thinkingBlockIndex(messages[at]?.content, entry.block);
        if (index !== undefined && (placed.message ?? placed.injected ?? placed.round) !== undefined) placed.block = index;
      }
      list.push(placed);
    }
    return { dropped, mismatchAllowed };
  }

  private static thinkingBlockIndex(content: readonly ContentBlock[] | undefined, sent: unknown): number | undefined {
    const wire = sent as { type?: unknown; signature?: unknown; data?: unknown } | null | undefined;
    const key = wire?.type === 'thinking' ? 'signature' : wire?.type === 'redacted_thinking' ? 'data' : undefined;
    if (!content || !key || typeof wire![key] !== 'string') return undefined;
    let found: number | undefined;
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as unknown as { type?: unknown; signature?: unknown; data?: unknown };
      if (block.type !== wire!.type || block[key] !== wire![key]) continue;
      if (found !== undefined) return undefined;
      found = i;
    }
    return found;
  }

  private async streamOnce(
    request: any,
    callbacks: StreamCallbacks,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      progressTimeoutMs?: number;
      progressBounds?: boolean | Partial<ProgressBounds>;
      onRequest?: (rawRequest: unknown) => void;
      wrapThinkingTags?: boolean;
      normalizedRequest: NormalizedRequest;
      formatterName: string;
      requiresAssistantPrefill: boolean;
      promptMessages?: NormalizedRequest['messages'];
      refusalRetries?: number;
      onRetrying?: (info: { attempt: number; maxAttempts: number; category?: string }) => void;
      retry?: boolean;
      onWireCacheMarkers?: (markerCount: number) => void;
      fidelity?: FidelityNotes;
    }
  ): Promise<
    import('./types/provider.js').ProviderResponse & {
      discardedUsage?: DiscardedAttemptsUsage;
      providerCalls: number;
      retryDelaysMs: number[];
    }
  > {
    // TypeScript checks excess properties only on object literals, so nothing
    // else keeps `normalizedRequest` out of the adapter's options.
    const { normalizedRequest, formatterName, requiresAssistantPrefill, refusalRetries, onRetrying, retry, onWireCacheMarkers, progressTimeoutMs, progressBounds, fidelity, ...adapterOptions } = options;
    const hooked = fidelity !== undefined && this.config.hooks?.beforeRequest !== undefined;
    const beforeHook = hooked ? requestFingerprint(request) : undefined;
    const normalizedBefore = hooked ? requestFingerprint(normalizedRequest) : undefined;
    let finalRequest = (await this.applyBeforeRequestHook(normalizedRequest, request)) as typeof request;
    if (beforeHook !== undefined) {
      const handed = requestFingerprint(request);
      const normalizedChanged = requestFingerprint(normalizedRequest) !== normalizedBefore;
      if (handed !== beforeHook || normalizedChanged) fidelity!.mutatedInPlace = true;
      const sent = finalRequest === request ? handed : requestFingerprint(finalRequest);
      if (sent !== beforeHook || normalizedChanged) fidelity!.unattributed = true;
    }
    if (fidelity && !this.adapter.reportsContentAlterations) fidelity.uninstrumented = true;

    const floatAfterHook = this.floatsAfterHook.get(request);
    if (floatAfterHook) {
      assertCacheMarkersWithinLimit(finalRequest, 'streamOnce');
      finalRequest = {
        ...finalRequest,
        messages: ownMessageBlocks(finalRequest.messages, fidelity ? (original, copy) => fidelity.ownCopy(original, copy) : undefined),
      };
      const withheldAt = placeFloatingMarker(finalRequest, floatAfterHook, true, this.adapter.sendsCacheMarkersOn);
      if (withheldAt !== undefined) this.warnFloatBudgetExhausted(withheldAt);
    }

    const markerCount = normalizedRequest.cacheMarkers === 'cm-owned'
      ? assertCacheMarkersWithinLimit(finalRequest, 'streamOnce')
      : clampCacheMarkers(finalRequest, 'streamOnce').total;
    onWireCacheMarkers?.(markerCount);
    const useWireReceipt = this.adapter.cacheReceiptBasis === 'wire-request';
    let receiptEmitted = false;
    let attemptAlterations: unknown[] = [];
    if (!useWireReceipt) deliverCacheWireReceipt(normalizedRequest, finalRequest);
    const receiptGuard = useWireReceipt && normalizedRequest.onCacheWireReceipt
      ? this.wireReceiptGuard(adapterOptions.signal)
      : undefined;
    const observedOptions = {
      ...adapterOptions,
      requestContext: {
        formatterName,
        toolMode: requiresAssistantPrefill ? 'xml' as const : 'native' as const,
        toolsDeclared: Boolean(normalizedRequest.tools?.length),
        requiresAssistantPrefill,
      },
      ...(receiptGuard ? { signal: receiptGuard.signal } : {}),
      ...(fidelity ? { onContentAltered: (block?: unknown) => { attemptAlterations.push(block); } } : {}),
      onRequest: (wireRequest: unknown) => {
        if (useWireReceipt) {
          const wireCount = countWireCacheMarkers(wireRequest as Parameters<typeof countWireCacheMarkers>[0]);
          onWireCacheMarkers?.(wireCount);
          if (!receiptEmitted) {
            receiptEmitted = true;
            receiptGuard?.emit(() => deliverCacheWireReceipt(normalizedRequest, wireRequest));
          }
        }
        adapterOptions.onRequest?.(wireRequest);
      },
    };

    const maxAttempts = onRetrying ? refusalBudget(refusalRetries) : 0;
    let retried = 0;
    let discardedUsage: DiscardedAttemptsUsage | undefined;
    let providerCalls = 0;
    let tries = 0;
    const retryDelaysMs: number[] = [];
    while (true) {
      providerCalls++;
      tries++;
      attemptAlterations = [];
      const localStops = requiresAssistantPrefill ? undefined : new LocalStopSequences(finalRequest.stopSequences, callbacks);
      let delivered = false;
      const sent = localStops?.callbacks ?? callbacks;
      const attemptCallbacks: StreamCallbacks = {
        onChunk: (chunk) => { delivered = true; sent.onChunk(chunk); },
        ...(sent.onContentBlock
          ? { onContentBlock: (index: number, block: unknown) => { delivered = true; sent.onContentBlock!(index, block); } }
          : {}),
        ...(sent.onThinkingSignature
          ? { onThinkingSignature: (index: number, signature: string) => { delivered = true; sent.onThinkingSignature!(index, signature); } }
          : {}),
      };
      let attemptResult: ProviderResponse | undefined;
      let failure: { error: unknown } | undefined;
      const progress = createProgressDeadline(observedOptions.signal, progressTimeoutMs, resolveProgressBounds(progressBounds));
      try {
        const streamCall = this.adapter.stream(
          finalRequest,
          attemptCallbacks,
          progress.onProgress
            ? { ...observedOptions, signal: progress.signal, onProgress: progress.onProgress, ...(progress.onSend ? { onSend: progress.onSend } : {}) }
            : observedOptions,
        );
        attemptResult = receiptGuard ? await receiptGuard.settle(streamCall) : await streamCall;
      } catch (error) {
        try { localStops?.release(); } catch { }
        failure = { error };
      } finally {
        progress.cleanup();
      }
      if (failure) {
        const typed = errorFromThrown(failure.error);
        if (delivered) throw typed;
        if (adapterOptions.signal?.aborted) throw typed;
        const errorInfo = classifyError(typed);
        const plan = this.retryPlan(errorInfo, tries, isDeadlineExpiry(typed), retry);
        if (!plan.retry) throw typed;
        const hooks = this.config.hooks;
        if (hooks?.onError) {
          const decision = await awaitCallerCode(() => hooks.onError!(errorInfo, tries));
          if (decision === 'abort') throw typed;
        }
        const delayMs = plan.delayMs;
        retryDelaysMs.push(delayMs);
        await this.sleep(delayMs, adapterOptions.signal);
        continue;
      }
      const afterLocalStops = localStops ? localStops.finish(attemptResult!) : attemptResult!;
      const result: ProviderResponse = {
        ...afterLocalStops,
        providerStopReason: this.providerReasonFor(attemptResult!),
        usage: normalizeUsageToCacheExcluded(afterLocalStops.usage, this.adapter.name, this.adapter.usageCacheConvention),
      };
      if (result.stopReason !== 'refusal' || retried >= maxAttempts) {
        for (const block of attemptAlterations) fidelity?.alterBlock(block);
        return {
          ...result,
          providerCalls,
          retryDelaysMs,
          ...(discardedUsage ? { discardedUsage } : {}),
        };
      }
      retried++;
      tries = 0;
      discardedUsage = this.mergeDiscardedAttempts(
        discardedUsage,
        this.discardedAttemptFrom(result.usage)
      );
      onRetrying!({
        attempt: retried,
        maxAttempts,
        category: isStopToken(result.refusalCategory) ? result.refusalCategory : undefined,
      });
    }
  }

  private buildContinuationRequest(
    originalRequest: NormalizedRequest,
    prefillResult: BuildResult,
    accumulated: string
  ): any {
    // Anthropic refuses final assistant content that ends in whitespace.
    const trimmedAccumulated = accumulated.trimEnd();

    const baseOffset = prefillResult.accumulatedBaseOffset ?? 0;
    const trailingContent = accumulated.slice(baseOffset).trimEnd();

    const messages = [...prefillResult.messages];
    
    let foundAssistant = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        messages[i] = { role: 'assistant', content: trailingContent };
        foundAssistant = true;
        break;
      }
    }
    
    if (!foundAssistant) {
      messages.push({ role: 'assistant', content: trailingContent });
    }
    
    return stripThinkingForPrefill({
      ...this.getBaseProviderParams(originalRequest.config),
      thinking: undefined,
      messages,
      system: ownSystemBlocks(prefillResult.systemContent) ?? undefined,
      stopSequences: prefillResult.stopSequences,
      extra: {
        ...originalRequest.providerParams,
        normalizedMessages: originalRequest.messages,
        prompt: trimmedAccumulated,
      },
    });
  }

  /** The Anthropic API allows images only in user turns. */
  private buildContinuationRequestWithImages(
    originalRequest: NormalizedRequest,
    prefillResult: BuildResult,
    accumulated: string,
    images: ProviderImageBlock[],
    afterImageXml: string
  ): any {
    const trimmedAccumulated = accumulated.trimEnd();

    const baseOffset = prefillResult.accumulatedBaseOffset ?? 0;
    const trailingContent = accumulated.slice(baseOffset).trimEnd();

    const messages: any[] = prefillResult.messages.map(msg => ({ ...msg }));

    let insertIdx = messages.length;
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx].role === 'assistant') {
        insertIdx = idx;
        break;
      }
    }

    // Anthropic refuses final assistant content that ends in whitespace.
    const trimmedAfterXml = afterImageXml.trimEnd();
    const splitTurnMessages = [
      { role: 'assistant', content: trailingContent },
      { role: 'user', content: images },
      { role: 'assistant', content: trimmedAfterXml },
    ];

    if (insertIdx < messages.length) {
      messages.splice(insertIdx, 1, ...splitTurnMessages);
    } else {
      messages.push(...splitTurnMessages);
    }

    persistImageSplit(prefillResult, messages, accumulated.length);

    return stripThinkingForPrefill({
      ...this.getBaseProviderParams(originalRequest.config),
      thinking: undefined,
      messages,
      system: ownSystemBlocks(prefillResult.systemContent) ?? undefined,
      stopSequences: prefillResult.stopSequences,
      extra: {
        ...originalRequest.providerParams,
        normalizedMessages: originalRequest.messages,
        prompt: trimmedAccumulated,
      },
    });
  }

  private transformResponse(
    providerResponse: any,
    request: NormalizedRequest,
    prefillResult: {
      cacheMarkersApplied?: number;
    },
    startTime: number,
    attempts: number,
    xmlToolProtocol: boolean,
    rawRequest?: unknown
  ): NormalizedResponse {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    let rawAssistantText = '';
    let offered: readonly { name: string }[] | undefined;

    if (Array.isArray(providerResponse.content)) {
      for (const block of providerResponse.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
          rawAssistantText += block.text;
        } else if (block.type === 'tool_use') {
          offered ??= toolsOffered(request);
          const name = restoreToolName(block.name, offered);
          const toolUse: ToolUseContent = {
            type: 'tool_use',
            id: block.id,
            name,
            ...toolUseInputFromValue(block.input),
            ...(block.unparseableInput !== undefined ? { unparseableInput: block.unparseableInput } : {}),
          };
          content.push(toolUse);
          toolCalls.push(toolCallOf(toolUse));
        } else if (block.type === 'thinking') {
          content.push({
            type: 'thinking',
            thinking: block.thinking ?? '',
            ...(block.signature ? { signature: block.signature } : {}),
          });
        } else if (block.type === 'redacted_thinking') {
          // A redacted_thinking block's encrypted `data` goes back as it is.
          content.push({ ...(block as any) } as ContentBlock);
        } else if (block.type === 'image') {
          content.push({ ...block } as ContentBlock);
        } else if (block.type === 'generated_image') {
          content.push({
            type: 'generated_image',
            data: block.data,
            mimeType: block.mimeType,
          });
        } else if (block && (block.rawItem || block.type)) {
          content.push(providerItemCarrier(block));
        }
      }
    } else if (typeof providerResponse.content === 'string') {
      content.push({ type: 'text', text: providerResponse.content });
      rawAssistantText = providerResponse.content;
    }

    // The API stops before the stop sequence, leaving a closing tag out of the
    // text.
    const stoppedOnClosingTag = xmlToolProtocol && providerResponse.stopReason === 'stop_sequence' &&
      providerResponse.stopSequence?.startsWith('</');
    if (stoppedOnClosingTag && providerResponse.stopSequence) {
      rawAssistantText += providerResponse.stopSequence;
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i]!;
        if (block.type === 'text' && !isRawItemCarrier(block)) {
          (block as { type: 'text'; text: string }).text += providerResponse.stopSequence;
          break;
        }
      }
    }

    let emptyToolBlocks = 0;
    if (xmlToolProtocol && toolCalls.length === 0 && rawAssistantText.includes('<function_calls>')) {
      const parsed = parseToolCalls(rawAssistantText, { tools: request.tools });
      if (parsed?.calls.length) {
        for (const tc of parsed.calls) {
          toolCalls.push(tc);
        }
      } else if (parsed) {
        emptyToolBlocks = 1;
      }
    }
    const unclosedToolBlock = xmlToolProtocol && endsWithPartialToolBlock(rawAssistantText);

    let stopReason = this.mapStopReason(providerResponse.stopReason);
    if (xmlToolProtocol) this.reportToolParseDiagnostics({ unclosedToolBlock, emptyToolBlocks }, stopReason);
    const endTurnTools = xmlToolProtocol
      ? undefined
      : this.toolUseWithEndTurn(content, stopReason, providerResponse, 0);
    if (endTurnTools?.treatedAsToolUse) stopReason = 'tool_use';
    const durationMs = Date.now() - startTime;
    const usage: DetailedUsage = {
      inputTokens: providerResponse.usage.inputTokens,
      outputTokens: providerResponse.usage.outputTokens,
      cacheCreationTokens: providerResponse.usage.cacheCreationTokens,
      cacheReadTokens: providerResponse.usage.cacheReadTokens,
      thinkingTokens: providerResponse.usage.thinkingTokens,
      estimatedCost: this.estimateCost(providerResponse.usage, request.config.model, providerResponse.model),
    };

    return {
      content,
      rawAssistantText,
      toolCalls,
      toolResults: [],
      stopReason,
      usage,
      details: {
        stop: { ...this.buildStopInfo(stopReason, providerResponse.providerStopReason, providerResponse.stopSequence), unclosedToolBlock },
        usage,
        timing: {
          totalDurationMs: durationMs,
          attempts,
        },
        model: {
          requested: request.config.model,
          actual: providerResponse.model,
          provider: this.adapter.name,
        },
        cache: {
          markersInRequest: prefillResult.cacheMarkersApplied ?? 0,
          tokensCreated: providerResponse.usage.cacheCreationTokens ?? 0,
          tokensRead: providerResponse.usage.cacheReadTokens ?? 0,
          hitRatio: this.calculateCacheHitRatio(providerResponse.usage),
        },
        ...(endTurnTools ? { anomalies: [endTurnTools] } : {}),
      },
      raw: {
        request: rawRequest ?? null,
        response: providerResponse.raw,
      },
    };
  }

  private reportToolParseDiagnostics(
    diagnostics: {
      unclosedToolBlock: boolean;
      emptyToolBlocks: number;
      splicedToolBlocks?: number;
      unclosedInvokeHeads?: number;
    },
    stopReason: StopReason
  ): void {
    const warnLog = this.warnLogger();

    if (diagnostics.unclosedToolBlock) {
      warnLog.warn(
        `[membrane] turn ended (${stopReason}) with an unclosed tool block in the ` +
        `assistant text — the loop does not resume on a length stop. Persisting this ` +
        `turn verbatim lets the next round's closing tag splice onto the stale ` +
        `opener; see details.stop.unclosedToolBlock.`
      );
    }

    if (diagnostics.emptyToolBlocks > 0) {
      warnLog.warn(
        `[membrane] ${diagnostics.emptyToolBlocks} function_calls block(s) parsed to ` +
        `zero tool calls — always a defect, never a normal ending. The call was ` +
        `returned as assistant text and nothing executed.`
      );
    }

    if (diagnostics.splicedToolBlocks) {
      warnLog.warn(
        `[membrane] ${diagnostics.splicedToolBlocks} tool block(s) spanned a second ` +
        `<function_calls> opener and were re-anchored to the innermost one — an ` +
        `earlier truncated block is present in this conversation's assistant text.`
      );
    }

    if (diagnostics.unclosedInvokeHeads) {
      warnLog.warn(
        `[membrane] ${diagnostics.unclosedInvokeHeads} <invoke> head(s) were left ` +
        `unclosed and swallowed the invoke that followed — nothing was dispatched ` +
        `under an unclosed head's name, and the call it absorbed was re-anchored ` +
        `and ran with its own parameters.`
      );
    }
  }

  private buildFinalResponse(
    accumulated: string,
    contentBlocks: ContentBlock[],
    stopReason: StopReason,
    turnUsage: TurnUsageAccumulator,
    request: NormalizedRequest,
    xmlToolProtocol: boolean,
    prefillResult: {
      cacheMarkersApplied?: number;
    },
    startTime: number,
    attempts: number,
    rawRequest: unknown,
    rawResponse: unknown,
    executedToolCalls: ToolCall[] = [],
    executedToolResults: ToolResult[] = [],
    startInsideBlock: 'thinking' | 'tool_call' | 'tool_result' | null = null,
    triggeredSequence?: string,
    providerStopReason?: string,
    splitRounds: readonly SplitResultsRound[] = [],
  ): NormalizedResponse {
    const usage = turnUsage.total;
    let finalContent: ContentBlock[];
    let toolCalls: ToolCall[];
    let toolResults: ToolResult[];

    let unclosedToolBlock = false;

    if (contentBlocks.length > 0 || !xmlToolProtocol) {
      finalContent = contentBlocks;
      toolCalls = executedToolCalls;
      toolResults = executedToolResults;
    } else {
      const parseOptions = {
        tools: request.tools,
        ...(startInsideBlock ? { startInsideBlock } : {}),
      };
      const parsed = parseAccumulatedIntoBlocks(accumulated, parseOptions);
      const attached = attachSplitResults(parsed, splitRounds);
      finalContent = attached.blocks;
      toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : executedToolCalls;
      toolResults = attached.toolResults.length > 0 ? attached.toolResults : executedToolResults;
      unclosedToolBlock = parsed.unclosedToolBlock;
      this.reportToolParseDiagnostics(parsed, stopReason);
    }

    const durationMs = Date.now() - startTime;

    return {
      content: finalContent,
      rawAssistantText: accumulated,
      toolCalls,
      toolResults,
      stopReason,
      usage,
      details: {
        stop: { ...this.buildStopInfo(stopReason, providerStopReason, triggeredSequence), unclosedToolBlock },
        usage,
        timing: {
          totalDurationMs: durationMs,
          attempts,
        },
        model: {
          requested: request.config.model,
          actual: turnUsage.lastServedModel || request.config.model,
          provider: this.adapter.name,
          perRound: turnUsage.perRound,
        },
        cache: {
          markersInRequest: prefillResult.cacheMarkersApplied ?? 0,
          tokensCreated: usage.cacheCreationTokens ?? 0,
          tokensRead: usage.cacheReadTokens ?? 0,
          hitRatio: this.calculateCacheHitRatio(usage),
        },
      },
      raw: {
        request: rawRequest,
        response: rawResponse,
      },
    };
  }

  /**
   * Anthropic has sent client tool calls under an `end_turn` stop, where a
   * response carrying a tool call should stop with `tool_use`.
   */
  private toolUseWithEndTurn(
    responseBlocks: ContentBlock[],
    mappedStopReason: StopReason,
    provider: {
      providerStopReason?: string;
      model?: string;
      responseId?: string;
      requestId?: string;
    },
    round: number,
  ): ResponseAnomaly | undefined {
    if (mappedStopReason !== 'end_turn' || provider.providerStopReason !== 'end_turn') return undefined;
    const calls = responseBlocks.filter(
      (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use'
    );
    if (calls.length === 0) return undefined;
    const incomplete = calls.filter((c) => c.unparseableInput !== undefined);
    const treatedAsToolUse = incomplete.length === 0;
    const anomaly: ResponseAnomaly = {
      kind: 'tool_use_with_end_turn',
      round,
      providerStopReason: 'end_turn',
      toolNames: calls.map((c) => c.name),
      toolUseIds: calls.map((c) => c.id),
      treatedAsToolUse,
      model: provider.model ?? '',
      ...(provider.responseId ? { messageId: provider.responseId } : {}),
      ...(provider.requestId ? { requestId: provider.requestId } : {}),
    };
    this.warnLogger().warn(
      `[membrane] ${provider.model || '(unknown model)'} ended round ${round} with ` +
      `stop_reason end_turn but returned ${calls.length} tool call(s) ` +
      `(${anomaly.toolNames.join(', ')}); ` +
      (treatedAsToolUse
        ? 'all complete, treating the round as tool_use'
        : `${incomplete.length} incomplete (${incomplete.map((c) => c.id).join(', ')}), leaving the round as end_turn, nothing runs`) +
      ` — message ${provider.responseId ?? '(no id)'}, request ${provider.requestId ?? '(no id)'}`,
    );
    return anomaly;
  }

  private buildStopInfo(
    reason: StopReason,
    providerReason: string | undefined,
    triggeredSequence: string | undefined
  ): StopInfo {
    return {
      reason,
      triggeredSequence,
      wasTruncated: reason === 'max_tokens',
      ...(providerReason !== undefined ? { providerReason } : {}),
    };
  }

  private mergeDiscardedAttempts(
    carry: DiscardedAttemptsUsage | undefined,
    add: DiscardedAttemptsUsage | undefined
  ): DiscardedAttemptsUsage | undefined {
    if (!add) return carry;
    const next: DiscardedAttemptsUsage = carry
      ? { ...carry }
      : { attempts: 0, inputTokens: 0, outputTokens: 0 };
    next.attempts += add.attempts;
    next.inputTokens += add.inputTokens;
    next.outputTokens += add.outputTokens;
    if (add.cacheCreationTokens != null) {
      next.cacheCreationTokens = (next.cacheCreationTokens ?? 0) + add.cacheCreationTokens;
    }
    if (add.cacheReadTokens != null) {
      next.cacheReadTokens = (next.cacheReadTokens ?? 0) + add.cacheReadTokens;
    }
    return next;
  }

  private discardedAttemptFrom(usage: DetailedUsage | BasicUsage | undefined): DiscardedAttemptsUsage {
    const detailed = (usage ?? { inputTokens: 0, outputTokens: 0 }) as DetailedUsage;
    return {
      attempts: 1,
      inputTokens: detailed.inputTokens ?? 0,
      outputTokens: detailed.outputTokens ?? 0,
      ...(detailed.cacheCreationTokens != null ? { cacheCreationTokens: detailed.cacheCreationTokens } : {}),
      ...(detailed.cacheReadTokens != null ? { cacheReadTokens: detailed.cacheReadTokens } : {}),
    };
  }

  private pricedDiscardedAttempts(
    discarded: DiscardedAttemptsUsage | undefined,
    model: string
  ): DiscardedAttemptsUsage | undefined {
    if (!discarded) return undefined;
    const estimatedCost = this.estimateCost(discarded, model);
    return estimatedCost ? { ...discarded, estimatedCost } : discarded;
  }

  private mapStopReason(adapterReason: string): StopReason {
    switch (adapterReason) {
      case 'end_turn':
        return 'end_turn';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      case 'tool_use':
        return 'tool_use';
      case 'pause_turn':
        // Anthropic's pause_turn: the provider paused a long-running turn, and the
        // caller resumes it.
        return 'pause_turn';
      case 'refusal':
        return 'refusal';
      default: {
        const shown = shownStopReason(adapterReason);
        if (!warnedStopReasons.has(shown) && warnedStopReasons.size < MAX_LOGGED_STOP_REASONS) {
          warnedStopReasons.add(shown);
          console.warn(
            `[membrane] Unmapped adapter stop reason ${shown} normalized to end_turn ` +
              '(details.stop.providerReason carries the adapter\'s providerStopReason if that\'s a non-empty string, ' +
              'else this stop reason if it\'s one; logged once per reason)'
          );
          if (warnedStopReasons.size === MAX_LOGGED_STOP_REASONS) {
            console.warn(
              `[membrane] ${MAX_LOGGED_STOP_REASONS} distinct unmapped stop reasons logged; further ones are not ` +
                '(details.stop.providerReason still carries the adapter\'s providerStopReason if that\'s a non-empty ' +
                'string, else the stop reason if it\'s one)'
            );
          }
        }
        return 'end_turn';
      }
    }
  }

  private providerReasonFor(
    result: Pick<ProviderResponse, 'stopReason' | 'providerStopReason'>
  ): string | undefined {
    if (isStopToken(result.providerStopReason)) return result.providerStopReason;
    const token: unknown = result.stopReason;
    return isStopToken(token) && this.mapStopReason(token) !== token ? token : undefined;
  }

  private calculateCacheHitRatio(usage: Pick<DetailedUsage, 'inputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): number {
    return calculateCacheHitRatio(usage);
  }

  private resolvePricing(
    requestedModel: string,
    actualModel?: string
  ): import('./types/provider.js').ModelPricing | undefined {
    const servedModel = actualModel && actualModel !== requestedModel ? actualModel : undefined;
    const fromRegistry = (modelId: string | undefined) =>
      modelId === undefined ? undefined : runCallerCode(() => this.registry?.getPricing(modelId));
    const fromBuiltin = (modelId: string | undefined) =>
      modelId === undefined ? undefined : getDefaultPricing(modelId);

    return fromRegistry(servedModel)
      ?? fromRegistry(requestedModel)
      ?? fromBuiltin(servedModel)
      ?? fromBuiltin(requestedModel);
  }

  private estimateCost(
    usage: import('./utils/cost.js').CostableUsage,
    requestedModel: string,
    actualModel?: string
  ): import('./types/response.js').CostBreakdown | undefined {
    const pricing = this.resolvePricing(requestedModel, actualModel);
    if (!pricing) {
      warnUnpricedModel(actualModel || requestedModel);
      return undefined;
    }
    return calculateCost(usage, pricing);
  }

  private retryPlan(
    errorInfo: ErrorInfo,
    attempt: number,
    deadline: boolean,
    retry: boolean | undefined,
  ): { retry: true; delayMs: number } | { retry: false } {
    if (retry === false) return { retry: false };
    const decision = retryDecision(
      classifyFailure({ ...errorInfo, deadline }),
      attempt,
      errorInfo.retryAfterMs,
      this.retrySettings,
    );
    return decision.retry ? decision : { retry: false };
  }

  private attachRawRequest(error: unknown, rawRequest: unknown): MembraneError {
    if (isBuildRefusal(error)) return error;
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    return errorFromThrown(error, rawRequest);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        cancel();
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      const cancel = setLongTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private isAbortError(error: unknown): boolean {
    return isTimeoutAbortError(error) || isTypedAbortError(error);
  }

  /**
   * `AbortSignal.timeout()` rejects a fetch with a DOMException named
   * `TimeoutError`, not `AbortError`.
   */
  private isCancellation(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true || this.isAbortError(error);
  }

  private abortOutcome(error: unknown, signal?: AbortSignal): { reason: 'user' | 'timeout' | 'error'; message?: string } {
    if (signal?.aborted) return { reason: 'user' };
    const reason = classifyError(error).type === 'timeout' ? 'timeout' : 'error';
    return error instanceof Error && error.message ? { reason, message: error.message } : { reason };
  }

  private buildAbortedResponse(
    accumulated: string,
    usage: BasicUsage,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    outcome: { reason: 'user' | 'timeout' | 'error'; message?: string },
    blocks: ContentBlock[]
  ): AbortedResponse {
    return {
      aborted: true,
      partialContent: blocks.length > 0 ? blocks : undefined,
      partialUsage: usage,
      ...outcome,
      rawAssistantText: accumulated || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    };
  }

  /**
   * Stream inference with yielding control for tool execution.
   *
   * Unlike `stream()` which uses callbacks for tool execution, this method
   * returns an async iterator that yields control back to the caller when
   * tool calls are detected. The caller provides results via `provideToolResults()`.
   *
   * @example
   * ```typescript
   * const stream = membrane.streamYielding(request, options);
   *
   * for await (const event of stream) {
   *   switch (event.type) {
   *     case 'tokens':
   *       process.stdout.write(event.content);
   *       break;
   *     case 'tool-calls':
   *       const results = await executeTools(event.calls);
   *       stream.provideToolResults(results);
   *       break;
   *     case 'complete':
   *       console.log('Done:', event.response);
   *       break;
   *   }
   * }
   * ```
   */
  streamYielding(
    request: NormalizedRequest,
    options: YieldingStreamOptions = {}
  ): YieldingStream {
    resolveProgressBounds(options.progressBounds);
    const activeFormatter = this.resolveActiveFormatter();
    const toolMode = this.resolveToolMode(request, activeFormatter);

    if (toolMode !== 'native' && (options.refusalRetries ?? 0) > 0) {
      this.warnLogger().warn(
        '[membrane] refusalRetries is ignored in XML tool mode ' +
        '(native-only for now) — the turn will surface the refusal as before.',
      );
    }

    const runInference = toolMode === 'native'
      ? (stream: YieldingStreamImpl) => this.runNativeToolsYielding(request, options, stream, activeFormatter)
      : (stream: YieldingStreamImpl) => this.runXmlToolsYielding(request, options, stream, activeFormatter);

    return new YieldingStreamImpl(options, runInference);
  }

  private async runXmlToolsYielding(
    request: NormalizedRequest,
    options: YieldingStreamOptions,
    stream: YieldingStreamImpl,
    activeFormatter: PrefillFormatter = this.resolveActiveFormatter()
  ): Promise<void> {
    const startTime = Date.now();
    const {
      maxToolDepth: maxToolDepthOpt,
      emitTokens = true,
      emitBlocks = true,
      emitUsage = true,
    } = options;
    const maxToolDepth =
      maxToolDepthOpt === undefined || maxToolDepthOpt === -1
        ? Infinity
        : maxToolDepthOpt;

    const MIN_ROUND_PROGRESS_CHARS = 16;
    const MAX_CONSECUTIVE_STALLED_RESUMPTIONS = 3;
    const RESUMPTION_WARN_ROUNDS = 5;
    const maxResumptionRounds =
      options.maxResumptionRounds === undefined
        ? 24
        : options.maxResumptionRounds === -1
          ? Infinity
          : options.maxResumptionRounds;
    let resumptionRounds = 0;
    let consecutiveStalledResumptions = 0;
    let enteredViaResumption = false;
    let prevRoundStopSequence: string | undefined;
    const warnLog = this.warnLogger();

    const formatter = activeFormatter;
    const xmlToolProtocol = formatter.supportsXmlTools;
    const streamedThinking = new StreamedThinking();
    const parser = formatter.createStreamParser();
    let toolDepth = 0;
    let providerCalls = 0;
    let rounds = 0;
    const retryDelaysMs: number[] = [];
    let warnedInjectionUnsupported = false;
    const turnUsage = new TurnUsageAccumulator(
      request.config.model,
      (servedModel) => this.resolvePricing(request.config.model, servedModel),
    );
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let lastProviderStopReason: string | undefined;
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    const providerImageBlocks: ContentBlock[] = [];

    const providerThinkingBlocks: ContentBlock[] = [];

    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];
    const splitRounds: SplitResultsRound[] = [];

    const buildFidelity = new FidelityNotes();
    let { providerRequest, prefillResult } = this.transformRequest(request, formatter, 'xml', undefined, buildFidelity);
    let injectedBatches = 0;
    let hookAlteredState = false;

    let initialPrefillLength = 0;
    let roundStartLen = 0;
    let initialBlockType: 'thinking' | 'tool_call' | 'tool_result' | null = null;
    if (prefillResult.assistantPrefill) {
      parser.push(prefillResult.assistantPrefill);
      initialPrefillLength = prefillResult.assistantPrefill.length;
      roundStartLen = initialPrefillLength;
      if (parser.isInsideBlock()) {
        const blockType = parser.getCurrentBlockType();
        if (blockType === 'thinking' || blockType === 'tool_call' || blockType === 'tool_result') {
          initialBlockType = blockType;
        }
      }
    }

    const prefillDepths = parser.getDepths();

    const registerResumptionRound = (): boolean => {
      resumptionRounds++;
      if (resumptionRounds === RESUMPTION_WARN_ROUNDS) {
        warnLog.warn(
          `[membrane] automatic resumption at round ${resumptionRounds} ` +
          `(${turnUsage.total.inputTokens} input tokens so far this turn) — ` +
          `a spin shows up here before it shows up on the bill`
        );
      }
      if (resumptionRounds > maxResumptionRounds) {
        warnLog.warn(
          `[membrane] automatic resumption cap (${maxResumptionRounds}) reached — ` +
          `ending turn with stopReason 'round_limit'. ` +
          `${turnUsage.total.inputTokens} input tokens spent this turn.`
        );
        return false;
      }
      return true;
    };

    const abortedPartial = () => {
      const newContent = parser.getAccumulated().slice(initialPrefillLength);
      return {
        partialContent: xmlToolProtocol
          ? attachSplitResults(parseAccumulatedIntoBlocks(newContent, { tools: request.tools, ...(initialBlockType ? { startInsideBlock: initialBlockType } : {}) }), splitRounds).blocks
          : streamedThinking.content(newContent, (value, context) => formatter.parseContentBlocks(value, request.tools, context)),
        rawAssistantText: newContent,
        toolCalls: [...executedToolCalls],
        toolResults: [...executedToolResults],
      };
    };
    stream.setAbortSnapshot(abortedPartial);

    try {
      while (toolDepth <= maxToolDepth) {
        if (stream.isCancelled) return;

        let detectedStopSequence: string | null = null;
        let truncatedAccumulated: string | null = null;
        const streamedFrom = parser.getAccumulated().length;
        const roundFidelity = buildFidelity.copy();

        let typedCallbacks = false;
        let sawChunk = false;
        const textStarts = new Map<number, number>();
        streamedThinking.beginRound(parser.getAccumulated().length - initialPrefillLength);
        const tracker = new NativeBlockTracker((event) => { if (typedCallbacks && emitBlocks) stream.emit({ type: 'block', event }); });
        const forward = (emissions: ProcessChunkResult['emissions']) => {
          for (const emission of emissions) {
            if (emission.kind === 'blockEvent') {
              if (emitBlocks && !typedCallbacks) stream.emit({ type: 'block', event: emission.event });
            } else if (emitTokens) {
              stream.emit({ type: 'tokens', content: emission.text, meta: typedCallbacks ? { ...emission.meta, blockIndex: tracker.blockIndex } : emission.meta });
            }
          }
        };
        const forwardOwn = (emissions: ProcessChunkResult['emissions']) => {
          if (!typedCallbacks) forward(emissions);
        };
        const onProviderBlock = (index: number, block: unknown) => {
          if (!xmlToolProtocol && (!detectedStopSequence || textStarts.has(index))) {
            const type = (block as { type?: string } | undefined)?.type;
            if (!sawChunk && (type === 'text' || type === 'thinking' || type === 'redacted_thinking')) typedCallbacks = true;
            const accepted = truncatedAccumulated ?? parser.getAccumulated();
            const offset = accepted.length - initialPrefillLength;
            let reported = block;
            if (type === 'text') {
              const start = textStarts.get(index);
              if (start === undefined) textStarts.set(index, offset);
              else reported = { ...(block as object), text: accepted.slice(initialPrefillLength + start) };
            }
            streamedThinking.onBlock(index, reported, offset);
            tracker.onProviderBlock(index, reported);
          }
        };

        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (detectedStopSequence || stream.isCancelled) {
                return;
              }

              sawChunk = true;
              if (!xmlToolProtocol && tracker.currentType === 'thinking') {
                streamedThinking.onThinkingChunk(tracker.blockIndex, chunk);
                if (emitTokens) stream.emit({ type: 'tokens', content: chunk, meta: { type: 'thinking', visible: false, blockIndex: tracker.blockIndex } });
                return;
              }
              const { found, head, emissions } = parseUpToStop(parser, chunk, streamedFrom, prefillResult.stopSequences);
              if (found) {
                detectedStopSequence = found.stop;
                truncatedAccumulated = head;
              }
              forward(emissions);
            },
            onContentBlock: onProviderBlock,
            onThinkingSignature: (index, signature) => streamedThinking.onSignature(index, signature),
          },
          {
            signal: stream.signal,
            timeoutMs: options.timeoutMs,
            idleTimeoutMs: options.idleTimeoutMs,
            progressTimeoutMs: options.progressTimeoutMs,
            progressBounds: options.progressBounds,
            retry: options.retry,
            normalizedRequest: request,
            formatterName: formatter.name,
            requiresAssistantPrefill: true,
            wrapThinkingTags: xmlToolProtocol,
            onWireCacheMarkers: (count) => { prefillResult.cacheMarkersApplied = count; },
            onRequest: (req: unknown) => { rawRequest = req; },
            ...(emitUsage ? { fidelity: roundFidelity } : {}),
          }
        );

        if (typedCallbacks) tracker.flushAfterProviderReturn();
        rounds++;
        providerCalls += streamResult.providerCalls;
        retryDelaysMs.push(...streamResult.retryDelaysMs);

        if (detectedStopSequence && truncatedAccumulated !== null) {
          if (parser.getAccumulated() !== truncatedAccumulated) {
            parser.reset();
            parser.push(truncatedAccumulated);
          }
          streamResult.stopReason = 'stop_sequence';
          streamResult.stopSequence = detectedStopSequence;
        }

        this.captureProviderImageBlocks(streamResult.content, providerImageBlocks);

        this.captureProviderThinkingBlocks(streamResult.content, providerThinkingBlocks);

        rawResponse = streamResult.raw;
        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastProviderStopReason = streamResult.providerStopReason;
        lastStopSequence = streamResult.stopSequence ?? undefined;

        const usageSoFar = turnUsage.addRound(streamResult.model, streamResult.usage);
        if (roundFidelity.mutatedInPlace) hookAlteredState = true;
        if (hookAlteredState) roundFidelity.unattributed = true;
        if (emitUsage) {
          stream.emit({
            type: 'usage',
            usage: usageSoFar,
            round: Membrane.roundReport({
              index: rounds - 1,
              stopReason: lastStopReason,
              usage: turnUsage.lastRound?.usage,
              unreported: streamResult.unreportedUsage,
              fidelity: roundFidelity,
              ...(injectedBatches > 0 ? { injectedBatch: { batch: injectedBatches - 1, applied: 0 } } : {}),
              ...(streamResult.inputTransformations
                ? { thinking: { entries: streamResult.inputTransformations, messages: request.messages } }
                : {}),
            }),
          });
        }

        forwardOwn(parser.flush().emissions);

        const streamedThisRound = parser.getAccumulated().length - streamedFrom;
        if (
          enteredViaResumption &&
          lastStopReason === 'stop_sequence' &&
          streamedThisRound < MIN_ROUND_PROGRESS_CHARS &&
          lastStopSequence === prevRoundStopSequence
        ) {
          consecutiveStalledResumptions++;
          if (consecutiveStalledResumptions >= MAX_CONSECUTIVE_STALLED_RESUMPTIONS) {
            warnLog.warn(
              `[membrane] ${consecutiveStalledResumptions} consecutive automatic resumptions ` +
              `made no progress (${streamedThisRound} chars this round, stop ` +
              `${JSON.stringify(lastStopSequence ?? null)} repeated) — ending turn with ` +
              `stopReason 'no_progress'. ${turnUsage.total.inputTokens} input tokens spent this turn.`
            );
            lastStopReason = 'no_progress';
            break;
          }
        } else {
          consecutiveStalledResumptions = 0;
        }
        prevRoundStopSequence = lastStopSequence;
        enteredViaResumption = false;

        if (xmlToolProtocol && streamResult.stopSequence === '</function_calls>') {
          const closeTag = '</function_calls>';
          parser.push(closeTag);

          const parsed = parseToolCalls(parser.getAccumulated(), { tools: request.tools });

          if (parsed && parsed.calls.length > 0) {
            if (emitBlocks) {
              for (const call of parsed.calls) {
                const toolCallBlockIndex = parser.getBlockIndex();
                stream.emit({
                  type: 'block',
                  event: {
                    event: 'block_start',
                    index: toolCallBlockIndex,
                    block: { type: 'tool_call' },
                  },
                });
                stream.emit({
                  type: 'block',
                  event: {
                    event: 'block_complete',
                    index: toolCallBlockIndex,
                    block: {
                      type: 'tool_call',
                      toolId: call.id,
                      toolName: call.name,
                      input: call.input,
                    },
                  },
                });
                parser.incrementBlockIndex();
              }
            }

            executedToolCalls.push(...parsed.calls);

            const context: ToolContext = {
              rawText: parsed.fullMatch,
              preamble: parsed.beforeText.slice(initialPrefillLength),
              roundPreamble: parsed.beforeText.slice(roundStartLen),
              depth: toolDepth,
              previousResults: executedToolResults,
              accumulated: parser.getAccumulated().slice(initialPrefillLength),
              supportsInjectedMessages: false,
            };

            const toolCallsEvent: ToolCallsEvent = {
              type: 'tool-calls',
              calls: parsed.calls,
              context,
            };

            const { results, injected } = await stream.requestToolExecution(toolCallsEvent);

            const yieldCallNames = new Map(parsed.calls.map((c) => [c.id, c.name]));
            for (const r of results) {
              if (!r.toolName) r.toolName = yieldCallNames.get(r.toolUseId);
            }

            if (injected) injectedBatches++;
            if (injected && !warnedInjectionUnsupported) {
              warnedInjectionUnsupported = true;
              console.warn(
                `[membrane] provideToolResults injectedMessages ignored: XML tool mode ` +
                `does not support mid-turn injection (delivered next turn instead)`
              );
            }

            executedToolResults.push(...results);

            const splitContent = hasImageInToolResults(results) ? formatToolResultsForSplitTurn(results) : null;
            if (splitContent?.hasImages) {
              splitRounds.push({
                xml: splitContent.beforeImageXml + splitContent.afterImageXml,
                docAt: parser.getAccumulated().length - initialPrefillLength,
                at: splitContent.beforeImageXml.length,
                imageResult: splitContent.imageResult,
                results,
              });

              if (emitBlocks) {
                stream.emit({
                  type: 'block',
                  event: {
                    event: 'block_start',
                    index: parser.getBlockIndex(),
                    block: { type: 'tool_result' },
                  },
                });
              }

              parser.push(splitContent.beforeImageXml);

              for (const result of results) {
                const resultContent = typeof result.content === 'string'
                  ? result.content
                  : JSON.stringify(result.content);

                if (emitTokens) {
                  const toolResultMeta: ChunkMeta = {
                    type: 'tool_result',
                    visible: false,
                    blockIndex: parser.getBlockIndex(),
                    toolId: result.toolUseId,
                  };
                  stream.emit({ type: 'tokens', content: resultContent, meta: toolResultMeta });
                }

                if (emitBlocks) {
                  stream.emit({
                    type: 'block',
                    event: {
                      event: 'block_complete',
                      index: parser.getBlockIndex(),
                      block: {
                        type: 'tool_result',
                        toolId: result.toolUseId,
                        content: resultContent,
                        isError: result.isError,
                      },
                    },
                  });
                }
                parser.incrementBlockIndex();
              }

              let afterImageXml = splitContent.afterImageXml;
              if (request.config.thinking?.enabled) {
                afterImageXml += '\n<thinking>';
              }

              providerRequest = this.buildContinuationRequestWithImages(
                request,
                prefillResult,
                parser.getAccumulated(),
                splitContent.images,
                afterImageXml
              );

              parser.push(afterImageXml);
              prefillResult.assistantPrefill = parser.getAccumulated();
              parser.resetForNewIteration();
            } else {
              const resultsXml = splitContent ? splitContent.beforeImageXml : formatToolResults(results);

              if (emitBlocks) {
                stream.emit({
                  type: 'block',
                  event: {
                    event: 'block_start',
                    index: parser.getBlockIndex(),
                    block: { type: 'tool_result' },
                  },
                });
              }

              parser.push(resultsXml);

              for (const result of results) {
                const resultContent = typeof result.content === 'string'
                  ? result.content
                  : JSON.stringify(result.content);

                if (emitTokens) {
                  const toolResultMeta: ChunkMeta = {
                    type: 'tool_result',
                    visible: false,
                    blockIndex: parser.getBlockIndex(),
                    toolId: result.toolUseId,
                  };
                  stream.emit({ type: 'tokens', content: resultContent, meta: toolResultMeta });
                }

                if (emitBlocks) {
                  stream.emit({
                    type: 'block',
                    event: {
                      event: 'block_complete',
                      index: parser.getBlockIndex(),
                      block: {
                        type: 'tool_result',
                        toolId: result.toolUseId,
                        content: resultContent,
                        isError: result.isError,
                      },
                    },
                  });
                }
                parser.incrementBlockIndex();
              }

              if (request.config.thinking?.enabled) {
                parser.push('\n<thinking>');
              }

              prefillResult.assistantPrefill = parser.getAccumulated();
              providerRequest = this.buildContinuationRequest(
                request,
                prefillResult,
                parser.getAccumulated()
              );
            }

            roundStartLen = parser.getAccumulated().length;

            parser.resetForNewIteration();
            toolDepth++;
            continue;
          }
        }

        const currentDepths = parser.getDepths();
        const modelOpenedNewBlock =
          currentDepths.functionCalls > prefillDepths.functionCalls ||
          currentDepths.functionResults > prefillDepths.functionResults ||
          currentDepths.thinking > prefillDepths.thinking;

        if (lastStopReason === 'stop_sequence' && modelOpenedNewBlock) {
          if (streamResult.stopSequence) {
            const type = parser.getCurrentBlockType();
            const putBack = parser.processChunk(streamResult.stopSequence).emissions;
            if (typedCallbacks) {
              if (emitTokens) {
                stream.emit({ type: 'tokens', content: streamResult.stopSequence, meta: { type, visible: type === 'text', blockIndex: 0 } });
              }
            } else {
              forward(putBack);
            }
          }

          toolDepth++;
          if (toolDepth > maxToolDepth) {
            forwardOwn(parser.flush().emissions);
            break;
          }
          if (!registerResumptionRound()) {
            lastStopReason = 'round_limit';
            forwardOwn(parser.flush().emissions);
            break;
          }
          enteredViaResumption = true;
          prefillResult.assistantPrefill = parser.getAccumulated();
          providerRequest = this.buildContinuationRequest(
            request,
            prefillResult,
            parser.getAccumulated()
          );
          continue;
        }

        break;
      }

      const fullAccumulated = parser.getAccumulated();
      const newContent = fullAccumulated.slice(initialPrefillLength);

      const response = this.buildFinalResponse(
        newContent,
        xmlToolProtocol ? contentBlocks : streamedThinking.content(newContent, (value, context) => formatter.parseContentBlocks(value, request.tools, context)),
        lastStopReason,
        turnUsage,
        request,
        xmlToolProtocol,
        prefillResult,
        startTime,
        providerCalls,
        rawRequest,
        rawResponse,
        executedToolCalls,
        executedToolResults,
        initialBlockType,
        lastStopSequence,
        lastProviderStopReason,
        splitRounds
      );

      this.mergeProviderThinkingBlocks(response.content, providerThinkingBlocks);

      response.content.push(...providerImageBlocks);
      response.details.timing.rounds = rounds;
      if (retryDelaysMs.length > 0) response.details.timing.retryDelaysMs = retryDelaysMs;

      stream.emit({ type: 'complete', response });
    } catch (error) {
      if (stream.isCancelled) return;
      if (this.isAbortError(error)) {
        stream.emit({ type: 'aborted', ...this.abortOutcome(error, stream.signal), ...abortedPartial() });
      } else {
        throw error;
      }
    }
  }

  private async runNativeToolsYielding(
    request: NormalizedRequest,
    options: YieldingStreamOptions,
    stream: YieldingStreamImpl,
    activeFormatter: PrefillFormatter = this.resolveActiveFormatter()
  ): Promise<void> {
    const startTime = Date.now();
    const {
      maxToolDepth: maxToolDepthOpt,
      emitTokens = true,
      emitBlocks = true,
      emitUsage = true,
    } = options;
    const maxToolDepth =
      maxToolDepthOpt === undefined || maxToolDepthOpt === -1
        ? Infinity
        : maxToolDepthOpt;

    let toolDepth = 0;
    const turnUsage = new TurnUsageAccumulator(
      request.config.model,
      (servedModel) => this.resolvePricing(request.config.model, servedModel),
    );
    let providerCalls = 0;
    let rounds = 0;
    const retryDelaysMs: number[] = [];
    let lastStopReason: StopReason = 'end_turn';
    const anomalies: ResponseAnomaly[] = [];
    let lastProviderStopReason: string | undefined;
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    let allTextAccumulated = '';
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];
    let discardedUsage: DiscardedAttemptsUsage | undefined;

    let messages = [...request.messages];
    const origins: MessageOrigin[] = request.messages.map((_, index) => ({ kind: 'input' as const, index }));
    let injectedBatches = 0;
    let newestBatchSize = 0;
    const injectedAlterations: Array<[number, number]> = [];
    let hookAlteredState = false;
    let allContentBlocks: ContentBlock[] = [];
    let roundReceived: (() => ContentBlock[]) | undefined;
    let markersInLastRequest = 0;

    const abortedPartial = () => ({
      partialContent: [...allContentBlocks, ...(roundReceived?.() ?? [])],
      rawAssistantText: allTextAccumulated,
      toolCalls: [...executedToolCalls],
      toolResults: [...executedToolResults],
    });
    stream.setAbortSnapshot(abortedPartial);

    try {
      while (toolDepth <= maxToolDepth) {
        if (stream.isCancelled) return;

        const roundFidelity = new FidelityNotes();
        const providerRequest = this.buildNativeToolRequest(request, messages, toolDepth > 0, activeFormatter, roundFidelity);
        const carriedBatch = injectedBatches > 0 ? { batch: injectedBatches - 1, applied: newestBatchSize } : undefined;

        let textAccumulated = '';
        const allTextBefore = allTextAccumulated.length;
        const offered = toolsOffered({ tools: request.tools, messages });
        const tracker = new NativeBlockTracker(
          emitBlocks ? (event) => stream.emit({ type: 'block', event }) : undefined,
          (name) => restoreToolName(name, offered),
        );
        roundReceived = () => this.parseProviderContent(tracker.partialContent(), offered);
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (stream.isCancelled) return;

              tracker.onChunk(chunk);
              const visible = tracker.currentType === 'text';
              if (visible) {
                textAccumulated += chunk;
                allTextAccumulated += chunk;
              }

              if (emitTokens) {
                const meta: ChunkMeta = {
                  type: tracker.currentType,
                  visible,
                  blockIndex: tracker.blockIndex,
                };
                stream.emit({ type: 'tokens', content: chunk, meta });
              }
            },
            onContentBlock: (index, block) => {
              if (stream.isCancelled) return;
              tracker.onProviderBlock(index, block);
            },
            onThinkingSignature: (index, signature) => {
              if (stream.isCancelled) return;
              tracker.onThinkingSignature(index, signature);
            },
          },
          {
            signal: stream.signal,
            timeoutMs: options.timeoutMs,
            idleTimeoutMs: options.idleTimeoutMs,
            progressTimeoutMs: options.progressTimeoutMs,
            progressBounds: options.progressBounds,
            retry: options.retry,
            normalizedRequest: request,
            formatterName: activeFormatter.name,
            requiresAssistantPrefill: false,
            promptMessages: messages,
            onRequest: (req: unknown) => { rawRequest = req; },
            onWireCacheMarkers: (markerCount: number) => {
              markersInLastRequest = markerCount;
            },
            ...(emitUsage ? { fidelity: roundFidelity } : {}),
            refusalRetries: options.refusalRetries,
            onRetrying: (info) => {
              allTextAccumulated = allTextAccumulated.slice(0, allTextBefore);
              textAccumulated = '';
              tracker.reset();
              stream.emit({
                type: 'retrying',
                attempt: info.attempt,
                maxAttempts: info.maxAttempts,
                reason: 'refusal',
                ...(info.category ? { category: info.category } : {}),
              });
            },
          }
        );

        const responseBlocks = this.parseProviderContent(streamResult.content, offered);
        roundReceived = () => responseBlocks;

        tracker.flushAfterProviderReturn();
        rounds++;
        providerCalls += streamResult.providerCalls;
        retryDelaysMs.push(...streamResult.retryDelaysMs);

        rawResponse = streamResult.raw;
        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastProviderStopReason = streamResult.providerStopReason;
        lastStopSequence = streamResult.stopSequence ?? undefined;
        const endTurnTools = this.toolUseWithEndTurn(responseBlocks, lastStopReason, streamResult, rounds - 1);
        if (endTurnTools) {
          anomalies.push(endTurnTools);
          if (endTurnTools.treatedAsToolUse) lastStopReason = 'tool_use';
        }

        discardedUsage = this.mergeDiscardedAttempts(discardedUsage, streamResult.discardedUsage);

        const usageSoFar = turnUsage.addRound(streamResult.model, streamResult.usage);
        if (roundFidelity.mutatedInPlace) hookAlteredState = true;
        if (hookAlteredState) roundFidelity.unattributed = true;
        if (emitUsage) {
          stream.emit({
            type: 'usage',
            usage: usageSoFar,
            round: Membrane.roundReport({
              index: rounds - 1,
              stopReason: lastStopReason,
              usage: turnUsage.lastRound?.usage,
              unreported: streamResult.unreportedUsage,
              fidelity: roundFidelity,
              origins,
              injectedAlterations,
              ...(carriedBatch ? { injectedBatch: carriedBatch } : {}),
              ...(streamResult.inputTransformations
                ? { thinking: { entries: streamResult.inputTransformations, messages } }
                : {}),
            }),
          });
        }

        allContentBlocks.push(...responseBlocks);
        roundReceived = undefined;

        const toolUseBlocks = responseBlocks.filter(
          (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use'
        );

        if (toolUseBlocks.length > 0 && lastStopReason === 'tool_use') {
          const toolCalls: ToolCall[] = toolUseBlocks.map(toolCallOf);

          executedToolCalls.push(...toolCalls);

          const context: ToolContext = {
            rawText: JSON.stringify(toolUseBlocks),
            preamble: textAccumulated,
            depth: toolDepth,
            previousResults: executedToolResults,
            accumulated: allTextAccumulated,
            roundContent: responseBlocks,
            supportsInjectedMessages: true,
          };

          const toolCallsEvent: ToolCallsEvent = {
            type: 'tool-calls',
            calls: toolCalls,
            context,
          };

          const { results, injected } = await stream.requestToolExecution(toolCallsEvent);

          executedToolResults.push(...results);

          for (const result of results) {
            allContentBlocks.push({
              type: 'tool_result',
              toolUseId: result.toolUseId,
              content: result.content,
              isError: result.isError,
            });
          }

          const assistantName = request.assistantParticipant
            ?? this.config.assistantParticipant ?? 'Claude';
          const userName = assistantName === 'Claude' ? 'User' : 'user';
          messages.push({
            participant: assistantName,
            content: responseBlocks,
          });
          origins.push({ kind: 'own', round: rounds - 1 });

          origins.push({ kind: 'own' });
          messages.push({
            participant: userName,
            content: results.map(r => ({
              type: 'tool_result' as const,
              toolUseId: r.toolUseId,
              content: r.content,
              isError: r.isError,
            })),
          });

          // Chat Completions carries tool results as role:'tool' messages, so injected
          // messages go after the tool_result envelope, as ordinary user messages.
          if (injected) {
            const batch = injectedBatches++;
            newestBatchSize = injected.size;
            for (const { index, message } of injected.messages) {
              messages.push({
                participant: message.participant ?? userName,
                content: message.content,
                ...(message.metadata ? { metadata: message.metadata } : {}),
              });
              origins.push({ kind: 'injected', batch, index });
            }
            for (const index of injected.altered) injectedAlterations.push([batch, index]);
          }

          toolDepth++;
          continue;
        }

        break;
      }

      const durationMs = Date.now() - startTime;
      const totalUsage = turnUsage.total;

      const response: NormalizedResponse = {
        content: allContentBlocks,
        rawAssistantText: allTextAccumulated,
        toolCalls: executedToolCalls,
        toolResults: executedToolResults,
        stopReason: lastStopReason,
        usage: totalUsage,
        details: {
          stop: this.buildStopInfo(lastStopReason, lastProviderStopReason, lastStopSequence),
          usage: {
            ...totalUsage,
            ...(discardedUsage
              ? { discardedAttempts: this.pricedDiscardedAttempts(discardedUsage, request.config.model) }
              : {}),
          },
          timing: {
            totalDurationMs: durationMs,
            attempts: providerCalls,
            rounds,
            ...(retryDelaysMs.length > 0 ? { retryDelaysMs } : {}),
          },
          model: {
            requested: request.config.model,
            actual: turnUsage.lastServedModel || request.config.model,
            provider: this.adapter.name,
            perRound: turnUsage.perRound,
          },
          cache: {
            markersInRequest: markersInLastRequest,
            tokensCreated: totalUsage.cacheCreationTokens ?? 0,
            tokensRead: totalUsage.cacheReadTokens ?? 0,
            hitRatio: this.calculateCacheHitRatio(totalUsage),
          },
          ...(anomalies.length ? { anomalies } : {}),
        },
        raw: {
          request: rawRequest,
          response: rawResponse,
        },
      };

      stream.emit({ type: 'complete', response });
    } catch (error) {
      if (stream.isCancelled) return;
      if (this.isAbortError(error)) {
        stream.emit({ type: 'aborted', ...this.abortOutcome(error, stream.signal), ...abortedPartial() });
      } else {
        throw error;
      }
    }
  }
}

/** An Anthropic server-tool block is its own native form, sent back as itself. */
function providerItemCarrier(item: { type?: unknown; rawItem?: unknown }): ContentBlock {
  if (!item.rawItem && !isAnthropicServerBlock(item)) warnUnconvertibleProviderItem(String(item.type));
  return { type: 'text', text: '', rawItem: item.rawItem ?? item };
}
