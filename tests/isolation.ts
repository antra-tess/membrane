import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const KEY = String.raw`(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]+\])`;
const SET = String.raw`\s*(?:=(?!=)|\?\?=|\|\|=|&&=)`;
const DEFINE = String.raw`\b(?:Object\s*\.\s*(?:assign|defineProperty|defineProperties)|Reflect\s*\.\s*(?:set|defineProperty|deleteProperty))\s*\(\s*`;

const PROCESS_STATE: readonly RegExp[] = [
  /^\s*\/\/\s*vitest:\s*isolate\b/m,
  /\bvi\s*\.\s*spyOn\s*\(\s*(?:(?:globalThis|global)\s*\.\s*)?console\b/,
  new RegExp(String.raw`\bconsole${KEY}${SET}`),
  new RegExp(String.raw`\bprocess\s*\.\s*env${KEY}?${SET}`),
  /\bdelete\s+process\s*\.\s*env\b/,
  new RegExp(String.raw`${DEFINE}(?:process\s*\.\s*env|globalThis|global|console)\b`),
  /\bvi\s*\.\s*stubEnv\s*\(/,
  new RegExp(String.raw`\b(?:globalThis|global)${KEY}${SET}`),
  /\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock|resetModules)\s*\(/,
];

const UNRESTORED: readonly (readonly [RegExp, RegExp])[] = [
  [/\bvi\s*\.\s*stubGlobal\s*\(/, /\bvi\s*\.\s*unstubAllGlobals\s*\(/],
  [/\bvi\s*\.\s*useFakeTimers\s*\(/, /\bvi\s*\.\s*useRealTimers\s*\(/],
];

/** Whether a test file can read or leave process-wide state that another file in the same worker would see. */
export function readsProcessState(source: string): boolean {
  return (
    PROCESS_STATE.some((pattern) => pattern.test(source)) ||
    UNRESTORED.some(([change, restore]) => change.test(source) && !restore.test(source))
  );
}

/** The test files under `src/` and `tests/` that run each in a fresh worker, as paths relative to `root`. */
export function isolatedTestFiles(root: string): string[] {
  return testFiles(root).filter((file) => {
    let source: string;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      return true;
    }
    return readsProcessState(source);
  });
}

/** Every test file under `src/` and `tests/`, as a path relative to `root` with `/` separators, sorted. */
export function testFiles(root: string): string[] {
  const files: string[] = [];
  for (const dir of ['src', 'tests']) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
      if (entry.endsWith('.test.ts')) files.push(relative(root, join(root, dir, entry)).split(sep).join('/'));
    }
  }
  return files.sort();
}

/** What a test file can leave changed for the next file in its worker. */
export interface ProcessState {
  readonly console: Properties;
  readonly process: Properties;
  readonly env: Properties;
  readonly globals: Properties;
  readonly fakeTimers: boolean;
}

interface Properties {
  readonly owner: object;
  readonly descriptors: ReadonlyMap<string, PropertyDescriptor>;
}

/** The process-wide state as it is now; `fakeTimers` is `vi.isFakeTimers()`. */
export function processState(fakeTimers: boolean): ProcessState {
  return {
    console: ownProperties(console),
    process: ownProperties(process),
    env: ownProperties(process.env),
    globals: ownProperties(globalThis),
    fakeTimers,
  };
}

// Node 22 replaces process.chdir when the process starts its first Worker, so that workers learn of directory
// changes. That is Node's change, made once per process, not a test's.
const NODE_OWN = new Set(['process.chdir']);

/** What differs between two states, by name, such as `console.warn`, `process.env.ZZ` or `globalThis.fetch`. */
export function changedState(before: ProcessState, after: ProcessState): string[] {
  return [
    ...changed('console.', before.console, after.console),
    ...changed('process.', before.process, after.process),
    ...changed('process.env.', before.env, after.env),
    ...changed('globalThis.', before.globals, after.globals),
    ...(before.fakeTimers === after.fakeTimers ? [] : ['fake timers']),
  ].filter((name) => !NODE_OWN.has(name));
}

function ownProperties(owner: object): Properties {
  return {
    owner,
    descriptors: new Map(Object.getOwnPropertyNames(owner).map((key) => [key, Object.getOwnPropertyDescriptor(owner, key)!])),
  };
}

function changed(prefix: string, before: Properties, after: Properties): string[] {
  return [...new Set([...before.descriptors.keys(), ...after.descriptors.keys()])]
    .filter((key) => !unchanged(after.owner, before.descriptors.get(key), after.descriptors.get(key)))
    .map((key) => prefix + key);
}

// Node 22 defines many globals as accessors that replace themselves with their value on first read, so an accessor
// that has become a value is unchanged when it still reads that value.
function unchanged(owner: object, before?: PropertyDescriptor, after?: PropertyDescriptor): boolean {
  if (before === undefined || after === undefined) return before === after;
  if ('value' in after) {
    if ('value' in before) return Object.is(before.value, after.value);
    try {
      return Object.is(before.get?.call(owner), after.value);
    } catch {
      return false;
    }
  }
  return !('value' in before) && Object.is(before.get, after.get) && Object.is(before.set, after.set);
}
