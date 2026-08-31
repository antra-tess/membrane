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
  for (const block of blocks) {
    prefix.push(block);
    chars += stableStringify(block).length;
    if (hasCacheControl(block)) {
      markers.push({
        ordinal: markers.length,
        prefixHash: sha(stableStringify(prefix)),
        estimatedOffset: Math.ceil(chars / 4),
      });
    }
  }
  return { requestHash, markers };
}

function flattenWireBlocks(rawRequest: unknown): unknown[] {
  if (!rawRequest || typeof rawRequest !== 'object') return [rawRequest];
  const request = rawRequest as Record<string, unknown>;
  const out: unknown[] = [];
  if (request.tools !== undefined) out.push({ tools: request.tools });
  if (request.system !== undefined) {
    const system = request.system;
    if (Array.isArray(system)) out.push(...system);
    else out.push({ system });
  }
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (!message || typeof message !== 'object') { out.push(message); continue; }
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) out.push(...content);
      else out.push(message);
    }
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
