/**
 * Google Gemini provider adapter
 *
 * Direct adapter for Google's Generative AI REST API.
 * Supports Gemini 2.x, 2.5, 3.x models with:
 * - Text and image input
 * - Tool/function calling
 * - Streaming via SSE
 *
 * Auth: API key passed as query parameter (?key=...)
 * Endpoint: generativelanguage.googleapis.com/v1beta
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  ContentBlock,
} from '../types/index.js';
import {
  MembraneError,
  abortError,
  classifyError,
  errorFromHttpResponse,
  errorFromProviderStatus,
  isTypedAbortError,
  withRawRequest,
} from '../types/index.js';
import { createCombinedSignal, textOnlyToolResultContent, toolUseInputFromValue, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved } from './utils.js';

// ============================================================================
// Gemini API Types
// ============================================================================

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    responseModalities?: string[];
  };
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
    safetyRatings?: unknown[];
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    /**
     * Reasoning ("thinking") tokens. DISJOINT from candidatesTokenCount and
     * billed at the output rate, so generated output is candidates + thoughts.
     * Live receipt 2026-08-25, gemini-3.5-flash-lite, thinkingBudget 512:
     * prompt 35, candidates 2, thoughts 228, total 265 — 35+2+228 === 265.
     */
    thoughtsTokenCount?: number;
    /**
     * Tokens of the prompts Gemini's built-in tools add, such as code
     * execution's intermediate tokens or URL context's retrieved pages.
     * DISJOINT from promptTokenCount: Google defines totalTokenCount as
     * "prompt + tool-use prompt + thoughts + response candidates"
     * (UsageMetadata reference, read 2026-10-14).
     */
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
  error?: { code: number; message: string; status: string };
}

interface GeminiStreamState {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  images: { data: string; mimeType: string }[];
  candidateFinishReason: string | undefined;
  sawCandidateData: boolean;
  promptFeedback: GeminiResponse['promptFeedback'];
  lastUsage: GeminiResponse['usageMetadata'];
  sawTerminalEvent: boolean;
  lastModelVersion: string | undefined;
}

/**
 * Gemini's usageMetadata follows proto3 JSON, which omits zero-valued counts:
 * when the object is present, a missing prompt, candidates or cache-read
 * count is a reported 0. Only a response with no usageMetadata at all leaves
 * the counts unreported. A turn without thinking keeps `thinkingTokens`
 * absent, as it always has.
 */
function geminiUnreportedUsage(usageMetadata: GeminiResponse['usageMetadata']): { unreportedUsage?: Array<'inputTokens' | 'outputTokens'> } {
  return usageMetadata ? {} : { unreportedUsage: ['inputTokens', 'outputTokens'] };
}

/**
 * Map Gemini's `usageMetadata` onto membrane's usage shape.
 *
 * `thoughtsTokenCount` is disjoint from `candidatesTokenCount` and billed at
 * the output rate, so generated output is the SUM of the two; reading only
 * candidates reported a thinking turn at a fraction of its real size. The
 * reconciliation check makes the next such omission loud rather than silent:
 * Google's own total is the independent witness, and a mismatch means a
 * usageMetadata field outside prompt, tool-use prompt, candidates and
 * thoughts is carrying tokens.
 *
 * `toolUsePromptTokenCount` is disjoint from `promptTokenCount` and is read
 * into `inputTokens`: Google bills code execution's intermediate tokens, URL
 * context's retrieved content and file search's retrieved documents as input.
 * Grounding, with Google Search or Google Maps, is billed per query or per
 * grounded prompt instead, which membrane doesn't price, and for text models
 * Google doesn't say whether grounding's retrieved context is counted here or
 * charged as input. If it is counted here and not charged, a grounded
 * response's input is overstated. A grounded candidate carries
 * `groundingMetadata`, but a response that used grounding and another tool
 * reports one count, which can't be split. The adapter's `raw` keeps
 * `usageMetadata` as Google sent it.
 */
function geminiUsageToProviderUsage(
  usageMetadata: GeminiResponse['usageMetadata']
): ProviderResponse['usage'] {
  const promptTokens = usageMetadata?.promptTokenCount ?? 0;
  const toolUsePromptTokens = usageMetadata?.toolUsePromptTokenCount ?? 0;
  const candidatesTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thoughtsTokens = usageMetadata?.thoughtsTokenCount;
  const totalTokens = usageMetadata?.totalTokenCount;

  if (usageMetadata && totalTokens != null) {
    const accountedTokens = promptTokens + toolUsePromptTokens + candidatesTokens + (thoughtsTokens ?? 0);
    if (accountedTokens !== totalTokens) {
      console.warn(
        `[membrane:gemini] usageMetadata does not reconcile: promptTokenCount(${promptTokens})`
        + ` + toolUsePromptTokenCount(${toolUsePromptTokens})`
        + ` + candidatesTokenCount(${candidatesTokens}) + thoughtsTokenCount(${thoughtsTokens ?? 0})`
        + ` = ${accountedTokens}, but totalTokenCount = ${totalTokens}.`
        + ' Some billed tokens are in a usageMetadata field outside prompt, tool-use prompt, candidates and thoughts.'
      );
    }
  }

  const cachedTokens = usageMetadata
    ? (typeof usageMetadata.cachedContentTokenCount === 'number' ? usageMetadata.cachedContentTokenCount : 0)
    : undefined;
  // A cached span larger than the whole prompt can't be inside the prompt
  // count, so the inclusive reading doesn't fit this response. Reading its
  // prompt count as the fresh input is this adapter's choice: the response is
  // read as cache-excluded, against the declared convention (see
  // GeminiAdapter.usageCacheConvention, whose basis is Google's definition,
  // not a measured implicit hit).
  const promptExcludesCache = cachedTokens !== undefined && cachedTokens > promptTokens;
  if (promptExcludesCache && !warnedPromptExcludesCache) {
    warnedPromptExcludesCache = true;
    console.warn(
      `[membrane:gemini] cachedContentTokenCount(${cachedTokens}) exceeds promptTokenCount(${promptTokens}),`
      + ' so this prompt count cannot include the cached span. The response is read as cache-excluded'
      + ' (promptTokenCount, with any tool-use prompt, is the fresh input); the adapter declares'
      + ' cache-inclusive from Google\'s'
      + ' definition of the field.'
    );
  }

  return {
    inputTokens: promptTokens + toolUsePromptTokens,
    outputTokens: candidatesTokens + (thoughtsTokens ?? 0),
    ...(thoughtsTokens != null ? { thinkingTokens: thoughtsTokens } : {}),
    // A reported 0 is a fact (no cache read); only an unreported count is
    // absent. By the proto3 rule above, a present usageMetadata reports the
    // cache-read count even when it omits it: real calls without a cache hit
    // never send the field (see usageCacheConvention's note), and that is a 0.
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
    ...(promptExcludesCache ? { cacheConvention: 'cache-excluded' as const } : {}),
  };
}

/** Whether the cached-above-prompt warning has been printed (once per process). */
let warnedPromptExcludesCache = false;

/** Test seam: the cached-above-prompt warning's latch is process-wide otherwise. */
export function resetPromptExcludesCacheWarning(): void {
  warnedPromptExcludesCache = false;
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface GeminiAdapterConfig {
  /** Google AI API key */
  apiKey?: string;

  /** Base URL (default: https://generativelanguage.googleapis.com/v1beta) */
  baseURL?: string;

  /** Default max output tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// Gemini Adapter
// ============================================================================

export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini';

  /**
   * Cache-inclusive: `promptTokenCount` (read into `inputTokens`, beside the
   * tool-use prompt) counts the cached span `cachedContentTokenCount` (read
   * as `cacheReadTokens`) reports, so membrane subtracts it to reach the
   * fresh input.
   *
   * The basis is Google's definition, not a measured hit. The UsageMetadata
   * reference (https://ai.google.dev/api/generate-content, read 2026-10-10)
   * says `promptTokenCount` is "Number of tokens in the prompt. When
   * cachedContent is set, this is still the total effective prompt size
   * meaning this includes the number of tokens in the cached content", and
   * that `totalTokenCount` is "prompt + tool-use prompt + thoughts + response
   * candidates" (read again 2026-10-15), with no cached term of its own. The "When cachedContent is set" sentence
   * is about explicit caching (`cachedContent`), which membrane never sets
   * itself: a hit through membrane is implicit unless a caller passes
   * `cachedContent` through `providerParams`, and for an implicit hit the
   * inclusion is inferred from the field's definition and the total, not
   * stated. A response whose cached count exceeds its prompt count can't be
   * read that way, so it is read as cache-excluded, with a warning (see
   * geminiUsageToProviderUsage). No probe has measured an implicit hit: on
   * 2026-08-25, three identical 10,893-token calls to gemini-3.5-flash-lite
   * never reported the field (implicit caching did not trigger), and
   * explicit `cachedContents` is refused on the free tier (429,
   * TotalCachedContentStorageTokensPerModelFreeTier limit=0).
   */
  readonly usageCacheConvention = 'cache-inclusive' as const;
  private apiKey: string;
  private baseURL: string;
  private defaultMaxTokens: number;

  constructor(config: GeminiAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? '';
    this.baseURL = (config.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;

    if (!this.apiKey) {
      throw new Error('Google AI API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gemini-');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const geminiRequest = this.buildRequest(request);
    options?.onRequest?.(geminiRequest);

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const url = `${this.baseURL}/models/${request.model}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), geminiRequest);
      }

      const data = await response.json() as GeminiResponse;

      if (data.error) {
        // An error object inside an HTTP 200: classify off its own code/status
        // instead of a rendered string.
        throw errorFromProviderStatus({
          provider: this.name,
          status: typeof data.error.code === 'number' ? data.error.code : undefined,
          body: data,
          rawRequest: geminiRequest,
        });
      }

      return this.parseResponse(data, request.model, geminiRequest);
    } catch (error) {
      throw this.handleError(error, geminiRequest);
    } finally {
      cleanup?.();
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const geminiRequest = this.buildRequest(request);
    options?.onRequest?.(geminiRequest);

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const url = `${this.baseURL}/models/${request.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), geminiRequest);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      const streamState: GeminiStreamState = {
        text: '',
        sawTerminalEvent: false,
        lastModelVersion: undefined,
        toolCalls: [],
        images: [],
        candidateFinishReason: undefined,
        sawCandidateData: false,
        promptFeedback: undefined,
        lastUsage: undefined,
      };
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last potentially incomplete line in buffer
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            this.consumeStreamFrame(line.slice(6).trim(), streamState, callbacks, geminiRequest, options?.onProgress);
          }
        }

        // Process any remaining data in the buffer (final chunk may not end with newline)
        const trailing = buffer.trim();
        if (trailing) {
          this.consumeStreamFrame(
            trailing.startsWith('data: ') ? trailing.slice(6).trim() : trailing,
            streamState,
            callbacks,
            geminiRequest,
            options?.onProgress,
          );
        }
      } finally {
        // A read loop that ends early, on a callback's error or any other,
        // leaves the body unread: cancel it, so the provider stops sending
        // and the connection is let go. After a full read it does nothing.
        void reader.cancel().catch(() => {});
      }

      assertTerminalEventObserved(
        streamState.sawTerminalEvent || (!streamState.sawCandidateData && streamState.promptFeedback?.blockReason !== undefined),
        'Gemini',
        geminiRequest,
      );

      return {
        content: this.buildContentBlocks(streamState.text, streamState.toolCalls, streamState.images),
        stopReason: this.resolveStopReason(
          streamState.sawCandidateData,
          streamState.candidateFinishReason,
          streamState.promptFeedback
        ),
        providerStopReason: streamState.candidateFinishReason ?? (!streamState.sawCandidateData ? streamState.promptFeedback?.blockReason : undefined),
        stopSequence: undefined,
        usage: geminiUsageToProviderUsage(streamState.lastUsage),
        ...geminiUnreportedUsage(streamState.lastUsage),
        model: streamState.lastModelVersion ?? request.model,
        rawRequest: geminiRequest,
        raw: {
          finishReason: streamState.candidateFinishReason ?? 'STOP',
          usage: streamState.lastUsage,
          ...(streamState.promptFeedback !== undefined
            ? { promptFeedback: streamState.promptFeedback }
            : {}),
        },
      };
    } catch (error) {
      throw this.handleError(error, geminiRequest);
    } finally {
      cleanup?.();
    }
  }

  private consumeStreamFrame(
    frameData: string,
    streamState: GeminiStreamState,
    callbacks: StreamCallbacks,
    rawRequest: unknown,
    onProgress?: () => void,
  ): void {
    if (!frameData || frameData === '[DONE]') return;

    let parsed: GeminiResponse;
    try {
      parsed = JSON.parse(frameData) as GeminiResponse;
    } catch {
      // A frame that isn't valid JSON carries nothing to accumulate
      return;
    }
    // `data: null` carries nothing to read, as on the other adapters.
    if (parsed === null) return;
    // A parsed provider event is progress (`data: null` is no event).
    onProgress?.();
    throwOnStreamErrorFrame(parsed, 'Gemini', rawRequest);
    if (parsed.modelVersion) streamState.lastModelVersion = parsed.modelVersion;
    const candidate = parsed.candidates?.[0];

    if (candidate?.content !== undefined || candidate?.finishReason !== undefined) {
      streamState.sawCandidateData = true;
    }

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          streamState.text += part.text;
          callbacks.onChunk(part.text);
        }
        if (part.inlineData) {
          streamState.images.push({
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
        }
        if (part.functionCall) {
          streamState.toolCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args,
          });
        }
      }
    }

    if (candidate?.finishReason) {
      streamState.candidateFinishReason = candidate.finishReason;
      streamState.sawTerminalEvent = true;
    }

    // A blocked prompt can ride a frame of its own, with zero candidates
    if (parsed.promptFeedback?.blockReason !== undefined) {
      streamState.promptFeedback = parsed.promptFeedback;
    }

    if (parsed.usageMetadata) {
      streamState.lastUsage = parsed.usageMetadata;
    }
  }

  // --------------------------------------------------------------------------
  // Request Building
  // --------------------------------------------------------------------------

  private buildRequest(request: ProviderRequest): GeminiRequest {
    const contents = this.convertMessages(request.messages as any[], request.model);
    const maxTokens = request.maxTokens || this.defaultMaxTokens;

    const geminiRequest: GeminiRequest = { contents };

    // System instruction
    if (request.system) {
      const systemText = typeof request.system === 'string'
        ? request.system
        : (request.system as any[])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');

      if (systemText) {
        geminiRequest.systemInstruction = {
          parts: [{ text: systemText }],
        };
      }
    }

    // Generation config
    geminiRequest.generationConfig = {
      maxOutputTokens: maxTokens,
    };

    if (request.temperature !== undefined) {
      geminiRequest.generationConfig.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      geminiRequest.generationConfig.topP = request.topP;
    }

    if (request.topK !== undefined) {
      geminiRequest.generationConfig.topK = request.topK;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      // Gemini API limits stop sequences to 5
      geminiRequest.generationConfig.stopSequences = request.stopSequences.slice(0, 5);
    }

    // Auto-detect image generation models by name
    if (request.model?.includes('image')) {
      geminiRequest.generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = [{
        functionDeclarations: this.convertTools(request.tools as any[]),
      }];
    }

    // Extra params — deep-merge generationConfig to preserve auto-detected settings
    if (request.extra) {
      const { normalizedMessages, prompt, generationConfig: extraGenConfig, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(geminiRequest, rest);
      if (extraGenConfig && typeof extraGenConfig === 'object') {
        Object.assign(geminiRequest.generationConfig, extraGenConfig);
      }
    }

    return geminiRequest;
  }

  private convertMessages(messages: any[], model?: string): GeminiContent[] {
    const contents: GeminiContent[] = [];

    // Gemini 3.x requires thought_signature on image parts from model outputs.
    // Images that round-trip through Discord lose their thought_signature metadata,
    // causing 400 INVALID_ARGUMENT when sent back as inlineData. For gemini-3.x
    // model-role images, we fall back to embedding the source URL as text — Gemini
    // auto-fetches URLs from text content, enabling iterative editing without
    // thought_signature. User images pass through as normal inlineData.
    const useUrlForModelImages = model?.startsWith('gemini-3');

    for (const msg of messages) {
      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

      // Simple string content
      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      // Array content blocks (Anthropic-style)
      if (Array.isArray(msg.content)) {
        const parts: GeminiPart[] = [];
        const toolResultParts: GeminiPart[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) parts.push({ text: block.text });
          } else if (block.type === 'image') {
            // Gemini 3.x model-role images: use URL-as-text so Gemini auto-fetches
            // the image without needing thought_signature metadata
            if (useUrlForModelImages && role === 'model' && block.sourceUrl) {
              parts.push({ text: block.sourceUrl });
              continue;
            }

            // Anthropic image format → Gemini inlineData
            const source = block.source;
            if (source?.type === 'base64' && source.data) {
              parts.push({
                inlineData: {
                  mimeType: source.media_type ?? 'image/jpeg',
                  data: source.data,
                },
              });
            }
          } else if (block.type === 'audio') {
            // Audio input → Gemini inlineData (same mechanism as images). This is
            // pure plumbing: whether a given model accepts/understands audio is the
            // model's concern (the caller decides what to send). Common MIME types:
            // audio/mp3, audio/wav, audio/ogg, audio/flac.
            const source = block.source;
            if (source?.type === 'base64' && source.data) {
              parts.push({
                inlineData: {
                  mimeType: source.mediaType ?? source.media_type ?? 'audio/mpeg',
                  data: source.data,
                },
              });
            }
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input ?? {},
              },
            });
          } else if (block.type === 'tool_result') {
            const resultContent = textOnlyToolResultContent(block.content);
            toolResultParts.push({
              functionResponse: {
                name: block.name ?? block.tool_use_id ?? 'unknown',
                response: { result: resultContent },
              },
            });
          }
        }

        // Tool results go in a user message
        if (toolResultParts.length > 0) {
          contents.push({ role: 'user', parts: toolResultParts });
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }

        continue;
      }

      // Null/empty content — skip
      if (msg.content === null || msg.content === undefined) continue;

      // Fallback
      contents.push({ role, parts: [{ text: String(msg.content) }] });
    }

    // Gemini requires alternating user/model roles.
    // Merge consecutive same-role messages.
    return this.mergeConsecutiveRoles(contents);
  }

  /**
   * Gemini requires strictly alternating user/model messages.
   * Merge consecutive messages with the same role into one.
   */
  private mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
    if (contents.length === 0) return contents;

    const merged: GeminiContent[] = [contents[0]!];

    for (let i = 1; i < contents.length; i++) {
      const current = contents[i]!;
      const last = merged[merged.length - 1]!;

      if (current.role === last.role) {
        // Merge parts into the previous message
        last.parts.push(...current.parts);
      } else {
        merged.push(current);
      }
    }

    // Gemini also requires the first message to be "user"
    // TODO: Accept prefillUserMessage from request when Gemini bots need C2 migration
    if (merged.length > 0 && merged[0]!.role !== 'user') {
      merged.unshift({ role: 'user', parts: [{ text: '[Start]' }] });
    }

    return merged;
  }

  private convertTools(tools: any[]): GeminiFunctionDeclaration[] {
    return tools.map(tool => {
      const schema = tool.inputSchema || tool.input_schema || { type: 'object', properties: {} };
      return {
        name: tool.name,
        description: tool.description ?? '',
        parameters: schema,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Response Parsing
  // --------------------------------------------------------------------------

  private parseResponse(
    response: GeminiResponse,
    requestedModel: string,
    rawRequest: unknown
  ): ProviderResponse {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    let text = '';
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const images: { data: string; mimeType: string }[] = [];

    for (const part of parts) {
      if (part.text) text += part.text;
      if (part.inlineData) {
        images.push({
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        });
      }
      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
      }
    }

    return {
      content: this.buildContentBlocks(text, toolCalls, images),
      stopReason: this.resolveStopReason(
        candidate !== undefined,
        candidate?.finishReason,
        response.promptFeedback
      ),
      providerStopReason: candidate?.finishReason ?? (candidate === undefined ? response.promptFeedback?.blockReason : undefined),
      stopSequence: undefined,
      usage: geminiUsageToProviderUsage(response.usageMetadata),
      ...geminiUnreportedUsage(response.usageMetadata),
      model: response.modelVersion ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private buildContentBlocks(
    text: string,
    toolCalls: { name: string; args: Record<string, unknown> }[],
    images: { data: string; mimeType: string }[] = []
  ): ContentBlock[] {
    const content: ContentBlock[] = [];

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const img of images) {
      content.push({
        type: 'generated_image',
        data: img.data,
        mimeType: img.mimeType,
      } as ContentBlock);
    }

    for (const tc of toolCalls) {
      content.push({
        type: 'tool_use',
        id: `gemini-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        // Gemini's API speaks proto3's JSON mapping, where a null field is
        // unset: null args, like absent ones, are a call with no arguments.
        ...toolUseInputFromValue(tc.args ?? undefined),
      });
    }

    return content;
  }

  // A prompt blocked BEFORE generation comes back as a 200 with
  // promptFeedback.blockReason and no candidate data at all — no data.error, no
  // finishReason — so it used to read as an empty, clean end_turn. complete()
  // and stream() both resolve here so the two paths cannot drift apart again.
  private resolveStopReason(
    sawCandidateData: boolean,
    candidateFinishReason: string | undefined,
    promptFeedback: GeminiResponse['promptFeedback']
  ): string {
    const promptBlockReason = sawCandidateData ? undefined : promptFeedback?.blockReason;
    // A prompt blocked before generation is a refusal whatever reason Google
    // gives (SAFETY, OTHER, BLOCKLIST, BLOCK_REASON_UNSPECIFIED, ...): nothing
    // was generated. providerStopReason keeps the reason itself.
    return promptBlockReason !== undefined
      ? 'refusal'
      : this.mapFinishReason(candidateFinishReason);
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      // Every generation-blocking safety enum, not just the two that were
      // mapped: the rest reported as a clean end_turn with empty content.
      case 'SAFETY':
      case 'RECITATION':
      case 'PROHIBITED_CONTENT':
      case 'BLOCKLIST':
      case 'SPII':
      case 'IMAGE_SAFETY':
        return 'refusal';
      case 'TOOL_CALLS':
      case 'FUNCTION_CALL':
        return 'tool_use';
      case undefined:
        return 'end_turn';
      // MALFORMED_FUNCTION_CALL, LANGUAGE, OTHER and anything Google adds
      // next have no membrane member; they travel as the provider's own
      // token. Membrane normalizes it to end_turn, since callers switch on a
      // closed union, and discloses it on details.stop.providerReason and in
      // a log line, so it doesn't pass for a clean end silently.
      default:
        return reason;
    }
  }

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (isDeadlineAbort(error)) return deadlineTimeoutError(error, rawRequest);
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    if (isTypedAbortError(error)) return abortError(undefined, rawRequest);

    const info = classifyError(error);
    info.rawRequest = rawRequest;
    return new MembraneError(info);
  }
}

// ============================================================================
// Content Conversion Utilities
// ============================================================================

/**
 * Convert normalized content blocks to Gemini parts
 */
export function toGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks.map(block => {
    if (block.type === 'text') {
      return { text: (block as any).text };
    }
    if (block.type === 'tool_use') {
      return {
        functionCall: {
          name: (block as any).name,
          args: (block as any).input ?? {},
        },
      };
    }
    return { text: String(block) };
  });
}

/**
 * Convert Gemini parts to normalized content blocks
 */
export function fromGeminiParts(parts: GeminiPart[]): ContentBlock[] {
  const result: ContentBlock[] = [];

  for (const part of parts) {
    if (part.text) {
      result.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      result.push({
        type: 'tool_use',
        id: `gemini-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        // As in the adapter's response: null args are unset (proto3 JSON).
        ...toolUseInputFromValue(part.functionCall.args ?? undefined),
      });
    }
  }

  return result;
}
