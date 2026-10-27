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
  errorFromHttpResponse,
  errorFromProviderStatus,
  isTypedAbortError,
  withRawRequest,
} from '../types/index.js';
import { errorFromThrown } from '../types/errors.js';
import { isRawItemCarrier } from '../utils/fidelity.js';
import { imageForRequest, GEMINI_IMAGE_TYPES } from '../utils/image-media.js';
import { convertMcpMedia } from '../utils/mcp-media.js';
import { createCombinedSignal, textOnlyToolResultContent, toolUseInputFromValue, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved, isEventObject } from './utils.js';

interface GeminiPart {
  text?: string;
  /**
   * Set on a part that is the model's reasoning rather than its answer. Its
   * `text` is a thought (a summary or the trace itself), so it is kept out of
   * the answer: Google's own samples read the answer as the text of parts
   * where `thought` is not set. Gemini returns such parts when the request
   * sets `thinkingConfig.includeThoughts`. An image model's interim "thought
   * images" are flagged too, and are kept out of the answer's images.
   */
  thought?: boolean;
  /** Opaque reasoning state; may ride any part. */
  thoughtSignature?: string;
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
  /**
   * The tool's `inputSchema`, as JSON Schema. Gemini's other field,
   * `parameters`, takes only its OpenAPI-subset `Schema`, where a `type` is a
   * single value and `$schema`, `$defs`, `$ref` and `const` are unknown
   * fields, so a schema using any of them fails the whole request.
   */
  parametersJsonSchema?: Record<string, unknown>;
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
     */
    thoughtsTokenCount?: number;
    /**
     * Tokens of the prompts Gemini's built-in tools add, such as code
     * execution's intermediate tokens or URL context's retrieved pages.
     * DISJOINT from promptTokenCount: Google defines totalTokenCount as
     * "prompt + tool-use prompt + thoughts + response candidates".
     */
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
  error?: { code: number; message: string; status: string };
}

interface GeminiStreamState {
  text: string;
  thinking: string;
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
 * Gemini's API speaks proto3's JSON mapping, where a null field is unset, so
 * a candidate whose content and finishReason are null or absent carries no
 * data.
 */
function hasCandidateData(candidate: NonNullable<GeminiResponse['candidates']>[number] | undefined): boolean {
  return candidate?.content != null || candidate?.finishReason != null;
}

/**
 * Gemini's usageMetadata follows proto3 JSON, which omits zero-valued counts:
 * when the object is present, a missing prompt, candidates or cache-read
 * count is a reported 0.
 */
function geminiUnreportedUsage(usageMetadata: GeminiResponse['usageMetadata']): { unreportedUsage?: Array<'inputTokens' | 'outputTokens'> } {
  return usageMetadata ? {} : { unreportedUsage: ['inputTokens', 'outputTokens'] };
}

/**
 * Google bills `thoughtsTokenCount`, disjoint from `candidatesTokenCount`, at
 * the output rate, and `toolUsePromptTokenCount`, disjoint from
 * `promptTokenCount`, as input (code execution's intermediate tokens, URL
 * context's retrieved content, file search's retrieved documents).
 * Grounding, with Google Search or Google Maps, is billed per query or per
 * grounded prompt instead, and for text models Google doesn't say whether
 * grounding's retrieved context is counted in the tool-use prompt; a
 * response that used grounding and another tool reports one count, which
 * can't be split.
 */
function geminiUsageToProviderUsage(
  usageMetadata: GeminiResponse['usageMetadata']
): ProviderResponse['usage'] {
  const promptTokens = usageMetadata?.promptTokenCount ?? 0;
  const toolUsePromptTokens = usageMetadata?.toolUsePromptTokenCount ?? 0;
  const candidatesTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thoughtsTokens = usageMetadata?.thoughtsTokenCount;
  const totalTokens = usageMetadata?.totalTokenCount;

  const cachedTokens = usageMetadata
    ? (typeof usageMetadata.cachedContentTokenCount === 'number' ? usageMetadata.cachedContentTokenCount : 0)
    : undefined;
  const promptExcludesCache = cachedTokens !== undefined && cachedTokens > promptTokens;

  if (usageMetadata && totalTokens != null) {
    const accountedTokens = promptTokens + toolUsePromptTokens + candidatesTokens + (thoughtsTokens ?? 0);
    const largestSum = promptExcludesCache ? accountedTokens + cachedTokens : accountedTokens;
    const reconciles = accountedTokens === totalTokens || largestSum === totalTokens;
    if (!reconciles) {
      const fields = promptExcludesCache
        ? 'prompt, tool-use prompt, cached, candidates and thoughts'
        : 'prompt, tool-use prompt, candidates and thoughts';
      console.warn(
        `[membrane:gemini] usageMetadata does not reconcile: promptTokenCount(${promptTokens})`
        + ` + toolUsePromptTokenCount(${toolUsePromptTokens})`
        + ` + candidatesTokenCount(${candidatesTokens}) + thoughtsTokenCount(${thoughtsTokens ?? 0})`
        + ` = ${accountedTokens}`
        + (promptExcludesCache ? ` (${largestSum} with cachedContentTokenCount(${cachedTokens}))` : '')
        + `, but totalTokenCount = ${totalTokens}.`
        + (totalTokens > largestSum ? ` Some billed tokens are in a usageMetadata field outside ${fields}.` : '')
      );
    }
  }
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
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
    ...(promptExcludesCache ? { cacheConvention: 'cache-excluded' as const } : {}),
  };
}

let warnedPromptExcludesCache = false;

export function resetPromptExcludesCacheWarning(): void {
  warnedPromptExcludesCache = false;
}

export interface GeminiAdapterConfig {
  /** Google AI API key */
  apiKey?: string;

  /** Base URL (default: https://generativelanguage.googleapis.com/v1beta) */
  baseURL?: string;

  /** Default max output tokens */
  defaultMaxTokens?: number;
}

const GEMINI_MAX_STOP_SEQUENCES = 5;

export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini';

  /**
   * Cache-inclusive: `promptTokenCount` (read into `inputTokens`, beside the
   * tool-use prompt) counts the cached span `cachedContentTokenCount` (read
   * as `cacheReadTokens`) reports, so membrane subtracts it to reach the
   * fresh input.
   *
   * Google's UsageMetadata reference says `promptTokenCount` is "Number of
   * tokens in the prompt. When cachedContent is set, this is still the total
   * effective prompt size meaning this includes the number of tokens in the
   * cached content", and that `totalTokenCount` is "prompt + tool-use prompt +
   * thoughts + response candidates", with no cached term of its own. For
   * implicit caching, googleapis/python-genai#2064 shows the prompt count is
   * the whole prompt whether the cache hit or not. A response whose cached
   * count exceeds its prompt count can't be read the inclusive way, so it is
   * read as cache-excluded, with a warning.
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
        // Gemini can send an error object inside an HTTP 200.
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
        thinking: '',
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
        // An unread body holds the connection: cancel it, so the provider stops
        // sending. After a full read it does nothing.
        void reader.cancel().catch(() => {});
      }

      assertTerminalEventObserved(
        streamState.sawTerminalEvent || (!streamState.sawCandidateData && streamState.promptFeedback?.blockReason !== undefined),
        'Gemini',
        geminiRequest,
      );

      return {
        content: this.buildContentBlocks(streamState.text, streamState.toolCalls, streamState.images, streamState.thinking),
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
      return;
    }
    if (!isEventObject(parsed)) return;
    onProgress?.();
    throwOnStreamErrorFrame(parsed, 'Gemini', rawRequest);
    if (parsed.modelVersion) streamState.lastModelVersion = parsed.modelVersion;
    const candidate = parsed.candidates?.[0];

    if (hasCandidateData(candidate)) {
      streamState.sawCandidateData = true;
    }

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text && part.thought) {
          streamState.thinking += part.text;
        } else if (part.text) {
          streamState.text += part.text;
          callbacks.onChunk(part.text);
        }
        // A thought image is a draft the model reasoned with, not its answer.
        if (part.inlineData && !part.thought) {
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

    // A blocked prompt can ride a frame of its own, with zero candidates. A
    // null blockReason, proto3's JSON for an unset field, blocks nothing, so it
    // neither ends the stream nor replaces a reason an earlier frame gave.
    if (parsed.promptFeedback?.blockReason != null) {
      streamState.promptFeedback = parsed.promptFeedback;
    }

    if (parsed.usageMetadata) {
      streamState.lastUsage = parsed.usageMetadata;
    }
  }

  private buildRequest(request: ProviderRequest): GeminiRequest {
    const contents = this.convertMessages(convertMcpMedia(request.messages as any[]), request.model);
    const maxTokens = request.maxTokens || this.defaultMaxTokens;

    const geminiRequest: GeminiRequest = { contents };

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
      geminiRequest.generationConfig.stopSequences = request.stopSequences.slice(0, GEMINI_MAX_STOP_SEQUENCES);
    }

    if (request.model?.includes('image')) {
      geminiRequest.generationConfig.responseModalities = ['TEXT', 'IMAGE'];
    }

    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = [{
        functionDeclarations: this.convertTools(request.tools as any[]),
      }];
    }

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

    // Gemini 3.x requires thought_signature on model-role image parts, and an
    // image that round-trips through another store (such as Discord) loses it
    // (400 INVALID_ARGUMENT). Gemini fetches a URL given as text, so a gemini-3
    // model-role image with a sourceUrl goes as its URL; one without still goes
    // as inlineData.
    const useUrlForModelImages = model?.startsWith('gemini-3');

    for (const msg of messages) {
      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const parts: GeminiPart[] = [];
        const toolResultParts: GeminiPart[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text) parts.push({ text: block.text });
          } else if (block.type === 'image') {
            if (useUrlForModelImages && role === 'model' && block.sourceUrl) {
              parts.push({ text: block.sourceUrl });
              continue;
            }

            const source = block.source;
            if (source?.type === 'base64') {
              const { mediaType, placeholder } = imageForRequest(source.data, source.media_type ?? source.mediaType, GEMINI_IMAGE_TYPES);
              parts.push(placeholder
                ? { text: placeholder.text }
                : { inlineData: { mimeType: mediaType, data: source.data } });
            }
          } else if (block.type === 'audio') {
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

        if (toolResultParts.length > 0) {
          contents.push({ role: 'user', parts: toolResultParts });
        }

        if (parts.length > 0) {
          contents.push({ role, parts });
        }

        continue;
      }

      if (msg.content === null || msg.content === undefined) continue;

      contents.push({ role, parts: [{ text: String(msg.content) }] });
    }

    return this.mergeConsecutiveRoles(contents);
  }

  /** Gemini requires strictly alternating user/model messages. */
  private mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
    if (contents.length === 0) return contents;

    const merged: GeminiContent[] = [contents[0]!];

    for (let i = 1; i < contents.length; i++) {
      const current = contents[i]!;
      const last = merged[merged.length - 1]!;

      if (current.role === last.role) {
        last.parts.push(...current.parts);
      } else {
        merged.push(current);
      }
    }

    // Gemini also requires the first message to be "user"
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
        parametersJsonSchema: schema,
      };
    });
  }

  private parseResponse(
    response: GeminiResponse,
    requestedModel: string,
    rawRequest: unknown
  ): ProviderResponse {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    let text = '';
    let thinking = '';
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const images: { data: string; mimeType: string }[] = [];

    for (const part of parts) {
      if (part.text && part.thought) thinking += part.text;
      else if (part.text) text += part.text;
      // A thought image is a draft the model reasoned with, not its answer.
      if (part.inlineData && !part.thought) {
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
      content: this.buildContentBlocks(text, toolCalls, images, thinking),
      stopReason: this.resolveStopReason(
        hasCandidateData(candidate),
        candidate?.finishReason,
        response.promptFeedback
      ),
      providerStopReason: candidate?.finishReason ?? (!hasCandidateData(candidate) ? response.promptFeedback?.blockReason : undefined) ?? undefined,
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
    images: { data: string; mimeType: string }[] = [],
    thinking = ''
  ): ContentBlock[] {
    const content: ContentBlock[] = [];

    // Gemini's thoughtSignature may ride any part, so it doesn't belong to this block.
    if (thinking) {
      content.push({ type: 'thinking', thinking });
    }

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

  private resolveStopReason(
    sawCandidateData: boolean,
    candidateFinishReason: string | undefined,
    promptFeedback: GeminiResponse['promptFeedback']
  ): string {
    const promptBlockReason = sawCandidateData ? undefined : promptFeedback?.blockReason;
    return promptBlockReason != null
      ? 'refusal'
      : this.mapFinishReason(candidateFinishReason);
  }

  private mapFinishReason(reason: string | undefined): string {
    if (reason == null) return 'end_turn';
    switch (reason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
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
      default:
        return reason;
    }
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (isDeadlineAbort(error)) return deadlineTimeoutError(error, rawRequest);
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    if (isTypedAbortError(error)) return abortError(undefined, rawRequest);

    return errorFromThrown(error, rawRequest, this.baseURL);
  }
}

/**
 * Convert normalized content blocks to Gemini parts
 */
export function toGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks.filter(block => (block.type === 'text' && !isRawItemCarrier(block)) || block.type === 'tool_use').map(block => {
    if (block.type === 'text') {
      return { text: (block as any).text };
    }
    return {
      functionCall: {
        name: (block as any).name,
        args: (block as any).input ?? {},
      },
    };
  });
}

/**
 * Convert Gemini parts to normalized content blocks, in part order: a part
 * with text becomes a text block, or a thinking block where it fell if it is
 * a thought, and a function call becomes a tool_use block. Other parts, and
 * parts with empty text, add no block.
 */
export function fromGeminiParts(parts: GeminiPart[]): ContentBlock[] {
  const result: ContentBlock[] = [];

  for (const part of parts) {
    if (part.text && part.thought) {
      result.push({ type: 'thinking', thinking: part.text });
    } else if (part.text) {
      result.push({ type: 'text', text: part.text });
    }
    if (part.functionCall) {
      result.push({
        type: 'tool_use',
        id: `gemini-tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        // null args are unset (proto3 JSON).
        ...toolUseInputFromValue(part.functionCall.args ?? undefined),
      });
    }
  }

  return result;
}
