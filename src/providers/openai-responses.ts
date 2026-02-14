/**
 * OpenAI Images API provider adapter
 *
 * Adapter for OpenAI's Images API endpoints, used for image generation
 * models like `gpt-image-1`:
 *
 * - `/v1/images/generations` — text-to-image (no image input)
 * - `/v1/images/edits` — image editing (accepts input images + prompt)
 *
 * The adapter automatically selects the right endpoint:
 * - If conversation contains images → uses /edits with images as data URLs
 * - If text-only → uses /generations
 *
 * Both endpoints:
 * - Take a single `prompt` string (not conversation messages)
 * - Return base64-encoded images in `data[].b64_json`
 * - No streaming support (returns complete image)
 * - Support `size`, `quality`, `n`, `background`, `output_format`
 *
 * Note: File retains the name openai-responses.ts and class name
 * OpenAIResponsesAdapter for compatibility with existing factory
 * routing and vendor configs (`openairesponses-*` prefix).
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
// Images API Types
// ============================================================================

interface ImagesGenerateRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  [key: string]: unknown;
}

interface ImagesEditRequest {
  model: string;
  prompt: string;
  image: string[];  // base64 data URLs
  n?: number;
  size?: string;
  quality?: string;
  [key: string]: unknown;
}

type ImagesRequest = ImagesGenerateRequest | ImagesEditRequest;

interface ImagesResponseData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface ImagesAPIResponse {
  created: number;
  data: ImagesResponseData[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      text_tokens?: number;
      image_tokens?: number;
    };
    output_tokens_details?: {
      image_tokens?: number;
    };
  };
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface OpenAIResponsesAdapterConfig {
  /** API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;

  /** Base URL (default: https://api.openai.com/v1) */
  baseURL?: string;

  /** Organization ID (optional) */
  organization?: string;

  /** Default max output tokens (unused by Images API, kept for interface compat) */
  defaultMaxTokens?: number;

  /**
   * Whether to allow image editing via /v1/images/edits when images
   * are present in the conversation context. When true (default),
   * the adapter auto-detects images and routes to the edits endpoint.
   * When false, always uses /v1/images/generations (text-only).
   */
  allowImageEditing?: boolean;
}

// ============================================================================
// OpenAI Images Adapter
// ============================================================================

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly name = 'openai-responses';
  private apiKey: string;
  private baseURL: string;
  private organization?: string;
  private allowImageEditing: boolean;

  constructor(config: OpenAIResponsesAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.organization = config.organization;
    this.allowImageEditing = config.allowImageEditing ?? true;

    if (!this.apiKey) {
      throw new Error('OpenAI API key not provided');
    }
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gpt-image');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const inputImages = this.allowImageEditing ? this.extractImages(request) : [];
    const isEdit = inputImages.length > 0;
    const endpoint = isEdit ? 'images/edits' : 'images/generations';
    const imagesRequest = this.buildRequest(request, inputImages);
    options?.onRequest?.(imagesRequest);

    try {
      const fetchOptions: RequestInit = {
        method: 'POST',
        signal: options?.signal,
      };

      if (isEdit) {
        // /v1/images/edits requires multipart/form-data with file uploads
        const formData = new FormData();
        formData.append('model', imagesRequest.model);
        formData.append('prompt', imagesRequest.prompt);
        if (imagesRequest.n != null) formData.append('n', String(imagesRequest.n));
        if (imagesRequest.quality) formData.append('quality', String(imagesRequest.quality));
        if (imagesRequest.size) formData.append('size', String(imagesRequest.size));

        // Convert base64 data URLs to Blobs and append as file uploads
        for (const dataUrl of inputImages) {
          const { buffer, mimeType } = this.dataUrlToBuffer(dataUrl);
          const ext = mimeType.split('/')[1] || 'png';
          const blob = new Blob([buffer], { type: mimeType });
          formData.append('image[]', blob, `image.${ext}`);
        }

        // Auth header only — don't set Content-Type, let fetch set multipart boundary
        fetchOptions.headers = {
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.organization ? { 'OpenAI-Organization': this.organization } : {}),
        };
        fetchOptions.body = formData;
      } else {
        // /v1/images/generations accepts JSON
        fetchOptions.headers = this.getHeaders();
        fetchOptions.body = JSON.stringify(imagesRequest);
      }

      const response = await fetch(`${this.baseURL}/${endpoint}`, fetchOptions);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Images API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as ImagesAPIResponse;
      return this.parseResponse(data, request.model, imagesRequest);
    } catch (error) {
      throw this.handleError(error, imagesRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    // Images API doesn't support streaming — do a full request
    // and emit any text content as a single chunk
    const response = await this.complete(request, options);

    const blocks = response.content as ContentBlock[];
    for (const block of blocks) {
      if (block.type === 'text' && (block as any).text) {
        callbacks.onChunk((block as any).text);
      }
    }

    return response;
  }

  // --------------------------------------------------------------------------
  // Request Building
  // --------------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    return headers;
  }

  /**
   * Extract base64 images from conversation messages as data URLs.
   * Used to determine whether to use /edits (with images) or /generations.
   * Returns up to 16 images (OpenAI limit for /v1/images/edits).
   */
  private extractImages(request: ProviderRequest): string[] {
    const dataUrls: string[] = [];
    const MAX_IMAGES = 16;

    if (!request.messages) return dataUrls;

    for (const msg of request.messages as any[]) {
      if (!Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (dataUrls.length >= MAX_IMAGES) break;

        if (block.type === 'image') {
          const source = block.source;
          if (source?.type === 'base64' && source.data) {
            const mimeType = source.media_type ?? source.mediaType ?? 'image/png';
            dataUrls.push(`data:${mimeType};base64,${source.data}`);
          }
        }
      }
    }

    return dataUrls;
  }

  /**
   * Convert a base64 data URL to a Buffer + mimeType for file upload.
   */
  private dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match || !match[1] || !match[2]) {
      throw new Error('Invalid data URL format');
    }
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  private buildRequest(request: ProviderRequest, inputImages: string[]): ImagesRequest {
    const prompt = this.flattenToPrompt(request);

    const imagesRequest: ImagesRequest = {
      model: request.model,
      prompt,
      n: 1,
      quality: 'auto',
    };

    // Include input images for the /edits endpoint
    if (inputImages.length > 0) {
      (imagesRequest as ImagesEditRequest).image = inputImages;
    }

    // Apply extra params (allow overriding size, quality, n, etc.)
    if (request.extra) {
      const { normalizedMessages, prompt: _p, ...rest } = request.extra as Record<string, unknown>;
      Object.assign(imagesRequest, rest);
    }

    return imagesRequest;
  }

  /**
   * Flatten conversation messages into a single prompt string.
   *
   * The Images API takes a single text prompt, not a conversation.
   * We include the system prompt as context and concatenate all
   * message text with role labels so the model understands the
   * full conversation when deciding what image to generate.
   */
  private flattenToPrompt(request: ProviderRequest): string {
    const parts: string[] = [];

    // Include system prompt as context
    if (request.system) {
      const systemText =
        typeof request.system === 'string'
          ? request.system
          : (request.system as any[])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');

      if (systemText) {
        parts.push(systemText);
      }
    }

    // Extract text from messages with role labels
    if (request.messages) {
      for (const msg of request.messages as any[]) {
        const role = msg.role === 'assistant' ? 'Assistant' : 'User';
        let text = '';

        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('\n');
        }

        if (text) {
          parts.push(`${role}: ${text}`);
        }
      }
    }

    return parts.join('\n\n');
  }

  // --------------------------------------------------------------------------
  // Response Parsing
  // --------------------------------------------------------------------------

  private parseResponse(
    response: ImagesAPIResponse,
    requestedModel: string,
    rawRequest: unknown
  ): ProviderResponse {
    const images: { data: string; mimeType: string }[] = [];
    let revisedPrompt: string | undefined;

    for (const item of response.data) {
      if (item.b64_json) {
        images.push({
          data: item.b64_json,
          mimeType: 'image/png',
        });
      }
      if (item.revised_prompt) {
        revisedPrompt = item.revised_prompt;
      }
    }

    return {
      content: this.buildContentBlocks(revisedPrompt, images),
      stopReason: 'end_turn',
      stopSequence: undefined,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      model: requestedModel,
      rawRequest,
      raw: response,
    };
  }

  private buildContentBlocks(
    text: string | undefined,
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

    return content;
  }

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof MembraneError) return error;

    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('429') || message.includes('rate_limit')) {
        const retryMatch = message.match(/retry after (\d+)/i);
        const retryAfter = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : undefined;
        return rateLimitError(message, retryAfter, error, rawRequest);
      }

      if (
        message.includes('401') ||
        message.includes('invalid_api_key') ||
        message.includes('Incorrect API key')
      ) {
        return authError(message, error, rawRequest);
      }

      if (
        message.includes('context_length') ||
        message.includes('maximum context') ||
        message.includes('too long')
      ) {
        return contextLengthError(message, error, rawRequest);
      }

      if (
        message.includes('content_policy') ||
        message.includes('safety_system') ||
        message.includes('moderation')
      ) {
        return new MembraneError({
          type: 'unknown',
          message: `Content policy violation: ${message}`,
          retryable: false,
          rawError: error,
          rawRequest,
        });
      }

      if (
        message.includes('500') ||
        message.includes('502') ||
        message.includes('503') ||
        message.includes('server_error')
      ) {
        return serverError(message, undefined, error, rawRequest);
      }

      if (error.name === 'AbortError') {
        return abortError(undefined, rawRequest);
      }

      if (
        message.includes('network') ||
        message.includes('fetch') ||
        message.includes('ECONNREFUSED')
      ) {
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
