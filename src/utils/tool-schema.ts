/**
 * Reading a tool's input schema: what it declares about each parameter.
 *
 * Three surfaces read these declarations and must agree:
 *
 *   - the XML parameter parser (utils/tool-parser.ts) parses a value by the
 *     JSON type its declaration admits;
 *   - the XML tool-definition renderer (formatters/anthropic-xml.ts, through
 *     `toolDefinitionForPrompt`) tells the model each parameter's type,
 *     nullability, requiredness and, where it can show each exactly, the
 *     values it takes;
 *   - the Anthropic native wire (providers/anthropic-tool-schema.ts) merges a
 *     root-level union into one object schema.
 *
 * The parser and the renderer both read through {@link readToolSchema}, so
 * what the model is told about a parameter and how its value is parsed are one
 * reading, with one deliberate difference. For the renderer, a node whose
 * `type` admits null while its other keywords (an `enum`, a `const`, a
 * combinator or a `$ref`) leave null out admits no null, and a parameter is
 * marked nullable only where null survives that; the parser still reads a
 * written null by the type alone (#150). The renderer also lists the values
 * a parameter's declaring nodes, `$ref`s and branches name ({@link valuesBy}),
 * where it can show each exactly, and the parser doesn't read them. The native
 * flattening shares {@link rootUnionOf} (which root unions
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
 * In JSON Schema every `allOf` branch applies to the same instance, so their
 * required lists union; `oneOf`/`anyOf` variants are alternatives, so only a
 * key every alternative requires is required.
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
 * JSON Schema's `number` type admits integers too, so `number` here is a
 * NON-integer number, and `integer` and `number` declarations combine by plain
 * set operations.
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

/**
 * OpenAPI 3.0.3 gives `nullable: true` effect only beside a `type`, and only
 * the boolean `true` counts.
 */
function admittedByTypeKeyword(type: unknown, nullable: unknown): Admitted {
  const names = typeof type === 'string' ? [type] : Array.isArray(type) ? type : undefined;
  if (names === undefined) return UNREADABLE;
  let admitted: Admitted = NOTHING;
  for (const name of names) {
    const kinds = typeof name === 'string' ? TYPE_NAME_KINDS.get(name) : undefined;
    if (kinds === undefined) return UNREADABLE;
    admitted = unionOf(admitted, new Set(kinds));
  }
  return nullable === true ? unionOf(admitted, new Set(['null'])) : admitted;
}

/** What a reading admits, less null; a sentinel stays as it is. */
function withoutNull(admitted: Admitted): Admitted {
  if (typeof admitted === 'string' || !admitted.has('null')) return admitted;
  return new Set([...admitted].filter(kind => kind !== 'null'));
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
  /**
   * Read for the tool instructions: a typed node whose other keywords leave
   * null out admits no null (#150). The parse reads without it, in a context
   * of its own, since `settled` holds this reading's results.
   */
  forInstructions?: boolean;
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
 * OpenAPI 3.0.3 says of `nullable` that "Other Schema Object constraints
 * retain their defined behavior, and therefore may disallow the use of `null`
 * as a value" (antra-tess/membrane#150).
 */
function admittedBy(node: unknown, context: ReadContext): Admitted {
  if (node === true) return ANY;
  if (node === false) return NOTHING;
  if (!isPlainObject(node)) return UNREADABLE;

  if (Object.hasOwn(node, 'type')) {
    const admitted = admittedByTypeKeyword(node.type, ownField(node, 'nullable'));
    if (!context.forInstructions) return admitted;
    const others = admittedByKeywords(node, context);
    return typeof others !== 'string' && !others.has('null') ? withoutNull(admitted) : admitted;
  }
  return admittedByKeywords(node, context);
}

/** What a node's kind-bearing keywords other than `type` admit together. */
function admittedByKeywords(node: Record<string, unknown>, context: ReadContext): Admitted {
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
// Values, for the tool instructions
// ============================================================================

/** A value the instructions can print: JSON's string, number, boolean or null. */
type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * The values a schema node admits, when the schema names them: a list;
 * `undefined` when it names none (as for any `type` but one that admits only
 * null, or a branch with no list of its own); or UNREADABLE when something
 * that would narrow them can't be read (a `$ref` that cycles, does not
 * resolve or takes a form this reading doesn't follow, an `enum`, combinator
 * or `$ref` of the wrong shape, a listed or `const` value that isn't a
 * string, number, boolean or null).
 * A `type` that can't be read narrows nothing, so it leaves the list as the
 * other keywords give it. UNREADABLE wins every combination, so a
 * cycle reads the same from any entry point. Read only for the tool
 * instructions' `enum`; the parser never reads it.
 */
type Values = readonly Scalar[] | undefined | typeof UNREADABLE;

interface ValuesContext {
  /** The instructions' kinds reading, whose root the `$ref`s resolve against. */
  kinds: ReadContext;
  /** `$ref`s being read on the current path: meeting one again is a cycle. */
  inProgress: Set<string>;
  /** `$ref`s already read, so a definition shared along many paths is read once. */
  settled: Map<string, Values>;
}

/** Each value once, where it first appears, so one schema always renders the same list. */
function firstOccurrences(values: Iterable<Scalar>): Scalar[] {
  return [...new Set(values)];
}

/** Values both admit, in the first's order; a node with no list doesn't narrow. */
function valuesInBoth(a: Values, b: Values): Values {
  if (a === UNREADABLE || b === UNREADABLE) return UNREADABLE;
  if (a === undefined) return b;
  if (b === undefined) return a;
  const inB = new Set(b);
  return a.filter(value => inB.has(value));
}

/** `anyOf`: a value any branch admits, provided every branch has a list. */
function valuesInAny(each: readonly Values[]): Values {
  if (each.includes(UNREADABLE)) return UNREADABLE;
  if (each.includes(undefined)) return undefined;
  return firstOccurrences((each as readonly (readonly Scalar[])[]).flat());
}

/** `oneOf`: a value exactly one branch admits, since one that several admit fails it. */
function valuesInOne(each: readonly Values[]): Values {
  if (each.includes(UNREADABLE)) return UNREADABLE;
  if (each.includes(undefined)) return undefined;
  const admitting = new Map<Scalar, number>();
  for (const list of each as readonly (readonly Scalar[])[]) {
    for (const value of list) admitting.set(value, (admitting.get(value) ?? 0) + 1);
  }
  return [...admitting].filter(([, count]) => count === 1).map(([value]) => value);
}

/** The values of kinds a reading admits; all of them when it can't say which. */
function valuesOfKinds(values: readonly Scalar[], admitted: Admitted): readonly Scalar[] {
  if (typeof admitted === 'string') return values;
  return values.filter(value => {
    const kinds = kindOfValue(value);
    return typeof kinds !== 'string' && [...kinds].every(kind => admitted.has(kind));
  });
}

function valuesByRef(ref: unknown, context: ValuesContext): Values {
  if (typeof ref !== 'string') return UNREADABLE;
  if (context.settled.has(ref)) return context.settled.get(ref);
  // A cycle names no list, from any entry point.
  if (context.inProgress.has(ref)) return UNREADABLE;
  // The kinds reading's resolution, so both readings follow a ref to one node.
  const target = refTarget(context.kinds.root, ref);
  if (target === undefined) return UNREADABLE;
  context.inProgress.add(ref);
  const values = valuesBy(target, context);
  context.inProgress.delete(ref);
  context.settled.set(ref, values);
  return values;
}

/**
 * The values one schema node admits, for the tool instructions.
 *
 * `enum` lists its values, `const` one value, and a `type` that admits only
 * null the value null. A node's keywords all apply at once, so their lists
 * intersect, and the kinds its keywords admit, as the instructions' reading
 * reads them, keep only the values of those kinds. `anyOf` lists the values
 * any branch admits and `oneOf` those exactly one branch admits, provided
 * every branch has a list; `allOf` lists the values its listing branches
 * share; `$ref` lists its target's, through chains of any length. Keywords
 * that constrain neither kinds nor values, such as `pattern`, `minimum` or
 * `not`, aren't read, as the kinds reading doesn't read them.
 */
function valuesBy(node: unknown, context: ValuesContext): Values {
  if (node === false) return [];
  if (node === true) return undefined;
  if (!isPlainObject(node)) return UNREADABLE;
  let values: Values;
  if (Object.hasOwn(node, 'enum')) {
    const listed = node.enum;
    values = Array.isArray(listed) && listed.every(isScalar) ? firstOccurrences(listed) : UNREADABLE;
  }
  if (Object.hasOwn(node, 'const')) {
    values = valuesInBoth(values, isScalar(node.const) ? [node.const] : UNREADABLE);
  }
  for (const [key, combine] of [['anyOf', valuesInAny], ['oneOf', valuesInOne]] as const) {
    if (!Object.hasOwn(node, key)) continue;
    const branches = node[key];
    values = valuesInBoth(
      values,
      Array.isArray(branches) ? combine(branches.map(branch => valuesBy(branch, context))) : UNREADABLE
    );
  }
  if (Object.hasOwn(node, 'allOf')) {
    const branches = node.allOf;
    if (!Array.isArray(branches)) return UNREADABLE;
    for (const branch of branches) values = valuesInBoth(values, valuesBy(branch, context));
  }
  if (Object.hasOwn(node, '$ref')) values = valuesInBoth(values, valuesByRef(node.$ref, context));
  const typeKinds = Object.hasOwn(node, 'type')
    ? admittedByTypeKeyword(node.type, ownField(node, 'nullable'))
    : ANY;
  if (values === undefined) {
    // A type that admits only null is a list of one, which the node's other
    // keywords may still rule out.
    const onlyNull = typeof typeKinds !== 'string' && typeKinds.size === 1 && typeKinds.has('null');
    if (!onlyNull) return undefined;
    values = [null];
  }
  if (values === UNREADABLE) return UNREADABLE;
  // The type and the other keywords filter apart, so one that can't be read
  // leaves the other's filter standing.
  return valuesOfKinds(valuesOfKinds(values, typeKinds), admittedByKeywords(node, context.kinds));
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
  /**
   * The declaration also admits `null`. Set for an `unresolved` declaration
   * too when what it admits includes null beside several kinds it can read:
   * a type list such as `["string", "number", "null"]`, `nullable: true`
   * beside such a list, an `anyOf` or `oneOf` with a null branch, or an
   * `enum` mixing null with values of several kinds.
   */
  nullable: boolean;
  /**
   * Whether the tool instructions mark the parameter `nullable="true"`:
   * `nullable`, read again with each typed node's other keywords (an `enum`,
   * a `const`, a combinator or a `$ref`) also able to leave null out, and
   * combined through `$ref`s, branches and root alternatives as the parse
   * combines them (#150). The parse follows `nullable`, so a written null
   * still reaches the tool as null where the two differ.
   */
  instructedNullable: boolean;
  /** Unconditionally required, with root-combinator semantics. */
  required: boolean;
  /** From the first schema node that declares the parameter. */
  description?: string;
  /**
   * The values the reading lists for the parameter, which the tool
   * instructions print where they can show each exactly: from its own `enum`
   * or `const`, or behind a `$ref`, in branches, or across root alternatives,
   * combined as the kinds are
   * ({@link valuesBy}). Only values of kinds the instructions' reading admits,
   * where it can name them, and null only where the parameter is marked
   * nullable. Absent when no list can be named, when a listed value isn't a
   * string, number, boolean or null, or when the list would be empty.
   */
  enum?: Array<string | number | boolean | null>;
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
  return { status: 'unresolved', nullable };
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

    const parseContext: ReadContext = { root: inputSchema, inProgress: new Set(), settled: new Map() };
    const instructionsContext: ReadContext = {
      root: inputSchema,
      inProgress: new Set(),
      settled: new Map(),
      forInstructions: true,
    };
    const valuesContext: ValuesContext = {
      kinds: instructionsContext,
      inProgress: new Set(),
      settled: new Map(),
    };
    const required = new Set(
      effectiveRequiredKeys(ownField(inputSchema, 'required'), readCombinators)
    );
    const admittedByEntry = (
      entry: { root?: unknown; alternatives: Map<RootUnionKey, unknown[]> },
      context: ReadContext
    ): Admitted => {
      let admitted: Admitted =
        entry.root === undefined ? ANY : admittedBy(entry.root, context);
      for (const [key, nodes] of entry.alternatives) {
        const each = nodes.map(node => admittedBy(node, context));
        admitted = intersectionOf(
          admitted,
          key === 'allOf' ? each.reduce(intersectionOf, ANY) : each.reduce(unionOf, NOTHING)
        );
      }
      return admitted;
    };
    // The same combination for values: the root and allOf alternatives apply
    // at once, and anyOf/oneOf alternatives are alternatives. A root oneOf
    // unites too, as the kinds do: whether a call fits exactly one
    // alternative turns on its other parameters, which this one can't see.
    const valuesByEntry = (entry: {
      root?: unknown;
      alternatives: Map<RootUnionKey, unknown[]>;
    }): Values => {
      let values: Values = entry.root === undefined ? undefined : valuesBy(entry.root, valuesContext);
      for (const [key, nodes] of entry.alternatives) {
        const each = nodes.map(node => valuesBy(node, valuesContext));
        values = valuesInBoth(
          values,
          key === 'allOf' ? each.reduce<Values>(valuesInBoth, undefined) : valuesInAny(each)
        );
      }
      return values;
    };

    for (const [name, entry] of declarations) {
      const admitted = admittedByEntry(entry, parseContext);
      const instructed = admittedByEntry(entry, instructionsContext);
      const instructedKind = declaredKind(instructed);
      const values = valuesByEntry(entry);
      // Only values of kinds the line's other attributes admit, and null only
      // where it marks the parameter nullable.
      const listed =
        values === undefined || values === UNREADABLE
          ? []
          : valuesOfKinds(values, instructed).filter(
              value => value !== null || instructedKind.nullable
            );
      const description = ownField(entry.declaredBy[0], 'description');
      parameters.set(name, {
        ...declaredKind(admitted),
        instructedNullable: instructedKind.nullable,
        required: required.has(name),
        description: typeof description === 'string' ? description : undefined,
        enum: listed.length > 0 ? [...listed] : undefined,
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
