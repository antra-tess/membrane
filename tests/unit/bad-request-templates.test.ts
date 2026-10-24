/**
 * A 400's kind, as a closed vocabulary: the template its message matches, and
 * the field path it opens with. Each template is checked against a message in
 * the provider's own wording, with neutral values where the provider quotes
 * one; then the field path's rules; then the provider's message as each
 * adapter carries it on its error, through a real adapter over a stubbed
 * transport, to the attempt record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAD_REQUEST_TEMPLATES, classifyBadRequest, providerMessageOf, REQUEST_FIELD_NAMES } from '../../src/utils/bad-request.js';
import { MembraneError, serializeError } from '../../src/types/errors.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { AttemptRecord, NormalizedRequest, ProviderAdapter } from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Each template, by a message in the provider's wording (a field path where the provider opens with one). */
const MESSAGES: Array<[string, string]> = [
  ['prefill_unsupported', 'This model does not support assistant message prefill. The conversation must end with a user message.'],
  ['sampling_parameter_deprecated', '`top_k` is deprecated for this model.'],
  ['sampling_parameter_deprecated', '`temperature` is deprecated for this model.'],
  ['sampling_parameter_deprecated', '`top_p` is deprecated for this model.'],
  ['system_change_unsupported', 'tool_addition/tool_removal requires a model that supports mid-conversation system content; this model does not'],
  ['system_change_unsupported', 'tool_addition/tool_removal is not supported on this model'],
  ['system_change_unsupported', "role 'system' is not supported on this model"],
  ['thinking_type_unsupported', '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.'],
  ['thinking_type_unsupported', 'adaptive thinking is not supported on this model'],
  ['effort_unsupported', 'output_config.effort requires a model that supports per-turn effort; this model does not'],
  ['tool_choice_unsupported', 'tool_choice: type "tool" and "any" are not supported for this model.'],
  ['max_tokens_not_above_thinking_budget', '`max_tokens` must be greater than `thinking.budget_tokens`. Please consult our documentation.'],
  ['prompt_too_long', 'prompt is too long: 210000 tokens > 200000 maximum'],
  ['thinking_bound_elsewhere', 'messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".'],
  ['thinking_signature_invalid', 'messages.5.content.0: Invalid `signature` in `thinking` block'],
  ['redacted_thinking_data_invalid', 'messages.5.content.1: Invalid `data` in `redacted_thinking` block'],
  ['thinking_blocks_modified', 'messages.7.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.'],
  ['thinking_last_in_assistant', 'messages.3: The final block in an assistant message cannot be `thinking`.'],
  ['tool_use_without_result', 'messages.2: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01. Each `tool_use` block must have a corresponding `tool_result` block in the next message.'],
  ['server_tool_use_without_result', 'messages.4: `web_search` tool use with id `srvtoolu_01` was found without a corresponding `web_search_tool_result` block'],
  ['server_tool_use_without_result', 'messages.4: `mcp_tool_use` with id `mcptoolu_01` was found without a corresponding `mcp_tool_result` block'],
  ['tool_result_without_use', 'messages.2.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.'],
  ['tool_use_ids_duplicate', 'messages.1.content.2: `tool_use` ids must be unique'],
  ['tool_use_ids_duplicate', 'messages.1.content.2: `server_tool_use` ids must be unique per assistant turn'],
  ['tool_result_error_empty', 'messages.2.content.0.tool_result: content cannot be empty if `is_error` is true'],
  ['tool_result_error_not_text', 'messages.2.content.0.tool_result: all content must be type `text` if `is_error` is true'],
  ['tool_names_not_unique', 'tools: Tool names must be unique.'],
  ['tool_schema_root_combinator', 'tools.3.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level'],
  ['cache_control_limit', 'A maximum of 4 blocks with cache_control may be provided. Found 5.'],
  ['cache_control_nested', 'messages.2.content.0.tool_result.content.0.cache_control: cache_control may not be specified within `tool_result.content`. Instead, place it directly on `tool_result`'],
  ['cache_ttl_order', "messages.4.content.0.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block. Note that blocks are processed in the following order: `tools`, `system`, `messages`."],
  ['cache_control_on_empty_text', 'messages.1.content.0.text: cache_control cannot be set for empty text blocks'],
  ['image_url_unsupported', 'messages.1.content.0.image.source.base64.data: URL image sources are not supported'],
  ['image_not_its_media_type', 'messages.1.content.0.image.source.base64.data: The image was specified using the image/png media type, but does not appear to be a valid png image'],
  ['image_empty', 'messages.1.content.0.image.source.base64: image cannot be empty'],
  ['document_empty', 'messages.1.content.0.document.source.content: document content cannot be empty'],
  ['too_many_media', 'too many images and documents: 90 + 20 > 100'],
  ['user_content_empty', 'messages.0: user messages must have non-empty content'],
  ['messages_empty', 'messages: at least one message is required'],
  ['final_assistant_trailing_whitespace', 'messages: final assistant content cannot end with trailing whitespace'],
  ['field_required', 'messages.1.content.0.thinking.signature: Field required'],
  ['extra_input', 'messages.1.content.0.text.annotations: Extra inputs are not permitted'],
  ['unknown_tag', "messages.1.content.0: Input tag 'zz_block' found using 'type' does not match any of the expected tags: 'text', 'image'"],
  ['invalid_input', 'messages.1.content.0.server_tool_use.input: Input should be a valid dictionary'],
  ['unsupported_parameter', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."],
  ['unsupported_value', "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."],
];

describe('BAD_REQUEST_TEMPLATES', () => {
  it.each(MESSAGES)('%s, from its wording', (id, message) => {
    expect(classifyBadRequest(message).template).toBe(id);
  });

  it('every template has a message here, and ids are unique', () => {
    const ids = BAD_REQUEST_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(MESSAGES.map(([id]) => id))).toEqual(new Set(ids));
  });

  it("a message no template knows has none", () => {
    expect(classifyBadRequest('zz an error no one has seen before')).toEqual({});
    expect(classifyBadRequest('')).toEqual({});
  });

  it("a wording or a path later in a message isn't its opening", () => {
    expect(classifyBadRequest('zz an upstream said: Field required')).toEqual({});
    expect(classifyBadRequest('zz the provider says messages.1.content.0: Field required')).toEqual({});
    expect(classifyBadRequest('zz before Invalid `signature` in `thinking` block')).toEqual({});
  });
});

describe('the field path', () => {
  it('numbers become N, and every other segment is a request field name', () => {
    expect(classifyBadRequest('messages.12.content.3.tool_result: content cannot be empty if `is_error` is true')).toEqual({
      template: 'tool_result_error_empty',
      fieldPath: 'messages.N.content.N.tool_result',
    });
  });

  it('kept with no template, and the template kept with no path', () => {
    expect(classifyBadRequest('tools.2.custom: zz a rule no template knows')).toEqual({ fieldPath: 'tools.N.custom' });
    expect(classifyBadRequest('A maximum of 4 blocks with cache_control may be provided. Found 5.')).toEqual({ template: 'cache_control_limit' });
  });

  it("left out whole when a segment is a name the request chose, so that name never leaves", () => {
    expect(classifyBadRequest('tools.0.custom.input_schema.properties.zz_secret_field.type: Field required')).toEqual({
      template: 'field_required',
    });
  });

  it('left out when the message opens with no path', () => {
    expect(classifyBadRequest('prompt is too long: 210000 tokens > 200000 maximum')).toEqual({ template: 'prompt_too_long' });
    expect(classifyBadRequest("Unsupported parameter: 'zz' is not supported with this model.")).toEqual({ template: 'unsupported_parameter' });
  });

  it('a single segment counts when it is a field name', () => {
    expect(classifyBadRequest('tool_choice: type "tool" and "any" are not supported for this model.').fieldPath).toBe('tool_choice');
    expect(classifyBadRequest('zz_field: zz').fieldPath).toBeUndefined();
  });

  it('the field names are names only', () => {
    for (const name of REQUEST_FIELD_NAMES) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

/** A Bedrock event-stream exception frame carrying `payload` as its JSON. */
function exceptionFrame(exceptionType: string, payload: object): Uint8Array {
  const header = (name: string, value: string) => {
    const n = Buffer.from(name), v = Buffer.from(value);
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    out[0] = n.length; n.copy(out, 1);
    out[1 + n.length] = 7;
    out.writeUInt16BE(v.length, 2 + n.length);
    v.copy(out, 4 + n.length);
    return out;
  };
  const headers = Buffer.concat([header(':exception-type', exceptionType), header(':message-type', 'exception')]);
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12); body.copy(frame, 12 + headers.length);
  return frame;
}

describe('providerMessageOf', () => {
  it("reads a serialized SDK error's body, not the error's rendering", () => {
    const sdkError = Object.assign(new Error('400 {"zz":"rendered"}'), {
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0: Field required' } },
    });
    expect(providerMessageOf(serializeError(sdkError))).toBe('messages.0: Field required');
  });

  it("finds nothing in an Error with no body, whatever its own message says", () => {
    expect(providerMessageOf(serializeError(new Error('messages.0: Field required')))).toBeUndefined();
  });

  it("reads a parsed body's message, and a body's text", () => {
    expect(providerMessageOf({ message: 'messages.0: Field required' })).toBe('messages.0: Field required');
    expect(providerMessageOf('{"message":"messages.0: Field required"}')).toBe('messages.0: Field required');
  });

  it("reads the provider's message behind a router's wrapper, in a serialized SDK error's body too", () => {
    const wrapped = {
      error: {
        message: 'Provider returned error', code: 400,
        metadata: { raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }) },
      },
    };
    expect(providerMessageOf(serializeError(Object.assign(new Error('400 rendered'), { error: wrapped }))))
      .toBe('prompt is too long: 210000 tokens > 200000 maximum');
  });

  it("reads an error frame's error on its first choice, as throwOnStreamErrorFrame does, beside a top-level error that's null or empty", () => {
    const choices = [{ error: { code: 400, message: 'messages.0: Field required' }, finish_reason: 'error' }];
    expect(providerMessageOf({ choices })).toBe('messages.0: Field required');
    expect(providerMessageOf({ error: null, choices })).toBe('messages.0: Field required');
    expect(providerMessageOf({ error: '', choices })).toBe('messages.0: Field required');
  });

  it("reads a frame's top-level error over its first choice's, as throwOnStreamErrorFrame does", () => {
    expect(providerMessageOf({
      error: { message: 'prompt is too long: 210000 tokens > 200000 maximum' },
      choices: [{ error: { message: 'messages.0: Field required' } }],
    })).toBe('prompt is too long: 210000 tokens > 200000 maximum');
  });

  it("reads the provider's message behind a router's wrapper", () => {
    const wrapped = {
      error: {
        message: 'Provider returned error', code: 400,
        metadata: { raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }) },
      },
    };
    expect(providerMessageOf(wrapped)).toBe('prompt is too long: 210000 tokens > 200000 maximum');
  });
});

describe("the provider's message, as each adapter carries it, reaches the record", () => {
  const MODEL = 'claude-sonnet-4-5';
  const REQUEST: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
    config: { model: MODEL, maxTokens: 64 },
    toolMode: 'native',
  };
  const TAIL = 'messages.0.content.0.thinking.signature: Field required';

  async function recordOf(adapter: ProviderAdapter, method: 'complete' | 'stream'): Promise<AttemptRecord> {
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter(), onAttempt: (r) => { records.push(r); } });
    if (method === 'complete') await membrane.complete(REQUEST).catch(() => undefined);
    else await membrane.stream(REQUEST).catch(() => undefined);
    expect(records).toHaveLength(1);
    return records[0]!;
  }

  const expected = {
    type: 'invalid_request', httpStatus: 400, cancelled: false, deadline: false,
    template: 'field_required', fieldPath: 'messages.N.content.N.thinking.signature',
  };

  it.each(['complete', 'stream'] as const)('Anthropic (an SDK error carrying the body), %s()', async (method) => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: TAIL }, request_id: 'req_zz' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 400, headers: { 'content-type': 'application/json' },
    })));
    const record = await recordOf(new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }), method);
    expect(record.ending).toEqual({ error: { ...expected, providerErrorCode: 'invalid_request_error' } });
  });

  it.each(['complete', 'stream'] as const)('Bedrock (the body text on its error), %s(), with the limit it reported', async (method) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: TAIL }), {
      status: 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/' },
    })));
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' });
    const record = await recordOf(adapter, method);
    expect(record.ending).toMatchObject({ error: expected });
    // The limit was reported before the send, so a failed attempt keeps it.
    expect(record.maxTokens).toBe(64);
  });

  it.each(['complete', 'stream'] as const)("OpenRouter (the upstream provider's message inside the router's), %s()", async (method) => {
    const body = {
      error: {
        message: 'Provider returned error', code: 400,
        metadata: { raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }) },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 400, headers: { 'content-type': 'application/json' },
    })));
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'zz-key' }), { formatter: new NativeFormatter(), onAttempt: (r) => { records.push(r); } });
    const request = { ...REQUEST, config: { ...REQUEST.config, model: 'anthropic/claude-sonnet-4.5' } };
    if (method === 'complete') await membrane.complete(request).catch(() => undefined);
    else await membrane.stream(request).catch(() => undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.ending).toMatchObject({ error: { httpStatus: 400, template: 'prompt_too_long' } });
  });

  it('Bedrock, an exception inside the stream: its message, kept as the error\'s body, gives the template and path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(exceptionFrame('validationException', { message: TAIL })); controller.close(); },
    }), { status: 200 })));
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' });
    const record = await recordOf(adapter, 'stream');
    expect(record.ending).toEqual({ error: { ...expected, providerErrorCode: 'validationException' } });
  });

  it("Bedrock, an exception inside the stream with no message: the error keeps no body, since the provider sent no words", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(exceptionFrame('validationException', {})); controller.close(); },
    }), { status: 200 })));
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' }), {
      formatter: new NativeFormatter(), onAttempt: (r) => { records.push(r); },
    });
    const error = await membrane.stream(REQUEST).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).message).toContain('Bedrock stream error (validationException)');
    expect(((error as MembraneError).rawError as { error?: unknown }).error).toBeUndefined();
    // A 400 with no words of the provider's has no template or path.
    expect(records.map((r) => r.ending)).toEqual([{
      error: { type: 'invalid_request', httpStatus: 400, providerErrorCode: 'validationException', cancelled: false, deadline: false },
    }]);
  });

  it('Bedrock, an Anthropic error event inside the stream: its message gives the template and path', async () => {
    const event = { type: 'error', error: { type: 'invalid_request_error', message: TAIL } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody([chunkFrame(event)]) })));
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' });
    const record = await recordOf(adapter, 'stream');
    expect(record.ending).toEqual({ error: { ...expected, providerErrorCode: 'invalid_request_error' } });
  });

  it("OpenRouter, an error frame inside the stream on its first choice: the template and path", async () => {
    const frame = { choices: [{ index: 0, delta: {}, finish_reason: 'error', error: { code: 400, message: TAIL } }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(frame)}\n\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })));
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'zz-key' }), { formatter: new NativeFormatter(), onAttempt: (r) => { records.push(r); } });
    await membrane.stream({ ...REQUEST, config: { ...REQUEST.config, model: 'anthropic/claude-sonnet-4.5' } }).catch(() => undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.ending).toMatchObject({ error: { httpStatus: 400, template: 'field_required', fieldPath: 'messages.N.content.N.thinking.signature' } });
  });

  it.each(['complete', 'stream'] as const)('OpenAI (the parsed body as the raw error), %s()', async (method) => {
    const body = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model.", type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status: 400, headers: { 'content-type': 'application/json' },
    })));
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), { formatter: new NativeFormatter(), onAttempt: (r) => { records.push(r); } });
    const request = { ...REQUEST, config: { ...REQUEST.config, model: 'gpt-4o' } };
    if (method === 'complete') await membrane.complete(request).catch(() => undefined);
    else await membrane.stream(request).catch(() => undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.ending).toMatchObject({ error: { type: 'invalid_request', httpStatus: 400, template: 'unsupported_parameter' } });
    expect(Object.keys((records[0]!.ending as { error: object }).error)).not.toContain('fieldPath');
  });
});
