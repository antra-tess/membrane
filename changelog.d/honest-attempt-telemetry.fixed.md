- Streaming responses now report the provider calls a turn actually cost.
  Every streaming path passed a literal `attempts: 1`, so a stitched turn —
  tool rounds, automatic resumptions, refusal re-issues — was
  indistinguishable in durable logs from a single-shot one. `details.timing`
  also gains `rounds`, the number of continuation rounds, which is lower than
  `attempts` whenever a round was re-issued.
