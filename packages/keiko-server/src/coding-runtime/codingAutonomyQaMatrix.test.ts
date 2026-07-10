import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  codingWorkbenchPolicyEffectFor,
  decideCodingWorkbenchActionForMode,
  validateCodingWorkbenchEvidenceRecord,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type GitRepositoryAgentOperationKind,
  type GitRepositoryAgentOperationRequest,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import {
  decideAutonomousDeliveryOperation,
  type AutonomousDeliveryPolicyRequest,
  type AutonomousDeliveryStep,
} from "./autonomousDeliveryPolicy.js";

const NOW = "2026-07-08T08:30:00.000Z";
const APPROVAL_DIGEST = "f".repeat(64);

function envelope(
  overrides: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-1994",
    localUser: "operator",
    taskRefs: ["issue-1994"],
    workspace: {
      workspaceId: "workspace",
      rootLabel: "keiko",
      rootDigest: "b".repeat(64),
    },
    branch: {
      baseRef: "dev",
      headRef: "issue/1994",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/"],
    },
    requestedMode: "autonomous-delivery",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
    runtimeSource: "delivery-runner",
    actionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
      "network-egress",
      "delivery-substrate",
    ],
    connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
    modelProfile: {
      profileId: "keiko-model-gateway",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: ["npm", "node"],
      deny: ["curl"],
      maxCommandTimeoutMs: 600_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: {
      mode: "connector-scoped-egress",
      allowLoopback: true,
      connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
    },
    gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
    budget: {
      maxRuntimeMs: 7_200_000,
      maxToolCalls: 120,
      maxPromptTokens: 200_000,
      maxPatchBytes: 500_000,
    },
    expiresAt: "2026-07-08T09:30:00.000Z",
    approvalProofDigest: APPROVAL_DIGEST,
    ...overrides,
  };
}

function repositoryOperation(
  operation: GitRepositoryAgentOperationKind,
  payload: Readonly<Record<string, unknown>>,
): GitRepositoryAgentOperationRequest {
  return {
    schemaVersion: "1",
    operation,
    mode: "execute",
    projectId: "workspace",
    idempotencyKey: `${operation}-1994`,
    payload,
  };
}

function repositoryStep(
  operation: GitRepositoryAgentOperationKind,
  payload: Readonly<Record<string, unknown>>,
): AutonomousDeliveryStep {
  return {
    kind: "repository-operation",
    stepId: `${operation}-step`,
    request: repositoryOperation(operation, payload),
  };
}

function commandStep(): AutonomousDeliveryStep {
  return {
    kind: "command-task",
    stepId: "verify-step",
    request: {
      projectId: "workspace",
      taskId: "npm-script:test",
      requestId: "verify-1994",
    },
  };
}

function connectorStep(targetRef = "issue-1994"): AutonomousDeliveryStep {
  return {
    kind: "connector-operation",
    stepId: "connector-step",
    request: {
      provider: "github",
      objectKind: "issue",
      action: "comment",
      targetRef,
      idempotencyKey: `comment-${targetRef}`,
      commentKind: "closure",
    },
  };
}

function policyRequest(
  overrides: Partial<AutonomousDeliveryPolicyRequest> = {},
): AutonomousDeliveryPolicyRequest {
  return {
    authorityEnvelope: envelope(),
    confirmation: {
      confirmed: true,
      approvalProofDigest: APPROVAL_DIGEST,
      confirmedAt: NOW,
    },
    approvalProofVerified: true,
    deploymentCeilingVerified: true,
    step: repositoryStep("pull-request", {
      kind: "create",
      ownerAndRepo: "oscharko-dev/Keiko",
      headBranchName: "issue/1994",
      baseBranchName: "dev",
      title: "Task: Add coding autonomy security, evaluation, and end-to-end QA matrix",
      description: "Issue body is intentionally not copied into evidence.",
      isDraft: true,
    }),
    usage: {
      runtimeMs: 0,
      toolCalls: 0,
      promptTokens: 0,
      patchBytes: 0,
    },
    nowIso: NOW,
    remainingStepCount: 1,
    ...overrides,
  };
}

function withoutConnectorScopes(
  scopes: readonly CodingWorkbenchConnectorScope[],
): CodingWorkbenchAuthorityEnvelope {
  return envelope({
    connectorScopes: scopes,
    networkPolicy: {
      mode: "connector-scoped-egress",
      allowLoopback: true,
      connectorScopes: scopes,
    },
  });
}

describe("coding autonomy closeout QA matrix", () => {
  it("keeps class admission separate from the three scope and risk policies", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"] as const) {
      expect(
        CODING_WORKBENCH_ACTION_CLASSES.every(
          (actionClass) => decideCodingWorkbenchActionForMode(mode, actionClass).allowed,
        ),
      ).toBe(true);
    }

    expect(
      codingWorkbenchPolicyEffectFor("governed-assist", "workspace-contained", "critical"),
    ).toBe("allowed");
    expect(codingWorkbenchPolicyEffectFor("governed-assist", "external-file", "low")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("governed-assist", "internet", "low")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("supervised-coding", "external-file", "medium")).toBe(
      "allowed",
    );
    expect(codingWorkbenchPolicyEffectFor("supervised-coding", "internet", "high")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("autonomous-delivery", "internet", "critical")).toBe(
      "allowed",
    );
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"] as const) {
      expect(codingWorkbenchPolicyEffectFor(mode, "delivery", "low")).toBe("approval-required");
    }
  });

  it("allows confirmed autonomous PR handoff while keeping evidence content-free", () => {
    const decision = decideAutonomousDeliveryOperation(policyRequest());

    expect(decision).toMatchObject({
      status: "allowed",
      evidence: {
        kind: "permission",
        effectiveMode: "autonomous-delivery",
        runtimeSource: "delivery-runner",
        modelSource: "keiko-model-gateway",
        artifactLabel: "delivery",
        safeSummary: "approval-proof-accepted",
        denied: false,
      },
    });
    expect(validateCodingWorkbenchEvidenceRecord(decision.evidence).ok).toBe(true);
    const serializedEvidence = JSON.stringify(decision.evidence);
    expect(serializedEvidence).not.toContain("Task: Add coding autonomy");
    expect(serializedEvidence).not.toContain("Issue body");
    expect(serializedEvidence).not.toContain("diff --git");
    expect(serializedEvidence).not.toContain("Bearer");
    expect(serializedEvidence).not.toContain("ghp_");
    expect(serializedEvidence).not.toContain("/Users/");
  });

  it.each([
    [
      "file",
      policyRequest({
        authorityEnvelope: envelope({
          actionClasses: [
            "workspace-read",
            "command-execution",
            "verification",
            "connector-access",
            "network-egress",
            "delivery-substrate",
          ],
        }),
        step: repositoryStep("branch-create", {
          branchName: "issue/1994",
          baseBranchName: "dev",
        }),
      }),
      "permission-scope-missing",
    ],
    [
      "shell",
      policyRequest({
        authorityEnvelope: envelope({
          commandPolicy: {
            mode: "deny",
            allow: [],
            deny: ["curl"],
            maxCommandTimeoutMs: 1,
            requirePerCommandApproval: true,
          },
        }),
        step: commandStep(),
      }),
      "delivery-policy-denied",
    ],
    [
      "git",
      policyRequest({
        step: repositoryStep("push", {
          sourceBranchName: "issue/1994",
          remoteBranchName: "issue/1994",
          forcePush: true,
        }),
      }),
      "delivery-policy-denied",
    ],
    [
      "connector",
      policyRequest({
        step: connectorStep("issue-0000"),
      }),
      "connector-object-out-of-envelope",
    ],
    [
      "model",
      policyRequest({
        authorityEnvelope: envelope({
          modelProfile: {
            profileId: "codex",
            source: "chatgpt-codex-subscription-profile",
            supportsStreaming: true,
            supportsToolCalling: true,
          },
        }),
        step: repositoryStep("merge", {
          headBranchName: "issue/1994",
          baseBranchName: "dev",
        }),
      }),
      "delivery-policy-denied",
    ],
    [
      "envelope",
      policyRequest({
        confirmation: {
          confirmed: false,
          approvalProofDigest: APPROVAL_DIGEST,
          confirmedAt: NOW,
        },
      }),
      "authority-envelope-unconfirmed",
    ],
  ] as const)(
    "fails closed for %s boundary bypass attempts",
    (_boundary, request, denialReason) => {
      expect(decideAutonomousDeliveryOperation(request)).toMatchObject({
        status: "denied",
        denialReason,
        evidence: { denied: true },
      });
    },
  );

  it("denies expired envelopes, connector scope drift, network drift, and branch escapes", () => {
    expect(
      decideAutonomousDeliveryOperation(policyRequest({ nowIso: "2026-07-08T09:30:00.000Z" })),
    ).toMatchObject({ status: "denied", denialReason: "authority-expired" });

    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: withoutConnectorScopes(["source-control.read"]),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "connector-scope-missing" });

    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: envelope({
            connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
            networkPolicy: {
              mode: "connector-scoped-egress",
              allowLoopback: true,
              connectorScopes: ["source-control.read", "issue-tracker.write"],
            },
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "permission-scope-missing" });

    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          step: repositoryStep("pull-request", {
            kind: "create",
            ownerAndRepo: "oscharko-dev/Keiko",
            headBranchName: "feature/outside-envelope",
            baseBranchName: "dev",
            isDraft: true,
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "branch-out-of-envelope" });
  });

  it.each([
    [
      "portable sidecar launch from managed install",
      "packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts",
      "resolves launch paths from a verified portable sidecar payload",
    ],
    [
      "Model Gateway fake-provider sidecar routing",
      "packages/keiko-server/src/coding-sidecar-gateway.test.ts",
      "sidecar-gateway-ready",
    ],
    [
      "ChatGPT/Codex subscription isolation",
      "packages/keiko-server/src/coding-codex-subscription.test.ts",
      "rejects access-token setup bodies that try to send the token to Keiko",
    ],
    [
      "Autonomous Delivery UI/a11y closeout",
      "tests/e2e/coding-workbench-1994.spec.ts",
      "autonomous closeout narrow viewport has no horizontal overflow",
    ],
    [
      "operator runbook three-mode policy",
      "docs/qa/coding-workbench-operator-runbook.md",
      "| **Ask for approval** | `governed-assist`",
    ],
    [
      "operator runbook delivery boundary",
      "docs/qa/coding-workbench-operator-runbook.md",
      "require separate explicit human approval in all three modes",
    ],
  ] as const)("keeps %s proof wired into the closeout ledger", (_label, filePath, expectedText) => {
    const absolutePath = resolve(process.cwd(), filePath);
    expect(existsSync(absolutePath), filePath).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toContain(expectedText);
  });
});
