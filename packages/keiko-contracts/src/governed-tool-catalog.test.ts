import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_ACTION_MAX_BODY_BYTES,
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
} from "./editor-agent.js";
import {
  CHANGESET_EDIT_ARGUMENT_LIMITS,
  GENERIC_TOOL_ARGUMENT_LIMITS,
  GOVERNED_CHANGESET_EDIT_TOOL_ID,
  TOOL_CATALOG_LIMITS,
  TOOL_PAGE_REASONS,
  TOOL_RESULT_REASONS,
  toolArgumentLimits,
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

describe("governed catalog per-tool argument ceilings (owner decision 2026-10-28)", () => {
  it("lets one changeset edit string and one call carry the changeset cap, derived from it", () => {
    expect(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes).toBe(
      EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
    );
    expect(CHANGESET_EDIT_ARGUMENT_LIMITS.maxArgumentBytes).toBe(
      EDITOR_AGENT_ACTION_MAX_BODY_BYTES,
    );
    // Room for the old and the new text of a cap-sized changeset plus escaping and envelope.
    expect(CHANGESET_EDIT_ARGUMENT_LIMITS.maxArgumentBytes).toBeGreaterThan(
      2 * CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes,
    );
    expect(Object.isFrozen(CHANGESET_EDIT_ARGUMENT_LIMITS)).toBe(true);
  });

  it("keeps the generic ceilings for every other tool", () => {
    expect(GENERIC_TOOL_ARGUMENT_LIMITS).toEqual({
      maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
      maxStringBytes: TOOL_CATALOG_LIMITS.maxStringBytes,
    });
    expect(toolArgumentLimits(GOVERNED_CHANGESET_EDIT_TOOL_ID)).toBe(
      CHANGESET_EDIT_ARGUMENT_LIMITS,
    );
    for (const id of ["keiko.workspace.read", "keiko.git.commit", "", "keiko.changeset.edit2"])
      expect(toolArgumentLimits(id)).toBe(GENERIC_TOOL_ARGUMENT_LIMITS);
  });
});
