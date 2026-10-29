import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export const runtimeSpecifiers = (source: string): string[] => [
  ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
  ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
  ...source.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g),
  ...source.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]/g),
].map((match) => match[1]!);

export function loadedBy(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    const name = relative(root, file);
    if (seen.has(name)) return;
    seen.add(name);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) { seen.add(`package ${spec}`); continue; }
      const target = join(dirname(file), spec).replace(/\.js$/, '.ts');
      if (!existsSync(target)) { seen.add(`missing ${spec}`); continue; }
      walk(target);
    }
  };
  walk(join(root, entry));
  return [...seen].sort();
}
