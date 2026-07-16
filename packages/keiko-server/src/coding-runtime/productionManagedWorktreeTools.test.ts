import { describe, expect, it, vi } from "vitest";

import type { CodingWorkbenchRuntimeAuthorityFacts } from "@oscharko-dev/keiko-contracts";

import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";

const DIGEST = "a".repeat(64);
const FACTS: CodingWorkbenchRuntimeAuthorityFacts = {
  binding: {
    taskId: "task-1",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRootDigest: DIGEST,
    branchRef: "issue-2376",
    branchHeadDigest: DIGEST,
  },
  actionClasses: ["workspace-read", "workspace-write", "verification"],
  connectorScopes: [],
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
  budgetDigest: DIGEST,
  commandPolicyDigest: DIGEST,
  networkPolicyDigest: DIGEST,
  gatesDigest: DIGEST,
  branchConstraintsDigest: DIGEST,
  modelProfileDigest: DIGEST,
};

describe("production managed worktree tools", () => {
  it("routes reads through the secure workspace port and rechecks live authority", async () => {
    let live = true;
    const readText = vi.fn(() => Promise.resolve({ ok: true as const, text: "private source" }));
    const facade = createProductionManagedWorktreeToolFacade({
      authority: {
        revalidateCapabilityForMutation: () =>
          live
            ? { ok: true as const, envelope: authorizedEnvelope() }
            : { ok: false as const, reason: "workspace-drift" as const },
        resolveCapabilityForDelegation: () =>
          live
            ? { ok: true as const, envelope: authorizedEnvelope() }
            : { ok: false as const, reason: "workspace-drift" as const },
      },
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      workspaceRoot: "/managed/worktree",
      authorityExpiresAt: "2099-01-01T00:00:00.000Z",
      deploymentCeiling: "supervised-coding",
      liveFacts: () => FACTS,
      secureWorkspaceTextRead: { readText },
      editorAgentClient: {
        action: () =>
          Promise.resolve({
            ok: false as const,
            error: { kind: "route" as const, code: "denied", message: "denied" },
          }),
      },
      invocationRegistry: createCodingToolInvocationRegistry(),
      verificationRunner: { runToReport: vi.fn() },
      onRuntimeEvent: vi.fn(),
    });
    const body = JSON.stringify({
      action: "read",
      actionId: "action-1",
      idempotencyKey: "key-1",
      relativePath: "src/example.ts",
    });

    await expect(facade.execute({ body, capability: "opaque-capability" })).resolves.toMatchObject({
      status: "completed",
      read: { text: "private source" },
    });
    live = false;
    await expect(
      facade.execute({ body: body.replace("key-1", "key-2"), capability: "opaque-capability" }),
    ).resolves.toMatchObject({ status: "denied" });
    expect(readText).toHaveBeenCalledOnce();
  });
});

function authorizedEnvelope(): never {
  return {
    authority: {
      actionClasses: ["workspace-read", "workspace-write", "verification"],
      connectorScopes: [],
      commandPolicy: { mode: "deny", allow: [], deny: [] },
      networkPolicy: { mode: "deny-all", connectorScopes: [] },
    },
  } as never;
}
