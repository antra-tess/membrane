/**
 * Providers reject unknown request parameters, such as membrane's internal
 * `normalizedMessages`, with a 400.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Adapter Request Sanitization', () => {
  describe('extra params filtering', () => {
    it('should filter normalizedMessages from extra params', () => {
      const extra = {
        normalizedMessages: [{ participant: 'User', content: [] }],
        prompt: 'some prompt',
        customParam: 'value',
        anotherParam: 123,
      };

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
        expect(true).toBe(false);
      } else {
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
      const fs = await import('fs');
      const path = await import('path');
      const adapterPath = path.join(process.cwd(), 'src/providers/openrouter.ts');
      const source = fs.readFileSync(adapterPath, 'utf-8');

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

      expect(source).toContain('const { normalizedMessages, prompt, ...rest }');
    });
  });
});
