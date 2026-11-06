import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

/** Shared SDK and native timer bounds; progress can never extend the total invocation grant. */
export function mcpRequestTimeouts(maxDurationMs: number): {
  readonly timeout: number;
  readonly maxTotalTimeout: number;
} {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0)
    throw new RangeError("Invalid MCP invocation duration");
  const timeout = Math.min(maxDurationMs, TOOL_CATALOG_LIMITS.maxDurationMs);
  return { timeout, maxTotalTimeout: timeout };
}
