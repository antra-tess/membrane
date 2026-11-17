// Existing exhaustive consumers must remain source-compatible without registering
// the new, separate suppression callback.
import type { KeepaliveEvent } from '../../src/index.js';
export function exhaustiveLegacyEvent(event: KeepaliveEvent): string {
  switch (event.type) {
    case 'refreshed':
    case 'ineffective':
    case 'skipped':
    case 'error':
    case 'disabled':
    case 'expired': return event.type;
    default: { const impossible: never = event; return impossible; }
  }
}
