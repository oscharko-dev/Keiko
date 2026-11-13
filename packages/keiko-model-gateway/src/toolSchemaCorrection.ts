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
    countGuidance(shape),
  ].join("");
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
