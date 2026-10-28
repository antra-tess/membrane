import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { isolatedTestFiles } from './tests/isolation.js';

const include = ['src/**/*.test.ts', 'tests/**/*.test.ts'];

// Give a test file a `// vitest: isolate` line when a helper it imports spies on `console` or leaves process-wide
// state changed: `tests/isolation.ts` routes each file by scanning only the file itself. CONTRIBUTING's
// test section says which files run alone and what `tests/shared-setup.ts` checks in the others.
const isolated = isolatedTestFiles(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
    projects: [
      { extends: true, test: { name: 'isolated', include: isolated, isolate: true } },
      {
        extends: true,
        test: {
          name: 'shared',
          include,
          exclude: [...configDefaults.exclude, ...isolated],
          isolate: false,
          setupFiles: ['./tests/shared-setup.ts'],
        },
      },
    ],
  },
});
