/**
 * A request that carries no system change builds as it did before system changes could carry effort: each request
 * of the corpus builds to the form `native-build-corpus.golden.json` records, which membrane `74c345c2e346` built.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { NativeFormatter } from '../../src/formatters/native.js';
import { corpus } from './native-build-corpus.js';

const golden = JSON.parse(readFileSync(new URL('./native-build-corpus.golden.json', import.meta.url), 'utf8')) as Record<string, string>;

describe('NativeFormatter: a request with no system change', () => {
  for (const { name, messages, options } of corpus) {
    it(`builds as before: ${name}`, () => {
      expect(JSON.stringify(new NativeFormatter().buildMessages(messages, options))).toBe(golden[name]);
    });
  }

  it('has a recorded form for every request of the corpus', () => {
    expect(Object.keys(golden).sort()).toEqual(corpus.map((c) => c.name).sort());
  });
});
