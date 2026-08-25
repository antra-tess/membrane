/**
 * Behavioral coverage for the rolling/marker engine in src/context/.
 *
 * Every test here fails on the pre-fix module: the roll decision counted
 * calls instead of the conversation, truncation cut inside tool cycles and
 * could empty the window, cache markers were written to a field no request
 * builder reads, the character hard limit dropped nothing, missing
 * metadata.sourceId silently reset state every call, and the
 * "is this a user turn?" heuristic ignored the configured assistant name.
 */

import { describe, it, expect } from 'vitest';
import {
  processContext,
  shouldRoll,
  truncateMessages,
  placeCacheMarkers,
  applyCacheMarkers,
  calculateCharacters,
  createInitialState,
  defaultTokenEstimator,
  MembraneContextIdentityError,
} from '../../src/context/index.js';
import type { ContextConfig, ContextState, MessageWithTokens } from '../../src/context/index.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { NormalizedMessage } from '../../src/types/index.js';

function zzMessage(
  participant: string,
  sourceId: string,
  text: string
): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
    metadata: { sourceId },
  };
}

function zzAlternating(count: number, charsPerMessage: number): NormalizedMessage[] {
  return Array.from({ length: count }, (_, i) =>
    zzMessage(
      i % 2 === 0 ? 'zz-user' : 'zz-agent',
      `ite${i}`,
      `zz-${'x'.repeat(Math.max(0, charsPerMessage - 3))}`
    )
  );
}

/** Four tool cycles: [user text, agent tool_use, user tool_result] x N. */
function zzToolCycles(cycles: number): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (let c = 1; c <= cycles; c++) {
    messages.push(zzMessage('zz-user', `ite${c}a`, `zz-ask-${c}`));
    messages.push({
      participant: 'zz-agent',
      content: [{ type: 'tool_use', id: `zztool${c}`, name: 'zz-tool', input: { zzarg: c } }],
      metadata: { sourceId: `ite${c}b` },
    });
    messages.push({
      participant: 'zz-user',
      content: [{ type: 'tool_result', toolUseId: `zztool${c}`, content: `zz-result-${c}` }],
      metadata: { sourceId: `ite${c}c` },
    });
  }
  return messages;
}

function withTokens(messages: NormalizedMessage[]): MessageWithTokens[] {
  return messages.map((message) => ({
    message,
    tokens: defaultTokenEstimator(message),
    id: message.metadata?.sourceId as string,
  }));
}

function orphanToolResultIds(messages: NormalizedMessage[]): string[] {
  const seenToolUseIds = new Set<string>();
  const orphans: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') seenToolUseIds.add(block.id);
      if (block.type === 'tool_result' && !seenToolUseIds.has(block.toolUseId)) {
        orphans.push(block.toolUseId);
      }
    }
  }
  return orphans;
}

function baseConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    rolling: { threshold: 50, buffer: 20, unit: 'messages' },
    ...overrides,
  };
}

function mockMembrane(): Membrane {
  const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0 });
  return new Membrane(adapter);
}

const zzGenerationConfig = { model: 'test-model', maxTokens: 32 };

function countCacheControlBlocks(messages: Array<{ content: unknown }>): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.cache_control) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// N1 — participant is not guaranteed at runtime
// ---------------------------------------------------------------------------

describe('N1: role-shaped messages without a participant', () => {
  it('processContext does not TypeError when participant is missing', async () => {
    const messages = zzAlternating(30, 300).map((m) => {
      const { participant: _dropped, ...rest } = m;
      return rest as unknown as NormalizedMessage;
    });

    const output = await processContext(
      mockMembrane(),
      { messages, config: zzGenerationConfig, context: baseConfig() },
      null
    );

    expect(output.info.messagesKept).toBe(30);
  });

  it('placeCacheMarkers treats a missing participant as a user turn', () => {
    const messages = zzAlternating(60, 200).map((m) => {
      const { participant: _dropped, ...rest } = m;
      return rest as unknown as NormalizedMessage;
    });

    const markers = placeCacheMarkers(
      messages,
      withTokens(messages),
      createInitialState(),
      false,
      baseConfig()
    );

    expect(markers.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F6 — stable identity is a requirement, not a nicety
// ---------------------------------------------------------------------------

describe('F6: processContext refuses messages without stable ids', () => {
  it('throws a typed error naming metadata.sourceId', async () => {
    const messages = zzAlternating(4, 40).map((m) => ({ ...m, metadata: undefined }));

    await expect(
      processContext(
        mockMembrane(),
        { messages, config: zzGenerationConfig, context: baseConfig() },
        null
      )
    ).rejects.toThrowError(MembraneContextIdentityError);
  });

  it('names the offending message indices', async () => {
    const messages = zzAlternating(4, 40);
    messages[2] = { ...messages[2]!, metadata: {} };

    const error = await processContext(
      mockMembrane(),
      { messages, config: zzGenerationConfig, context: baseConfig() },
      null
    ).then(
      () => null,
      (e: unknown) => e as MembraneContextIdentityError
    );

    expect(error).toBeInstanceOf(MembraneContextIdentityError);
    expect(error!.messageIndices).toEqual([2]);
    expect(error!.message).toContain('sourceId');
  });

  it('accepts messages that all carry sourceId', async () => {
    const messages = zzAlternating(4, 40);
    const output = await processContext(
      mockMembrane(),
      { messages, config: zzGenerationConfig, context: baseConfig() },
      null
    );
    expect(output.state.windowMessageIds).toEqual(['ite0', 'ite1', 'ite2', 'ite3']);
  });
});

// ---------------------------------------------------------------------------
// F2 — the kept window is never empty
// ---------------------------------------------------------------------------

describe('F2: truncation floors the kept window at one message', () => {
  it('keeps the last message when it alone exceeds the token target', () => {
    const messages = withTokens([
      zzMessage('zz-user', 'ite0', 'zz-small-one'),
      zzMessage('zz-agent', 'ite1', 'zz-small-two'),
      zzMessage('zz-user', 'ite2', `zz-${'x'.repeat(200000)}`),
    ]);

    const result = truncateMessages(messages, 1000, undefined, baseConfig());

    expect(result.kept.length).toBe(1);
    expect(result.dropped).toBe(2);
    expect(result.kept[0]!.id).toBe('ite2');
  });

  it('reports residual overflow through ContextInfo instead of emptying messages', async () => {
    const messages = [zzMessage('zz-user', 'ite0', `zz-${'x'.repeat(599997)}`)];

    const output = await processContext(
      mockMembrane(),
      { messages, config: zzGenerationConfig, context: baseConfig() },
      null
    );

    expect(output.info.messagesKept).toBe(1);
    expect(output.info.hardLimitHit).toBe(true);
    expect(output.info.residualOverflow).toEqual({
      unit: 'characters',
      limit: 500000,
      actual: 600000,
    });
  });
});

// ---------------------------------------------------------------------------
// F1 — truncation never opens the window on an orphan tool_result
// ---------------------------------------------------------------------------

describe('F1: truncation snaps forward to a clean tool-cycle boundary', () => {
  it('does not leave an orphan tool_result at the head (message target)', () => {
    const messages = zzToolCycles(4);
    expect(messages.length).toBe(12);

    const result = truncateMessages(withTokens(messages), undefined, 7, baseConfig());
    const kept = result.kept.map((m) => m.message);

    expect(orphanToolResultIds(kept)).toEqual([]);
    expect(kept.length).toBeLessThan(12);
  });

  it('does not leave an orphan tool_result at the head (token target)', () => {
    const messages = zzToolCycles(4);
    const tokens = withTokens(messages);
    const tailTokens = tokens.slice(5).reduce((sum, m) => sum + m.tokens, 0);

    const result = truncateMessages(tokens, tailTokens, undefined, baseConfig());
    const kept = result.kept.map((m) => m.message);

    expect(orphanToolResultIds(kept)).toEqual([]);
  });

  it('leaves a window that is already clean untouched', () => {
    const messages = zzToolCycles(4);
    const result = truncateMessages(withTokens(messages), undefined, 6, baseConfig());

    expect(result.dropped).toBe(6);
    expect(result.kept[0]!.id).toBe('ite3a');
  });
});

// ---------------------------------------------------------------------------
// F3 — markers reach the wire
// ---------------------------------------------------------------------------

describe('F3: cache markers land on the field request builders read', () => {
  it('applyCacheMarkers sets cacheBreakpoint and keeps metadata.cacheControl', () => {
    const messages = zzAlternating(4, 40);
    const marked = applyCacheMarkers(messages, [
      { messageId: 'ite1', messageIndex: 1, tokenEstimate: 2048 },
    ]);

    expect(marked[1]!.cacheBreakpoint).toBe(true);
    expect(marked[1]!.metadata?.cacheControl).toEqual({ type: 'ephemeral' });
    expect(marked[0]!.cacheBreakpoint).toBeUndefined();
  });

  it('produces cache_control on the wire through the default XML formatter', () => {
    const messages = zzAlternating(6, 40);
    const marked = applyCacheMarkers(messages, [
      { messageId: 'ite2', messageIndex: 2, tokenEstimate: 2048 },
    ]);

    const built = new AnthropicXmlFormatter().buildMessages(marked, {
      assistantParticipant: 'zz-agent',
      promptCaching: true,
      systemPrompt: 'zz-system-prompt',
    });

    expect(countCacheControlBlocks(built.messages)).toBeGreaterThanOrEqual(1);
  });

  it('produces cache_control on the wire through the native formatter', () => {
    const messages = zzAlternating(6, 40);
    const marked = applyCacheMarkers(messages, [
      { messageId: 'ite2', messageIndex: 2, tokenEstimate: 2048 },
    ]);

    const built = new NativeFormatter().buildMessages(marked, {
      assistantParticipant: 'zz-agent',
      promptCaching: true,
      systemPrompt: 'zz-system-prompt',
    });

    expect(countCacheControlBlocks(built.messages)).toBeGreaterThanOrEqual(1);
  });

  it('caps module-placed markers below the provider breakpoint budget', () => {
    const messages = zzAlternating(200, 200);
    const markers = placeCacheMarkers(
      messages,
      withTokens(messages),
      createInitialState(),
      true,
      baseConfig({ cache: { points: 4 } })
    );

    expect(markers.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// F4 — the roll decision reads the conversation
// ---------------------------------------------------------------------------

describe('F4: shouldRoll measures the window, not the call count', () => {
  it('rolls a 500-message window arriving on fresh state', () => {
    const decision = shouldRoll(createInitialState(), 500, 5000, 1000, baseConfig());

    expect(decision.shouldRoll).toBe(true);
    expect(decision.targetMessages).toBe(50);
  });

  it('does not roll a stable window just because counters accumulated', () => {
    const state: ContextState = {
      ...createInitialState(),
      messagesSinceRoll: 500,
      tokensSinceRoll: 20600,
    };
    const config = baseConfig({ rolling: { threshold: 20000, buffer: 20, unit: 'tokens' } });

    const decision = shouldRoll(state, 40, 4120, 16000, config);

    expect(decision.shouldRoll).toBe(false);
    expect(decision.enteredGrace).toBe(false);
  });

  it('rolls on measured tokens once the window itself crosses the threshold', () => {
    const config = baseConfig({ rolling: { threshold: 20000, buffer: 20, unit: 'tokens' } });

    const decision = shouldRoll(createInitialState(), 40, 20001, 16000, config);

    expect(decision.shouldRoll).toBe(true);
    expect(decision.targetTokens).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// F5 — the character hard limit truncates for real
// ---------------------------------------------------------------------------

describe('F5: maxCharacters is enforced by truncation', () => {
  it('drops from the front until the window is under the character limit', async () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      zzMessage(i % 2 === 0 ? 'zz-user' : 'zz-agent', `ite${i}`, `zz-${'x'.repeat(19997)}`)
    );

    const output = await processContext(
      mockMembrane(),
      { messages, config: zzGenerationConfig, context: baseConfig() },
      null
    );

    expect(output.info.hardLimitHit).toBe(true);
    expect(output.info.messagesDropped).toBeGreaterThan(0);
    expect(output.info.messagesKept * 20000).toBeLessThanOrEqual(500000);
    expect(output.info.residualOverflow).toBeUndefined();
  });

  it('truncateMessages honours an explicit character target', () => {
    const messages = withTokens(
      Array.from({ length: 10 }, (_, i) =>
        zzMessage('zz-user', `ite${i}`, `zz-${'x'.repeat(997)}`)
      )
    );

    const result = truncateMessages(messages, undefined, undefined, baseConfig(), 3000);

    expect(calculateCharacters(result.kept.map((m) => m.message))).toBeLessThanOrEqual(3000);
    expect(result.kept.length).toBeGreaterThan(0);
  });

  it('does not reset the roll counters when a roll dropped nothing', async () => {
    const membrane = mockMembrane();
    const messages = [zzMessage('zz-user', 'ite0', `zz-${'x'.repeat(599997)}`)];
    const input = { messages, config: zzGenerationConfig, context: baseConfig() };

    const first = await processContext(membrane, input, null);
    const second = await processContext(membrane, input, first.state);

    expect(first.state.messagesSinceRoll).toBe(1);
    expect(second.state.messagesSinceRoll).toBe(2);
    expect(second.info.didRoll).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F9 — the assistant is whoever the deployment says it is
// ---------------------------------------------------------------------------

describe('F9: preferUserMessages consults the configured assistant', () => {
  it('walks back off an assistant turn named by config', () => {
    const messages = zzAlternating(60, 200);

    const markers = placeCacheMarkers(
      messages,
      withTokens(messages),
      createInitialState(),
      true,
      baseConfig({ assistantParticipant: 'zz-agent' })
    );

    expect(markers.length).toBe(1);
    const marked = messages[markers[0]!.messageIndex]!;
    expect(marked.participant).toBe('zz-user');
  });

  it('still honours the legacy assistant names when none is configured', () => {
    const messages = Array.from({ length: 60 }, (_, i) =>
      zzMessage(i % 2 === 0 ? 'zz-user' : 'Claude', `ite${i}`, `zz-${'x'.repeat(197)}`)
    );

    const markers = placeCacheMarkers(
      messages,
      withTokens(messages),
      createInitialState(),
      true,
      baseConfig()
    );

    expect(markers.length).toBe(1);
    expect(messages[markers[0]!.messageIndex]!.participant).toBe('zz-user');
  });
});
