import { createHash } from 'node:crypto';
import { blockCacheMarker } from './utils/cache-marker-budget.js';

export interface CacheWireMarkerReceipt {
  ordinal: number;
  prefixHash: string;
  estimatedOffset: number;
}

export interface CacheWireReceipt {
  requestHash: string;
  markers: CacheWireMarkerReceipt[];
}

/** Hash the selected cache-layout representation and every marked prefix.
 * The adapter's cacheReceiptBasis selects post-hook ProviderRequest (default)
 * or its final request observation. A unit is marked when it holds a
 * breakpoint at any depth the cache-marker budget walks, once however many
 * it holds. Token offsets are estimates. */
export function computeCacheWireReceipt(rawRequest: unknown): CacheWireReceipt {
  const requestHash = sha(stableStringify(rawRequest));
  const blocks = flattenWireBlocks(rawRequest);
  const prefix: unknown[] = [];
  const markers: CacheWireMarkerReceipt[] = [];
  let chars = 0;
  for (const unit of blocks) {
    prefix.push(unit.identity);
    chars += unit.estimatedChars;
    if (unit.marked) {
      markers.push({
        ordinal: markers.length,
        prefixHash: sha(stableStringify(prefix)),
        estimatedOffset: Math.ceil(chars / 4),
      });
    }
  }
  return { requestHash, markers };
}

interface ReceiptUnit {
  identity: unknown;
  marked: boolean;
  estimatedChars: number;
}

function flattenWireBlocks(rawRequest: unknown): ReceiptUnit[] {
  if (!rawRequest || typeof rawRequest !== 'object') {
    return [{ identity: rawRequest, marked: false, estimatedChars: stableStringify(rawRequest).length }];
  }
  const request = rawRequest as Record<string, unknown>;
  const out: ReceiptUnit[] = [];
  if (Array.isArray(request.tools)) {
    request.tools.forEach((tool, index) => out.push({
      identity: { surface: 'tool', index, tool },
      marked: isMarked(tool),
      estimatedChars: stableStringify(tool).length,
    }));
  } else if (request.tools !== undefined) {
    out.push({
      identity: { surface: 'tools', value: request.tools },
      marked: isMarked(request.tools),
      estimatedChars: stableStringify(request.tools).length,
    });
  }
  if (request.system !== undefined) {
    const system = request.system;
    if (Array.isArray(system)) {
      system.forEach((block, index) => out.push({
        identity: { surface: 'system', index, block },
        marked: isMarked(block),
        estimatedChars: stableStringify(block).length,
      }));
    } else {
      out.push({
        identity: { surface: 'system', value: system },
        marked: isMarked(system),
        estimatedChars: stableStringify(system).length,
      });
    }
  }
  if (Array.isArray(request.messages)) {
    request.messages.forEach((message, messageIndex) => {
      if (!message || typeof message !== 'object') {
        out.push({
          identity: { surface: 'message', messageIndex, value: message },
          marked: false,
          estimatedChars: stableStringify(message).length,
        });
        return;
      }
      const record = message as Record<string, unknown>;
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        content.forEach((block, blockIndex) => out.push({
          identity: {
            surface: 'message-block', messageIndex, blockIndex,
            role: record.role, block,
          },
          marked: isMarked(block),
          estimatedChars: stableStringify({ role: record.role, content: [block] }).length,
        }));
      } else {
        out.push({
          identity: { surface: 'message', messageIndex, role: record.role, content },
          marked: isMarked(message),
          estimatedChars: stableStringify(message).length,
        });
      }
    });
  }
  return out;
}

/** Whether a unit holds a breakpoint, its own or one nested in it, as the
 *  cache-marker budget finds them (blockCacheMarker). The units are top-level
 *  blocks, so a nested breakpoint's prefix is taken through the block that
 *  holds it, and a block holding several is marked once. */
function isMarked(value: unknown): boolean {
  return Boolean(blockCacheMarker(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
