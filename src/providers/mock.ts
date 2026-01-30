/**
 * Mock Provider Adapter for testing
 *
 * Returns canned responses without calling any real LLM API.
 * Useful for testing the framework without API costs.
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../types/provider.js';

export interface MockAdapterConfig {
  /** Default response text when no specific response is configured */
  defaultResponse?: string;

  /** Simulated delay in ms for complete() calls */
  completeDelayMs?: number;

  /** Simulated delay in ms between stream chunks */
  streamChunkDelayMs?: number;

  /** Size of chunks when streaming (characters) */
  streamChunkSize?: number;

  /** If true, echo back the last user message */
  echoMode?: boolean;

  /** Queue of responses to return (FIFO, then falls back to default) */
  responseQueue?: string[];

  /** Function to generate response based on request */
  responseGenerator?: (request: ProviderRequest) => string;
}

const DEFAULT_CONFIG: Required<Omit<MockAdapterConfig, 'responseGenerator'>> = {
  defaultResponse: 'This is a mock response from the test adapter.',
  completeDelayMs: 10,
  streamChunkDelayMs: 5,
  streamChunkSize: 10,
  echoMode: false,
  responseQueue: [],
};

/**
 * Mock adapter for testing without real LLM calls.
 */
export class MockAdapter implements ProviderAdapter {
  readonly name = 'mock';

  private config: Required<Omit<MockAdapterConfig, 'responseGenerator'>> & Pick<MockAdapterConfig, 'responseGenerator'>;
  private responseQueue: string[];
  private requestLog: Array<{ timestamp: number; request: ProviderRequest }> = [];

  constructor(config: MockAdapterConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.responseQueue = [...(config.responseQueue ?? [])];
  }

  supportsModel(_modelId: string): boolean {
    return true;
  }

  /**
   * Add a response to the queue.
   */
  queueResponse(response: string): void {
    this.responseQueue.push(response);
  }

  /**
   * Add multiple responses to the queue.
   */
  queueResponses(responses: string[]): void {
    this.responseQueue.push(...responses);
  }

  /**
   * Clear the response queue.
   */
  clearQueue(): void {
    this.responseQueue = [];
  }

  /**
   * Get the request log.
   */
  getRequestLog(): Array<{ timestamp: number; request: ProviderRequest }> {
    return [...this.requestLog];
  }

  /**
   * Get the last request made.
   */
  getLastRequest(): ProviderRequest | undefined {
    return this.requestLog[this.requestLog.length - 1]?.request;
  }

  /**
   * Clear the request log.
   */
  clearRequestLog(): void {
    this.requestLog = [];
  }

  /**
   * Reset the adapter (clear queue and request log).
   */
  reset(): void {
    this.clearQueue();
    this.clearRequestLog();
  }

  /**
   * Get the response for a request.
   */
  private getResponse(request: ProviderRequest): string {
    // Log the request
    this.requestLog.push({ timestamp: Date.now(), request });

    // Try queued response first
    if (this.responseQueue.length > 0) {
      return this.responseQueue.shift()!;
    }

    // Try response generator
    if (this.config.responseGenerator) {
      return this.config.responseGenerator(request);
    }

    // Echo mode - reflect back the last user message
    if (this.config.echoMode) {
      const lastMessage = request.messages[request.messages.length - 1];
      if (lastMessage && typeof lastMessage === 'object') {
        const content = (lastMessage as any).content;
        if (typeof content === 'string') {
          return `[Echo] ${content}`;
        }
        if (Array.isArray(content)) {
          const textBlock = content.find((b: any) => b.type === 'text');
          if (textBlock) {
            return `[Echo] ${textBlock.text}`;
          }
        }
      }
      return '[Echo] (no text found in last message)';
    }

    // Default response
    return this.config.defaultResponse;
  }

  async complete(
    request: ProviderRequest,
    _options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    // Simulate processing delay
    if (this.config.completeDelayMs > 0) {
      await this.sleep(this.config.completeDelayMs);
    }

    const responseText = this.getResponse(request);

    return {
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
      usage: {
        inputTokens: this.estimateTokens(JSON.stringify(request.messages)),
        outputTokens: this.estimateTokens(responseText),
      },
      model: request.model,
      rawRequest: request,
      raw: { mock: true, responseText },
    };
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const responseText = this.getResponse(request);

    // Stream the response in chunks
    let offset = 0;
    while (offset < responseText.length) {
      const chunk = responseText.slice(offset, offset + this.config.streamChunkSize);
      callbacks.onChunk(chunk);
      offset += this.config.streamChunkSize;

      if (offset < responseText.length && this.config.streamChunkDelayMs > 0) {
        await this.sleep(this.config.streamChunkDelayMs);
      }
    }

    return {
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
      usage: {
        inputTokens: this.estimateTokens(JSON.stringify(request.messages)),
        outputTokens: this.estimateTokens(responseText),
      },
      model: request.model,
      rawRequest: request,
      raw: { mock: true, responseText },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Create a mock adapter with echo mode enabled.
 */
export function createEchoAdapter(config?: Omit<MockAdapterConfig, 'echoMode'>): MockAdapter {
  return new MockAdapter({ ...config, echoMode: true });
}

/**
 * Create a mock adapter with specific canned responses.
 */
export function createCannedAdapter(responses: string[], config?: Omit<MockAdapterConfig, 'responseQueue'>): MockAdapter {
  return new MockAdapter({ ...config, responseQueue: responses });
}
