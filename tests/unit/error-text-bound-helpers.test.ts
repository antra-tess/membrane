/**
 * The bound itself: MembraneError's message, stack, rawError and
 * providerErrorCode, with controls showing that small errors are unchanged.
 * Boundary and consumer evidence lives in error-text-bounds.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MembraneError,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_PROVIDER_ERROR_CODE_CHARS,
  MAX_RAW_ERROR_JSON_BYTES,
  boundErrorText,
  boundRawError,
  classifyError,
  isOverloadedError,
  serializeError,
} from '../../src/types/errors.js';
import type { ErrorInfo } from '../../src/types/errors.js';

/** Length of the omission marker boundErrorText inserts, at these sizes. */
const MARKER_ALLOWANCE = 64;
/** A bounded stack: the bounded message plus a modest frame list. */
const STACK_ALLOWANCE = MAX_ERROR_MESSAGE_CHARS + MARKER_ALLOWANCE + 8_000;

const echo = (n: number, word = '') => `${'zz-echo '.repeat(Math.ceil(n / 16))}${word}${'zz-echo '.repeat(Math.ceil(n / 16))}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function bigError(rawError?: unknown, providerErrorCode?: string): MembraneError {
  return new MembraneError({
    type: 'invalid_request',
    message: `zz-provider API error 400: ${echo(1_000_000)}`,
    retryable: false,
    httpStatus: 400,
    providerErrorCode,
    rawError,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the bound', () => {
  it('leaves a small error exactly as it was (control)', () => {
    const rawError = { error: { message: 'zz-short', type: 'invalid_request_error' } };
    const error = new MembraneError({
      type: 'invalid_request',
      message: 'zz-provider API error 400: zz-short',
      retryable: false,
      httpStatus: 400,
      providerErrorCode: 'invalid_request_error',
      rawError,
    });
    expect(error.message).toBe('zz-provider API error 400: zz-short');
    expect(error.rawError).toBe(rawError);
    expect(error.providerErrorCode).toBe('invalid_request_error');
    expect(error.stack?.startsWith('MembraneError: zz-provider API error 400: zz-short')
      || error.stack?.startsWith('Error: zz-provider API error 400: zz-short')).toBe(true);
  });

  it('keeps a head and a tail around a marker that states what was omitted, within max', () => {
    const text = `${'h'.repeat(1_600)}${'m'.repeat(1_000)}${'t'.repeat(400)}`;
    const bounded = boundErrorText(text, 2_000);
    expect(bounded.length).toBeLessThanOrEqual(2_000);
    const marker = bounded.match(/ …\[(\d+) of 3000 characters omitted\]… /);
    expect(marker).not.toBeNull();
    const [head, tail] = bounded.split(marker![0]);
    expect(head).toBe('h'.repeat(head!.length));
    expect(head!.length).toBeGreaterThan(1_400);
    expect(tail!.endsWith('t'.repeat(400))).toBe(true);
    expect(head!.length + tail!.length + Number(marker![1])).toBe(3_000);
    expect(text.startsWith(head!) && text.endsWith(tail!)).toBe(true);
    expect(boundErrorText('zz-fits', 2_000)).toBe('zz-fits');
    expect(boundErrorText(bounded, 2_000)).toBe(bounded);
  });

  it('never splits a surrogate pair at either cut, and stays within max', () => {
    for (const offset of [0, 1]) {
      const text = `${'x'.repeat(offset)}${'😀'.repeat(3_000)}`;
      const bounded = boundErrorText(text, 2_000);
      expect(loneSurrogate.test(bounded)).toBe(false);
      expect(bounded.length).toBeLessThanOrEqual(2_000);
    }
    // One pair straddling each computed cut, at every nearby position (June's
    // 99,000-unit case is one of these). The head cut falls within the first
    // 2,100 units and the tail cut within the last 600, so both ranges are
    // walked whole.
    for (const n of [5_000, 99_000]) {
      const nearCuts = [
        ...Array.from({ length: 2_099 }, (_, i) => i + 1),
        ...Array.from({ length: 599 }, (_, i) => n - 600 + i),
      ];
      for (const at of nearCuts) {
        const text = `${'x'.repeat(at - 1)}😀${'x'.repeat(n - at - 1)}`;
        const bounded = boundErrorText(text, 2_000);
        expect(bounded.length).toBeLessThanOrEqual(2_000);
        expect(loneSurrogate.test(bounded)).toBe(false);
      }
    }
  });

  it('bounds the message and therefore the stack of a 1 MB message', () => {
    const error = bigError();
    expect(error.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    expect(error.message.startsWith('zz-provider API error 400: zz-echo')).toBe(true);
    expect(error.message).toMatch(/characters omitted\]…/);
    expect((error.stack ?? '').length).toBeLessThanOrEqual(STACK_ALLOWANCE);
    expect(error.type).toBe('invalid_request');
    expect(error.httpStatus).toBe(400);
    expect(error.retryable).toBe(false);
  });

  it('summarizes an oversized rawError with its length, sha256 and head', () => {
    const body = { error: { message: 'Image inputs are not supported for this model' }, request: { text: echo(1_000_000) } };
    const error = bigError(body);
    const json = JSON.stringify(body);
    expect(error.rawError).toEqual({
      truncated: true,
      jsonBytes: Buffer.byteLength(json, 'utf8'),
      sha256: sha256(json),
      head: json.slice(0, 2_048),
    });
    expect(utf8(error.rawError)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('bounds the aggregate, not each string: many small fields still count', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 2_000; i++) many[`field${i}`] = 'zz-value-0123456789';
    const error = bigError(many);
    expect((error.rawError as { truncated?: boolean }).truncated).toBe(true);
    expect(utf8(error.rawError)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('counts nested Error properties and enumerable fields of a serialized Error', () => {
    const inner = Object.assign(new Error('zz-inner'), { body: { request: echo(200_000) } });
    const error = bigError(inner);
    expect(utf8(error.rawError)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
    expect((error.rawError as { truncated?: boolean }).truncated).toBe(true);
  });

  it('turns a small cyclic rawError into an acyclic copy and never throws', () => {
    const cyclic: Record<string, unknown> = { error: { message: 'zz-cyclic' } };
    cyclic.self = cyclic;
    const error = bigError(cyclic);
    expect(error.rawError).toEqual({ error: { message: 'zz-cyclic' }, self: '[Circular]' });
    expect(() => JSON.stringify(error)).not.toThrow();
  });

  it('keeps repeated non-cyclic references when a cycle forces the acyclic form', () => {
    const shared = { code: 'zz-shared' };
    const value: Record<string, unknown> = { a: shared, b: shared };
    value.loop = value;
    expect(boundRawError(value)).toEqual({ a: { code: 'zz-shared' }, b: { code: 'zz-shared' }, loop: '[Circular]' });
  });

  it('summarizes a large cyclic rawError instead of throwing', () => {
    const cyclic: Record<string, unknown> = { request: echo(100_000) };
    cyclic.self = cyclic;
    const error = bigError(cyclic);
    expect((error.rawError as { truncated?: boolean }).truncated).toBe(true);
    expect(utf8(error.rawError)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('describes an unserializable rawError instead of breaking the error path', () => {
    const hostile = { toJSON() { throw new Error('zz-cannot serialize'); } };
    let error: MembraneError | undefined;
    expect(() => { error = bigError(hostile); }).not.toThrow();
    expect(error!.rawError).toEqual({
      truncated: true,
      unserializable: 'Error: zz-cannot serialize',
      valueType: 'object',
    });
  });

  it('measures the aggregate in UTF-8 bytes, not UTF-16 code units', () => {
    // 8,000 three-byte characters: 8,002 code units of JSON but 24,002 bytes.
    const wide = '界'.repeat(8_000);
    expect(boundRawError(wide)).toEqual({
      truncated: true,
      bytes: 24_000,
      sha256: sha256(wide),
      head: wide.slice(0, 2_048),
    });
    const fits = '界'.repeat(5_000); // 15,002 bytes of JSON
    expect(boundRawError(fits)).toBe(fits);
    const error = bigError({ text: wide });
    expect(utf8(error.rawError)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('keeps the failure when the rawError throws on being asked whether it is an Error', () => {
    // instanceof walks the prototype chain, so a Proxy whose getPrototypeOf
    // throws can't be asked whether it is an Error. serializeError describes
    // it instead of keeping it, and the failure being reported stands.
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('zz-prototype trap failed'); } });
    expect(serializeError(hostile)).toEqual({ truncated: true, unserializable: '[unreadable: Error: zz-prototype trap failed]' });
    let error: MembraneError | undefined;
    expect(() => {
      error = new MembraneError({ type: 'invalid_request', retryable: false, message: 'zz-original provider failure', rawError: hostile });
    }).not.toThrow();
    expect(error!.message).toBe('zz-original provider failure');
    expect(error!.rawError).toEqual({ truncated: true, unserializable: '[unreadable: Error: zz-prototype trap failed]' });
  });

  it('keeps the failure when an Error property getter throws', () => {
    const source = new Error('zz-original provider failure');
    Object.defineProperty(source, 'response', {
      enumerable: true,
      get() { throw new Error('zz-response getter failed'); },
    });
    let error: MembraneError | undefined;
    expect(() => {
      error = new MembraneError({ type: 'invalid_request', retryable: false, message: 'zz-original provider failure', rawError: source });
    }).not.toThrow();
    expect(error!.message).toBe('zz-original provider failure');
    expect(error!.type).toBe('invalid_request');
    expect((error!.rawError as Record<string, unknown>).message).toBe('zz-original provider failure');
    expect((error!.rawError as Record<string, unknown>).response).toBe('[unreadable: Error: zz-response getter failed]');
    expect(() => serializeError(source)).not.toThrow();
  });

  it('keeps the failure when even the key listing of a rawError throws', () => {
    const hostile = new Proxy(new Error('zz-proxied'), {
      ownKeys() { throw new Error('zz-ownKeys failed'); },
    });
    let error: MembraneError | undefined;
    expect(() => {
      error = new MembraneError({ type: 'unknown', retryable: false, message: 'zz-still here', rawError: hostile });
    }).not.toThrow();
    expect(error!.message).toBe('zz-still here');
    expect(utf8(error!.rawError ?? null)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('writes a BigInt as its decimal string when it forces the acyclic form', () => {
    expect(boundRawError({ count: 12n })).toEqual({ count: '12' });
  });

  it('keeps a token-sized provider code and bounds a provider-sized one', () => {
    const exact = 'c'.repeat(MAX_PROVIDER_ERROR_CODE_CHARS);
    expect(bigError(undefined, exact).providerErrorCode).toBe(exact);
    const oversized = `zz_code_${echo(1_000)}`;
    const bounded = bigError(undefined, oversized).providerErrorCode!;
    expect(bounded.length).toBeLessThan(100);
    expect(bounded.startsWith('zz_code_zz-echo')).toBe(true);
    expect(bounded.endsWith(`…[${oversized.length} characters]`)).toBe(true);
  });

  it('is idempotent across toErrorInfo round trips', () => {
    const first = bigError({ request: echo(100_000) }, `zz_${'c'.repeat(300)}`);
    const second = new MembraneError(first.toErrorInfo());
    expect(second.message).toBe(first.message);
    expect(second.rawError).toEqual(first.rawError);
    expect(second.providerErrorCode).toBe(first.providerErrorCode);
  });

  it('bounds the message and stack of a serialized Error', () => {
    const serialized = serializeError(new Error(echo(500_000))) as { message: string; stack?: string };
    expect(serialized.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    expect((serialized.stack ?? '').length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  });

  /** An Error carrying its message and stack as own enumerable properties. */
  const enumerableError = (message: string, stack: string) => {
    // A message-less Error has no own message, so Object.assign creates an
    // enumerable one; the runtime's own stack is redefined as enumerable.
    const error = Object.assign(new Error(), { message, status: 400 });
    Object.defineProperty(error, 'stack', { value: stack, enumerable: true, configurable: true, writable: true });
    return error;
  };

  it('keeps those bounds when message and stack are own enumerable properties', () => {
    class AssignedMessageError extends Error {
      constructor(text: string) {
        super();
        this.message = text;
      }
    }
    for (const source of [enumerableError(echo(500_000), echo(500_000)), new AssignedMessageError(echo(500_000))]) {
      expect(Object.keys(source)).toContain('message');
      const serialized = serializeError(source) as Record<string, unknown>;
      expect((serialized.message as string).length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
      expect(((serialized.stack as string | undefined) ?? '').length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    }
    // Other enumerable fields are still copied.
    expect((serializeError(enumerableError('zz-small', 'zz-stack')) as Record<string, unknown>).status).toBe(400);
  });

  it('leaves an enumerable stack out in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const serialized = serializeError(enumerableError('zz-small', echo(500_000))) as Record<string, unknown>;
      expect(serialized).not.toHaveProperty('stack');
      expect(serialized).toMatchObject({ message: 'zz-small', status: 400 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the bounds at their exact limits', () => {
  it('keeps a message of exactly the cap and cuts one character more', () => {
    const exact = 'm'.repeat(MAX_ERROR_MESSAGE_CHARS);
    expect(boundErrorText(exact)).toBe(exact);
    expect(new MembraneError({ type: 'unknown', retryable: false, message: exact, rawError: undefined }).message).toBe(exact);
    const over = boundErrorText(`${exact}m`);
    expect(over).toMatch(/characters omitted\]…/);
    expect(over.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  });

  it('keeps a rawError of exactly the byte bound and summarizes one byte more', () => {
    // A string's JSON is its text and two quotes.
    const exact = 'b'.repeat(MAX_RAW_ERROR_JSON_BYTES - 2);
    expect(utf8(exact)).toBe(MAX_RAW_ERROR_JSON_BYTES);
    expect(boundRawError(exact)).toBe(exact);
    expect(boundRawError(`${exact}b`)).toMatchObject({ truncated: true, bytes: MAX_RAW_ERROR_JSON_BYTES - 1 });
  });
});

describe('serializeError holds its whole result to the bound', () => {
  it('summarizes an Error whose copied fields are oversized, as a MembraneError would', () => {
    const source = Object.assign(new Error('zz-small'), { error: { request: echo(200_000) } });
    const serialized = serializeError(source);
    expect((serialized as { truncated?: boolean }).truncated).toBe(true);
    expect(utf8(serialized)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('counts the name and a message or stack that is not a string', () => {
    const named = new Error('zz-small');
    named.name = `ZzError${echo(100_000)}`;
    const unstrung = new Error();
    Object.defineProperty(unstrung, 'message', { value: { text: echo(100_000) } });
    Object.defineProperty(unstrung, 'stack', { value: { frames: echo(100_000) } });
    for (const source of [named, unstrung]) {
      const serialized = serializeError(source);
      expect((serialized as { truncated?: boolean }).truncated).toBe(true);
      expect(utf8(serialized)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
    }
  });

  it('bounds a value that is not an Error, and keeps a small one as it is (control)', () => {
    const body = echo(100_000);
    expect(serializeError(body)).toMatchObject({ truncated: true, bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body) });
    const small = { error: { message: 'zz-short' } };
    expect(serializeError(small)).toBe(small);
  });

  it("bounds classifyError's rawError for a throwable that is not a MembraneError", () => {
    const thrown = Object.assign(new Error('zz-socket hang up'), { response: { body: echo(200_000) } });
    const info = classifyError(thrown);
    expect(info.type).toBe('network');
    expect(utf8(info.rawError)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });
});

describe('an Error held in a serialized field', () => {
  it('is serialized like the top-level one, so its text counts and is cut', () => {
    const inner = new Error(echo(100_000));
    const outer = Object.assign(new Error('zz-outer'), { original: inner, status: 502 });
    const serialized = serializeError(outer) as { status: number; original: { name: string; message: string; stack?: string } };
    expect(serialized.status).toBe(502);
    expect(serialized.original.name).toBe('Error');
    expect(serialized.original.message.startsWith('zz-echo')).toBe(true);
    expect(serialized.original.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    expect((serialized.original.stack ?? '').length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    expect(utf8(serialized)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('counts the inner error toward the aggregate, so a large one is summarized', () => {
    const inner = Object.assign(new Error('zz-inner'), { body: echo(200_000) });
    const serialized = serializeError(Object.assign(new Error('zz-outer'), { original: inner }));
    expect((serialized as { truncated?: boolean }).truncated).toBe(true);
    expect(utf8(serialized)).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
  });

  it('stops at an error that holds itself, directly or through the one it holds', () => {
    const looped = new Error('zz-looped') as Error & { self?: unknown };
    looped.self = looped;
    expect(serializeError(looped)).toMatchObject({ message: 'zz-looped', self: '[Circular]' });
    const outer = new Error('zz-outer') as Error & { inner?: unknown };
    const inner = new Error('zz-inner') as Error & { outer?: unknown };
    outer.inner = inner;
    inner.outer = outer;
    expect(serializeError(outer)).toMatchObject({ message: 'zz-outer', inner: { message: 'zz-inner', outer: '[Circular]' } });
  });
});

describe('classifyError and serializeError on a hostile error', () => {
  it('a message or name getter that throws does not replace the failure', () => {
    const source = new Error('zz-original');
    Object.defineProperty(source, 'message', { get() { throw new Error('zz-message getter failed'); } });
    Object.defineProperty(source, 'name', { get() { throw new Error('zz-name getter failed'); } });
    let info: ErrorInfo | undefined;
    expect(() => { info = classifyError(source); }).not.toThrow();
    expect(info!.type).toBe('unknown');
    expect(info!.message).toBe('[unreadable: Error: zz-message getter failed]');
    expect(info!.rawError).toMatchObject({ name: '[unreadable: Error: zz-name getter failed]' });
    expect(() => new MembraneError(info!)).not.toThrow();
  });

  it('a Proxy whose prototype cannot be asked for is classified, not thrown', () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('zz-prototype trap failed'); } });
    let info: ErrorInfo | undefined;
    expect(() => { info = classifyError(hostile); }).not.toThrow();
    expect(info!.type).toBe('unknown');
    expect(info!.rawError).toEqual({ truncated: true, unserializable: '[unreadable: Error: zz-prototype trap failed]' });
  });

  it('a socket code getter that throws leaves the message to classify the error', () => {
    const source = new Error('zz-network failure');
    Object.defineProperty(source, 'code', { get() { throw new Error('zz-code getter failed'); } });
    expect(classifyError(source)).toMatchObject({ type: 'network', retryable: true, message: 'zz-network failure' });
  });

  it('a message that is not a string is classified as its text', () => {
    const source = new Error();
    Object.defineProperty(source, 'message', { value: 504 });
    expect(classifyError(source)).toMatchObject({ type: 'server', retryable: true, message: '504' });
  });
});

describe('the constructor takes what a JavaScript caller passes', () => {
  const make = (message: unknown, providerErrorCode?: unknown) => new MembraneError({
    type: 'unknown',
    retryable: false,
    message: message as string,
    providerErrorCode: providerErrorCode as string | undefined,
    rawError: undefined,
  });

  it('turns a message that is not a string into its text, and undefined into an empty one', () => {
    expect(make(undefined).message).toBe('');
    expect(make(42).message).toBe('42');
    expect(make({ toString: () => 'zz-described' }).message).toBe('zz-described');
    expect(make(`zz-${echo(100_000)}`).message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  });

  it('keeps a provider code that is not a string as its string form, and null as none', () => {
    expect(make('zz-text', 429).providerErrorCode).toBe('429');
    expect(make('zz-text', null).providerErrorCode).toBeUndefined();
  });
});

describe('the overload fallback reads none of the omission marker', () => {
  it('an omitted count of exactly 529 is no overload; a token in the kept head still is (control)', () => {
    const lengths = Array.from({ length: 1_000 }, (_, i) => MAX_ERROR_MESSAGE_CHARS + 1 + i);
    const length = lengths.find((n) => boundErrorText('x'.repeat(n)).includes(' …[529 of '));
    expect(length).toBeDefined();
    const statusLess = (message: string) =>
      new MembraneError({ type: 'server', retryable: true, message, rawError: undefined }).toErrorInfo();
    const plain = statusLess('x'.repeat(length!));
    expect(plain.message).toContain(' …[529 of ');
    expect(isOverloadedError(plain)).toBe(false);
    expect(isOverloadedError(statusLess(`overloaded_error ${'x'.repeat(length! - 17)}`))).toBe(true);
  });
});
