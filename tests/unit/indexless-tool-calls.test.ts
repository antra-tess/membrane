/**
 * OpenAI's API spec requires `index` on every `tool_calls` entry of a streamed
 * delta; some OpenAI-compatible servers are reported to leave it out
 * (antra-tess/membrane#159).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

// A warning test that fails before its mockRestore() would leave console.warn spied for the tests after it.
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const wire: ProviderRequest = { model: 'zz-review-model', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 };

function sse(deltas: unknown[][]): Response {
  const frames = [...deltas.map(tool_calls => ({ choices: [{ delta: { tool_calls } }] })), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
  const text = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

const piece = (id: string | undefined, name: string | undefined, args: string) =>
  ({ ...(id ? { id, type: 'function' } : {}), function: { ...(name ? { name } : {}), arguments: args } });

const adapters: Array<[string, () => ProviderAdapter]> = [
  ['openai', () => new OpenAIAdapter({ apiKey: 'zz-key' })],
  ['openai-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' })],
  ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' })],
];

for (const [name, make] of adapters) {
  describe(`${name}: tool_calls entries with no index`, () => {
    const calls = async (deltas: unknown[][]) => {
      vi.stubGlobal('fetch', vi.fn(async () => sse(deltas)));
      const response = await make().stream(wire, { onChunk() {} }) as any;
      return response.content
        .filter((block: { type: string }) => block.type === 'tool_use')
        .map((block: { id: string; name: string; input: unknown }) => ({ id: block.id, name: block.name, input: block.input }));
    };
    const a = { id: 'call_a', name: 'zz_a', input: { x: 1 } };
    const b = { id: 'call_b', name: 'zz_b', input: { y: 2 } };
    const newIds = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('new ids'));

    it('calls with different ids and names stay separate calls, in one delta or across deltas', async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":1}'), piece('call_b', 'zz_b', '{"y":2}')],
        [piece('call_c', 'zz_c', '{"z":3}')],
      ])).toEqual([a, b, { id: 'call_c', name: 'zz_c', input: { z: 3 } }]);
    });

    it('two calls of the same tool, each with its own id, stay separate calls', async () => {
      expect(await calls([[piece('call_a', 'zz_read', '{"x":1}')], [piece('call_b', 'zz_read', '{"y":2}')]])).toEqual([
        { id: 'call_a', name: 'zz_read', input: { x: 1 } },
        { id: 'call_b', name: 'zz_read', input: { y: 2 } },
      ]);
    });

    it('calls with no ids but different names stay separate calls, each under an id of its own', async () => {
      expect(await calls([[piece(undefined, 'zz_a', '{"x":1}')], [piece(undefined, 'zz_b', '{"y":2}')]])).toEqual([
        { id: 'call_1', name: 'zz_a', input: { x: 1 } },
        { id: 'call_2', name: 'zz_b', input: { y: 2 } },
      ]);
    });

    it('a call with no id comes back under one of its own, and the warning names it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await calls([[piece(undefined, 'zz_a', '{"x":1}')]])).toEqual([{ id: 'call_1', name: 'zz_a', input: { x: 1 } }]);
      expect(newIds(warn).join('\n')).toContain('call_1');
      warn.mockRestore();
    });

    it('calls that each have an id of their own keep them, and no new id is warned of', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await calls([[piece('call_a', 'zz_a', '{"x":1}')], [piece('call_b', 'zz_b', '{"y":2}')]])).toEqual([a, b]);
      expect(newIds(warn)).toEqual([]);
      warn.mockRestore();
    });

    it('three calls under one id come back as x, x_2 and x_3, and the warning names the new ones', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await calls([[piece('x', 'zz_a', '{"a":1}')], [piece('x', 'zz_b', '{"b":2}')], [piece('x', 'zz_c', '{"c":3}')]])).map((c: { id: string }) => c.id)).toEqual(['x', 'x_2', 'x_3']);
      expect(newIds(warn).join('\n')).toContain('x_2');
      expect(newIds(warn).join('\n')).toContain('x_3');
      warn.mockRestore();
    });

    it("a call with no id skips a call_1 the server sent", async () => {
      expect((await calls([[piece('call_1', 'zz_a', '{"x":1}')], [piece(undefined, 'zz_b', '{"y":2}')]])).map((c: { id: string }) => c.id)).toEqual(['call_1', 'call_2']);
    });

    it('a new id skips one that a later call has', async () => {
      expect((await calls([[piece('x', 'zz_a', '{"a":1}')], [piece('x', 'zz_b', '{"b":2}')], [piece('x_2', 'zz_c', '{"c":3}')]])).map((c: { id: string }) => c.id)).toEqual(['x', 'x_3', 'x_2']);
    });

    it('an index of null counts as none, so two calls of one tool stay two', async () => {
      const nullIndex = (id: string, args: string) => ({ index: null, ...piece(id, 'zz_read', args) });
      expect(await calls([[nullIndex('call_a', '{"x":1}')], [nullIndex('call_b', '{"y":2}')]])).toEqual([
        { id: 'call_a', name: 'zz_read', input: { x: 1 } },
        { id: 'call_b', name: 'zz_read', input: { y: 2 } },
      ]);
    });

    it('a piece with only arguments continues the call before it', async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":')], [piece(undefined, undefined, '1}')],
        [piece('call_b', 'zz_b', '{"y":')], [piece(undefined, undefined, '2}')],
      ])).toEqual([a, b]);
    });

    it('a call whose every piece repeats its id stays one call, as on main', async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [piece('call_a', undefined, '1}')]])).toEqual([a]);
    });

    it("a piece that repeats a call's id joins that call wherever it is, and a piece with only arguments then continues it", async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":1}')], [piece('call_b', 'zz_b', '{"y":')], [piece('call_c', 'zz_c', '{"z":3}')],
        [piece('call_b', undefined, '')], [piece(undefined, undefined, '2}')],
      ])).toEqual([a, b, { id: 'call_c', name: 'zz_c', input: { z: 3 } }]);
    });

    it("an id that arrives after the call's name joins that call, as on main", async () => {
      expect(await calls([[piece(undefined, 'zz_a', '')], [piece('call_a', undefined, '{"x":1}')]])).toEqual([a]);
    });

    it('calls whose names come before their ids stay apart, each with its own name', async () => {
      expect(await calls([
        [piece(undefined, 'zz_a', '')], [piece('call_a', undefined, '{"x":1}')],
        [piece(undefined, 'zz_b', '')], [piece('call_b', undefined, '{"y":2}')],
      ])).toEqual([a, b]);
    });

    it('a later piece that carries a new id and no name stays with its call, which keeps the id it started under', async () => {
      expect(await calls([[piece('call_a1', 'zz_a', '{"x":')], [piece('call_a2', undefined, '1}')]])).toEqual([
        { id: 'call_a1', name: 'zz_a', input: { x: 1 } },
      ]);
    });

    it("a piece that repeats a call's id but names another tool starts a call of its own, under an id of its own", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await calls([[piece('call_0', 'zz_first', '')], [piece('call_0', 'zz_second', '{"y":2}')]])).toEqual([
        { id: 'call_0', name: 'zz_first', input: {} },
        { id: 'call_0_2', name: 'zz_second', input: { y: 2 } },
      ]);
      expect(newIds(warn)).toEqual(['[membrane] The server repeated or left out a streamed tool call\'s id; new ids: "call_0" as call_0_2']);
      warn.mockRestore();
    });

    it('a new id skips one another call already has', async () => {
      expect((await calls([[piece('call_0', 'zz_a', '{"x":1}')], [piece('call_0_2', 'zz_c', '{"z":3}')], [piece('call_0', 'zz_b', '{"y":2}')]])).map((c: { id: string }) => c.id)).toEqual(['call_0', 'call_0_2', 'call_0_3']);
    });

    it("an entry with no index takes no index's slot: those with one come first, in index order", async () => {
      const at = (index: number, id: string, args: string) => ({ index, ...piece(id, `zz_${id.slice(-1)}`, args) });
      expect(await calls([[at(0, 'call_a', '{"x":1}')], [piece('call_b', 'zz_b', '{"y":2}')], [at(1, 'call_c', '{"z":3}')]])).toEqual([
        a, { id: 'call_c', name: 'zz_c', input: { z: 3 } }, b,
      ]);
    });

    it('an entry with no index after a call at a large index is placed without walking the index space', async () => {
      const large = { index: 100_000_000, ...piece('call_z', 'zz_z', '{}') };
      const started = performance.now();
      const placed = await calls([[large], [piece('call_a', 'zz_a', '{"x":1}')]]);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(placed).toEqual([{ id: 'call_z', name: 'zz_z', input: {} }, a]);
    });

    it('a call that began without an index keeps its pieces when later ones carry its id and an index', async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [{ index: 0, ...piece('call_a', undefined, '1}') }]])).toEqual([a]);
    });

    it('an entry with no index that carries nothing opens no call', async () => {
      expect(await calls([[{}], [{ index: 0, ...piece('call_a', 'zz_a', '{"x":1}') }]])).toEqual([a]);
    });

    it('a call whose id comes first and whose name follows takes the name', async () => {
      expect(await calls([[piece('call_a', undefined, '{"x":')], [piece(undefined, 'zz_a', '1}')]])).toEqual([a]);
    });

    it('a call whose name is repeated and whose id arrives later stays one call', async () => {
      expect(await calls([[piece(undefined, 'zz_a', '{"x":')], [piece('call_a', 'zz_a', '1}')]])).toEqual([a]);
    });

    it('an indexed call continued in its slot stays one call, as on main', async () => {
      expect(await calls([[{ index: 0, ...piece('call_a', 'zz_a', '{"x":') }], [{ index: 0, ...piece(undefined, undefined, '1}') }]])).toEqual([a]);
    });

    it("a later indexed piece with another id and no name keeps the call's first id", async () => {
      expect(await calls([[{ index: 0, ...piece('call_a', 'zz_a', '{"x":') }], [{ index: 0, ...piece('call_b', undefined, '1}') }]])).toEqual([a]);
    });

    it('a named piece with a new id and the same tool continues its slot\'s call', async () => {
      expect(await calls([[{ index: 0, ...piece('call_a', 'zz_a', '{"x":') }], [{ index: 0, ...piece('call_b', 'zz_a', '1}') }]])).toEqual([a]);
    });

    it('an empty entry with an index opens no call, so a call that began without one still moves into the slot', async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [{ index: 0 }], [{ index: 0, ...piece('call_a', undefined, '1}') }]])).toEqual([a]);
    });

    it("a call that began without an index moves into its slot by its id even when the slot holds another call", async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [{ index: 0, ...piece('call_x', 'zz_x', '{"z":3}') }], [{ index: 0, ...piece('call_a', undefined, '1}') }]])).toEqual([
        { id: 'call_x', name: 'zz_x', input: { z: 3 } },
        a,
      ]);
    });

    it('an indexed piece naming another tool leaves the call that began without an index under its id where it was', async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":1}')], [{ index: 0, ...piece('call_a', 'zz_b', '{"y":2}') }]])).toEqual([
        { id: 'call_a', name: 'zz_b', input: { y: 2 } },
        { id: 'call_a_2', name: 'zz_a', input: { x: 1 } },
      ]);
    });

    it("an indexed piece whose id names a call in another slot takes nothing from the calls without an index", async () => {
      expect(await calls([[{ index: 0, ...piece('call_a', 'zz_a', '{"x":1}') }], [piece('call_x', 'zz_x', '{"z":3}')], [{ index: 1, ...piece('call_a', 'zz_a', '') }]])).toEqual([
        a,
        { id: 'call_a_2', name: 'zz_a', input: {} },
        { id: 'call_x', name: 'zz_x', input: { z: 3 } },
      ]);
    });

    it('a piece in a slot that names another tool starts a call of its own there, which the slot continues', async () => {
      const at0 = (id: string | undefined, name: string | undefined, args: string) => ({ index: 0, ...piece(id, name, args) });
      expect(await calls([[at0('call_a', 'zz_first', '')], [at0('call_b', 'zz_second', '')], [at0(undefined, undefined, '{"y":')], [at0(undefined, undefined, '2}')]])).toEqual([
        { id: 'call_a', name: 'zz_first', input: {} },
        { id: 'call_b', name: 'zz_second', input: { y: 2 } },
      ]);
    });

    it("in a slot two calls share, a piece with the earlier call's id and no name continues that call", async () => {
      const at0 = (id: string | undefined, name: string | undefined, args: string) => ({ index: 0, ...piece(id, name, args) });
      expect(await calls([[at0('call_a', 'zz_a', '')], [at0('call_b', 'zz_b', '')], [at0('call_a', undefined, '{"x":1}')]])).toEqual([
        { id: 'call_a', name: 'zz_a', input: { x: 1 } },
        { id: 'call_b', name: 'zz_b', input: {} },
      ]);
    });

    it("in a slot two calls share, a piece with one call's id that names the other's tool starts a call of its own", async () => {
      const at0 = (id: string | undefined, name: string | undefined, args: string) => ({ index: 0, ...piece(id, name, args) });
      expect(await calls([[at0('call_a', 'zz_a', '')], [at0('call_b', 'zz_b', '')], [at0('call_a', 'zz_b', '{"y":2}')]])).toEqual([
        { id: 'call_a', name: 'zz_a', input: {} },
        { id: 'call_b', name: 'zz_b', input: {} },
        { id: 'call_a_2', name: 'zz_b', input: { y: 2 } },
      ]);
    });

    it("in a slot, a piece with an id two of its calls share continues the later of them", async () => {
      const at0 = (id: string | undefined, name: string | undefined, args: string) => ({ index: 0, ...piece(id, name, args) });
      expect(await calls([[at0('shared', 'zz_a', '')], [at0('shared', 'zz_b', '')], [at0('shared', undefined, '{"y":2}')]])).toEqual([
        { id: 'shared', name: 'zz_a', input: {} },
        { id: 'shared_2', name: 'zz_b', input: { y: 2 } },
      ]);
    });

    it("an indexed piece continues its slot's call with its id rather than moving in a call without an index under the same id", async () => {
      const at0 = (id: string | undefined, name: string | undefined, args: string) => ({ index: 0, ...piece(id, name, args) });
      expect(await calls([[at0('shared', 'zz_a', '')], [piece('shared', 'zz_b', '')], [at0('shared', undefined, '{"x":1}')]])).toEqual([
        { id: 'shared', name: 'zz_a', input: { x: 1 } },
        { id: 'shared_2', name: 'zz_b', input: {} },
      ]);
    });

    it("a continuation with an empty id continues its slot's last call", async () => {
      const at0 = (id: string | undefined, name: string | undefined, args: string) => ({ index: 0, ...piece(id, name, args) });
      expect(await calls([[at0(undefined, 'zz_a', '{"x":1}')], [at0('call_b', 'zz_b', '{"y":')], [{ index: 0, id: '', function: { arguments: '2}' } }]])).toEqual([
        { id: 'call_1', name: 'zz_a', input: { x: 1 } },
        b,
      ]);
    });

    it('an entry that carries only empty arguments opens no call, with or without an index', async () => {
      expect(await calls([[{ function: { arguments: '' } }], [{ index: 0, function: { arguments: '' } }], [piece('call_a', 'zz_a', '{"x":1}')]])).toEqual([a]);
    });

    it('two calls in their own slots under one id come back with the second under an id of its own', async () => {
      expect(await calls([[{ index: 0, ...piece('call_0', 'zz_a', '{"x":1}') }], [{ index: 1, ...piece('call_0', 'zz_b', '{"y":2}') }]])).toEqual([
        { id: 'call_0', name: 'zz_a', input: { x: 1 } },
        { id: 'call_0_2', name: 'zz_b', input: { y: 2 } },
      ]);
    });
  });
}
