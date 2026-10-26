export const ROOT_UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;

export type RootUnionKey = (typeof ROOT_UNION_KEYS)[number];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownField(record: unknown, key: string): unknown {
  return isPlainObject(record) && Object.hasOwn(record, key) ? record[key] : undefined;
}

function ownProperties(schema: unknown): Array<[string, unknown]> {
  const properties = ownField(schema, 'properties');
  return isPlainObject(properties) ? Object.entries(properties) : [];
}

export function stringMembers(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export interface RootCombinator {
  key: RootUnionKey;
  raw: unknown[];
  variants: Record<string, unknown>[];
}

export interface RootUnion {
  combinators: RootCombinator[];
  mergeable: boolean;
}

function isMergeableObjectVariant(variant: Record<string, unknown>): boolean {
  return (
    variant.type === 'object' ||
    (variant.type === undefined && isPlainObject(variant.properties))
  );
}

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

type Admitted = ReadonlySet<JsonKind> | typeof ANY | typeof UNREADABLE;

const NOTHING: ReadonlySet<JsonKind> = new Set();

function unionOf(a: Admitted, b: Admitted): Admitted {
  if (a === ANY || b === ANY) return ANY;
  if (a === UNREADABLE || b === UNREADABLE) return UNREADABLE;
  return new Set([...a, ...b]);
}

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

function withoutNull(admitted: Admitted): Admitted {
  if (typeof admitted === 'string' || !admitted.has('null')) return admitted;
  return new Set([...admitted].filter(kind => kind !== 'null'));
}

const REF_PREFIXES = [
  { prefix: '#/definitions/', key: 'definitions' },
  { prefix: '#/$defs/', key: '$defs' },
] as const;

function refTarget(root: Record<string, unknown>, ref: string): unknown {
  for (const { prefix, key } of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (name.length === 0 || name.includes('/') || name.includes('~')) return undefined;
    return ownField(ownField(root, key), name);
  }
  return undefined;
}

interface ReadContext {
  root: Record<string, unknown>;
  inProgress: Set<string>;
  settled: Map<string, Admitted>;
  forInstructions?: boolean;
}

function admittedByRef(ref: unknown, context: ReadContext): Admitted {
  if (typeof ref !== 'string') return UNREADABLE;
  const settled = context.settled.get(ref);
  if (settled !== undefined) return settled;
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

type Scalar = string | number | boolean | null;

function isScalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

type Values = readonly Scalar[] | undefined | typeof UNREADABLE;

interface ValuesContext {
  kinds: ReadContext;
  inProgress: Set<string>;
  settled: Map<string, Values>;
}

function firstOccurrences(values: Iterable<Scalar>): Scalar[] {
  return [...new Set(values)];
}

function valuesInBoth(a: Values, b: Values): Values {
  if (a === UNREADABLE || b === UNREADABLE) return UNREADABLE;
  if (a === undefined) return b;
  if (b === undefined) return a;
  const inB = new Set(b);
  return a.filter(value => inB.has(value));
}

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
  if (context.inProgress.has(ref)) return UNREADABLE;
  const target = refTarget(context.kinds.root, ref);
  if (target === undefined) return UNREADABLE;
  context.inProgress.add(ref);
  const values = valuesBy(target, context);
  context.inProgress.delete(ref);
  context.settled.set(ref, values);
  return values;
}

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
    const onlyNull = typeof typeKinds !== 'string' && typeKinds.size === 1 && typeKinds.has('null');
    if (!onlyNull) return undefined;
    values = [null];
  }
  if (values === UNREADABLE) return UNREADABLE;
  return valuesOfKinds(valuesOfKinds(values, typeKinds), admittedByKeywords(node, context.kinds));
}

export interface ParameterDeclaration {
  status: 'typed' | 'untyped' | 'unresolved';
  type?: string;
  nullable: boolean;
  instructedNullable: boolean;
  required: boolean;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  declaredBy: unknown[];
}

export interface ToolSchemaReading {
  parameters: Map<string, ParameterDeclaration>;
  unreadRootUnion: RootUnionKey[];
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

export function readToolSchema(inputSchema: unknown): ToolSchemaReading {
  const parameters = new Map<string, ParameterDeclaration>();
  if (!isPlainObject(inputSchema)) return { parameters, unreadRootUnion: [] };

  try {
    const union = rootUnionOf(inputSchema);
    const readCombinators = union?.mergeable ? union.combinators : [];
    const unreadRootUnion = union && !union.mergeable ? union.combinators.map(({ key }) => key) : [];

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
    return {
      parameters: new Map(),
      unreadRootUnion: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}
