import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import { persistWorkflowEvidence, type RunIdentity } from "./evidence.js";

const identity: RunIdentity = {
  runId: "ui-run-1",
  fingerprint: "fp",
  modelId: "example-chat-model-unstructured",
  kind: "unit-tests",
  status: "completed",
  startedAt: 10,
  finishedAt: 25,
  workspaceRoot: "/repo",
};

describe("persistWorkflowEvidence", () => {
  it("persists a redacted diff for UI workflow result replay", () => {
    const store = createInMemoryEvidenceStore();
    const literalSecret = ["CORPSECRET_", "ui-diff"].join("");

    persistWorkflowEvidence(
      identity,
      {
        workflowId: "unit-test-generation",
        status: "dry-run",
        proposedDiff: `--- /dev/null\n+++ b/tests/${literalSecret}.test.ts\n`,
        addedTestFiles: [{ path: "tests/add.test.ts", estimatedTestCount: 1 }],
      },
      [],
      { store, env: {}, additionalSecrets: [literalSecret] },
    );

    const loaded = loadEvidence(store, identity.runId);
    if (loaded === undefined) throw new Error("Expected persisted evidence.");
    expect(loaded.patch?.redactedDiff).toBeDefined();
    expect(loaded.patch?.redactedDiff).not.toContain(literalSecret);
  });
});
