- Thinking signatures now pair with parser-derived thinking blocks by CONTENT
  IDENTITY instead of stream position. Index-zipping crossed the two lists
  whenever their shapes differed — a signature-only (`display: 'omitted'`)
  block beside a visible one stamped the omitted block's signature onto the
  visible text and re-prepended the real carrier as a second copy, and the XML
  path's visible `<thinking>` text could adopt a native signature outright. A
  mispaired carrier round-trips into stored history and fails Anthropic's
  signature validation on the next turn.
- Continuation splits are reconstructed rather than mis-signed: when a parsed
  thinking block is the concatenation of a run of consecutive provider blocks
  (a `<thinking>` block split across a `max_tokens` boundary, where capture
  runs per round but the parser sees the whole accumulation), the spanning
  block is REPLACED in place by the provider originals, each keeping its own
  signature. A span that does not reconstruct leaves the parsed block
  unsigned and prepends the originals instead of guessing.
- Signature-only thinking blocks are never text-match candidates (prepend
  only), and leftover carriers are de-duplicated against what the content
  already holds, so a merge can no longer emit two copies of one block.
