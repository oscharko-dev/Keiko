// OpenAI-family function tools (Azure OpenAI, OpenAI) reject a parameters schema whose top level
// carries oneOf/anyOf: "schema must have type 'object' and not have 'oneOf'/'anyOf'/... at the top
// level". A governed tool may still describe mutually exclusive argument sets that way. The
// advertised schema is flattened into one object with every alternative's properties, and the
// alternatives are named in the description. The server keeps validating each call against the
// original schema, so the advertisement only loosens what the model is shown, never what runs.

type JsonObject = Record<string, unknown>;

const ROOT_ALTERNATIVE_KEYS = ["oneOf", "anyOf"] as const;

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

function mergedProperties(base: JsonObject, alternatives: readonly JsonObject[]): JsonObject {
  const properties: JsonObject = isRecord(base.properties) ? { ...base.properties } : {};
  for (const alternative of alternatives) {
    if (!isRecord(alternative.properties)) continue;
    for (const [name, schema] of Object.entries(alternative.properties)) {
      if (!(name in properties)) properties[name] = schema;
    }
  }
  return properties;
}

function sharedRequired(base: JsonObject, alternatives: readonly JsonObject[]): readonly string[] {
  const [first, ...rest] = alternatives.map(requiredOf);
  const common = (first ?? []).filter((name) => rest.every((names) => names.includes(name)));
  return [...new Set([...requiredOf(base), ...common])];
}

function alternativesSentence(alternatives: readonly JsonObject[]): string {
  const sets = alternatives.map((alternative) => {
    const names = requiredOf(alternative);
    return names.length > 0 ? names.join(" + ") : "no arguments";
  });
  return `Provide exactly one of these argument sets: ${sets.join("; or ")}.`;
}

/** The provider-facing schema and description of one tool; unchanged when nothing needs flattening. */
export function providerToolSchema(schema: JsonObject, description: string): ProviderToolSchema {
  const key = ROOT_ALTERNATIVE_KEYS.find((candidate) => Array.isArray(schema[candidate]));
  if (key === undefined) return { parameters: schema, description };
  const alternatives = schema[key] as readonly unknown[];
  if (alternatives.length === 0 || !alternatives.every(isObjectAlternative)) {
    return { parameters: schema, description };
  }
  const rest = Object.fromEntries(Object.entries(schema).filter(([name]) => name !== key));
  const required = sharedRequired(schema, alternatives);
  const closed = alternatives.every((alternative) => alternative.additionalProperties === false);
  const parameters: JsonObject = {
    ...rest,
    type: "object",
    properties: mergedProperties(schema, alternatives),
    ...(required.length > 0 ? { required } : {}),
    ...(closed ? { additionalProperties: false } : {}),
  };
  const sentence = alternativesSentence(alternatives);
  return {
    parameters,
    description: description.length > 0 ? `${description} ${sentence}` : sentence,
  };
}
