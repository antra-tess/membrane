import { unreportedUsage } from '../utils/usage.js';
import { assertPromptToolSupport } from './request-capabilities.js';

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
  isTypedAbortError,
  withRawRequest,
} from '../types/index.js';
import { errorFromThrown } from '../types/errors.js';
import { createCombinedSignal, SSELineParser, isDeadlineAbort, deadlineTimeoutError, throwOnStreamErrorFrame, assertTerminalEventObserved, isEventObject, callerAbort } from './utils.js';
import { isRawItemCarrier } from '../utils/fidelity.js';

interface CompletionsRequest {
  model: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

interface CompletionsResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    text: string;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAICompletionsAdapterConfig {
  /** Base URL for the API (required, e.g., 'http://localhost:8000/v1') */
  baseURL: string;

  /** API key (optional for local servers) */
  apiKey?: string;

  /** Provider name for logging/identification (default: 'openai-completions') */
  providerName?: string;

  /** Default max tokens */
  defaultMaxTokens?: number;

  /** Additional headers to include with requests */
  extraHeaders?: Record<string, string>;

  /**
   * Name of the assistant participant (default: 'Assistant'). The prompt
   * ends with it as the completion's prefix (`Name:`), and it gets no stop
   * sequence of its own among the participant ones.
   */
  assistantName?: string;

  /**
   * End-of-turn token to append after each message (default: '<|eot|>')
   * Set to empty string or null to disable.
   *
   * Example output with default:
   *   Alice: Hello<|eot|>
   *
   *   Claude: Hi there!<|eot|>
   */
  eotToken?: string | null;

  /**
   * Additional stop sequences beyond auto-generated participant-based ones.
   * By default, stop sequences are generated from participant names in the
   * conversation (e.g., "\n\nAlice:", "\nBob:").
   */
  extraStopSequences?: string[];

  /**
   * Whether to warn when images are stripped from context (default: true)
   */
  warnOnImageStrip?: boolean;
}

export class OpenAICompletionsAdapter implements ProviderAdapter {
  readonly name: string;

  /** NOT ESTABLISHED: legacy /v1/completions against arbitrary vendors. */
  readonly usageCacheConvention = 'unknown' as const;
  private baseURL: string;
  private apiKey: string;
  private defaultMaxTokens: number;
  private extraHeaders: Record<string, string>;
  private assistantName: string;
  private eotToken: string;
  private extraStopSequences: string[];
  private warnOnImageStrip: boolean;

  constructor(config: OpenAICompletionsAdapterConfig) {
    if (!config.baseURL) {
      throw new Error('OpenAI completions adapter requires baseURL');
    }

    this.name = config.providerName ?? 'openai-completions';
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};
    this.assistantName = config.assistantName ?? 'Assistant';
    this.eotToken = config.eotToken === null ? '' : (config.eotToken ?? '<|eot|>');
    this.extraStopSequences = config.extraStopSequences ?? [];
    this.warnOnImageStrip = config.warnOnImageStrip ?? true;
  }

  supportsModel(_modelId: string): boolean {
    return true;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const completionsRequest = this.buildRequest(request, options);
    options?.onRequest?.(completionsRequest);

    try {
      const response = await this.makeRequest(completionsRequest, options);
      return this.parseResponse(response, request.model, completionsRequest);
    } catch (error) {
      throw callerAbort(options?.signal, error, completionsRequest) ?? this.handleError(error, completionsRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const completionsRequest = this.buildRequest(request, options);
    completionsRequest.stream = true;
    // Ask for usage in the stream — without this the endpoint sends no usage
    // frame at all and every streamed call reports 0/0 tokens.
    completionsRequest.stream_options = { include_usage: true };
    options?.onRequest?.(completionsRequest);

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(completionsRequest),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), completionsRequest);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      const sseParser = new SSELineParser();
      let accumulated = '';
      let finishReason: string | undefined;
      let sawTerminalEvent = false;
      let streamUsage: CompletionsResponse['usage'] | undefined;

      // Some backends leak the eotToken, sent as an API stop string, into streamed output.
      const eot = this.eotToken;
      let emittedLen = 0;
      let eotFound = false;

      const processDataLine = (data: string): void => {
        if (data === '[DONE]') {
          sawTerminalEvent = true;
          return;
        }

        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (!isEventObject(parsed)) return;
        options?.onProgress?.();

        throwOnStreamErrorFrame(parsed, this.name, completionsRequest);

        const text = parsed.choices?.[0]?.text;

        if (text) {
          accumulated += text;
          const idx = eot ? accumulated.indexOf(eot) : -1;
          if (idx !== -1) {
            accumulated = accumulated.slice(0, idx);
            if (accumulated.length > emittedLen) {
              callbacks.onChunk(accumulated.slice(emittedLen));
            }
            emittedLen = accumulated.length;
            eotFound = true;
            sawTerminalEvent = true;
          } else if (eot) {
            const safeLen = Math.max(emittedLen, accumulated.length - (eot.length - 1));
            if (safeLen > emittedLen) {
              callbacks.onChunk(accumulated.slice(emittedLen, safeLen));
              emittedLen = safeLen;
            }
          } else {
            callbacks.onChunk(text);
          }
        }

        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
          sawTerminalEvent = true;
        }

        if (parsed.usage) {
          streamUsage = parsed.usage;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          for (const data of sseParser.feed(chunk)) {
            processDataLine(data);
            if (eotFound) break;
          }
          if (eotFound) break;
        }

        // A final `data:` line can arrive without its trailing newline: servers and
        // proxies close right after writing the last event.
        if (!eotFound) {
          for (const data of sseParser.flush()) {
            processDataLine(data);
            if (eotFound) break;
          }
        }

        if (eot && !eotFound && accumulated.length > emittedLen) {
          callbacks.onChunk(accumulated.slice(emittedLen));
        }
      } finally {
        // An unread body holds the connection: cancel it, without waiting on a
        // cancel that may never settle, so the provider stops sending. After a full
        // read it does nothing.
        void reader.cancel().catch(() => {});
      }

      assertTerminalEventObserved(sawTerminalEvent, this.name, completionsRequest);

      return this.buildStreamedResponse(accumulated, finishReason, request.model, streamUsage, completionsRequest, eotFound);

    } catch (error) {
      throw callerAbort(options?.signal, error, completionsRequest) ?? this.handleError(error, completionsRequest);
    } finally {
      cleanup?.();
    }
  }

  /**
   * Serialize messages to "Participant: content<eot>" format for base models.
   * Uses actual participant names from messages.
   * Images are stripped from content.
   */
  serializeToPrompt(messages: any[]): { prompt: string; participants: Set<string> } {
    const parts: string[] = [];
    const participants = new Set<string>();
    let hasStrippedImages = false;

    for (const msg of messages) {
      const participant = msg.participant || msg.role || 'Unknown';
      participants.add(participant);

      const textContent = this.extractTextContent(msg.content);
      if (textContent.hadImages) {
        hasStrippedImages = true;
      }

      if (textContent.text) {
        const eot = this.eotToken;
        parts.push(`${participant}: ${textContent.text}${eot}`);
      }
    }

    if (hasStrippedImages && this.warnOnImageStrip) {
      console.warn('[OpenAICompletionsAdapter] Images were stripped from context (not supported in completions mode)');
    }

    parts.push(`${this.assistantName}:`);

    return {
      prompt: parts.join('\n\n'),
      participants,
    };
  }

  private generateStopSequences(participants: Set<string>): string[] {
    const stops: string[] = [];

    for (const participant of participants) {
      if (participant === this.assistantName) continue;

      stops.push(`\n\n${participant}:`);
      stops.push(`\n${participant}:`);
    }

    return stops;
  }

  private extractTextContent(content: any): { text: string; hadImages: boolean } {
    if (typeof content === 'string') {
      return { text: content, hadImages: false };
    }

    if (Array.isArray(content)) {
      const textParts: string[] = [];
      let hadImages = false;

      for (const block of content) {
        if (block.type === 'text') {
          if (isRawItemCarrier(block)) continue;
          textParts.push(block.text);
        } else if (block.type === 'image' || block.type === 'image_url') {
          hadImages = true;
        }
      }

      return { text: textParts.join('\n'), hadImages };
    }

    return { text: '', hadImages: false };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private buildRequest(request: ProviderRequest, options?: ProviderRequestOptions): CompletionsRequest {
    let prompt: string;
    let stopSequences: string[];

    const extra = request.extra ?? {};
    const { messages: _messages, tools: extraTools, normalizedMessages, prompt: explicitPrompt, ...rest } = extra;
    const hasNormalizedMessages = normalizedMessages !== undefined || 'normalizedMessages' in Object(extra);
    const promptMessages = hasNormalizedMessages ? normalizedMessages : options?.promptMessages;
    assertPromptToolSupport(request, options, this.name, { kind: 'xml-prompt', prompt: explicitPrompt, extraTools });

    if (typeof explicitPrompt === 'string') {
      prompt = explicitPrompt;
      stopSequences = [
        ...this.extraStopSequences,
        ...(request.stopSequences || []),
      ];
    } else {
      const messages = (promptMessages as any[]) || (request.messages as any[]);
      const result = this.serializeToPrompt(messages);
      prompt = result.prompt;
      stopSequences = [
        ...this.generateStopSequences(result.participants),
        ...(this.eotToken ? [this.eotToken] : []),
        ...this.extraStopSequences,
        ...(request.stopSequences || []),
      ];
    }

    const params: CompletionsRequest = {
      model: request.model,
      prompt,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
    };

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.topP !== undefined) {
      params.top_p = request.topP;
    }

    if (request.presencePenalty !== undefined) {
      params.presence_penalty = request.presencePenalty;
    }

    if (request.frequencyPenalty !== undefined) {
      params.frequency_penalty = request.frequencyPenalty;
    }

    if (request.repetitionPenalty !== undefined) {
      params.repetition_penalty = request.repetitionPenalty;
    }

    if (stopSequences.length > 0) {
      params.stop = stopSequences;
    }

    Object.assign(params, rest);

    return params;
  }

  private async makeRequest(request: CompletionsRequest, options?: ProviderRequestOptions): Promise<CompletionsResponse> {
    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request),
        signal: combinedSignal,
      });

      if (!response.ok) {
        throw errorFromHttpResponse(this.name, response, await response.text(), request);
      }

      const body: unknown = await response.json();
      // A 200 can carry the provider's error, as a stream frame can.
      throwOnStreamErrorFrame(body, this.name, request, 'response error');
      return body as CompletionsResponse;
    } finally {
      cleanup?.();
    }
  }

  private parseResponse(response: CompletionsResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    let text = choice?.text ?? '';

    // Some backends leak the eotToken into the output.
    if (this.eotToken) {
      const idx = text.indexOf(this.eotToken);
      if (idx !== -1) {
        text = text.slice(0, idx);
      }
    }

    return {
      content: this.textToContent(text),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      providerStopReason: choice?.finish_reason ?? undefined,
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      ...unreportedUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private buildStreamedResponse(
    accumulated: string,
    finishReason: string | undefined,
    requestedModel: string,
    streamUsage?: CompletionsResponse['usage'],
    rawRequest?: unknown,
    endedAtEot = false
  ): ProviderResponse {
    return {
      content: this.textToContent(accumulated),
      stopReason: endedAtEot ? 'end_turn' : this.mapFinishReason(finishReason),
      providerStopReason: finishReason,
      stopSequence: undefined,
      usage: {
        // An endpoint that ignores stream_options sends no usage frame.
        inputTokens: streamUsage?.prompt_tokens ?? 0,
        outputTokens: streamUsage?.completion_tokens ?? 0,
      },
      ...unreportedUsage(streamUsage?.prompt_tokens, streamUsage?.completion_tokens),
      model: requestedModel,
      rawRequest,
      raw: { text: accumulated, finish_reason: finishReason ?? 'stop', usage: streamUsage },
    };
  }

  private textToContent(text: string): ContentBlock[] {
    const trimmed = text.replace(/^\s+/, '');

    if (!trimmed) return [];

    return [{ type: 'text', text: trimmed }];
  }

  private mapFinishReason(reason: string | undefined): string {
    if (reason == null) return 'end_turn';
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'refusal';
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
