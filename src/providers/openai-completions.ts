/**
 * OpenAI-Compatible Completions adapter for base models
 *
 * For true base/completion models that use the `/v1/completions` endpoint:
 * - No chat formatting built-in
 * - Single text prompt input
 * - Raw completion output
 * - No image support
 *
 * Serializes conversations to Human:/Assistant: format.
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
  rateLimitError,
  contextLengthError,
  authError,
  serverError,
  abortError,
  networkError,
} from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

interface CompletionsRequest {
  model: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
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

// ============================================================================
// Adapter Configuration
// ============================================================================

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
   * Stop sequences to use (default: ['\n\nHuman:', '\nHuman:'])
   * These prevent the model from generating user turns.
   */
  defaultStopSequences?: string[];

  /**
   * Whether to warn when images are stripped from context (default: true)
   */
  warnOnImageStrip?: boolean;
}

// ============================================================================
// OpenAI Completions Adapter
// ============================================================================

export class OpenAICompletionsAdapter implements ProviderAdapter {
  readonly name: string;
  private baseURL: string;
  private apiKey: string;
  private defaultMaxTokens: number;
  private extraHeaders: Record<string, string>;
  private defaultStopSequences: string[];
  private warnOnImageStrip: boolean;

  constructor(config: OpenAICompletionsAdapterConfig) {
    if (!config.baseURL) {
      throw new Error('OpenAI completions adapter requires baseURL');
    }

    this.name = config.providerName ?? 'openai-completions';
    this.baseURL = config.baseURL.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey ?? '';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.extraHeaders = config.extraHeaders ?? {};
    this.defaultStopSequences = config.defaultStopSequences ?? ['\n\nHuman:', '\nHuman:'];
    this.warnOnImageStrip = config.warnOnImageStrip ?? true;
  }

  supportsModel(_modelId: string): boolean {
    return true;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const completionsRequest = this.buildRequest(request);

    try {
      const response = await this.makeRequest(completionsRequest, options);
      return this.parseResponse(response, request.model, completionsRequest);
    } catch (error) {
      throw this.handleError(error, completionsRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const completionsRequest = this.buildRequest(request);
    completionsRequest.stream = true;

    try {
      const response = await fetch(`${this.baseURL}/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(completionsRequest),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let accumulated = '';
      let finishReason = 'stop';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const text = parsed.choices?.[0]?.text;

            if (text) {
              accumulated += text;
              callbacks.onChunk(text);
            }

            if (parsed.choices?.[0]?.finish_reason) {
              finishReason = parsed.choices[0].finish_reason;
            }
          } catch {
            // Ignore parse errors in stream
          }
        }
      }

      return this.buildStreamedResponse(accumulated, finishReason, request.model, completionsRequest);

    } catch (error) {
      throw this.handleError(error, completionsRequest);
    }
  }

  // ============================================================================
  // Prompt Serialization
  // ============================================================================

  /**
   * Serialize messages to Human:/Assistant: format for base models.
   * Images are stripped from content.
   */
  serializeToPrompt(messages: any[]): string {
    const parts: string[] = [];
    let hasStrippedImages = false;

    for (const msg of messages) {
      const role = this.normalizeRole(msg.role);
      const prefix = role === 'user' ? 'Human:' : 'Assistant:';

      // Extract text content, strip images
      const textContent = this.extractTextContent(msg.content);
      if (textContent.hadImages) {
        hasStrippedImages = true;
      }

      if (textContent.text) {
        parts.push(`${prefix} ${textContent.text}`);
      }
    }

    if (hasStrippedImages && this.warnOnImageStrip) {
      console.warn('[OpenAICompletionsAdapter] Images were stripped from context (not supported in completions mode)');
    }

    // Add final Assistant: prefix to prompt completion
    parts.push('Assistant:');

    return parts.join('\n\n');
  }

  private normalizeRole(role: string): 'user' | 'assistant' {
    if (role === 'user' || role === 'human' || role === 'Human') {
      return 'user';
    }
    return 'assistant';
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
          textParts.push(block.text);
        } else if (block.type === 'image' || block.type === 'image_url') {
          hadImages = true;
        }
        // Skip tool_use, tool_result, thinking blocks for base models
      }

      return { text: textParts.join('\n'), hadImages };
    }

    return { text: '', hadImages: false };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

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

  private buildRequest(request: ProviderRequest): CompletionsRequest {
    const prompt = this.serializeToPrompt(request.messages as any[]);

    const params: CompletionsRequest = {
      model: request.model,
      prompt,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
    };

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    // Combine default stop sequences with any provided ones
    const stopSequences = [
      ...this.defaultStopSequences,
      ...(request.stopSequences || []),
    ];
    if (stopSequences.length > 0) {
      params.stop = stopSequences;
    }

    // Apply extra params (but not messages/tools which don't apply)
    if (request.extra) {
      const { messages, tools, ...rest } = request.extra as any;
      Object.assign(params, rest);
    }

    return params;
  }

  private async makeRequest(request: CompletionsRequest, options?: ProviderRequestOptions): Promise<CompletionsResponse> {
    const response = await fetch(`${this.baseURL}/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<CompletionsResponse>;
  }

  private parseResponse(response: CompletionsResponse, requestedModel: string, rawRequest: unknown): ProviderResponse {
    const choice = response.choices[0];
    const text = choice?.text ?? '';

    return {
      content: this.textToContent(text),
      stopReason: this.mapFinishReason(choice?.finish_reason),
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model ?? requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private buildStreamedResponse(
    accumulated: string,
    finishReason: string,
    requestedModel: string,
    rawRequest?: unknown
  ): ProviderResponse {
    return {
      content: this.textToContent(accumulated),
      stopReason: this.mapFinishReason(finishReason),
      stopSequence: undefined,
      usage: {
        inputTokens: 0, // Not available in streaming
        outputTokens: 0,
      },
      model: requestedModel,
      rawRequest,
      raw: { text: accumulated, finish_reason: finishReason },
    };
  }

  private textToContent(text: string): ContentBlock[] {
    // Trim leading whitespace (model often starts with space after "Assistant:")
    const trimmed = text.replace(/^\s+/, '');

    if (!trimmed) return [];

    return [{ type: 'text', text: trimmed }];
  }

  private mapFinishReason(reason: string | undefined): string {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('429') || message.includes('rate')) {
        return rateLimitError(message, undefined, error, rawRequest);
      }

      if (message.includes('401') || message.includes('auth') || message.includes('Unauthorized')) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long') || message.includes('maximum context')) {
        return contextLengthError(message, error, rawRequest);
      }

      if (message.includes('500') || message.includes('502') || message.includes('503')) {
        return serverError(message, undefined, error, rawRequest);
      }

      if (error.name === 'AbortError') {
        return abortError(undefined, rawRequest);
      }

      if (message.includes('network') || message.includes('fetch') || message.includes('ECONNREFUSED')) {
        return networkError(message, error, rawRequest);
      }
    }

    return new MembraneError({
      type: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      rawError: error,
      rawRequest,
    });
  }
}
