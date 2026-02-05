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
import type { ChunkMeta, BlockEvent } from './types/streaming.js';
import type {
  YieldingStream,
  YieldingStreamOptions,
  StreamEvent,
  ToolCallsEvent,
} from './types/yielding-stream.js';
import type { PrefillFormatter, StreamParser } from './formatters/types.js';
import { AnthropicXmlFormatter } from './formatters/anthropic-xml.js';
import { YieldingStreamImpl } from './yielding-stream.js';

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
        const { providerRequest, prefillResult } = this.transformRequest(request);

        // Call beforeRequest hook
        let finalRequest = providerRequest;
        if (this.config.hooks?.beforeRequest) {
          finalRequest = await this.config.hooks.beforeRequest(request, providerRequest) ?? providerRequest;
        }

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

        if (errorInfo.retryable && attempts < this.retryConfig.maxRetries) {
          // Check hook for retry decision
          if (this.config.hooks?.onError) {
            const decision = await this.config.hooks.onError(errorInfo, attempts);
            if (decision === 'abort') {
              throw new MembraneError(errorInfo);
            }
          }

          // Wait before retry
          const delay = this.calculateRetryDelay(attempts);
          await this.sleep(delay);
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
    
    // Auto mode: choose based on provider
    // OpenRouter and OpenAI-compatible APIs use native tools
    // Anthropic direct with prefill mode uses XML tools
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
    let totalUsage: BasicUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let rawRequest: unknown;
    let rawResponse: unknown;

    // Track executed tool calls and results
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

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

        rawResponse = streamResult.raw;

        // Call onResponse callback with raw response from API
        onResponse?.(rawResponse);

        lastStopReason = this.mapStopReason(streamResult.stopReason);

        // Accumulate usage
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
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
        // Use parser's nesting detection instead of regex-based hasUnclosedToolBlock
        if (lastStopReason === 'stop_sequence' && parser.isInsideBlock()) {
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

      return this.buildFinalResponse(
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
        initialBlockType
      );
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
    let totalUsage: BasicUsage = { inputTokens: 0, outputTokens: 0 };
    let lastStopReason: StopReason = 'end_turn';
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

        // Accumulate usage
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
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

          // Add assistant message with tool use and user message with tool results
          messages.push({
            participant: 'Claude',
            content: responseBlocks,
          });

          messages.push({
            participant: 'User',
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
            tokensCreated: 0,
            tokensRead: 0,
            hitRatio: 0,
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
    // Convert messages to provider format
    const providerMessages: any[] = [];
    
    for (const msg of messages) {
      const isAssistant = msg.participant === 'Claude';
      const role = isAssistant ? 'assistant' : 'user';
      
      // Convert content blocks
      const content: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          const textBlock: Record<string, unknown> = { type: 'text', text: block.text };
          if ((block as any).cache_control) {
            textBlock.cache_control = (block as any).cache_control;
          }
          content.push(textBlock);
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          });
        }
      }
      
      providerMessages.push({ role, content });
    }
    
    // Convert tools to provider format
    const tools = request.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    
    // Build thinking config for native extended thinking
    const thinking = request.config.thinking?.enabled
      ? {
          type: 'enabled' as const,
          budget_tokens: request.config.thinking.budgetTokens ?? 5000,
        }
      : undefined;

    // Anthropic requires temperature=1 when extended thinking is enabled
    const temperature = thinking ? 1 : request.config.temperature;

    return {
      model: request.config.model,
      maxTokens: request.config.maxTokens,
      temperature,
      messages: providerMessages,
      system: request.system,
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
          blocks.push({ type: 'text', text: item.text });
        } else if (item.type === 'tool_use') {
          blocks.push({
            type: 'tool_use',
            id: item.id,
            name: item.name,
            input: item.input,
          });
        } else if (item.type === 'thinking') {
          blocks.push({
            type: 'thinking',
            thinking: item.thinking,
            signature: item.signature,
          });
        }
      }
      return blocks;
    }
    
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    
    return [];
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  /**
   * Transform a normalized request into provider format using the formatter
   */
  private transformRequest(request: NormalizedRequest, formatter?: PrefillFormatter): {
    providerRequest: any;
    prefillResult: BuildResult;
  } {
    // Use provided formatter or instance formatter
    const activeFormatter = formatter ?? this.formatter;

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
      assistantParticipant: this.config.assistantParticipant ?? 'Claude',
      tools: request.tools,
      thinking: request.config.thinking,
      systemPrompt: request.system,
      promptCaching: request.promptCaching ?? true, // Default true for backward compat
      cacheTtl: request.cacheTtl,
      additionalStopSequences,
      maxParticipantsForStop,
    });

    const providerRequest = {
      model: request.config.model,
      maxTokens: request.config.maxTokens,
      temperature: request.config.temperature,
      messages: buildResult.messages,
      system: buildResult.systemContent,
      stopSequences: buildResult.stopSequences,
      tools: buildResult.nativeTools,
      extra: {
        ...request.providerParams,
        normalizedMessages: request.messages,
      },
    };

    return { providerRequest, prefillResult: buildResult };
  }

  private async streamOnce(
    request: any,
    callbacks: { onChunk: (chunk: string) => void; onContentBlock?: (index: number, block: unknown) => void },
    options: { signal?: AbortSignal; onRequest?: (rawRequest: unknown) => void }
  ) {
    return await this.adapter.stream(request, callbacks, options);
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
      model: originalRequest.config.model,
      maxTokens: originalRequest.config.maxTokens,
      temperature: originalRequest.config.temperature,
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

    // Build messages: copy existing, then modify/add for split-turn
    const messages: any[] = [];

    // Copy all messages except the last assistant message
    for (const msg of prefillResult.messages) {
      if (msg.role === 'assistant') {
        // Skip - we'll add our own assistant messages
        continue;
      }
      messages.push({ ...msg });
    }

    // Add assistant message with accumulated content (ends mid-XML)
    messages.push({
      role: 'assistant',
      content: trimmedAccumulated,
    });

    // Add user message with just the images
    messages.push({
      role: 'user',
      content: images,
    });

    // Add assistant prefill with closing XML tags
    // Anthropic quirk: assistant content cannot end with trailing whitespace
    const trimmedAfterXml = afterImageXml.trimEnd();
    messages.push({
      role: 'assistant',
      content: trimmedAfterXml,
    });

    return {
      model: originalRequest.config.model,
      maxTokens: originalRequest.config.maxTokens,
      temperature: originalRequest.config.temperature,
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
            thinking: block.thinking,
            signature: block.signature,
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
    usage: BasicUsage,
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
    startInsideBlock: 'thinking' | 'tool_call' | 'tool_result' | null = null
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
          wasTruncated: stopReason === 'max_tokens',
        },
        usage: {
          ...usage,
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
          markersInRequest: 0,
          tokensCreated: 0,
          tokensRead: 0,
          hitRatio: 0,
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
      default:
        return 'end_turn';
    }
  }

  private calculateCacheHitRatio(usage: any): number {
    const cacheRead = usage.cacheReadTokens ?? 0;
    const total = usage.inputTokens ?? 0;
    if (total === 0) return 0;
    return cacheRead / total;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      maxToolDepth = 10,
      emitTokens = true,
      emitBlocks = true,
      emitUsage = true,
    } = options;

    // Initialize parser from formatter for format-specific tracking
    const formatter = this.formatter;
    const parser = formatter.createStreamParser();
    let toolDepth = 0;
    let totalUsage: BasicUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let rawRequest: unknown;
    let rawResponse: unknown;

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
          }
        );

        // If we detected stop sequence manually, fix up the parser and result
        if (detectedStopSequence && truncatedAccumulated !== null) {
          parser.reset();
          parser.push(truncatedAccumulated);
          streamResult.stopReason = 'stop_sequence';
          streamResult.stopSequence = detectedStopSequence;
        }

        rawResponse = streamResult.raw;
        lastStopReason = this.mapStopReason(streamResult.stopReason);

        // Accumulate usage
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
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
        if (lastStopReason === 'stop_sequence' && parser.isInsideBlock()) {
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
        initialBlockType
      );

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
      maxToolDepth = 10,
      emitTokens = true,
      emitUsage = true,
    } = options;

    let toolDepth = 0;
    let totalUsage: BasicUsage = { inputTokens: 0, outputTokens: 0 };
    let lastStopReason: StopReason = 'end_turn';
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
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              if (stream.isCancelled) return;

              textAccumulated += chunk;
              allTextAccumulated += chunk;

              if (emitTokens) {
                const meta: ChunkMeta = {
                  type: 'text',
                  visible: true,
                  blockIndex,
                };
                stream.emit({ type: 'tokens', content: chunk, meta });
              }
            },
            onContentBlock: undefined,
          },
          {
            signal: stream.signal,
          }
        );

        rawResponse = streamResult.raw;
        lastStopReason = this.mapStopReason(streamResult.stopReason);

        // Accumulate usage
        totalUsage.inputTokens += streamResult.usage.inputTokens;
        totalUsage.outputTokens += streamResult.usage.outputTokens;
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

          // Add messages for next iteration
          messages.push({
            participant: 'Claude',
            content: responseBlocks,
          });

          messages.push({
            participant: 'User',
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
            tokensCreated: 0,
            tokensRead: 0,
            hitRatio: 0,
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
