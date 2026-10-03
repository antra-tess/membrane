import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeFormatter } from '../../src/formatters/native.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { ownSystemBlocks } from '../../src/utils/cache-marker-budget.js';
import type { NormalizedRequest } from '../../src/types/index.js';

describe('NativeFormatter nameFormat compatibility', () => {
  it('accepts a subclass with a readonly nameFormat data property', () => {
    const directory = mkdtempSync(join(tmpdir(), 'membrane-subclass-'));
    const fixture = join(directory, 'consumer.mts');
    try {
      writeFileSync(fixture, [
        'import { NativeFormatter } from ' + JSON.stringify(resolve('src/formatters/native.js')) + ';',
        'class CustomFormatter extends NativeFormatter {',
        '  override readonly nameFormat = "[{name}] ";',
        '}',
        'const formatter: NativeFormatter = new CustomFormatter();',
        'formatter.buildMessages([], { participantMode: "multiuser", assistantParticipant: "Assistant" });',
      ].join('\n'));
      const compilation = spawnSync(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--noImplicitOverride',
        '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        fixture,
      ], { encoding: 'utf8' });
      expect(compilation.error).toBeUndefined();
      expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps the configured template as an own data property', () => {
    const formatter = new NativeFormatter({ nameFormat: '[{name}] ' });
    expect(Object.getOwnPropertyDescriptor(formatter, 'nameFormat')?.value).toBe('[{name}] ');
  });
});

describe('literal completions names', () => {
  it('preserves replacement tokens in messages, context prefix, prefill, and stop variants', () => {
    const human = "Bob $& $` $' $$ $1";
    const assistant = "ASSISTANT $& $` $' $$ $1";
    const formatter = new CompletionsFormatter({ nameFormat: '[{name}] ', caseInsensitiveStops: true });
    const built = formatter.buildMessages([
      { participant: human, content: [{ type: 'text', text: 'hello' }] },
    ], {
      participantMode: 'multiuser', assistantParticipant: assistant, contextPrefix: 'seed',
    });
    expect(built.assistantPrefill).toBe(
      '[' + assistant + '] seed<|eot|>\n\n[' + human + '] hello<|eot|>\n\n[' + assistant + ']',
    );
    expect(built.stopSequences).toEqual([
      '\n\n[' + human + ']', '\n[' + human + ']',
      '\n\n[' + human.toLowerCase() + ']', '\n[' + human.toLowerCase() + ']',
      '<|eot|>',
    ]);
  });
});

describe('empty system normalization', () => {
  it('omits empty arrays and preserves ownership of nonempty systems', () => {
    expect(ownSystemBlocks([])).toBeUndefined();
    expect(ownSystemBlocks('rules')).toBe('rules');
    const source = [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }];
    const owned = ownSystemBlocks(source) as typeof source;
    expect(owned).toEqual(source);
    expect(owned).not.toBe(source);
    expect(owned[0]).not.toBe(source[0]);
  });

  it.each(['initial', 'native', 'continuation', 'image-continuation'])('omits empty system arrays in the %s builder', builder => {
    const membrane = new Membrane(new MockAdapter(), { formatter: new NativeFormatter() }) as any;
    const req: NormalizedRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'hello' }] }],
      config: { model: 'test-model', maxTokens: 128 }, system: [], promptCaching: false,
    };
    const prefill = { messages: [{ role: 'user', content: 'hello' }], systemContent: [], stopSequences: [] };
    const built = builder === 'initial' ? membrane.transformRequest(req).providerRequest
      : builder === 'native' ? membrane.buildNativeToolRequest(req, req.messages)
      : builder === 'continuation' ? membrane.buildContinuationRequest(req, prefill, 'answer')
      : membrane.buildContinuationRequestWithImages(req, prefill, 'answer', [], 'closing');
    expect(built.system).toBeUndefined();
    expect(JSON.stringify(built)).not.toContain('"system":[]');
  });
});
