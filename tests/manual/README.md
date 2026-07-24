# Manual tests

Scripts here hit the **real Anthropic API** and cost money, so they are not
part of `npm test` (the vitest include only picks up `*.test.ts` under
`tests/` and `src/`, and these are deliberately named without the suffix).
Run them by hand when touching streaming, tool execution, or prefill parsing:

```bash
ANTHROPIC_API_KEY=... npx tsx tests/manual/smoke.ts
ANTHROPIC_API_KEY=... npx tsx tests/manual/api-integration.ts
```

Model outputs are non-deterministic; both scripts assert structural behavior
rather than specific content.
