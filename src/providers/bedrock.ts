/**
 * AWS Bedrock provider adapter for Anthropic Claude models
 *
 * Uses the Anthropic Messages API format through AWS Bedrock.
 */

import { unreportedUsage } from '../utils/usage.js';
import { assertMessagePrefillSupported } from './request-capabilities.js';

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
  invalidRequestError,
  abortError,
  errorFromHttpResponse,
  errorFromProviderStatus,
  isTypedAbortError,
  networkError,
  withRawRequest,
} from '../types/index.js';
import { errorFromThrown } from '../types/errors.js';
import { stripEmptyTextRequest } from '../utils/empty-text.js';
import { isUnsignedThinking } from '../utils/thinking-carriers.js';
import { createCombinedSignal, isDeadlineAbort, deadlineTimeoutError, assertTerminalEventObserved, toolUseInputFromText, toolUseInputFromValue, streamIndex, isEventObject, isToolCallBlock, isToolCallArgumentsDelta, contentOfAnthropicEvent } from './utils.js';
import {
  INTERLEAVED_THINKING_BETA,
  THINKING_BINDING_BETA,
  THINKING_DISPLAY_UPDATES_BETA,
  needsInterleavedThinkingBeta,
  readInputTransformations,
  readRefusalCategory,
  sendsBlockBinding,
  sendsDisplayUpdates,
  thinkingEnabled,
} from './anthropic.js';
import { imageForRequest, urlImageForRequest } from '../utils/image-media.js';
import { convertMcpMedia, isSourcelessMedia } from '../utils/mcp-media.js';

// ============================================================================
// Adapter Configuration
// ============================================================================

export interface BedrockAdapterConfig {
  /** AWS access key ID */
  accessKeyId?: string;

  /** AWS secret access key */
  secretAccessKey?: string;

  /** AWS region (defaults to us-west-2) */
  region?: string;

  /** AWS session token (for temporary credentials) */
  sessionToken?: string;

  /** Default max tokens */
  defaultMaxTokens?: number;

  /** Anthropic API version header (defaults to 2023-06-01) */
  anthropicVersion?: string;

  /**
   * Endpoint override (no trailing slash), e.g. an inference gateway leg
   * like `https://gate.animalabs.ai/bedrock/apse1`. Defaults to
   * `https://bedrock-runtime.{region}.amazonaws.com`. When pointing at a
   * gateway, set accessKeyId to the gate token — the gateway reads it from
   * the SigV4 Credential field, discards the client signature, and re-signs
   * with real AWS creds that never leave the gateway box.
   */
  baseURL?: string;
}

// ============================================================================
// Bedrock Request/Response Types
// ============================================================================

interface BedrockMessageRequest {
  anthropic_version: string;
  max_tokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }>;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  /** As membrane builds it: enabled with a budget, or adaptive, either with
   *  `display` and binding controls when they're set. */
  thinking?:
    | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' | 'updates'; block_binding?: { prefix_mismatch_behavior: 'error' | 'drop_block' } }
    | { type: 'adaptive'; display?: 'summarized' | 'omitted' | 'updates'; block_binding?: { prefix_mismatch_behavior: 'error' | 'drop_block' } };
  /** Beta flags. On bedrock-runtime these ride in the body, not a header. */
  anthropic_beta?: string[];
}

interface BedrockMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text' | 'tool_use' | 'thinking';
    text?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    input?: unknown;
    /** Set by the stream assembly, never by Bedrock (ToolUseContent.unparseableInput). */
    unparseableInput?: string;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence?: string | null;
  /**
   * With a refusal, its details, as AWS documents for a non-streamed body
   * (Claude Messages API on Bedrock): `category`, such as 'cyber', and an
   * explanation. AWS's page doesn't show it in a stream's events; the stream's
   * final message carries it when a message_delta did.
   */
  stop_details?: unknown;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** The thinking-binding report (with THINKING_BINDING_BETA). */
  input_transformations?: unknown;
}

interface BedrockStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string;
    /** On a refusal's message_delta, if Bedrock passes it on (see BedrockMessageResponse.stop_details). */
    stop_details?: unknown;
  };
  message?: BedrockMessageResponse;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  /** On message_delta, after a server-side model fallback: the serving model's report. */
  input_transformations?: unknown;
}

/**
 * Bedrock accepts `cache_control: { type: 'ephemeral' }` but rejects the
 * direct-API `ttl` extension ("cache_control.ttl: Extra inputs are not
 * permitted"). Drop the ttl, keep the marker — the cache still works, at
 * Bedrock's fixed default TTL.
 */
function stripCacheTtl<T extends Record<string, any>>(block: T): T {
  if (block?.cache_control && typeof block.cache_control === 'object' && 'ttl' in block.cache_control) {
    const { ttl, ...cacheControl } = block.cache_control;
    return { ...block, cache_control: cacheControl };
  }
  return block;
}

// ============================================================================
// AWS Signature V4 Implementation
// ============================================================================

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

async function signRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string | undefined,
  region: string,
  service: string
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = getAmzDate();

  // Prepare headers for signing
  const signedHeaders: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-date': amzDate,
  };

  if (sessionToken) {
    signedHeaders['x-amz-security-token'] = sessionToken;
  }

  // Create canonical request
  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map(k => `${k.toLowerCase()}:${signedHeaders[k]?.trim()}`)
    .join('\n') + '\n';
  const signedHeadersList = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
  const payloadHash = await sha256(body);

  // URI-encode path components for canonical request (AWS SigV4 requirement)
  // AWS requires double-encoding: %3A in the URL becomes %253A in the canonical request
  // We encode each segment without decoding first to achieve double-encoding
  const canonicalUri = url.pathname
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  const canonicalRequest = [
    method,
    canonicalUri,
    url.search.slice(1), // Remove leading '?'
    canonicalHeaders,
    signedHeadersList,
    payloadHash,
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  // Calculate signature
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Create authorization header
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return {
    ...signedHeaders,
    authorization,
  };
}

// ============================================================================
// Bedrock Adapter
// ============================================================================

export class BedrockAdapter implements ProviderAdapter {
  readonly name = 'bedrock';
  /**
   * Reports what it leaves out: whitespace-only text its cleanup removes, an
   * image whose data the API doesn't accept, which goes as the placeholder
   * (at the top level or nested in a tool result), and a passthrough
   * `messages` that replaces the built ones. Otherwise it carries message
   * content as built, nested tool-result blocks included; only wire fields
   * (sourceUrl, cache ttl, media_type spelling) change.
   */
  readonly reportsContentAlterations = true;
  readonly cacheReceiptBasis = 'wire-request' as const;

  /**
   * Bedrock serves Anthropic models over the Anthropic Messages payload shape
   * and this adapter reads Anthropic's own field names
   * (`cache_read_input_tokens` / `cache_creation_input_tokens`), so it inherits
   * the convention verified live against api.anthropic.com on 2026-08-25.
   * Derived from the wire contract, not measured against Bedrock directly.
   */
  readonly usageCacheConvention = 'cache-excluded' as const;

  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  private region: string;
  private defaultMaxTokens: number;
  private anthropicVersion: string;
  private baseURL?: string;

  constructor(config: BedrockAdapterConfig = {}) {
    this.accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? '';
    this.secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? '';
    this.sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN;
    this.region = config.region ?? process.env.AWS_REGION ?? 'us-west-2';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.anthropicVersion = config.anthropicVersion ?? 'bedrock-2023-05-31';
    this.baseURL = config.baseURL?.replace(/\/$/, '');

    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('AWS credentials required: accessKeyId and secretAccessKey');
    }
  }

  supportsModel(modelId: string): boolean {
    // Support both Bedrock model IDs and standard Claude model IDs
    return modelId.includes('claude') || modelId.startsWith('anthropic.');
  }

  /**
   * Cross-region inference-profile prefix for this adapter's region.
   * Claude 4-era models on Bedrock reject on-demand invocation of the
   * direct id ("Invocation ... with on-demand throughput isn't supported")
   * and require the profile form — verified live 2026-07-31.
   */
  private inferenceProfilePrefix(): string {
    if (this.region.startsWith('eu-')) return 'eu.';
    if (this.region.startsWith('ap-')) return 'apac.';
    return 'us.';
  }

  /**
   * Convert a standard Claude model ID to Bedrock format if needed
   */
  private toBedrockModelId(modelId: string): string {
    // Strip bedrock: routing prefix if present (used for explicit routing to this adapter)
    if (modelId.startsWith('bedrock:')) {
      modelId = modelId.slice('bedrock:'.length);
    }

    // If already in Bedrock format, use as-is
    // Supports both direct model IDs (anthropic.claude-...) and
    // cross-region inference profile IDs (us.anthropic.claude-..., eu.anthropic.claude-...,
    // apac.anthropic.claude-..., global.anthropic.claude-... — `global` is 6 chars, hence {2,6}).
    if (modelId.startsWith('anthropic.') || /^[a-z]{2,6}\.anthropic\./.test(modelId)) {
      return modelId;
    }

    const profile = this.inferenceProfilePrefix();

    // Map common Claude model IDs to Bedrock format. The 3.x entries keep
    // their historical direct-id form (those models predate inference
    // profiles; all are EOL on Bedrock as of 2026-07 anyway, so the exact
    // shape is moot). 4-era entries use the profile form — the direct id
    // no longer invokes.
    const modelMap: Record<string, string> = {
      'claude-3-5-sonnet-20241022': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-sonnet-latest': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-haiku-20241022': 'anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-3-5-haiku-latest': 'anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-3-opus-20240229': 'anthropic.claude-3-opus-20240229-v1:0',
      'claude-3-sonnet-20240229': 'anthropic.claude-3-sonnet-20240229-v1:0',
      'claude-3-haiku-20240307': 'anthropic.claude-3-haiku-20240307-v1:0',
      'claude-sonnet-4-20250514': `${profile}anthropic.claude-sonnet-4-20250514-v1:0`,
      'claude-opus-4-20250514': `${profile}anthropic.claude-opus-4-20250514-v1:0`,
      // Haiku 4.5 previously aliased to 3.5 Haiku (a stand-in from before
      // Haiku 4.5 reached Bedrock). 3.5 Haiku is EOL on Bedrock now, so the
      // alias routed every plain-id caller to a guaranteed error.
      'claude-haiku-4-5-20251001': `${profile}anthropic.claude-haiku-4-5-20251001-v1:0`,
    };

    return modelMap[modelId] ?? `${profile}anthropic.${modelId}-v1:0`;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const bedrockModelId = this.toBedrockModelId(request.model);
    const bedrockRequest = this.buildRequest(request, bedrockModelId, options?.onContentAltered);
    const fullRequest = { modelId: bedrockModelId, ...bedrockRequest };
    assertMessagePrefillSupported(bedrockModelId, fullRequest.messages, options, this.name, fullRequest);
    options?.onRequest?.(fullRequest);
    options?.onSend?.({ maxTokens: fullRequest.max_tokens });

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      const response = await this.invokeModel(bedrockModelId, bedrockRequest, combinedSignal, fullRequest);
      return this.parseResponse(response, fullRequest);
    } catch (error) {
      throw this.handleError(error, fullRequest);
    } finally {
      cleanup?.();
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const bedrockModelId = this.toBedrockModelId(request.model);
    const bedrockRequest = this.buildRequest(request, bedrockModelId, options?.onContentAltered);
    const fullRequest = { modelId: bedrockModelId, ...bedrockRequest, stream: true };
    assertMessagePrefillSupported(bedrockModelId, fullRequest.messages, options, this.name, fullRequest);
    options?.onRequest?.(fullRequest);
    // This stream reports content through onProgress (contentOfAnthropicEvent below).
    options?.onSend?.({ maxTokens: fullRequest.max_tokens, reportsContent: true });

    const { signal: combinedSignal, cleanup } = createCombinedSignal(options?.signal, options?.timeoutMs);
    try {
      return await this.invokeModelWithStream(bedrockModelId, bedrockRequest, callbacks, combinedSignal, fullRequest, options?.onProgress);
    } catch (error) {
      throw this.handleError(error, fullRequest);
    } finally {
      cleanup?.();
    }
  }

  private buildRequest(request: ProviderRequest, bedrockModelId?: string, onContentAltered?: (block?: unknown) => void): BedrockMessageRequest {
    // Wire copies of the request's own blocks, so a block the cleanup drops
    // is reported as the block membrane built (and can attribute).
    const originals = new WeakMap<object, unknown>();
    const remember = <T>(copy: T, original: unknown): T => {
      if (copy !== original && copy !== null && typeof copy === 'object') originals.set(copy as object, original);
      return copy;
    };
    // Strip provider-specific fields (e.g., sourceUrl for Gemini) from image blocks
    // before sending to Bedrock/Anthropic, which rejects extra inputs.
    //
    // Same treatment for cache_control.ttl: Bedrock's prompt cache runs at the
    // fixed default (5m) TTL — the ttl field is a direct-API extension and
    // Bedrock rejects it as an extra input. The marker itself is fine and
    // caching works without the field, so strip just the ttl and keep the
    // breakpoint. Transport quirks belong to the transport, not to every
    // caller that sets cacheTtl. (Connectome issue #35.)
    // Bedrock is strict about the wire shape of image sources: internal blocks
    // carry camelCase `mediaType`, the API requires snake_case `media_type`.
    // The Anthropic adapter converts on both paths (top-level images in its
    // buildRequest, nested ones through toAnthropicToolResultContent); without
    // the same conversion here a tool-returned image 400s with
    // "media_type: Field required" mid-turn
    // (observed on eidoverse snapshot results, 2026-08-08). Applies to
    // top-level image blocks AND images nested inside tool_result content.
    // Data that is no image the API accepts goes as imageForRequest's
    // placeholder text instead, keeping any cache breakpoint the image
    // carried; `onPlaceholder` hears each one.
    const toWireImage = (block: any, onPlaceholder: () => void): any => {
      const source = block.source;
      if (source?.type === 'url') {
        // A data: URL holds its image inline, so it goes as base64 data or
        // the placeholder; any other URL goes as it is.
        const image = urlImageForRequest(source.url);
        if (image.placeholder) {
          onPlaceholder();
          return block.cache_control ? { ...image.placeholder, cache_control: block.cache_control } : image.placeholder;
        }
        return image.data ? { ...block, source: { type: 'base64', media_type: image.mediaType, data: image.data } } : block;
      }
      if (!source || source.type !== 'base64') return block;
      const { mediaType, media_type, ...restSource } = source;
      const image = imageForRequest(source.data, media_type ?? mediaType);
      if (image.placeholder) {
        onPlaceholder();
        return block.cache_control ? { ...image.placeholder, cache_control: block.cache_control } : image.placeholder;
      }
      return {
        ...block,
        source: {
          ...restSource,
          media_type: image.mediaType,
        },
      };
    };
    const sanitizedMessages = (request.messages as any[]).map((msg: any) => {
      if (!Array.isArray(msg.content)) return msg;
      // Media in MCP's form becomes membrane's first, for a caller that
      // builds a request directly (Membrane's own builds have converted it
      // already, utils/mcp-media.ts), as the Anthropic adapter converts it. A
      // report about a block names the one the caller handed in.
      const converted = convertMcpMedia(msg.content as unknown[]) as any[];
      return {
        ...msg,
        content: msg.content.flatMap((original: any, index: number) => {
          const block = converted[index];
          if (isSourcelessMedia(block)) {
            // Media with no source object (MCP's form that didn't convert)
            // has no form the API takes: left out, and reported.
            onContentAltered?.(original);
            return [];
          }
          if (isUnsignedThinking(block)) {
            // Another provider's reasoning has no signature, and the
            // Anthropic API refuses a thinking block without a valid one
            // (#191): left out, and reported, as the Anthropic adapter does.
            onContentAltered?.(original);
            return [];
          }
          return [remember((() => {
            if (block.type === 'image' && block.sourceUrl !== undefined) {
              const { sourceUrl, ...rest } = block;
              return stripCacheTtl(toWireImage(rest, () => onContentAltered?.(original)));
            }
            if (block.type === 'image') {
              return stripCacheTtl(toWireImage(block, () => onContentAltered?.(original)));
            }
            if (block.type === 'tool_result' && Array.isArray(block.content)) {
              let altered = false;
              // Media with no source object has no form the API takes here
              // either: left out, and the result reported, as at the top.
              const content = block.content.flatMap((inner: any) => {
                if (isSourcelessMedia(inner)) {
                  altered = true;
                  return [];
                }
                return [inner?.type === 'image' ? toWireImage(inner, () => { altered = true; }) : inner];
              });
              if (altered) onContentAltered?.(original);
              return stripCacheTtl({ ...block, content });
            }
            return stripCacheTtl(block);
          })(), original)];
        }),
      };
    });

    const params: BedrockMessageRequest = {
      anthropic_version: this.anthropicVersion,
      max_tokens: request.maxTokens || this.defaultMaxTokens,
      messages: sanitizedMessages as BedrockMessageRequest['messages'],
    };

    // Handle system prompt
    // Claude 3 Sonnet (20240229) on Bedrock intermittently rejects the array content-block
    // format for system prompts via APAC cross-region inference. Flatten to a plain string
    // for this model to avoid the "system: Input should be a valid string" validation error.
    if (request.system) {
      const needsFlatten = bedrockModelId?.includes('claude-3-sonnet-20240229') ?? false;
      if (needsFlatten && Array.isArray(request.system)) {
        const blocks = request.system as Array<{ type: string; text: string }>;
        params.system = blocks.map(b => b.text).join('\n\n');
      } else if (Array.isArray(request.system)) {
        params.system = (request.system as Array<Record<string, any>>).map(
          b => stripCacheTtl(b)
        ) as BedrockMessageRequest['system'];
      } else {
        params.system = request.system as BedrockMessageRequest['system'];
      }
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    // Anthropic API (via Bedrock) rejects requests with both temperature and top_p set.
    if (request.topP !== undefined && request.temperature === undefined) {
      params.top_p = request.topP;
    }

    if (request.topK !== undefined) {
      params.top_k = request.topK;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop_sequences = request.stopSequences;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = (request.tools as Array<Record<string, any>>).map(t => stripCacheTtl(t));
    }

    // Handle extended thinking
    if ((request as any).thinking) {
      params.thinking = (request as any).thinking;
    }

    // Apply extra params, excluding internal membrane fields
    if (request.extra) {
      const { normalizedMessages, prompt, ...rest } = request.extra as Record<string, unknown>;
      // A passthrough `messages` replaces the built messages wholesale.
      if (rest.messages !== undefined) onContentAltered?.();
      Object.assign(params, rest);
    }

    // Validate independently of the beta gate: a malformed caller value must
    // neither disappear during the merge nor reach Bedrock on newer models.
    const consumerBetas: unknown = params.anthropic_beta;
    if (consumerBetas !== undefined && (
      !Array.isArray(consumerBetas) ||
      [...consumerBetas].some(beta => typeof beta !== 'string')
    )) {
      throw invalidRequestError('Bedrock anthropic_beta must be an array of strings.');
    }

    // Interleaved thinking on pre-4.6 Claude 4: same gate as the Anthropic
    // adapter, but bedrock-runtime takes betas as the `anthropic_beta` body
    // field rather than an HTTP header. Runs after the extra-assign so a
    // consumer-supplied anthropic_beta is merged (Set-deduped), not clobbered.
    // The gate only matches Claude 4 <4.6 ids, so legacy 3.x models (which
    // reject unknown beta flags) never receive the field.
    if (thinkingEnabled(request) && needsInterleavedThinkingBeta(request.model)) {
      const existing = params.anthropic_beta ?? [];
      params.anthropic_beta = [...new Set([...existing, INTERLEAVED_THINKING_BETA])];
    }
    // Thinking-binding controls need their beta, the same way.
    if (sendsBlockBinding(params)) {
      const existing = params.anthropic_beta ?? [];
      params.anthropic_beta = [...new Set([...existing, THINKING_BINDING_BETA])];
    }
    // So does `display: 'updates'` (progress notes between tool calls).
    if (sendsDisplayUpdates(params)) {
      const existing = params.anthropic_beta ?? [];
      params.anthropic_beta = [...new Set([...existing, THINKING_DISPLAY_UPDATES_BETA])];
    }

    stripEmptyTextRequest(params, onContentAltered
      ? (dropped) => onContentAltered(dropped !== null && typeof dropped === 'object' ? originals.get(dropped) ?? dropped : dropped)
      : undefined);
    return params;
  }

  private async invokeModel(
    modelId: string,
    request: BedrockMessageRequest,
    signal: AbortSignal | undefined,
    rawRequest: unknown
  ): Promise<BedrockMessageResponse> {
    const url = new URL(
      `${this.baseURL ?? `https://bedrock-runtime.${this.region}.amazonaws.com`}/model/${encodeURIComponent(modelId)}/invoke`
    );

    const body = JSON.stringify(request);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };

    const signedHeaders = await signRequest(
      'POST',
      url,
      headers,
      body,
      this.accessKeyId,
      this.secretAccessKey,
      this.sessionToken,
      this.region,
      'bedrock'
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signedHeaders,
      body,
      signal,
    });

    if (!response.ok) {
      throw errorFromHttpResponse(this.name, response, await response.text(), rawRequest);
    }

    return response.json() as Promise<BedrockMessageResponse>;
  }

  private async invokeModelWithStream(
    modelId: string,
    request: BedrockMessageRequest,
    callbacks: StreamCallbacks,
    signal: AbortSignal | undefined,
    rawRequest: unknown,
    onProgress?: ProviderRequestOptions['onProgress'],
  ): Promise<ProviderResponse> {
    const url = new URL(
      `${this.baseURL ?? `https://bedrock-runtime.${this.region}.amazonaws.com`}/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`
    );

    const body = JSON.stringify(request);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
    };

    const signedHeaders = await signRequest(
      'POST',
      url,
      headers,
      body,
      this.accessKeyId,
      this.secretAccessKey,
      this.sessionToken,
      this.region,
      'bedrock'
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signedHeaders,
      body,
      signal,
    });

    if (!response.ok) {
      throw errorFromHttpResponse(this.name, response, await response.text(), rawRequest);
    }

    // Parse the binary event stream
    const contentBlocks: Array<{ type: string; text?: string; thinking?: string; signature?: string }> = [];
    // Indices of blocks content_block_stop finalized. A tool call truncated by
    // max_tokens never gets one, as in the Anthropic adapter.
    const stoppedBlocks = new Set<number>();
    let currentBlockIndex = -1;
    // Block events come in the API's order: a start while no block is open,
    // at the next index, then that block's deltas (a tool call's carry only
    // its arguments: isToolCallBlock, isToolCallArgumentsDelta) and its stop.
    // A start above the next index is placed, as it always was, and the slots
    // it skips fail the call below as lost blocks; the Anthropic adapter takes
    // that start as out of order instead. A stream that ends with a block
    // open, as a max_tokens cut does, is in order. Reading stops at
    // message_delta, as in the Anthropic adapter, so a block still open there
    // is cut off in both. The first event that isn't in order
    // means the stream can't vouch for which call any arguments belong to:
    // no later block event is applied, a block still open stays unstopped
    // (marked below), and every tool_use block in the response is marked,
    // with one warning.
    let blockOrderBroken = false;
    // A start that names no block, while none is open, is skipped as it
    // always was: until the next start, the deltas and stop after it join no
    // block rather than breaking block order, and a later block still fails
    // the call over the block the message lost. A start while a block is
    // open, or at an index below the next, breaks block order whatever it
    // names.
    let skippedStart = false;
    const blockOpen = (): boolean =>
      currentBlockIndex >= 0 && contentBlocks[currentBlockIndex] !== undefined && !stoppedBlocks.has(currentBlockIndex);
    const breakBlockOrder = (what: string): void => {
      if (blockOrderBroken) return;
      blockOrderBroken = true;
      console.warn('[membrane:bedrock] Skipping malformed stream event:', `${what}; no later block event is applied, and every tool_use block in the response is marked`);
    };
    let finalMessage: BedrockMessageResponse | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    // Whether the stream reported each count (an unreported one stays a 0 default).
    let inputReported = false;
    let outputReported = false;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let stopReason: string | undefined;
    // A refusal's details, from its message_delta, as AnthropicAdapter's
    // stream reads them. AWS's page doesn't show them in the stream, so they
    // may never come; the reader leaves the category out when they don't.
    let stopDetails: unknown;
    let sawTerminalEvent = false;
    let stopSequence: string | undefined;
    let fullText = '';
    // Final in message_start, replaced by a message_delta's after a fallback.
    let inputTransformations: unknown;

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    let buffer = new Uint8Array(0);

    try {
      read: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append new data to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        // Parse complete events from buffer
        while (buffer.length >= 16) {
          // AWS event stream format:
          // 4 bytes: total byte length (big-endian)
          // 4 bytes: headers length (big-endian)
          // 4 bytes: prelude CRC
          // headers
          // payload
          // 4 bytes: message CRC
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const totalLength = view.getUint32(0, false);
          const headersLength = view.getUint32(4, false);

          if (buffer.length < totalLength) {
            // Incomplete message, wait for more data
            break;
          }

          // Extract payload (skip prelude, headers, and CRCs)
          const payloadStart = 12 + headersLength;
          const payloadEnd = totalLength - 4;
          const payloadBytes = buffer.slice(payloadStart, payloadEnd);

          // Parse headers to find event type and exception type
          let eventType = '';
          let exceptionType = '';
          let headerOffset = 12;
          const headerEnd = 12 + headersLength;
          while (headerOffset < headerEnd) {
            const nameLength = buffer[headerOffset]!;
            headerOffset += 1;
            const name = new TextDecoder().decode(buffer.slice(headerOffset, headerOffset + nameLength));
            headerOffset += nameLength;
            const valueType = buffer[headerOffset]!;
            headerOffset += 1;

            if (valueType === 7) {
              // String type
              const valueLength = new DataView(buffer.buffer, buffer.byteOffset + headerOffset, 2).getUint16(0, false);
              headerOffset += 2;
              const value = new TextDecoder().decode(buffer.slice(headerOffset, headerOffset + valueLength));
              headerOffset += valueLength;

              if (name === ':event-type') {
                eventType = value;
              } else if (name === ':exception-type') {
                exceptionType = value;
              }
            } else {
              // Skip other header types
              break;
            }
          }

          // Handle exception events from Bedrock (throttling, model errors, etc.)
          if (exceptionType) {
            let errorMessage = exceptionType;
            try {
              const exPayload = JSON.parse(new TextDecoder().decode(payloadBytes));
              errorMessage = exPayload.message || exPayload.Message || exceptionType;
            } catch {
              // Use exception type as message
            }
            throw new BedrockError(
              BEDROCK_STREAM_EXCEPTION_STATUS.get(exceptionType.toLowerCase()) ?? 500,
              `Bedrock stream error (${exceptionType}): ${errorMessage}`,
              exceptionType,
              errorMessage === exceptionType ? undefined : { message: errorMessage },
            );
          }

          // Parse the JSON payload
          if (eventType === 'chunk' && payloadBytes.length > 0) {
            // Decode first. An event that doesn't decode, carries no bytes,
            // or decodes to JSON that isn't an object (`null`, a number, a
            // string, an array) is skipped, with a warning. Nothing after the
            // decode is caught here, so an error there, a caller's callback
            // included, fails the stream.
            let decoded: unknown;
            let skipped: unknown = 'no event in its bytes';
            try {
              const payloadJson = JSON.parse(new TextDecoder().decode(payloadBytes));
              if (payloadJson.bytes) {
                // Decode base64 → bytes → UTF-8 string (atob returns Latin-1, mangling multi-byte emoji)
                const binaryStr = atob(payloadJson.bytes);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                decoded = JSON.parse(new TextDecoder().decode(bytes));
                skipped = 'bytes that decode to no object';
              }
            } catch (e) {
              skipped = e;
            }
            const eventData = isEventObject(decoded) ? decoded as BedrockStreamEvent : undefined;
            if (eventData === undefined) console.warn('[membrane:bedrock] Skipping malformed stream event:', skipped);

            if (eventData !== undefined) {
              // A decoded model event is progress; a ping only proves the
              // connection.
              if ((eventData as { type?: string }).type !== 'ping') onProgress?.(contentOfAnthropicEvent(eventData));

              // Check for error events within the stream
              if (eventData.type === 'error') {
                // Anthropic's own error event: its error.type
                // (overloaded_error, rate_limit_error, ...) is the code
                // the shared table reads a status from; one it doesn't
                // know stays a 500.
                const streamError = (eventData as any).error;
                throw new BedrockError(
                  undefined,
                  `Bedrock stream error: ${streamError?.message || JSON.stringify(eventData)}`,
                  typeof streamError?.type === 'string' ? streamError.type : undefined,
                  eventData,
                );
              }

              if (eventData.type === 'message_start' && eventData.message) {
                // Cache metrics ride the same usage objects as on the direct
                // API. Dropping them (pre-2026-07-31) made caching look
                // permanently inert on Bedrock streams: complete() surfaced
                // them, stream() zeroed them, and every ledger/pricing
                // consumer downstream saw zeros. (Connectome issue #35.)
                inputTransformations = eventData.message.input_transformations;
                const startUsage = eventData.message.usage;
                inputTokens = startUsage?.input_tokens ?? 0;
                inputReported = typeof startUsage?.input_tokens === 'number';
                if (startUsage?.cache_creation_input_tokens != null) {
                  cacheCreationTokens = startUsage.cache_creation_input_tokens;
                }
                if (startUsage?.cache_read_input_tokens != null) {
                  cacheReadTokens = startUsage.cache_read_input_tokens;
                }
              } else if (eventData.type === 'content_block_start') {
                // Order first: a start while a block is open, or at an index
                // below the next (one already used, or a slot a start above
                // the next skipped), breaks block order whatever it names.
                // Then a block whose index names no slot (an absent index is
                // slot 0, as streamIndex reads it), or that isn't an object,
                // an array included, can't be placed: it's skipped, with the
                // warning, and its deltas and stop join no block, though a
                // text delta's text still streams.
                const startIndex = streamIndex(eventData.index);
                const startBlock: unknown = eventData.content_block;
                if (blockOrderBroken || blockOpen() || (startIndex !== undefined && startIndex < contentBlocks.length)) {
                  breakBlockOrder('a content_block_start while a block is open or at an index below the next');
                } else if (startIndex === undefined || startBlock === null || typeof startBlock !== 'object' || Array.isArray(startBlock)) {
                  console.warn('[membrane:bedrock] Skipping malformed stream event:', 'a content_block_start that names no block');
                  currentBlockIndex = -1;
                  skippedStart = true;
                } else {
                  skippedStart = false;
                  currentBlockIndex = startIndex;
                  contentBlocks[currentBlockIndex] = startBlock as { type: string };
                  callbacks.onContentBlock?.(currentBlockIndex, startBlock);
                }
              } else if (eventData.type === 'content_block_delta') {
                const deltaIndex = streamIndex((eventData as { index?: unknown }).index, currentBlockIndex);
                if (blockOrderBroken || (!skippedStart && (!blockOpen() || deltaIndex !== currentBlockIndex))) {
                  breakBlockOrder('a content_block_delta for a block other than the open one');
                } else if (isToolCallBlock(contentBlocks[currentBlockIndex]) && !isToolCallArgumentsDelta(eventData.delta)) {
                  // A tool call's deltas carry only its arguments. (After a
                  // skipped start currentBlockIndex is -1, which holds no block.)
                  breakBlockOrder('a content_block_delta that a tool call can\'t take');
                } else if (eventData.delta?.type === 'text_delta' && eventData.delta.text) {
                  fullText += eventData.delta.text;
                  callbacks.onChunk(eventData.delta.text);
                  if (contentBlocks[currentBlockIndex]) {
                    contentBlocks[currentBlockIndex]!.text = (contentBlocks[currentBlockIndex]!.text ?? '') + eventData.delta.text;
                  }
                } else if (eventData.delta?.type === 'thinking_delta' && eventData.delta.thinking) {
                  callbacks.onChunk(eventData.delta.thinking);
                  if (contentBlocks[currentBlockIndex]) {
                    contentBlocks[currentBlockIndex]!.thinking = (contentBlocks[currentBlockIndex]!.thinking ?? '') + eventData.delta.thinking;
                  }
                } else if (eventData.delta?.type === 'signature_delta' && (eventData.delta as any).signature) {
                  if (contentBlocks[currentBlockIndex]) {
                    contentBlocks[currentBlockIndex]!.signature = (contentBlocks[currentBlockIndex]!.signature ?? '') + (eventData.delta as any).signature;
                    // Reported as it accumulates, so a stream that ends before
                    // content_block_stop still keeps the signature it received.
                    callbacks.onThinkingSignature?.(currentBlockIndex, contentBlocks[currentBlockIndex]!.signature!);
                  }
                } else if (eventData.delta?.type === 'input_json_delta' && (eventData.delta as any).partial_json !== undefined) {
                  // Tool-call arguments stream as input_json_delta fragments.
                  // Dropping these (pre-2026-07-21 behavior) gutted every
                  // tool_use block: stop_reason said tool_use but the block
                  // lost its input — and then its id/name in final assembly.
                  const blk = contentBlocks[currentBlockIndex] as (typeof contentBlocks)[number] & { partialJson?: string };
                  if (blk) {
                    blk.partialJson = (blk.partialJson ?? '') + (eventData.delta as any).partial_json;
                  }
                }
              } else if (eventData.type === 'content_block_stop') {
                // Mirror the Anthropic adapter: fire onContentBlock a second
                // time with the finalised block so consumers can distinguish
                // start from stop. Without this, downstream code that depends
                // on the dual-fire convention (e.g. membrane's native
                // yielding path) silently drops block_complete on Bedrock.
                const blockIdx = streamIndex((eventData as { index?: unknown }).index, currentBlockIndex);
                if (skippedStart) {
                  // After a skipped start no block is open. A stop joins no
                  // block, as the skipped block's deltas do, whatever index it
                  // names, the skipped start's own slot included: nothing is
                  // applied or reported, and a slot no block filled still
                  // fails the call below.
                } else if (blockOrderBroken || !blockOpen() || blockIdx !== currentBlockIndex) {
                  // A stop for no block, or for a block never started,
                  // included.
                  breakBlockOrder('a content_block_stop for a block other than the open one');
                } else {
                  stoppedBlocks.add(blockIdx);
                  // Finalize tool_use blocks: parse accumulated argument JSON
                  // into `input` before the block_complete fire, so consumers
                  // of the dual-fire convention see a complete tool call.
                  const stoppedBlk = contentBlocks[blockIdx] as ((typeof contentBlocks)[number] & { partialJson?: string; input?: unknown; unparseableInput?: string }) | undefined;
                  if (stoppedBlk?.type === 'tool_use' && stoppedBlk.partialJson !== undefined) {
                    // As in the Anthropic adapter: arguments that don't parse,
                    // or parse to anything but an object, leave the input
                    // content_block_start carried, and the raw text marks it.
                    const parsed = toolUseInputFromText(stoppedBlk.partialJson);
                    if (parsed.unparseableInput === undefined) stoppedBlk.input = parsed.input;
                    else stoppedBlk.unparseableInput = parsed.unparseableInput;
                  }
                  callbacks.onContentBlock?.(blockIdx, contentBlocks[blockIdx]);
                }
              } else if (eventData.type === 'message_delta') {
                sawTerminalEvent = true;
                if (Array.isArray(eventData.input_transformations)) inputTransformations = eventData.input_transformations;
                if (eventData.usage) {
                  outputTokens = eventData.usage.output_tokens;
                  if (typeof eventData.usage.output_tokens === 'number') outputReported = true;
                  // message_delta carries cumulative cache metrics — use as
                  // authoritative when present (same contract as the
                  // Anthropic adapter).
                  if (eventData.usage.cache_creation_input_tokens != null) {
                    cacheCreationTokens = eventData.usage.cache_creation_input_tokens;
                  }
                  if (eventData.usage.cache_read_input_tokens != null) {
                    cacheReadTokens = eventData.usage.cache_read_input_tokens;
                  }
                }
                if (eventData.delta?.stop_reason) {
                  stopReason = eventData.delta.stop_reason;
                }
                if (eventData.delta?.stop_details !== undefined) stopDetails = eventData.delta.stop_details;
                // WHICH stop sequence fired, not just that one did. Dropping
                // this (pre-2026-07-26) broke prefill/XML tool use on
                // Bedrock entirely: membrane's tool gate matches
                // stopSequence === '</function_calls>', so calls were never
                // parsed or executed, the close tag was never restored, and
                // the turn continuation looped forever on the dangling
                // block (~6 output tokens per full-prefill round).
                if (eventData.delta?.stop_sequence) {
                  stopSequence = eventData.delta.stop_sequence;
                }
              }
            }
          }

          // Remove processed message from buffer
          buffer = buffer.slice(totalLength);
          // message_delta ends the message: as in the Anthropic adapter,
          // nothing after it is read, and the finally lets the body go.
          if (sawTerminalEvent) break read;
        }
      }
    } finally {
      // A read loop that ends early, on a callback's error or any other,
      // leaves the body unread: cancel it, so the provider stops sending and
      // the connection is let go. After a full read it does nothing.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    // Detect empty responses — Bedrock returned no content and no tokens
    if (contentBlocks.length === 0 && inputTokens === 0 && outputTokens === 0) {
      throw new BedrockError(
        500,
        'Bedrock returned empty response: no content blocks, 0 input/output tokens. This may indicate a transient service issue.'
      );
    }

    // The empty-response guard above only catches a stream that produced
    // NOTHING; a stream truncated after any content passed it and was
    // reported as a clean end_turn. message_delta is the terminal event.
    assertTerminalEventObserved(sawTerminalEvent, 'Bedrock', { modelId, ...request });

    // A block start skipped as malformed leaves its slot empty, and a block's
    // index is its place in the message, so a slot before the last block that
    // no block filled is a block the message lost. The request was never
    // answered in full, as when a stream ends before its terminal event, so it
    // fails the same retryable way rather than returning the message without
    // that block. The scan stops at the first empty slot.
    let slot = 0;
    while (slot < contentBlocks.length && slot in contentBlocks) slot++;
    if (slot < contentBlocks.length) {
      throw networkError(
        `Bedrock stream lost content block ${slot}: no block start placed it`,
        undefined,
        { modelId, ...request }
      );
    }

    // Build response from accumulated data
    finalMessage = {
      id: 'msg_stream',
      type: 'message',
      role: 'assistant',
      content: contentBlocks.map((b, blockIdx) => {
        if (b.type === 'thinking') {
          return { type: 'thinking' as const, thinking: b.thinking ?? '', signature: b.signature };
        }
        if (b.type === 'redacted_thinking') {
          // Pass through verbatim — carries the encrypted `data` payload
          return { ...b } as unknown as { type: 'text'; text?: string };
        }
        if (b.type === 'tool_use') {
          // Preserve id/name and the input accumulated from input_json_delta
          // fragments — the generic text mapping below would strip them and
          // parseResponse would then drop the block (requires id && name).
          const tb = b as { type: string; id?: string; name?: string; input?: unknown; partialJson?: string; unparseableInput?: string };
          // A block content_block_stop finalized keeps what it set there. One
          // the stream left open keeps the input content_block_start carried,
          // and whatever argument text arrived marks it, none included, as in
          // the Anthropic adapter: the call never finished, so nothing says
          // its arguments were complete, even text that parses.
          let unparseableInput = stoppedBlocks.has(blockIdx) ? tb.unparseableInput : (tb.partialJson ?? '');
          let input = tb.input ?? {};
          // After a break in block order no call counts as complete, those
          // finished before it included: one not already marked keeps its
          // arguments, as JSON, in the marker, and an empty input. One already
          // marked keeps its marker and the input its start carried.
          if (blockOrderBroken && unparseableInput === undefined) {
            unparseableInput = JSON.stringify(input);
            input = {};
          }
          return {
            type: 'tool_use', id: tb.id, name: tb.name, input,
            ...(unparseableInput !== undefined ? { unparseableInput } : {}),
          } as unknown as { type: 'text'; text?: string };
        }
        return { type: b.type as 'text', text: b.text };
      }),
      model: modelId,
      stop_reason: (stopReason ?? 'end_turn') as BedrockMessageResponse['stop_reason'],
      stop_sequence: stopSequence ?? null,
      ...(stopDetails !== undefined ? { stop_details: stopDetails } : {}),
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreationTokens != null ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
        ...(cacheReadTokens != null ? { cache_read_input_tokens: cacheReadTokens } : {}),
      },
      ...(Array.isArray(inputTransformations) ? { input_transformations: inputTransformations } : {}),
    };

    const parsed = this.parseResponse(finalMessage, rawRequest);
    const { unreportedUsage: _fromSynthetic, ...rest } = parsed;
    return {
      ...rest,
      ...unreportedUsage(inputReported ? inputTokens : undefined, outputReported ? outputTokens : undefined),
      providerStopReason: stopReason,
    };
  }

  private parseResponse(response: BedrockMessageResponse, rawRequest: unknown): ProviderResponse {
    const content: ContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        // The stream assembly's marker wins over the value's JSON: it holds
        // the arguments as they came, or after a break in block order as JSON
        // when they had parsed (ToolUseContent.unparseableInput).
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          ...toolUseInputFromValue(block.input),
          ...(block.unparseableInput !== undefined ? { unparseableInput: block.unparseableInput } : {}),
        });
      } else if (block.type === 'thinking') {
        // Signature-only thinking blocks (display:'omitted') have an empty
        // thinking field but must still be preserved for round-tripping.
        content.push({
          type: 'thinking',
          thinking: block.thinking ?? '',
          ...(block.signature ? { signature: block.signature } : {}),
        });
      } else if ((block as any).type === 'redacted_thinking') {
        // Pass through verbatim — carries the encrypted `data` payload
        content.push({ ...(block as any) } as ContentBlock);
      }
    }

    return {
      content,
      stopReason: response.stop_reason ?? 'end_turn',
      providerStopReason: response.stop_reason ?? undefined,
      // A non-streamed body carries stop_details, as AWS documents. The
      // stream's final message carries them when a message_delta did, which
      // AWS's page doesn't show.
      ...readRefusalCategory(response.stop_reason, response.stop_details),
      stopSequence: response.stop_sequence ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens,
      },
      ...unreportedUsage(response.usage?.input_tokens, response.usage?.output_tokens),
      ...readInputTransformations(response.input_transformations, (rawRequest as { messages?: unknown } | undefined)?.messages),
      model: response.model,
      rawRequest,
      raw: response,
    };
  }

  /**
   * HTTP failures are classified at the fetch boundary. What reaches here is
   * a synthesized stream-event failure (BedrockError, which carries the
   * status its exception type implies, and the type itself as the provider
   * code), a typed abort, or a non-HTTP throwable.
   */
  private handleError(error: unknown, rawRequest?: unknown): MembraneError {
    if (isDeadlineAbort(error)) return deadlineTimeoutError(error, rawRequest);
    if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
    if (isTypedAbortError(error)) return abortError(undefined, rawRequest);

    if (error instanceof BedrockError) {
      return errorFromProviderStatus({
        provider: this.name,
        status: error.status,
        fallbackStatus: 500,
        code: error.code,
        body: error.message,
        message: error.message,
        rawError: error,
        rawRequest,
      });
    }

    return errorFromThrown(error, rawRequest);
  }
}

// ============================================================================
// Error Class
// ============================================================================

class BedrockError extends Error {
  constructor(
    /** Undefined when the code decides it (a 500 if the table doesn't know the code). */
    public status: number | undefined,
    message: string,
    /** The exception's own type, or an in-band error event's error.type. */
    public code?: string,
    /**
     * The provider's error as it came in the stream, as the Anthropic SDK's
     * APIError keeps its body as `error`: an exception's `{ message }`, or an
     * in-band error event.
     */
    public error?: unknown,
  ) {
    super(message);
    this.name = 'BedrockError';
  }
}

/**
 * The status each exception Bedrock sends inside a response stream implies:
 * the HTTP status AWS documents for the same exception. AWS documents
 * modelStreamErrorException as a 424 and asks for a retry, and a 424 would
 * read here as a bad request, so it stays a retryable 500. A type not listed
 * is a 500 too, as every non-throttling exception was.
 */
const BEDROCK_STREAM_EXCEPTION_STATUS = new Map<string, number>([
  ['validationexception', 400],
  ['modeltimeoutexception', 408],
  ['throttlingexception', 429],
  ['internalserverexception', 500],
  ['modelstreamerrorexception', 500],
  ['serviceunavailableexception', 503],
]);
