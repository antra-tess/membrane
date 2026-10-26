import { describe, it, expect, afterEach, vi } from 'vitest';
import { requestByteCap, DEFAULT_MAX_REQUEST_BYTES } from '../../src/utils/image-media.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requestByteCap', () => {
  it('falls back to the default when MEMBRANE_MAX_REQUEST_BYTES is unset or empty', () => {
    vi.stubEnv('MEMBRANE_MAX_REQUEST_BYTES', undefined);
    expect(requestByteCap()).toBe(DEFAULT_MAX_REQUEST_BYTES);
    vi.stubEnv('MEMBRANE_MAX_REQUEST_BYTES', '');
    expect(requestByteCap()).toBe(DEFAULT_MAX_REQUEST_BYTES);
  });

  it('takes MEMBRANE_MAX_REQUEST_BYTES when it is set', () => {
    vi.stubEnv('MEMBRANE_MAX_REQUEST_BYTES', '262144');
    expect(requestByteCap()).toBe(262144);
  });

  it('defaults below the roughly 32 MB request size its doc says it leaves headroom under', () => {
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeLessThan(32_000_000);
  });
});
