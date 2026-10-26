import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MembraneError } from '../../src/types/errors.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import type { NormalizedRequest } from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'claude-sonnet-4-5', maxTokens: 64 },
  toolMode: 'native',
};
const MESSAGE = 'messages.0.content.0.thinking.signature: Field required';

function exceptionFrame(exceptionType: string, payload: object): Uint8Array {
  const header = (name: string, value: string) => {
    const n = Buffer.from(name), v = Buffer.from(value);
    const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    out[0] = n.length; n.copy(out, 1);
    out[1 + n.length] = 7;
    out.writeUInt16BE(v.length, 2 + n.length);
    v.copy(out, 4 + n.length);
    return out;
  };
  const headers = Buffer.concat([header(':exception-type', exceptionType), header(':message-type', 'exception')]);
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12); body.copy(frame, 12 + headers.length);
  return frame;
}

async function streamError(): Promise<MembraneError> {
  const membrane = new Membrane(new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' }), {
    formatter: new NativeFormatter(),
  });
  const error = await membrane.stream(REQUEST).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(MembraneError);
  return error as MembraneError;
}

function exceptionStream(payload: object) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(exceptionFrame('validationException', payload)); controller.close(); },
  }), { status: 200 })));
}

describe('an error inside a Bedrock stream keeps the provider\'s error on the raw error, as `error`', () => {
  it("an exception: its message, as { message }", async () => {
    exceptionStream({ message: MESSAGE });
    const error = await streamError();
    expect(error.message).toContain(`Bedrock stream error (validationException): ${MESSAGE}`);
    expect((error.rawError as { error?: unknown }).error).toEqual({ message: MESSAGE });
  });

  it('an exception with no message: no error, since the provider sent no words', async () => {
    exceptionStream({});
    const error = await streamError();
    expect(error.message).toContain('Bedrock stream error (validationException)');
    expect((error.rawError as { error?: unknown }).error).toBeUndefined();
  });

  it('an error event: the event as it came', async () => {
    const event = { type: 'error', error: { type: 'invalid_request_error', message: MESSAGE } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody([chunkFrame(event)]) })));
    const error = await streamError();
    expect(error.message).toContain(`Bedrock stream error: ${MESSAGE}`);
    expect((error.rawError as { error?: unknown }).error).toEqual(event);
  });
});
