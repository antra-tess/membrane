/**
 * Unit tests for MockAdapter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockAdapter, createEchoAdapter, createCannedAdapter } from '../../src/providers/mock.js';

describe('MockAdapter', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  describe('complete()', () => {
    it('returns default response', async () => {
      const response = await adapter.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content[0]).toEqual({
        type: 'text',
        text: 'This is a mock response from the test adapter.',
      });
      expect(response.stopReason).toBe('end_turn');
    });

    it('returns queued response', async () => {
      adapter.queueResponse('Custom response 1');
      adapter.queueResponse('Custom response 2');

      const response1 = await adapter.complete({
        model: 'test',
        messages: [],
      });
      const response2 = await adapter.complete({
        model: 'test',
        messages: [],
      });

      expect((response1.content[0] as any).text).toBe('Custom response 1');
      expect((response2.content[0] as any).text).toBe('Custom response 2');
    });

    it('logs requests', async () => {
      await adapter.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const log = adapter.getRequestLog();
      expect(log.length).toBe(1);
      expect(log[0]?.request.model).toBe('test-model');
    });

    it('uses response generator', async () => {
      const customAdapter = new MockAdapter({
        responseGenerator: (req) => `Model: ${req.model}`,
      });

      const response = await customAdapter.complete({
        model: 'gpt-4',
        messages: [],
      });

      expect((response.content[0] as any).text).toBe('Model: gpt-4');
    });
  });

  describe('stream()', () => {
    it('streams response in chunks', async () => {
      adapter.queueResponse('Hello world!');
      const chunks: string[] = [];

      await adapter.stream(
        { model: 'test', messages: [] },
        { onChunk: (chunk) => chunks.push(chunk) }
      );

      expect(chunks.join('')).toBe('Hello world!');
      expect(chunks.length).toBeGreaterThan(1); // Should be chunked
    });
  });

  describe('echo mode', () => {
    it('echoes back user message', async () => {
      const echoAdapter = createEchoAdapter();

      const response = await echoAdapter.complete({
        model: 'test',
        messages: [
          { role: 'user', content: 'Test message' },
        ],
      });

      expect((response.content[0] as any).text).toBe('[Echo] Test message');
    });

    it('handles content blocks', async () => {
      const echoAdapter = createEchoAdapter();

      const response = await echoAdapter.complete({
        model: 'test',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Block message' }] },
        ],
      });

      expect((response.content[0] as any).text).toBe('[Echo] Block message');
    });
  });

  describe('createCannedAdapter', () => {
    it('creates adapter with pre-queued responses', async () => {
      const canned = createCannedAdapter(['First', 'Second', 'Third']);

      const r1 = await canned.complete({ model: 'test', messages: [] });
      const r2 = await canned.complete({ model: 'test', messages: [] });
      const r3 = await canned.complete({ model: 'test', messages: [] });

      expect((r1.content[0] as any).text).toBe('First');
      expect((r2.content[0] as any).text).toBe('Second');
      expect((r3.content[0] as any).text).toBe('Third');
    });
  });

  describe('reset()', () => {
    it('clears queue and request log', async () => {
      adapter.queueResponse('Test');
      await adapter.complete({ model: 'test', messages: [] });

      expect(adapter.getRequestLog().length).toBe(1);

      adapter.reset();

      expect(adapter.getRequestLog().length).toBe(0);
    });
  });

  describe('getLastRequest()', () => {
    it('returns the most recent request', async () => {
      await adapter.complete({ model: 'model-1', messages: [] });
      await adapter.complete({ model: 'model-2', messages: [] });

      expect(adapter.getLastRequest()?.model).toBe('model-2');
    });

    it('returns undefined when no requests made', () => {
      expect(adapter.getLastRequest()).toBeUndefined();
    });
  });
});
