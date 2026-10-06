/**
 * stream() forwards its per-request deadlines to the adapter (A3 MAJOR-1).
 *
 * timeoutMs is declared and documented on StreamOptions, honoured by every
 * adapter, and forwarded by complete() and by the yielding paths — but the
 * callback streaming path dropped it, so a caller who set a timeout on the
 * one call that can wedge mid-stream got no timeout at all.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

class OptionRecordingAdapter extends MockAdapter {
  readonly seenOptions: Array<ProviderRequestOptions | undefined> = [];

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.seenOptions.push(options);
    return super.stream(request, callbacks, options);
  }

  override async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.seenOptions.push(options);
    return super.complete(request, options);
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};

const NATIVE_REQUEST: NormalizedRequest = {
  ...REQUEST,
  toolMode: 'native',
  tools: [
    {
      name: 'zz_probe',
      description: 'zz probe tool',
      inputSchema: { type: 'object', properties: { fld1: { type: 'string' } } },
    },
  ],
};

describe('stream() deadline forwarding', () => {
  it('forwards timeoutMs and idleTimeoutMs on the XML path', async () => {
    const adapter = new OptionRecordingAdapter();
    const membrane = new Membrane(adapter);
    await membrane.stream(REQUEST, { timeoutMs: 1234, idleTimeoutMs: 5678 });
    expect(adapter.seenOptions[0]?.timeoutMs).toBe(1234);
    expect(adapter.seenOptions[0]?.idleTimeoutMs).toBe(5678);
  });

  it('forwards timeoutMs and idleTimeoutMs on the native path', async () => {
    const adapter = new OptionRecordingAdapter();
    const membrane = new Membrane(adapter);
    await membrane.stream(NATIVE_REQUEST, { timeoutMs: 4321, idleTimeoutMs: 8765 });
    expect(adapter.seenOptions[0]?.timeoutMs).toBe(4321);
    expect(adapter.seenOptions[0]?.idleTimeoutMs).toBe(8765);
  });

  it('still forwards through the streaming:false fallback to complete()', async () => {
    const adapter = new OptionRecordingAdapter();
    const membrane = new Membrane(adapter);
    await membrane.stream({ ...REQUEST, streaming: false }, { timeoutMs: 999 });
    expect(adapter.seenOptions[0]?.timeoutMs).toBe(999);
  });
});
