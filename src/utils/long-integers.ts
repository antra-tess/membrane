/**
 * A `JSON.parse` reviver that keeps an integer written as plain digits past `Number.MAX_SAFE_INTEGER` as those digits,
 * a string, where `JSON.parse` alone would round it: a long id a model writes unquoted in a tool call's arguments, such
 * as a Discord snowflake, then reaches the tool as written. Every other value is as `JSON.parse` gives it, and so is
 * every value where the runtime gives the reviver no source text, its third argument, which TypeScript's reviver type
 * doesn't declare.
 */
export function keepLongIntegers(_key: string, value: unknown, context?: { source: string }): unknown {
  return typeof value === 'number' && !Number.isSafeInteger(value) && context !== undefined && /^-?\d+$/.test(context.source)
    ? context.source
    : value;
}
