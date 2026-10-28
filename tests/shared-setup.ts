import { afterAll, vi } from 'vitest';
import { changedState, processState } from './isolation.js';

const before = processState(vi.isFakeTimers());

afterAll((suite) => {
  const changed = changedState(before, processState(vi.isFakeTimers()));
  if (changed.length > 0) {
    throw new Error(
      `${suite.file?.name ?? 'This file'} leaves process-wide state changed for the next file in its worker: ` +
        `${changed.join(', ')}. Restore it before the file ends, or write it so tests/isolation.ts isolates the file.`,
    );
  }
});
