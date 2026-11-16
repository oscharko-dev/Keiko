import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { CatalogHandlerResult } from "../tool-catalog/catalogToolPorts.js";

/** One result projection shared by Chat and retained Coding Jira observations. */
export function jiraCatalogResult(data: CatalogJsonObject): CatalogHandlerResult {
  const truncated = typeof data.nextStartAt === "number" || typeof data.nextCursor === "string";
  return {
    data,
    page: { truncated, reason: truncated ? "result-cap" : "none", cursor: null },
    resultCount: Array.isArray(data.items) ? data.items.length : 0,
  };
}
