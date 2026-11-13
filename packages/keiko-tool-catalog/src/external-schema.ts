import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  EXTERNAL_JSON_SCHEMA_DEFAULT,
  isBoundedExternalJsonSchema,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { catalogObject, copyCatalogJson } from "./json.js";
import { requireCatalog, ToolCatalogError, type CatalogSchemaMismatch } from "./errors.js";

const OPTIONS = {
  strict: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allowUnionTypes: true,
  allErrors: false,
  ownProperties: true,
  inlineRefs: false,
  loopRequired: 32,
  loopEnum: 32,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
  logger: false as const,
  code: { optimize: 0 },
};
function compiler(dialect: CatalogJsonValue | undefined): Ajv {
  let validator: Ajv;
  if (dialect === EXTERNAL_JSON_SCHEMA_DEFAULT) validator = new Ajv2020(OPTIONS);
  else if (dialect === "https://json-schema.org/draft/2019-09/schema")
    validator = new Ajv2019(OPTIONS);
  else validator = new Ajv(OPTIONS);
  addFormats.default(validator, {
    mode: "full",
    formats: [
      "date",
      "time",
      "date-time",
      "duration",
      "uri",
      "uri-reference",
      "uri-template",
      "email",
      "hostname",
      "ipv4",
      "ipv6",
      "uuid",
      "json-pointer",
      "relative-json-pointer",
    ],
  });
  validator.addKeyword({ keyword: "x-mcp-header", schemaType: "string", valid: true });
  return validator;
}
// Building an Ajv instance compiles its meta-schema, which dominated every distinct schema's cost
// (about 3.8 ms against 0.15 ms to compile on an existing instance). One instance per dialect
// compiles every schema; each is removed from the instance right after, so no schema, `$id` or
// anchor outlives its own compilation and a repeated `$id` cannot collide. External schemas cannot
// carry `$id`, `$anchor` or dynamic anchors at all (`isBoundedExternalJsonSchema`), so a `$ref` can
// only resolve inside its own schema, as on a fresh instance.
const SHARED_COMPILERS = new Map<string, Ajv>();
function sharedCompiler(dialect: CatalogJsonValue | undefined): Ajv {
  const key = typeof dialect === "string" ? dialect : "";
  const existing = SHARED_COMPILERS.get(key);
  if (existing !== undefined) return existing;
  const created = compiler(dialect);
  SHARED_COMPILERS.set(key, created);
  return created;
}
function compileValidator(schema: CatalogJsonObject): ValidateFunction {
  const shared = sharedCompiler(schema.$schema);
  try {
    return shared.compile(schema);
  } catch (sharedError) {
    // A refusal is only ever decided by a fresh instance, exactly as before sharing: its own
    // compile error propagates and the caller reports the closed `unsupported-schema` refusal.
    compiler(schema.$schema).compile(schema);
    // The fresh instance accepted what the shared one refused, so sharing itself is defective.
    // That is never a valid schema's compilation: it fails closed and keeps its cause.
    throw new Error("Shared external-schema compiler refused a schema a fresh one accepts", {
      cause: sharedError,
    });
  } finally {
    shared.removeSchema(schema);
  }
}
const VALIDATORS = new Map<string, ValidateFunction>();
function validationFor(schema: CatalogJsonObject, bounded = false): ValidateFunction {
  requireCatalog(bounded || isBoundedExternalJsonSchema(schema), "unsupported-schema");
  const identity = canonicalise(schema);
  const cached = VALIDATORS.get(identity);
  if (cached !== undefined) return cached;
  try {
    const validate = compileValidator(schema);
    if (VALIDATORS.size >= 64) {
      const oldest = VALIDATORS.keys().next().value;
      if (oldest !== undefined) VALIDATORS.delete(oldest);
    }
    VALIDATORS.set(identity, validate);
    return validate;
  } catch {
    throw new ToolCatalogError("unsupported-schema");
  }
}

/** Preserve external constraints exactly; an absent dialect means MCP's standard 2020-12. */
export function compileExternalCatalogSchema(value: unknown): CatalogJsonObject {
  requireCatalog(isBoundedExternalJsonSchema(value), "unsupported-schema");
  const schema = catalogObject(copyCatalogJson(value));
  const declared = { ...schema, $schema: schema.$schema ?? EXTERNAL_JSON_SCHEMA_DEFAULT };
  validationFor(declared, true);
  return declared;
}
/** The caller already owns a bounded private copy; no second copy or bound walk is needed. */
export function compileOwnedExternalCatalogSchema(schema: CatalogJsonObject): CatalogJsonObject {
  const declared = { ...schema, $schema: schema.$schema ?? EXTERNAL_JSON_SCHEMA_DEFAULT };
  validationFor(declared);
  return declared;
}

function declaredPath(error: ErrorObject): string {
  const segments = error.schemaPath.split("/");
  let path = "";
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index] === "properties") {
      const key = segments[++index]?.replaceAll("~1", "/").replaceAll("~0", "~");
      if (key !== undefined) path += `${path === "" ? "" : "."}${key}`;
    } else if (segments[index] === "items" || segments[index] === "prefixItems") path += "[]";
  }
  return path === "" ? "$" : path;
}
export function externalCatalogSchemaMismatch(
  schema: CatalogJsonObject,
  value: CatalogJsonValue,
): CatalogSchemaMismatch | undefined {
  const validate = validationFor(schema);
  if (validate(value)) return undefined;
  return mismatchDetail(schema, validate.errors ?? []);
}
function missingRequired(error: ErrorObject | undefined, path: string): string | undefined {
  if (error?.keyword !== "required" || typeof error.params.missingProperty !== "string")
    return undefined;
  const property = error.params.missingProperty;
  return path === "$" ? property : `${path}.${property}`;
}
const MAX_CHOICE_BRANCHES = 8;
const MAX_ALLOWED_VALUES = 8;
const MAX_ALLOWED_STRING = 64;
type Allowed = NonNullable<CatalogSchemaMismatch["allowed"]>;
type Choice = NonNullable<CatalogSchemaMismatch["choice"]>;

function isObjectNode(
  node: CatalogJsonValue | undefined,
): node is Readonly<Record<string, CatalogJsonValue>> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}
function schemaAt(root: CatalogJsonValue, schemaPath: string): CatalogJsonValue | undefined {
  if (!schemaPath.startsWith("#/")) return undefined;
  let node: CatalogJsonValue | undefined = root;
  for (const segment of schemaPath.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) node = (node as readonly CatalogJsonValue[])[Number(key)];
    else if (isObjectNode(node)) node = Object.hasOwn(node, key) ? node[key] : undefined;
    else return undefined;
  }
  return node;
}
function branchRequirements(branch: CatalogJsonValue | undefined): readonly string[] | undefined {
  if (!isObjectNode(branch)) return undefined;
  const required = branch.required;
  return Array.isArray(required) &&
    required.length > 0 &&
    required.every((name) => typeof name === "string")
    ? required
    : undefined;
}
/** Keywords inside a branch that say the choice itself, not a value, is what failed. */
const CHOICE_SHAPE_KEYWORDS = new Set(["required", "additionalProperties", "not"]);
/**
 * Whether the first error is the choice failing: the `oneOf`/`anyOf` error itself, or a missing,
 * undeclared or excluded property inside one of its branches. An invalid VALUE inside a branch
 * (a type, constant, length) is the failure there, and the first error already names its path.
 */
function choiceIsTheFailure(first: ErrorObject | undefined, choice: ErrorObject): boolean {
  if (first === undefined || first === choice) return true;
  return (
    first.schemaPath.startsWith(`${choice.schemaPath}/`) && CHOICE_SHAPE_KEYWORDS.has(first.keyword)
  );
}
/** The top-level alternatives of a failed `oneOf`/`anyOf`, only when every branch names its properties. */
function choiceOf(schema: CatalogJsonObject, errors: readonly ErrorObject[]): Choice | undefined {
  const error = errors.find(
    (entry) =>
      (entry.keyword === "oneOf" || entry.keyword === "anyOf") && entry.instancePath === "",
  );
  const branches = error === undefined ? undefined : schemaAt(schema, error.schemaPath);
  if (error === undefined || !Array.isArray(branches) || branches.length > MAX_CHOICE_BRANCHES)
    return undefined;
  if (!choiceIsTheFailure(errors[0], error)) return undefined;
  const alternatives = branches.map((branch) => branchRequirements(branch as CatalogJsonValue));
  if (alternatives.length === 0 || alternatives.includes(undefined)) return undefined;
  return {
    kind: error.keyword === "oneOf" ? "exactly-one" : "at-least-one",
    alternatives: alternatives as readonly (readonly string[])[],
  };
}
/** The schema's own constant or enumerated values for the failing property. */
function allowedOf(error: ErrorObject | undefined, path: string): Allowed | undefined {
  if (error?.keyword !== "const" && error?.keyword !== "enum") return undefined;
  const declared: unknown =
    error.keyword === "const" ? [error.params.allowedValue] : error.params.allowedValues;
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > MAX_ALLOWED_VALUES)
    return undefined;
  const values = declared.filter(
    (entry): entry is string | number | boolean | null =>
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "number" ||
      (typeof entry === "string" && entry.length <= MAX_ALLOWED_STRING),
  );
  return values.length === declared.length ? { path, values } : undefined;
}
const MAX_DECLARED_PROPERTIES = 16;
/** Root property names of a closed schema; nested closed objects are not named. */
function declaredOf(schema: CatalogJsonObject, error: ErrorObject | undefined): readonly string[] {
  if (error?.keyword !== "additionalProperties" || error.instancePath !== "") return [];
  const properties = schema.properties;
  if (!isObjectNode(properties)) return [];
  const names = Object.keys(properties);
  return names.length <= MAX_DECLARED_PROPERTIES ? names : [];
}
function mismatchDetail(
  schema: CatalogJsonObject,
  errors: readonly ErrorObject[],
): CatalogSchemaMismatch {
  const error = errors[0];
  const path = error === undefined ? "$" : declaredPath(error);
  const missing = missingRequired(error, path);
  const extra = error?.keyword === "additionalProperties";
  const choice = choiceOf(schema, errors);
  const allowed = allowedOf(error, path);
  const declared = declaredOf(schema, error);
  return {
    missingRequired: missing === undefined ? [] : [missing],
    invalidPaths: missing !== undefined || extra ? [] : [path],
    unexpectedPropertyCount: extra ? 1 : 0,
    droppedPathCount: 0,
    optionalProperties: true,
    ...(declared.length === 0 ? {} : { declaredProperties: declared }),
    ...(choice === undefined ? {} : { choice }),
    ...(allowed === undefined ? {} : { allowed }),
  };
}
