# Contributing to membrane

membrane is part of the Connectome ecosystem
([agent-framework](https://github.com/anima-research/agent-framework),
[context-manager](https://github.com/anima-research/context-manager),
[chronicle](https://github.com/anima-research/chronicle),
[connectome-host](https://github.com/anima-research/connectome-host)). These
conventions describe how work actually lands here — they codify existing
practice rather than aspiration. When in doubt, recent merged PRs are the best
reference.

Everything below applies to every change however it lands — external PR or
maintainer direct push — and to human and AI authors identically. There is
no separate rulebook for either.

## How changes land

- External contributions come as PRs against `main`, from a fork or a repo
  branch. Maintainers also land small changes directly on `main`; don't be
  surprised by history that never saw a PR — in this repo that is the
  majority of it.
- Branch names: `feat/<kebab-case>`, `fix/<kebab-case>`, `docs/`, `chore/`.
  Including the issue number is welcome (`fix/17-cache-breakpoint-drift`).
- PRs are merged as **true merge commits** — no squash, no rebase-merge.
  Because nothing is squashed, keep individual commits coherent.
- To update a stale branch, rebase onto `main` or merge `main` in; both are
  accepted.
- Stacked PRs and cross-repo companion PRs are fine, but **declare them** in
  the body with merge-order guidance ("stacked on #7 — review that first";
  "safe to merge in either order because …"). membrane is the bottom of the
  stack — agent-framework, context-manager and connectome-host all sit on
  it — so a change here is frequently one half of a pair. Say which side is
  safe to land first and what happens if only one does.

## What a PR should contain

Body shape (the PR template mirrors this): **Problem / Changes / Tests**,
plus, when applicable, **Not verified**, **Out of scope**, and
**Companion PRs**. The conventions that matter:

- **Evidence over assertion.** State the test baseline numerically:
  "`npm test`: N pass / M fail, failure count identical to `main` baseline."
  A claim like "all tests pass" without the count will be re-verified anyway,
  so save the reviewer the trip.
- **Say what you did NOT verify.** This package's whole job is talking to
  provider APIs, and most of the suite necessarily mocks them — so be
  explicit about what was exercised against a live provider and what was
  not, and on which models. An honest "streaming path tested against
  Anthropic only, OpenRouter untested" is respected; a silent gap that
  review uncovers is not.
- **Tests accompany behavior changes.** Review scrutinizes test substance,
  not mere presence — a test that can't fail on the unfixed code will be
  called out.
- **Changelog entry** under `## Unreleased` for anything behavior-affecting
  (see below).

Conventional-commit-style titles (`feat(providers): …`, `fix(streaming): …`)
are the house default; plain descriptive titles are accepted.

## Review process — what to expect

- Review arrives as **ordinary PR comments**, not GitHub review approvals —
  the comment thread is the gate. Reviews are frequently AI-generated and
  explicitly labeled as such, with a severity verdict and itemized findings.
- The reviewer will typically **run your branch** (typecheck, test suite,
  sometimes a live provider call) and paste transcripts. Claims are checked,
  not trusted.
- Respond by pushing fix commits and replying per finding — "Addressed in
  `<sha>`" — rather than force-pushing a rewritten branch. A re-review then
  flips the verdict.
- Maintainers may push small review fixes **directly to your branch** to keep
  things moving. Say so in the PR body if you'd rather they didn't.
- PRs are never closed silently: a closed PR gets a one-line disposition
  comment (usually supersession by another PR).

## AI-assisted contributions

AI-written code is the norm in this ecosystem, welcome from everyone, and
held to exactly the same evidence standards as anything else. Declare it the
way we do:

- the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  footer (or equivalent for your tooling) in the PR body, and
- a `Co-Authored-By:` trailer naming the model in commits.

What earns an automated contribution a changes-requested review is not being
AI-generated — it's arriving without the suite having been run, with tests
that don't fail on unfixed code, or with claims the branch itself disproves.

## Changelog

`CHANGELOG.md` keeps a standing `## Unreleased` section with
`### Breaking` / `### Added` / `### Changed` / `### Fixed` subsections
(loosely [Keep a Changelog](https://keepachangelog.com/)).

- **The entry lands with the change** — same commit, or at least the same
  PR. This binds direct pushes to `main` just as much as PRs. On PRs, CI
  enforces it softly: touching `src/` without touching `CHANGELOG.md` fails
  the `changelog` check unless the `no-changelog` label is applied.
- **What needs an entry:** anything a caller would notice — request/response
  shape, streaming and tool-call behavior, transforms, provider adapters and
  the models they accept, cache-control and breakpoint handling, usage
  accounting, public exports, defaults. Internal refactors, test-only, and
  docs-only changes don't.
- **Breaking entries are audience-scoped.** Name the audience in the heading
  (`### Breaking (provider adapters only)`) and cover: **who needs to act**,
  **migration**, and **unchanged** (what readers might fear broke but
  didn't). This package is pinned by range from three siblings, so a
  breaking change here surfaces in their next install — say which minimum
  sibling versions cope with it.
- **Keep one `## Unreleased` heading.** Add entries under the existing one;
  don't open a second. Only the first is cut at release time, so entries
  filed under a later heading are silently never released — the release
  script refuses to run if it finds more than one.
- **Releases** (maintainers): `npm version <patch|minor|major>` does the
  whole cut — the `version` hook retitles `Unreleased` to
  `## X.Y.Z — YYYY-MM-DD` (keeping a fresh `Unreleased` above it, and
  refusing to release when there are no entries), then npm commits and tags.
  `git push --follow-tags` triggers CI, which refuses a tag with no matching
  changelog section, publishes `@animalabs/membrane` to npm, and creates the
  GitHub release with that section as its notes. The two release jobs are
  independent: some consumers run github-clone checkouts, so release notes
  must exist even when npm publish fails. Version bumps are a maintainer
  release-time action, not part of feature PRs.

## Building and testing

```bash
npm ci                # strict lockfile install (see below)
npm run build         # tsc
npm test              # vitest run
npx tsc --noEmit      # typecheck
```

Push-time CI (`ci.yml`) builds, typechecks and tests every push and PR on
ubuntu and macos, installing with `npm ci`. The lockfile is committed and
strict: `npm install` on npm >= 11 will quietly re-resolve platform packages
missing from the lock, so only `npm ci` fails loudly on a lock that is broken
or out of sync. If you change dependencies, commit the regenerated lock — and
note that a lock regenerated over an existing `node_modules` tree records
only your platform's native binaries, which is why CI installs on both.

Provider credentials come from the environment; tests that would need real
ones are mocked, so the suite runs without keys.
