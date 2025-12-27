/**
 * Membrane - LLM middleware core class
 * 
 * A selective boundary that transforms what passes through.
 */

import type {
  NormalizedRequest,
  NormalizedResponse,
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
} from './types/index.js';
import {
  transformToPrefill,
  type PrefillTransformResult,
} from './transforms/index.js';
import {
  parseToolCalls,
  formatToolResults,
  hasUnclosedToolBlock,
} from './utils/tool-parser.js';

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
          attempts
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
   * Stream a request with inline tool execution
   */
  async stream(
    request: NormalizedRequest,
    options: StreamOptions = {}
  ): Promise<NormalizedResponse> {
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
   */
  private async streamWithXmlTools(
    request: NormalizedRequest,
    options: StreamOptions
  ): Promise<NormalizedResponse> {
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
    
    let accumulated = '';
    let toolDepth = 0;
    let totalUsage: BasicUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let lastStopReason: StopReason = 'end_turn';
    let rawRequest: unknown;
    let rawResponse: unknown;
    
    // Transform initial request (XML tools are injected into system prompt)
    let { providerRequest, prefillResult } = this.transformRequest(request);
    
    // Tool execution loop
    while (toolDepth <= maxToolDepth) {
      rawRequest = providerRequest;
      
      // Stream from provider
      const streamResult = await this.streamOnce(
        providerRequest,
        {
          onChunk: (chunk) => {
            accumulated += chunk;
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
      
      // Check for tool calls (if handler provided)
      if (onToolCalls && streamResult.stopSequence === '</function_calls>') {
        // Anthropic stops BEFORE outputting the stop sequence, so we need to append it
        accumulated += '</function_calls>';
        onChunk?.('</function_calls>');
        
        const parsed = parseToolCalls(accumulated);
        
        if (parsed && parsed.calls.length > 0) {
          // Notify about pre-tool content
          if (onPreToolContent && parsed.beforeText.trim()) {
            await onPreToolContent(parsed.beforeText);
          }
          
          // Execute tools
          const context: ToolContext = {
            rawText: parsed.fullMatch,
            preamble: parsed.beforeText,
            depth: toolDepth,
            previousResults: [],
            accumulated,
          };
          
          const results = await onToolCalls(parsed.calls, context);
          
          // Inject results and continue
          const resultsXml = formatToolResults(results);
          accumulated += resultsXml;
          onChunk?.(resultsXml);
          
          // Update prefill and continue
          prefillResult.assistantPrefill = accumulated;
          providerRequest = this.buildContinuationRequest(
            request,
            prefillResult,
            accumulated
          );
          
          toolDepth++;
          continue;
        }
      }
      
      // Check for false-positive stop (unclosed block)
      // Only resume if we stopped on a stop_sequence (not end_turn or max_tokens)
      if (lastStopReason === 'stop_sequence' && hasUnclosedToolBlock(accumulated)) {
        // Resume streaming - but limit resumptions to prevent infinite loops
        toolDepth++; // Count this as a "depth" to limit iterations
        if (toolDepth > maxToolDepth) {
          break;
        }
        prefillResult.assistantPrefill = accumulated;
        providerRequest = this.buildContinuationRequest(
          request,
          prefillResult,
          accumulated
        );
        continue;
      }
      
      // No more tools or tool handling disabled, we're done
      break;
    }
    
    // Build final response
    return this.buildFinalResponse(
      accumulated,
      contentBlocks,
      lastStopReason,
      totalUsage,
      request,
      prefillResult,
      startTime,
      1, // attempts
      rawRequest,
      rawResponse
    );
  }

  /**
   * Stream with native API tool execution
   */
  private async streamWithNativeTools(
    request: NormalizedRequest,
    options: StreamOptions
  ): Promise<NormalizedResponse> {
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
    
    // Build messages array that we'll update with tool results
    let messages = [...request.messages];
    let allContentBlocks: ContentBlock[] = [];
    
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
        
        // Execute tools
        const context: ToolContext = {
          rawText: JSON.stringify(toolUseBlocks),
          preamble: textAccumulated,
          depth: toolDepth,
          previousResults: [],
          accumulated: textAccumulated,
        };
        
        const results = await onToolCalls(toolCalls, context);
        
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
      assistantName: 'Claude', // TODO: make configurable
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

  private transformResponse(
    providerResponse: any,
    request: NormalizedRequest,
    prefillResult: PrefillTransformResult,
    startTime: number,
    attempts: number
  ): NormalizedResponse {
    // Extract text from response
    const content: ContentBlock[] = [];
    
    if (Array.isArray(providerResponse.content)) {
      for (const block of providerResponse.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
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
    }
    
    const stopReason = this.mapStopReason(providerResponse.stopReason);
    const durationMs = Date.now() - startTime;
    
    return {
      content,
      stopReason,
      usage: {
        inputTokens: providerResponse.usage.inputTokens,
        outputTokens: providerResponse.usage.outputTokens,
      },
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
        request: null, // TODO: store raw request
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
    rawResponse: unknown
  ): NormalizedResponse {
    // Parse accumulated text into content blocks
    const finalContent: ContentBlock[] = contentBlocks.length > 0
      ? contentBlocks
      : [{ type: 'text', text: accumulated }];
    
    const durationMs = Date.now() - startTime;
    
    return {
      content: finalContent,
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
}
