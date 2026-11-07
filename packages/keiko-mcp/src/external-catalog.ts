import type { Tool } from "@modelcontextprotocol/client";
import type { ExternalMcpTool } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { boundedDescription, MAX_TOOL_DESCRIPTION_BYTES, ManagedMcpError } from "./definitions.js";

/** Retain the object-root types established by the SDK tools/list parser across JSON capture. */
export type AdmittedTool = ExternalMcpTool & Pick<Tool, "inputSchema" | "outputSchema">;

export const MAX_ADMITTED_TOOLS = 64;
/** The admitted catalog is held to 1 MiB after narrowing. */
const MAX_CATALOG_BYTES = 1024 * 1024;
/** All descriptions of one catalog together; each is also cut to its own bound. */
const DESCRIPTION_BUDGET_BYTES = 128 * 1024;

export interface AdmittedCatalog {
  readonly tools: readonly AdmittedTool[];
  readonly digest: string;
  /** Tools the server offers that the registry did not allow; never forwarded. */
  readonly omitted: number;
  /** Descriptions cut to their bound; the cut text is never recorded. */
  readonly truncated: number;
}

export function captured<T>(value: T, maxBytes: number): T {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new ManagedMcpError("protocol-error");
  return deepFreeze(JSON.parse(text) as T);
}

function boundDescriptions(tools: readonly Tool[]): { tools: Tool[]; truncated: number } {
  let remaining = DESCRIPTION_BUDGET_BYTES;
  let truncated = 0;
  const bounded = tools.map((tool) => {
    if (tool.description === undefined) return tool;
    const limit = Math.min(MAX_TOOL_DESCRIPTION_BYTES, remaining);
    const text = boundedDescription(tool.description, limit);
    remaining -= Buffer.byteLength(text, "utf8");
    if (text === tool.description) return tool;
    truncated++;
    return { ...tool, description: text };
  });
  return { tools: bounded, truncated };
}

function schemasBounded(tool: Tool): boolean {
  return (
    isBoundedExternalJsonSchema(tool.inputSchema) &&
    (tool.outputSchema === undefined || isBoundedExternalJsonSchema(tool.outputSchema))
  );
}

/**
 * Narrow a listing to the tools the registry allows, bound every description, and fingerprint the
 * result. A server with hundreds of tools is narrowed instead of refused; the count that matters is
 * the admitted one.
 */
export function admitCatalog(
  listed: readonly Tool[],
  allowed: ReadonlySet<string> | undefined,
): AdmittedCatalog {
  if (new Set(listed.map((tool) => tool.name)).size !== listed.length)
    throw new ManagedMcpError("descriptor-drift");
  const kept = allowed === undefined ? listed : listed.filter((tool) => allowed.has(tool.name));
  if (kept.length > MAX_ADMITTED_TOOLS) throw new ManagedMcpError("descriptor-drift");
  if (!kept.every(schemasBounded)) throw new ManagedMcpError("protocol-error");
  const { tools: bounded, truncated } = boundDescriptions(kept);
  const tools = captured(bounded, MAX_CATALOG_BYTES) as readonly AdmittedTool[];
  return {
    tools,
    digest: sha256Hex(canonicalise(tools)),
    omitted: listed.length - kept.length,
    truncated,
  };
}

/** Cheap change detector for a raw listing; equal means unchanged, unequal means "compare fully". */
export function listingFingerprint(listed: readonly Tool[]): string {
  return sha256Hex(JSON.stringify(listed));
}
