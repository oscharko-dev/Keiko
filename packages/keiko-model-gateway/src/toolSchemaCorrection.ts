import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { CatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";

/**
 * Body-free provider-call identity retained only for a bounded schema-correction retry, plus the
 * schema's own account of the mismatch (declared property names and counts, never the arguments) so
 * the correction can name what to fix.
 */
export interface GatewayToolCallRepair {
  readonly toolCallId: string;
  readonly offeredAlias: string;
  readonly shape?: CatalogSchemaMismatch | undefined;
  /**
   * The offered tool's own input schema, so the correction can describe each listed property from
   * its declaration (type, bounds, description). Never the rejected arguments.
   */
  readonly schema?: CatalogJsonObject | undefined;
  readonly transport?: "assistant-text" | undefined;
}

const TOOL_SCHEMA_REPAIR_PREFIX =
  "The previous tool call was rejected before execution because its arguments did not match the advertised schema.";
// What the model is told to fix, in the schema's vocabulary only (declared property paths and
// counts; the rejected arguments are never quoted back). A generic "match the schema" sentence left
// gpt-5.4 repeating the same omission until the retry budget was gone (run 7, 2026-09-10: three
// `keiko_repository_search` calls without the properties the dialect declares required).
// Module-level export (not part of the package surface) so the sentence for each branch of the
// account can be pinned directly: the real catalog offers no tool with more than sixteen distinct
// schema paths, so the "further properties not listed" branch is unreachable through a provider
// round trip today and stays a guard for a wider future schema (PR #3452 review).
export function schemaMismatchGuidance(repair: GatewayToolCallRepair | undefined): string {
  const shape = repair?.shape;
  if (shape === undefined) return "";
  const parts = [...pathGuidance(shape, repair?.schema), ...countGuidance(shape)];
  return parts.length === 0 ? "" : `\n${parts.join("\n")}`;
}

/** The listed paths, each described from the offered schema. */
function pathGuidance(
  shape: CatalogSchemaMismatch,
  schema: CatalogJsonObject | undefined,
): readonly string[] {
  const parts: string[] = [];
  if (shape.missingRequired.length > 0) {
    parts.push(
      `Missing required properties:${describedPaths(schema, shape.missingRequired)}`,
      "Every property the schema declares is required, also when another property already carries the same value. For a boolean or array property that does not apply, pass false or [].",
    );
  }
  if (shape.invalidPaths.length > 0) {
    parts.push(
      `Properties whose value does not match the schema:${describedPaths(schema, shape.invalidPaths)}`,
    );
  }
  return parts;
}

/** What the account counts but does not name: undeclared and unlisted properties. */
function countGuidance(shape: CatalogSchemaMismatch): readonly string[] {
  const parts: string[] = [];
  if (shape.unexpectedPropertyCount > 0) {
    const plural = shape.unexpectedPropertyCount === 1 ? "property is" : "properties are";
    parts.push(
      `${String(shape.unexpectedPropertyCount)} ${plural} not declared by the schema and must be removed.`,
    );
  }
  if (shape.droppedPathCount > 0) {
    parts.push(
      `${String(shape.droppedPathCount)} further mismatching ${shape.droppedPathCount === 1 ? "property is" : "properties are"} not listed; check every remaining property against the schema.`,
    );
  }
  return parts;
}

// #4130 seeds (2026-11-09): a local Reviewer left out the top-level `file` of `keiko_review_report`
// whenever its evidence entries named the file, and a correction that listed only the name did not
// stop it. Each listed path is now described from the offered schema's own declaration, so a
// property's description reaches the model at the moment it got that property wrong.
const SCHEMA_HINT_DESCRIPTION_MAX_CHARS = 240;

/** Each path on its own line, with what its schema node declares when the path resolves. */
function describedPaths(schema: CatalogJsonObject | undefined, paths: readonly string[]): string {
  return paths
    .map((path) => {
      const hint = schemaPathHint(schema, path);
      return hint === undefined ? `\n- ${path}` : `\n- ${path} ${hint}`;
    })
    .join("");
}

/** How many of the listed paths the offered schema describes; counted on the repair line. */
export function describedSchemaPathCount(repair: GatewayToolCallRepair | undefined): number {
  const shape = repair?.shape;
  if (shape === undefined) return 0;
  return [...shape.missingRequired, ...shape.invalidPaths].filter(
    (path) => schemaPathHint(repair?.schema, path) !== undefined,
  ).length;
}

function asSchemaObject(value: CatalogJsonValue | undefined): CatalogJsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as CatalogJsonObject)
    : undefined;
}

// Paths use the catalog walker's syntax: `.` between properties, `[]` for array items and `*` for
// additional properties (`evidence[].startLine`). A path the schema does not declare resolves to
// nothing, so an external dialect or the root marker `$` is listed by name only.
function schemaNodeAt(
  schema: CatalogJsonObject | undefined,
  path: string,
): CatalogJsonObject | undefined {
  let node = schema;
  for (const segment of path.split(".")) {
    const name = segment.replace(/(\[\])+$/u, "");
    node =
      name === "*"
        ? asSchemaObject(node?.additionalProperties)
        : asSchemaObject(asSchemaObject(node?.properties)?.[name]);
    for (let depth = (segment.length - name.length) / 2; depth > 0; depth -= 1) {
      node = asSchemaObject(node?.items);
    }
    if (node === undefined) return undefined;
  }
  return node;
}

function schemaPathHint(schema: CatalogJsonObject | undefined, path: string): string | undefined {
  const node = schemaNodeAt(schema, path);
  if (node === undefined) return undefined;
  const shape = schemaShapeHint(node);
  const description = typeof node.description === "string" ? node.description.trim() : "";
  if (description.length === 0) return shape === undefined ? undefined : `(${shape})`;
  const bounded = Array.from(description).slice(0, SCHEMA_HINT_DESCRIPTION_MAX_CHARS).join("");
  return `(${shape ?? "value"}): ${bounded}`;
}

function rangeHint(
  lower: CatalogJsonValue | undefined,
  upper: CatalogJsonValue | undefined,
): string {
  if (typeof lower === "number" && typeof upper === "number") {
    return `${String(lower)} to ${String(upper)}`;
  }
  if (typeof lower === "number") return `at least ${String(lower)}`;
  return typeof upper === "number" ? `at most ${String(upper)}` : "";
}

function schemaShapeHint(node: CatalogJsonObject): string | undefined {
  if (Array.isArray(node.enum)) {
    return `one of ${node.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  const type = typeof node.type === "string" ? node.type : undefined;
  if (type === "array") {
    const items = rangeHint(node.minItems, node.maxItems);
    return items === "" ? "array" : `array of ${items} items`;
  }
  if (type === "integer" || type === "number") {
    const range = rangeHint(node.minimum, node.maximum);
    return range === "" ? type : `${type}, ${range}`;
  }
  return type;
}

/** The one correction a rejected tool call gets, in the schema's vocabulary only. */
export function toolSchemaCorrectionMessage(
  repair: GatewayToolCallRepair | undefined,
): string | undefined {
  if (repair === undefined) return undefined;
  if (repair.transport === "assistant-text") {
    return `${TOOL_SCHEMA_REPAIR_PREFIX} The previous answer serialized a tool invocation as assistant text, which executes no tool. Call offered tool ${repair.offeredAlias} through native function tool_calls with JSON arguments matching its advertised schema. Do not write model transport markers or a tool invocation in answer text.`;
  }
  return `${TOOL_SCHEMA_REPAIR_PREFIX} Retry tool call ${repair.toolCallId} for offered tool ${repair.offeredAlias} with arguments that match its advertised schema exactly.${schemaMismatchGuidance(repair)}`;
}
