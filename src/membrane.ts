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
import {
  transformToPrefill,
  type PrefillTransformResult,
} from './transforms/index.js';
import {
  parseToolCalls,
  formatToolResults,
  parseAccumulatedIntoBlocks,
  hasImageInToolResults,
  formatToolResultsForSplitTurn,
  type ProviderImageBlock,
} from './utils/tool-parser.js';
import { IncrementalXmlParser } from './utils/stream-parser.js';

// ============================================================================
// Membrane Class
// ============================================================================

export class Membrane {
  private adapter: ProviderAdapter;
  private registry?: ModelRegistry;
  private retryConfig: RetryConfig;
  private config: MembraneConfig;

  constructor(
    adapter: ProviderAdapter,
    config: MembraneConfig = {}
  ) {
    this.adapter = adapter;
    this.registry = config.registry;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };
    this.config = config;
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
        });
        
        const response = this.transformResponse(
          providerResponse,
          request,
          prefillResult,
          startTime,
          attempts,
          finalRequest
        );
        
        // Call afterResponse hook
        if (this.config.hooks?.afterResponse) {
          return await this.config.hooks.afterResponse(response, providerResponse.raw);
        }
        
        return response;
        
      } catch (error) {
        const errorInfo = classifyError(error);
        
        if (errorInfo.retryable && attempts < this.retryConfig.maxRetries) {
          // Check hook for retry decision
          if (this.config.hooks?.onError) {
            const decision = await this.config.hooks.onError(errorInfo, attempts);
            if (decision === 'abort') {
              throw error instanceof MembraneError ? error : new MembraneError(errorInfo);
            }
          }
          
          // Wait before retry
          const delay = this.calculateRetryDelay(attempts);
          await this.sleep(delay);
          continue;
        }
        
        throw error instanceof MembraneError ? error : new MembraneError(errorInfo);
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
      maxToolDepth = 10,
      signal,
    } = options;

    // Initialize incremental parser for XML tracking
    const parser = new IncrementalXmlParser();
    let toolDepth = 0;
    let totalUsage: BasicUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let rawRequest: unknown;
    let rawResponse: unknown;

    // Track executed tool calls and results
    const executedToolCalls: ToolCall[] = [];
    const executedToolResults: ToolResult[] = [];

    // Transform initial request (XML tools are injected into system prompt)
    let { providerRequest, prefillResult } = this.transformRequest(request);

    try {
      // Tool execution loop
      while (toolDepth <= maxToolDepth) {
        rawRequest = providerRequest;

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

              // Feed to incremental parser (updates nesting depth)
              const blockEvents = parser.push(chunk);

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

                  // Emit only the portion up to stop sequence
                  const alreadyEmitted = accumulated.length - chunk.length;
                  if (absoluteIdx > alreadyEmitted) {
                    const truncatedChunk = accumulated.slice(alreadyEmitted, absoluteIdx);
                    onChunk?.(truncatedChunk);
                  }
                  return;
                }
              }

              // Emit raw chunk
              onChunk?.(chunk);

              // Emit block events if callback provided
              if (onBlock) {
                for (const event of blockEvents) {
                  onBlock(event);
                }
              }
            },
            onContentBlock: onContentBlockUpdate
              ? (index: number, block: unknown) => onContentBlockUpdate(index, block as ContentBlock)
              : undefined,
          },
          { signal }
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
        onUsage?.(totalUsage);

        // Get accumulated text from parser
        const accumulated = parser.getAccumulated();

        // Check for tool calls (if handler provided)
        if (onToolCalls && streamResult.stopSequence === '</function_calls>') {
          // Append the closing tag (we truncated before it, or API stopped before it)
          const closeTag = '</function_calls>';
          parser.push(closeTag);
          onChunk?.(closeTag);

          const parsed = parseToolCalls(parser.getAccumulated());

          if (parsed && parsed.calls.length > 0) {
            // Notify about pre-tool content
            if (onPreToolContent && parsed.beforeText.trim()) {
              await onPreToolContent(parsed.beforeText);
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

            // Track the tool results
            executedToolResults.push(...results);

            // Check if results contain images (requires split-turn injection)
            if (hasImageInToolResults(results)) {
              // Use split-turn injection for images
              const splitContent = formatToolResultsForSplitTurn(results);

              // Append the text portion to accumulated (before image)
              parser.push(splitContent.beforeImageXml);
              onChunk?.(splitContent.beforeImageXml);

              // Build continuation with image injection
              providerRequest = this.buildContinuationRequestWithImages(
                request,
                prefillResult,
                parser.getAccumulated(),
                splitContent.images,
                splitContent.afterImageXml
              );

              // Also add afterImageXml to accumulated for complete rawAssistantText
              // This is prefilled but represents assistant's logical output
              parser.push(splitContent.afterImageXml);
              onChunk?.(splitContent.afterImageXml);
              prefillResult.assistantPrefill = parser.getAccumulated();
            } else {
              // Standard path: no images, use simple XML injection
              const resultsXml = formatToolResults(results);
              parser.push(resultsXml);
              onChunk?.(resultsXml);

              // Update prefill and continue
              prefillResult.assistantPrefill = parser.getAccumulated();
              providerRequest = this.buildContinuationRequest(
                request,
                prefillResult,
                parser.getAccumulated()
              );
            }

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
            onChunk?.(streamResult.stopSequence);
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
          continue;
        }

        // No more tools or tool handling disabled, we're done
        break;
      }

      // Build final response
      return this.buildFinalResponse(
        parser.getAccumulated(),
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
        executedToolResults
      );
    } catch (error) {
      // Check if this is an abort error
      if (this.isAbortError(error)) {
        return this.buildAbortedResponse(
          parser.getAccumulated(),
          totalUsage,
          executedToolCalls,
          executedToolResults,
          'user'
        );
      }
      // Re-throw non-abort errors
      throw error;
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
        rawRequest = providerRequest;

        // Stream from provider
        let textAccumulated = '';
        const streamResult = await this.streamOnce(
          providerRequest,
          {
            onChunk: (chunk) => {
              textAccumulated += chunk;
              allTextAccumulated += chunk;
              onChunk?.(chunk);
            },
            onContentBlock: onContentBlockUpdate
              ? (index: number, block: unknown) => onContentBlockUpdate(index, block as ContentBlock)
              : undefined,
          },
          { signal }
        );

        rawResponse = streamResult.raw;
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
      // Re-throw non-abort errors
      throw error;
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
          content.push({ type: 'text', text: block.text });
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
    
    return {
      model: request.config.model,
      maxTokens: request.config.maxTokens,
      temperature: request.config.temperature,
      messages: providerMessages,
      system: request.system,
      tools,
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

  private transformRequest(request: NormalizedRequest): {
    providerRequest: any;
    prefillResult: PrefillTransformResult;
  } {
    // For now, use prefill transform
    // In full implementation, would check capabilities and choose transform
    const prefillResult = transformToPrefill(request, {
      assistantName: this.config.assistantParticipant ?? 'Claude',
      promptCaching: true, // Enable cache control by default
    });
    
    // Use the pre-built messages from prefill transform
    // These include cache_control markers on appropriate content blocks
    const providerRequest = {
      model: request.config.model,
      maxTokens: request.config.maxTokens,
      temperature: request.config.temperature,
      messages: prefillResult.messages,
      // System is now part of messages with cache_control
      // But we still pass it for providers that need it separately
      system: prefillResult.systemContent.length > 0 
        ? prefillResult.systemContent 
        : undefined,
      stopSequences: prefillResult.stopSequences,
      extra: request.providerParams,
    };
    
    return { providerRequest, prefillResult };
  }

  private async streamOnce(
    request: any,
    callbacks: { onChunk: (chunk: string) => void; onContentBlock?: (index: number, block: unknown) => void },
    options: { signal?: AbortSignal }
  ) {
    return await this.adapter.stream(request, callbacks, options);
  }

  private buildContinuationRequest(
    originalRequest: NormalizedRequest,
    prefillResult: PrefillTransformResult,
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
      system: prefillResult.systemContent.length > 0
        ? prefillResult.systemContent
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
    prefillResult: PrefillTransformResult,
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
      system: prefillResult.systemContent.length > 0
        ? prefillResult.systemContent
        : undefined,
      stopSequences: prefillResult.stopSequences,
      extra: originalRequest.providerParams,
    };
  }

  private transformResponse(
    providerResponse: any,
    request: NormalizedRequest,
    prefillResult: PrefillTransformResult,
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
          markersInRequest: prefillResult.cacheMarkersApplied,
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
    prefillResult: PrefillTransformResult,
    startTime: number,
    attempts: number,
    rawRequest: unknown,
    rawResponse: unknown,
    executedToolCalls: ToolCall[] = [],
    executedToolResults: ToolResult[] = []
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
      const parsed = parseAccumulatedIntoBlocks(accumulated);
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
    reason: 'user' | 'timeout' | 'error'
  ): AbortedResponse {
    // Parse accumulated text into content blocks for partial content
    const { blocks } = parseAccumulatedIntoBlocks(accumulated);

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
}
