import {
  effectiveRequiredKeys,
  isPlainObject,
  rootUnionOf,
  stringMembers,
} from '../utils/tool-schema.js';

const MAX_FALLBACK_DESCRIPTION = 4000;

/**
 * Rewrite a root-level `oneOf`/`anyOf`/`allOf` in a tool input schema into a
 * single Anthropic-acceptable object schema: MCP permits a root combinator,
 * and the Anthropic API refuses one with a 400 ("input_schema does not
 * support oneOf, allOf, or anyOf at the top level"). Returns the input
 * unchanged (same reference) when there is nothing to repair, so callers can
 * cheaply detect whether a rewrite happened.
 *
 * When every variant of every combinator present is an object schema,
 * `properties` merges them all (first wins on a key collision); `required`
 * is the union of the variants' lists under `allOf`, and under
 * `oneOf`/`anyOf` only the keys every variant requires; a note naming the
 * alternative argument groups is appended to the description; and
 * variant-level `additionalProperties: false` is dropped. Otherwise the
 * result is a permissive object schema whose description is the schema's own
 * followed by the serialized union, cut to 4,000 characters. Combinators
 * nested inside `properties` or array `items` are left untouched.
 */
export function flattenRootSchemaUnion(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;

  const union = rootUnionOf(schema);
  if (!union) return schema;

  const { combinators } = union;
  const presentKeys = combinators.map(({ key }) => key);
  const rawVariantsAll: unknown[] = combinators.flatMap(({ raw }) => raw);

  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;

  if (union.mergeable) {
    const mergedProperties = new Map<string, unknown>(
      isPlainObject(rest.properties) ? Object.entries(rest.properties) : [],
    );
    for (const { variants } of combinators) {
      for (const variant of variants) {
        if (isPlainObject(variant.properties)) {
          for (const [key, propSchema] of Object.entries(variant.properties)) {
            if (!mergedProperties.has(key)) mergedProperties.set(key, propSchema);
          }
        }
      }
    }
    const properties: Record<string, unknown> = Object.fromEntries(mergedProperties);

    const required = effectiveRequiredKeys(rest.required, combinators).filter((key) =>
      mergedProperties.has(key),
    );

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

    const noteParts = combinators
      .filter(({ key, variants }) => key !== 'allOf' && variants.length > 1)
      .map(({ variants }) => {
        const groups = variants
          .map((variant) => {
            const req = stringMembers(variant.required);
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
