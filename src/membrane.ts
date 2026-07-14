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
  StopReason,
  TimingInfo,
  CacheInfo,
  ToolCall,
  ToolResult,
  ToolContext,
  RetryConfig,
  ToolMode,
  ToolDefinition,
} from './types/index.js';
import {
  DEFAULT_RETRY_CONFIG,
  MembraneError,
  classifyError,
  isTextContent,
  isAbortedResponse,
} from './types/index.js';
import type { BuildResult } from './formatters/types.js';
import {
  parseToolCalls,
  formatToolResults,
  parseAccumulatedIntoBlocks,
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
import { normalizeToolPairs, mergeConsecutiveRoles } from './formatters/normalize-tool-pairs.js';
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
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };
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

    while (true) {
      attempts++;

      try {
        const { providerRequest, prefillResult } = this.transformRequest(request, options.formatter);

        // Route through the single canonical hook helper so any future
        // change to hook semantics (logging, retry interaction, error
        // handling) applies to both complete() and the streaming paths.
        // Cast back to the local provider-request shape: the hook returns
        // `unknown` deliberately, and we acknowledge the cast at the boundary.
        const finalRequest = (await this.applyBeforeRequestHook(request, providerRequest)) as typeof providerRequest;

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

        // Call afterResponse hook
        if (this.config.hooks?.afterResponse) {
          return await this.config.hooks.afterResponse(response, providerResponse.raw);
        }

        return response;

      } catch (error) {
        const errorInfo = classifyError(error);
        errorInfo.rawRequest = rawRequest;

        // Rate limits (429) always retry up to 5 attempts regardless of config.
        // Other retryable errors only retry when maxRetries > 0.
        const isRateLimit = errorInfo.type === 'rate_limit';
        const effectiveMax = isRateLimit
          ? Math.max(this.retryConfig.maxRetries, 5)
          : this.retryConfig.maxRetries;

        if (errorInfo.retryable && attempts < effectiveMax) {
          // Check hook for retry decision
          if (this.config.hooks?.onError) {
            const decision = await this.config.hooks.onError(errorInfo, attempts);
            if (decision === 'abort') {
              throw new MembraneError(errorInfo);
            }
          }

          // Wait before retry (abort-aware)
          const delay = this.calculateRetryDelay(attempts);
          await this.sleep(delay, options.signal);
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

    // Determine tool mode
    const toolMode = this.resolveToolMode(request);

    if (toolMode === 'native' && request.tools && request.tools.length > 0) {
      return this.streamWithNativeTools(request, options);
    } else {
      return this.streamWithXmlTools(request, options);
    }
  }

  /**
   * Determine the effective tool mode
   */
  private resolveToolMode(request: NormalizedRequest): ToolMode {
    // Explicit mode takes precedence
    if (request.toolMode && request.toolMode !== 'auto') {
      return request.toolMode;
    }

    // Auto mode: choose based on formatter
    // NativeFormatter → native tools via API
    // AnthropicXmlFormatter (default) → XML tools in prefill
    if (this.formatter.name === 'native' || this.formatter.name === 'openai-responses') {
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
    options: StreamOptions
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
      formatter: requestFormatter,
    } = options;

    // Use per-request formatter if provided, otherwise use instance formatter
    const formatter = requestFormatter ?? this.formatter;

    // Initialize parser from formatter for format-specific tracking
    const parser = formatter.createStreamParser();
    let toolDepth = 0;
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
    let initialBlockType: 'thinking' | 'tool_call' | 'tool_result' | null = null;
    if (prefillResult.assistantPrefill) {
      parser.push(prefillResult.assistantPrefill);
      initialPrefillLength = prefillResult.assistantPrefill.length;
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

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {

        // Track if we manually detected a stop sequence (API doesn't always stop)
        let detectedStopSequence: string | null = null;
        let truncatedAccumulated: string | null = null;

        // Track where to start checking for stop sequences (skip already-processed content)
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

        // Check for tool calls (if handler provided)
        if (onToolCalls && streamResult.stopSequence === '</function_calls>') {
          // Append the closing tag (we truncated before it, or API stopped before it)
          const closeTag = '</function_calls>';
          parser.push(closeTag);
          // Note: closing tag is structural XML, not emitted via onChunk (invisible)

          const parsed = parseToolCalls(parser.getAccumulated());

          if (parsed && parsed.calls.length > 0) {
            // Notify about pre-tool content
            if (onPreToolContent && parsed.beforeText.trim()) {
              await onPreToolContent(parsed.beforeText);
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

            // Execute tools
            const context: ToolContext = {
              rawText: parsed.fullMatch,
              preamble: parsed.beforeText,
              depth: toolDepth,
              previousResults: executedToolResults,
              accumulated: parser.getAccumulated(),
            };

            const results = await onToolCalls(parsed.calls, context);
            if (!Array.isArray(results)) {
              throw new Error(
                `onToolCalls must return an array of ToolResult, got ${typeof results}`
              );
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

            // Reset parser state for new streaming iteration
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
        1, // attempts
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
          'user',
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
    options: StreamOptions
  ): Promise<NormalizedResponse | AbortedResponse> {
    const startTime = Date.now();
    const {
      onChunk,
      onContentBlockUpdate,
      onToolCalls,
      onPreToolContent,
      onUsage,
      onRequest,
      onResponse,
      maxToolDepth = 10,
      signal,
    } = options;

    let toolDepth = 0;
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

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {
        // Build provider request with native tools
        const providerRequest = this.buildNativeToolRequest(request, messages);

        // Stream from provider
        let textAccumulated = '';
        let blockIndex = 0;
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              textAccumulated += chunk;
              allTextAccumulated += chunk;
              // For native mode, emit text chunks with basic metadata
              // TODO: Use native API content_block events for richer metadata
              const meta: ChunkMeta = {
                type: 'text',
                visible: true,
                blockIndex,
              };
              onChunk?.(chunk, meta);
            },
            onContentBlock: onContentBlockUpdate
              ? (index: number, block: unknown) => onContentBlockUpdate(index, block as ContentBlock)
              : undefined,
          },
          {
            signal,
            normalizedRequest: request,
            onRequest: (req) => {
              rawRequest = req;
              onRequest?.(req);
            },
          }
        );

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
            attempts: 1,
          },
          model: {
            requested: request.config.model,
            actual: request.config.model,
            provider: this.adapter.name,
          },
          cache: {
            markersInRequest: 0,
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
          'user'
        );
      }
      // Re-throw with rawRequest attached for logging
      throw this.attachRawRequest(error, rawRequest);
    }
  }

  /**
   * Build a provider request with native tool support
   */
  private buildNativeToolRequest(
    request: NormalizedRequest,
    messages: typeof request.messages
  ): any {
    // Provider-native formatters own their complete input-item shape. The
    // legacy implementation below is intentionally Anthropic-specific; using
    // it for Responses would normalize away item IDs, encrypted reasoning,
    // assistant phases, and compaction items.
    if (this.formatter.name === 'openai-responses') {
      return this.transformRequest({ ...request, messages }, this.formatter).providerRequest;
    }

    // Convert messages to provider format
    const providerMessages: any[] = [];
    
    const assistantName = request.assistantParticipant
      ?? this.config.assistantParticipant ?? 'Claude';

    const promptCaching = request.promptCaching ?? true;
    const cacheControl = promptCaching ? { type: 'ephemeral' as const, ...(request.cacheTtl ? { ttl: request.cacheTtl } : {}) } : undefined;

    // Anthropic allows at most 4 cache_control breakpoints per request. The
    // message breakpoints are the valuable ones (they cache the longest prefixes,
    // and every one already includes tools+system at the front of the request).
    // So tools/system get a breakpoint only as a FALLBACK — when no message
    // breakpoint was marked — otherwise they're redundant and would push the
    // total past 4, which the API hard-rejects (the agent goes unresponsive).
    let messageBreakpoints = 0;

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

      // Apply cache_control to last block of messages with cacheBreakpoint
      if (msg.cacheBreakpoint && cacheControl && content.length > 0) {
        content[content.length - 1].cache_control = cacheControl;
        messageBreakpoints++;
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
    const normalized = normalizeToolPairs(providerMessages);
    const mergedMessages = mergeConsecutiveRoles(normalized.messages);

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
      if (cacheControl && messageBreakpoints === 0 && request.tools && idx === request.tools.length - 1) {
        t.cache_control = cacheControl;
      }
      return t;
    });

    // Wrap system prompt with cache_control only as a fallback (no message
    // breakpoint marked); otherwise a message breakpoint already caches
    // tools+system as part of its prefix.
    let system: unknown = request.system;
    if (cacheControl && messageBreakpoints === 0 && typeof system === 'string' && system.length > 0) {
      system = [{ type: 'text', text: system, cache_control: cacheControl }];
    } else if (cacheControl && messageBreakpoints === 0 && Array.isArray(system) && system.length > 0) {
      const blocks = system as Record<string, unknown>[];
      system = blocks.map((block, idx) =>
        idx === blocks.length - 1 ? { ...block, cache_control: cacheControl } : block
      );
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
   * (matched in stream order), and prepend any leftover provider blocks —
   * signature-only thinking (display:'omitted') never appears in the text
   * stream, so the parser produces no block for it. redacted_thinking
   * blocks are always prepended verbatim.
   *
   * Mutates `content` in place. Shared by the XML stream paths
   * (streamWithXmlTools and runXmlToolsYielding).
   */
  private mergeProviderThinkingBlocks(
    content: ContentBlock[],
    providerThinkingBlocks: ContentBlock[]
  ): void {
    if (providerThinkingBlocks.length === 0) return;

    const parsedThinking = content.filter(
      (b) => b.type === 'thinking'
    ) as Array<{ type: 'thinking'; thinking: string; signature?: string }>;

    const providerThinking = providerThinkingBlocks.filter((b) => b.type === 'thinking');
    const redacted = providerThinkingBlocks.filter((b) => b.type === 'redacted_thinking');

    const matched = Math.min(providerThinking.length, parsedThinking.length);
    for (let i = 0; i < matched; i++) {
      const sig = (providerThinking[i] as { signature?: string }).signature;
      if (sig) {
        parsedThinking[i]!.signature = sig;
      }
    }

    const leftover = providerThinking.slice(matched);
    if (leftover.length > 0 || redacted.length > 0) {
      content.unshift(...leftover, ...redacted);
    }
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
   * Transform a normalized request into provider format using the formatter
   */
  private transformRequest(request: NormalizedRequest, formatter?: PrefillFormatter): {
    providerRequest: any;
    prefillResult: BuildResult;
  } {
    // The Responses adapter's input is a provider-native item array. A generic
    // per-request formatter (for example Context Manager's NativeFormatter)
    // produces Anthropic-style `{ role, content: [{ type: 'text' }] }`
    // envelopes, which the Responses API rejects before inference. Keep the
    // configured Responses formatter authoritative at this transport boundary;
    // per-request formatter overrides remain available for adapters whose wire
    // format supports them.
    const activeFormatter =
      this.adapter.name === 'openai-responses-api' && this.formatter.name === 'openai-responses'
        ? this.formatter
        : formatter ?? this.formatter;

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
      thinking: request.config.thinking,
      systemPrompt: request.system,
      promptCaching: request.promptCaching ?? true, // Default true for backward compat
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
      system: buildResult.systemContent,
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
    if (buildResult.assistantPrefill && providerRequest.thinking) {
      delete providerRequest.thinking;
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
    }
  ) {
    // Strip `normalizedRequest` before forwarding to the adapter — it's
    // not part of `ProviderRequestOptions` and TypeScript's structural
    // compatibility won't catch the excess field (checked only on object
    // literals, not on variables). Leaving it in would silently leak the
    // normalized form into every adapter's options.
    const { normalizedRequest, ...adapterOptions } = options;
    const finalRequest = (await this.applyBeforeRequestHook(normalizedRequest, request)) as typeof request;
    return await this.adapter.stream(finalRequest, callbacks, adapterOptions);
  }

  private buildContinuationRequest(
    originalRequest: NormalizedRequest,
    prefillResult: BuildResult,
    accumulated: string
  ): any {
    // Anthropic quirk: assistant content cannot end with trailing whitespace
    const trimmedAccumulated = accumulated.trimEnd();
    
    // Build continuation messages: keep all messages up to last assistant,
    // then replace/add the accumulated content
    const messages = [...prefillResult.messages];
    
    // Find and update the last assistant message, or add one
    let foundAssistant = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        messages[i] = { role: 'assistant', content: trimmedAccumulated };
        foundAssistant = true;
        break;
      }
    }
    
    if (!foundAssistant) {
      messages.push({ role: 'assistant', content: trimmedAccumulated });
    }
    
    return {
      ...this.getBaseProviderParams(originalRequest.config),
      // Continuations always end in an assistant prefill — the API rejects
      // extended thinking combined with prefill, so never send the param here
      thinking: undefined,
      messages,
      system: prefillResult.systemContent
        ? (Array.isArray(prefillResult.systemContent) && prefillResult.systemContent.length > 0
          ? prefillResult.systemContent
          : prefillResult.systemContent)
        : undefined,
      stopSequences: prefillResult.stopSequences,
      extra: {
        ...originalRequest.providerParams,
        // Pre-serialized prompt for completions adapters — skip re-serialization
        prompt: trimmedAccumulated,
      },
    };
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
      { role: 'assistant', content: trimmedAccumulated },
      { role: 'user', content: images },
      { role: 'assistant', content: trimmedAfterXml },
    ];

    if (insertIdx < messages.length) {
      messages.splice(insertIdx, 1, ...splitTurnMessages);
    } else {
      messages.push(...splitTurnMessages);
    }

    return {
      ...this.getBaseProviderParams(originalRequest.config),
      // Continuations always end in an assistant prefill — the API rejects
      // extended thinking combined with prefill, so never send the param here
      thinking: undefined,
      messages,
      system: prefillResult.systemContent
        ? (Array.isArray(prefillResult.systemContent) && prefillResult.systemContent.length > 0
          ? prefillResult.systemContent
          : prefillResult.systemContent)
        : undefined,
      stopSequences: prefillResult.stopSequences,
      extra: originalRequest.providerParams,
    };
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
    if (toolCalls.length === 0 && rawAssistantText.includes('<function_calls>')) {
      const parsed = parseToolCalls(rawAssistantText);
      if (parsed?.calls.length) {
        for (const tc of parsed.calls) {
          toolCalls.push(tc);
        }
      }
    }

    const stopReason = this.mapStopReason(providerResponse.stopReason);
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

  private calculateRetryDelay(attempt: number): number {
    const { retryDelayMs, backoffMultiplier, maxRetryDelayMs } = this.retryConfig;
    const delay = retryDelayMs * Math.pow(backoffMultiplier, attempt - 1);
    return Math.min(delay, maxRetryDelayMs);
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
    const toolMode = this.resolveToolMode(request);

    // Create the yielding stream with the appropriate inference runner
    const runInference = toolMode === 'native'
      ? (stream: YieldingStreamImpl) => this.runNativeToolsYielding(request, options, stream)
      : (stream: YieldingStreamImpl) => this.runXmlToolsYielding(request, options, stream);

    return new YieldingStreamImpl(options, runInference);
  }

  /**
   * Run XML-based tool execution with yielding stream.
   */
  private async runXmlToolsYielding(
    request: NormalizedRequest,
    options: YieldingStreamOptions,
    stream: YieldingStreamImpl
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

    // Initialize parser from formatter for format-specific tracking
    const formatter = this.formatter;
    const parser = formatter.createStreamParser();
    let toolDepth = 0;
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
    let initialBlockType: 'thinking' | 'tool_call' | 'tool_result' | null = null;
    if (prefillResult.assistantPrefill) {
      parser.push(prefillResult.assistantPrefill);
      initialPrefillLength = prefillResult.assistantPrefill.length;
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

            // Build tool context
            const context: ToolContext = {
              rawText: parsed.fullMatch,
              preamble: parsed.beforeText,
              depth: toolDepth,
              previousResults: executedToolResults,
              accumulated: parser.getAccumulated(),
            };

            // Yield control for tool execution
            const toolCallsEvent: ToolCallsEvent = {
              type: 'tool-calls',
              calls: parsed.calls,
              context,
            };

            const results = await stream.requestToolExecution(toolCallsEvent);

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
        1,
        rawRequest,
        rawResponse,
        executedToolCalls,
        executedToolResults,
        initialBlockType,
        lastStopSequence
      );

      // Merge provider thinking signatures into parser-derived thinking blocks
      this.mergeProviderThinkingBlocks(response.content, providerThinkingBlocks);

      stream.emit({ type: 'complete', response });
    } catch (error) {
      if (this.isAbortError(error)) {
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
    stream: YieldingStreamImpl
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
    let totalUsage: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
    const pricing = this.resolvePricing(request.config.model);
    let lastStopReason: StopReason = 'end_turn';
    let lastStopSequence: string | undefined;
    let rawRequest: unknown;
    let rawResponse: unknown;

    let allTextAccumulated = '';
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

    let messages = [...request.messages];
    let allContentBlocks: ContentBlock[] = [];

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
        const providerRequest = this.buildNativeToolRequest(request, messages);

        // Stream from provider
        let textAccumulated = '';
        let blockIndex = 0;
        // Track block-type from the provider's content_block_start signal so
        // every token chunk is tagged with the membrane block it belongs to.
        // Without this, thinking_delta chunks get mislabelled as 'text' and
        // downstream consumers (TUIs, WebUIs) can't render them distinctly.
        let currentBlockType: MembraneBlockType = 'text';
        const seenBlockIndices = new Set<number>();
        const mapApiBlockType = (apiType: string | undefined): MembraneBlockType => {
          if (apiType === 'thinking') return 'thinking';
          if (apiType === 'tool_use') return 'tool_call';
          return 'text';
        };
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (stream.isCancelled) return;

              textAccumulated += chunk;
              allTextAccumulated += chunk;

              if (emitTokens) {
                const meta: ChunkMeta = {
                  type: currentBlockType,
                  visible: currentBlockType === 'text',
                  blockIndex,
                };
                stream.emit({ type: 'tokens', content: chunk, meta });
              }
            },
            onContentBlock: (index, block) => {
              if (stream.isCancelled) return;
              const apiType = (block as { type?: string } | undefined)?.type;
              const mbType = mapApiBlockType(apiType);
              const isStart = !seenBlockIndices.has(index);
              if (isStart) {
                seenBlockIndices.add(index);
                currentBlockType = mbType;
                blockIndex = index;
                if (emitBlocks) {
                  stream.emit({
                    type: 'block',
                    event: { event: 'block_start', index, block: { type: mbType } },
                  });
                }
              } else if (emitBlocks) {
                // Second call for the same index = content_block_stop. The
                // provider has filled the block with final content; surface
                // a block_complete with the relevant fields for consumers
                // that want full block payloads (e.g. context-manager).
                const apiBlock = block as {
                  type?: string;
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
                stream.emit({
                  type: 'block',
                  event: { event: 'block_complete', index, block: mb },
                });
              }
            },
          },
          {
            signal: stream.signal,
            timeoutMs: options.timeoutMs,
            idleTimeoutMs: options.idleTimeoutMs,
            normalizedRequest: request,
            onRequest: (req: unknown) => { rawRequest = req; },
          }
        );

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

          const results = await stream.requestToolExecution(toolCallsEvent);

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
          messages.push({
            participant: assistantName,
            content: responseBlocks,
          });

          messages.push({
            participant: assistantName === 'Claude' ? 'User' : 'user',
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
          usage: { ...totalUsage },
          timing: {
            totalDurationMs: durationMs,
            attempts: 1,
          },
          model: {
            requested: request.config.model,
            actual: request.config.model,
            provider: this.adapter.name,
          },
          cache: {
            markersInRequest: 0,
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
          reason: 'user',
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
