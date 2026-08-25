- Thinking-text identity no longer erases internal whitespace, so two distinct
  signed payloads that differ only in where their spaces fall (`zz-ab c` vs
  `zz-a bc`) stay distinct and the wrong signature is no longer stamped onto
  the wrong reasoning. Normalization is now exactly the two named artifacts:
  the XML path's `<thinking>` scaffolding tags, and whitespace at the OUTER
  boundaries. A mis-stamped carrier round-trips into stored history and fails
  Anthropic's signature validation on the next turn.
- Continuation splits still reconstruct across the round boundary that loses a
  fragment's trailing whitespace: the spanning search now tries both the
  verbatim join and the join `buildContinuationRequest`'s trimEnd actually
  produces, instead of relying on blanket whitespace erasure.
