import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorPatchApplyWireResponse, EditorPatchVerificationSummary } from "./types";
import { requestEditorPatchApply } from "./api";
import {
  buildPatchApplyInput,
  buildRevertApplyInput,
  mapWireToPatchApplyView,
} from "./editor-patch-apply";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function summary(
  overrides: Partial<EditorPatchVerificationSummary> = {},
): EditorPatchVerificationSummary {
  return {
    outcome: "passed",
    networkEnforced: true,
    sandboxBackend: "bubblewrap",
    stepCount: 1,
    passed: 1,
    failed: 0,
    durationMs: 5,
    bounds: { wallTimeMs: 120_000, maxOutputBytes: 1_048_576, envAllowlistCount: 14 },
    preApply: false,
    secretsRedacted: true,
    ...overrides,
  };
}

function applied(
  overrides: Partial<EditorPatchApplyWireResponse> = {},
): EditorPatchApplyWireResponse {
  return {
    schemaVersion: "1",
    status: "applied",
    patchId: "p1",
    applied: { changedFiles: 1, created: 1, deleted: 0 },
    verification: summary(),
    evidence: { applyRunId: "a", verificationRunId: "v" },
    ...overrides,
  };
}

describe("mapWireToPatchApplyView", () => {
  it("maps an applied + verified response to a success tone", () => {
    const view = mapWireToPatchApplyView(applied());
    expect(view.status).toBe("applied");
    expect(view.tone).toBe("success");
    expect(view.applied).toEqual({ changedFiles: 1, created: 1, deleted: 0 });
    expect(view.verification?.outcome).toBe("passed");
    expect(view.verification?.networkEnforced).toBe(true);
    expect(view.revert).toBeUndefined();
  });

  it("maps a failed verification to a warning tone and surfaces the revert proposal", () => {
    const view = mapWireToPatchApplyView(
      applied({
        verification: summary({ outcome: "failed", passed: 0, failed: 1 }),
        revertProposal: {
          patchId: "p1",
          diff: "REVERT",
          changedFiles: ["src/a.test.ts"],
          reason: "x",
        },
      }),
    );
    expect(view.tone).toBe("warning");
    expect(view.verification?.outcome).toBe("failed");
    expect(view.revert?.diff).toBe("REVERT");
    expect(view.headline).toContain("revert");
  });

  it("maps a denied verification to a warning tone without a revert", () => {
    const view = mapWireToPatchApplyView(
      applied({ verification: summary({ outcome: "denied", networkEnforced: false }) }),
    );
    expect(view.tone).toBe("warning");
    expect(view.revert).toBeUndefined();
  });

  it("maps a conflict to an error tone with the first rejection reason", () => {
    const view = mapWireToPatchApplyView({
      schemaVersion: "1",
      status: "conflict",
      patchId: "p1",
      rejections: [{ reason: "would-overwrite", path: "src/a.test.ts", detail: "exists" }],
    });
    expect(view.tone).toBe("error");
    expect(view.headline).toContain("overwrite");
    expect(view.rejections).toHaveLength(1);
  });

  it("maps rejected / disabled / failed statuses", () => {
    expect(
      mapWireToPatchApplyView({ schemaVersion: "1", status: "rejected", patchId: "p" }).tone,
    ).toBe("info");
    expect(
      mapWireToPatchApplyView({ schemaVersion: "1", status: "disabled", patchId: "p" }).tone,
    ).toBe("info");
    expect(
      mapWireToPatchApplyView({ schemaVersion: "1", status: "failed", patchId: "p" }).tone,
    ).toBe("error");
  });
});

describe("requestEditorPatchApply", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the decision to the patch-apply route with the CSRF header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ schemaVersion: "1", status: "disabled", patchId: "p1", reason: "off" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const response = await requestEditorPatchApply({
      root: "/repo",
      patchId: "p1",
      decision: "apply",
      diff: "DIFF",
      verify: false,
    });
    expect(response.status).toBe("disabled");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/patch-apply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });
});

describe("buildPatchApplyInput / buildRevertApplyInput", () => {
  it("builds an apply request from a reviewed candidate's diff", () => {
    const input = buildPatchApplyInput("/repo", "p1", "DIFF", "apply", { verify: false });
    expect(input).toEqual({
      root: "/repo",
      patchId: "p1",
      decision: "apply",
      diff: "DIFF",
      verify: false,
    });
  });

  it("omits absent optional fields", () => {
    const input = buildPatchApplyInput("/repo", "p1", "DIFF", "reject");
    expect("allowOverwrite" in input).toBe(false);
    expect("verify" in input).toBe(false);
  });

  it("builds a revert re-apply request from a guarded revert proposal", () => {
    const input = buildRevertApplyInput("/repo", {
      patchId: "p1",
      diff: "REVERT",
      changedFiles: ["src/a.test.ts"],
      reason: "x",
    });
    expect(input).toEqual({ root: "/repo", patchId: "p1", decision: "apply", diff: "REVERT" });
  });
});
