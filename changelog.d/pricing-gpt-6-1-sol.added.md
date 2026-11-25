- Default pricing has a `gpt-6.1-sol` row ($2 / $10 per MTok, cached input
  $0.10, as of 2026-11-09, from https://platform.openai.com/docs/pricing), so a
  host running it through the OpenAI or Codex path gets an `estimatedCost`
  instead of `[membrane:cost] no pricing for model "gpt-6.1-sol"` on every call
  (#249).
