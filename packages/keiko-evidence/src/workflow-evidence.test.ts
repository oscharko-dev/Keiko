import { describe, expect, it } from "vitest";
import {
  buildWorkflowManifest,
  createInMemoryEvidenceStore,
  loadEvidence,
  persistWorkflowEvidence,
  type WorkflowEventLike,
  type WorkflowRunIdentity,
} from "./index.js";
import type { VerificationAuditSummary } from "@oscharko-dev/keiko-contracts";

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
    modelId: "example-chat-model-unstructured",
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

  it("folds bug-investigation model usage and workspace metadata", () => {
    const manifest = buildWorkflowManifest(
      identity({ kind: "bug-investigation", workspaceRoot: "/repo" }),
      [
        {
          type: "bug:model:call:completed",
          promptTokens: 3,
          completionTokens: 5,
          latencyMs: 7,
        } as unknown as WorkflowEventLike,
      ],
      { workflowId: "bug-investigation", status: "investigation-only" },
    );
    expect(manifest.usageTotals).toEqual({
      promptTokens: 3,
      completionTokens: 5,
      requestCount: 1,
      totalLatencyMs: 7,
    });
    expect(manifest.context?.workspaceRoot).toBe("/repo");
  });

  it("preserves governed grounded handoff provenance when provided", () => {
    const manifest = buildWorkflowManifest(
      identity(),
      [],
      {
        workflowId: "unit-test-generation",
        status: "dry-run",
        proposedDiff: "--- /dev/null\n+++ b/tests/add.test.ts\n",
        addedTestFiles: [{ path: "tests/add.test.ts", estimatedTestCount: 1 }],
      },
      undefined,
      {
        governedHandoff: {
          sourceGroundedRunId: "grounded-run-1",
          contextPackStableIdHash: "a".repeat(64),
          workflowKind: "unit-test-generation",
          editablePathCount: 1,
          readOnlyPathCount: 2,
          evidenceAtomCount: 3,
          expectedChecks: ["tests"],
          approvalTokenHash: "b".repeat(64),
        },
      },
    );
    expect(manifest.governedHandoff).toMatchObject({
      sourceGroundedRunId: "grounded-run-1",
      workflowKind: "unit-test-generation",
      editablePathCount: 1,
      expectedChecks: ["tests"],
    });
  });
});

describe("persistWorkflowEvidence", () => {
  it("returns an EvidenceReport and persists the redacted manifest", () => {
    const store = createInMemoryEvidenceStore();
    const literalSecret = ["CORPSECRET_", "123456789"].join("");
    const events = [
      { type: "workflow:model:call:completed", promptTokens: 1, completionTokens: 2, latencyMs: 3 },
    ] as const;
    const report = persistWorkflowEvidence(
      identity(),
      {
        workflowId: "unit-test-generation",
        status: "dry-run",
        proposedDiff: "--- /dev/null\n+++ b/tests/add.test.ts\n",
        addedTestFiles: [{ path: "tests/add.test.ts", estimatedTestCount: 1 }],
        verificationSummary: { ...verification, workspaceRoot: literalSecret },
      },
      events,
      { store, env: {}, additionalSecrets: [literalSecret] },
    );
    expect(report.runId).toBe("run-1");
    expect(report.evidenceLocation).toBe("run-1.json");
    expect(report.usageTotals.requestCount).toBe(1);
    const loaded = loadEvidence(store, "run-1");
    expect(JSON.stringify(loaded)).not.toContain(literalSecret);
  });
});
