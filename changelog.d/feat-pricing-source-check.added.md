- The built-in pricing table is checked against a source: `tests/fixtures/openrouter-models.json`
  is a snapshot of OpenRouter's public model list (base rates, cache reads and writes, the
  1-hour write, and the long-prompt overrides, for every Anthropic, OpenAI and Google model),
  refreshed by hand with `node scripts/pricing-source.mjs`, and
  `tests/unit/default-pricing-source.test.ts` compares each priced row's rates in effect on
  the snapshot's date to it, failing with both figures on a difference that isn't a listed
  known gap (an open PR, a choice the table makes, or a source error checked against the
  provider's page), on a row the source lost, and on a known gap that is gone. It also lists
  the source models the prefix rule prices by another model's row at other rates. The check
  is as current as the snapshot: a provider's change is caught at the next refresh, as a
  failing test with the two figures, rather than by someone re-reading the page.
