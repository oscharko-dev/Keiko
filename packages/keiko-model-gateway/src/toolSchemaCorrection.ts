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
   * The offered tool's own input schema, so the correction can add the description its author gave
   * each listed property. Never the rejected arguments.
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
  const choice = choiceGuidance(shape);
  return [
    choice === "" || !choiceCoversMissing(shape) ? missingGuidance(shape) : "",
    choice,
    invalidGuidance(shape),
    expectedGuidance(shape),
    describedGuidance(shape, repair?.schema),
    countGuidance(shape),
  ].join("");
}

/** The ceiling of the sentence that states each rejected property's rule (the Jira result-guidance bound). */
const EXPECTED_GUIDANCE_CHARS_MAX = 1280;
/**
 * What the schema states at each rejected or missing property, in one sentence of one form for
 * every tool ("path must be a string in uri format, 1 to 255 characters"). The rules come from the
 * tool's own schema, never from the arguments, so the correction says what to send without
 * quoting what was sent. A property whose allowed values the sentence above already names is not
 * repeated.
 */
/** The sentence, the properties it states and how many were left out (here or by the schema owner). */
export interface StatedExpectations {
  readonly text: string;
  readonly statedCount: number;
  readonly omittedCount: number;
}
export function statedExpectations(shape: CatalogSchemaMismatch): StatedExpectations {
  const entries = (shape.expected ?? []).filter((entry) => entry.path !== shape.allowed?.path);
  const kept: string[] = [];
  let chars = " Expected: .".length;
  for (const entry of entries) {
    const text = `${entry.path} must be ${entry.rule}`;
    chars += text.length + 2;
    if (chars > EXPECTED_GUIDANCE_CHARS_MAX) break;
    kept.push(text);
  }
  return {
    text: kept.length === 0 ? "" : ` Expected: ${kept.join("; ")}.`,
    statedCount: kept.length,
    omittedCount: entries.length - kept.length + (shape.expectedOmittedCount ?? 0),
  };
}
function expectedGuidance(shape: CatalogSchemaMismatch): string {
  return statedExpectations(shape).text;
}

function missingGuidance(shape: CatalogSchemaMismatch): string {
  if (shape.missingRequired.length === 0) return "";
  // The managed-runtime dialect requires every declared property. An external JSON Schema does
  // not, and telling a model to pass `false` there produced values its own schema refuses.
  const rule =
    shape.optionalProperties === true
      ? ""
      : " Every property the schema declares is required; pass an explicit value such as false or [] when a property does not apply.";
  return ` Missing required properties: ${shape.missingRequired.join(", ")}.${rule}`;
}

function invalidGuidance(shape: CatalogSchemaMismatch): string {
  if (shape.invalidPaths.length === 0) return "";
  const allowed =
    shape.allowed === undefined
      ? ""
      : ` The value of ${shape.allowed.path} must be one of: ${shape.allowed.values.map((value) => JSON.stringify(value)).join(", ")}.`;
  return ` Properties whose value does not match the schema: ${shape.invalidPaths.join(", ")}.${allowed}`;
}

/** What the schema does declare, so removing the stray property does not invite another one. */
function declaredSuffix(shape: CatalogSchemaMismatch): string {
  const declared = shape.declaredProperties;
  return declared === undefined || declared.length === 0
    ? ""
    : `; it declares only: ${declared.join(", ")}`;
}

function countGuidance(shape: CatalogSchemaMismatch): string {
  const parts: string[] = [];
  if (shape.unexpectedPropertyCount > 0) {
    const plural = shape.unexpectedPropertyCount === 1 ? "property is" : "properties are";
    parts.push(
      ` ${String(shape.unexpectedPropertyCount)} ${plural} not declared by the schema and must be removed${declaredSuffix(shape)}.`,
    );
  }
  if (shape.droppedPathCount > 0) {
    parts.push(
      ` ${String(shape.droppedPathCount)} further mismatching ${shape.droppedPathCount === 1 ? "property is" : "properties are"} not listed; check every remaining property against the schema.`,
    );
  }
  return parts.join("");
}

// #4130 seeds (2026-11-09): a local Reviewer left out the top-level `file` of `keiko_review_report`
// whenever its evidence entries named the file, and a correction that listed only the name did not
// stop it. The description the schema's author gave a listed property now reaches the model at the
// moment it got that property wrong. The property's type and bounds are stated by the rule sentence
// above (`statedExpectations`); this sentence adds only the description.
const SCHEMA_DESCRIPTION_MAX_CHARS = 240;

// R4130-045/046 (#4330 review): only Keiko's own closed-dialect schemas describe a path. An external
// schema (a managed MCP server's, which always declares its `$schema` dialect) is the server's own
// text: copying its descriptions into the gateway's system correction would hand server-authored
// instructions the gateway's voice. Its mismatch paths can also start inside a `$ref` target, where
// they do not resolve from the root. Such paths get no description.
function describableSchema(schema: CatalogJsonObject | undefined): CatalogJsonObject | undefined {
  return schema?.$schema === undefined ? schema : undefined;
}

function asSchemaObject(value: CatalogJsonValue | undefined): CatalogJsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as CatalogJsonObject)
    : undefined;
}

// Paths use the catalog walker's syntax: `.` between properties, `[]` for array items and `*` for
// additional properties (`evidence[].startLine`). A path the schema does not declare resolves to
// nothing, so an external dialect or the root marker `$` gets no description.
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

/** The description the schema gives the property at `path`, capped; `undefined` when it has none. */
function schemaPathDescription(
  schema: CatalogJsonObject | undefined,
  path: string,
): string | undefined {
  const description = schemaNodeAt(schema, path)?.description;
  const text = typeof description === "string" ? description.trim() : "";
  return text.length === 0
    ? undefined
    : Array.from(text).slice(0, SCHEMA_DESCRIPTION_MAX_CHARS).join("");
}

/** The listed paths the offered schema describes, each with its description. */
function describedPaths(
  shape: CatalogSchemaMismatch,
  offered: CatalogJsonObject | undefined,
): readonly string[] {
  const schema = describableSchema(offered);
  return [...shape.missingRequired, ...shape.invalidPaths].flatMap((path) => {
    const description = schemaPathDescription(schema, path);
    return description === undefined ? [] : [`${path}: ${description}`];
  });
}

function describedGuidance(
  shape: CatalogSchemaMismatch,
  offered: CatalogJsonObject | undefined,
): string {
  const described = describedPaths(shape, offered);
  return described.length === 0 ? "" : ` What the schema says: ${described.join(" ")}`;
}

/** How many of the listed paths the offered schema describes; counted on the repair line. */
export function describedSchemaPathCount(repair: GatewayToolCallRepair | undefined): number {
  const shape = repair?.shape;
  return shape === undefined ? 0 : describedPaths(shape, repair?.schema).length;
}

/** The rule of a failed `oneOf` or `anyOf`, in the schema's own property names. */
function choiceGuidance(shape: CatalogSchemaMismatch): string {
  const choice = shape.choice;
  if (choice === undefined) return "";
  const names = choice.alternatives.map((names) => names.join(" and ")).join(", ");
  return choice.kind === "exactly-one"
    ? ` Supply exactly one of: ${names}; omit the others.`
    : ` Supply at least one of: ${names}.`;
}

/** A missing property that is one alternative of the choice is not missing on its own. */
function choiceCoversMissing(shape: CatalogSchemaMismatch): boolean {
  const named = new Set(shape.choice?.alternatives.flat());
  return shape.missingRequired.every((path) => named.has(path));
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
