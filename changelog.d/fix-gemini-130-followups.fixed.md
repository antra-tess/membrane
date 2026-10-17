- `gemini`: a response whose cached count exceeds its prompt count is read as
  cache-excluded, so membrane counts its cached span beside its prompt. The
  usage check now also accepts a `totalTokenCount` that includes that span,
  the total membrane counts, besides the total of Google's formula, so such a
  response no longer logs "usageMetadata does not reconcile" on every call.
  None of the published responses cited for the cache-inclusive reading
  shows this case; the one-time warning that the response is read as
  cache-excluded still says when it is met. A total that
  matches neither sum still logs, and names both. The warning's closing
  sentence, that some billed tokens are in another usageMetadata field, now
  appears only when the total exceeds every sum it names.
