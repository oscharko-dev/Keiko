import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { catalogArray, catalogObject, catalogString, copyCatalogJson } from "./json.js";
import { requireCatalog } from "./errors.js";

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const COMMON_KEYS = new Set(["type", "description", "enum", "const"]);
const TYPE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  object: new Set(["properties", "required", "additionalProperties"]),
  array: new Set(["items", "minItems", "maxItems"]),
  string: new Set(["minLength", "maxLength"]),
  number: new Set(["minimum", "maximum"]),
  integer: new Set(["minimum", "maximum"]),
  boolean: new Set<string>(),
  null: new Set<string>(),
});

function numericBounds(
  schema: CatalogJsonObject,
  lower: string,
  upper: string,
  integers: boolean,
): void {
  for (const key of [lower, upper]) {
    const value = schema[key];
    if (value === undefined) continue;
    requireCatalog(typeof value === "number" && Number.isFinite(value), "invalid-schema");
    if (integers) requireCatalog(Number.isSafeInteger(value) && value >= 0, "invalid-schema");
  }
  if (schema[lower] !== undefined && schema[upper] !== undefined)
    requireCatalog((schema[lower] as number) <= (schema[upper] as number), "invalid-schema");
}

function scalarMatches(type: string, value: CatalogJsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function normalizedEnum(
  schema: CatalogJsonObject,
  type: string,
): readonly CatalogJsonValue[] | undefined {
  if (schema.enum === undefined) return undefined;
  const values = catalogArray(schema.enum);
  requireCatalog(type !== "object" && type !== "array" && values.length > 0, "invalid-schema");
  requireCatalog(
    values.every((value) => scalarMatches(type, value)),
    "invalid-schema",
  );
  const identities = values.map((value) => canonicalise(value));
  requireCatalog(new Set(identities).size === values.length, "invalid-schema");
  return [...values].sort((left, right) => compareStrings(canonicalise(left), canonicalise(right)));
}

function objectSchema(schema: CatalogJsonObject): CatalogJsonObject {
  const properties = catalogObject(schema.properties);
  const required = catalogArray(schema.required).map(catalogString).sort(compareStrings);
  requireCatalog(new Set(required).size === required.length, "invalid-schema");
  requireCatalog(
    required.every((key) => Object.hasOwn(properties, key)),
    "invalid-schema",
  );
  const extra = schema.additionalProperties;
  requireCatalog(
    typeof extra === "boolean" ||
      (typeof extra === "object" && extra !== null && !Array.isArray(extra)),
    "invalid-schema",
  );
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        normalizeSchema(catalogObject(value)),
      ]),
    ),
    required,
    additionalProperties:
      typeof extra === "boolean" ? extra : normalizeSchema(catalogObject(extra)),
  };
}

function normalizeSchema(schema: CatalogJsonObject): CatalogJsonObject {
  const type = catalogString(schema.type);
  requireCatalog(TYPES.has(type), "unsupported-schema");
  const allowed = TYPE_KEYS[type];
  requireCatalog(
    Object.keys(schema).every((key) => COMMON_KEYS.has(key) || allowed?.has(key) === true),
    "unsupported-schema",
  );
  if (schema.description !== undefined) catalogString(schema.description);
  if (schema.const !== undefined)
    requireCatalog(scalarMatches(type, schema.const), "invalid-schema");
  const values = normalizedEnum(schema, type);
  if (values !== undefined && schema.const !== undefined)
    requireCatalog(
      values.some((value) => canonicalise(value) === canonicalise(schema.const)),
      "invalid-schema",
    );
  const normalized = values === undefined ? schema : { ...schema, enum: values };
  return normalizeTypedSchema(normalized, type);
}

function normalizeTypedSchema(schema: CatalogJsonObject, type: string): CatalogJsonObject {
  if (type === "object") return objectSchema(schema);
  if (type === "array") {
    numericBounds(schema, "minItems", "maxItems", true);
    return { ...schema, items: normalizeSchema(catalogObject(schema.items)) };
  }
  if (type === "string") numericBounds(schema, "minLength", "maxLength", true);
  if (type === "number" || type === "integer") numericBounds(schema, "minimum", "maximum", false);
  return schema;
}

/** Closed common dialect: unsupported keywords are errors, never dropped transformations. */
export function compileCatalogSchema(value: unknown): CatalogJsonObject {
  return normalizeSchema(catalogObject(copyCatalogJson(value)));
}

function withinNumericBounds(
  schema: CatalogJsonObject,
  value: number,
  lower: string,
  upper: string,
): boolean {
  const min = schema[lower];
  const max = schema[upper];
  return (typeof min !== "number" || value >= min) && (typeof max !== "number" || value <= max);
}

function objectMatches(schema: CatalogJsonObject, value: CatalogJsonObject): boolean {
  const properties = catalogObject(schema.properties);
  if (!catalogArray(schema.required).every((key) => Object.hasOwn(value, catalogString(key))))
    return false;
  return Object.entries(value).every(([key, child]) => {
    const property = properties[key];
    if (property !== undefined) return schemaMatches(catalogObject(property), child);
    return (
      schema.additionalProperties === true ||
      (schema.additionalProperties !== false &&
        schemaMatches(catalogObject(schema.additionalProperties), child))
    );
  });
}

function arrayMatches(schema: CatalogJsonObject, value: CatalogJsonValue): boolean {
  return (
    Array.isArray(value) &&
    withinNumericBounds(schema, value.length, "minItems", "maxItems") &&
    value.every((child) => schemaMatches(catalogObject(schema.items), child as CatalogJsonValue))
  );
}

function typeMatches(schema: CatalogJsonObject, value: CatalogJsonValue): boolean {
  const type = catalogString(schema.type);
  if (type === "object")
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      objectMatches(schema, value as CatalogJsonObject)
    );
  if (type === "array") return arrayMatches(schema, value);
  if (!scalarMatches(type, value)) return false;
  if (typeof value === "string")
    return withinNumericBounds(schema, Array.from(value).length, "minLength", "maxLength");
  if (typeof value === "number") return withinNumericBounds(schema, value, "minimum", "maximum");
  return true;
}

function schemaMatches(schema: CatalogJsonObject, value: CatalogJsonValue): boolean {
  if (!typeMatches(schema, value)) return false;
  const identity = canonicalise(value);
  if (schema.const !== undefined && identity !== canonicalise(schema.const)) return false;
  return (
    schema.enum === undefined ||
    catalogArray(schema.enum).some((item) => canonicalise(item) === identity)
  );
}

export function matchesCatalogSchema(schema: CatalogJsonObject, value: CatalogJsonValue): boolean {
  return schemaMatches(schema, value);
}
