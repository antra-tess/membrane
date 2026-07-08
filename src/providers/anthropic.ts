/**
 * Anthropic provider adapter
 */

import Anthropic from '@anthropic-ai/sdk';
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
  invalidRequestError,
  authError,
  serverError,
  abortError,
} from '../types/index.js';
import { flattenRootSchemaUnion } from './anthropic-tool-schema.js';

// ============================================================================
// Model capability gates
// ============================================================================

/**
 * Models that reject the sampling parameters (`temperature`, `top_p`,
 * `top_k`) with a 400 invalid_request_error — which Membrane classifies as
 * non-retryable, so a single stray `temperature` kills the whole turn.
 * Mirrors the `noTemperatureSupport` gate in the OpenAI provider.
 *
 * This is the always-on-thinking / reasoning-forward tier, which removes the
 * sampling parameters from the API surface entirely (Sonnet 5 rejects only
 * non-default values). Everything else — Haiku 4.5, Sonnet 4.6, Opus 4.6 and
 * older — ACCEPTS `temperature`, so it must NOT be listed here.
 *
 *   - Opus 4.7 / Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 / Mythos preview:
 *     documented 400 on any sampling parameter.
 *
 * NB: claude-haiku-4-5 was previously listed here on the strength of a single
 * "observed 400 in production when temperature is sent" anecdote. Haiku 4.5
 * documentably supports `temperature`; the production 400 was almost certainly
 * the `extra`-params bypass fixed in this same PR (a sampling param smuggled
 * through `extra` and re-inserted after the gate — 400s on any model), not a
 * capability of Haiku. Listing it silently discarded a valid parameter on the
 * most common cheap model, so it has been removed.
 *
 * Prefix-matched, so dated snapshots (e.g. claude-opus-4-8-20251001) are
 * covered. Keep this list updated as models launch.
 */
const NO_TEMPERATURE_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
];

/**
 * Check if a model doesn't support custom sampling parameters
 */
function noTemperatureSupport(model: string): boolean {
  return NO_TEMPERATURE_MODELS.some(prefix => model.startsWith(prefix));
}

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface AnthropicAdapterConfig {
  /** API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  
  /** Base URL override */
  baseURL?: string;
  
  /** Default max tokens */
  defaultMaxTokens?: number;
}

// ============================================================================
// Anthropic Adapter
// ============================================================================

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  private client: Anthropic;
  private defaultMaxTokens: number;

  constructor(config: AnthropicAdapterConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('claude-');
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const anthropicRequest = this.buildRequest(request);
    const fullRequest = { ...anthropicRequest, stream: false as const };
    options?.onRequest?.(fullRequest);

    try {
      const response = await this.client.messages.create(fullRequest, {
        signal: options?.signal,
      });

      return this.parseResponse(response, fullRequest);
    } catch (error) {
      throw this.handleError(error, fullRequest);
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const anthropicRequest = this.buildRequest(request);
    // Note: stream is implicitly true when using .stream()
    const fullRequest = { ...anthropicRequest, stream: true };
    options?.onRequest?.(fullRequest);

    // Idle timeout: abort if no SSE event arrives within the deadline.
    // The SDK's timeout only covers the initial HTTP response headers;
    // once streaming starts, a silently dropped connection waits forever.
    const idleMs = options?.idleTimeoutMs ?? 120_000;
    const idleAbort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimedOut = false;

    // Link caller's signal so external cancellation still works
    const onExternalAbort = () => idleAbort.abort();
    if (options?.signal) {
      if (options.signal.aborted) { idleAbort.abort(); }
      else { options.signal.addEventListener('abort', onExternalAbort, { once: true }); }
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimedOut = true; idleAbort.abort(); }, idleMs);
    };

    resetIdleTimer();

    try {
      const stream = await this.client.messages.stream(anthropicRequest, {
        signal: idleAbort.signal,
      });

      // Accumulate response metadata from SSE events directly, so we can
      // skip finalMessage() and its variable-latency connection teardown.
      let model = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens: number | undefined;
      let cacheReadTokens: number | undefined;
      let stopReason: string = 'end_turn';
      let stopSequence: string | undefined;
      let stopDetails: unknown;

      // Content block tracking — finalized on content_block_stop
      const contentBlocks: Record<string, unknown>[] = [];
      let currentBlockIndex = -1;
      let currentBlockContent = '';
      let currentBlockInputJson = '';
      // When wrapThinkingTags is set (XML formatter path), native thinking
      // deltas are wrapped in <thinking>...</thinking> on the chunk stream so
      // the tag-based parser tracks them as thinking instead of visible text.
      // Tag opened lazily on the first delta — display:'omitted' models emit
      // thinking blocks with no thinking_delta at all (signature only).
      const wrapThinkingTags = options?.wrapThinkingTags === true;
      let thinkingTagOpen = false;

      for await (const event of stream) {
        resetIdleTimer();
        if (event.type === 'message_start') {
          model = event.message.model;
          const usage = event.message.usage as unknown as Record<string, number>;
          inputTokens = usage.input_tokens ?? 0;
          cacheCreationTokens = usage.cache_creation_input_tokens;
          cacheReadTokens = usage.cache_read_input_tokens;

        } else if (event.type === 'content_block_start') {
          currentBlockIndex = event.index;
          currentBlockContent = '';
          currentBlockInputJson = '';
          contentBlocks[currentBlockIndex] = { ...event.content_block };
          callbacks.onContentBlock?.(currentBlockIndex, event.content_block);

        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            currentBlockContent += chunk;
            callbacks.onChunk(chunk);
          } else if (event.delta.type === 'thinking_delta') {
            currentBlockContent += event.delta.thinking;
            if (wrapThinkingTags && !thinkingTagOpen) {
              callbacks.onChunk('<thinking>');
              thinkingTagOpen = true;
            }
            callbacks.onChunk(event.delta.thinking);
          } else if ((event.delta as { type: string }).type === 'signature_delta') {
            // Accumulate the cryptographic signature that authenticates this
            // thinking block. Without this, signatures never land on the
            // streaming path and the next request — which carries the block
            // back in history — fails Anthropic's signature validation.
            const sig = (event.delta as { signature?: string }).signature;
            const block = contentBlocks[currentBlockIndex];
            if (block && block.type === 'thinking' && sig) {
              block.signature = ((block.signature as string | undefined) ?? '') + sig;
            }
          } else if ((event.delta as { type: string }).type === 'input_json_delta') {
            currentBlockInputJson += (event.delta as { partial_json: string }).partial_json;
          }

        } else if (event.type === 'content_block_stop') {
          // Finalize block — use event.index for defensive correctness
          const blockIdx = (event as { index: number }).index;
          const block = contentBlocks[blockIdx];
          if (block) {
            if (block.type === 'text') {
              block.text = currentBlockContent;
            } else if (block.type === 'thinking') {
              block.thinking = currentBlockContent;
              if (thinkingTagOpen) {
                callbacks.onChunk('</thinking>\n');
                thinkingTagOpen = false;
              }
            } else if (block.type === 'tool_use' && currentBlockInputJson) {
              try { block.input = JSON.parse(currentBlockInputJson); } catch { /* partial JSON */ }
            }
          }
          callbacks.onContentBlock?.(blockIdx, contentBlocks[blockIdx]);

        } else if (event.type === 'message_delta') {
          // All content blocks are finalized by the time message_delta arrives.
          // Capture final metadata and exit — message_stop and the SSE connection
          // teardown after it add only variable latency with no useful data.
          const delta = event.delta as {
            stop_reason?: string;
            stop_sequence?: string;
            stop_details?: unknown;
          };
          stopReason = delta.stop_reason ?? 'end_turn';
          stopSequence = delta.stop_sequence ?? undefined;
          // stop_details carries refusal metadata (e.g., category: 'reasoning_extraction')
          stopDetails = delta.stop_details ?? undefined;
          const deltaUsage = event.usage as unknown as {
            output_tokens: number;
            cache_creation_input_tokens?: number | null;
            cache_read_input_tokens?: number | null;
          };
          outputTokens = deltaUsage.output_tokens ?? 0;
          // message_delta carries cumulative cache metrics — use as authoritative
          if (deltaUsage.cache_creation_input_tokens != null) {
            cacheCreationTokens = deltaUsage.cache_creation_input_tokens;
          }
          if (deltaUsage.cache_read_input_tokens != null) {
            cacheReadTokens = deltaUsage.cache_read_input_tokens;
          }
          break;
        }
      }

      // Clean up idle timer and external signal listener
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      // Force-close the HTTP connection so we don't block on SSE drain
      try { stream.controller.abort(); } catch { /* already closed */ }

      return {
        content: contentBlocks,
        stopReason,
        stopSequence,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
        },
        model,
        rawRequest: fullRequest,
        raw: {
          content: contentBlocks,
          stop_reason: stopReason,
          stop_sequence: stopSequence ?? null,
          stop_details: stopDetails ?? null,
          model,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
          },
        },
      };

    } catch (error) {
      // Clean up timer on error path too
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);

      if (idleTimedOut && error instanceof Error && error.name === 'AbortError') {
        throw new MembraneError({
          type: 'timeout',
          message: `SSE stream idle timeout — no events received within ${idleMs}ms`,
          retryable: true,
          rawError: error,
          rawRequest: fullRequest,
        });
      }
      throw this.handleError(error, fullRequest);
    }
  }

  private buildRequest(request: ProviderRequest): Anthropic.MessageCreateParams {
    // Strip provider-specific fields (e.g., sourceUrl for Gemini) from image blocks
    // before sending to Anthropic, which rejects extra inputs.
    // Also normalize nested tool_result content blocks: Membrane uses camelCase
    // `mediaType`, Anthropic expects snake_case `media_type`. Without this,
    // an image returned by a tool reaches the API as `{source: {mediaType: ...}}`
    // and is silently rejected (the model sees the text label only).
    const sanitizedMessages = (request.messages as any[]).map((msg: any) => {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map((block: any) => {
          if (block.type === 'image' && block.sourceUrl !== undefined) {
            const { sourceUrl, ...rest } = block;
            return rest;
          }
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            return {
              ...block,
              content: toAnthropicToolResultContent(block.content as ContentBlock[]),
            };
          }
          return block;
        }),
      };
    });

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: sanitizedMessages as Anthropic.MessageParam[],
    };
    
    // Handle system prompt - can be string or content blocks with cache_control
    if (request.system) {
      if (typeof request.system === 'string') {
        params.system = request.system;
      } else if (Array.isArray(request.system)) {
        // System is an array of content blocks (with potential cache_control)
        params.system = request.system as Anthropic.TextBlockParam[];
      }
    }
    
    // Sampling-parameter gates:
    //   - Some models reject temperature/top_p/top_k outright with a 400
    //     (see NO_TEMPERATURE_MODELS) — strip rather than let the whole
    //     inference die on a non-retryable invalid_request_error.
    //   - Extended thinking rejects custom temperature/top_k on every model
    //     (only the defaults are accepted while thinking is on) — strip those
    //     too when a thinking config is present and not disabled.
    const stripSampling = noTemperatureSupport(request.model);
    // Thinking can arrive top-level OR smuggled through `extra` — the same
    // `Object.assign(params, rest)` below installs `extra.thinking` into the
    // request AFTER this gate ran. Resolve from both sources so an enabled
    // thinking config strips sampling params no matter where it came from;
    // otherwise `extra: { thinking, temperature }` reproduces the exact 400
    // this gate exists to prevent (same bug class as the extra-sampling bypass,
    // one field over).
    const extraThinking = (request.extra as { thinking?: { type?: string } } | undefined)?.thinking;
    const thinkingConfig = request.thinking ?? extraThinking;
    const thinkingOn = thinkingConfig !== undefined && thinkingConfig.type !== 'disabled';

    if (request.temperature !== undefined && !stripSampling && !thinkingOn) {
      params.temperature = request.temperature;
    }

    // Anthropic API rejects requests with both temperature and top_p set.
    // When both are provided, prefer temperature (more commonly tuned) and drop top_p.
    // With thinking on, top_p is only accepted in [0.95, 1] — strip values below.
    if (
      request.topP !== undefined &&
      params.temperature === undefined &&
      !stripSampling &&
      (!thinkingOn || request.topP >= 0.95)
    ) {
      params.top_p = request.topP;
    }

    if (request.topK !== undefined && !stripSampling && !thinkingOn) {
      params.top_k = request.topK;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop_sequences = request.stopSequences;
    }
    
    if (request.tools && request.tools.length > 0) {
      // MCP allows a root-level oneOf/anyOf/allOf in a tool's input schema,
      // but the Anthropic API rejects it ("input_schema does not support
      // oneOf, allOf, or anyOf at the top level") — one bad tool 400s the
      // entire inference. Flatten such roots into a single object schema
      // before shipping (see anthropic-tool-schema.ts).
      params.tools = (request.tools as Anthropic.Tool[]).map(tool => {
        const inputSchema = (tool as { input_schema?: unknown }).input_schema;
        const flattened = flattenRootSchemaUnion(inputSchema);
        return flattened === inputSchema
          ? tool
          : ({ ...tool, input_schema: flattened } as Anthropic.Tool);
      });
    }

    // Handle extended thinking
    if (request.thinking) {
      (params as any).thinking = request.thinking;
    }

    // Apply extra params, excluding internal membrane fields
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      // Sampling params passed through `extra` must obey the same gates as the
      // top-level ones. Otherwise a caller passing e.g. `extra: { temperature }`
      // for a reject-list model (or under extended thinking) would re-insert the
      // stripped value here — via Object.assign, after the gate above — and
      // reproduce the exact non-retryable 400 this stripping is meant to prevent.
      if (stripSampling || thinkingOn) {
        delete rest.temperature;
        delete rest.top_k;
        // top_p is accepted in [0.95, 1] while thinking is on, but never when
        // the model rejects sampling params outright.
        const extraTopP = rest.top_p;
        if (stripSampling || typeof extraTopP !== 'number' || extraTopP < 0.95) {
          delete rest.top_p;
        }
      }
      Object.assign(params, rest);
    }

    return params;
  }

  private parseResponse(response: Anthropic.Message, rawRequest: unknown): ProviderResponse {
    return {
      content: response.content,
      stopReason: response.stop_reason ?? 'end_turn',
      stopSequence: response.stop_sequence ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: (response.usage as any).cache_creation_input_tokens,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens,
      },
      model: response.model,
      rawRequest,
      raw: response,
    };
  }

  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (error instanceof Anthropic.APIError) {
      // Mid-stream SSE `error` events are rethrown by the SDK as APIError
      // with status === undefined (sdk core/streaming.js), so the HTTP
      // status branches below would never match them — overloaded_error
      // (529) most commonly arrives exactly this way and used to fall
      // through to `unknown, retryable: false`. Recover the effective
      // status from the error body's type instead.
      const bodyType = (error.error as { error?: { type?: string } } | undefined)?.error?.type;
      const status = error.status ?? (bodyType !== undefined ? {
        invalid_request_error: 400,
        authentication_error: 401,
        permission_error: 403,
        not_found_error: 404,
        request_too_large: 413,
        rate_limit_error: 429,
        api_error: 500,
        overloaded_error: 529,
      }[bodyType] : undefined);
      const message = error.message;

      if (status === 429) {
        // Try to parse retry-after
        const retryAfter = this.parseRetryAfter(error);
        return rateLimitError(message, retryAfter, error, rawRequest);
      }

      if (status === 401) {
        return authError(message, error, rawRequest);
      }

      if (message.includes('context') || message.includes('too long')) {
        return contextLengthError(message, error, rawRequest);
      }

      // 400 invalid_request_error — malformed payload (e.g. orphan tool_use_id,
      // unknown model, schema violation). Retrying with the same payload is
      // guaranteed to produce the same 400, so classify these as non-retryable
      // here. Previously these fell through to the generic `unknown` branch
      // below, which left them with `retryable: false` but also with no
      // structured type — making framework-level error policies unable to
      // distinguish them from genuinely unknown errors.
      if (status === 400) {
        return invalidRequestError(message, error, rawRequest);
      }

      if (status !== undefined && status >= 500) {
        return serverError(message, status, error, rawRequest);
      }

      // Safety net: if the SSE error body wasn't parseable JSON, neither
      // status nor bodyType resolves — match the message itself rather
      // than let a transient capacity error become non-retryable.
      if (message.toLowerCase().includes('overloaded')) {
        return serverError(message, 529, error, rawRequest);
      }

      // Vercel AI Gateway wraps transient upstream outages (a fallback
      // provider 503, routing churn on a sunsetting model) in non-5xx
      // aggregate errors whose body carries gateway routing metadata. The
      // SAME request frequently succeeds on retry once a live provider is
      // picked, so classify these as retryable instead of terminal.
      const gw = message.toLowerCase();
      if (gw.includes("providermetadata") || gw.includes("fallbacksavailable") ||
          gw.includes("modelattempts") || gw.includes("temporarily unavailable") ||
          gw.includes("no_providers_available")) {
        return serverError(message, status ?? 503, error, rawRequest);
      }
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return abortError(undefined, rawRequest);
    }

    return new MembraneError({
      type: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      rawError: error,
      rawRequest,
    });
  }

  private parseRetryAfter(error: { message: string }): number | undefined {
    // Try to extract retry-after from headers or message
    const message = error.message;
    const match = message.match(/retry after (\d+)/i);
    if (match && match[1]) {
      return parseInt(match[1], 10) * 1000;
    }
    return undefined;
  }
}

// ============================================================================
// Content Conversion Utilities
// ============================================================================

/**
 * Convert Membrane tool-result content blocks to Anthropic's tool_result.content
 * mixed array (text + image). This is what carries an image returned by a tool
 * (e.g. an MCP fetch_attachment result) all the way to the model. Other block
 * types are not valid inside tool_result.content per the Anthropic API and are
 * dropped.
 */
function toAnthropicToolResultContent(
  blocks: ContentBlock[],
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  const out: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      if (block.source.type === 'base64') {
        out.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: detectImageMediaType(block.source.data, block.source.mediaType as string) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: block.source.data,
          },
        });
      } else if (block.source.type === 'url') {
        out.push({
          type: 'image',
          source: { type: 'url', url: block.source.url },
        });
      }
    }
  }
  return out;
}

/**
 * Convert normalized content blocks to Anthropic format
 * Preserves cache_control for prompt caching
 */

/** Detect image media type from the base64 payload's magic bytes. Storage/ingest
 *  can lose or mislabel mediaType (e.g. a PNG tagged image/jpeg), which the
 *  Anthropic API rejects with a 400. Trust the bytes; fall back to the declared
 *  type, then jpeg. */
function detectImageMediaType(data: string | undefined, fallback?: string): string {
  try {
    const b = Buffer.from((data || "").slice(0, 24), "base64");
    if (b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47) return "image/png";
    if (b[0]===0xff&&b[1]===0xd8&&b[2]===0xff) return "image/jpeg";
    if (b[0]===0x47&&b[1]===0x49&&b[2]===0x46) return "image/gif";
    if (b[0]===0x52&&b[1]===0x49&&b[2]===0x46) return "image/webp";
  } catch {}
  const f = (fallback || "").toLowerCase();
  if (f==="image/jpeg"||f==="image/png"||f==="image/gif"||f==="image/webp") return f;
  return "image/jpeg";
}

export function toAnthropicContent(blocks: ContentBlock[]): Anthropic.ContentBlockParam[] {
  const result: Anthropic.ContentBlockParam[] = [];
  
  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const textBlock: any = { type: 'text', text: block.text };
        // Preserve cache_control if present
        if (block.cache_control) {
          textBlock.cache_control = block.cache_control;
        }
        result.push(textBlock);
        break;
      }
        
      case 'image':
        if (block.source.type === 'base64') {
          result.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: detectImageMediaType(block.source.data, block.source.mediaType as string) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: block.source.data,
            },
          });
        } else if (block.source.type === 'url') {
          result.push({
            type: 'image',
            source: { type: 'url', url: block.source.url },
          });
        }
        break;
        
      case 'document':
        result.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.source.mediaType as 'application/pdf',
            data: block.source.data,
          },
        });
        break;
        
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
        
      case 'tool_result':
        result.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: typeof block.content === 'string'
            ? block.content
            : toAnthropicToolResultContent(block.content),
          is_error: block.isError,
        });
        break;
        
      case 'thinking':
        result.push({
          type: 'thinking',
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {}),
        } as any);
        break;

      case 'redacted_thinking':
        // Round-trip verbatim — `data` is the encrypted reasoning payload;
        // the API rejects/ignores the block without it.
        result.push({
          type: 'redacted_thinking',
          data: (block as any).data,
        } as any);
        break;
    }
  }

  return result;
}

/**
 * Convert Anthropic response content to normalized format
 */
export function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        result.push({ type: 'text', text: block.text });
        break;
        
      case 'tool_use':
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
        break;
        
      case 'thinking':
        result.push({
          type: 'thinking',
          thinking: (block as any).thinking,
          signature: (block as any).signature,
        });
        break;
        
      default:
        // Handle redacted_thinking or unknown types
        if ((block as any).type === 'redacted_thinking') {
          // Preserve the encrypted `data` payload — without it the block
          // cannot be round-tripped and prior reasoning is lost.
          result.push({ type: 'redacted_thinking', data: (block as any).data } as any);
        }
        break;
    }
  }
  
  return result;
}
