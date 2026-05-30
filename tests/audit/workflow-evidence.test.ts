import { describe, expect, it } from "vitest";
import { buildWorkflowManifest, type WorkflowRunIdentity } from "../../src/audit/index.js";
import type { VerificationAuditSummary } from "../../src/verification/index.js";

const verification: VerificationAuditSummary = {
  workspaceRoot: "/repo",
  overallStatus: "passed",
  durationMs: 12,
  counts: {
    passed: 1,
    failed: 0,
    skipped: 0,
    denied: 0,
    "timed-out": 0,
    cancelled: 0,
    "resource-exceeded": 0,
  },
  results: [],
};

function identity(overrides: Partial<WorkflowRunIdentity> = {}): WorkflowRunIdentity {
  return {
    runId: "run-1",
    fingerprint: "fp",
    modelId: "Qwen2.5-Coder-7B-Instruct",
    kind: "unit-tests",
    status: "completed",
    startedAt: 10,
    finishedAt: 25,
    ...overrides,
  };
}

describe("buildWorkflowManifest", () => {
  it("marks a completed unit-test workflow patch as applied and preserves verification", () => {
    const manifest = buildWorkflowManifest(identity(), [], {
      workflowId: "unit-test-generation",
      status: "completed",
      proposedDiff: "--- /dev/null\n+++ b/tests/add.test.ts\n",
      addedTestFiles: [{ path: "tests/add.test.ts", estimatedTestCount: 1 }],
      verificationSummary: verification,
    });
    expect(manifest.patch).toMatchObject({
      proposed: true,
      applied: true,
      changedFiles: 1,
      targetFileCount: 1,
    });
    expect(manifest.verification?.overallStatus).toBe("passed");
  });

  it("preserves bug-investigation verification from verified.verification", () => {
    const manifest = buildWorkflowManifest(identity({ kind: "bug-investigation" }), [], {
      workflowId: "bug-investigation",
      status: "fix-applied",
      proposedDiff: "--- a/src/buggy.ts\n+++ b/src/buggy.ts\n",
      changedFiles: [{ path: "src/buggy.ts", kind: "modify" }],
      verified: {
        patchApplied: true,
        verification,
      },
    });
    expect(manifest.patch?.applied).toBe(true);
    expect(manifest.verification?.overallStatus).toBe("passed");
  });
});
