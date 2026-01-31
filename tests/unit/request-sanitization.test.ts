/**
 * Request Sanitization Tests
 *
 * Ensures internal membrane fields are not leaked to provider APIs.
 * This prevents 400 errors from providers rejecting unknown parameters.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedMessage, NormalizedRequest } from '../../src/types/index.js';

// ============================================================================
// Test Helpers
// ============================================================================

function textMessage(participant: string, text: string): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Request Sanitization', () => {
  let adapter: MockAdapter;
  let membrane: Membrane;

  beforeEach(() => {
    adapter = new MockAdapter();
    membrane = new Membrane(adapter);
  });

  describe('internal fields should not appear in raw request', () => {
    it('should not include normalizedMessages in complete() request', async () => {
      adapter.queueResponse('Test response');

      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const request: NormalizedRequest = {
        messages,
        system: 'You are helpful.',
        config: { model: 'test', maxTokens: 100 },
      };

      let rawRequest: any = null;
      await membrane.complete(request, {
        onRequest: (req) => { rawRequest = req; },
      });

      expect(rawRequest).not.toBeNull();
      expect(rawRequest).not.toHaveProperty('normalizedMessages');
      expect(rawRequest).not.toHaveProperty('prompt');
    });

    it('should not include normalizedMessages in stream() request', async () => {
      adapter.queueResponse('Test response');

      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const request: NormalizedRequest = {
        messages,
        system: 'You are helpful.',
        config: { model: 'test', maxTokens: 100 },
      };

      let rawRequest: any = null;
      await membrane.stream(request, {
        onRequest: (req) => { rawRequest = req; },
      });

      expect(rawRequest).not.toBeNull();
      expect(rawRequest).not.toHaveProperty('normalizedMessages');
      expect(rawRequest).not.toHaveProperty('prompt');
    });

    it('should not include internal fields even with providerParams', async () => {
      adapter.queueResponse('Test response');

      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const request: NormalizedRequest = {
        messages,
        config: { model: 'test', maxTokens: 100 },
        providerParams: {
          customParam: 'value',
          anotherParam: 123,
        },
      };

      let rawRequest: any = null;
      await membrane.complete(request, {
        onRequest: (req) => { rawRequest = req; },
      });

      expect(rawRequest).not.toBeNull();
      expect(rawRequest).not.toHaveProperty('normalizedMessages');
      expect(rawRequest).not.toHaveProperty('prompt');
      // But custom params should be passed through
      expect(rawRequest.extra).toHaveProperty('customParam', 'value');
      expect(rawRequest.extra).toHaveProperty('anotherParam', 123);
    });

    it('should not include internal fields with tools enabled', async () => {
      adapter.queueResponse('I will help you.');

      const messages: NormalizedMessage[] = [
        textMessage('User', 'Calculate something'),
        textMessage('Claude', ''),
      ];

      const request: NormalizedRequest = {
        messages,
        tools: [{
          name: 'calculate',
          description: 'Does math',
          inputSchema: {
            type: 'object',
            properties: { expr: { type: 'string' } },
          },
        }],
        config: { model: 'test', maxTokens: 100 },
      };

      let rawRequest: any = null;
      await membrane.complete(request, {
        onRequest: (req) => { rawRequest = req; },
      });

      expect(rawRequest).not.toBeNull();
      expect(rawRequest).not.toHaveProperty('normalizedMessages');
      expect(rawRequest).not.toHaveProperty('prompt');
    });

    it('should not include internal fields with thinking enabled', async () => {
      adapter.queueResponse('Let me think... The answer is 42.');

      const messages: NormalizedMessage[] = [
        textMessage('User', 'What is the meaning of life?'),
        textMessage('Claude', ''),
      ];

      const request: NormalizedRequest = {
        messages,
        config: {
          model: 'test',
          maxTokens: 100,
          thinking: { enabled: true },
        },
      };

      let rawRequest: any = null;
      await membrane.complete(request, {
        onRequest: (req) => { rawRequest = req; },
      });

      expect(rawRequest).not.toBeNull();
      expect(rawRequest).not.toHaveProperty('normalizedMessages');
      expect(rawRequest).not.toHaveProperty('prompt');
    });
  });

  describe('expected fields should be present', () => {
    it('should include standard API fields', async () => {
      adapter.queueResponse('Test response');

      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const request: NormalizedRequest = {
        messages,
        system: 'You are helpful.',
        config: { model: 'test-model', maxTokens: 500, temperature: 0.7 },
      };

      let rawRequest: any = null;
      await membrane.complete(request, {
        onRequest: (req) => { rawRequest = req; },
      });

      expect(rawRequest).not.toBeNull();
      expect(rawRequest).toHaveProperty('model', 'test-model');
      expect(rawRequest).toHaveProperty('maxTokens', 500);
      expect(rawRequest).toHaveProperty('temperature', 0.7);
      expect(rawRequest).toHaveProperty('messages');
      expect(rawRequest).toHaveProperty('system');
    });
  });
});
