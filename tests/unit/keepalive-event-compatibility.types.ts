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

// Pin payloads too: both directions reject removed, changed, or newly required
// fields while retaining the exhaustive-switch check above.
type LegacyEvent =
  | { type: 'refreshed'; key: string; lane: 'stream' | 'complete'; readTokens: number; idleMs: number }
  | { type: 'ineffective'; key: string; reason: string; readTokens: number; writeTokens: number }
  | { type: 'skipped'; key: string; reason: string }
  | { type: 'error'; key: string; error: string; consecutive: number }
  | { type: 'disabled'; reason: string }
  | { type: 'expired'; key: string; idleMs: number };
export const legacyPayload: (event: KeepaliveEvent) => LegacyEvent = event => event;
export const currentPayload: (event: LegacyEvent) => KeepaliveEvent = event => event;
