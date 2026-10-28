import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../../vitest.config.js';
import { changedState, isolatedTestFiles, processState, readsProcessState } from '../isolation.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('which test files run alone in a fresh worker', () => {
  it('isolates the files that read the stop reasons membrane has already logged, and those that write process.env or globalThis', () => {
    const isolated = isolatedTestFiles(root);
    for (const file of [
      'tests/unit/stop-reason-loudness.test.ts',
      'tests/unit/null-finish-reason.test.ts',
      'tests/unit/stop-reason-log-cap.test.ts',
      'tests/unit/anthropic-auth.test.ts',
      'tests/unit/gemini-cache-convention.test.ts',
    ]) {
      expect(isolated).toContain(file);
    }
    expect(isolated).not.toContain('tests/unit/caller-abort.test.ts');
  });

  it.each([
    ['the explicit opt-in', "import { warnings } from '../helpers/console-spy.js';\n// vitest: isolate\n"],
    ['the opt-in with its reason after it', "// vitest: isolate (the console-spy helper reads console)\n"],
    ["a console spy", "const warn = vi.spyOn(console, 'warn');"],
    ['a console spy spelled with spaces', "const warn = vi.spyOn (console, 'warn');"],
    ['a console spy through globalThis', "const warn = vi.spyOn(globalThis.console, 'warn');"],
    ['a console spy through the global alias', "const warn = vi.spyOn(global.console, 'warn');"],
    ['a console merge', 'Object.assign(console, { warn: () => {} });'],
    ['a console assignment', 'console.warn = () => {};'],
    ['a console assignment by key', "console['warn'] = () => {};"],
    ['a process.env write', "process.env.ANTHROPIC_API_KEY = 'zz';"],
    ['a process.env write by key', "process.env['ZZ'] ??= 'zz';"],
    ['a process.env ||= write', "process.env.ZZ ||= 'zz';"],
    ['a process.env &&= write', "process.env.ZZ &&= 'zz';"],
    ['a whole process.env replaced', "process.env = { ...process.env, ZZ: 'zz' };"],
    ['a process.env deletion', 'delete process.env.ZZ;'],
    ['a process.env merge', "Object.assign(process.env, { ZZ: 'zz' });"],
    ['a process.env property defined', "Object.defineProperty(process.env, 'ZZ', { value: 'zz' });"],
    ['a process.env write through Reflect', "Reflect.set(process.env, 'ZZ', 'zz');"],
    ['a process.env property defined through Reflect', "Reflect.defineProperty(process.env, 'ZZ', { value: 'zz' });"],
    ['a process.env deletion through Reflect', "Reflect.deleteProperty(process.env, 'ZZ');"],
    ['vi.stubEnv', "vi.stubEnv('ZZ', 'zz');"],
    ['a globalThis write', 'globalThis.fetch = stub;'],
    ['a globalThis write by key', "globalThis['fetch'] = stub;"],
    ['a write through the global alias', 'global.fetch = stub;'],
    ['a globalThis property defined', "Object.defineProperty(globalThis, 'fetch', { value: stub });"],
    ['globalThis properties defined', 'Object.defineProperties(globalThis, { fetch: { value: stub } });'],
    ['a module mock', "vi.mock('../../src/membrane.js');"],
    ['a module mock made in a test', "vi.doMock('../../src/membrane.js');"],
    ['a module unmocked', "vi.unmock('../../src/membrane.js');"],
    ['a module unmocked in a test', "vi.doUnmock('../../src/membrane.js');"],
    ['the module registry reset', 'vi.resetModules();'],
    ['a vi.stubGlobal never undone', "vi.stubGlobal('fetch', stub);"],
    ['fake timers never undone', 'vi.useFakeTimers();'],
  ])('isolates a file with %s', (_kind, source) => {
    expect(readsProcessState(source)).toBe(true);
  });

  it('shares a file that undoes what it stubs, and one that only reads', () => {
    expect(readsProcessState("vi.stubGlobal('fetch', stub);\nafterEach(() => vi.unstubAllGlobals());")).toBe(false);
    expect(readsProcessState('vi.useFakeTimers();\nafterEach(() => vi.useRealTimers());')).toBe(false);
    expect(readsProcessState("const key = process.env.ANTHROPIC_API_KEY;\nif (globalThis.fetch === undefined) throw new Error('zz');")).toBe(false);
    expect(readsProcessState("if (process.env.ZZ !== 'zz' && globalThis.fetch !== stub) throw new Error('zz');")).toBe(false);
    expect(readsProcessState('// vitest: isolated by its helper, which restores console\n')).toBe(false);
  });

  it('isolates a test file it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'membrane-isolation-'));
    try {
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'tests', 'unit', 'unreadable.test.ts'), { recursive: true });
      writeFileSync(join(dir, 'tests', 'unit', 'plain.test.ts'), "it('zz', () => {});");
      expect(isolatedTestFiles(dir)).toEqual(['tests/unit/unreadable.test.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the two projects', () => {
  it('run every test file once: an isolated file alone, any other in a shared worker that checks what it leaves', () => {
    type Project = { test: { name: string; include?: string[]; exclude?: string[]; isolate?: boolean; setupFiles?: string[] } };
    expect(config.test!.projects).toHaveLength(2);
    const [isolatedProject, sharedProject] = (config.test!.projects as Project[]).map((project) => project.test);
    const isolated = isolatedTestFiles(root);
    expect(config.test).not.toHaveProperty('include');
    expect(isolatedProject).toMatchObject({ name: 'isolated', include: isolated, isolate: true });
    expect(isolatedProject).not.toHaveProperty('exclude');
    expect(sharedProject).toMatchObject({
      name: 'shared',
      include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
      isolate: false,
      setupFiles: ['./tests/shared-setup.ts'],
    });
    expect(sharedProject!.exclude).toEqual([...configDefaults.exclude, ...isolated]);
  });
});

describe('what a shared file leaves changed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('is nothing when nothing changed, NaN included', () => {
    expect(changedState(processState(false), processState(false))).toEqual([]);
  });

  it.each([
    ['console.warn', () => vi.spyOn(console, 'warn').mockImplementation(() => {})],
    ['process.exit', () => vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)],
    ['process.env.ZZ_ISOLATION', () => vi.stubEnv('ZZ_ISOLATION', 'zz')],
    ['globalThis.fetch', () => vi.stubGlobal('fetch', () => {})],
    ['globalThis.zzIsolation', () => vi.stubGlobal('zzIsolation', 1)],
  ])('names %s when it is left changed', (name, change) => {
    const before = processState(false);
    change();
    expect(changedState(before, processState(false))).toEqual([name]);
  });

  it('counts an accessor that has put its own value in place, as Node 22\'s lazy globals do, as unchanged', () => {
    const value = {};
    Object.defineProperty(globalThis, 'zzLazy', {
      configurable: true,
      get() {
        Object.defineProperty(globalThis, 'zzLazy', { configurable: true, writable: true, value });
        return value;
      },
    });
    try {
      const before = processState(false);
      expect((globalThis as Record<string, unknown>).zzLazy).toBe(value);
      expect(changedState(before, processState(false))).toEqual([]);
      vi.stubGlobal('zzLazy', {});
      expect(changedState(before, processState(false))).toEqual(['globalThis.zzLazy']);
    } finally {
      vi.unstubAllGlobals();
      delete (globalThis as Record<string, unknown>).zzLazy;
    }
  });

  it("leaves out process.chdir, which Node 22 replaces when the process starts its first Worker", () => {
    const chdir = process.chdir;
    const before = processState(false);
    try {
      process.chdir = (directory: string) => chdir(directory);
      expect(changedState(before, processState(false))).toEqual([]);
    } finally {
      process.chdir = chdir;
    }
  });

  it('names fake timers left on', () => {
    const before = processState(vi.isFakeTimers());
    vi.useFakeTimers();
    expect(changedState(before, processState(vi.isFakeTimers()))).toContain('fake timers');
  });
});
