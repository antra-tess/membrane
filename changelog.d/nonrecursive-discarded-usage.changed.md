- **Types:** `DiscardedAttemptsUsage` no longer extends `DetailedUsage`, so
  the discarded-spend record no longer claims to carry discarded spend of its
  own, arbitrarily nested — a shape nothing ever produced. It extends the new
  exported `CallUsage` instead (the token and cost fields shared by both), and
  every field it actually reports is unchanged.
