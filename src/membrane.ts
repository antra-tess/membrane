/**
 * Membrane - LLM middleware core class
 * 
 * A selective boundary that transforms what passes through.
 */

import type {
  NormalizedRequest,
  NormalizedResponse,
  AbortedResponse,
  ContentBlock,
  ProviderAdapter,
  ModelRegistry,
  MembraneConfig,
  StreamOptions,
  CompleteOptions,
  BasicUsage,
  DetailedUsage,
  DiscardedAttemptsUsage,
  StopReason,
  TimingInfo,
  CacheInfo,
  ToolCall,
  ToolResult,
  ToolContext,
  RetryConfig,
  ToolDefinition,
} from './types/index.js';
import { lastCacheableBlockIndex } from './formatters/native.js';
import {
  sameThinkingText,
  findSpanningProviderRun,
  thinkingCarrierKey,
  stripThinkingForPrefill,
} from './utils/thinking-carriers.js';
import {
  countWireCacheMarkers,
  clampCacheMarkers,
  ownSystemBlocks,
  MAX_CACHE_BREAKPOINTS,
} from './utils/cache-marker-budget.js';
import {
  DEFAULT_RETRY_CONFIG,
  MembraneError,
  classifyError,
  isOverloadedError,
  isTimeoutAbortError,
  isTextContent,
  isAbortedResponse,
  unsupportedError,
} from './types/index.js';
import type { BuildResult } from './formatters/types.js';
import {
  parseToolCalls,
  formatToolResults,
  parseAccumulatedIntoBlocks,
  endsWithPartialToolBlock,
  hasImageInToolResults,
  formatToolResultsForSplitTurn,
  type ProviderImageBlock,
} from './utils/tool-parser.js';
import { IncrementalXmlParser, type ProcessChunkResult } from './utils/stream-parser.js';
import type { ChunkMeta, BlockEvent, MembraneBlockType, MembraneBlock } from './types/streaming.js';
import type {
  YieldingStream,
  YieldingStreamOptions,
  StreamEvent,
  ToolCallsEvent,
} from './types/yielding-stream.js';
import type { PrefillFormatter, StreamParser } from './formatters/types.js';
import { AnthropicXmlFormatter } from './formatters/anthropic-xml.js';
import {
  normalizeToolPairs,
  mergeConsecutiveRoles,
  PREFIX_REWRITING_NORMALIZE_EVENT_KINDS,
} from './formatters/normalize-tool-pairs.js';
import { YieldingStreamImpl } from './yielding-stream.js';
import { calculateCost } from './utils/cost.js';
import {
  isAcceptedImageMediaType,
  strippedImagePlaceholder,
  shedImagesToFitByteBudget, assertWithinByteBudget,
} from './utils/image-media.js';
import { getDefaultPricing } from './registry/default-pricing.js';

// ============================================================================
// Membrane Class
// ============================================================================

/**
 * Block-lifecycle tracking shared by the two native-tools streaming paths
 * (`streamWithNativeTools` and `runNativeToolsYielding`).
 *
 * Providers signal blocks through `onContentBlock(index, block)`, but not all
 * of them the same way: the Anthropic and Bedrock adapters fire it twice per
 * index (content_block_start with an empty block, content_block_stop with the
 * finalised one), while the OpenAI Responses adapter fires it ONCE per block,
 * already finalised, after the stream has ended. Treating "second sighting"
 * as the only completion signal therefore left single-callback adapters with
 * `block_start` events that never completed (#63 review). The tracker keeps
 * the paired semantics and adds `flush()`, which the caller runs once the
 * provider stream has returned: every started block that never saw a second
 * callback is completed from the last block payload seen for it.
 */
class NativeBlockTracker {
  currentType: MembraneBlockType = 'text';
  blockIndex = 0;
  private readonly started = new Map<number, MembraneBlockType>();
  private readonly completed = new Set<number>();
  private readonly lastSeen = new Map<number, unknown>();

  constructor(private readonly emit: ((event: BlockEvent) => void) | undefined) {}

  static mapApiBlockType(apiType: string | undefined): MembraneBlockType {
    if (apiType === 'thinking' || apiType === 'redacted_thinking' || apiType === 'reasoning') return 'thinking';
    if (apiType === 'tool_use' || apiType === 'function_call' || apiType === 'tool_call') return 'tool_call';
    return 'text';
  }

  /** Provider block callback: first sighting of an index starts it, a second completes it. */
  onProviderBlock(index: number, block: unknown): void {
    this.lastSeen.set(index, block);
    if (!this.started.has(index)) {
      const mbType = NativeBlockTracker.mapApiBlockType((block as { type?: string } | undefined)?.type);
      this.started.set(index, mbType);
      this.currentType = mbType;
      this.blockIndex = index;
      this.emit?.({ event: 'block_start', index, block: { type: mbType } });
      return;
    }
    this.complete(index, block);
  }

  /**
   * Complete every started block that never received its second callback.
   * Run after the provider stream has returned; idempotent, and a no-op for
   * paired-callback adapters.
   */
  flush(): void {
    for (const index of this.started.keys()) {
      if (!this.completed.has(index)) this.complete(index, this.lastSeen.get(index));
    }
  }

  /** Discard tracking state (refusal retry rolled the attempt back). */
  reset(): void {
    this.currentType = 'text';
    this.blockIndex = 0;
    this.started.clear();
    this.completed.clear();
    this.lastSeen.clear();
  }

  private complete(index: number, block: unknown): void {
    if (this.completed.has(index)) return;
    this.completed.add(index);
    const mbType = this.started.get(index)
      ?? NativeBlockTracker.mapApiBlockType((block as { type?: string } | undefined)?.type);
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
      mb.toolName = apiBlock?.name;
      mb.input = apiBlock?.input as Record<string, unknown> | undefined;
    }
    this.emit?.({ event: 'block_complete', index, block: mb });
  }
}

export class Membrane {
  private adapter: ProviderAdapter;
  private registry?: ModelRegistry;
  private retryConfig: RetryConfig;
  private config: MembraneConfig;
  private formatter: PrefillFormatter;

  constructor(
    adapter: ProviderAdapter,
    config: MembraneConfig = {}
  ) {
    this.adapter = adapter;
    this.registry = config.registry;
    this.retryConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.retry,
      overloaded: { ...DEFAULT_RETRY_CONFIG.overloaded, ...config.retry?.overloaded },
    };
    this.config = config;
    // Use provided formatter or default to AnthropicXmlFormatter
    this.formatter = config.formatter ?? new AnthropicXmlFormatter();
  }

  // ==========================================================================
  // Main API
  // ==========================================================================

  /**
   * Complete a request (non-streaming)
   */
  async complete(
    request: NormalizedRequest,
    options: CompleteOptions = {}
  ): Promise<NormalizedResponse> {
    const startTime = Date.now();
    let attempts = 0;
    let rawRequest: unknown;
    // Counted separately from `attempts` (the transport-error budget): a
    // refusal is a successful HTTP call with an unwanted verdict, and letting
    // it consume error retries would couple two unrelated budgets.
    let refusalRetriesUsed = 0;
    // Spend on attempts we threw away. A refused attempt is a completed,
    // billed HTTP call; reporting only the surviving attempt's usage
    // under-reports the turn by one full call per retry.
    let discardedUsage: DiscardedAttemptsUsage | undefined;

    // One selection for the whole call: mode resolution and the build must
    // name the same formatter instance (see resolveActiveFormatter).
    const activeFormatter = this.resolveActiveFormatter(options.formatter);

    while (true) {
      attempts++;

      try {
        const { providerRequest, prefillResult } = this.transformRequest(request, activeFormatter);

        // Route through the single canonical hook helper so any future
        // change to hook semantics (logging, retry interaction, error
        // handling) applies to both complete() and the streaming paths.
        // Cast back to the local provider-request shape: the hook returns
        // `unknown` deliberately, and we acknowledge the cast at the boundary.
        const finalRequest = (await this.applyBeforeRequestHook(request, providerRequest)) as typeof providerRequest;

        // Last exit before the adapter: the only place that sees EVERY
        // contribution (builder, formatter, passthrough, float, hook).
        clampCacheMarkers(finalRequest, 'complete');

        const providerResponse = await this.adapter.complete(finalRequest, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onRequest: (req) => {
            rawRequest = req;
            options.onRequest?.(req);
          },
        });

        // Call onResponse callback with raw response from API
        options.onResponse?.(providerResponse.raw);

        const response = this.transformResponse(
          providerResponse,
          request,
          prefillResult,
          startTime,
          attempts,
          rawRequest
        );

        // Re-issue a content-policy refusal (opt-in, default off). Safe here
        // in a way the streaming paths are not: nothing has reached the
        // caller yet, so the abandoned attempt leaves no trace to retract.
        // Deliberately BEFORE afterResponse — a hook that logs or transforms
        // should see the attempt that actually stands, not the discarded one.
        if (
          response.stopReason === 'refusal' &&
          refusalRetriesUsed < Math.max(0, options.refusalRetries ?? 0)
        ) {
          refusalRetriesUsed++;
          discardedUsage = this.mergeDiscardedAttempts(
            discardedUsage,
            this.discardedAttemptFrom(response.usage)
          );
          continue;
        }

        // Report what the discarded attempts cost. Set BEFORE afterResponse
        // so a hook that logs spend sees the whole turn, not just the
        // attempt that stands.
        if (discardedUsage) {
          response.details.usage.discardedAttempts =
            this.pricedDiscardedAttempts(discardedUsage, request.config.model);
        }

        // Call afterResponse hook
        if (this.config.hooks?.afterResponse) {
          return await this.config.hooks.afterResponse(response, providerResponse.raw);
        }

        return response;

      } catch (error) {
        const errorInfo = classifyError(error);
        errorInfo.rawRequest = rawRequest;

        // Rate limits (429) always retry up to 5 attempts regardless of
        // config, and overloaded (529) always retries on its own longer
        // schedule — both are transient by definition, and the default
        // maxRetries of 0 would otherwise turn a capacity blip into a dead
        // turn. Other retryable errors only retry when maxRetries > 0.
        // overloaded.maxRetries: 0 disables the dedicated policy entirely;
        // the 529 then follows the base config like any retryable server
        // error (exactly the pre-policy behavior), rather than being
        // silently re-promoted to the long schedule by a positive base limit.
        const isRateLimit = errorInfo.type === 'rate_limit';
        const isOverloaded =
          isOverloadedError(errorInfo) && this.retryConfig.overloaded.maxRetries > 0;
        const effectiveMax = isRateLimit
          ? Math.max(this.retryConfig.maxRetries, 5)
          : isOverloaded
            ? Math.max(this.retryConfig.maxRetries, this.retryConfig.overloaded.maxRetries)
            : this.retryConfig.maxRetries;

        if (errorInfo.retryable && attempts < effectiveMax) {
          // Check hook for retry decision
          if (this.config.hooks?.onError) {
            const decision = await this.config.hooks.onError(errorInfo, attempts);
            if (decision === 'abort') {
              throw new MembraneError(errorInfo);
            }
          }

          // Wait before retry (abort-aware). An abort landing inside the
          // sleep must fail like every other failure of this method — a
          // MembraneError — rather than escaping the loop as a raw
          // DOMException whose shape no caller of complete() expects.
          const delay = this.calculateRetryDelay(attempts, isOverloaded);
          try {
            await this.sleep(delay, options.signal);
          } catch (sleepError) {
            throw this.attachRawRequest(sleepError, rawRequest);
          }
          continue;
        }

        throw new MembraneError(errorInfo);
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
    // If streaming is explicitly disabled on the request, fall back to complete()
    // and synthesize the streaming callbacks from the full response
    if (request.streaming === false) {
      // complete() has no tool loop, and neither branch of this fallback can
      // build one: honouring onToolCalls here would mean re-implementing the
      // whole XML/native continuation machinery. Silently dropping it turned
      // a working agent into one that narrates tool calls it never makes —
      // the raw <function_calls> XML lands in the returned text and the turn
      // ends. Refuse where the option is passed, before spending a call.
      if (options.onToolCalls) {
        throw unsupportedError(
          'stream() cannot execute tools with streaming: false — the non-streaming ' +
          'fallback routes to complete(), which has no tool loop, so onToolCalls ' +
          'would never run. Leave streaming enabled (or drive the loop yourself ' +
          'with complete() per round).'
        );
      }
      const response = await this.complete(request, options);
      // Synthesize onChunk callbacks so callers that depend on them still work
      if (options.onChunk && 'content' in response) {
        for (let i = 0; i < response.content.length; i++) {
          const block = response.content[i]!;
          if (block.type === 'text' && block.text) {
            options.onChunk(block.text, {
              type: 'text',
              visible: true,
              blockIndex: i,
            });
          }
        }
      }
      return response;
    }

    // Determine tool mode against the formatter that will build the request
    const activeFormatter = this.resolveActiveFormatter(options.formatter);
    const toolMode = this.resolveToolMode(request, activeFormatter);
    const useNative = toolMode === 'native' && !!request.tools && request.tools.length > 0;

    // Overloaded (529) pre-emission retry. The streaming paths have no retry
    // loop of their own, so a capacity error used to kill the turn outright —
    // and 529s most often arrive INSTEAD of a stream, before anything reaches
    // the caller, where retrying is transparent. Once any callback has
    // delivered output (tokens, blocks, usage), retrying would replay content
    // the caller already consumed, so mid-stream errors still throw.
    let attempts = 0;
    const retryDelaysMs: number[] = [];
    while (true) {
      attempts++;
      let emitted = false;
      const mark = <A extends unknown[], R>(fn?: (...args: A) => R) =>
        fn && ((...args: A): R => { emitted = true; return fn(...args); });
      const tracked: StreamOptions = {
        ...options,
        onChunk: mark(options.onChunk),
        onContentBlockUpdate: mark(options.onContentBlockUpdate),
        onToolCalls: mark(options.onToolCalls),
        onPreToolContent: mark(options.onPreToolContent),
        onUsage: mark(options.onUsage),
        onBlock: mark(options.onBlock),
        onResponse: mark(options.onResponse),
        // onRequest fires before the send — it is not an emission.
      };

      try {
        const result = useNative
          ? await this.streamWithNativeTools(request, tracked, activeFormatter)
          : await this.streamWithXmlTools(request, tracked, activeFormatter);
        // The inner paths count their own provider calls but cannot see this
        // wrapper's discarded attempts. Each failed attempt here died before
        // emitting anything (that is the precondition for retrying), so it
        // cost at least the one call it failed on — ADD those to the inner
        // count rather than overwriting it, or a turn that retried twice and
        // then ran three tool rounds would report 2 calls instead of 5.
        if (attempts > 1 && 'details' in result) {
          result.details.timing.attempts += attempts - 1;
          result.details.timing.retryDelaysMs = retryDelaysMs;
        }
        return result;
      } catch (error) {
        const errorInfo = classifyError(error);
        // Same semantics as complete(): maxRetries bounds total attempts,
        // the overloaded floor applies over the base config, and
        // overloaded.maxRetries: 0 opts out of stream retries entirely
        // (streaming had no retry before this policy existed).
        const overloadedEnabled = this.retryConfig.overloaded.maxRetries > 0;
        const maxOverloaded = Math.max(
          this.retryConfig.maxRetries,
          this.retryConfig.overloaded.maxRetries
        );
        if (!emitted && overloadedEnabled && isOverloadedError(errorInfo) && attempts < maxOverloaded) {
          // Honor the same pre-retry hook contract as complete(): hosts use
          // onError for circuit-breaking, and its 'abort' decision must work
          // on the streaming path too.
          if (this.config.hooks?.onError) {
            const decision = await this.config.hooks.onError(errorInfo, attempts);
            if (decision === 'abort') {
              throw error;
            }
          }
          const delay = this.calculateRetryDelay(attempts, true);
          retryDelaysMs.push(delay);
          // An abort during the backoff window is still a cancellation of
          // this stream, and stream() documents cancellation as an
          // AbortedResponse. Letting the sleep's rejection escape made that
          // contract depend on which millisecond the abort landed in.
          // Nothing has been emitted on this path (that is the precondition
          // for retrying at all), so there is no partial content to report.
          try {
            await this.sleep(delay, options.signal);
          } catch (sleepError) {
            if (this.isAbortError(sleepError)) {
              return this.buildAbortedResponse(
                '',
                { inputTokens: 0, outputTokens: 0 },
                [],
                [],
                this.abortReason(sleepError, options.signal)
              );
            }
            throw sleepError;
          }
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Select the ACTIVE formatter for a request: the one instance that resolves
   * its tool mode, builds its provider request, and parses its stream.
   *
   * A per-request override (`CompleteOptions.formatter` /
   * `StreamOptions.formatter`) wins over the instance formatter, with ONE
   * transport exception: the Responses adapter's input is a provider-native
   * item array, and a generic override (for example Context Manager's
   * NativeFormatter) produces Anthropic-style `{ role, content: [{ type:
   * 'text' }] }` envelopes the Responses API rejects before inference — so a
   * configured Responses formatter stays authoritative there.
   *
   * The exception is why this selection is a method rather than a `??` at each
   * call site: while it lived inside transformRequest alone, the BUILD honored
   * it and every other formatter reader resolved against a different instance,
   * which is the split resolveToolMode exists to prevent, one layer down.
   * Every entry point selects once, here, and threads the result.
   */
  private resolveActiveFormatter(requestFormatter?: PrefillFormatter): PrefillFormatter {
    if (this.adapter.name === 'openai-responses-api' && this.formatter.name === 'openai-responses') {
      return this.formatter;
    }
    return requestFormatter ?? this.formatter;
  }

  /**
   * Determine the effective tool mode.
   *
   * THE single source of truth for the mode: both complete() (via
   * transformRequest → BuildOptions.toolMode) and the streaming paths (via
   * their native-vs-XML path choice) resolve here, so a given request resolves
   * to the same mode whichever entry point it arrives through.
   *
   * Precedence, strongest first:
   *   1. an explicit non-'auto' `request.toolMode`
   *   2. the mode the BUILDING formatter was explicitly constructed with
   *      (`AnthropicXmlFormatter({ toolMode: 'native' })`) — a caller's stated
   *      choice, not a derivation
   *   3. formatter/provider derivation
   *
   * `formatter` is the formatter that will actually build the request — the
   * instance `resolveActiveFormatter` selected for this call — because
   * resolving against one formatter while building with another is exactly the
   * split this method exists to prevent.
   */
  private resolveToolMode(
    request: NormalizedRequest,
    formatter: PrefillFormatter = this.formatter
  ): 'xml' | 'native' {
    // Explicit mode takes precedence
    if (request.toolMode && request.toolMode !== 'auto') {
      return request.toolMode;
    }

    // A formatter constructed with an explicit mode states its caller's choice
    if (formatter.configuredToolMode) {
      return formatter.configuredToolMode;
    }

    // Auto mode: choose based on formatter
    // NativeFormatter → native tools via API
    // AnthropicXmlFormatter (default) → XML tools in prefill
    if (formatter.name === 'native' || formatter.name === 'openai-responses') {
      return 'native';
    }

    // Also handle known native-tool providers regardless of formatter
    if (this.adapter.name === 'openrouter') {
      return 'native';
    }

    // Default to XML for prefill compatibility
    return 'xml';
  }

  /**
   * Stream with XML-based tool execution (prefill mode)
   *
   * Uses IncrementalXmlParser to track XML nesting depth for:
   * - False-positive stop sequence detection (e.g., "\nUser:" inside tool results)
   * - Structured block events for UI
   */
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
    } = options;

    // The formatter stream() selected: the same instance that resolved the
    // mode and will build the request, so the parser can never be reading a
    // different format than the one on the wire.
    const formatter = activeFormatter;

    // Initialize parser from formatter for format-specific tracking
    const parser = formatter.createStreamParser();
    let toolDepth = 0;
    // Honest turn telemetry: provider calls actually made (including refusal
    // re-issues inside streamOnce) and continuation rounds.
    let providerCalls = 0;
    let rounds = 0;
    let totalUsage: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
    const pricing = this.resolvePricing(request.config.model);
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    // Track executed tool calls and results
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

    // Track non-text content blocks from provider (e.g., generated_image from Gemini)
    // These can't be handled by the text-based XML parser, so we capture and append them
    const extraContentBlocks: ContentBlock[] = [];

    // Native thinking blocks from the provider (with signatures). The parser
    // derives signature-less thinking blocks from <thinking> text (via
    // wrapThinkingTags); signatures from these are merged into those after
    // parsing, and signature-only blocks are prepended.
    const providerThinkingBlocks: ContentBlock[] = [];

    // Transform initial request using the formatter
    let { providerRequest, prefillResult } = this.transformRequest(request, formatter);

    // Initialize parser with prefill content so it knows about any open tags
    // (e.g., <thinking> in the prefill means API response continues inside thinking)
    // Track the initial prefill length so we can extract only NEW content for response
    // Also track what block type we're inside at the end of prefill
    let initialPrefillLength = 0;
    // Watermark for per-round delta text (ToolContext.roundPreamble): start of
    // the CURRENT round's model text in parser-accumulated coordinates.
    // Advanced past each round's injected results push, so injected
    // <function_results> XML never enters a round's delta.
    let roundStartLen = 0;
    let initialBlockType: 'thinking' | 'tool_call' | 'tool_result' | null = null;
    if (prefillResult.assistantPrefill) {
      parser.push(prefillResult.assistantPrefill);
      initialPrefillLength = prefillResult.assistantPrefill.length;
      roundStartLen = initialPrefillLength;
      // Capture what block type we're inside after prefill (if any)
      if (parser.isInsideBlock()) {
        const blockType = parser.getCurrentBlockType();
        if (blockType === 'thinking' || blockType === 'tool_call' || blockType === 'tool_result') {
          initialBlockType = blockType;
        }
      }
    }

    // Capture parser depths after prefill initialization so we can distinguish
    // blocks inherited from prefill context (e.g., unclosed <thinking> from other bots)
    // from blocks the model itself opened during generation
    const prefillDepths = parser.getDepths();

    // Resumption spin guards (issue #39). Observed live on Ash 2026-07-26:
    // each automatic resumption re-sent ~172k input tokens, streamed ~6
    // output tokens, and stopped on the same (dropped) stop sequence — 43
    // rounds, ~7M input tokens, zero progress, found only because a human
    // noticed. Two guards, both scoped to AUTOMATIC false-positive
    // resumptions — tool rounds are real caller-governed work (maxToolDepth
    // / the yielding API's uncapped contract) and are never counted here:
    //   - stall guard: several CONSECUTIVE resumptions that each stream
    //     almost nothing and stop identically end the turn ('no_progress').
    //     One short repeated round is low progress, not proof of none — a
    //     stop sequence inside legitimate tool-argument text can cause a
    //     couple of short resumptions on the way to completing.
    //   - round cap: a hard bound on resumptions per turn ('round_limit'),
    //     the backstop for a spin that keeps technically progressing.
    const MIN_ROUND_PROGRESS_CHARS = 16;
    const MAX_CONSECUTIVE_STALLED_RESUMPTIONS = 3;
    const RESUMPTION_WARN_ROUNDS = 5;
    const maxResumptionRounds = options.maxResumptionRounds ?? 24;
    let resumptionRounds = 0;
    let consecutiveStalledResumptions = 0;
    let enteredViaResumption = false;
    let prevRoundStopSequence: string | undefined;
    const warnLog = this.config.logger ?? console;

    /** Count an automatic resumption; emits the visibility warning at the
     *  threshold and returns false when the cap says the turn should end. */
    const registerResumptionRound = (): boolean => {
      resumptionRounds++;
      if (resumptionRounds === RESUMPTION_WARN_ROUNDS) {
        warnLog.warn(
          `[membrane] automatic resumption at round ${resumptionRounds} ` +
          `(${totalUsage.inputTokens} input tokens so far this turn) — ` +
          `a spin shows up here before it shows up on the bill`
        );
      }
      if (resumptionRounds > maxResumptionRounds) {
        warnLog.warn(
          `[membrane] automatic resumption cap (${maxResumptionRounds}) reached — ` +
          `ending turn with stopReason 'round_limit'. ` +
          `${totalUsage.inputTokens} input tokens spent this turn.`
        );
        return false;
      }
      return true;
    };

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {

        // Track if we manually detected a stop sequence (API doesn't always stop)
        let detectedStopSequence: string | null = null;
        let truncatedAccumulated: string | null = null;

        // Track where to start checking for stop sequences (skip already-processed content).
        // Also the round's progress baseline: XML we pushed ourselves at the
        // end of the previous round (tool results, closing tags) sits below
        // this index and doesn't count as model progress.
        const checkFromIndex = parser.getAccumulated().length;

        // Stream from provider
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              // If we already detected a stop sequence, ignore remaining chunks
              if (detectedStopSequence) {
                return;
              }

              // Process chunk with enriched streaming API
              const { emissions } = parser.processChunk(chunk);

              // Check for stop sequences only in NEW content (not already-processed)
              const accumulated = parser.getAccumulated();
              const newContent = accumulated.slice(checkFromIndex);

              for (const stopSeq of prefillResult.stopSequences) {
                const idx = newContent.indexOf(stopSeq);
                if (idx !== -1) {
                  // Found stop sequence - mark it and truncate
                  const absoluteIdx = checkFromIndex + idx;
                  detectedStopSequence = stopSeq;
                  truncatedAccumulated = accumulated.slice(0, absoluteIdx);

                  // Emit only the portion up to stop sequence with metadata
                  const alreadyEmitted = accumulated.length - chunk.length;
                  if (absoluteIdx > alreadyEmitted) {
                    const truncatedChunk = accumulated.slice(alreadyEmitted, absoluteIdx);
                    const meta: ChunkMeta = {
                      type: parser.getCurrentBlockType(),
                      visible: parser.getCurrentBlockType() === 'text',
                      blockIndex: 0, // Approximate
                    };
                    onChunk?.(truncatedChunk, meta);
                  }
                  return;
                }
              }

              // Emit in correct interleaved order using emissions array
              for (const emission of emissions) {
                if (emission.kind === 'blockEvent') {
                  onBlock?.(emission.event);
                } else {
                  onChunk?.(emission.text, emission.meta);
                }
              }
            },
            onContentBlock: onContentBlockUpdate
              ? (index: number, block: unknown) => onContentBlockUpdate(index, block as ContentBlock)
              : undefined,
          },
          {
            signal,
            timeoutMs,
            idleTimeoutMs,
            normalizedRequest: request,
            // The tag-based parser tracks thinking via <thinking> tags — ask the
            // provider to wrap native thinking deltas so they don't stream as
            // visible text (see ProviderRequestOptions.wrapThinkingTags)
            wrapThinkingTags: true,
            onRequest: (req) => {
              rawRequest = req;
              onRequest?.(req);
            },
          }
        );

        rounds++;
        providerCalls += streamResult.providerCalls;

        // If we detected stop sequence manually, fix up the parser and result
        if (detectedStopSequence && truncatedAccumulated !== null) {
          parser.reset();
          parser.push(truncatedAccumulated);
          streamResult.stopReason = 'stop_sequence';
          streamResult.stopSequence = detectedStopSequence;
        }

        // Capture non-text content blocks from provider response (e.g., generated_image from Gemini)
        // The XML parser only handles text — binary content blocks need to be preserved separately
        if (Array.isArray(streamResult.content)) {
          for (const block of streamResult.content) {
            if (block.type === 'generated_image') {
              extraContentBlocks.push({
                type: 'generated_image',
                data: (block as any).data,
                mimeType: (block as any).mimeType,
              } as ContentBlock);
            }
          }
          // Native thinking blocks carry the signature (encrypted full
          // reasoning) — captured so consumers can persist and round-trip
          // them for reasoning continuity.
          this.captureProviderThinkingBlocks(streamResult.content, providerThinkingBlocks);
        }

        rawResponse = streamResult.raw;

        // Call onResponse callback with raw response from API
        onResponse?.(rawResponse);

        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastStopSequence = streamResult.stopSequence ?? undefined;

        // Accumulate usage (including cache metrics)
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
        if (streamResult.usage.cacheCreationTokens) {
          totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + streamResult.usage.cacheCreationTokens;
        }
        if (streamResult.usage.cacheReadTokens) {
          totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + streamResult.usage.cacheReadTokens;
        }
        if (pricing) totalUsage.estimatedCost = calculateCost(totalUsage, pricing);
        onUsage?.(totalUsage);

        // Flush the parser to complete any in-progress streaming block
        const flushResult = parser.flush();
        for (const emission of flushResult.emissions) {
          if (emission.kind === 'blockEvent') {
            onBlock?.(emission.event);
          }
        }

        // Get accumulated text from parser
        const accumulated = parser.getAccumulated();

        // Stall accounting (issue #39): only rounds ENTERED via automatic
        // resumption can stall — tool rounds are caller-governed work and a
        // real tool call is longer than the threshold anyway. A stall is a
        // resumption that streamed almost nothing and stopped identically to
        // the previous round; the turn ends only after several IN A ROW
        // (one short repeated round is low progress, not proof of none —
        // a stop sequence inside legitimate tool-argument text can cause a
        // couple of short resumptions on the way to completing).
        const streamedThisRound = accumulated.length - checkFromIndex;
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
              `stopReason 'no_progress'. ${totalUsage.inputTokens} input tokens spent this turn.`
            );
            lastStopReason = 'no_progress';
            break;
          }
        } else {
          consecutiveStalledResumptions = 0;
        }
        prevRoundStopSequence = lastStopSequence;
        enteredViaResumption = false;

        // Check for tool calls (if handler provided)
        if (onToolCalls && streamResult.stopSequence === '</function_calls>') {
          // Append the closing tag (we truncated before it, or API stopped before it)
          const closeTag = '</function_calls>';
          parser.push(closeTag);
          // Note: closing tag is structural XML, not emitted via onChunk (invisible)

          const parsed = parseToolCalls(parser.getAccumulated());

          if (parsed && parsed.calls.length > 0) {
            // Notify about pre-tool content
            // Slice the seeded prefill off: beforeText starts with the whole
            // flattened document in XML mode (see ToolContext note below).
            const preToolNew = parsed.beforeText.slice(initialPrefillLength);
            if (onPreToolContent && preToolNew.trim()) {
              await onPreToolContent(preToolNew);
            }

            // Emit block events for each tool call
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

            // Track the tool calls
            executedToolCalls.push(...parsed.calls);

            // Execute tools.
            // preamble/accumulated must expose the MODEL'S text only. The
            // parser is seeded with the entire assistant prefill (the whole
            // flattened document in XML mode), so parsed.beforeText starts
            // with it — consumers that persist the preamble as "what the
            // agent said this round" would otherwise write the full document
            // back into the store as an assistant message (observed on Ash,
            // 2026-07-26: a died-mid-rounds turn flushed a ~720k-char
            // document echo into her message store as 62 sharded messages).
            // The turn-END path already slices (newContent =
            // fullAccumulated.slice(initialPrefillLength)); the tool-round
            // path must match it.
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

            // Backfill tool names for the legacy XML result rendering
            // (<result><tool_name>…</tool_name><stdout>…) when the executor
            // didn't supply them.
            const callNames = new Map(parsed.calls.map((c) => [c.id, c.name]));
            for (const r of results) {
              if (!r.toolName) r.toolName = callNames.get(r.toolUseId);
            }

            // Track the tool results
            executedToolResults.push(...results);

            // Check if results contain images (requires split-turn injection)
            if (hasImageInToolResults(results)) {
              // Use split-turn injection for images
              const splitContent = formatToolResultsForSplitTurn(results);

              // Emit block events for tool results (image path)
              const toolResultBlockIndex = parser.getBlockIndex();
              onBlock?.({
                event: 'block_start',
                index: toolResultBlockIndex,
                block: { type: 'tool_result' },
              });

              // Push XML to parser for prefill (internal)
              parser.push(splitContent.beforeImageXml);

              // Emit chunk and block complete for each tool result (without XML wrapper)
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

              // If thinking is enabled, add <thinking> tag after tool results
              let afterImageXml = splitContent.afterImageXml;
              if (request.config.thinking?.enabled) {
                afterImageXml += '\n<thinking>';
              }

              // Build continuation with image injection
              providerRequest = this.buildContinuationRequestWithImages(
                request,
                prefillResult,
                parser.getAccumulated(),
                splitContent.images,
                afterImageXml
              );

              // Also add afterImageXml to accumulated for complete rawAssistantText
              // Note: afterImageXml is internal prefill (closing tags), not emitted via onChunk
              parser.push(afterImageXml);
              prefillResult.assistantPrefill = parser.getAccumulated();

              // Reset parser state for new streaming iteration
              parser.resetForNewIteration();
            } else {
              // Standard path: no images, use simple XML injection
              const resultsXml = formatToolResults(results);

              // Emit block events for tool results
              const toolResultBlockIndex = parser.getBlockIndex();
              onBlock?.({
                event: 'block_start',
                index: toolResultBlockIndex,
                block: { type: 'tool_result' },
              });

              // Push XML to parser for prefill (internal), but emit clean content via onChunk
              parser.push(resultsXml);

              // Emit chunk and block complete for each tool result (without XML wrapper)
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

              // If thinking is enabled, add <thinking> tag after tool results
              // to prompt the model to think before responding
              if (request.config.thinking?.enabled) {
                parser.push('\n<thinking>');
              }

              // Update prefill and continue
              prefillResult.assistantPrefill = parser.getAccumulated();
              providerRequest = this.buildContinuationRequest(
                request,
                prefillResult,
                parser.getAccumulated()
              );
            }

            // Next round's model text starts after everything injected this
            // round (results XML, image-split tags, thinking opener).
            roundStartLen = parser.getAccumulated().length;

            // Reset parser state for new streaming iteration. Tool rounds
            // are the caller's work — they count against maxToolDepth only,
            // never against the resumption guards (issue #39 review).
            parser.resetForNewIteration();
            toolDepth++;
            continue;
          }
        }

        // Check for false-positive stop (unclosed block)
        // Only resume if we stopped on a stop_sequence (not end_turn or max_tokens)
        // Use depth delta vs prefill baseline: only treat as false positive if the MODEL
        // opened a new block (depth increased beyond what was inherited from prefill context).
        // This prevents unclosed tags from other bots' messages in prefill from triggering
        // infinite continuation loops.
        const currentDepths = parser.getDepths();
        const modelOpenedNewBlock =
          currentDepths.functionCalls > prefillDepths.functionCalls ||
          currentDepths.functionResults > prefillDepths.functionResults ||
          currentDepths.thinking > prefillDepths.thinking;

        if (lastStopReason === 'stop_sequence' && modelOpenedNewBlock) {
          // False positive! The stop sequence (e.g., "\nUser:") appeared inside XML content
          // Re-add the consumed stop sequence and resume streaming
          if (streamResult.stopSequence) {
            parser.push(streamResult.stopSequence);
            const meta: ChunkMeta = {
              type: parser.getCurrentBlockType(),
              visible: parser.getCurrentBlockType() === 'text',
              blockIndex: 0,
            };
            onChunk?.(streamResult.stopSequence, meta);
          }

          // Resume streaming - but limit resumptions to prevent infinite loops
          toolDepth++; // Count this as a "depth" to limit iterations
          if (toolDepth > maxToolDepth) {
            break;
          }
          if (!registerResumptionRound()) {
            lastStopReason = 'round_limit';
            break;
          }
          enteredViaResumption = true;
          prefillResult.assistantPrefill = parser.getAccumulated();
          providerRequest = this.buildContinuationRequest(
            request,
            prefillResult,
            parser.getAccumulated()
          );
          // Reset parser state for new streaming iteration
          parser.resetForNewIteration();
          continue;
        }

        // No more tools or tool handling disabled, we're done
        break;
      }

      // Build final response - only use NEW content (after initial prefill) for content parsing
      // The full accumulated text is still available in raw.response
      const fullAccumulated = parser.getAccumulated();
      const newContent = fullAccumulated.slice(initialPrefillLength);

      const response = this.buildFinalResponse(
        newContent,
        contentBlocks,
        lastStopReason,
        totalUsage,
        request,
        prefillResult,
        startTime,
        providerCalls,
        rawRequest,
        rawResponse,
        executedToolCalls,
        executedToolResults,
        initialBlockType,
        lastStopSequence
      );

      // Append non-text content blocks (e.g., generated_image) that the XML parser can't handle
      if (extraContentBlocks.length > 0) {
        response.content.push(...extraContentBlocks);
      }

      // Merge provider thinking signatures into parser-derived thinking blocks
      this.mergeProviderThinkingBlocks(response.content, providerThinkingBlocks);

      response.details.timing.rounds = rounds;

      return response;
    } catch (error) {
      // Check if this is an abort error
      if (this.isAbortError(error)) {
        // Only use NEW content (after initial prefill) for partial content
        const fullAccumulated = parser.getAccumulated();
        const newContent = fullAccumulated.slice(initialPrefillLength);

        return this.buildAbortedResponse(
          newContent,
          totalUsage,
          executedToolCalls,
          executedToolResults,
          this.abortReason(error, signal),
          initialBlockType
        );
      }
      // Re-throw with rawRequest attached for logging
      throw this.attachRawRequest(error, rawRequest);
    }
  }

  /**
   * Stream with native API tool execution
   */
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
    } = options;

    let toolDepth = 0;
    // Honest turn telemetry: provider calls actually made (including refusal
    // re-issues inside streamOnce) and continuation rounds.
    let providerCalls = 0;
    let rounds = 0;
    let totalUsage: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
    const pricing = this.resolvePricing(request.config.model);
    let lastStopReason: StopReason = 'end_turn';
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    // Track all text for rawAssistantText
    let allTextAccumulated = '';

    // Track executed tool calls and results
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

    // Build messages array that we'll update with tool results
    let messages = [...request.messages];
    let allContentBlocks: ContentBlock[] = [];
    let markersInLastRequest = 0;

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {
        // Build provider request with native tools
        const providerRequest = this.buildNativeToolRequest(request, messages, toolDepth > 0, activeFormatter);

        // Stream from provider
        let textAccumulated = '';
        // Tag every token chunk with the membrane block it belongs to and
        // surface the block lifecycle through onBlock — the same shape
        // runNativeToolsYielding uses (#19). Before this, meta.type was
        // hardcoded to 'text' on every chunk and onBlock was never invoked
        // from this path (#20).
        const tracker = new NativeBlockTracker(onBlock ? (event) => onBlock(event) : undefined);
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              textAccumulated += chunk;
              allTextAccumulated += chunk;
              const meta: ChunkMeta = {
                type: tracker.currentType,
                visible: tracker.currentType === 'text',
                blockIndex: tracker.blockIndex,
              };
              onChunk?.(chunk, meta);
            },
            onContentBlock: (index: number, block: unknown) => {
              tracker.onProviderBlock(index, block);
              // Deprecated pass-through, kept for callers still on it.
              onContentBlockUpdate?.(index, block as ContentBlock);
            },
          },
          {
            signal,
            timeoutMs,
            idleTimeoutMs,
            normalizedRequest: request,
            onRequest: (req) => {
              rawRequest = req;
              onRequest?.(req);
            },
            // Telemetry reports what this request actually SHIPPED with —
            // builder breakpoints, stale passthrough, fallback, float, plus
            // whatever the beforeRequest hook and the wire clamp did after
            // the build. Both native paths used to hardcode 0, and counting
            // at build time reported a number no request ever had.
            onWireCacheMarkers: (markerCount) => {
              markersInLastRequest = markerCount;
            },
          }
        );

        // Single-callback adapters (OpenAI Responses) report each finalised
        // block once, after the stream: complete whatever never saw a stop.
        tracker.flush();
        rounds++;
        providerCalls += streamResult.providerCalls;

        rawResponse = streamResult.raw;

        // Call onResponse callback with raw response from API
        onResponse?.(rawResponse);

        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastStopSequence = streamResult.stopSequence ?? undefined;

        // Accumulate usage (including cache metrics)
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
        if (streamResult.usage.cacheCreationTokens) {
          totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + streamResult.usage.cacheCreationTokens;
        }
        if (streamResult.usage.cacheReadTokens) {
          totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + streamResult.usage.cacheReadTokens;
        }
        if (pricing) totalUsage.estimatedCost = calculateCost(totalUsage, pricing);
        onUsage?.(totalUsage);

        // Parse content blocks from response
        const responseBlocks = this.parseProviderContent(streamResult.content);
        allContentBlocks.push(...responseBlocks);

        // Check for tool_use blocks
        const toolUseBlocks = responseBlocks.filter(
          (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use'
        );

        if (onToolCalls && toolUseBlocks.length > 0 && lastStopReason === 'tool_use') {
          // Notify about pre-tool content
          const textBlocks = responseBlocks.filter(b => b.type === 'text');
          if (onPreToolContent && textBlocks.length > 0) {
            const preToolText = textBlocks.map(b => (b as any).text).join('');
            if (preToolText.trim()) {
              await onPreToolContent(preToolText);
            }
          }

          // Convert to normalized ToolCall[]
          const toolCalls: ToolCall[] = toolUseBlocks.map(block => ({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          }));

          // Track tool calls
          executedToolCalls.push(...toolCalls);

          // Execute tools
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

          // Track tool results
          executedToolResults.push(...results);

          // Add tool results to content blocks
          for (const result of results) {
            allContentBlocks.push({
              type: 'tool_result',
              toolUseId: result.toolUseId,
              content: result.content,
              isError: result.isError,
            });
          }

          // Add assistant message with tool use and user message with tool results.
          // Use the request's participant name so role mapping is consistent.
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

        // No more tools, we're done
        break;
      }

      const durationMs = Date.now() - startTime;

      return {
        content: allContentBlocks,
        rawAssistantText: allTextAccumulated,
        toolCalls: executedToolCalls,
        toolResults: executedToolResults,
        stopReason: lastStopReason,
        usage: totalUsage,
        details: {
          stop: {
            reason: lastStopReason,
            triggeredSequence: lastStopSequence,
            wasTruncated: lastStopReason === 'max_tokens',
          },
          usage: { ...totalUsage },
          timing: {
            totalDurationMs: durationMs,
            attempts: providerCalls,
            rounds,
          },
          model: {
            requested: request.config.model,
            actual: request.config.model,
            provider: this.adapter.name,
          },
          cache: {
            markersInRequest: markersInLastRequest,
            tokensCreated: totalUsage.cacheCreationTokens ?? 0,
            tokensRead: totalUsage.cacheReadTokens ?? 0,
            hitRatio: this.calculateCacheHitRatio(totalUsage),
          },
        },
        raw: {
          request: rawRequest,
          response: rawResponse,
        },
      };
    } catch (error) {
      // Check if this is an abort error
      if (this.isAbortError(error)) {
        return this.buildAbortedResponse(
          allTextAccumulated,
          totalUsage,
          executedToolCalls,
          executedToolResults,
          this.abortReason(error, signal)
        );
      }
      // Re-throw with rawRequest attached for logging
      throw this.attachRawRequest(error, rawRequest);
    }
  }

  /**
   * Rate-limit state for the float's budget warning. See the
   * floating-cache-marker block in buildNativeToolRequest.
   *
   * A once-per-instance latch made the ONLY observable of an over-budget wire
   * go quiet for the life of the process: a long-lived Membrane warns for the
   * first agent that trips it and never again, so the condition looks like it
   * healed. Warn on the first occurrence, then at most once per interval,
   * carrying the count of what was suppressed in between.
   */
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

  /**
   * Build a provider request with native tool support.
   *
   * `toolLoopRebuild` is true when this build is a tool-loop continuation
   * (toolDepth > 0) rather than the turn's first request — the only case
   * where the floating cache marker applies.
   *
   * `activeFormatter` is the formatter the caller selected for the request
   * (see resolveActiveFormatter). Reading `this.formatter` here instead made
   * the native loop build through the instance formatter while the mode had
   * been resolved against a per-request override — the two disagreeing about
   * which formatter is active.
   */
  private buildNativeToolRequest(
    request: NormalizedRequest,
    messages: typeof request.messages,
    toolLoopRebuild = false,
    activeFormatter: PrefillFormatter = this.formatter
  ): any {
    // Provider-native formatters own their complete input-item shape. The
    // legacy implementation below is intentionally Anthropic-specific; using
    // it for Responses would normalize away item IDs, encrypted reasoning,
    // assistant phases, and compaction items.
    if (activeFormatter.name === 'openai-responses') {
      return this.transformRequest({ ...request, messages }, activeFormatter).providerRequest;
    }

    // Convert messages to provider format
    const providerMessages: any[] = [];
    
    const assistantName = request.assistantParticipant
      ?? this.config.assistantParticipant ?? 'Claude';

    const promptCaching = request.promptCaching ?? this.config.defaultPromptCaching ?? true;
    const cacheControl = promptCaching ? { type: 'ephemeral' as const, ...(request.cacheTtl ? { ttl: request.cacheTtl } : {}) } : undefined;

    // Anthropic allows at most 4 cache_control breakpoints per request. The
    // message breakpoints are the valuable ones (they cache the longest prefixes,
    // and every one already includes tools+system at the front of the request).
    // So tools/system get a breakpoint only as a FALLBACK — when no marker
    // exists anywhere on the wire — otherwise they're redundant and would push
    // the total past 4, which the API hard-rejects (the agent goes
    // unresponsive). The fallback gate reads a RECOUNT of the built artifacts
    // (see below), never a running tally: a running tally cannot see a
    // caller-marked system block, and double-counts a message breakpoint that
    // lands on a block already carrying stale cache_control.
    for (const msg of messages) {
      const isAssistant = msg.participant === assistantName;
      const role = isAssistant ? 'assistant' : 'user';

      // Convert content blocks
      const content: any[] = [];
      const includeNamePrefix = !isAssistant;
      for (const block of msg.content) {
        if (block.type === 'text') {
          // Empty text blocks are rejected by the Anthropic API. In
          // particular, zero-width rawItem carriers (opaque Responses items,
          // see parseProviderContent) must not leak here. Filter BEFORE the
          // name prefix below would make them non-empty.
          if (block.text === '') continue;
          let text = block.text;
          if (includeNamePrefix && msg.participant) {
            text = `${msg.participant}: ${text}`;
          }
          const textBlock: Record<string, unknown> = { type: 'text', text };
          if ((block as any).cache_control) {
            // A block-level passthrough occupies one of the 4 breakpoint slots
            // exactly like a marked message; the recount below sees it.
            // (Imported/seeded conversations carry stale request-time
            // cache_control on stored blocks — first seen wedging Sill
            // 2026-07-25: 3 cm markers + 2 stale Arc-export blocks = 5 → hard
            // 400 on every inference.)
            textBlock.cache_control = (block as any).cache_control;
          }
          content.push(textBlock);
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: sanitizeToolName(block.name),
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          });
        } else if (block.type === 'thinking') {
          // Round-trip thinking blocks verbatim including the signature — the
          // API validates it and (on display:'omitted' models) decrypts it to
          // reconstruct prior reasoning. Empty thinking + signature is valid.
          content.push({
            type: 'thinking',
            thinking: (block as { thinking?: string }).thinking ?? '',
            ...((block as { signature?: string }).signature
              ? { signature: (block as { signature?: string }).signature }
              : {}),
          });
        } else if (block.type === 'redacted_thinking') {
          content.push({ ...(block as unknown as Record<string, unknown>) });
        } else if (block.type === 'image') {
          if (block.source.type === 'base64') {
            if (!isAcceptedImageMediaType(block.source.mediaType)) {
              // API-unacceptable media type (e.g. image/svg): degrade to a
              // loud text placeholder instead of poisoning the whole request
              // (one bad stored block otherwise 400s every compile forever).
              content.push(strippedImagePlaceholder(block.source.mediaType));
            } else {
              const imageBlock: Record<string, unknown> = {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: block.source.mediaType,
                  data: block.source.data,
                },
              };
              // Preserve sourceUrl for providers that use URL-as-text (Gemini 3.x)
              if (block.sourceUrl) {
                imageBlock.sourceUrl = block.sourceUrl;
              }
              content.push(imageBlock);
            }
          }
        }
      }

      // Apply cache_control to the last CACHEABLE block of messages with a
      // cacheBreakpoint. The API rejects cache_control on thinking /
      // redacted_thinking blocks (400 "thinking.cache_control: Extra inputs
      // are not permitted"), so a breakpoint landing on a thinking-terminated
      // message must step back to the last non-thinking block — and is skipped
      // entirely when the message is thinking-only.
      //
      // 2026-07-14: this is the THIRD request builder to need the rule. The
      // 2026-07-01 fix hardened NativeFormatter's two sites but not this one,
      // which is the live Connectome path (native tools + thinking) — so the
      // 400 came back the moment a breakpoint landed on a thinking-only turn.
      // The rule now lives in ONE exported helper that every builder calls.
      if (msg.cacheBreakpoint && cacheControl && content.length > 0) {
        const bpIdx = lastCacheableBlockIndex(content as Array<Record<string, unknown>>);
        if (bpIdx >= 0) {
          content[bpIdx].cache_control = cacheControl;
        }
      }

      providerMessages.push({ role, content });
    }

    // Wire-boundary safety net: repair upstream-produced violations of
    // Anthropic's tool-cycle structural rules (orphan tool_use, mis-roled
    // blocks, consecutive same-role envelopes from upstream chunkers that
    // dropped a tool_result). Mirrors NativeFormatter.buildMessages — the
    // streaming-native path (runNativeToolsYielding) used to bypass this
    // and exposed every agent inference to the 400 family.
    //
    // Synthesized [pending] tool_results land in fresh user envelopes;
    // the normalizer also suppresses cache_control on those envelopes
    // so an in-flight gap can't poison the prompt cache. Merging after
    // normalize collapses any same-role neighbours the upstream may have
    // produced before they reach the API's alternating-role check.
    //
    // `pendingToolCallIds` is intentionally not threaded here: by the
    // time runNativeToolsYielding rebuilds the request between
    // tool-execution rounds, it has already appended the corresponding
    // tool_results to `messages`. Any unmatched tool_use that reaches
    // this splice is upstream stranding (the bug class this fix exists
    // to catch) — `[pending]` is exactly the right synthesis.
    // A synthesized [pending] tool_result's bytes are rewritten when the
    // real result lands — the floating-marker block below must not cache
    // past one. `synthetic_pending_result` (not the downstream
    // cache_suppressed_for_synthetic, which only fires when a marker was
    // actually stripped) is the root condition.
    // Every repair that REWRITES prefix bytes stands the float down, not just
    // the synthetic [pending] result: a textified orphan tool_result is
    // rewritten the same way when its real pairing arrives, so caching at or
    // past one poisons the prefix identically. The kinds live in one exported
    // set so a normalizer that grows a new prefix-rewriting repair cannot
    // silently escape this guard.
    let prefixRewritten = false;
    const normalized = normalizeToolPairs(providerMessages, {
      onEvent: (e) => {
        if (PREFIX_REWRITING_NORMALIZE_EVENT_KINDS.has(e.kind)) prefixRewritten = true;
      },
    });
    const mergedMessages = mergeConsecutiveRoles(normalized.messages);

    // ONE recount of the constructed wire artifacts, taken BEFORE the
    // tools/system fallback decision so the fallback and the float share a
    // single truth. Counted post-normalize, so phase-5.5 cache suppression is
    // already reflected. `request.system` is the caller's own system content:
    // it explicitly accepts pre-marked blocks, and those are real wire markers
    // that no running tally ever saw (three of them plus both fallbacks = 5 on
    // the wire = a 400 on every inference of that config).
    const upstreamWireMarkers = countWireCacheMarkers({
      messages: mergedMessages,
      system: request.system,
    });

    // Convert tools to provider format.
    // Native tool names must match ^[a-zA-Z0-9_-]{1,128}$ — sanitize colons
    // from the module:tool namespace convention. Reversed in parseProviderContent.
    const tools = request.tools?.map((tool, idx) => {
      const t: Record<string, unknown> = {
        name: sanitizeToolName(tool.name),
        description: tool.description,
        input_schema: tool.inputSchema,
      };
      // Cache the tool list (last tool) only as a fallback — a marked message
      // breakpoint already caches the tools as part of its prefix.
      if (cacheControl && upstreamWireMarkers === 0 && request.tools && idx === request.tools.length - 1) {
        t.cache_control = cacheControl;
      }
      return t;
    });

    // Wrap system prompt with cache_control only as a fallback (no message
    // breakpoint marked); otherwise a message breakpoint already caches
    // tools+system as part of its prefix.
    let system: unknown = ownSystemBlocks(request.system);
    if (cacheControl && upstreamWireMarkers === 0 && typeof system === 'string' && system.length > 0) {
      system = [{ type: 'text', text: system, cache_control: cacheControl }];
    } else if (cacheControl && upstreamWireMarkers === 0 && Array.isArray(system) && system.length > 0) {
      const blocks = system as Record<string, unknown>[];
      system = blocks.map((block, idx) =>
        idx === blocks.length - 1 ? { ...block, cache_control: cacheControl } : block
      );
    }

    // ------------------------------------------------------------------
    // Floating cache marker: incremental prompt caching inside the native
    // tool loop. Message breakpoints are placed by the context strategy at
    // compile time — once per turn — but this builder re-runs on every
    // tool round with that round's messages appended, so the deepest
    // upstream marker stays glued to the turn-start snapshot and each
    // rebuild re-pays the entire appended suffix at full input price
    // (qa-ops incident, 2026-08-20: two subagents re-sent a suffix growing
    // to ~118k tokens ~30 times each — ~5.3M uncached tokens in 18 min —
    // with their one marker sitting on message 2 of 61).
    //
    // The tool loop only ever appends, so a marker riding the newest
    // message yields the intended incremental pattern: each round writes
    // its delta and cache-reads everything before it.
    //
    // Authority contract: the float spends only the RESIDUAL breakpoint
    // budget (Anthropic allows 4 cache_control including tools/system).
    // Upstream markers are never displaced or stripped — if they fill all
    // 4 slots the float is withheld (with a warning) and behavior is
    // exactly pre-float. With 2+ slots free, the previous round's
    // endpoint is marked too: a wide parallel-tool round can append more
    // blocks than the provider's ~20-block backward search covers, which
    // would orphan the previous round's cache entry behind an unmarked
    // boundary.
    //
    // Skipped when the normalizer synthesized a [pending] tool_result:
    // those bytes are rewritten when the real result lands, and caching
    // past them poisons the prefix — the same rationale as the
    // normalizer's phase 5.5 cache suppression.
    // ------------------------------------------------------------------
    const floatingEnabled =
      request.floatingCacheMarker ?? this.config.defaultFloatingCacheMarker ?? true;
    if (toolLoopRebuild && floatingEnabled && cacheControl && !prefixRewritten) {
      // Same recount as the fallback gate, re-taken POST-fallback so the
      // fallback's own spend is inside the residuum.
      const wireMarkers = countWireCacheMarkers({ messages: mergedMessages, system, tools });
      let residuum = MAX_CACHE_BREAKPOINTS - wireMarkers;
      if (residuum <= 0) {
        this.warnFloatBudgetExhausted(wireMarkers);
      } else {
        // Newest message first; then the previous round's endpoint (two
        // wire messages back: [..., prevResults, assistant, results]).
        const targets = [mergedMessages.length - 1, mergedMessages.length - 3];
        for (const mi of targets) {
          if (residuum <= 0 || mi < 0) continue;
          const content = mergedMessages[mi]?.content;
          if (!Array.isArray(content) || content.length === 0) continue;
          const bpIdx = lastCacheableBlockIndex(content as Array<Record<string, unknown>>);
          if (bpIdx < 0) continue;
          // Already a breakpoint here (e.g. the strategy's own end marker
          // on the turn's first rebuild) — nothing to add.
          if ((content[bpIdx] as Record<string, unknown>).cache_control) continue;
          (content[bpIdx] as Record<string, unknown>).cache_control = cacheControl;
          residuum--;
        }
      }
    }

    // Build thinking config for native extended thinking (budget clamped to max_tokens)
    // Fable/Mythos models: thinking is always on and unconfigurable; sampling params are removed.
    // Sending thinking config or temperature returns a 400 — omit both entirely.
    const alwaysOnThinking = Membrane.isAlwaysThinkingModel(request.config.model);
    const thinking = alwaysOnThinking ? undefined : this.buildThinkingParam(request.config);

    // Anthropic requires temperature=1 when extended thinking is enabled
    const temperature = alwaysOnThinking ? undefined : (thinking ? 1 : request.config.temperature);

    // Byte-wall policy point (see transformRequest): loud failure unless the
    // caller explicitly owns image loss.
    if (request.shedOversizeImages) {
      shedImagesToFitByteBudget(mergedMessages, undefined, 'buildNativeToolRequest');
    } else {
      assertWithinByteBudget(mergedMessages, undefined, 'buildNativeToolRequest');
    }

    return {
      model: request.config.model,
      maxTokens: request.config.maxTokens,
      temperature,
      messages: mergedMessages,
      system,
      tools,
      thinking,
      extra: request.providerParams,
    };
  }

  /**
   * Parse provider response content into normalized blocks
   */
  private parseProviderContent(content: unknown): ContentBlock[] {
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
            name: unsanitizeToolName(item.name),
            input: item.input,
            // Arguments that never parsed: carry the marker through so a
            // consumer can refuse the block instead of trusting `input`.
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
          // Pass through verbatim — carries the encrypted `data` payload
          blocks.push({ ...item } as ContentBlock);
        } else if (item.type === 'generated_image') {
          blocks.push({
            type: 'generated_image',
            data: item.data,
            mimeType: item.mimeType,
          });
        } else if (item.rawItem) {
          // Opaque Responses items such as encrypted compaction or custom
          // tool records have no normalized ContentBlock equivalent. Retain a
          // zero-width carrier so Chronicle and the Responses formatter can
          // replay the raw item without surfacing synthetic prompt text.
          // Anthropic-bound conversion paths filter these out (empty text
          // blocks are a 400 there); the Responses formatter replays rawItem.
          blocks.push({ type: 'text', text: '', rawItem: item.rawItem });
        }
      }
      return blocks;
    }

    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }

    return [];
  }

  /**
   * Capture native thinking / redacted_thinking blocks from a provider
   * response so they can be merged into parser-derived content (XML paths,
   * where the parser only sees text). Includes signature-only thinking
   * blocks (display:'omitted' returns an empty thinking field).
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
   * Merge provider thinking signatures into parser-derived thinking blocks
   * and prepend any leftover provider blocks — signature-only thinking
   * (display:'omitted') never appears in the text stream, so the parser
   * produces no block for it. redacted_thinking blocks are always prepended
   * verbatim.
   *
   * Pairing is by CONTENT IDENTITY, never by index. The two lists are
   * differently shaped whenever the provider emits a block the parser cannot
   * see (signature-only), the parser emits a block the provider never
   * produced (the XML path's literal `Claude: <thinking>` prefill turns
   * VISIBLE text into a thinking block), or one provider block spans several
   * (auto-continuation: capture runs per round while the parser sees the
   * CONCATENATED accumulation). Index-zipping crosses the lists in all three
   * shapes and stamps a signature onto content that never produced it —
   * which round-trips into the consumer's stored history and fails Anthropic
   * signature validation on the next turn.
   *
   * The three rules, in order:
   *   1. identity — a provider block pairs with the parsed block whose
   *      thinking text is the same; empty-thinking (signature-only) blocks
   *      are never text-match candidates and are prepend-only.
   *   2. span — a parsed block that reconstructs as the concatenation of a
   *      RUN of consecutive unpaired provider blocks is REPLACED in place by
   *      those originals, so the spanning block never wears a fragment's
   *      signature and no reasoning is sent twice.
   *   3. leftover — everything still unpaired is prepended, de-duplicated
   *      against what `content` already carries (and against itself).
   *
   * Mutates `content` in place. Shared by the XML stream paths
   * (streamWithXmlTools and runXmlToolsYielding).
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

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Apply the configured `beforeRequest` hook to a provider-format request.
   * Returns the (possibly modified) request, or the original if no hook is
   * configured. This is the single point that all request-build sites should
   * route through before invoking the adapter, so observers / mutators
   * (logging, redaction, model rewriting) see every API call regardless of
   * whether it came from `complete()`, `stream()`, or `streamYielding()`.
   */
  private async applyBeforeRequestHook(
    normalizedRequest: NormalizedRequest,
    providerRequest: unknown,
  ): Promise<unknown> {
    if (!this.config.hooks?.beforeRequest) return providerRequest;
    const result = await this.config.hooks.beforeRequest(normalizedRequest, providerRequest);
    return result ?? providerRequest;
  }

  /**
   * Extract base provider params from config, with thinking temperature enforcement.
   * Used by transformRequest, buildContinuationRequest, and buildContinuationRequestWithImages.
   */
  private getBaseProviderParams(config: NormalizedRequest['config']) {
    // Fable/Mythos models: thinking always on (unconfigurable), sampling params removed — omit both.
    const alwaysOnThinking = Membrane.isAlwaysThinkingModel(config.model);
    // Build thinking config for native extended thinking
    const thinking = alwaysOnThinking ? undefined : this.buildThinkingParam(config);
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
   * Models with always-on, unconfigurable thinking (Claude Fable/Mythos family).
   * These reject `thinking` config and sampling params (`temperature`, `top_p`, `top_k`)
   * with a 400 — callers must omit them entirely.
   */
  private static isAlwaysThinkingModel(model: string | undefined): boolean {
    return /\b(fable|mythos)\b/i.test(model ?? '');
  }

  /**
   * Build the provider thinking parameter from config.
   *
   * For type 'enabled', the API requires max_tokens > budget_tokens and a
   * minimum budget of 1024 — a misconfigured budget (e.g., default 10000 with
   * max_tokens 4096) is clamped to fit. If no valid budget fits (max_tokens
   * too small), thinking is omitted entirely rather than sending a request
   * the API will reject.
   */
  private buildThinkingParam(config: NormalizedRequest['config']):
    | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' }
    | undefined {
    if (!config.thinking?.enabled) return undefined;

    const display = config.thinking.display;
    if ((config.thinking.type ?? 'enabled') === 'adaptive') {
      return { type: 'adaptive', ...(display ? { display } : {}) };
    }

    const requested = config.thinking.budgetTokens ?? 5000;
    const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : undefined;
    const budget = maxTokens !== undefined ? Math.min(requested, maxTokens - 1024) : requested;
    if (budget < 1024) {
      // Can't fit a valid thinking budget under max_tokens — skip thinking
      return undefined;
    }
    return { type: 'enabled', budget_tokens: budget, ...(display ? { display } : {}) };
  }

  /**
   * Transform a normalized request into provider format using the formatter.
   *
   * `activeFormatter` is the instance the caller already selected via
   * resolveActiveFormatter — including that selection's Responses-transport
   * authority rule, which used to live inline here. It is a parameter and not
   * a re-derivation so that the formatter which BUILDS is the same one that
   * resolved the tool mode and drives the loop.
   */
  private transformRequest(request: NormalizedRequest, activeFormatter: PrefillFormatter = this.formatter): {
    providerRequest: any;
    prefillResult: BuildResult;
  } {
    // Extract user-provided stop sequences
    const additionalStopSequences = Array.isArray(request.stopSequences)
      ? request.stopSequences
      : request.stopSequences?.sequences ?? [];

    // Request-level maxParticipantsForStop takes precedence over instance config
    const maxParticipantsForStop = request.maxParticipantsForStop
      ?? this.config.maxParticipantsForStop
      ?? 10;

    // Use formatter's buildMessages for all request building
    const buildResult = activeFormatter.buildMessages(request.messages, {
      participantMode: 'multiuser',
      assistantParticipant: request.assistantParticipant ?? this.config.assistantParticipant ?? 'Claude',
      tools: request.tools,
      // One resolution for every entry point: complete() used to build from the
      // formatter's constructor-time mode alone, so request.toolMode was a
      // second, disconnected source of truth on this path.
      toolMode: this.resolveToolMode(request, activeFormatter),
      thinking: request.config.thinking,
      systemPrompt: request.system,
      promptCaching: request.promptCaching ?? this.config.defaultPromptCaching ?? true, // Default true for backward compat
      cacheTtl: request.cacheTtl,
      additionalStopSequences,
      maxParticipantsForStop,
      contextPrefix: request.contextPrefix,
      prefillUserMessage: request.prefillUserMessage,
    });

    // Byte-wall policy point (2026-07-12): transformRequest serves BOTH
    // complete() and the streaming path through EVERY adapter. Oversize
    // requests FAIL LOUDLY here, before the API round-trip, unless the
    // caller explicitly owns image loss via `shedOversizeImages` (and the
    // shed itself reports at error grade). No silent transport mutation.
    if (request.shedOversizeImages) {
      shedImagesToFitByteBudget(buildResult.messages, undefined, 'transformRequest');
    } else {
      assertWithinByteBudget(buildResult.messages, undefined, 'transformRequest');
    }

    const providerRequest = {
      ...this.getBaseProviderParams(request.config),
      messages: buildResult.messages,
      // Owned, not aliased: the wire clamp strips markers in place, and a
      // formatter may pass the caller's own system array straight through.
      system: ownSystemBlocks(buildResult.systemContent),
      stopSequences: buildResult.stopSequences,
      tools: buildResult.nativeTools,
      extra: {
        ...request.providerParams,
        normalizedMessages: request.messages,
      },
    };

    // The API rejects extended thinking combined with an assistant prefill.
    // Prefill-style builds (XML formatter) use the thinking config for the
    // literal `<thinking>` text prefix instead of the API feature — drop the
    // API param when the built request actually ends in an assistant prefill.
    // Chat-style builds (no prefill) keep it.
    if (buildResult.assistantPrefill) {
      stripThinkingForPrefill(providerRequest);
    }

    return { providerRequest, prefillResult: buildResult };
  }

  private async streamOnce(
    request: any,
    callbacks: { onChunk: (chunk: string) => void; onContentBlock?: (index: number, block: unknown) => void },
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      onRequest?: (rawRequest: unknown) => void;
      /** See ProviderRequestOptions.wrapThinkingTags */
      wrapThinkingTags?: boolean;
      /**
       * The original NormalizedRequest, threaded through so the
       * `beforeRequest` hook can see both shapes (normalized + provider).
       * Required: forgetting this is the failure mode the helper exists to
       * prevent (the streaming paths previously skipped the hook entirely).
       * If a future caller genuinely needs to bypass the hook, introduce a
       * separate `streamOnceWithoutHook` so the bypass is intentional.
       */
      normalizedRequest: NormalizedRequest;
      /**
       * Re-issue this attempt when the provider ends it with
       * `stop_reason: 'refusal'` (see RetryingEvent). Default 0 = off, so
       * every existing caller keeps byte-identical behaviour.
       */
      refusalRetries?: number;
      /**
       * REQUIRED to enable streaming retries. Called immediately before a
       * re-issue so the caller can discard the abandoned attempt: reset its
       * accumulators and tell its own consumer to drop what it emitted.
       *
       * Without it a retry would silently concatenate two attempts, so a
       * caller that does not pass this simply does not get retries — an
       * unaware consumer can never be corrupted by enabling the option
       * somewhere upstream.
       */
      onRetrying?: (info: { attempt: number; maxAttempts: number; category?: string }) => void;
      /**
       * Receives the number of cache_control markers the request ACTUALLY
       * ships with, taken from the clamp's own tally below — i.e. after the
       * `beforeRequest` hook has added or removed markers of its own and
       * after everything past the 4-breakpoint budget has been dropped.
       *
       * Telemetry that counts the request at BUILD time reports a number no
       * request ever had (a hook placing 7 markers on a wire that carries 4
       * was reported as the builder's 1), which defeats the audit the count
       * exists for. This is the only count that describes the wire.
       */
      onWireCacheMarkers?: (markerCount: number) => void;
    }
  ): Promise<
    import('./types/provider.js').ProviderResponse & {
      discardedUsage?: DiscardedAttemptsUsage;
      /** Provider calls this helper made, including refusal re-issues. */
      providerCalls: number;
    }
  > {
    // Strip `normalizedRequest` before forwarding to the adapter — it's
    // not part of `ProviderRequestOptions` and TypeScript's structural
    // compatibility won't catch the excess field (checked only on object
    // literals, not on variables). Leaving it in would silently leak the
    // normalized form into every adapter's options.
    const { normalizedRequest, refusalRetries, onRetrying, onWireCacheMarkers, ...adapterOptions } = options;
    const finalRequest = (await this.applyBeforeRequestHook(normalizedRequest, request)) as typeof request;

    // Last exit before the adapter: the only place that sees EVERY
    // contribution (builder, formatter, passthrough, float, hook). Every
    // streaming path — stream(), streamYielding(), both tool loops — funnels
    // through here, so this is the one clamp they all get, and its tally is
    // therefore the only count that describes the wire.
    const clampOutcome = clampCacheMarkers(finalRequest, 'streamOnce');
    onWireCacheMarkers?.(clampOutcome.total);

    // Retries are only safe when the caller can discard the abandoned
    // attempt, so they require BOTH a budget and an onRetrying hook.
    const maxAttempts = onRetrying ? Math.max(0, refusalRetries ?? 0) : 0;
    let retried = 0;
    // Every re-issued attempt was a completed, billed provider call. The
    // caller's usage accumulator only ever sees the surviving result, so the
    // abandoned spend rides back out on the result itself.
    let discardedUsage: DiscardedAttemptsUsage | undefined;
    let providerCalls = 0;
    while (true) {
      providerCalls++;
      const result = await this.adapter.stream(finalRequest, callbacks, adapterOptions);
      if (result.stopReason !== 'refusal' || retried >= maxAttempts) {
        return {
          ...result,
          providerCalls,
          ...(discardedUsage ? { discardedUsage } : {}),
        };
      }
      retried++;
      discardedUsage = this.mergeDiscardedAttempts(
        discardedUsage,
        this.discardedAttemptFrom(result.usage)
      );
      const category = (result.raw as { response?: { stop_details?: { category?: string } } } | undefined)
        ?.response?.stop_details?.category;
      onRetrying!({ attempt: retried, maxAttempts, category });
    }
  }

  private buildContinuationRequest(
    originalRequest: NormalizedRequest,
    prefillResult: BuildResult,
    accumulated: string
  ): any {
    // Anthropic quirk: assistant content cannot end with trailing whitespace
    const trimmedAccumulated = accumulated.trimEnd();

    // Everything before the watermark already rides EARLIER messages (a
    // persisted split turn), so only the suffix belongs in the trailing
    // assistant prefill — replacing it with the whole document would
    // duplicate the pre-seam text and flatten the image user-turn away.
    const baseOffset = prefillResult.accumulatedBaseOffset ?? 0;
    const trailingContent = accumulated.slice(baseOffset).trimEnd();

    // Build continuation messages: keep all messages up to last assistant,
    // then replace/add the accumulated content
    const messages = [...prefillResult.messages];
    
    // Find and update the last assistant message, or add one
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
      // Continuations always end in an assistant prefill — the API rejects
      // extended thinking combined with prefill, so never send the param here
      thinking: undefined,
      messages,
      system: ownSystemBlocks(prefillResult.systemContent) ?? undefined,
      stopSequences: prefillResult.stopSequences,
      extra: {
        ...originalRequest.providerParams,
        // Same contract transformRequest sends: adapters that reason about
        // the normalized shape (or fall back to serializing it) must not see
        // a continuation as a request with no normalized form at all.
        normalizedMessages: originalRequest.messages,
        // Pre-serialized prompt for completions adapters — skip re-serialization
        prompt: trimmedAccumulated,
      },
    });
  }

  /**
   * Build continuation request with split-turn image injection.
   *
   * When tool results contain images in prefill mode, we must:
   * 1. End assistant turn mid-XML (after text content, inside <function_results>)
   * 2. Insert user turn with only image content
   * 3. Continue with assistant prefill containing closing XML tags
   *
   * This is required because Anthropic API only allows images in user turns.
   *
   * Structure:
   * ```
   * Assistant: "...response..." + <function_results><result>text content
   * User: [image blocks]
   * Assistant (prefill): </result></function_results>
   * ```
   */
  private buildContinuationRequestWithImages(
    originalRequest: NormalizedRequest,
    prefillResult: BuildResult,
    accumulated: string,
    images: ProviderImageBlock[],
    afterImageXml: string
  ): any {
    // Anthropic quirk: assistant content cannot end with trailing whitespace
    const trimmedAccumulated = accumulated.trimEnd();

    // The split replaces only the CURRENT trailing assistant message, which
    // covers the accumulated text from the previous seam onward (0 on the
    // first split, the previous image seam on a later one).
    const baseOffset = prefillResult.accumulatedBaseOffset ?? 0;
    const trailingContent = accumulated.slice(baseOffset).trimEnd();

    // Build messages: copy all, then replace only the last assistant with split-turn
    const messages: any[] = prefillResult.messages.map(msg => ({ ...msg }));

    // Find last assistant — replace in-place via splice to preserve history
    let insertIdx = messages.length;
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx].role === 'assistant') {
        insertIdx = idx;
        break;
      }
    }

    // Anthropic quirk: assistant content cannot end with trailing whitespace
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

    // PERSIST the split. Later rounds rebuild from prefillResult.messages;
    // without this the image user-turn exists on exactly one request and the
    // next continuation flattens the accumulated document back over it —
    // leaving <function_results> XML asserting a screenshot the model can no
    // longer see. Reassign (never mutate in place): the previous array is
    // still referenced by the request already on the wire. The watermark
    // moves to the seam — the point in `accumulated` where afterImageXml is
    // about to be appended — so the next builder replaces only the closing
    // assistant turn.
    prefillResult.messages = messages;
    prefillResult.accumulatedBaseOffset = accumulated.length;

    return stripThinkingForPrefill({
      ...this.getBaseProviderParams(originalRequest.config),
      // Continuations always end in an assistant prefill — the API rejects
      // extended thinking combined with prefill, so never send the param here
      thinking: undefined,
      messages,
      system: ownSystemBlocks(prefillResult.systemContent) ?? undefined,
      stopSequences: prefillResult.stopSequences,
      // Copied, not aliased: the guard below deletes the smuggled thinking
      // config, and mutating the caller's own providerParams object would
      // silently disable thinking on their NEXT (non-prefill) request.
      extra: {
        ...originalRequest.providerParams,
        // Same contract as transformRequest and the plain continuation
        // builder. Without these a completions-style adapter fell through to
        // serializing PROVIDER-shaped messages as if they were normalized
        // ones, re-adding participant stop sequences the continuation
        // deliberately suppresses.
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
    rawRequest?: unknown
  ): NormalizedResponse {
    // Extract text from response
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];

    // Build raw text for rawAssistantText
    let rawAssistantText = '';

    if (Array.isArray(providerResponse.content)) {
      for (const block of providerResponse.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
          rawAssistantText += block.text;
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'thinking') {
          content.push({
            type: 'thinking',
            thinking: block.thinking ?? '',
            ...(block.signature ? { signature: block.signature } : {}),
          });
        } else if (block.type === 'redacted_thinking') {
          // Pass through verbatim — carries the encrypted `data` payload
          content.push({ ...(block as any) } as ContentBlock);
        } else if (block.type === 'generated_image') {
          content.push({
            type: 'generated_image',
            data: block.data,
            mimeType: block.mimeType,
          });
        }
      }
    } else if (typeof providerResponse.content === 'string') {
      content.push({ type: 'text', text: providerResponse.content });
      rawAssistantText = providerResponse.content;
    }

    // If we stopped on a closing XML tag, append it to the text so parsers can complete
    // the block. The API stops BEFORE the stop sequence, but we need the closing tag.
    const stoppedOnClosingTag = providerResponse.stopReason === 'stop_sequence' &&
      providerResponse.stopSequence?.startsWith('</');
    if (stoppedOnClosingTag && providerResponse.stopSequence) {
      rawAssistantText += providerResponse.stopSequence;
      // Update the last text content block if it exists
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i]!;
        if (block.type === 'text') {
          (block as { type: 'text'; text: string }).text += providerResponse.stopSequence;
          break;
        }
      }
    }

    // Parse XML tool calls from text if no native tool_use blocks were found
    // This handles prefill mode where tools are XML in the text
    let emptyToolBlocks = 0;
    if (toolCalls.length === 0 && rawAssistantText.includes('<function_calls>')) {
      const parsed = parseToolCalls(rawAssistantText);
      if (parsed?.calls.length) {
        for (const tc of parsed.calls) {
          toolCalls.push(tc);
        }
      } else if (parsed) {
        emptyToolBlocks = 1;
      }
    }
    const unclosedToolBlock = endsWithPartialToolBlock(rawAssistantText);

    const stopReason = this.mapStopReason(providerResponse.stopReason);
    this.reportToolParseDiagnostics({ unclosedToolBlock, emptyToolBlocks }, stopReason);
    const durationMs = Date.now() - startTime;
    const usage = {
      inputTokens: providerResponse.usage.inputTokens,
      outputTokens: providerResponse.usage.outputTokens,
    };

    return {
      content,
      rawAssistantText,
      toolCalls,
      toolResults: [], // complete() doesn't execute tools
      stopReason,
      usage,
      details: {
        stop: {
          reason: stopReason,
          triggeredSequence: providerResponse.stopSequence,
          wasTruncated: stopReason === 'max_tokens',
          unclosedToolBlock,
        },
        usage: {
          inputTokens: providerResponse.usage.inputTokens,
          outputTokens: providerResponse.usage.outputTokens,
          cacheCreationTokens: providerResponse.usage.cacheCreationTokens,
          cacheReadTokens: providerResponse.usage.cacheReadTokens,
          estimatedCost: this.estimateCost(providerResponse.usage, request.config.model),
        },
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
      },
      raw: {
        request: rawRequest ?? null,
        response: providerResponse.raw,
      },
    };
  }

  /**
   * The turn is over, and the two guards that detect a half-written tool block
   * finally have a call site. Both shapes are defects a consumer must not
   * persist blind: an unclosed block splices onto the NEXT round's closing tag
   * (the loop does not resume on a length stop, so max_tokens leaves exactly
   * this), and a block that parsed to nothing means the model believes it
   * called a tool that never ran.
   */
  private reportToolParseDiagnostics(
    diagnostics: {
      unclosedToolBlock: boolean;
      emptyToolBlocks: number;
      splicedToolBlocks?: number;
      unclosedInvokeHeads?: number;
    },
    stopReason: StopReason
  ): void {
    const warnLog = this.config.logger ?? console;

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
    usage: DetailedUsage,
    request: NormalizedRequest,
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
    triggeredSequence?: string
  ): NormalizedResponse {
    // Parse accumulated text into structured content blocks
    // This extracts thinking, tool_use, tool_result, and text blocks
    let finalContent: ContentBlock[];
    let toolCalls: ToolCall[];
    let toolResults: ToolResult[];

    let unclosedToolBlock = false;

    if (contentBlocks.length > 0) {
      // Native mode - content blocks already structured
      finalContent = contentBlocks;
      toolCalls = executedToolCalls;
      toolResults = executedToolResults;
    } else {
      // XML mode - parse accumulated text into blocks
      // If we started inside a block (from prefill), pass that context so the parser
      // can correctly handle closing tags without corresponding opening tags
      const parseOptions = startInsideBlock ? { startInsideBlock } : undefined;
      const parsed = parseAccumulatedIntoBlocks(accumulated, parseOptions);
      finalContent = parsed.blocks;
      toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : executedToolCalls;
      toolResults = parsed.toolResults.length > 0 ? parsed.toolResults : executedToolResults;
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
        stop: {
          reason: stopReason,
          triggeredSequence,
          wasTruncated: stopReason === 'max_tokens',
          unclosedToolBlock,
        },
        usage: {
          ...usage,
          estimatedCost: usage.estimatedCost ?? this.estimateCost(usage, request.config.model),
        },
        timing: {
          totalDurationMs: durationMs,
          attempts,
        },
        model: {
          requested: request.config.model,
          actual: request.config.model, // TODO: get from response
          provider: this.adapter.name,
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
   * Fold one discarded (billed but abandoned) attempt's usage into a carry.
   * Returns a NEW object so a caller's earlier snapshot is never mutated.
   */
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
    if (add.cacheCreationTokens) {
      next.cacheCreationTokens = (next.cacheCreationTokens ?? 0) + add.cacheCreationTokens;
    }
    if (add.cacheReadTokens) {
      next.cacheReadTokens = (next.cacheReadTokens ?? 0) + add.cacheReadTokens;
    }
    return next;
  }

  /** One provider call's usage as a single-attempt discard record. */
  private discardedAttemptFrom(usage: DetailedUsage | BasicUsage | undefined): DiscardedAttemptsUsage {
    const detailed = (usage ?? { inputTokens: 0, outputTokens: 0 }) as DetailedUsage;
    return {
      attempts: 1,
      inputTokens: detailed.inputTokens ?? 0,
      outputTokens: detailed.outputTokens ?? 0,
      ...(detailed.cacheCreationTokens ? { cacheCreationTokens: detailed.cacheCreationTokens } : {}),
      ...(detailed.cacheReadTokens ? { cacheReadTokens: detailed.cacheReadTokens } : {}),
    };
  }

  /** Price the discarded spend so a caller can read it without re-deriving. */
  private pricedDiscardedAttempts(
    discarded: DiscardedAttemptsUsage | undefined,
    model: string
  ): DiscardedAttemptsUsage | undefined {
    if (!discarded) return undefined;
    const estimatedCost = this.estimateCost(discarded, model);
    return estimatedCost ? { ...discarded, estimatedCost } : discarded;
  }

  private mapStopReason(providerReason: string): StopReason {
    switch (providerReason) {
      case 'end_turn':
        return 'end_turn';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      case 'tool_use':
        return 'tool_use';
      case 'refusal':
        // Safety refusal (e.g., Fable 5 reasoning_extraction). Must survive
        // mapping — downstream consumers react to refusals (chapterx adds a
        // Discord reaction). Defaulting this to end_turn silently hid them.
        return 'refusal';
      default:
        return 'end_turn';
    }
  }

  private calculateCacheHitRatio(usage: Pick<DetailedUsage, 'inputTokens' | 'cacheReadTokens'>): number {
    const cacheRead = usage.cacheReadTokens ?? 0;
    const total = usage.inputTokens ?? 0;
    if (total === 0) return 0;
    return cacheRead / total;
  }

  private resolvePricing(model: string): import('./types/provider.js').ModelPricing | undefined {
    return this.registry?.getPricing(model) ?? getDefaultPricing(model);
  }

  /** Resolve pricing + calculate cost in one call (for one-shot use outside loops). */
  private estimateCost(usage: import('./utils/cost.js').CostableUsage, model: string): import('./types/response.js').CostBreakdown | undefined {
    const pricing = this.resolvePricing(model);
    return pricing ? calculateCost(usage, pricing) : undefined;
  }

  private calculateRetryDelay(attempt: number, overloaded = false): number {
    const { retryDelayMs, backoffMultiplier, maxRetryDelayMs } = overloaded
      ? this.retryConfig.overloaded
      : this.retryConfig;
    const delay = Math.min(retryDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxRetryDelayMs);
    // Equal jitter on the overloaded schedule only: a capacity storm is
    // exactly the case where a fleet retrying in sync re-creates the
    // stampede it's backing off from. [delay/2, delay) keeps the wait long.
    return overloaded ? Math.floor(delay / 2 + Math.random() * (delay / 2)) : delay;
  }

  private attachRawRequest(error: unknown, rawRequest: unknown): Error {
    const errorInfo = classifyError(error);
    errorInfo.rawRequest = rawRequest;
    return new MembraneError(errorInfo);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  }

  /**
   * Check if an error is an abort error
   */
  private isAbortError(error: unknown): boolean {
    // An adapter's own deadline: a timeout by classification, still an abort
    // by provenance, so the streaming paths hand back the partial content
    // they collected instead of throwing.
    if (isTimeoutAbortError(error)) return true;
    if (error instanceof Error) {
      // Standard AbortError
      if (error.name === 'AbortError') return true;
      // Anthropic SDK abort
      if (error.message.includes('aborted') || error.message.includes('abort')) return true;
    }
    // DOMException for browser environments
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return error.name === 'AbortError';
    }
    return false;
  }

  /**
   * Why a caught abort happened. The caller's own signal is authoritative:
   * if it fired, the cancellation is theirs whatever the error text says.
   * Otherwise an adapter-side deadline classifies as a timeout — the adapters
   * mark the abort createCombinedSignal's timeoutMs raises and map it to a
   * TimeoutAbortError, so the identity survives their error handling — and
   * anything else that reached the abort catch is a failure, not a person.
   */
  private abortReason(error: unknown, signal?: AbortSignal): 'user' | 'timeout' | 'error' {
    if (signal?.aborted) return 'user';
    if (classifyError(error).type === 'timeout') return 'timeout';
    return 'error';
  }

  /**
   * Build an AbortedResponse from current execution state
   */
  private buildAbortedResponse(
    accumulated: string,
    usage: BasicUsage,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    reason: 'user' | 'timeout' | 'error',
    startInsideBlock: 'thinking' | 'tool_call' | 'tool_result' | null = null
  ): AbortedResponse {
    // Parse accumulated text into content blocks for partial content
    // If we started inside a block (from prefill), pass that context
    const parseOptions = startInsideBlock ? { startInsideBlock } : undefined;
    const { blocks } = parseAccumulatedIntoBlocks(accumulated, parseOptions);

    return {
      aborted: true,
      partialContent: blocks.length > 0 ? blocks : undefined,
      partialUsage: usage,
      reason,
      rawAssistantText: accumulated || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    };
  }

  // ============================================================================
  // Yielding Stream API
  // ============================================================================

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
    // YieldingStreamOptions carries no per-request formatter override, so the
    // selection here can only land on the instance formatter — it goes through
    // resolveActiveFormatter anyway so this path reads the same single source
    // as complete() and stream() if an override is ever added.
    const activeFormatter = this.resolveActiveFormatter();
    const toolMode = this.resolveToolMode(request, activeFormatter);

    // refusalRetries is implemented on the native path only. The XML path
    // accumulates into a streaming parser carrying prefill context and
    // resumption depths; rolling that back mid-turn is a separate problem,
    // and a partial implementation would corrupt the turn instead of
    // retrying it. Fail LOUD and OFF rather than silently mis-retrying.
    if (toolMode !== 'native' && (options.refusalRetries ?? 0) > 0) {
      (this.config.logger ?? console).warn(
        '[membrane] refusalRetries is ignored in XML tool mode ' +
        '(native-only for now) — the turn will surface the refusal as before.',
      );
    }

    // Create the yielding stream with the appropriate inference runner
    const runInference = toolMode === 'native'
      ? (stream: YieldingStreamImpl) => this.runNativeToolsYielding(request, options, stream, activeFormatter)
      : (stream: YieldingStreamImpl) => this.runXmlToolsYielding(request, options, stream, activeFormatter);

    return new YieldingStreamImpl(options, runInference);
  }

  /**
   * Run XML-based tool execution with yielding stream.
   */
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
    // Yielding paths default to unlimited (the caller — typically an agent
    // framework — drives the stream and is expected to budget its own work).
    // Omit `maxToolDepth` for unlimited; `-1` is an explicit "unlimited"
    // sentinel for callers that need to write the value out; any other
    // number is taken at face value as the cap.
    const maxToolDepth =
      maxToolDepthOpt === undefined || maxToolDepthOpt === -1
        ? Infinity
        : maxToolDepthOpt;

    // Resumption spin guards (issue #39). This is the path the Ash spin ran
    // on: tool depth here is unlimited BY DESIGN (the caller budgets its own
    // tool work — that contract stands untouched), and the false-positive
    // resumption path counted against that same unlimited bound — 43 rounds
    // × ~172k input tokens of zero progress. Only AUTOMATIC resumptions are
    // guarded: a stall guard (consecutive no-progress resumptions →
    // 'no_progress') and a hard resumption cap ('round_limit'). Tool rounds
    // are never counted. See streamWithXmlTools for the rationale details.
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
    const warnLog = this.config.logger ?? console;

    // Initialize parser from the formatter streamYielding selected, so the
    // parser and the build below read the same format.
    const formatter = activeFormatter;
    const parser = formatter.createStreamParser();
    let toolDepth = 0;
    // Honest turn telemetry: provider calls actually made (including refusal
    // re-issues inside streamOnce) and continuation rounds.
    let providerCalls = 0;
    let rounds = 0;
    // Once-per-stream latch for the injectedMessages-unsupported warning.
    let warnedInjectionUnsupported = false;
    let totalUsage: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
    const pricing = this.resolvePricing(request.config.model);
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    // Native thinking blocks from the provider (with signatures) — merged
    // into the parser-derived content before the final response is emitted.
    // See streamWithXmlTools for the matching non-yielding logic.
    const providerThinkingBlocks: ContentBlock[] = [];

    // Track executed tool calls and results
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

    // Transform initial request using the formatter
    let { providerRequest, prefillResult } = this.transformRequest(request, formatter);

    // Initialize parser with prefill content
    let initialPrefillLength = 0;
    // Watermark for per-round delta text (ToolContext.roundPreamble) — see
    // streamWithXmlTools for rationale. Advanced past each results push.
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

    // Capture parser depths after prefill initialization so we can distinguish
    // blocks inherited from prefill context (e.g., unclosed <thinking> from other bots)
    // from blocks the model itself opened during generation
    const prefillDepths = parser.getDepths();

    /** Count an automatic resumption; emits the visibility warning at the
     *  threshold and returns false when the cap says the turn should end. */
    const registerResumptionRound = (): boolean => {
      resumptionRounds++;
      if (resumptionRounds === RESUMPTION_WARN_ROUNDS) {
        warnLog.warn(
          `[membrane] automatic resumption at round ${resumptionRounds} ` +
          `(${totalUsage.inputTokens} input tokens so far this turn) — ` +
          `a spin shows up here before it shows up on the bill`
        );
      }
      if (resumptionRounds > maxResumptionRounds) {
        warnLog.warn(
          `[membrane] automatic resumption cap (${maxResumptionRounds}) reached — ` +
          `ending turn with stopReason 'round_limit'. ` +
          `${totalUsage.inputTokens} input tokens spent this turn.`
        );
        return false;
      }
      return true;
    };

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {
        // Check for cancellation
        if (stream.isCancelled) {
          const fullAccumulated = parser.getAccumulated();
          const newContent = fullAccumulated.slice(initialPrefillLength);
          stream.emit({
            type: 'aborted',
            reason: 'user',
            partialContent: parseAccumulatedIntoBlocks(newContent).blocks,
            rawAssistantText: newContent,
            toolCalls: executedToolCalls,
            toolResults: executedToolResults,
          });
          return;
        }

        // Track if we manually detected a stop sequence
        let detectedStopSequence: string | null = null;
        let truncatedAccumulated: string | null = null;
        const checkFromIndex = parser.getAccumulated().length;

        // Stream from provider
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (detectedStopSequence || stream.isCancelled) {
                return;
              }

              // Process chunk with enriched streaming API
              const { emissions } = parser.processChunk(chunk);

              // Check for stop sequences only in NEW content
              const accumulated = parser.getAccumulated();
              const newContent = accumulated.slice(checkFromIndex);

              for (const stopSeq of prefillResult.stopSequences) {
                const idx = newContent.indexOf(stopSeq);
                if (idx !== -1) {
                  const absoluteIdx = checkFromIndex + idx;
                  detectedStopSequence = stopSeq;
                  truncatedAccumulated = accumulated.slice(0, absoluteIdx);

                  // Emit only the portion up to stop sequence
                  const alreadyEmitted = accumulated.length - chunk.length;
                  if (emitTokens && absoluteIdx > alreadyEmitted) {
                    const truncatedChunk = accumulated.slice(alreadyEmitted, absoluteIdx);
                    const meta: ChunkMeta = {
                      type: parser.getCurrentBlockType(),
                      visible: parser.getCurrentBlockType() === 'text',
                      blockIndex: 0,
                    };
                    stream.emit({ type: 'tokens', content: truncatedChunk, meta });
                  }
                  return;
                }
              }

              // Emit in correct interleaved order
              for (const emission of emissions) {
                if (emission.kind === 'blockEvent') {
                  if (emitBlocks) {
                    stream.emit({ type: 'block', event: emission.event });
                  }
                } else {
                  if (emitTokens) {
                    stream.emit({ type: 'tokens', content: emission.text, meta: emission.meta });
                  }
                }
              }
            },
            onContentBlock: undefined,
          },
          {
            signal: stream.signal,
            timeoutMs: options.timeoutMs,
            idleTimeoutMs: options.idleTimeoutMs,
            normalizedRequest: request,
            // The tag-based parser tracks thinking via <thinking> tags — ask
            // the provider to wrap native thinking deltas so they don't
            // stream as visible text (same as streamWithXmlTools).
            wrapThinkingTags: true,
            onRequest: (req: unknown) => { rawRequest = req; },
          }
        );

        rounds++;
        providerCalls += streamResult.providerCalls;

        // If we detected stop sequence manually, fix up the parser and result
        if (detectedStopSequence && truncatedAccumulated !== null) {
          parser.reset();
          parser.push(truncatedAccumulated);
          streamResult.stopReason = 'stop_sequence';
          streamResult.stopSequence = detectedStopSequence;
        }

        // Capture native thinking blocks (with signatures) from the provider
        // response — the text parser can't see signatures, so they're merged
        // into the final response content after parsing.
        this.captureProviderThinkingBlocks(streamResult.content, providerThinkingBlocks);

        rawResponse = streamResult.raw;
        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastStopSequence = streamResult.stopSequence ?? undefined;

        // Accumulate usage (including cache metrics)
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
        if (streamResult.usage.cacheCreationTokens) {
          totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + streamResult.usage.cacheCreationTokens;
        }
        if (streamResult.usage.cacheReadTokens) {
          totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + streamResult.usage.cacheReadTokens;
        }
        if (pricing) totalUsage.estimatedCost = calculateCost(totalUsage, pricing);
        if (emitUsage) {
          stream.emit({ type: 'usage', usage: { ...totalUsage } });
        }

        // Flush the parser
        const flushResult = parser.flush();
        for (const emission of flushResult.emissions) {
          if (emission.kind === 'blockEvent' && emitBlocks) {
            stream.emit({ type: 'block', event: emission.event });
          }
        }

        // Stall accounting (issue #39): only rounds ENTERED via automatic
        // resumption can stall; the turn ends only after several consecutive
        // stalls. Tool rounds are never counted. Mirrors streamWithXmlTools —
        // see the detailed rationale there.
        const streamedThisRound = parser.getAccumulated().length - checkFromIndex;
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
              `stopReason 'no_progress'. ${totalUsage.inputTokens} input tokens spent this turn.`
            );
            lastStopReason = 'no_progress';
            break;
          }
        } else {
          consecutiveStalledResumptions = 0;
        }
        prevRoundStopSequence = lastStopSequence;
        enteredViaResumption = false;

        // Check for tool calls
        if (streamResult.stopSequence === '</function_calls>') {
          const closeTag = '</function_calls>';
          parser.push(closeTag);

          const parsed = parseToolCalls(parser.getAccumulated());

          if (parsed && parsed.calls.length > 0) {
            // Emit block events for each tool call
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

            // Track the tool calls
            executedToolCalls.push(...parsed.calls);

            // Build tool context.
            // preamble/accumulated must expose the MODEL'S text only: the
            // parser was seeded with the entire assistant prefill (the whole
            // flattened document in XML mode), so parsed.beforeText starts
            // with it. Consumers persist the preamble as "what the agent said
            // this round" — unsliced, a turn that dies mid-rounds flushes the
            // full document back into the agent's store as its own message
            // (observed on Ash 2026-07-26: ~720k-char document echo persisted
            // as 62 sharded assistant messages, doubling her store and
            // wedging every subsequent compile). The turn-END path already
            // slices (newContent = fullAccumulated.slice(initialPrefillLength));
            // the tool-round path must match it.
            const context: ToolContext = {
              rawText: parsed.fullMatch,
              preamble: parsed.beforeText.slice(initialPrefillLength),
              roundPreamble: parsed.beforeText.slice(roundStartLen),
              depth: toolDepth,
              previousResults: executedToolResults,
              accumulated: parser.getAccumulated().slice(initialPrefillLength),
            };

            // Yield control for tool execution
            const toolCallsEvent: ToolCallsEvent = {
              type: 'tool-calls',
              calls: parsed.calls,
              context,
            };

            const { results, injectedMessages } = await stream.requestToolExecution(toolCallsEvent);

            // Backfill tool names for the legacy XML result rendering
            // (<result><tool_name>…</tool_name><stdout>…) when the executor
            // didn't supply them.
            const yieldCallNames = new Map(parsed.calls.map((c) => [c.id, c.name]));
            for (const r of results) {
              if (!r.toolName) r.toolName = yieldCallNames.get(r.toolUseId);
            }

            // Mid-turn injected messages are not supported on the XML prefill
            // path: the continuation is an assistant prefill over an XML
            // transcript, not a message array, so there is no user envelope
            // to append to. Warn (once per stream — long turns have many
            // rounds) rather than drop silently; the messages remain in the
            // caller's context window and reach the model on the next turn.
            if (injectedMessages && injectedMessages.length > 0 && !warnedInjectionUnsupported) {
              warnedInjectionUnsupported = true;
              console.warn(
                `[membrane] provideToolResults injectedMessages ignored: XML tool mode ` +
                `does not support mid-turn injection (delivered next turn instead)`
              );
            }

            // Track the tool results
            executedToolResults.push(...results);

            // Check if results contain images
            if (hasImageInToolResults(results)) {
              const splitContent = formatToolResultsForSplitTurn(results);

              // Emit block events for tool results
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

              // Emit tool result content
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
              // Standard path: no images
              const resultsXml = formatToolResults(results);

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

            // Next round's model text starts after everything injected this
            // round (results XML, image-split tags, thinking opener).
            roundStartLen = parser.getAccumulated().length;

            // Tool rounds are the caller's work — they count against
            // maxToolDepth only, never against the resumption guards
            // (issue #39 review: the uncapped tool-loop contract stands).
            parser.resetForNewIteration();
            toolDepth++;
            continue;
          }
        }

        // Check for false-positive stop (unclosed block)
        // Use depth delta vs prefill baseline — see streamWithXmlTools for detailed comment
        const currentDepths = parser.getDepths();
        const modelOpenedNewBlock =
          currentDepths.functionCalls > prefillDepths.functionCalls ||
          currentDepths.functionResults > prefillDepths.functionResults ||
          currentDepths.thinking > prefillDepths.thinking;

        if (lastStopReason === 'stop_sequence' && modelOpenedNewBlock) {
          if (streamResult.stopSequence) {
            parser.push(streamResult.stopSequence);
            if (emitTokens) {
              const meta: ChunkMeta = {
                type: parser.getCurrentBlockType(),
                visible: parser.getCurrentBlockType() === 'text',
                blockIndex: 0,
              };
              stream.emit({ type: 'tokens', content: streamResult.stopSequence, meta });
            }
          }

          toolDepth++;
          if (toolDepth > maxToolDepth) {
            break;
          }
          if (!registerResumptionRound()) {
            lastStopReason = 'round_limit';
            break;
          }
          enteredViaResumption = true;
          prefillResult.assistantPrefill = parser.getAccumulated();
          providerRequest = this.buildContinuationRequest(
            request,
            prefillResult,
            parser.getAccumulated()
          );
          parser.resetForNewIteration();
          continue;
        }

        // No more tools, we're done
        break;
      }

      // Build final response
      const fullAccumulated = parser.getAccumulated();
      const newContent = fullAccumulated.slice(initialPrefillLength);

      const response = this.buildFinalResponse(
        newContent,
        contentBlocks,
        lastStopReason,
        totalUsage,
        request,
        prefillResult,
        startTime,
        providerCalls,
        rawRequest,
        rawResponse,
        executedToolCalls,
        executedToolResults,
        initialBlockType,
        lastStopSequence
      );

      // Merge provider thinking signatures into parser-derived thinking blocks
      this.mergeProviderThinkingBlocks(response.content, providerThinkingBlocks);

      response.details.timing.rounds = rounds;

      stream.emit({ type: 'complete', response });
    } catch (error) {
      if (this.isAbortError(error)) {
        const fullAccumulated = parser.getAccumulated();
        const newContent = fullAccumulated.slice(initialPrefillLength);
        stream.emit({
          type: 'aborted',
          reason: this.abortReason(error, stream.signal),
          partialContent: parseAccumulatedIntoBlocks(newContent).blocks,
          rawAssistantText: newContent,
          toolCalls: executedToolCalls,
          toolResults: executedToolResults,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Run native tool execution with yielding stream.
   */
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
    // Yielding paths default to unlimited (the caller — typically an agent
    // framework — drives the stream and is expected to budget its own work).
    // Omit `maxToolDepth` for unlimited; `-1` is an explicit "unlimited"
    // sentinel for callers that need to write the value out; any other
    // number is taken at face value as the cap.
    const maxToolDepth =
      maxToolDepthOpt === undefined || maxToolDepthOpt === -1
        ? Infinity
        : maxToolDepthOpt;

    let toolDepth = 0;
    // Honest turn telemetry: provider calls actually made (including refusal
    // re-issues inside streamOnce) and continuation rounds.
    let providerCalls = 0;
    let rounds = 0;
    let totalUsage: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
    const pricing = this.resolvePricing(request.config.model);
    let lastStopReason: StopReason = 'end_turn';
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    let allTextAccumulated = '';
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];
    // Spend on refusal attempts this turn threw away (see streamOnce).
    let discardedUsage: DiscardedAttemptsUsage | undefined;

    let messages = [...request.messages];
    let allContentBlocks: ContentBlock[] = [];
    let markersInLastRequest = 0;

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {
        // Check for cancellation
        if (stream.isCancelled) {
          stream.emit({
            type: 'aborted',
            reason: 'user',
            rawAssistantText: allTextAccumulated,
            toolCalls: executedToolCalls,
            toolResults: executedToolResults,
          });
          return;
        }

        // Build provider request with native tools
        const providerRequest = this.buildNativeToolRequest(request, messages, toolDepth > 0, activeFormatter);

        // Stream from provider
        let textAccumulated = '';
        // Where this attempt starts inside the tool-loop-spanning buffer, so
        // a refusal retry can roll back exactly this attempt's contribution.
        const allTextBefore = allTextAccumulated.length;
        // Track block-type from the provider's content_block signals so
        // every token chunk is tagged with the membrane block it belongs to.
        // Without this, thinking_delta chunks get mislabelled as 'text' and
        // downstream consumers (TUIs, WebUIs) can't render them distinctly.
        const tracker = new NativeBlockTracker(
          emitBlocks ? (event) => stream.emit({ type: 'block', event }) : undefined,
        );
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (stream.isCancelled) return;

              textAccumulated += chunk;
              allTextAccumulated += chunk;

              if (emitTokens) {
                const meta: ChunkMeta = {
                  type: tracker.currentType,
                  visible: tracker.currentType === 'text',
                  blockIndex: tracker.blockIndex,
                };
                stream.emit({ type: 'tokens', content: chunk, meta });
              }
            },
            onContentBlock: (index, block) => {
              if (stream.isCancelled) return;
              tracker.onProviderBlock(index, block);
            },
          },
          {
            signal: stream.signal,
            timeoutMs: options.timeoutMs,
            idleTimeoutMs: options.idleTimeoutMs,
            normalizedRequest: request,
            onRequest: (req: unknown) => { rawRequest = req; },
            // Telemetry reports what this request actually SHIPPED with —
            // builder breakpoints, stale passthrough, fallback, float, plus
            // whatever the beforeRequest hook and the wire clamp did after
            // the build. Both native paths used to hardcode 0, and counting
            // at build time reported a number no request ever had.
            onWireCacheMarkers: (markerCount: number) => {
              markersInLastRequest = markerCount;
            },
            refusalRetries: options.refusalRetries,
            // Discard the refused attempt: roll the accumulators back to
            // where this attempt began and tell the consumer to drop what it
            // already received. `allTextAccumulated` spans the whole tool
            // loop, so it is truncated rather than cleared.
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

        // Single-callback adapters (OpenAI Responses) report each finalised
        // block once, after the stream: complete whatever never saw a stop.
        tracker.flush();
        rounds++;
        providerCalls += streamResult.providerCalls;

        rawResponse = streamResult.raw;
        lastStopReason = this.mapStopReason(streamResult.stopReason);
        lastStopSequence = streamResult.stopSequence ?? undefined;

        // Attempts this round re-issued past a refusal are billed calls whose
        // output was discarded — carry their spend to the final response.
        discardedUsage = this.mergeDiscardedAttempts(discardedUsage, streamResult.discardedUsage);

        // Accumulate usage (including cache metrics)
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
        if (streamResult.usage.cacheCreationTokens) {
          totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + streamResult.usage.cacheCreationTokens;
        }
        if (streamResult.usage.cacheReadTokens) {
          totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + streamResult.usage.cacheReadTokens;
        }
        if (pricing) totalUsage.estimatedCost = calculateCost(totalUsage, pricing);
        if (emitUsage) {
          stream.emit({ type: 'usage', usage: { ...totalUsage } });
        }

        // Parse content blocks from response
        const responseBlocks = this.parseProviderContent(streamResult.content);
        allContentBlocks.push(...responseBlocks);

        // Check for tool_use blocks
        const toolUseBlocks = responseBlocks.filter(
          (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use'
        );

        if (toolUseBlocks.length > 0 && lastStopReason === 'tool_use') {
          // Convert to normalized ToolCall[]
          const toolCalls: ToolCall[] = toolUseBlocks.map(block => ({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          }));

          // Track tool calls
          executedToolCalls.push(...toolCalls);

          // Build tool context
          const context: ToolContext = {
            rawText: JSON.stringify(toolUseBlocks),
            preamble: textAccumulated,
            depth: toolDepth,
            previousResults: executedToolResults,
            accumulated: allTextAccumulated,
            // Full normalized blocks for this round, in provider order —
            // lets consumers persist the assistant turn verbatim (signed
            // thinking must precede tool_use in the same turn).
            roundContent: responseBlocks,
          };

          // Yield control for tool execution
          const toolCallsEvent: ToolCallsEvent = {
            type: 'tool-calls',
            calls: toolCalls,
            context,
          };

          const { results, injectedMessages } = await stream.requestToolExecution(toolCallsEvent);

          // Track tool results
          executedToolResults.push(...results);

          // Add tool results to content blocks
          for (const result of results) {
            allContentBlocks.push({
              type: 'tool_result',
              toolUseId: result.toolUseId,
              content: result.content,
              isError: result.isError,
            });
          }

          // Add messages for next iteration — use the request's participant names
          const assistantName = request.assistantParticipant
            ?? this.config.assistantParticipant ?? 'Claude';
          const userName = assistantName === 'Claude' ? 'User' : 'user';
          messages.push({
            participant: assistantName,
            content: responseBlocks,
          });

          messages.push({
            participant: userName,
            content: results.map(r => ({
              type: 'tool_result' as const,
              toolUseId: r.toolUseId,
              content: r.content,
              isError: r.isError,
            })),
          });

          // Mid-turn injection: messages that arrived while this round's
          // tools were executing, appended AFTER the tool_result envelope so
          // the next inference round sees them. Placed here (not co-mingled
          // with the results) so provider conversions that special-case
          // tool_result envelopes (e.g. ChatCompletions role:'tool') carry
          // them as ordinary user messages. Signed-thinking adjacency is
          // unaffected: the assistant turn above is round-tripped verbatim.
          if (injectedMessages) {
            for (const injected of injectedMessages) {
              messages.push({
                participant: injected.participant ?? userName,
                content: injected.content,
                ...(injected.metadata ? { metadata: injected.metadata } : {}),
              });
            }
          }

          toolDepth++;
          continue;
        }

        // No more tools, we're done
        break;
      }

      const durationMs = Date.now() - startTime;

      const response: NormalizedResponse = {
        content: allContentBlocks,
        rawAssistantText: allTextAccumulated,
        toolCalls: executedToolCalls,
        toolResults: executedToolResults,
        stopReason: lastStopReason,
        usage: totalUsage,
        details: {
          stop: {
            reason: lastStopReason,
            triggeredSequence: lastStopSequence,
            wasTruncated: lastStopReason === 'max_tokens',
          },
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
          },
          model: {
            requested: request.config.model,
            actual: request.config.model,
            provider: this.adapter.name,
          },
          cache: {
            markersInRequest: markersInLastRequest,
            tokensCreated: totalUsage.cacheCreationTokens ?? 0,
            tokensRead: totalUsage.cacheReadTokens ?? 0,
            hitRatio: this.calculateCacheHitRatio(totalUsage),
          },
        },
        raw: {
          request: rawRequest,
          response: rawResponse,
        },
      };

      stream.emit({ type: 'complete', response });
    } catch (error) {
      if (this.isAbortError(error)) {
        stream.emit({
          type: 'aborted',
          reason: this.abortReason(error, stream.signal),
          rawAssistantText: allTextAccumulated,
          toolCalls: executedToolCalls,
          toolResults: executedToolResults,
        });
      } else {
        throw error;
      }
    }
  }
}

// Native tool names must match ^[a-zA-Z0-9_-]{1,128}$.
// Tool names use `--` namespacing, which is already API-valid; the only
// character that ever needs escaping is a literal colon, encoded losslessly as
// `__` and back. We deliberately do NOT escape underscores — they are valid,
// and escaping them (the previous `_u`/`_c` scheme) garbled every
// underscore-containing tool name in the request the model actually sees
// (`send_message` → `send_umessage`), polluting its reasoning for no benefit.
function sanitizeToolName(name: string): string {
  return name.replace(/:/g, '__');
}

function unsanitizeToolName(name: string): string {
  return name.replace(/__/g, ':');
}
