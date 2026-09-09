import type {
  ToolDescriptor,
  ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  compileToolProjection,
  createInitialToolCatalog,
  lookupCatalogTool,
  validateToolArguments,
} from "@oscharko-dev/keiko-tool-catalog";
import { ToolArgumentError, UnknownToolError } from "./errors.js";

const catalog = createInitialToolCatalog();
const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });

export function workspaceToolDescriptor(alias: string): ToolDescriptor {
  const projected = projection.tools.find((tool) => tool.alias === alias);
  const descriptor =
    projected === undefined ? undefined : lookupCatalogTool(catalog, projected.toolRef);
  if (descriptor === undefined) throw new UnknownToolError("Unknown workspace tool", alias);
  return descriptor;
}

export function workspaceToolAlias(ref: ToolRef): string {
  const projected = projection.tools.find(
    (tool) =>
      tool.toolRef.canonicalId === ref.canonicalId &&
      tool.toolRef.contractVersion === ref.contractVersion,
  );
  if (projected === undefined)
    throw new UnknownToolError("Unknown workspace tool identity", ref.canonicalId);
  return projected.alias;
}

/** A handler boundary, not execution authority. The binder owns admission and settlement. */
export function captureWorkspaceToolArguments(
  alias: string,
  input: unknown,
): Record<string, unknown> {
  const descriptor = workspaceToolDescriptor(alias);
  try {
    const captured = validateToolArguments(input, descriptor);
    if (typeof captured !== "object" || captured === null || Array.isArray(captured))
      throw new TypeError("Workspace tool requires object arguments");
    return captured as Record<string, unknown>;
  } catch {
    throw new ToolArgumentError(
      "Arguments do not match the canonical workspace tool contract",
      alias,
    );
  }
}
