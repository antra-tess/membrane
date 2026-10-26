/**
 * AWS event-stream frame: totalLen(4) | headersLen(4) | preludeCRC(4) | headers | payload | msgCRC(4)
 */

const STRING_HEADER_VALUE_TYPE = 7;

export function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  const out = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let o = 0;
  out[o++] = nameBytes.length;
  out.set(nameBytes, o); o += nameBytes.length;
  out[o++] = STRING_HEADER_VALUE_TYPE;
  new DataView(out.buffer).setUint16(o, valueBytes.length, false); o += 2;
  out.set(valueBytes, o);
  return out;
}

export function chunkFrame(event: unknown): Uint8Array {
  const inner = new TextEncoder().encode(JSON.stringify(event));
  const b64 = Buffer.from(inner).toString('base64');
  const payload = new TextEncoder().encode(JSON.stringify({ bytes: b64 }));
  const headers = stringHeader(':event-type', 'chunk');
  const totalLength = 12 + headers.length + payload.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.length, false);
  frame.set(headers, 12);
  frame.set(payload, 12 + headers.length);
  return frame;
}

export function streamBody(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
}
