import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  TOOL_PAGE_REASONS,
  TOOL_RESULT_REASONS,
} from "./governed-tool-catalog.js";

describe("governed catalog frozen generic vocabulary", () => {
  it("retains the accepted architecture bounds and exact terminal vocabulary", () => {
    const architecture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../docs/architecture/governed-tool-contract.v1.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { bounds: Record<string, number>; statuses: Record<string, readonly string[]> };
    for (const [key, value] of Object.entries(TOOL_CATALOG_LIMITS))
      expect(value).toBe(architecture.bounds[key]);
    expect(TOOL_RESULT_REASONS).toEqual(architecture.statuses);
    expect(Object.keys(TOOL_RESULT_REASONS)).toEqual([
      "completed",
      "denied",
      "invalid",
      "busy",
      "cancelled",
      "timeout",
      "failed",
    ]);
  });
  it("freezes the constants and nested reason lists", () => {
    expect(Reflect.set(TOOL_CATALOG_LIMITS, "maxResultBytes", 999999)).toBe(false);
    expect(Reflect.set(TOOL_RESULT_REASONS.invalid, "0", "approval-bypass")).toBe(false);
    expect(Reflect.set(TOOL_PAGE_REASONS, "0", "private-text")).toBe(false);
  });
});
