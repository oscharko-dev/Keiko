import { describe, expect, it } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { mcpRequestTimeouts } from "./request-timeouts.js";

describe("MCP request timeout bounds", () => {
  it("retains long declared calls and applies one total bound to both SDK timers", () => {
    expect(mcpRequestTimeouts(3_000_000)).toEqual({
      timeout: 3_000_000,
      maxTotalTimeout: 3_000_000,
    });
  });
  it("clamps oversized durations before native or SDK timers can overflow", () => {
    expect(mcpRequestTimeouts(Number.MAX_SAFE_INTEGER)).toEqual({
      timeout: TOOL_CATALOG_LIMITS.maxDurationMs,
      maxTotalTimeout: TOOL_CATALOG_LIMITS.maxDurationMs,
    });
  });
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid duration %s",
    (duration) => {
      expect(() => mcpRequestTimeouts(duration)).toThrow(RangeError);
    },
  );
});
