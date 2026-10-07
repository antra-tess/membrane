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
  MAX_RAW_ERROR_JSON_CHARS,
  boundErrorText,
  boundRawError,
  serializeError,
} from '../../src/types/errors.js';

/** Length of the omission marker boundErrorText inserts, at these sizes. */
const MARKER_ALLOWANCE = 64;
/** A bounded stack: the bounded message plus a modest frame list. */
const STACK_ALLOWANCE = MAX_ERROR_MESSAGE_CHARS + MARKER_ALLOWANCE + 8_000;

const echo = (n: number, word = '') => `${'zz-echo '.repeat(Math.ceil(n / 16))}${word}${'zz-echo '.repeat(Math.ceil(n / 16))}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
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

  it('never splits a surrogate pair at either cut', () => {
    for (const offset of [0, 1]) {
      const text = `${'x'.repeat(offset)}${'😀'.repeat(3_000)}`;
      const bounded = boundErrorText(text, 2_000);
      expect(loneSurrogate.test(bounded)).toBe(false);
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
      jsonChars: json.length,
      sha256: sha256(json),
      head: json.slice(0, 2_048),
    });
    expect(JSON.stringify(error.rawError).length).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_CHARS);
  });

  it('bounds the aggregate, not each string: many small fields still count', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 2_000; i++) many[`field${i}`] = 'zz-value-0123456789';
    const error = bigError(many);
    expect((error.rawError as { truncated?: boolean }).truncated).toBe(true);
    expect(JSON.stringify(error.rawError).length).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_CHARS);
  });

  it('counts nested Error properties and enumerable fields of a serialized Error', () => {
    const inner = Object.assign(new Error('zz-inner'), { body: { request: echo(200_000) } });
    const error = bigError(inner);
    expect(JSON.stringify(error.rawError).length).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_CHARS);
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
    expect(JSON.stringify(error.rawError).length).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_CHARS);
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
});
