- The built-in pricing table is checked against a source: `tests/fixtures/openrouter-models.json`
  is a snapshot of OpenRouter's public model list (base rates, cache reads and writes, the
  1-hour write, and the long-prompt overrides, for every Anthropic, OpenAI and Google model),
  refreshed by `node scripts/pricing-source.mjs`, and `tests/unit/default-pricing-source.test.ts`
  fails on any row whose rate differs from it, with both figures, unless the difference is a
  listed known gap (an open PR, a choice the table makes, or a source error checked against the
  provider's page). It also lists the source models the prefix rule prices by another model's
  row at other rates. A provider's price change is now a failing test and a refresh, not a page
  to find and re-read.
