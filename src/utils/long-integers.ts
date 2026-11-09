/**
 * A `JSON.parse` reviver that keeps an integer literal past `Number.MAX_SAFE_INTEGER` as its digits, a string, where
 * `JSON.parse` alone would round it: a long id a model writes unquoted in a tool call's arguments, such as a Discord
 * snowflake, then reaches the tool as written. Every other value is as `JSON.parse` gives it. `context` is the
 * reviver's third argument, which carries the literal's source text; TypeScript's reviver type doesn't declare it,
 * so it's optional here.
 */
export function keepLongIntegers(_key: string, value: unknown, context?: { source: string }): unknown {
  return typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context!.source) ? context!.source : value;
}
