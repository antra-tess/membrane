# Pending changelog fragments

One file per change, so concurrent branches never conflict the way shared
`CHANGELOG.md` edits do. At release time `npm version` folds every fragment
here into the new version section of `CHANGELOG.md` and deletes it.

**Name:** `<slug>.<breaking|added|changed|fixed>.md` — the slug just has to
be unique among pending fragments; the PR number or branch name works
(`48-context-length-guard.fixed.md`).

**Content:** one or more markdown bullets, exactly as they should appear in
`CHANGELOG.md`:

```markdown
- Prompt-cache keepalive refreshes a near-expiry Anthropic cache entry at
  cache-read price instead of repaying the write (#47). Continuation lines
  indent two spaces.
```

Breaking fragments open by naming who needs to act:
`- **Provider adapters:** …`.

See [CONTRIBUTING.md](../CONTRIBUTING.md#changelog) for what needs an entry.
