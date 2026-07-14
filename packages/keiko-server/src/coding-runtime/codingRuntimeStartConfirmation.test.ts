import { describe, expect, it } from "vitest";

import { codingRuntimeStartConfirmationClaim } from "./codingRuntimeStartConfirmation.js";

const facts = {
  requestId: "request-1",
  taskIntent: "implement bounded change",
  requestedMode: "supervised-coding",
  runtimePreference: "managed-gateway",
  operatorId: "operator-1",
  taskId: "task-1",
  projectId: "project-1",
  projectDigest: "a".repeat(64),
  workspaceId: "workspace-1",
  workspaceRoot: "/managed/project/task-1",
  branchRef: "issue/2376-runtime",
  branchHeadDigest: "b".repeat(64),
  deploymentCeiling: "supervised-coding",
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
  modelProfileId: "coding-safe-openai-compatible",
} as const;

describe("coding runtime start confirmation binding", () => {
  it("is deterministic while binding every authority-bearing dimension", () => {
    const expected = codingRuntimeStartConfirmationClaim(facts, 1).bindingDigest;
    expect(codingRuntimeStartConfirmationClaim(facts, 2).bindingDigest).toBe(expected);

    for (const changed of [
      { requestId: "request-2" },
      { taskIntent: "altered" },
      { requestedMode: "governed-assist" as const },
      { runtimePreference: "codex-subscription" as const },
      { operatorId: "operator-2" },
      { taskId: "task-2" },
      { projectId: "project-2" },
      { projectDigest: "c".repeat(64) },
      { workspaceId: "workspace-2" },
      { workspaceRoot: "/managed/project/task-2" },
      { branchRef: "issue/other" },
      { branchHeadDigest: "d".repeat(64) },
      { deploymentCeiling: "governed-assist" as const },
      { runtimeSource: "codex-cli-adapter" as const },
      { modelSource: "chatgpt-codex-subscription-profile" as const },
      { modelProfileId: "codex-subscription" },
    ]) {
      expect(
        codingRuntimeStartConfirmationClaim({ ...facts, ...changed }, 1).bindingDigest,
      ).not.toBe(expected);
    }
  });
});
