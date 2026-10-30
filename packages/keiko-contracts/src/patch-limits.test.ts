// #4110 (owner decision 2026-10-29): every patch path is bounded by the ONE governed patch cap.
// Each derived default is compared with the producer's constant, never with a restated number, so a
// path that grows its own literal again fails here.

import { describe, expect, it } from "vitest";
import { DEFAULT_BUG_WORKFLOW_LIMITS } from "./bug-investigation-events.js";
import {
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
  EDITOR_AGENT_CHANGESET_PATCH_LIMITS,
} from "./editor-agent.js";
import { DEFAULT_LIMITS } from "./harness.js";
import { GOVERNED_PATCH_MAX_BYTES } from "./patch-limits.js";
import { DEFAULT_PATCH_LIMITS, DEFAULT_TOOL_HOST_CONFIG } from "./tools.js";
import { DEFAULT_PATCH_SCOPE_LIMITS } from "./workflow-handoff.js";

describe("GOVERNED_PATCH_MAX_BYTES (#4110)", () => {
  it("is the per-patch byte bound of every patch path", () => {
    expect(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES).toBe(GOVERNED_PATCH_MAX_BYTES);
    expect(EDITOR_AGENT_CHANGESET_PATCH_LIMITS.maxPatchBytes).toBe(GOVERNED_PATCH_MAX_BYTES);
    expect(DEFAULT_PATCH_LIMITS.maxPatchBytes).toBe(GOVERNED_PATCH_MAX_BYTES);
    expect(DEFAULT_TOOL_HOST_CONFIG.patchLimits.maxPatchBytes).toBe(GOVERNED_PATCH_MAX_BYTES);
    expect(DEFAULT_LIMITS.maxPatchBytes).toBe(GOVERNED_PATCH_MAX_BYTES);
    expect(DEFAULT_BUG_WORKFLOW_LIMITS.maxPatchBytes).toBe(GOVERNED_PATCH_MAX_BYTES);
    expect(DEFAULT_PATCH_SCOPE_LIMITS.maxPatchBytes).toBe(GOVERNED_PATCH_MAX_BYTES);
  });

  it("changes no other limit of those defaults", () => {
    expect(DEFAULT_PATCH_LIMITS).toMatchObject({ maxChangedLines: 2_000, maxFilesChanged: 50 });
    expect(DEFAULT_BUG_WORKFLOW_LIMITS).toMatchObject({
      contextBudgetBytes: 65_536,
      maxFilesChanged: 10,
      maxChangedLines: 300,
    });
    expect(DEFAULT_LIMITS).toMatchObject({ maxContextBytes: 512_000, maxWallTimeMs: 300_000 });
    expect(DEFAULT_PATCH_SCOPE_LIMITS).toMatchObject({ maxFileCount: 16, maxNewFiles: 4 });
  });
});
