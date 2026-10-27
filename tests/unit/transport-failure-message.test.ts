/**
 * A request that can't reach its host says which host it tried and what
 * happened, through every adapter, in the shapes Node's and Bun's fetch reject
 * with: Node's code sits under `TypeError: fetch failed`, with each address's
 * attempt in an AggregateError for a name with several, and Bun's is on the
 * thrown error itself.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { MembraneError, classifyError, errorFromThrown, isOverloadedError, networkError, serializeError } from '../../src/types/errors.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/provider.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';

const request: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

/** Node's fetch: `TypeError: fetch failed`, its cause the socket's error. */
const nodeFailure = (code: string, place: { address?: string; port?: number; hostname?: string } = {}) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code, errno: -111, syscall: 'connect', ...place }) });

/** Node's fetch to a name with several addresses: each attempt's error in an AggregateError. */
const nodeAttempts = (...attempts: Array<{ code: string; address: string; port: number }>) =>
  new TypeError('fetch failed', {
    cause: Object.assign(new AggregateError(attempts.map((a) => Object.assign(new Error(`connect ${a.code}`), a)), ''), { code: attempts[0].code }),
  });

/** Bun's fetch: the code on the thrown error, and the URL in `path`. */
const bunFailure = (code: string, url: string, message = 'Unable to connect. Is the computer able to access the url?') =>
  Object.assign(new TypeError(`${code}: ${message}`), { code, path: url, errno: 0 });

const BASE = 'https://zz-user:zz-secret@api.zz-provider.test:8443/zz-path?key=zz-key';
const HOST = 'api.zz-provider.test:8443';

const adapters: Array<[string, (baseURL: string) => ProviderAdapter]> = [
  ['anthropic', (baseURL) => new AnthropicAdapter({ apiKey: 'zz-key', baseURL })],
  ['bedrock', (baseURL) => new BedrockAdapter({ baseURL, accessKeyId: 'zz-access', secretAccessKey: 'zz-secret-access' })],
  ['gemini', (baseURL) => new GeminiAdapter({ baseURL, apiKey: 'zz-key' })],
  ['openai', (baseURL) => new OpenAIAdapter({ baseURL, apiKey: 'zz-key' })],
  ['openai-compatible', (baseURL) => new OpenAICompatibleAdapter({ baseURL, apiKey: 'zz-key' })],
  ['openai-completions', (baseURL) => new OpenAICompletionsAdapter({ baseURL, apiKey: 'zz-key' })],
  ['openai-responses', (baseURL) => new OpenAIResponsesAdapter({ baseURL, apiKey: 'zz-key' })],
  ['openai-responses-api', (baseURL) => new OpenAIResponsesAPIAdapter({ baseURL, apiKey: 'zz-key' })],
  ['openrouter', (baseURL) => new OpenRouterAdapter({ baseURL, apiKey: 'zz-key' })],
];

async function failure(adapter: ProviderAdapter, entry: 'complete' | 'stream'): Promise<MembraneError> {
  try {
    if (entry === 'complete') await adapter.complete(request);
    else await adapter.stream(request, { onChunk: () => {} });
  } catch (error) {
    expect(error).toBeInstanceOf(MembraneError);
    return error as MembraneError;
  }
  throw new Error('expected the call to reject');
}

afterEach(() => vi.unstubAllGlobals());

describe("every adapter's error names the host it tried and what happened", () => {
  const cases = adapters.flatMap(([name, make]) => (['complete', 'stream'] as const).map((entry) => [name, entry, make] as const));

  it.each(cases)('%s %s: Node, refused at an address other than the host\'s', async (_name, entry, make) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw nodeFailure('ECONNREFUSED', { address: '0.0.0.0', port: 8443 }); }));
    const error = await failure(make(BASE), entry);
    expect(error.message).toBe(`The request to ${HOST} failed: the connection was refused (ECONNREFUSED at 0.0.0.0:8443).`);
    expect(error).toMatchObject({ type: 'network', retryable: true });
  });

  it.each(cases)('%s %s: Bun, refused', async (_name, entry, make) => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw bunFailure('ECONNREFUSED', String(url)); }));
    const error = await failure(make(BASE), entry);
    expect(error.message).toBe(`The request to ${HOST} failed: the connection was refused (ECONNREFUSED).`);
    expect(error).toMatchObject({ type: 'network', retryable: true });
  });

  it('bedrock with no baseURL names its regional endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw nodeFailure('ENOTFOUND', { hostname: 'bedrock-runtime.zz-region-1.amazonaws.com' }); }));
    const error = await failure(new BedrockAdapter({ region: 'zz-region-1', accessKeyId: 'zz-access', secretAccessKey: 'zz-secret-access' }), 'complete');
    expect(error.message).toBe("The request to bedrock-runtime.zz-region-1.amazonaws.com failed: the host name didn't resolve (ENOTFOUND).");
  });

  it("a credential resolver's own failure keeps its own text and doesn't name the adapter's host", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const fetching = new OpenAIResponsesAPIAdapter({
      baseURL: BASE,
      credentials: async () => { throw nodeFailure('ECONNREFUSED', { address: '192.0.2.7', port: 443 }); },
    });
    expect((await failure(fetching, 'complete')).message).toBe('fetch failed');
    const anthropic = new AnthropicAdapter({
      baseURL: BASE,
      credentials: async () => { throw nodeFailure('ECONNREFUSED', { address: '192.0.2.7', port: 443 }); },
    });
    const error = await failure(anthropic, 'complete');
    expect(error.message).toBe('Credential resolution failed: fetch failed');
  });

  it("a resolved credential whose headers can't be read keeps that failure's own text and names no host", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const credential = {
      token: 'zz-token',
      get headers(): Record<string, string> { throw Object.assign(new Error('zz headers unreadable'), { code: 'ECONNRESET' }); },
    };
    const adapter = new OpenAIResponsesAPIAdapter({ baseURL: BASE, credentials: async () => credential });
    expect((await failure(adapter, 'complete')).message).toBe('zz headers unreadable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a call aborted while its credential is resolved, or before, is the caller's abort and names no host", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const reason = () => Object.assign(new Error('zz caller gave up'), { code: 'ECONNRESET' });
    const rejected = (adapter: ProviderAdapter, signal: AbortSignal) =>
      adapter.complete(request, { signal }).then(() => { throw new Error('expected the call to reject'); }, (error: unknown) => error as MembraneError);
    const during = new AbortController();
    const resolving = new OpenAIResponsesAPIAdapter({
      baseURL: BASE,
      credentials: () => { setTimeout(() => during.abort(reason()), 0); return new Promise<never>(() => {}); },
    });
    const aborted = { type: 'abort', retryable: false, message: 'Request was aborted' };
    const shown = (error: MembraneError) => ({ type: error.type, retryable: error.retryable, message: error.message });
    expect(shown(await rejected(resolving, during.signal))).toEqual(aborted);
    const before = new AbortController();
    before.abort(reason());
    const resolved = new OpenAIResponsesAPIAdapter({ baseURL: BASE, credentials: async () => ({ token: 'zz-token' }) });
    expect(shown(await rejected(resolved, before.signal))).toEqual(aborted);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a credential resolver's rejection that isn't an object stays what it was", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const adapter = new OpenAIResponsesAPIAdapter({ baseURL: BASE, credentials: () => Promise.reject('zz-resolver-refused') });
    expect((await failure(adapter, 'complete')).message).toBe('zz-resolver-refused');
  });

  it.each([
    ['complete', undefined, 'https://bedrock-runtime.zz-region-1.amazonaws.com/model/', '/invoke'],
    ['stream', undefined, 'https://bedrock-runtime.zz-region-1.amazonaws.com/model/', '/invoke-with-response-stream'],
    ['complete', 'https://zz-gateway.test/bedrock/', 'https://zz-gateway.test/bedrock/model/', '/invoke'],
    ['stream', 'https://zz-gateway.test/bedrock/', 'https://zz-gateway.test/bedrock/model/', '/invoke-with-response-stream'],
  ] as const)('bedrock %s with baseURL %s sends to %s<model>%s', async (entry, baseURL, start, end) => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (to: unknown) => { sent.push(String(to)); throw nodeFailure('ECONNREFUSED'); }));
    await failure(new BedrockAdapter({ region: 'zz-region-1', accessKeyId: 'zz-access', secretAccessKey: 'zz-secret-access', ...(baseURL ? { baseURL } : {}) }), entry);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.startsWith(start) && sent[0]!.endsWith(end) && !sent[0]!.slice(start.length, -end.length).includes('/')).toBe(true);
  });
});

describe('plain words for each transport code, with the code, and the type it gives as before', () => {
  const words: Array<[string, string, string]> = [
    ['ECONNREFUSED', 'the connection was refused', 'network'],
    ['ConnectionRefused', "the connection was refused or the host name didn't resolve", 'network'],
    ['ENOTFOUND', "the host name didn't resolve", 'network'],
    ['EAI_AGAIN', "the host name didn't resolve", 'network'],
    ['ECONNRESET', 'the connection was reset', 'network'],
    ['ConnectionReset', 'the connection was reset', 'network'],
    ['EPIPE', 'the connection was closed', 'network'],
    ['ECONNABORTED', 'the connection was closed', 'network'],
    ['UND_ERR_SOCKET', 'the connection was closed', 'network'],
    ['ConnectionClosed', 'the connection was closed', 'network'],
    ['EHOSTUNREACH', "the host couldn't be reached", 'network'],
    ['ENETUNREACH', "the host couldn't be reached", 'network'],
    ['ETIMEDOUT', 'the connection timed out', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'the connection timed out', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'no response arrived in time', 'timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'the response stopped arriving', 'timeout'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', "the server's certificate isn't trusted", 'unknown'],
    ['SELF_SIGNED_CERT_IN_CHAIN', "the server's certificate isn't trusted", 'unknown'],
    ['UNABLE_TO_GET_ISSUER_CERT', "the server's certificate isn't trusted", 'unknown'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', "the server's certificate isn't trusted", 'unknown'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', "the server's certificate isn't trusted", 'unknown'],
    ['CERT_HAS_EXPIRED', "the server's certificate has expired", 'unknown'],
    ['CERT_NOT_YET_VALID', "the server's certificate isn't valid yet", 'unknown'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "the server's certificate is for another name", 'unknown'],
  ];

  it.each(words)('%s: "%s"', (code, said) => {
    const error = errorFromThrown(nodeFailure(code), undefined, 'https://api.zz-provider.test/v1');
    expect(error.message).toBe(`The request to api.zz-provider.test failed: ${said} (${code}).`);
  });

  it.each(words)('%s alone types the error as before', (code, _said, type) => {
    expect(classifyError(Object.assign(new Error('zz-no-keyword'), { code })).type).toBe(type);
  });

  it("a code with no words follows the error's own text", () => {
    expect(errorFromThrown(nodeFailure('EPROTO'), undefined, 'https://api.zz-provider.test/v1').message)
      .toBe('The request to api.zz-provider.test failed: fetch failed (EPROTO).');
    const closed = Object.assign(new Error('zz premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    expect(networkError('Stream aborted by provider.', closed).message)
      .toBe('The request failed: Stream aborted by provider (ERR_STREAM_PREMATURE_CLOSE).');
    expect(networkError('', closed).message).toBe('The request failed: ERR_STREAM_PREMATURE_CLOSE.');
    const mixed = new TypeError('fetch failed', { cause: Object.assign(new Error('zz'), { code: 'ECONNRESET', cause: Object.assign(new Error('zz'), { code: 'EPROTO' }) }) });
    expect(errorFromThrown(mixed, undefined, 'https://api.zz-provider.test').message)
      .toBe('The request to api.zz-provider.test failed: the connection was reset (ECONNRESET); fetch failed (EPROTO).');
  });

  it('codes with no words follow the worded ones, each with the addresses it was met at', () => {
    const chain = Object.assign(new TypeError('fetch failed', {
      cause: Object.assign(new Error('zz'), {
        code: 'ECONNRESET',
        cause: Object.assign(new Error('zz'), { code: 'ERR_ZZ_TWO', address: '192.0.2.9', port: 8443 }),
      }),
    }), { code: 'ERR_ZZ_ONE' });
    expect(errorFromThrown(chain, undefined, 'https://api.zz-provider.test').message)
      .toBe('The request to api.zz-provider.test failed: the connection was reset (ECONNRESET); fetch failed (ERR_ZZ_ONE, ERR_ZZ_TWO at 192.0.2.9:8443).');
  });

  it("a code the error's own text already names isn't named again", () => {
    expect(errorFromThrown(bunFailure('EADDRNOTAVAIL', 'https://api.zz-provider.test/v1', 'zz socket unavailable'), undefined, 'https://api.zz-provider.test/v1').message)
      .toBe('The request to api.zz-provider.test failed: EADDRNOTAVAIL: zz socket unavailable.');
    const placed = Object.assign(new Error('EADDRNOTAVAIL: zz socket unavailable'), { code: 'EADDRNOTAVAIL', address: '192.0.2.9', port: 443 });
    expect(errorFromThrown(placed, undefined, 'https://api.zz-provider.test/v1').message)
      .toBe('The request to api.zz-provider.test failed: EADDRNOTAVAIL: zz socket unavailable (EADDRNOTAVAIL at 192.0.2.9:443).');
    expect(errorFromThrown(nodeFailure('EPROTONOSUPPORT'), undefined, 'https://api.zz-provider.test').message.includes('(EPROTONOSUPPORT)')).toBe(true);
  });
});

describe('the addresses a code was met at', () => {
  it('each code once, with every address it was met at, from each attempt of a name with several', () => {
    const error = errorFromThrown(
      nodeAttempts({ code: 'ECONNREFUSED', address: '::1', port: 44209 }, { code: 'ECONNREFUSED', address: '127.0.0.1', port: 44209 }),
      undefined,
      'http://localhost:44209/v1',
    );
    expect(error.message).toBe('The request to localhost:44209 failed: the connection was refused (ECONNREFUSED at [::1]:44209, 127.0.0.1:44209).');
    expect(error).toMatchObject({ type: 'network', retryable: true });
  });

  it('attempts that failed differently each name their own code', () => {
    const error = errorFromThrown(
      nodeAttempts({ code: 'ENETUNREACH', address: '2001:db8::7', port: 443 }, { code: 'ECONNREFUSED', address: '192.0.2.7', port: 443 }),
      undefined,
      'https://api.zz-provider.test',
    );
    expect(error.message).toBe(
      "The request to api.zz-provider.test failed: the host couldn't be reached (ENETUNREACH at [2001:db8::7]:443); the connection was refused (ECONNREFUSED at 192.0.2.7:443).",
    );
  });

  it("the target's own address, on its default port, isn't repeated", () => {
    expect(errorFromThrown(nodeFailure('ECONNREFUSED', { address: '192.0.2.7', port: 443 }), undefined, 'https://192.0.2.7/v1').message)
      .toBe('The request to 192.0.2.7 failed: the connection was refused (ECONNREFUSED).');
    expect(errorFromThrown(nodeFailure('ECONNREFUSED', { address: '192.0.2.7', port: 80 }), undefined, 'http://192.0.2.7/v1').message)
      .toBe('The request to 192.0.2.7 failed: the connection was refused (ECONNREFUSED).');
    expect(errorFromThrown(nodeFailure('ECONNREFUSED', { address: '::1', port: 8080 }), undefined, 'http://[::1]:8080').message)
      .toBe('The request to [::1]:8080 failed: the connection was refused (ECONNREFUSED).');
  });

  it('the same address on another port is named', () => {
    expect(errorFromThrown(nodeFailure('ECONNREFUSED', { address: '192.0.2.7', port: 8443 }), undefined, 'https://192.0.2.7/v1').message)
      .toBe('The request to 192.0.2.7 failed: the connection was refused (ECONNREFUSED at 192.0.2.7:8443).');
  });

  it('with no target, the addresses and names alone', () => {
    expect(errorFromThrown(nodeFailure('ECONNREFUSED', { address: '127.0.0.1', port: 443 })).message)
      .toBe('The request failed: the connection was refused (ECONNREFUSED at 127.0.0.1:443).');
    expect(errorFromThrown(nodeFailure('ENOTFOUND', { hostname: 'no-such-host.invalid' })).message)
      .toBe("The request failed: the host name didn't resolve (ENOTFOUND at no-such-host.invalid).");
    expect(errorFromThrown(bunFailure('ECONNREFUSED', 'http://zz-user:zz-secret@localhost:1/v1')).message)
      .toBe('The request failed: the connection was refused (ECONNREFUSED).');
  });

  it('a target that is not a URL is no target', () => {
    expect(errorFromThrown(nodeFailure('ECONNREFUSED', { address: '127.0.0.1', port: 443 }), undefined, 'zz not a url').message)
      .toBe('The request failed: the connection was refused (ECONNREFUSED at 127.0.0.1:443).');
  });
});

describe("the Anthropic SDK's connection error", () => {
  it('names the host from the base URL the client uses, two causes down', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', baseURL: BASE });
    const sdkError = new Anthropic.APIConnectionError({ cause: nodeFailure('ECONNREFUSED', { address: '0.0.0.0', port: 8443 }) });
    const error = (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(sdkError);
    expect(error.message).toBe(`The request to ${HOST} failed: the connection was refused (ECONNREFUSED at 0.0.0.0:8443).`);
  });

  it("names it for a read cut off mid-response, which the SDK's MessageStream wraps once more", () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', baseURL: BASE });
    const socket = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
    const cut = Object.assign(new Anthropic.AnthropicError('terminated'), { cause: new TypeError('terminated', { cause: socket }) });
    const error = (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(cut);
    expect(error.message).toBe(`The request to ${HOST} failed: the connection was closed (UND_ERR_SOCKET).`);
    expect(error).toMatchObject({ type: 'network', retryable: true });
  });

  it('with no base URL configured, the default host', () => {
    const before = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      const adapter = new AnthropicAdapter({ apiKey: 'zz-key' });
      const sdkError = new Anthropic.APIConnectionError({ cause: nodeFailure('ECONNREFUSED', { address: '0.0.0.0', port: 443 }) });
      const error = (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(sdkError);
      expect(error.message).toBe('The request to api.anthropic.com failed: the connection was refused (ECONNREFUSED at 0.0.0.0:443).');
    } finally {
      if (before !== undefined) process.env.ANTHROPIC_BASE_URL = before;
    }
  });
});

describe('what stays as it was', () => {
  it('a failure whose causes carry no code keeps its own text', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', baseURL: BASE });
    const sdkError = new Anthropic.APIConnectionError({ cause: new TypeError('fetch failed') });
    expect((adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(sdkError).message).toBe('Connection error.');
    expect(errorFromThrown(new TypeError('fetch failed'), undefined, BASE).message).toBe('fetch failed');
    expect(errorFromThrown(new DOMException('The operation timed out.', 'TimeoutError'), undefined, BASE).message).toBe('The operation timed out.');
    expect(networkError('zz stream ended early', undefined, undefined, BASE).message).toBe('zz stream ended early');
  });

  it("a certificate failure that isn't a network error keeps its text: Bun's fetch", () => {
    const thrown = Object.assign(new TypeError('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', path: 'https://localhost:1/' });
    const error = errorFromThrown(thrown, undefined, 'https://localhost:1');
    expect(error).toMatchObject({ type: 'unknown', retryable: false, message: 'self signed certificate' });
  });

  it('type, retryability, the raw error and the deadline mark', () => {
    const refused = nodeFailure('ECONNREFUSED', { address: '0.0.0.0', port: 443 });
    expect(errorFromThrown(refused, undefined, BASE)).toMatchObject({ type: 'network', retryable: true, rawError: serializeError(refused) });
    const headers = nodeFailure('UND_ERR_HEADERS_TIMEOUT');
    const sent = errorFromThrown(headers, undefined, BASE);
    expect(sent).toMatchObject({ type: 'timeout', retryable: true, rawError: serializeError(headers) });
    expect((sent as unknown as Record<symbol, unknown>)[Symbol.for('membrane.deadlineExpiry')]).toBe(true);
  });

  it('a connection refused or timed out at a host on port 529 is not retried as an overload', () => {
    const refused = errorFromThrown(nodeFailure('ECONNREFUSED', { address: '192.0.2.7', port: 529 }), undefined, 'https://node-529.zz-provider.test:529');
    expect(refused.message).toContain('529');
    expect(isOverloadedError(refused.toErrorInfo())).toBe(false);
    const slow = errorFromThrown(nodeFailure('UND_ERR_CONNECT_TIMEOUT'), undefined, 'https://node-529.zz-provider.test:529');
    expect(slow).toMatchObject({ type: 'timeout', retryable: true });
    expect(slow.message).toContain('529');
    expect(isOverloadedError(slow.toErrorInfo())).toBe(false);
  });
});

describe('through real sockets on this runtime', () => {
  let refusedPort = 0;
  let resetPort = 0;
  const resetServer = net.createServer((socket) => socket.resetAndDestroy());
  const listen = (server: net.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

  beforeAll(async () => {
    const probe = net.createServer();
    refusedPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    resetPort = await listen(resetServer);
  });
  afterAll(() => new Promise((resolve) => resetServer.close(resolve)));

  it.each([['anthropic', adapters[0][1]], ['openai-compatible', adapters[4][1]]] as const)('%s: refused and reset', async (_name, make) => {
    const refused = await failure(make(`http://127.0.0.1:${refusedPort}/v1`), 'complete');
    expect(refused.message).toBe(`The request to 127.0.0.1:${refusedPort} failed: the connection was refused (ECONNREFUSED).`);
    const reset = await failure(make(`http://127.0.0.1:${resetPort}/v1`), 'complete');
    expect(reset.type).toBe('network');
    const resetWords = 'the connection was (reset \\(ECONNRESET\\)|closed \\((EPIPE|UND_ERR_SOCKET)\\))';
    expect(reset.message).toMatch(new RegExp(`^The request to 127\\.0\\.0\\.1:${resetPort} failed: ${resetWords}(; ${resetWords})*\\.$`));
  });
});

describe("a caller's own error", () => {
  it('thrown from a stream callback through Membrane keeps its text and names no host', async () => {
    const own = Object.assign(new Error('zz downstream socket closed'), { code: 'EPIPE' });
    const membrane = new Membrane(new MockAdapter(), { retry: { maxRetries: 0 } });
    const thrown = await membrane
      .stream({ messages: [{ participant: 'user', content: [{ type: 'text', text: 'zz' }] }], config: { model: 'zz-model-1', maxTokens: 16 } }, { onChunk: () => { throw own; } })
      .then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(MembraneError);
    expect((thrown as MembraneError).message).toBe('zz downstream socket closed');
    expect((thrown as MembraneError & { cause?: unknown }).cause).toBe(own);
  });
});
