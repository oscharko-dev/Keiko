import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { catalogArray, catalogObject, catalogString, copyCatalogJson } from "./json.js";
import { requireCatalog, type CatalogSchemaMismatch } from "./errors.js";

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const COMMON_KEYS = new Set(["type", "description", "enum", "const"]);
const TYPE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  object: new Set(["properties", "required", "additionalProperties"]),
  array: new Set(["items", "minItems", "maxItems"]),
  string: new Set(["minLength", "maxLength", "pattern"]),
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

// #3414 AC1: an ECMA regex source, valid only if `new RegExp` accepts it. `pattern` is authored by
// the catalog owner at compile time (never attacker-supplied input — the values it later matches
// against are, but those are already bounded to `TOOL_CATALOG_LIMITS.maxStringBytes` by
// `copyCatalogJson` before this dialect ever sees them), the same trust boundary the rest of this
// closed dialect already assumes for every other keyword.
function isValidRegexSource(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function stringSchema(schema: CatalogJsonObject): void {
  numericBounds(schema, "minLength", "maxLength", true);
  if (schema.pattern === undefined) return;
  requireCatalog(isValidRegexSource(catalogString(schema.pattern)), "invalid-schema");
}

function normalizeTypedSchema(schema: CatalogJsonObject, type: string): CatalogJsonObject {
  if (type === "object") return objectSchema(schema);
  if (type === "array") {
    numericBounds(schema, "minItems", "maxItems", true);
    return { ...schema, items: normalizeSchema(catalogObject(schema.items)) };
  }
  if (type === "string") stringSchema(schema);
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

const MAX_MISMATCH_PATHS = 16;

// Distinct schema paths, never one entry per offending value: an array walk names every item under
// the same `…[]…` path, so twenty malformed items are one path here, and a distinct violation
// reached later in the walk is never crowded out of the account (PR #3452 review). The sets are
// bounded by the compiled schema's own shape — paths name declared properties and `[]`/`*` nodes —
// not by the payload.
interface MismatchCollector {
  readonly missingRequired: Set<string>;
  readonly invalidPaths: Set<string>;
  unexpectedPropertyCount: number;
}

function joinSchemaPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function noteInvalid(out: MismatchCollector, path: string): false {
  out.invalidPaths.add(path === "" ? "$" : path);
  return false;
}

function noteMissing(out: MismatchCollector, path: string): void {
  out.missingRequired.add(path);
}

// The cap applies to the SORTED distinct set, so which paths are listed is deterministic, and what
// it drops is counted rather than lost.
function cappedPaths(paths: ReadonlySet<string>): {
  readonly listed: readonly string[];
  readonly dropped: number;
} {
  const sorted = [...paths].sort(compareStrings);
  return {
    listed: Object.freeze(sorted.slice(0, MAX_MISMATCH_PATHS)),
    dropped: Math.max(0, sorted.length - MAX_MISMATCH_PATHS),
  };
}

function collectObjectMismatch(
  schema: CatalogJsonObject,
  value: CatalogJsonObject,
  path: string,
  out: MismatchCollector,
): boolean {
  const properties = catalogObject(schema.properties);
  let matched = true;
  for (const key of catalogArray(schema.required).map(catalogString)) {
    if (Object.hasOwn(value, key)) continue;
    noteMissing(out, joinSchemaPath(path, key));
    matched = false;
  }
  for (const [key, child] of Object.entries(value)) {
    const property = properties[key];
    if (property !== undefined) {
      matched =
        collectMismatch(catalogObject(property), child, joinSchemaPath(path, key), out) && matched;
    } else if (schema.additionalProperties === false) {
      out.unexpectedPropertyCount += 1;
      matched = false;
    } else if (schema.additionalProperties !== true) {
      const additional = catalogObject(schema.additionalProperties);
      matched = collectMismatch(additional, child, joinSchemaPath(path, "*"), out) && matched;
    }
  }
  return matched;
}

function collectArrayMismatch(
  schema: CatalogJsonObject,
  value: CatalogJsonValue,
  path: string,
  out: MismatchCollector,
): boolean {
  if (!Array.isArray(value) || !withinNumericBounds(schema, value.length, "minItems", "maxItems")) {
    return noteInvalid(out, path);
  }
  const items = catalogObject(schema.items);
  let matched = true;
  for (const child of value) {
    matched = collectMismatch(items, child as CatalogJsonValue, `${path}[]`, out) && matched;
  }
  return matched;
}

function collectTypedMismatch(
  schema: CatalogJsonObject,
  value: CatalogJsonValue,
  path: string,
  out: MismatchCollector,
): boolean {
  const type = catalogString(schema.type);
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? collectObjectMismatch(schema, value as CatalogJsonObject, path, out)
      : noteInvalid(out, path);
  }
  if (type === "array") return collectArrayMismatch(schema, value, path, out);
  return scalarWithinSchema(schema, type, value) ? true : noteInvalid(out, path);
}

function scalarWithinSchema(
  schema: CatalogJsonObject,
  type: string,
  value: CatalogJsonValue,
): boolean {
  if (!scalarMatches(type, value)) return false;
  if (typeof value === "string") return stringMatches(schema, value);
  if (typeof value === "number") return withinNumericBounds(schema, value, "minimum", "maximum");
  return true;
}

// `schema.pattern` is only ever reached here already validated by `stringSchema` (every schema
// this dialect matches against was produced by `compileCatalogSchema`), so `new RegExp` cannot
// throw on it.
function stringMatches(schema: CatalogJsonObject, value: string): boolean {
  if (!withinNumericBounds(schema, Array.from(value).length, "minLength", "maxLength"))
    return false;
  const pattern = schema.pattern;
  return pattern === undefined || new RegExp(catalogString(pattern)).test(value);
}

// One walk serves the boolean match and the body-free mismatch account: a second, parallel matcher
// could accept what the account reports (or the reverse) and neither pin would notice.
function collectMismatch(
  schema: CatalogJsonObject,
  value: CatalogJsonValue,
  path: string,
  out: MismatchCollector,
): boolean {
  if (!collectTypedMismatch(schema, value, path, out)) return false;
  const identity = canonicalise(value);
  if (schema.const !== undefined && identity !== canonicalise(schema.const)) {
    return noteInvalid(out, path);
  }
  if (
    schema.enum !== undefined &&
    !catalogArray(schema.enum).some((item) => canonicalise(item) === identity)
  ) {
    return noteInvalid(out, path);
  }
  return true;
}

/**
 * Why `value` fails `schema`, in the schema's own vocabulary, or `undefined` when it matches. Paths
 * name declared properties (`changeset.files[].file`), never the value; a property the schema does
 * not declare is counted, not named. Both lists hold distinct paths, sorted and capped at
 * MAX_MISMATCH_PATHS entries; `droppedPathCount` says how many distinct paths the caps left out.
 */
export function describeCatalogSchemaMismatch(
  schema: CatalogJsonObject,
  value: CatalogJsonValue,
): CatalogSchemaMismatch | undefined {
  const out: MismatchCollector = {
    missingRequired: new Set<string>(),
    invalidPaths: new Set<string>(),
    unexpectedPropertyCount: 0,
  };
  if (collectMismatch(schema, value, "", out)) return undefined;
  const missing = cappedPaths(out.missingRequired);
  const invalid = cappedPaths(out.invalidPaths);
  return Object.freeze({
    missingRequired: missing.listed,
    invalidPaths: invalid.listed,
    unexpectedPropertyCount: out.unexpectedPropertyCount,
    droppedPathCount: missing.dropped + invalid.dropped,
  });
}

export function matchesCatalogSchema(schema: CatalogJsonObject, value: CatalogJsonValue): boolean {
  return describeCatalogSchemaMismatch(schema, value) === undefined;
}
