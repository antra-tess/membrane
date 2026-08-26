/**
 * AnthropicXmlFormatter cache budget.
 *
 * This is the prefill (Connectome-style) builder. It attaches cache_control at
 * five sites — system, contextPrefix, hasCacheMarker flushes, cacheBreakpoint
 * flushes, and the CLI-simulation system block — and until now compared the
 * total to nothing at all, so three marked messages on a prefill turn put five
 * markers on the wire and the API rejected the request outright.
 *
 * It also flattened a caller-marked system ARRAY into one text block, silently
 * discarding every per-block cache_control the caller placed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { countWireCacheMarkers, MAX_CACHE_BREAKPOINTS } from '../../src/utils/cache-marker-budget.js';
import type { NormalizedMessage, ContentBlock } from '../../src/types/index.js';

const message = (participant: string, text: string, cacheBreakpoint = false): NormalizedMessage => ({
  participant,
  content: [{ type: 'text', text }],
  ...(cacheBreakpoint ? { cacheBreakpoint } : {}),
});

const markedSystemBlock = (text: string): ContentBlock =>
  ({ type: 'text', text, cache_control: { type: 'ephemeral' } }) as unknown as ContentBlock;

function build(messages: NormalizedMessage[], options: Record<string, unknown> = {}) {
  const formatter = new AnthropicXmlFormatter();
  return formatter.buildMessages(messages, {
    participantMode: 'multiuser',
    assistantParticipant: 'Claude',
    promptCaching: true,
    ...options,
  } as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnthropicXmlFormatter: breakpoint budget', () => {
  it('clamps a system + contextPrefix + three-breakpoint build to 4 markers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = build(
      [
        message('zzOperator', 'zz one', true),
        message('Claude', 'zz reply one', true),
        message('zzOperator', 'zz two', true),
        message('Claude', ''),
      ],
      { systemPrompt: 'zz system prompt', contextPrefix: 'zz seeded prefix' }
    );

    expect(countWireCacheMarkers({ messages: result.messages, system: result.systemContent }))
      .toBe(MAX_CACHE_BREAKPOINTS);
    expect(result.cacheMarkersApplied).toBe(MAX_CACHE_BREAKPOINTS);
    expect(warn).toHaveBeenCalled();
    // Shallowest dropped first: the system block loses its marker, the
    // deepest conversation flushes keep theirs.
    expect((result.systemContent as any[])[0].cache_control).toBeUndefined();
  });

  it('clamps a system + four-breakpoint build (no contextPrefix) to 4 markers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = build(
      [
        message('zzOperator', 'zz one', true),
        message('Claude', 'zz reply one', true),
        message('zzOperator', 'zz two', true),
        message('Claude', 'zz reply two', true),
        message('Claude', ''),
      ],
      { systemPrompt: 'zz system prompt' }
    );

    expect(countWireCacheMarkers({ messages: result.messages, system: result.systemContent }))
      .toBe(MAX_CACHE_BREAKPOINTS);
    expect(result.cacheMarkersApplied).toBe(MAX_CACHE_BREAKPOINTS);
  });

  it('reports cacheMarkersApplied as the real wire count', () => {
    const result = build([message('zzOperator', 'zz one', true), message('Claude', '')], {
      systemPrompt: 'zz system prompt',
    });
    expect(result.cacheMarkersApplied).toBe(
      countWireCacheMarkers({ messages: result.messages, system: result.systemContent })
    );
  });
});

describe('AnthropicXmlFormatter: caller-marked system array', () => {
  it('preserves per-block cache_control instead of flattening it away', () => {
    const result = build([message('zzOperator', 'zz hello'), message('Claude', '')], {
      systemPrompt: [
        markedSystemBlock('zz stable preamble'),
        markedSystemBlock('zz stable middle'),
        markedSystemBlock('zz volatile tail'),
      ],
    });

    const systemBlocks = result.systemContent as any[];
    expect(systemBlocks).toHaveLength(3);
    expect(systemBlocks.map((b) => b.text)).toEqual([
      'zz stable preamble',
      'zz stable middle',
      'zz volatile tail',
    ]);
    expect(systemBlocks.filter((b) => b.cache_control)).toHaveLength(3);
    expect(result.cacheMarkersApplied).toBe(3);
  });

  it('does not add a fourth marker of its own when the caller already marked blocks', () => {
    const result = build([message('zzOperator', 'zz hello'), message('Claude', '')], {
      systemPrompt: [markedSystemBlock('zz marked'), { type: 'text', text: 'zz unmarked' } as ContentBlock],
    });
    const systemBlocks = result.systemContent as any[];
    expect(systemBlocks.filter((b) => b.cache_control)).toHaveLength(1);
    expect(systemBlocks[0].cache_control).toBeDefined();
  });

  it('marks the last block of an UNMARKED system array (one marker, not one per block)', () => {
    const result = build([message('zzOperator', 'zz hello'), message('Claude', '')], {
      systemPrompt: [
        { type: 'text', text: 'zz first' } as ContentBlock,
        { type: 'text', text: 'zz second' } as ContentBlock,
      ],
    });
    const systemBlocks = result.systemContent as any[];
    expect(systemBlocks.filter((b) => b.cache_control)).toHaveLength(1);
    expect(systemBlocks[1].cache_control).toBeDefined();
  });

  it('injects system-mode tools into the last block, keeping the earlier blocks marked', () => {
    const result = build([message('zzOperator', 'zz hello'), message('Claude', '')], {
      systemPrompt: [markedSystemBlock('zz stable preamble'), markedSystemBlock('zz tail')],
      tools: [{ name: 'zz_shell', description: 'zz run', inputSchema: { type: 'object' } }],
    });
    const formatter = new AnthropicXmlFormatter({ toolInjectionMode: 'system' });
    const injected = formatter.buildMessages([message('zzOperator', 'zz hello'), message('Claude', '')], {
      participantMode: 'multiuser',
      assistantParticipant: 'Claude',
      promptCaching: true,
      systemPrompt: [markedSystemBlock('zz stable preamble'), markedSystemBlock('zz tail')],
      tools: [{ name: 'zz_shell', description: 'zz run', inputSchema: { type: 'object' } }],
    } as any);

    const blocks = injected.systemContent as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('zz stable preamble');
    expect(blocks[1].text).toContain('available_tools');
    expect(blocks.filter((b) => b.cache_control)).toHaveLength(2);
    // Conversation-mode injection leaves the system blocks alone.
    expect((result.systemContent as any[])[1].text).toBe('zz tail');
  });
});
