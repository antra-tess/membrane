import type { NormalizeOptions } from '../formatters/normalize-tool-pairs.js';
import type { ContentBlock } from '../types/content.js';

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
 * as text, nested tool-result media rendered as a note, whitespace-only text
 * removed by a cleanup policy. Removing an exactly empty text block ('')
 * carries nothing and is not an alteration; neither is the faithful
 * rendering of harness or attempt blocks, or a block moved between provider
 * messages.
 *
 * Builders record alterations by the index of the message in the array they
 * were handed, and register the blocks they emit (`own`), so an adapter that
 * reports altering a block (`ProviderRequestOptions.onContentAltered`) is
 * attributed to the message that block came from. When content changes in a
 * way no index can be attached to
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
  /**
   * A beforeRequest hook changed, in place, the request object it was handed.
   * That object shares structure with membrane's retained build state (an XML
   * stream's prefill messages) or with the consumer's own blocks, so the
   * change can outlive this round: loops keep later rounds unknown.
   */
  mutatedInPlace = false;

  /**
   * Request blocks the builder emitted (and nested tool-result blocks): the
   * owning message of each registration. Builders emit a distinct object per
   * occurrence (nested tool-result blocks are copied, not passed through), so
   * one owner is the norm; an object that ends up with several is ambiguous.
   */
  constructor(private readonly owners = new WeakMap<object, number[]>()) {}

  alter(index: number): void {
    this.altered.add(index);
  }

  /** Remember that an occurrence of `block`, as sent on the request, came from message `index`. */
  own(block: unknown, index: number): void {
    if (block === null || typeof block !== 'object') return;
    const occurrences = this.owners.get(block);
    if (occurrences) occurrences.push(index);
    else this.owners.set(block, [index]);
  }

  /**
   * An adapter altered `block` (or an unknown part, when absent). A block
   * this round's builder emitted for exactly one message is attributed to
   * it. Anything else (an object the builder didn't emit, or one registered
   * for several messages) can't say which message lost content, so the round
   * is unattributed rather than letting an altered message look intact.
   */
  alterBlock(block?: unknown): void {
    const occurrences = block !== null && typeof block === 'object' ? this.owners.get(block) : undefined;
    if (occurrences && new Set(occurrences).size === 1) this.alter(occurrences[0]!);
    else this.unattributed = true;
  }

  /**
   * `copy` stands on the request where `original` was (a normalizer made a
   * new object out of it), so it has the same owners: an adapter's report
   * about the copy is attributed as one about the original would be.
   */
  ownCopy(original: unknown, copy: unknown): void {
    if (original === null || typeof original !== 'object') return;
    for (const index of this.owners.get(original) ?? []) this.own(copy, index);
  }

  get established(): boolean {
    return !this.unattributed && !this.uninstrumented;
  }

  /** A copy for a round that carries an earlier build's conversions: same notes, same block owners. */
  copy(): FidelityNotes {
    const notes = new FidelityNotes(this.owners);
    for (const index of this.altered) notes.alter(index);
    notes.unattributed = this.unattributed;
    notes.uninstrumented = this.uninstrumented;
    return notes;
  }
}

/**
 * Register a built message's blocks (and the blocks nested in its tool
 * results, which builders pass through by reference) as coming from message
 * `index`, so an adapter's report about one of them is attributed.
 */
export function ownBlocks(fidelity: FidelityNotes | undefined, blocks: readonly unknown[], index: number): void {
  if (!fidelity) return;
  for (const block of blocks) {
    fidelity.own(block, index);
    const value = block as { type?: unknown; content?: unknown } | null;
    if (value?.type === 'tool_result' && Array.isArray(value.content)) {
      for (const nested of value.content) fidelity.own(nested, index);
    }
  }
}

/**
 * The tool-pair normalizer's block-identity callbacks, for a build recording
 * `fidelity` (spread into `normalizeToolPairs`' options). The normalizer
 * makes new objects out of a consumer's blocks in two places. An orphan
 * tool_result rewritten as text alters exactly the message that occurrence
 * came from. A copy made to drop `cache_control` carries the same content,
 * so it keeps its owner and a later adapter report about it is attributed.
 */
export function followNormalizedBlocks(
  fidelity: FidelityNotes | undefined,
): Pick<NormalizeOptions, 'onBlockRewritten' | 'onBlockCopied'> {
  if (!fidelity) return {};
  return {
    onBlockRewritten: (original, replacement) => {
      fidelity.alterBlock(original);
      fidelity.ownCopy(original, replacement);
    },
    onBlockCopied: (original, copy) => fidelity.ownCopy(original, copy),
  };
}

/**
 * Whether leaving these blocks out loses anything: true unless every block
 * is an exactly empty text block. Only '' carries nothing; whitespace-only
 * text is content.
 */
export function holdsContent(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) => !(block.type === 'text' && block.text === ''));
}

/** Where a message in a yielding loop's working array came from. */
export type MessageOrigin =
  /** `NormalizedRequest.messages[index]`, as the consumer submitted it. */
  | { kind: 'input'; index: number }
  /** Message `index` of injected batch `batch`. */
  | { kind: 'injected'; batch: number; index: number }
  /** Built by membrane itself (an assistant round, a tool_result envelope). */
  | { kind: 'own' };

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
