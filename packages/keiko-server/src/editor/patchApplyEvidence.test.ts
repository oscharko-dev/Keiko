// Issue #1204 — patch-apply evidence is content-free, distinguishes apply vs verification phases, and
// links them to the proposal by the shared patchId (AC4/AC13).

import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EditorPatchVerificationSummary } from "@oscharko-dev/keiko-contracts";
import { recordPatchApplyEvidence, recordPatchVerificationEvidence } from "./patchApplyEvidence.js";

const identity = (value: unknown): unknown => value;

function summary(): EditorPatchVerificationSummary {
  return {
    outcome: "passed",
    networkEnforced: true,
    sandboxBackend: "bubblewrap",
    stepCount: 1,
    passed: 1,
    failed: 0,
    durationMs: 12,
    bounds: { wallTimeMs: 120_000, maxOutputBytes: 1_048_576, envAllowlistCount: 14 },
    preApply: false,
    secretsRedacted: true,
  };
}

describe("recordPatchApplyEvidence", () => {
  it("writes a content-free apply record correlated by patchId", () => {
    const store = createInMemoryEvidenceStore();
    const runId = recordPatchApplyEvidence(
      store,
      identity,
      {
        patchId: "p-1",
        decision: "apply",
        status: "applied",
        applied: true,
        counts: { changedFiles: 1, created: 1, deleted: 0 },
        allowOverwrite: false,
      },
      1_000,
    );
    expect(runId).toContain("editor-patch-apply-");
    const record = JSON.parse(store.get(runId) ?? "{}") as Record<string, unknown>;
    expect(record.phase).toBe("apply");
    expect(record.patchId).toBe("p-1");
    expect(record.applied).toBe(true);
    expect(record.created).toBe(1);
    // Content-free: no diff text, no file paths.
    const json = store.get(runId) ?? "";
    expect(json).not.toContain("src/");
  });

  it("records rejection reasons as enums only (no paths)", () => {
    const store = createInMemoryEvidenceStore();
    const runId = recordPatchApplyEvidence(
      store,
      identity,
      {
        patchId: "p-2",
        decision: "apply",
        status: "conflict",
        applied: false,
        rejections: [{ reason: "out-of-scope", path: "../../etc/passwd", detail: "escapes" }],
        allowOverwrite: false,
      },
      1_000,
    );
    const json = store.get(runId) ?? "";
    expect(json).toContain("out-of-scope");
    expect(json).not.toContain("etc/passwd");
  });
});

describe("recordPatchVerificationEvidence", () => {
  it("states command, hashed root, timeout, env allowlist, network status, redaction, and pre/post-apply", () => {
    const store = createInMemoryEvidenceStore();
    const runId = recordPatchVerificationEvidence(
      store,
      identity,
      {
        patchId: "p-1",
        rootRealPath: "/Users/dev/secret-project",
        command: "npx vitest run",
        summary: summary(),
      },
      2_000,
    );
    expect(runId).toContain("editor-patch-verification-");
    const record = JSON.parse(store.get(runId) ?? "{}") as Record<string, unknown>;
    expect(record.phase).toBe("verification");
    expect(record.patchId).toBe("p-1");
    expect(record.command).toBe("npx vitest run");
    expect(record.networkStatus).toBe("enforced-none");
    expect(record.sandboxBackend).toBe("bubblewrap");
    expect(record.timeoutMs).toBe(120_000);
    expect(record.envAllowlistCount).toBe(14);
    expect(record.secretsRedacted).toBe(true);
    expect(record.preApply).toBe(false);
    // The root is hashed, never recorded verbatim.
    const json = store.get(runId) ?? "";
    expect(json).not.toContain("secret-project");
    expect(typeof record.rootHash).toBe("string");
  });

  it("links apply and verification by sharing the same patchId across both phase records", () => {
    const store = createInMemoryEvidenceStore();
    const applyId = recordPatchApplyEvidence(
      store,
      identity,
      {
        patchId: "corr-9",
        decision: "apply",
        status: "applied",
        applied: true,
        allowOverwrite: false,
      },
      1_000,
    );
    const verifyId = recordPatchVerificationEvidence(
      store,
      identity,
      { patchId: "corr-9", rootRealPath: "/r", command: "npx vitest run", summary: summary() },
      1_000,
    );
    expect(applyId).not.toBe(verifyId);
    const apply = JSON.parse(store.get(applyId) ?? "{}") as Record<string, unknown>;
    const verify = JSON.parse(store.get(verifyId) ?? "{}") as Record<string, unknown>;
    expect(apply.patchId).toBe(verify.patchId);
  });
});
