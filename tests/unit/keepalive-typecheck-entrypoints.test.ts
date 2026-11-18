import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { watchdogMs } from '../helpers/watchdog.js';

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


it('the effective compatibility program includes the event fixture', () => {
  const root = new URL('../../', import.meta.url);
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)),
    '-p', 'tsconfig.compatibility.json', '--listFilesOnly',
  ], { cwd: root, encoding: 'utf8', timeout: watchdogMs(30_000), killSignal: 'SIGKILL' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.split(/\r?\n/).map(path => normalize(path))).toContain(
    fileURLToPath(new URL('tests/unit/keepalive-event-compatibility.types.ts', root)),
  );
}, watchdogMs(35_000));
