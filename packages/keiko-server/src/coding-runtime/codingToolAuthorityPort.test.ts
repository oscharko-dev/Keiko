import { describe, expect, it, vi } from "vitest";

import type {
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeAuthorityFacts,
} from "@oscharko-dev/keiko-contracts";

import { createCodingToolAuthorityPort } from "./codingToolAuthorityPort.js";

const DIGEST = "a".repeat(64);
const liveFacts: CodingWorkbenchRuntimeAuthorityFacts = {
  binding: {
    taskId: "task-1",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRootDigest: DIGEST,
    branchRef: "issue-2251",
    branchHeadDigest: DIGEST,
  },
  actionClasses: ["command-execution"],
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

const fullyAuthorizedEnvelope = {
  authority: {
    actionClasses: [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
      "network-egress",
      "delivery-substrate",
    ],
    connectorScopes: [
      "source-control.read",
      "source-control.write",
      "issue-tracker.read",
      "issue-tracker.write",
    ],
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      requirePerCommandApproval: false,
    },
    networkPolicy: {
      mode: "allowlist",
      connectorScopes: [
        "source-control.read",
        "source-control.write",
        "issue-tracker.read",
        "issue-tracker.write",
      ],
    },
  },
} as never;

function restrictedEnvelope(
  overrides: Readonly<Record<string, unknown>>,
): CodingWorkbenchRuntimeAuthorityEnvelope {
  const base = (fullyAuthorizedEnvelope as CodingWorkbenchRuntimeAuthorityEnvelope).authority;
  return {
    authority: { ...base, ...overrides },
  } as unknown as CodingWorkbenchRuntimeAuthorityEnvelope;
}

describe("CodingToolAuthorityPort", () => {
  it("binds capability admission to live facts, replay identity, and usage", () => {
    const resolveCapabilityForDelegation = vi.fn(() => ({
      ok: true as const,
      envelope: undefined as never,
    }));
    const revalidateCapabilityForMutation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
    }));
    const port = createCodingToolAuthorityPort(
      { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
      () => ({
        adapterKind: "model-gateway-sidecar",
        liveFacts,
        workspaceRoot: "/managed/workspace",
        deploymentCeiling: "supervised-coding",
        nowIso: "2026-07-11T12:00:00.000Z",
      }),
    );

    const admission = port.admit("runtime-capability-secret", {
      action: "edit",
      actionId: "action-1",
      idempotencyKey: "key-1",
      targetPath: "src/file.ts",
      patchBytes: 42,
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error("expected admission");
    expect(admission.mutationGuard.check()).toBe(true);
    expect(resolveCapabilityForDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "runtime-capability-secret",
        delegationId: "action-1",
        idempotencyKey: "key-1",
        usage: { toolCalls: 1, patchBytes: 42, promptTokens: 0 },
        liveFacts,
      }),
    );
    expect(revalidateCapabilityForMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "runtime-capability-secret",
        liveFacts,
      }),
    );
  });

  it("fails closed for missing capability and authority denial", () => {
    const resolveCapabilityForDelegation = vi.fn(() => ({
      ok: false as const,
      reason: "revoked" as const,
    }));
    const revalidateCapabilityForMutation = vi.fn(() => ({
      ok: false as const,
      reason: "revoked" as const,
    }));
    const port = createCodingToolAuthorityPort(
      { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
      () => ({
        adapterKind: "model-gateway-sidecar",
        liveFacts,
        workspaceRoot: "/managed/workspace",
        deploymentCeiling: "supervised-coding",
        nowIso: "2026-07-11T12:00:00.000Z",
      }),
    );
    const request = {
      action: "command" as const,
      actionId: "action-1",
      idempotencyKey: "key-1",
      commandId: "verification-1",
    };

    expect(port.admit(undefined, request)).toEqual({
      ok: false,
      reason: "capability-missing",
    });
    expect(port.admit("runtime-capability-secret", request)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it.each([
    [
      "edit",
      { action: "edit", actionId: "a", idempotencyKey: "k", targetPath: "a.ts", patchBytes: 1 },
      { actionClasses: ["workspace-read"] },
    ],
    [
      "command",
      { action: "command", actionId: "a", idempotencyKey: "k", commandId: "test" },
      {
        commandPolicy: {
          mode: "deny",
          allow: [],
          deny: [],
          requirePerCommandApproval: false,
        },
      },
    ],
    [
      "verification",
      { action: "verification", actionId: "a", idempotencyKey: "k", verifierId: "unit" },
      { actionClasses: ["workspace-read"] },
    ],
    [
      "deny-listed command",
      { action: "command", actionId: "a", idempotencyKey: "k", commandId: "deploy" },
      {
        commandPolicy: {
          mode: "governed",
          allow: [],
          deny: ["deploy"],
          requirePerCommandApproval: false,
        },
      },
    ],
    [
      "non-allowlisted command",
      { action: "command", actionId: "a", idempotencyKey: "k", commandId: "deploy" },
      {
        commandPolicy: {
          mode: "allowlisted",
          allow: ["test"],
          deny: [],
          requirePerCommandApproval: false,
        },
      },
    ],
    [
      "command awaiting per-command approval",
      { action: "command", actionId: "a", idempotencyKey: "k", commandId: "test" },
      {
        commandPolicy: {
          mode: "governed",
          allow: [],
          deny: [],
          requirePerCommandApproval: true,
        },
      },
    ],
    [
      "git read",
      { action: "git", actionId: "a", idempotencyKey: "k", operation: "read" },
      { actionClasses: ["verification"] },
    ],
    [
      "git write",
      { action: "git", actionId: "a", idempotencyKey: "k", operation: "write" },
      { connectorScopes: ["source-control.read"] },
    ],
    [
      "delivery",
      { action: "delivery", actionId: "a", idempotencyKey: "k", intent: "commit" },
      { actionClasses: ["workspace-write"] },
    ],
    [
      "connector",
      { action: "connector", actionId: "a", idempotencyKey: "k", scope: "issue-tracker.write" },
      { connectorScopes: ["source-control.read"] },
    ],
    [
      "remote delivery without network scope",
      { action: "delivery", actionId: "a", idempotencyKey: "k", intent: "push" },
      {
        networkPolicy: {
          mode: "allowlist",
          connectorScopes: ["source-control.read"],
        },
      },
    ],
    [
      "egress",
      { action: "egress", actionId: "a", idempotencyKey: "k", target: "approved-target" },
      { networkPolicy: { mode: "deny-all", connectorScopes: [] } },
    ],
  ] as const)(
    "denies %s before replay or budget reservation when envelope policy is missing",
    (_label, request, overrides) => {
      const resolveCapabilityForDelegation = vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      }));
      const revalidateCapabilityForMutation = vi.fn(() => ({
        ok: true as const,
        envelope: restrictedEnvelope(overrides),
      }));
      const port = createCodingToolAuthorityPort(
        { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
        () => ({
          adapterKind: "model-gateway-sidecar",
          liveFacts,
          workspaceRoot: "/managed/workspace",
          deploymentCeiling: "supervised-coding",
          nowIso: "2026-07-11T12:00:00.000Z",
        }),
      );

      expect(port.admit("runtime-capability-secret", request)).toEqual({
        ok: false,
        reason: "action-not-authorized",
      });
      expect(resolveCapabilityForDelegation).not.toHaveBeenCalled();
    },
  );
});
