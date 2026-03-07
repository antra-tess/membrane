/**
 * Safely parse a JSON string, returning an empty object on failure.
 * Used for tool call arguments which may be malformed from streaming.
 */
export function safeParseJson(str: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(str || '{}');
  } catch (e) {
    console.warn('[membrane] Failed to parse tool arguments JSON:', e);
    return {};
  }
}
