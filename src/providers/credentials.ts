import { authError } from '../types/index.js';

/** Credential acquisition stays with the application; transports resolve per attempt. */
export interface ResolvedCredential {
  token: string;
  /** Headers tied to this token, e.g. ChatGPT-Account-Id. Returned atomically. */
  headers?: Record<string, string>;
}

export interface CredentialContext {
  /** False for the first attempt; true for the single retry after HTTP 401. */
  forceRefresh: boolean;
  /** The request's combined cancellation/deadline signal. */
  signal?: AbortSignal;
}

export type CredentialResolver = (
  context: CredentialContext,
) => ResolvedCredential | Promise<ResolvedCredential>;

/** Internal shared HTTP seam: refresh only a 401, before a body is consumed.
 * Static credentials retain their single-attempt behavior. SDK-backed callers
 * can use this as their fetch implementation without rebuilding a client. */
export async function fetchWithCredentials(
  input: string | URL | Request,
  init: RequestInit,
  credentials: CredentialResolver | ResolvedCredential,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  for (const forceRefresh of [false, true]) {
    signal?.throwIfAborted();
    const credential = typeof credentials === 'function'
      ? await resolveWithSignal(credentials, forceRefresh, signal)
      : credentials;
    signal?.throwIfAborted();
    if (!credential.token) throw authError('Credential resolver returned an empty token');
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(credential.headers ?? {})) headers.set(key, value);
    if (typeof credentials === 'function' || !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${credential.token}`);
    }
    const response = await fetch(input, { ...init, headers });
    if (response.status !== 401 || typeof credentials !== 'function' || forceRefresh) return response;
    await response.body?.cancel();
  }
  throw new Error('Unreachable credential retry state');
}

/** Bound credential acquisition by the same cancellation/deadline as HTTP. */
async function resolveWithSignal(
  resolver: CredentialResolver,
  forceRefresh: boolean,
  signal?: AbortSignal,
) {
  if (!signal) return resolver({ forceRefresh });
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return resolver({ forceRefresh, signal });
    }), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
