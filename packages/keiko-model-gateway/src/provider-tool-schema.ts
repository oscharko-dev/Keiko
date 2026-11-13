// OpenAI-family function tools (Azure OpenAI, OpenAI) reject a parameters schema that is not a plain
// object schema at the top level: "schema must have type 'object' and not have
// 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level". A governed tool may still describe
// mutually exclusive argument sets, a conjunction or a forbidden combination that way. The advertised
// schema is flattened into one object with every alternative's properties, `allOf` members are folded
// into the root, and the alternatives and forbidden combinations are named in the description. The
// server keeps validating each call against the original schema, so the advertisement only loosens
// what the model is shown, never what runs.

type JsonObject = Record<string, unknown>;

const ROOT_ALTERNATIVE_KEYS = ["oneOf", "anyOf"] as const;
// Every keyword a provider refuses at the top level of a function's parameters.
const ROOT_KEYWORDS = ["oneOf", "anyOf", "allOf", "not", "enum", "const"] as const;
const ROOT_KEYWORD_SET: ReadonlySet<string> = new Set(ROOT_KEYWORDS);
const MAX_FOLD_DEPTH = 4;
const MAX_SENTENCE_SETS = 8;

export interface ProviderToolSchema {
  readonly parameters: JsonObject;
  readonly description: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectAlternative(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  if (value.type !== undefined && value.type !== "object") return false;
  return value.properties === undefined || isRecord(value.properties);
}

function requiredOf(schema: JsonObject): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function fixedValues(schema: unknown): readonly unknown[] | undefined {
  if (!isRecord(schema)) return undefined;
  if (schema.const !== undefined) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

/** One schema per distinct definition, in first-seen order. */
function distinctDefinitions(definitions: readonly unknown[]): readonly unknown[] {
  const seen = new Map<string, unknown>();
  for (const definition of definitions) {
    const identity = JSON.stringify(definition);
    if (!seen.has(identity)) seen.set(identity, definition);
  }
  return [...seen.values()];
}

/**
 * The advertised schema of a property several alternatives define. A property every definition
 * fixes to a value (a discriminator such as `kind`) keeps every value as one enum; other differing
 * definitions are offered as a nested anyOf, which providers accept below the top level, so the
 * model can still produce a valid call for every alternative.
 */
function mergedProperty(definitions: readonly unknown[]): unknown {
  const distinct = distinctDefinitions(definitions);
  const [first] = distinct;
  if (distinct.length === 1) return first;
  const values = distinct.map((definition) => fixedValues(definition));
  if (isRecord(first) && values.every((entry) => entry !== undefined)) {
    const merged: JsonObject = { ...first, enum: [...new Set(values.flat())] };
    delete merged.const;
    return merged;
  }
  return { anyOf: distinct };
}

/** Base properties win: every alternative must satisfy the base schema as well. */
function mergedProperties(base: JsonObject, alternatives: readonly JsonObject[]): JsonObject {
  const properties: JsonObject = isRecord(base.properties) ? { ...base.properties } : {};
  const definitions = new Map<string, unknown[]>();
  for (const alternative of alternatives) {
    if (!isRecord(alternative.properties)) continue;
    for (const [name, schema] of Object.entries(alternative.properties)) {
      if (name in properties) continue;
      const known = definitions.get(name);
      if (known === undefined) definitions.set(name, [schema]);
      else known.push(schema);
    }
  }
  for (const [name, schemas] of definitions) properties[name] = mergedProperty(schemas);
  return properties;
}

function sharedRequired(base: JsonObject, alternatives: readonly JsonObject[]): readonly string[] {
  const [first, ...rest] = alternatives.map((alternative) => requiredOf(alternative));
  const common = (first ?? []).filter((name) => rest.every((names) => names.includes(name)));
  return [...new Set([...requiredOf(base), ...common])];
}

/** The names a forbidden combination (`not`) lists: one set, or one set per anyOf/oneOf member. */
function forbiddenSets(not: unknown): readonly (readonly string[])[] {
  if (!isRecord(not)) return [];
  const own = requiredOf(not);
  if (own.length > 0) return [own];
  for (const key of ROOT_ALTERNATIVE_KEYS) {
    const members = not[key];
    if (!Array.isArray(members) || members.length === 0) continue;
    const sets = members.map((member) => (isRecord(member) ? requiredOf(member) : []));
    if (sets.every((names) => names.length > 0)) return sets;
  }
  return [];
}

/** One alternative as the model reads it: what it requires, and what it must leave out. */
function alternativeLabel(alternative: JsonObject): string {
  const names = requiredOf(alternative).join(" + ");
  const absent = forbiddenSets(alternative.not)
    .filter((set) => set.length === 1)
    .map((set) => set.join(""));
  const without = absent.length > 0 ? `without ${absent.join(", ")}` : "";
  return [names, without].filter((part) => part.length > 0).join(" ") || "no arguments";
}

// The sentence stays bounded however many alternatives a schema lists: the first MAX_SENTENCE_SETS are
// named and the rest are counted. Validation of the call is unaffected, it uses the original schema.
function alternativesSentence(alternatives: readonly JsonObject[], lead: string): string {
  const named = alternatives
    .slice(0, MAX_SENTENCE_SETS)
    .map((alternative) => alternativeLabel(alternative));
  const omitted = alternatives.length - named.length;
  const listed = omitted > 0 ? [...named, `${String(omitted)} more argument sets`] : named;
  return `${lead} ${listed.join("; or ")}.`;
}

/** A `not` over required names: the combination the validator refuses and the schema can no longer say. */
function forbiddenSentence(sets: readonly (readonly string[])[]): string {
  const [only] = sets;
  if (sets.length === 1 && only !== undefined) {
    return only.length === 1
      ? `Do not provide ${only.join("")}.`
      : `Do not provide all of these together: ${only.join(" + ")}.`;
  }
  const listed = sets.slice(0, MAX_SENTENCE_SETS).map((names) => names.join(" + "));
  return `Do not provide any of these combinations: ${listed.join("; or ")}.`;
}

/**
 * Every root alternative list as object alternatives, or undefined when one of them is not a
 * non-empty list of object alternatives, in which case the schema is advertised as it is.
 */
function toAlternativeGroups(
  lists: readonly unknown[],
): readonly (readonly JsonObject[])[] | undefined {
  const groups: (readonly JsonObject[])[] = [];
  for (const alternatives of lists) {
    if (
      !Array.isArray(alternatives) ||
      alternatives.length === 0 ||
      !alternatives.every((alternative) => isObjectAlternative(alternative))
    ) {
      return undefined;
    }
    groups.push(alternatives);
  }
  return groups;
}

/** What a root schema holds once its `allOf` members are folded into it. */
interface FoldedRoot {
  readonly properties: JsonObject;
  readonly required: string[];
  readonly lists: unknown[];
  readonly forbidden: (readonly (readonly string[])[])[];
}

/** Folds one schema (the root, then each `allOf` member) into the accumulator; false when it cannot. */
function foldInto(folded: FoldedRoot, schema: JsonObject, depth: number): boolean {
  if (isRecord(schema.properties)) {
    for (const [name, definition] of Object.entries(schema.properties)) {
      if (!(name in folded.properties)) folded.properties[name] = definition;
    }
  }
  folded.required.push(...requiredOf(schema));
  for (const key of ROOT_ALTERNATIVE_KEYS) {
    if (schema[key] !== undefined) folded.lists.push(schema[key]);
  }
  const forbidden = forbiddenSets(schema.not);
  if (forbidden.length > 0) folded.forbidden.push(forbidden);
  if (schema.allOf === undefined) return true;
  if (!Array.isArray(schema.allOf) || depth >= MAX_FOLD_DEPTH) return false;
  return schema.allOf.every((member) => isRecord(member) && foldInto(folded, member, depth + 1));
}

function foldRoot(schema: JsonObject): FoldedRoot | undefined {
  const folded: FoldedRoot = { properties: {}, required: [], lists: [], forbidden: [] };
  return foldInto(folded, schema, 0) ? folded : undefined;
}

/** True when a provider that wants a plain object schema at the top level would refuse this one. */
function needsProjection(schema: JsonObject): boolean {
  if (ROOT_KEYWORDS.some((key) => schema[key] !== undefined)) return true;
  return schema.type !== undefined && schema.type !== "object";
}

const GROUP_LEADS = [
  "Provide exactly one of these argument sets:",
  "Also provide one of these argument sets:",
] as const;

/**
 * The provider-facing schema and description of one tool; unchanged when nothing needs projecting.
 * A root oneOf and a root anyOf both hold, so each list adds the names all its alternatives require
 * and its own sentence. A root allOf is folded into the root, including the lists and forbidden
 * combinations its members carry; a root not, enum or const is dropped from the advertisement, a
 * forbidden combination of argument names is named in the description. Keiko's validation always
 * uses the original schema.
 */
export function providerToolSchema(schema: JsonObject, description: string): ProviderToolSchema {
  if (!needsProjection(schema)) return { parameters: schema, description };
  const folded = foldRoot(schema);
  const groups = folded === undefined ? undefined : toAlternativeGroups(folded.lists);
  if (folded === undefined || groups === undefined) return { parameters: schema, description };
  const alternatives = groups.flat();
  const rest = Object.fromEntries(
    Object.entries(schema).filter(([name]) => !ROOT_KEYWORD_SET.has(name)),
  );
  const required = [
    ...new Set([...folded.required, ...groups.flatMap((group) => sharedRequired({}, group))]),
  ];
  const closed =
    alternatives.length > 0 &&
    alternatives.every((alternative) => alternative.additionalProperties === false);
  const parameters: JsonObject = {
    ...rest,
    type: "object",
    properties: mergedProperties({ properties: folded.properties }, alternatives),
    ...(required.length > 0 ? { required } : {}),
    ...(closed ? { additionalProperties: false } : {}),
  };
  const sentences = [
    ...groups.map((group, index) =>
      alternativesSentence(group, GROUP_LEADS[Math.min(index, 1)] ?? ""),
    ),
    ...folded.forbidden.slice(0, MAX_SENTENCE_SETS).map((sets) => forbiddenSentence(sets)),
  ].join(" ");
  return {
    parameters,
    description:
      sentences.length === 0
        ? description
        : description.length > 0
          ? `${description} ${sentences}`
          : sentences,
  };
}
