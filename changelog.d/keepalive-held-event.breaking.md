- **Code that switches exhaustively over `KeepaliveEvent`:** the union gains
  a member, `{ type: 'held'; model: string; until: number; reason: string }`,
  which the cache keepalive emits when a hold on a model begins or grows.
  **Who needs to act:** code with an exhaustive `switch` over
  `KeepaliveEvent`, or a `Record` keyed by its `type`, which TypeScript now
  reports as missing a case or a key. **Migration:** add a case for
  `'held'`, or a default. **Unchanged:** `onEvent`'s signature, and every
  other event's shape.
