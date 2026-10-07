/**
 * Request fidelity: what a request build carried of the consumer's messages.
 *
 * A consumer that needs to know whether a message it handed to membrane
 * reached the provider verbatim (agent-framework's receipt clocks, for one)
 * reads the round report on the `usage` event (`RoundReport.altered`,
 * `RoundReport.fidelity`). That report is assembled from notes the request
 * builders record here while they convert messages.
 *
 * An alteration is any non-empty consumer block not carried verbatim: a
 * placeholder substituted for an image, an image or block stripped, an
 * unsupported block left out, a tool carrier skipped, a tool_result rewritten
 * as text. Removing an empty text block carries nothing and is not an
 * alteration; neither is the faithful rendering of harness or attempt
 * blocks, or a block moved between provider messages.
 *
 * Builders record alterations by the index of the message in the array they
 * were handed. When content changes in a way no index can be attached to
 * (opt-in image shedding after role merging, a beforeRequest hook that
 * changed the request), the notes are marked unattributed; when any part of
 * the build or transport does not report alterations at all, they are marked
 * uninstrumented. Either makes the round's fidelity 'unknown', so an empty
 * alteration list is never mistaken for proof.
 */
export class FidelityNotes {
  /** Indices, in the builder's input messages, whose content was not carried verbatim. */
  readonly altered = new Set<number>();
  /** Content changed somewhere no message index can be attached to. */
  unattributed = false;
  /** Some part of the build or transport does not report alterations. */
  uninstrumented = false;

  alter(index: number): void {
    this.altered.add(index);
  }

  get established(): boolean {
    return !this.unattributed && !this.uninstrumented;
  }
}

/**
 * A structural fingerprint of a provider request, for telling whether a
 * `beforeRequest` hook changed it (by replacement or in place).
 */
export function requestFingerprint(request: unknown): string {
  try {
    return JSON.stringify(request) ?? '';
  } catch {
    return `unserializable:${Math.random()}`;
  }
}
