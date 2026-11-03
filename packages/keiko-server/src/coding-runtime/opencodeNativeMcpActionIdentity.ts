import { randomBytes } from "node:crypto";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { captureCatalogJson, ToolCatalogError } from "@oscharko-dev/keiko-tool-catalog";

interface NativeMcpActionIdentity {
  readonly mcpInput?: Readonly<Record<string, unknown>>;
  readonly mcpActionDigest?: string;
}

/**
 * One server-owned identity per received MCP permission check. OpenCode exposes the enclosing
 * Code Mode call id for every inner action; even identical physical reads must spend separately.
 * The detached request retains this private identity through approval and relay revalidation.
 * No incoming digest/nonce is accepted, and neither arguments nor their digest become evidence.
 */
export function parseNativeMcpAction(permission: string, value: unknown): NativeMcpActionIdentity {
  if (value === undefined) return {};
  try {
    const input = captureCatalogJson(value, TOOL_CATALOG_LIMITS.maxArgumentBytes);
    if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
    const argumentsDigest = sha256Hex(canonicalise(input));
    return {
      mcpInput: input as CatalogJsonObject,
      mcpActionDigest: sha256Hex(
        canonicalise([randomBytes(32).toString("hex"), permission, argumentsDigest]),
      ),
    };
  } catch (error) {
    if (!(error instanceof ToolCatalogError)) throw error;
    // The native policy owner refuses a known MCP action without this identity and records the
    // existing body-free authority-refused outcome, before human approval or budget admission.
    return {};
  }
}
