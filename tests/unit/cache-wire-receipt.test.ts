import { describe, expect, it } from 'vitest';
import { computeCacheWireReceipt } from '../../src/cache-wire-receipt.js';

describe('cache wire receipt', () => {
  it('hashes the exact request and marked prefixes deterministically', () => {
    const raw = {
      tools: [{ name: 'x' }],
      system: [{ type: 'text', text: 's' }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
        ],
      }],
    };
    const first = computeCacheWireReceipt(raw);
    const second = computeCacheWireReceipt(raw);
    expect(first).toEqual(second);
    expect(first.requestHash).toHaveLength(64);
    expect(first.markers).toHaveLength(2);
    expect(first.markers[0]!.prefixHash).not.toBe(first.markers[1]!.prefixHash);
    expect(first.markers[1]!.estimatedOffset).toBeGreaterThan(first.markers[0]!.estimatedOffset);
  });

  it('changes request identity when immutable wire content changes', () => {
    const a = computeCacheWireReceipt({ system: 'a', messages: [] });
    const b = computeCacheWireReceipt({ system: 'b', messages: [] });
    expect(a.requestHash).not.toBe(b.requestHash);
  });

  it('receipts tool breakpoints instead of hiding them inside the tools array', () => {
    const receipt = computeCacheWireReceipt({
      tools: [
        { name: 'a', input_schema: { type: 'object' } },
        { name: 'b', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    });
    expect(receipt.markers).toHaveLength(1);
  });

  it('includes message role and envelope identity in marked-prefix hashes', () => {
    const block = { type: 'text', text: 'same', cache_control: { type: 'ephemeral' } };
    const user = computeCacheWireReceipt({ messages: [{ role: 'user', content: [block] }] });
    const assistant = computeCacheWireReceipt({ messages: [{ role: 'assistant', content: [block] }] });
    expect(user.markers).toHaveLength(1);
    expect(assistant.markers).toHaveLength(1);
    expect(user.markers[0]!.prefixHash).not.toBe(assistant.markers[0]!.prefixHash);
  });
});
