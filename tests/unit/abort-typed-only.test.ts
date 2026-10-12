/**
 * A cancellation is a type, not a phrase.
 *
 * membrane's isAbortError treated any error whose message merely CONTAINED
 * "abort" as a user cancellation, so the streaming catch returned a
 * well-formed AbortedResponse{reason:'user'} instead of throwing. The real
 * error was destroyed — no stack, no classification, no rawRequest — and the
 * caller was told the human cancelled. The tool executor runs inside that
 * same try, so a host tool failing with "...aborted..." turned the whole turn
 * into a phantom cancellation.
 */

import { describe, expect, it } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { isAbortedResponse } from '../../src/types/response.js';
import { abortError, MembraneError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

class ThrowingCompleteAdapter extends MockAdapter {
  constructor(private makeError: () => unknown) {
    super();
  }

  override async complete(_request: ProviderRequest, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    throw this.makeError();
  }
}

class ThrowingStreamAdapter extends MockAdapter {
  constructor(private makeError: () => unknown) {
    super();
  }

  override async stream(
    _request: ProviderRequest,
    _callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    throw this.makeError();
  }
}

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

describe('stream() abort detection is typed', () => {
  it('throws a tool-policy failure whose message contains "aborted" instead of faking a cancellation', async () => {
    const membrane = new Membrane(
      new ThrowingStreamAdapter(() => new Error('zz-tool policy aborted the run')),
    );
    await expect(membrane.stream(zzRequest, { onChunk: () => {} })).rejects.toThrow(
      'zz-tool policy aborted the run',
    );
  });

  it('does not treat a provider message mentioning "abort" as a user cancellation', async () => {
    const membrane = new Membrane(
      new ThrowingStreamAdapter(() => new Error('zz-upstream will abort idle connections')),
    );
    const result = await membrane
      .stream(zzRequest, { onChunk: () => {} })
      .then(value => value, error => error);
    expect(result).toBeInstanceOf(MembraneError);
    expect((result as MembraneError).type).not.toBe('abort');
    expect((result as MembraneError).message).toContain('zz-upstream will abort idle connections');
  });

  it('still reports a real DOMException AbortError as a user abort', async () => {
    const membrane = new Membrane(
      new ThrowingStreamAdapter(() => new DOMException('The operation was aborted.', 'AbortError')),
    );
    const result = await membrane.stream(zzRequest, { onChunk: () => {} });
    expect(isAbortedResponse(result)).toBe(true);
  });

  it('still reports a typed membrane abort error as a user abort', async () => {
    const membrane = new Membrane(new ThrowingStreamAdapter(() => abortError()));
    const result = await membrane.stream(zzRequest, { onChunk: () => {} });
    expect(isAbortedResponse(result)).toBe(true);
  });

  it('still reports an Error whose name is AbortError as a user abort', async () => {
    const membrane = new Membrane(
      new ThrowingStreamAdapter(() => {
        const error = new Error('zz-signal fired');
        error.name = 'AbortError';
        return error;
      }),
    );
    const result = await membrane.stream(zzRequest, { onChunk: () => {} });
    expect(isAbortedResponse(result)).toBe(true);
  });
});

describe('complete() abort detection is typed', () => {
  // complete() shares stream()'s typed helpers; a message-reading arm on its
  // path would turn these failures into cancellations.
  for (const message of ['zz-tool policy aborted the run', 'zz-upstream will abort idle connections']) {
    it(`rejects "${message}" with its classification, not as an abort`, async () => {
      const error = await new Membrane(new ThrowingCompleteAdapter(() => new Error(message)))
        .complete(zzRequest)
        .then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).type).not.toBe('abort');
      expect((error as MembraneError).message).toContain(message);
    });
  }

  it('still rejects an Error named AbortError as an abort', async () => {
    const error = await new Membrane(new ThrowingCompleteAdapter(() => {
      const abort = new Error('zz-signal fired');
      abort.name = 'AbortError';
      return abort;
    }))
      .complete(zzRequest)
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).type).toBe('abort');
  });
});
