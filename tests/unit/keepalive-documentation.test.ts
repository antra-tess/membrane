import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('README distinguishes HTTP rejection from replayable default semantic refusal', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  expect(readme).toContain('an HTTP rejection before `message_start`');
  expect(readme).toContain('a resolved semantic refusal after `message_start` remains recorded and can be replayed');
});

it('PR description preserves the provider-terminal stream qualification boundary', () => {
  const description = readFileSync(new URL('../../change-text.md', import.meta.url), 'utf8');
  expect(description).toContain('Stream qualification precedes final response assembly');
  expect(description).toContain('can reject the invocation without undoing qualification');
});
