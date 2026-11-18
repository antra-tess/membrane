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

// Structural assignability ignores readonly. Legacy consumers may mutate every field.
export function mutableLegacyPayload(event: KeepaliveEvent): void {
  event.type = event.type;
  if ('key' in event) event.key = event.key;
  if ('lane' in event) event.lane = event.lane;
  if ('readTokens' in event) event.readTokens = event.readTokens;
  if ('writeTokens' in event) event.writeTokens = event.writeTokens;
  if ('idleMs' in event) event.idleMs = event.idleMs;
  if ('reason' in event) event.reason = event.reason;
  if ('error' in event) event.error = event.error;
  if ('consecutive' in event) event.consecutive = event.consecutive;
}

// Exact equality also rejects `any`, which bidirectional assignability accepts.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type ExactLegacyPayload = Assert<Equal<KeepaliveEvent, LegacyEvent>>;
