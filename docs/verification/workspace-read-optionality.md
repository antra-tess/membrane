# Workspace read: optional paging regression and vm2 verification

Verification date: 2026-10-20.

The runtime fix is already on `main` via
[PR #100](https://github.com/antra-tess/membrane/pull/100), merge
`1c33026ee6f1b7fefa5c2592b09924d2b7b2b754`. This report and the workspace-specific
regression supplement it; they do not introduce another tool conversion policy.

## Failure and diagnosis

The `workspace--read` tool in agent-framework 0.22.1 has five properties:
`path`, `offset`, `limit`, `offsetChars`, and `limitChars`. Only `path` is required.
Presence of either character parameter selects character paging; mixing either
line parameter into that call is rejected.

In Membrane 0.5.87 the function-tool request omitted `strict`. An offline fetch
intercept using the installed workspace module's actual tool definition showed
that the source schema and outbound `parameters` were identical, with only
`path` required. The adapter did not locally add the optional fields to
`required`.

However, Responses attempts strict normalization when `strict` is omitted;
explicit `strict: false` opts out and retains optional-property semantics.
See the [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).
This diagnosis is based on the documented contract, captured request shape and
the before/after experiment below, not inspection of provider internals.

## Live experiment on vm2

Environment: Connectome host `c3a62e2a0478da1c49a5da133edbe515fd7abdef`,
agent-framework 0.22.1, Membrane 0.5.87, Bun 1.4.3 on Linux x64,
`gpt-5.6-sol` through the application's subscription adapter.

The local fix explicitly sent `strict: false` for omitted/null strict values on
all three function-tool shapes, retaining explicit booleans. The workspace
handler and the model's instructions were unchanged.

The model received ordinary user messages and selected/executed tools itself.
Tests used separate sessions and synthetic files; expected file contents were
not included in the prompts. Inbound Telegram was paused during the experiment,
then restored along with the original working session.

The same user request before and after patching was:

> Прочитай файл workspace/workspace-read-check/check.txt и назови точные значения first, second и third. Ничего не изменяй.

| Case | Observed model arguments | Observed result |
|---|---|---|
| Before fix | `offset: 1, limit: 2000, offsetChars: 0, limitChars: 2000`, plus `path` | Rejected: `Use either offset/limit (lines) or offsetChars/limitChars (characters), not both.` |
| Retry before fix | Same groups, with `limitChars: 0` | Same rejection. The driver interrupted after two errors. |
| After fix and service restart, same session and identical request | `offset: 1, limit: 2000`, plus `path` | One successful read; all three independently generated control values matched the answer. |
| Fresh session: request only lines 3–4 | `offset: 3, limit: 2`, plus `path` | Exactly lines 3–4 returned; answer matched their contents. |
| Character paging in the fresh session, first page | `offsetChars: 0, limitChars: 5`, plus `path` | Content `😀АБВ`, continuation `5`. |
| Second character page | `offsetChars: 5, limitChars: 5`, plus `path` | Content `ГДЕЖЗ`, continuation `10`; second offset came from the first result. |

The three successful turns took 5.978 s, 5.644 s, and 7.922 s respectively.
These are individual observations, not a latency benchmark.
No successful call supplied both paging groups.

Six workspace tests also passed against the installed module: line ranges and
default cap, character paging/EOF, Unicode boundaries, empty files, invalid or
mixed arguments, and mount/missing-file checks. Mixed arguments still fail;
the fix does not silently discard one group.

The deployment patch was registered with Bun for Membrane 0.5.87. A separate
clean `bun install --frozen-lockfile --ignore-scripts` reproduced the patched
source and compiled-file hashes. No dependency versions changed.

## Regression scope and limits

The added `workspace read optional paging through Membrane` tests exercise
both API-key/Responses-formatter and subscription/native-formatter paths. They
use a fixture mirroring the property names, types and required list of the
agent-framework 0.22.1 workspace read schema, with abbreviated descriptions.
They assert the actual HTTP body carries that fixture's schema unchanged with
`strict: false`, then use `toStrictEqual` to check that a mocked tool call retains
only the selected arguments on its return through Membrane, including absence
of extra properties with `undefined` values. Cases cover path-only defaults,
line paging, and character paging.

The mocked responses do **not** demonstrate live model behavior; the live
observations above are the evidence for that. The tests are designed to fail
if the old omitted-strict behavior returns.

Local validation against base `37718936b98b96d6a92c3ed4fa6517b52a06afdb`
(Node 22.23.0): the baseline had 3390 passing tests; this branch has 3396
passing tests across 147 files, with no failures. Typecheck and build pass.
Temporarily making absent/null strict resolve to `undefined`, so JSON
serialization again omits the field, makes all six new cases fail at the
HTTP-body assertion. The mutation was removed before the passing full run.
The full suite needs loopback access for its existing platform-fetch fixture.

The live experiment used the local 0.5.87 backport, not this PR's entire current
upstream revision. Live API-key billing, other models/providers, and arbitrary
future model calls were not verified by that experiment. Runtime argument
validation remains necessary. The local patch should remain until a released
upstream version containing #100 is deployed and checked; opening this PR is
not itself a release or a production upgrade.
