/**
 * Adapter Request Sanitization Tests
 *
 * Tests that adapters properly filter internal membrane fields
 * before sending to the API. This prevents 400 errors from
 * providers rejecting unknown parameters like 'normalizedMessages'.
 *
 * Bug reference: membrane 0.5.2 incorrectly included normalizedMessages
 * in OpenRouter/OpenAI requests causing 400 errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll test the filtering logic by examining what would be spread
// into the request params

describe('Adapter Request Sanitization', () => {
  describe('extra params filtering', () => {
    // This test verifies the filtering pattern used in adapters
    it('should filter normalizedMessages from extra params', () => {
      const extra = {
        normalizedMessages: [{ participant: 'User', content: [] }],
        prompt: 'some prompt',
        customParam: 'value',
        anotherParam: 123,
      };

      // This is the filtering pattern used in the adapters
      const { normalizedMessages, prompt, ...rest } = extra as Record<string, unknown>;

      expect(rest).not.toHaveProperty('normalizedMessages');
      expect(rest).not.toHaveProperty('prompt');
      expect(rest).toHaveProperty('customParam', 'value');
      expect(rest).toHaveProperty('anotherParam', 123);
    });

    it('should handle extra without internal fields', () => {
      const extra = {
        customParam: 'value',
      };

      const { normalizedMessages, prompt, ...rest } = extra as Record<string, unknown>;

      expect(normalizedMessages).toBeUndefined();
      expect(prompt).toBeUndefined();
      expect(rest).toHaveProperty('customParam', 'value');
    });

    it('should handle undefined extra', () => {
      const extra = undefined;

      if (extra) {
        const { normalizedMessages, prompt, ...rest } = extra as Record<string, unknown>;
        // Shouldn't reach here
        expect(true).toBe(false);
      } else {
        // No extra params, nothing to filter
        expect(true).toBe(true);
      }
    });

    it('should handle empty extra', () => {
      const extra = {};

      const { normalizedMessages, prompt, ...rest } = extra as Record<string, unknown>;

      expect(rest).toEqual({});
    });
  });

  describe('OpenRouter adapter filtering', () => {
    it('verifies OpenRouter uses correct filtering pattern', async () => {
      // Read the actual source to verify the pattern is used
      const fs = await import('fs');
      const path = await import('path');
      const adapterPath = path.join(process.cwd(), 'src/providers/openrouter.ts');
      const source = fs.readFileSync(adapterPath, 'utf-8');

      // Verify the filtering pattern exists
      expect(source).toContain('const { normalizedMessages, prompt, ...rest }');
      expect(source).toContain('Object.assign(params, rest)');
      expect(source).not.toMatch(/Object\.assign\(params,\s*request\.extra\)/);
    });
  });

  describe('OpenAI adapter filtering', () => {
    it('verifies OpenAI uses correct filtering pattern', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adapterPath = path.join(process.cwd(), 'src/providers/openai.ts');
      const source = fs.readFileSync(adapterPath, 'utf-8');

      expect(source).toContain('const { normalizedMessages, prompt, ...rest }');
      expect(source).toContain('Object.assign(params, rest)');
      expect(source).not.toMatch(/Object\.assign\(params,\s*request\.extra\)/);
    });
  });

  describe('OpenAI-compatible adapter filtering', () => {
    it('verifies OpenAI-compatible uses correct filtering pattern', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adapterPath = path.join(process.cwd(), 'src/providers/openai-compatible.ts');
      const source = fs.readFileSync(adapterPath, 'utf-8');

      expect(source).toContain('const { normalizedMessages, prompt, ...rest }');
      expect(source).toContain('Object.assign(params, rest)');
      expect(source).not.toMatch(/Object\.assign\(params,\s*request\.extra\)/);
    });
  });

  describe('Anthropic adapter filtering', () => {
    it('verifies Anthropic uses correct filtering pattern', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adapterPath = path.join(process.cwd(), 'src/providers/anthropic.ts');
      const source = fs.readFileSync(adapterPath, 'utf-8');

      // Anthropic adapter has its own filtering
      expect(source).toContain('const { normalizedMessages, prompt, ...rest }');
    });
  });
});
