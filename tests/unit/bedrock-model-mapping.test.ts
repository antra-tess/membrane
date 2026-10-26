/**
 * Claude 4-era models reject on-demand invocation of the direct
 * `anthropic.<id>-v1:0` form ("...with on-demand throughput isn't supported")
 * and require a cross-region inference profile (us./eu./apac.).
 */

import { describe, it, expect } from 'vitest';
import { BedrockAdapter } from '../../src/providers/bedrock.js';

function mapId(modelId: string, region = 'us-west-2'): string {
  const adapter = new BedrockAdapter({
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    region,
  });
  return (adapter as unknown as { toBedrockModelId(id: string): string })
    .toBedrockModelId(modelId);
}

describe('BedrockAdapter model id mapping', () => {
  it('passes through explicit Bedrock and inference-profile ids', () => {
    expect(mapId('anthropic.claude-3-opus-20240229-v1:0')).toBe('anthropic.claude-3-opus-20240229-v1:0');
    expect(mapId('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('us.anthropic.claude-opus-4-1-20250805-v1:0');
    expect(mapId('bedrock:us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0');
    // In ap-southeast-1, Sonnet 4.5 is offered only as the `global.` inference profile.
    expect(mapId('global.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(mapId('global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'ap-southeast-1')).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('maps 4-era plain ids to inference-profile form', () => {
    expect(mapId('claude-sonnet-4-20250514')).toBe('us.anthropic.claude-sonnet-4-20250514-v1:0');
    expect(mapId('claude-haiku-4-5-20251001')).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('falls back to a profile-prefixed id for unlisted plain ids', () => {
    expect(mapId('claude-opus-4-1-20250805')).toBe('us.anthropic.claude-opus-4-1-20250805-v1:0');
    expect(mapId('claude-sonnet-4-5-20250929')).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('derives the profile prefix from the adapter region', () => {
    expect(mapId('claude-haiku-4-5-20251001', 'eu-central-1')).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(mapId('claude-haiku-4-5-20251001', 'ap-northeast-1')).toBe('apac.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(mapId('claude-haiku-4-5-20251001', 'us-east-1')).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('keeps legacy 3.x direct-id mappings unchanged', () => {
    expect(mapId('claude-3-5-sonnet-20241022')).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(mapId('claude-3-haiku-20240307')).toBe('anthropic.claude-3-haiku-20240307-v1:0');
  });
});
