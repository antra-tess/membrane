import type { BuildOptions } from '../../src/formatters/types.js';
import type { ContentBlock, NormalizedMessage, ToolDefinition } from '../../src/types/index.js';

const schema = { type: 'object' as const, properties: { city: { type: 'string' as const } }, required: ['city'] };
const tool = (name: string): ToolDefinition => ({ name, description: `Tool ${name}.`, inputSchema: schema });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const user = (t: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ participant: 'User', content: [text(t)], ...extra });
const reply = (...content: ContentBlock[]): NormalizedMessage => ({ participant: 'Claude', content });
const call = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'get_time', input: { city: 'Paris' } });
const result = (id: string): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: 'noon' });
const results = (...ids: string[]): NormalizedMessage => ({ participant: 'User', content: ids.map(result) });
const signed = (t: string): ContentBlock => ({ type: 'thinking', thinking: t, signature: `sig-${t}` } as ContentBlock);
const unsigned = (t: string): ContentBlock => ({ type: 'thinking', thinking: t } as ContentBlock);

const simple: BuildOptions = { participantMode: 'simple', assistantParticipant: 'Claude', humanParticipant: 'User', tools: [tool('get_time')] };

/**
 * Requests that carry no system change, over the shapes NativeFormatter's building treats apart: role runs that
 * merge, tool pairs moved, repaired or left pending, thinking, empty text, cache markers placed by membrane or by
 * the caller, a context prefix, a synthesized leading user turn and named participants. Their built form at
 * membrane `74c345c2e346` is `native-build-corpus.golden.json`.
 */
export const corpus: Array<{ name: string; messages: NormalizedMessage[]; options: BuildOptions }> = [
  { name: 'alternating', messages: [user('u0'), reply(text('a1')), user('u2')], options: simple },
  { name: 'runs that merge', messages: [user('u0'), user('u1'), reply(text('a2')), reply(text('a3')), user('u4'), user('u5')], options: simple },
  { name: 'a tool pair', messages: [user('u0'), reply(text('a1'), call('t1')), results('t1'), reply(text('a3'))], options: simple },
  { name: 'parallel calls, results apart', messages: [user('u0'), reply(call('t1'), call('t2')), results('t2'), results('t1'), user('u4')], options: simple },
  { name: 'a result after a later turn', messages: [user('u0'), reply(call('t1')), user('u2'), reply(text('a3')), results('t1'), user('u5')], options: simple },
  { name: 'an orphan result', messages: [user('u0'), reply(text('a1')), results('t9'), reply(text('a3'))], options: simple },
  { name: 'a call with no result', messages: [user('u0'), reply(call('t1')), user('u2')], options: simple },
  { name: 'a pending call', messages: [user('u0'), reply(call('t1'))], options: { ...simple, pendingToolCallIds: new Set(['t1']) } },
  { name: 'thinking, signed and not', messages: [user('u0'), reply(signed('s1'), text('a1')), user('u2'), reply(unsigned('n3'), text('a3')), user('u4')], options: simple },
  { name: 'empty and whitespace text', messages: [user('u0'), reply(text(''), text('a1')), user('   '), user('u3'), reply(text('  '))], options: simple },
  {
    name: 'breakpoints placed by membrane',
    messages: [user('u0'), reply(text('a1')), user('u2', { cacheBreakpoint: true }), reply(text('a3')), user('u4', { cacheBreakpoint: true })],
    options: { ...simple, promptCaching: true, cacheTtl: '1h', systemPrompt: 'You are Claude.' },
  },
  {
    name: 'boundaries the caller owns',
    messages: [user('u0'), reply(text('a1')), user('u2'), reply(text('a3')), user('u4')],
    options: { ...simple, promptCaching: true, cacheMarkers: 'cm-owned', hasCacheMarker: (_m, index) => index === 2 || index === 4 },
  },
  { name: 'a context prefix', messages: [reply(text('a0')), user('u1'), reply(text('a2'))], options: { ...simple, contextPrefix: 'Earlier, the story so far.', promptCaching: true } },
  { name: 'a leading assistant turn', messages: [reply(text('a0')), user('u1')], options: { ...simple, prefillUserMessage: '[Start]' } },
  {
    name: 'named participants',
    messages: [
      { participant: 'Ann', content: [text('hi')] },
      { participant: 'Bo', content: [text('hello')] },
      reply(text('a2')),
      { participant: 'Ann', content: [text('bye')] },
    ],
    options: { participantMode: 'multiuser', assistantParticipant: 'Claude', tools: [tool('get_time')] },
  },
];
