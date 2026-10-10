- `thinking.blockBinding` asks the API what to do with a signed thinking
  block the request sends back when the conversation before it has changed
  since it was minted: `{ prefixMismatchBehavior: 'drop_block' }` removes the
  failing blocks and the request proceeds, and `'error'` fails it with a 400.
  The Anthropic and Bedrock adapters send it as `thinking.block_binding`, with
  the `thinking-binding-controls-2026-08-01` beta, also to Fable and Mythos
  models, whose thinking config is otherwise left out. Unset, nothing is
  sent, and the account's default applies.
- Yielding streams report what the provider did with that thinking:
  `RoundReport.thinking` lists the blocks it dropped (`dropped`) and the
  ones that failed a binding check but were shown anyway, where the check
  isn't enforced (`mismatchAllowed`). Each entry gives the provider's reason
  and its `messages.{i}.content.{j}` path, and, where membrane can say, the
  consumer message it came from (`message`, `injected` as `[batch, index]`,
  or `round` for an earlier round of the stream) and the block's index in
  it. `ProviderResponse.inputTransformations` carries the provider's own
  report, and a streamed response's raw form now includes
  `input_transformations`.
