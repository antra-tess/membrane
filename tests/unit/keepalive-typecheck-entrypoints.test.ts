import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('typecheck commands reference the existing event compatibility fixture', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  expect(read('.github/workflows/ci.yml')).toMatch(/name: Type-check\s+run: npm run typecheck/);
  expect(read('.github/workflows/publish.yml')).toMatch(/name: Type-check\s+run: npm run typecheck/);
  expect(read('CONTRIBUTING.md')).toMatch(/npm run typecheck\s+# typecheck/);
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.scripts.typecheck).toBe('tsc --noEmit && tsc -p tsconfig.compatibility.json');
  expect(read('tests/unit/keepalive-event-compatibility.types.ts').trim()).not.toBe('');
  expect(JSON.parse(read('tsconfig.compatibility.json')).include).toContain('tests/unit/keepalive-event-compatibility.types.ts');
});
