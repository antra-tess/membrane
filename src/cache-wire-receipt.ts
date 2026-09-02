import { createHash } from 'node:crypto';

export interface CacheWireMarkerReceipt {
  ordinal: number;
  prefixHash: string;
  estimatedOffset: number;
}

export interface CacheWireReceipt {
  requestHash: string;
  markers: CacheWireMarkerReceipt[];
}

/** Hash the exact post-format/post-hook provider request and every marked
 * prefix. Token offsets are estimates; provider usage reconciles them later. */
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
      marked: hasCacheControl(tool),
      estimatedChars: stableStringify(tool).length,
    }));
  } else if (request.tools !== undefined) {
    out.push({
      identity: { surface: 'tools', value: request.tools },
      marked: hasCacheControl(request.tools),
      estimatedChars: stableStringify(request.tools).length,
    });
  }
  if (request.system !== undefined) {
    const system = request.system;
    if (Array.isArray(system)) {
      system.forEach((block, index) => out.push({
        identity: { surface: 'system', index, block },
        marked: hasCacheControl(block),
        estimatedChars: stableStringify(block).length,
      }));
    } else {
      out.push({
        identity: { surface: 'system', value: system },
        marked: hasCacheControl(system),
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
          marked: hasCacheControl(block),
          estimatedChars: stableStringify({ role: record.role, content: [block] }).length,
        }));
      } else {
        out.push({
          identity: { surface: 'message', messageIndex, role: record.role, content },
          marked: hasCacheControl(message),
          estimatedChars: stableStringify(message).length,
        });
      }
    });
  }
  return out;
}

function hasCacheControl(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).cache_control);
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
