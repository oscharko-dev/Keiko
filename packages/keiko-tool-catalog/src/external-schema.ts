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
const VALIDATORS = new Map<string, ValidateFunction>();
function validationFor(schema: CatalogJsonObject): ValidateFunction {
  requireCatalog(isBoundedExternalJsonSchema(schema), "unsupported-schema");
  const identity = canonicalise(schema);
  const cached = VALIDATORS.get(identity);
  if (cached !== undefined) return cached;
  try {
    const validator = compiler(schema.$schema);
    const validate = validator.compile(schema);
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
  return mismatchDetail(validate.errors?.[0]);
}
function missingRequired(error: ErrorObject | undefined, path: string): string | undefined {
  if (error?.keyword !== "required" || typeof error.params.missingProperty !== "string")
    return undefined;
  const property = error.params.missingProperty;
  return path === "$" ? property : `${path}.${property}`;
}
function mismatchDetail(error: ErrorObject | undefined): CatalogSchemaMismatch {
  const path = error === undefined ? "$" : declaredPath(error);
  const missing = missingRequired(error, path);
  const extra = error?.keyword === "additionalProperties";
  return {
    missingRequired: missing === undefined ? [] : [missing],
    invalidPaths: missing !== undefined || extra ? [] : [path],
    unexpectedPropertyCount: extra ? 1 : 0,
    droppedPathCount: 0,
  };
}
