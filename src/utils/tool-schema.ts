/**
 * Reading a tool's input schema: what it declares about each parameter.
 *
 * Three surfaces read these declarations and must agree:
 *
 *   - the XML parameter parser (utils/tool-parser.ts) parses a value by the
 *     JSON type its declaration admits;
 *   - the XML tool-definition renderer (formatters/anthropic-xml.ts, through
 *     `toolDefinitionForPrompt`) tells the model each parameter's type,
 *     nullability and requiredness;
 *   - the Anthropic native wire (providers/anthropic-tool-schema.ts) merges a
 *     root-level union into one object schema.
 *
 * The parser and the renderer both read through {@link readToolSchema}, so
 * what the model is told about a parameter and how its value is parsed are one
 * reading. The native flattening shares {@link rootUnionOf} (which root unions
 * merge into one parameter list) and {@link effectiveRequiredKeys} (which of
 * their keys are required), so the two wires agree on which parameters exist
 * and which are required. They deliberately differ on one thing: the native
 * merge keeps the FIRST variant's schema for a parameter several alternatives
 * declare, while the XML reading admits what every declaring alternative
 * admits — first-wins there would parse a valid call to a later alternative by
 * an earlier alternative's type.
 *
 * Schemas arrive from producers unvalidated — MCP servers, hand-written tool
 * definitions — so nothing here trusts their shape. A node that is not a plain
 * object, a keyword whose value has the wrong shape, a `$ref` that does not
 * resolve, and a key spelled like an `Object.prototype` member are all read as
 * data, never followed as structure, and reading never throws.
 */

/** Root-level combinator keys, in the order their variants are read. */
export const ROOT_UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;

export type RootUnionKey = (typeof ROOT_UNION_KEYS)[number];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `record[key]` when `record` is a plain object that OWNS `key`, never an inherited member. */
function ownField(record: unknown, key: string): unknown {
  return isPlainObject(record) && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Own entries of a schema's `properties`, when it is a plain object; none otherwise. */
function ownProperties(schema: unknown): Array<[string, unknown]> {
  const properties = ownField(schema, 'properties');
  return isPlainObject(properties) ? Object.entries(properties) : [];
}

/** Schema lists arrive unvalidated: keep the string members. */
export function stringMembers(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

// ============================================================================
// Root-level unions
// ============================================================================

/** One combinator present at a schema's root. */
export interface RootCombinator {
  key: RootUnionKey;
  /** The combinator's array as declared. */
  raw: unknown[];
  /** Its members that are plain objects. */
  variants: Record<string, unknown>[];
}

export interface RootUnion {
  /** The combinators present, in {@link ROOT_UNION_KEYS} order. */
  combinators: RootCombinator[];
  /**
   * Every member of every present combinator is an object schema, so the
   * variants' properties merge into one parameter list.
   */
  mergeable: boolean;
}

function isMergeableObjectVariant(variant: Record<string, unknown>): boolean {
  return (
    variant.type === 'object' ||
    (variant.type === undefined && isPlainObject(variant.properties))
  );
}

/**
 * The root-level `oneOf`/`anyOf`/`allOf` of a schema, or `undefined` when it
 * has none. A combinator counts when it is a non-empty array.
 *
 * `mergeable` decides, for every surface at once, whether the variants are
 * read as parameters: the native wire merges them into one object schema only
 * when every variant is an object schema (`type: "object"`, or no `type` and a
 * `properties` object), and the XML reading follows the same rule. Any other
 * root union — a `$ref` variant, a string alternative — falls back on both:
 * the native wire to a permissive object schema carrying the union in its
 * description, the XML surfaces to the root's own `properties`.
 */
export function rootUnionOf(schema: Record<string, unknown>): RootUnion | undefined {
  const combinators: RootCombinator[] = [];
  for (const key of ROOT_UNION_KEYS) {
    const raw = schema[key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    combinators.push({ key, raw, variants: raw.filter(isPlainObject) });
  }
  if (combinators.length === 0) return undefined;
  const mergeable = combinators.every(
    ({ raw, variants }) =>
      variants.length === raw.length && variants.every(isMergeableObjectVariant)
  );
  return { combinators, mergeable };
}

/**
 * The keys a valid instance MUST carry, given a root `required` and the root
 * combinators around it.
 *
 * Requiredness follows the combinator's own semantics: every `allOf` branch
 * applies to the same instance, so their required lists UNION; `oneOf`/`anyOf`
 * variants are alternatives, so only a key required by EVERY alternative is
 * unconditionally required — an INTERSECTION. Sibling combinators must all
 * hold at once, so their results union together with root `required`.
 *
 * The Anthropic native wire (`flattenRootSchemaUnion`) and the XML reading
 * ({@link readToolSchema}) both derive requiredness here.
 */
export function effectiveRequiredKeys(
  rootRequired: unknown,
  combinators: ReadonlyArray<{
    key: RootUnionKey;
    variants: ReadonlyArray<{ required?: unknown }>;
  }>
): string[] {
  const requiredPerCombinator = combinators.flatMap(({ key, variants }) => {
    const variantRequired = variants.map(variant => stringMembers(variant.required));
    if (key === 'allOf') return variantRequired.flat();
    return variantRequired.reduce(
      (sharedKeys, variantKeys) => sharedKeys.filter(name => variantKeys.includes(name)),
      variantRequired[0] ?? []
    );
  });
  return [...new Set([...stringMembers(rootRequired), ...requiredPerCombinator])];
}

// ============================================================================
// The JSON kinds a declaration admits
// ============================================================================

/**
 * JSON value kinds. `number` here is a NON-integer number: the type name
 * `number` admits both `integer` and `number`, so `integer` and `number`
 * declarations combine by plain set operations.
 */
type JsonKind = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

const TYPE_NAME_KINDS = new Map<string, readonly JsonKind[]>([
  ['string', ['string']],
  ['integer', ['integer']],
  ['number', ['integer', 'number']],
  ['boolean', ['boolean']],
  ['object', ['object']],
  ['array', ['array']],
  ['null', ['null']],
]);

const ANY = 'any';
const UNREADABLE = 'unreadable';

/**
 * What a schema node admits: a set of kinds; ANY when nothing in it
 * constrains the kind (`{}`, `true`, a description alone); UNREADABLE when
 * something that would constrain it cannot be read (an unknown type name, a
 * `$ref` that does not resolve or that cycles, a keyword of the wrong shape).
 */
type Admitted = ReadonlySet<JsonKind> | typeof ANY | typeof UNREADABLE;

const NOTHING: ReadonlySet<JsonKind> = new Set();

/** Alternatives: a value is valid when ANY of them admits it. */
function unionOf(a: Admitted, b: Admitted): Admitted {
  if (a === ANY || b === ANY) return ANY;
  if (a === UNREADABLE || b === UNREADABLE) return UNREADABLE;
  return new Set([...a, ...b]);
}

/** Conjunction: a value is valid when ALL of them admit it. */
function intersectionOf(a: Admitted, b: Admitted): Admitted {
  if (a === UNREADABLE || b === UNREADABLE) return UNREADABLE;
  if (a === ANY) return b;
  if (b === ANY) return a;
  return new Set([...a].filter(kind => b.has(kind)));
}

function kindOfValue(value: unknown): Admitted {
  if (value === null) return new Set(['null']);
  switch (typeof value) {
    case 'string':
      return new Set(['string']);
    case 'boolean':
      return new Set(['boolean']);
    case 'number':
      return new Set([Number.isInteger(value) ? 'integer' : 'number']);
    case 'object':
      return new Set([Array.isArray(value) ? 'array' : 'object']);
    default:
      return UNREADABLE;
  }
}

function admittedByTypeKeyword(type: unknown): Admitted {
  const names = typeof type === 'string' ? [type] : Array.isArray(type) ? type : undefined;
  if (names === undefined) return UNREADABLE;
  let admitted: Admitted = NOTHING;
  for (const name of names) {
    const kinds = typeof name === 'string' ? TYPE_NAME_KINDS.get(name) : undefined;
    if (kinds === undefined) return UNREADABLE;
    admitted = unionOf(admitted, new Set(kinds));
  }
  return admitted;
}

/** `$ref` spellings resolved against the tool's own inputSchema. */
const REF_PREFIXES = [
  { prefix: '#/definitions/', key: 'definitions' },
  { prefix: '#/$defs/', key: '$defs' },
] as const;

function refTarget(root: Record<string, unknown>, ref: string): unknown {
  for (const { prefix, key } of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    // Only flat names: a deeper JSON pointer (or one carrying ~0/~1 escapes)
    // is an unreadable form, and says so out loud rather than guessing.
    if (name.length === 0 || name.includes('/') || name.includes('~')) return undefined;
    return ownField(ownField(root, key), name);
  }
  return undefined;
}

interface ReadContext {
  root: Record<string, unknown>;
  /** `$ref`s being read on the current path: meeting one again is a cycle. */
  inProgress: Set<string>;
  /** `$ref`s already read, so a definition shared along many paths is read once. */
  settled: Map<string, Admitted>;
}

function admittedByRef(ref: unknown, context: ReadContext): Admitted {
  if (typeof ref !== 'string') return UNREADABLE;
  const settled = context.settled.get(ref);
  if (settled !== undefined) return settled;
  // A cycle: every definition on it reads as UNREADABLE, from any entry point.
  if (context.inProgress.has(ref)) return UNREADABLE;
  const target = refTarget(context.root, ref);
  if (target === undefined) return UNREADABLE;
  context.inProgress.add(ref);
  const admitted = admittedBy(target, context);
  context.inProgress.delete(ref);
  context.settled.set(ref, admitted);
  return admitted;
}

/**
 * The kinds one schema node admits.
 *
 * `type`, when present, decides on its own. It is what the XML instructions
 * have always rendered for a parameter, so reading it alone keeps every such
 * rendering byte-identical; the other kind-bearing keywords are read for a
 * declaration that has no `type`, and all of them apply at once: `enum` and
 * `const` admit the kinds of their values, `anyOf`/`oneOf` the union of their
 * branches, `allOf` the intersection, and `$ref` its target inside the tool's
 * own `definitions`/`$defs`, followed through chains of any length.
 */
function admittedBy(node: unknown, context: ReadContext): Admitted {
  if (node === true) return ANY;
  if (node === false) return NOTHING;
  if (!isPlainObject(node)) return UNREADABLE;

  if (Object.hasOwn(node, 'type')) return admittedByTypeKeyword(node.type);

  let admitted: Admitted = ANY;
  if (Object.hasOwn(node, 'enum')) {
    const values = node.enum;
    admitted = intersectionOf(
      admitted,
      Array.isArray(values)
        ? values.reduce<Admitted>((acc, value) => unionOf(acc, kindOfValue(value)), NOTHING)
        : UNREADABLE
    );
  }
  if (Object.hasOwn(node, 'const')) {
    admitted = intersectionOf(admitted, kindOfValue(node.const));
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Object.hasOwn(node, key)) continue;
    const branches = node[key];
    admitted = intersectionOf(
      admitted,
      Array.isArray(branches)
        ? branches.reduce<Admitted>(
            (acc, branch) => unionOf(acc, admittedBy(branch, context)),
            NOTHING
          )
        : UNREADABLE
    );
  }
  if (Object.hasOwn(node, 'allOf')) {
    const branches = node.allOf;
    admitted = intersectionOf(
      admitted,
      Array.isArray(branches)
        ? branches.reduce<Admitted>(
            (acc, branch) => intersectionOf(acc, admittedBy(branch, context)),
            ANY
          )
        : UNREADABLE
    );
  }
  if (Object.hasOwn(node, '$ref')) {
    admitted = intersectionOf(admitted, admittedByRef(node.$ref, context));
  }
  return admitted;
}

// ============================================================================
// Parameter declarations
// ============================================================================

/** What one tool's schema declares about one parameter, as the XML surfaces read it. */
export interface ParameterDeclaration {
  /**
   * - `typed`: the declaration admits exactly one JSON type (null aside),
   *   named by `type`.
   * - `untyped`: it does not constrain the type at all (`{}`, a description
   *   alone): any JSON value is valid.
   * - `unresolved`: it constrains the type, but not to one type this reader
   *   can name — several types (`string` or `number`, or alternatives that
   *   disagree), none (a contradiction), an unknown type name, or a `$ref`
   *   that cycles or does not resolve inside the tool's own schema.
   */
  status: 'typed' | 'untyped' | 'unresolved';
  /** The JSON Schema type name, when `status` is `typed`. */
  type?: string;
  /** The declaration also admits `null`. */
  nullable: boolean;
  /** Unconditionally required, with root-combinator semantics. */
  required: boolean;
  /** From the first schema node that declares the parameter. */
  description?: string;
  /** From the first schema node that declares the parameter. */
  enum?: string[];
  /** Every schema node that declares the parameter, in reading order. */
  declaredBy: unknown[];
}

export interface ToolSchemaReading {
  /** The declared parameters, in declaration order. */
  parameters: Map<string, ParameterDeclaration>;
  /**
   * Root combinators whose variants were NOT read, because the union does not
   * merge (see {@link rootUnionOf}). A parameter declared only inside them
   * reads as undeclared.
   */
  unreadRootUnion: RootUnionKey[];
  /** Set when the schema could not be read at all; every parameter then reads as undeclared. */
  failure?: string;
}

function declaredKind(
  admitted: Admitted
): Pick<ParameterDeclaration, 'status' | 'type' | 'nullable'> {
  if (admitted === ANY) return { status: 'untyped', nullable: false };
  if (admitted === UNREADABLE) return { status: 'unresolved', nullable: false };
  const nullable = admitted.has('null');
  const nonNull = [...admitted].filter(kind => kind !== 'null');
  if (nonNull.length === 0) {
    // Only null: the type IS null. Nothing at all: a contradiction.
    return nullable
      ? { status: 'typed', type: 'null', nullable: false }
      : { status: 'unresolved', nullable: false };
  }
  if (nonNull.every(kind => kind === 'integer' || kind === 'number')) {
    return { status: 'typed', type: nonNull.includes('number') ? 'number' : 'integer', nullable };
  }
  if (nonNull.length === 1) return { status: 'typed', type: nonNull[0], nullable };
  return { status: 'unresolved', nullable: false };
}

/**
 * Read every parameter a tool's input schema declares.
 *
 * Parameters are the root's own `properties` and, when the root union merges
 * (see {@link rootUnionOf}), the `properties` of every root variant — in that
 * order, root first, then variants in `oneOf`, `anyOf`, `allOf` order, each
 * parameter placed where it first appears. What a parameter admits combines
 * every node that declares it by the combinator's semantics: the root's own
 * declaration and every declaring `allOf` branch apply at once (intersection);
 * the declaring `oneOf`/`anyOf` alternatives are alternatives (union). An
 * alternative that does not declare the parameter does not widen it: a call
 * that carries the parameter is a call to an alternative that declares it.
 */
export function readToolSchema(inputSchema: unknown): ToolSchemaReading {
  const parameters = new Map<string, ParameterDeclaration>();
  if (!isPlainObject(inputSchema)) return { parameters, unreadRootUnion: [] };

  try {
    const union = rootUnionOf(inputSchema);
    const readCombinators = union?.mergeable ? union.combinators : [];
    const unreadRootUnion = union && !union.mergeable ? union.combinators.map(({ key }) => key) : [];

    // Every declaring node of every parameter, by where it sits.
    const declarations = new Map<
      string,
      { root?: unknown; alternatives: Map<RootUnionKey, unknown[]>; declaredBy: unknown[] }
    >();
    const declare = (name: string, where: RootUnionKey | undefined, node: unknown): void => {
      let entry = declarations.get(name);
      if (entry === undefined) {
        entry = { alternatives: new Map(), declaredBy: [] };
        declarations.set(name, entry);
      }
      entry.declaredBy.push(node);
      if (where === undefined) {
        entry.root = node;
      } else {
        const nodes = entry.alternatives.get(where) ?? [];
        nodes.push(node);
        entry.alternatives.set(where, nodes);
      }
    };
    for (const [name, node] of ownProperties(inputSchema)) declare(name, undefined, node);
    for (const { key, variants } of readCombinators) {
      for (const variant of variants) {
        for (const [name, node] of ownProperties(variant)) declare(name, key, node);
      }
    }

    const context: ReadContext = { root: inputSchema, inProgress: new Set(), settled: new Map() };
    const required = new Set(
      effectiveRequiredKeys(ownField(inputSchema, 'required'), readCombinators)
    );

    for (const [name, entry] of declarations) {
      let admitted: Admitted =
        entry.root === undefined ? ANY : admittedBy(entry.root, context);
      for (const [key, nodes] of entry.alternatives) {
        const each = nodes.map(node => admittedBy(node, context));
        admitted = intersectionOf(
          admitted,
          key === 'allOf' ? each.reduce(intersectionOf, ANY) : each.reduce(unionOf, NOTHING)
        );
      }
      const first = entry.declaredBy[0];
      const description = ownField(first, 'description');
      const enumValues = ownField(first, 'enum');
      parameters.set(name, {
        ...declaredKind(admitted),
        required: required.has(name),
        description: typeof description === 'string' ? description : undefined,
        enum: Array.isArray(enumValues) ? (enumValues as string[]) : undefined,
        declaredBy: entry.declaredBy,
      });
    }

    return { parameters, unreadRootUnion };
  } catch (error) {
    // Unreachable for any schema a producer can reasonably send (the reads
    // above guard every shape); kept so an absurd one — nesting deep enough
    // to exhaust the stack — degrades to the legacy parse instead of
    // aborting the inference that carried it.
    return {
      parameters: new Map(),
      unreadRootUnion: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}
