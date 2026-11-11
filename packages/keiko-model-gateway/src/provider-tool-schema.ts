// OpenAI-family function tools (Azure OpenAI, OpenAI) reject a parameters schema whose top level
// carries oneOf/anyOf: "schema must have type 'object' and not have 'oneOf'/'anyOf'/... at the top
// level". A governed tool may still describe mutually exclusive argument sets that way. The
// advertised schema is flattened into one object with every alternative's properties, and the
// alternatives are named in the description. The server keeps validating each call against the
// original schema, so the advertisement only loosens what the model is shown, never what runs.

type JsonObject = Record<string, unknown>;

const ROOT_ALTERNATIVE_KEYS = ["oneOf", "anyOf"] as const;
const ROOT_ALTERNATIVE_KEY_SET: ReadonlySet<string> = new Set(ROOT_ALTERNATIVE_KEYS);

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

function alternativesSentence(alternatives: readonly JsonObject[], lead: string): string {
  const sets = alternatives.map((alternative) => {
    const names = requiredOf(alternative);
    return names.length > 0 ? names.join(" + ") : "no arguments";
  });
  return `${lead} ${sets.join("; or ")}.`;
}

/**
 * Every root alternative list (oneOf, anyOf or both), or undefined when one of them is not a
 * non-empty list of object alternatives, in which case the schema is advertised as it is.
 */
function rootAlternativeGroups(schema: JsonObject): readonly (readonly JsonObject[])[] | undefined {
  const groups: (readonly JsonObject[])[] = [];
  for (const key of ROOT_ALTERNATIVE_KEYS) {
    const alternatives = schema[key];
    if (alternatives === undefined) continue;
    if (
      !Array.isArray(alternatives) ||
      alternatives.length === 0 ||
      !alternatives.every((alternative) => isObjectAlternative(alternative))
    ) {
      return undefined;
    }
    groups.push(alternatives);
  }
  return groups.length > 0 ? groups : undefined;
}

const GROUP_LEADS = [
  "Provide exactly one of these argument sets:",
  "Also provide one of these argument sets:",
] as const;

/**
 * The provider-facing schema and description of one tool; unchanged when nothing needs flattening.
 * A root oneOf and a root anyOf both hold, so each list adds the names all its alternatives require
 * and its own sentence.
 */
export function providerToolSchema(schema: JsonObject, description: string): ProviderToolSchema {
  const groups = rootAlternativeGroups(schema);
  if (groups === undefined) return { parameters: schema, description };
  const alternatives = groups.flat();
  const rest = Object.fromEntries(
    Object.entries(schema).filter(([name]) => !ROOT_ALTERNATIVE_KEY_SET.has(name)),
  );
  const required = [...new Set(groups.flatMap((group) => sharedRequired(schema, group)))];
  const closed = alternatives.every((alternative) => alternative.additionalProperties === false);
  const parameters: JsonObject = {
    ...rest,
    type: "object",
    properties: mergedProperties(schema, alternatives),
    ...(required.length > 0 ? { required } : {}),
    ...(closed ? { additionalProperties: false } : {}),
  };
  const sentence = groups
    .map((group, index) => alternativesSentence(group, GROUP_LEADS[Math.min(index, 1)] ?? ""))
    .join(" ");
  return {
    parameters,
    description: description.length > 0 ? `${description} ${sentence}` : sentence,
  };
}
