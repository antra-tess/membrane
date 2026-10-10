import type { ProviderRequest, ProviderRequestOptions } from '../types/index.js';
import { hasToolResultImages } from './tool-result-images.js';

/** Explicit modes override registry knowledge; auto uses the adapter fallback. */
export type ToolResultImageMode = 'auto' | 'media' | 'omit';

/** Synchronous helpers have no model context: callers own a media choice. */
export interface ToolResultImageConversionOptions {
  toolResultImages?: 'media' | 'omit';
}

/** The fields whose selected values must survive asynchronous resolution. */
export interface RequestModelSelection {
  model: string;
  extra?: Record<string, unknown>;
}

/** Capture only the selected model and the values extra's object-rest will send.
 * Other request fields retain direct property access on the original object,
 * including class getters and non-enumerable fields. */
export function captureRequestSelection(request: ProviderRequest): RequestModelSelection {
  const model = request.model;
  const extra = request.extra;
  return { model, extra: extra ? { ...extra } : extra };
}

/** A captured extra override is the same value used for the eventual wire. */
export function effectiveChatModel(selection: RequestModelSelection): string {
  return Object.hasOwn(selection.extra ?? {}, 'model') ? selection.extra!.model as string : selection.model;
}

/** Only known tool media needs a capability decision. User images are explicit. */
function needsToolImageConversion(messages: any[]): boolean {
  return messages.some(msg => Array.isArray(msg.content) && (
    (msg.role === 'tool' && msg.content.some((part: any) => part?.type === 'image_url'))
    || msg.content.some((block: any) => block?.type === 'tool_result' && hasToolResultImages(block.content))
  ));
}

/**
 * First image use pins a decision for this adapter/model, including false.
 * Keeping the in-flight promise also makes concurrent first callers agree.
 * Image-free requests neither consult the registry nor freeze its answer.
 */
export class ToolResultImagePolicy<T extends boolean | Promise<boolean> = boolean> {
  private readonly decisions = new Map<string, boolean | T>();

  constructor(
    private readonly mode: ToolResultImageMode = 'auto',
    private readonly auto: (model: string) => T,
  ) {}

  resolve(model: string, messages: any[], options?: ProviderRequestOptions): boolean | T {
    if (!needsToolImageConversion(messages)) return false;
    if (this.mode !== 'auto') return this.mode === 'media';
    const existing = this.decisions.get(model);
    if (existing !== undefined) return existing;
    const decision = options?.getModelImageInput?.(model) ?? this.auto(model);
    this.decisions.set(model, decision);
    return decision;
  }
}

/** OpenAI Chat models known to lack image input; other models default to media. */
export function openAIModelImageInput(model: string): boolean {
  // Fine-tuning a text-only base does not add image input. Keep the complete
  // model ID everywhere else: registry identity, pinned policy, and wire.
  model = model.startsWith('ft:') ? model.split(':')[1] ?? model : model;
  return !(
    /^(?:o1-mini|o1-preview|o3-mini)(?:-|$)/.test(model)
    || model.startsWith('gpt-3.5')
    || model.startsWith('gpt-oss-')
    || /^gpt-4(?:$|-32k(?:-|$)|-0314$|-0613$|-1106-preview$|-0125-preview$|-turbo-preview$)/.test(model)
  );
}

/** Wait independently of shared work, preserving the caller's abort reason. */
export function waitForImageDecision<T>(work: T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!signal) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
