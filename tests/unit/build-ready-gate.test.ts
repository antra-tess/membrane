/**
 * The `ready` flag must be READ at the wire boundary.
 *
 * `BuildOptions.pendingToolCallIds` is public API: a caller declares which
 * tool_use ids are still in flight, and the tool-pair normalizer answers with
 * `BuildResult.ready === false` instead of synthesizing a `[pending]` result
 * over a call that has not finished. The flag was written by two formatters
 * and read nowhere — so a consumer following Membrane's own example of
 * ignoring it built a request carrying an unmatched tool_use, which is exactly
 * the 400 family the normalizer exists to prevent, produced by using its
 * documented option.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MembraneError } from '../../src/types/errors.js';
import type { NormalizedRequest, NormalizedMessage } from '../../src/types/index.js';
import type { BuildOptions, BuildResult } from '../../src/formatters/types.js';

/** A formatter whose build reports an unfinished tool cycle. */
class ZzNotReadyFormatter extends NativeFormatter {
  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    return { ...super.buildMessages(messages, options), ready: false };
  }
}

/** Same shape, ready — proves the gate is keyed on the flag and nothing else. */
class ZzReadyFormatter extends NativeFormatter {
  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    return { ...super.buildMessages(messages, options), ready: true };
  }
}

function createRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
    config: { model: 'zz-test-model', maxTokens: 32 },
  };
}

describe('BuildResult.ready gates the send', () => {
  it('refuses a not-ready build instead of shipping an unmatched tool_use', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0 });
    const membrane = new Membrane(adapter);

    await expect(
      membrane.complete(createRequest(), { formatter: new ZzNotReadyFormatter() }),
    ).rejects.toThrow(/not ready/i);
  });

  it('never reaches the adapter', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0 });
    const membrane = new Membrane(adapter);

    await membrane
      .complete(createRequest(), { formatter: new ZzNotReadyFormatter() })
      .catch(() => undefined);

    expect(adapter.getRequestLog()).toHaveLength(0);
  });

  it('classifies the refusal as a non-retryable invalid request', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0 });
    const membrane = new Membrane(adapter, { retry: { maxRetries: 3 } });

    let caught: unknown;
    try {
      await membrane.complete(createRequest(), { formatter: new ZzNotReadyFormatter() });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MembraneError);
    expect((caught as MembraneError).type).toBe('invalid_request');
    expect((caught as MembraneError).retryable).toBe(false);
    // A deterministic build failure must not burn the transport retry budget.
    expect(adapter.getRequestLog()).toHaveLength(0);
  });

  it('ships a ready build normally', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0 });
    const membrane = new Membrane(adapter);

    const response = await membrane.complete(createRequest(), {
      formatter: new ZzReadyFormatter(),
    });

    expect(response.content.length).toBeGreaterThan(0);
    expect(adapter.getRequestLog()).toHaveLength(1);
  });
});
