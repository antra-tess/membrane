/**
 * Anthropic tool-schema normalization
 *
 * MCP permits a tool's input JSON Schema to have a root-level `oneOf` /
 * `anyOf` / `allOf` (a union of alternative argument shapes). The Anthropic
 * API does not: `input_schema` must be a single object-type schema, and a
 * root-level combinator is rejected with 400
 * ("input_schema does not support oneOf, allOf, or anyOf at the top level").
 * One such tool 400s the entire inference — same philosophy as
 * `normalize-tool-pairs`: repair at the wire boundary instead of letting a
 * producer-side quirk kill the turn.
 *
 * `flattenRootSchemaUnion` rewrites the common case — every union variant is
 * itself an object schema — into a single object schema:
 *
 *   - `properties` is the merge of all variants' properties (first wins on
 *     key collision).
 *   - `required`: for `allOf` (intersective — every variant applies) the
 *     union of the variants' required lists; for `oneOf`/`anyOf`
 *     (alternatives) only keys required by *every* variant stay required.
 *   - A short note enumerating the alternative argument groups is appended
 *     to the description so the model still sees the union intent.
 *   - Variant-level `additionalProperties: false` is dropped: the merged
 *     object is a permissive superset of the alternatives, and `false`
 *     could reject payloads valid under one of the original variants.
 *
 * If any variant is not object-shaped (e.g. a root `oneOf` of a string and
 * an object), the union cannot be merged into properties; we fall back to a
 * permissive object schema carrying the serialized union in the description.
 * Degenerate, but it does not 400 — the tool stays callable and the model
 * sees the accepted shapes.
 *
 * Nested combinators (inside `properties`, array `items`, etc.) are legal
 * for Anthropic and are left untouched; only the root is rewritten.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMergeableObjectVariant(variant: Record<string, unknown>): boolean {
  return (
    variant.type === 'object' ||
    (variant.type === undefined && isPlainObject(variant.properties))
  );
}

function stringRequired(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

const ROOT_UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;

/** Max length of the description we synthesize on the fallback path. */
const MAX_FALLBACK_DESCRIPTION = 4000;

/**
 * Rewrite a root-level `oneOf`/`anyOf`/`allOf` in a tool input schema into a
 * single Anthropic-acceptable object schema. Returns the input unchanged
 * (same reference) when there is nothing to repair, so callers can cheaply
 * detect whether a rewrite happened.
 */
export function flattenRootSchemaUnion(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;

  // A root may carry more than one combinator at once (e.g. `{ oneOf, anyOf }`).
  // These are sibling keywords: a valid instance must satisfy every one of
  // them (an implicit `allOf` across the combinators). Process *all* present
  // keys — handling only the first would strip the others' variants (the
  // destructuring below removes all three keys), silently losing their
  // properties and required lists.
  const presentKeys = ROOT_UNION_KEYS.filter(
    (key) => Array.isArray(schema[key]) && (schema[key] as unknown[]).length > 0,
  );
  if (presentKeys.length === 0) return schema;

  const combinators = presentKeys.map((key) => {
    const raw = schema[key] as unknown[];
    return { key, raw, variants: raw.filter(isPlainObject) };
  });
  const rawVariantsAll: unknown[] = combinators.flatMap(({ raw }) => raw);

  // Keep every root key except the combinators themselves.
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;

  const allMergeable = combinators.every(
    ({ raw, variants }) =>
      variants.length === raw.length && variants.every(isMergeableObjectVariant),
  );

  if (allMergeable) {
    // Common case: every variant of every present combinator is an object
    // schema — merge them all.
    const properties: Record<string, unknown> = isPlainObject(rest.properties)
      ? { ...rest.properties }
      : {};
    for (const { variants } of combinators) {
      for (const variant of variants) {
        if (isPlainObject(variant.properties)) {
          for (const [key, propSchema] of Object.entries(variant.properties)) {
            if (!(key in properties)) properties[key] = propSchema;
          }
        }
      }
    }

    // Per-combinator required semantics: `allOf` unions its variants' required
    // lists (every variant applies); `oneOf`/`anyOf` keep only keys required by
    // every variant (alternatives). Across combinators they all apply at once,
    // so the effective required set is the union of the per-combinator results.
    const mergedRequired = combinators.flatMap(({ key, variants }) => {
      const variantRequired = variants.map((variant) => stringRequired(variant.required));
      return key === 'allOf'
        ? [...new Set(variantRequired.flat())]
        : variantRequired.reduce(
            (acc, req) => acc.filter((k) => req.includes(k)),
            variantRequired[0] ?? [],
          );
    });
    const required = [
      ...new Set([...stringRequired(rest.required), ...mergedRequired]),
    ].filter((key) => key in properties);

    const {
      properties: _properties,
      required: _required,
      additionalProperties: _additionalProperties,
      ...restSansObjectKeys
    } = rest;

    const result: Record<string, unknown> = {
      ...restSansObjectKeys,
      type: 'object',
      properties,
    };
    if (required.length > 0) result.required = required;

    // For alternatives, preserve the union intent in prose so the model
    // still knows the arguments come in groups (one line per combinator).
    const noteParts = combinators
      .filter(({ key, variants }) => key !== 'allOf' && variants.length > 1)
      .map(({ variants }) => {
        const groups = variants
          .map((variant) => {
            const req = stringRequired(variant.required);
            return req.length > 0 ? `(${req.join(', ')})` : '(no required fields)';
          })
          .join(' | ');
        return `Provide one of the following argument groups: ${groups}.`;
      });
    if (noteParts.length > 0) {
      const note = noteParts.join('\n');
      result.description =
        typeof result.description === 'string' && result.description.length > 0
          ? `${result.description}\n${note}`
          : note;
    }

    return result;
  }

  // Fallback: at least one variant (across the present combinators) is not an
  // object schema (or not a schema at all). Emit a permissive object schema and
  // carry the union(s) into the description so the intent survives.
  const label = presentKeys.join('/');
  let note: string;
  try {
    note = `Accepts one of the following input shapes (flattened from a root-level ${label}): ${JSON.stringify(rawVariantsAll)}`;
  } catch {
    note = `Accepts one of ${rawVariantsAll.length} alternative input shapes (root-level ${label} flattened).`;
  }
  const baseDescription =
    typeof rest.description === 'string' && rest.description.length > 0
      ? `${rest.description}\n${note}`
      : note;

  // Spread `rest` (already sans the combinator keys) so sibling definitions —
  // `$defs`/`definitions` — survive. Without this, a variant serialized into
  // the description as `{"$ref":"#/definitions/A"}` would point at a definition
  // that no longer exists anywhere in the tool. The mergeable path preserves
  // `restSansObjectKeys` for the same reason; the fallback extends the courtesy.
  return {
    ...rest,
    type: 'object',
    properties: isPlainObject(rest.properties) ? rest.properties : {},
    additionalProperties: true,
    description:
      baseDescription.length > MAX_FALLBACK_DESCRIPTION
        ? baseDescription.slice(0, MAX_FALLBACK_DESCRIPTION)
        : baseDescription,
  };
}
