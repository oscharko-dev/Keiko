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
  const parts: string[] = [];
  if (shape.missingRequired.length > 0) {
    parts.push(
      ` Missing required properties: ${shape.missingRequired.join(", ")}. Every property the schema declares is required; pass an explicit value such as false or [] when a property does not apply.`,
    );
  }
  if (shape.invalidPaths.length > 0) {
    parts.push(
      ` Properties whose value does not match the schema: ${shape.invalidPaths.join(", ")}.`,
    );
  }
  if (shape.unexpectedPropertyCount > 0) {
    const plural = shape.unexpectedPropertyCount === 1 ? "property is" : "properties are";
    parts.push(
      ` ${String(shape.unexpectedPropertyCount)} ${plural} not declared by the schema and must be removed.`,
    );
  }
  if (shape.droppedPathCount > 0) {
    parts.push(
      ` ${String(shape.droppedPathCount)} further mismatching ${shape.droppedPathCount === 1 ? "property is" : "properties are"} not listed; check every remaining property against the schema.`,
    );
  }
  return parts.join("");
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
