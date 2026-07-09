import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchAuthorityEnvelope,
  GitRepositoryAgentOperationRequest,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchEvidenceRecord } from "@oscharko-dev/keiko-contracts";
import {
  decideAutonomousDeliveryOperation,
  type AutonomousDeliveryPolicyRequest,
} from "./autonomousDeliveryPolicy.js";

const NOW = "2026-07-07T13:00:00.000Z";
const APPROVAL_DIGEST = "a".repeat(64);

function envelope(
  overrides: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-1993",
    localUser: "operator",
    taskRefs: ["issue-1993"],
    workspace: {
      workspaceId: "workspace",
      rootLabel: "workspace",
      rootDigest: "b".repeat(64),
    },
    branch: {
      baseRef: "dev",
      headRef: "issue/1993",
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
    connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.read"],
    modelProfile: {
      profileId: "codex",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 120_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: {
      mode: "connector-scoped-egress",
      allowLoopback: true,
      connectorScopes: ["source-control.read", "source-control.write"],
    },
    gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 20,
      maxPromptTokens: 200_000,
      maxPatchBytes: 1_000_000,
    },
    expiresAt: "2026-07-07T14:00:00.000Z",
    approvalProofDigest: APPROVAL_DIGEST,
    ...overrides,
  };
}

function pullRequestOperation(
  payload: Readonly<Record<string, unknown>> = {},
): GitRepositoryAgentOperationRequest {
  return {
    schemaVersion: "1",
    operation: "pull-request",
    mode: "execute",
    projectId: "workspace",
    idempotencyKey: "pr-1",
    payload: {
      kind: "create",
      ownerAndRepo: "oscharko-dev/Keiko",
      headBranchName: "issue/1993",
      baseBranchName: "dev",
      title: "Autonomous delivery",
      description: "Redacted body is delegated only.",
      isDraft: true,
      ...payload,
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
    step: {
      kind: "repository-operation",
      stepId: "step-1",
      request: pullRequestOperation(),
    },
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

function connectorPolicyRequest(
  overrides: Partial<AutonomousDeliveryPolicyRequest> = {},
): AutonomousDeliveryPolicyRequest {
  return policyRequest({
    authorityEnvelope: envelope({
      connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
      networkPolicy: {
        mode: "connector-scoped-egress",
        allowLoopback: true,
        connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
      },
    }),
    step: {
      kind: "connector-operation",
      stepId: "connector-1",
      request: {
        provider: "github",
        objectKind: "issue",
        action: "comment",
        targetRef: "issue-1993",
        idempotencyKey: "issue-comment-1",
        commentKind: "progress",
      },
    },
    ...overrides,
  });
}

describe("autonomous delivery policy", () => {
  it("allows a confirmed autonomous PR operation through delivery and source-control scopes", () => {
    const decision = decideAutonomousDeliveryOperation(policyRequest());

    expect(decision.status).toBe("allowed");
    expect(decision.evidence).toMatchObject({
      kind: "permission",
      effectiveMode: "autonomous-delivery",
      runtimeSource: "delivery-runner",
      artifactLabel: "delivery",
      safeSummary: "approval-proof-accepted",
      denied: false,
    });
    expect(validateCodingWorkbenchEvidenceRecord(decision.evidence).ok).toBe(true);
  });

  it("denies autonomous delivery without a matching confirmed Authority Envelope proof", () => {
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          confirmation: {
            confirmed: false,
            approvalProofDigest: APPROVAL_DIGEST,
            confirmedAt: NOW,
          },
        }),
      ),
    ).toMatchObject({
      status: "denied",
      denialReason: "authority-envelope-unconfirmed",
      evidence: { safeSummary: "approval-proof-missing", denied: true },
    });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          approvalProofVerified: false,
          confirmation: {
            confirmed: true,
            approvalProofDigest: APPROVAL_DIGEST,
            confirmedAt: NOW,
          },
        }),
      ),
    ).toMatchObject({
      status: "denied",
      denialReason: "authority-envelope-unconfirmed",
      evidence: { safeSummary: "approval-proof-missing", denied: true },
    });
  });

  it("denies autonomous delivery when the server deployment ceiling does not validate", () => {
    const decision = decideAutonomousDeliveryOperation(
      policyRequest({
        deploymentCeilingVerified: false,
      }),
    );

    expect(decision).toMatchObject({
      status: "denied",
      denialReason: "delivery-policy-denied",
      evidence: { safeSummary: "policy-denied", denied: true },
    });
  });

  it("denies expired envelopes, stopped runs, and non-autonomous effective modes", () => {
    expect(
      decideAutonomousDeliveryOperation(policyRequest({ nowIso: "2026-07-07T14:00:00.001Z" })),
    ).toMatchObject({ status: "denied", denialReason: "authority-expired" });
    expect(
      decideAutonomousDeliveryOperation(policyRequest({ operatorStopped: true })),
    ).toMatchObject({ status: "denied", denialReason: "operator-stopped" });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: envelope({
            requestedMode: "supervised-coding",
            effectiveMode: "supervised-coding",
            actionClasses: [
              "workspace-read",
              "workspace-write",
              "command-execution",
              "verification",
              "connector-access",
            ],
            networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "delivery-policy-denied" });
  });

  it("denies envelopes at the exact expiresAt boundary", () => {
    expect(
      decideAutonomousDeliveryOperation(policyRequest({ nowIso: "2026-07-07T14:00:00.000Z" })),
    ).toMatchObject({ status: "denied", denialReason: "authority-expired" });
  });

  it("denies missing action classes, connector scopes, and network policy scopes", () => {
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: envelope({
            actionClasses: [
              "workspace-read",
              "workspace-write",
              "command-execution",
              "verification",
              "connector-access",
              "network-egress",
            ],
          }),
          step: {
            kind: "repository-operation",
            stepId: "step-1",
            request: {
              schemaVersion: "1",
              operation: "commit",
              mode: "execute",
              projectId: "workspace",
              idempotencyKey: "commit-1",
              payload: { message: "content-free" },
            },
          },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "permission-scope-missing" });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: envelope({
            connectorScopes: ["source-control.read"],
            networkPolicy: {
              mode: "connector-scoped-egress",
              allowLoopback: true,
              connectorScopes: ["source-control.read"],
            },
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "connector-scope-missing" });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: envelope({
            networkPolicy: {
              mode: "connector-scoped-egress",
              allowLoopback: true,
              connectorScopes: ["source-control.read"],
            },
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "permission-scope-missing" });
  });

  it("denies branch escapes, force-push, merge, and exhausted budgets", () => {
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          step: {
            kind: "repository-operation",
            stepId: "step-1",
            request: pullRequestOperation({ headBranchName: "feature/outside" }),
          },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "branch-out-of-envelope" });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          step: {
            kind: "repository-operation",
            stepId: "step-1",
            request: {
              schemaVersion: "1",
              operation: "push",
              mode: "execute",
              projectId: "workspace",
              idempotencyKey: "push-1",
              payload: {
                sourceBranchName: "issue/1993",
                remoteBranchName: "issue/1993",
                forcePush: true,
              },
            },
          },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "delivery-policy-denied" });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          step: {
            kind: "repository-operation",
            stepId: "step-1",
            request: {
              schemaVersion: "1",
              operation: "merge",
              mode: "execute",
              projectId: "workspace",
              idempotencyKey: "merge-1",
              payload: { headBranchName: "issue/1993", baseBranchName: "dev" },
            },
          },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "delivery-policy-denied" });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          usage: { runtimeMs: 0, toolCalls: 20, promptTokens: 0, patchBytes: 0 },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "budget-exceeded" });
  });

  it("allows governed command-task verification and denies it when command execution is absent", () => {
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          step: {
            kind: "command-task",
            stepId: "verify-1",
            request: { projectId: "workspace", taskId: "npm-script:test", requestId: "verify-1" },
          },
        }),
      ),
    ).toMatchObject({
      status: "allowed",
      evidence: { artifactLabel: "verification", safeSummary: "approval-proof-accepted" },
    });
    expect(
      decideAutonomousDeliveryOperation(
        policyRequest({
          authorityEnvelope: envelope({
            actionClasses: [
              "workspace-read",
              "workspace-write",
              "verification",
              "connector-access",
              "network-egress",
              "delivery-substrate",
            ],
            commandPolicy: {
              mode: "deny",
              allow: [],
              deny: [],
              maxCommandTimeoutMs: 120_000,
              requirePerCommandApproval: false,
            },
          }),
          step: {
            kind: "command-task",
            stepId: "verify-1",
            request: { projectId: "workspace", taskId: "npm-script:test", requestId: "verify-1" },
          },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "permission-scope-missing" });
  });

  it("allows bounded connector writes through issue-tracker scope and content-free evidence", () => {
    const decision = decideAutonomousDeliveryOperation(connectorPolicyRequest());

    expect(decision).toMatchObject({
      status: "allowed",
      evidence: {
        artifactLabel: "issue-tracker",
        safeSummary: "approval-proof-accepted",
        denied: false,
      },
    });
    expect(JSON.stringify(decision.evidence)).not.toContain("progress");
  });

  it("denies connector writes without write scope, network scope, or task-ref binding", () => {
    expect(
      decideAutonomousDeliveryOperation(
        connectorPolicyRequest({
          authorityEnvelope: envelope({
            connectorScopes: ["source-control.read", "source-control.write"],
            networkPolicy: {
              mode: "connector-scoped-egress",
              allowLoopback: true,
              connectorScopes: ["source-control.read", "source-control.write"],
            },
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "connector-scope-missing" });
    expect(
      decideAutonomousDeliveryOperation(
        connectorPolicyRequest({
          authorityEnvelope: envelope({
            connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
            networkPolicy: {
              mode: "connector-scoped-egress",
              allowLoopback: true,
              connectorScopes: ["source-control.read", "source-control.write"],
            },
          }),
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "permission-scope-missing" });
    expect(
      decideAutonomousDeliveryOperation(
        connectorPolicyRequest({
          step: {
            kind: "connector-operation",
            stepId: "connector-1",
            request: {
              provider: "jira",
              objectKind: "issue",
              action: "status-update",
              targetRef: "issue-1994",
              idempotencyKey: "jira-status-1",
              status: "blocked",
            },
          },
        }),
      ),
    ).toMatchObject({ status: "denied", denialReason: "connector-object-out-of-envelope" });
  });
});
