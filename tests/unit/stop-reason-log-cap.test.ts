/** This case fills the process-wide memory of logged stop reasons, so it has a file of its own, which runs alone in a fresh worker since it spies on console (vitest.config.ts). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';

class FreshReasonAdapter extends MockAdapter {
  private count = 0;

  override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const response = await super.complete(request, options);
    const reason = `zz_fresh_reason_${this.count++}`;
    return { ...response, stopReason: reason, providerStopReason: reason };
  }
}

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the unmapped stop-reason log is bounded', () => {
  it('logs the first 64 distinct reasons, says once that it stops, and then stays quiet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(new FreshReasonAdapter());
    for (let i = 0; i < 80; i++) {
      const response = await membrane.complete(zzRequest);
      expect(response.details.stop.providerReason).toBe(`zz_fresh_reason_${i}`);
    }
    const lines = warn.mock.calls.map(args => String(args[0]));
    expect(lines.filter(line => line.includes('Unmapped adapter stop reason'))).toHaveLength(64);
    expect(lines.filter(line => line.includes('distinct unmapped stop reasons logged'))).toEqual([
      '[membrane] 64 distinct unmapped stop reasons logged; further ones are not ' +
        "(details.stop.providerReason still carries the adapter's providerStopReason if that's a non-empty " +
        "string, else the stop reason if it's one)",
    ]);
    expect(lines.some(line => line.includes('"zz_fresh_reason_63"'))).toBe(true);
    expect(lines.some(line => line.includes('"zz_fresh_reason_64"'))).toBe(false);
  });
});
