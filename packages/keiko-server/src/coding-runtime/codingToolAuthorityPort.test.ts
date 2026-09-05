import { describe, expect, it, vi } from "vitest";

import type {
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeAuthorityFacts,
} from "@oscharko-dev/keiko-contracts";

import {
  createCodingToolAuthorityPort,
  createCodingToolAuthorityPreview,
  createRuntimeCodingToolFacade,
} from "./codingToolAuthorityPort.js";
import {
  codingToolApprovalBindingDigest,
  createCodingToolApprovalBridge,
  type ApprovableToolRequest,
} from "./codingToolApprovalBridge.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import type { CodingToolGovernedPorts } from "./codingToolGovernedDelegate.js";
import type { CodingRuntimeCapabilityDelegationInput } from "./runtimeAuthorityService.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";

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
    effectiveMode: "supervised-coding",
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

function governedPorts(
  editorOutcome: "completed" | "failed" = "completed",
): CodingToolGovernedPorts {
  const failed = (): Promise<{ readonly status: "failed" }> =>
    Promise.resolve({ status: "failed" });
  return {
    repositoryRead: { execute: failed },
    repositoryDiscover: { execute: failed },
    repositorySearch: { execute: failed },
    editorChangeset: { execute: () => Promise.resolve({ status: editorOutcome }) },
    commandRunner: { execute: failed },
    verificationRunner: { execute: failed },
    gitAuthority: { execute: failed },
    deliveryAuthority: { execute: failed },
    connectorAuthority: { execute: failed },
    egressAuthority: { execute: failed },
  };
}

function runtimeContext(): {
  readonly adapterKind: "model-gateway-sidecar";
  readonly liveFacts: CodingWorkbenchRuntimeAuthorityFacts;
  readonly workspaceRoot: string;
  readonly deploymentCeiling: "supervised-coding";
  readonly nowIso: string;
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly authorityExpiresAt: string;
} {
  return {
    adapterKind: "model-gateway-sidecar",
    liveFacts,
    workspaceRoot: "/managed/workspace",
    deploymentCeiling: "supervised-coding",
    nowIso: "2026-07-12T09:00:00.000Z",
    runId: "run-authority-a",
    envelopeDigest: DIGEST,
    authorityExpiresAt: "2026-07-12T12:00:00.000Z",
  };
}

function approvableRequest(action: "command" | "verification"): ApprovableToolRequest {
  const identity = {
    actionId: "action-approved",
    idempotencyKey: "action-approved",
  };
  return action === "command"
    ? { ...identity, action, commandId: "test" }
    : { ...identity, action, verifierId: "test" };
}

async function duplicateResults(
  runtime: ReturnType<typeof createRuntimeCodingToolFacade>,
  body: string,
): Promise<readonly import("./codingToolIpc.js").CodingToolResult[]> {
  const results = [];
  for (let index = 0; index < 1_000; index += 1) {
    results.push(await runtime.execute({ body, capability: "runtime-capability-secret" }));
  }
  return results;
}

describe("CodingToolAuthorityPort", () => {
  it.each([
    { actionClasses: ["workspace-read"] },
    { connectorScopes: ["source-control.write"] },
    { networkPolicy: { mode: "deny-all", connectorScopes: ["source-control.read"] } },
    { networkPolicy: { mode: "allowlist", connectorScopes: [] } },
  ])("requires the existing source-control network grant for CI metadata %j", (restriction) => {
    const envelope = restrictedEnvelope(restriction);
    const authority = {
      revalidateCapabilityForMutation: vi.fn(() => ({ ok: true as const, envelope })),
      resolveCapabilityForDelegation: vi.fn(() => ({ ok: true as const, envelope })),
    };
    const port = createCodingToolAuthorityPort(authority, runtimeContext);
    expect(
      port.admit("capability", {
        action: "git",
        operation: "ci",
        actionId: "ci-1",
        idempotencyKey: "ci-1",
      }).ok,
    ).toBe(false);
    expect(authority.resolveCapabilityForDelegation).not.toHaveBeenCalled();
  });
  it("never turns a hard command denial into an approval request", () => {
    const envelope = restrictedEnvelope({
      commandPolicy: {
        mode: "governed",
        allow: [],
        deny: ["test"],
        requirePerCommandApproval: true,
      },
    });
    const resolveCapabilityForDelegation = vi.fn(() => ({ ok: true as const, envelope }));
    const revalidateCapabilityForMutation = vi.fn(() => ({ ok: true as const, envelope }));
    const preview = createCodingToolAuthorityPreview(
      { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
      runtimeContext,
    );
    expect(preview("capability", approvableRequest("command"))).toEqual({
      ok: false,
      reason: "action-not-authorized",
    });
    expect(resolveCapabilityForDelegation).not.toHaveBeenCalled();
  });
  it("previews live authority without reserving delegation or returning mutation authority", () => {
    const resolveCapabilityForDelegation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
    }));
    const revalidateCapabilityForMutation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
    }));
    const preview = createCodingToolAuthorityPreview(
      { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
      runtimeContext,
      { requireProducerBinding: true },
    );
    const request = {
      action: "read" as const,
      actionId: "preview",
      idempotencyKey: "preview",
      relativePath: "file.ts",
    };
    expect(preview("capability", request)).toEqual({ ok: true });
    expect(resolveCapabilityForDelegation).not.toHaveBeenCalled();
    expect(revalidateCapabilityForMutation).toHaveBeenCalledOnce();
    expect(preview(undefined, request)).toEqual({ ok: false, reason: "capability-missing" });
  });
  it("keeps a matched approval unconsumed during preview and rechecks current policy", () => {
    const envelope = restrictedEnvelope({
      commandPolicy: { mode: "governed", allow: [], deny: [], requirePerCommandApproval: true },
    });
    const resolveCapabilityForDelegation = vi.fn(() => ({ ok: true as const, envelope }));
    const revalidateCapabilityForMutation = vi.fn(() => ({ ok: true as const, envelope }));
    const matches = vi.fn(() => true);
    const consume = vi.fn(() => true);
    const preview = createCodingToolAuthorityPreview(
      { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
      runtimeContext,
      { approvalProofVerifier: { matches, consume } },
    );
    const request = {
      ...approvableRequest("command"),
      approvalProof: { approvalId: "approval-1", approvalDigest: DIGEST },
    };
    expect(preview("capability", request)).toEqual({ ok: true });
    expect(matches).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    expect(resolveCapabilityForDelegation).not.toHaveBeenCalled();
    matches.mockReturnValue(false);
    expect(preview("capability", request)).toEqual({ ok: false, reason: "approval-required" });
  });
  it("binds capability admission to live facts, replay identity, and usage", () => {
    const resolveCapabilityForDelegation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
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
      action: "read",
      actionId: "action-1",
      idempotencyKey: "key-1",
      relativePath: "src/file.ts",
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error("expected admission");
    expect(admission.mutationGuard.check()).toBe(true);
    expect(resolveCapabilityForDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "runtime-capability-secret",
        delegationId: "action-1",
        idempotencyKey: "key-1",
        usage: { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
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

  it("returns the admitted immutable run, envelope, workspace, and expiry binding for producer carriage", () => {
    const resolveCapabilityForDelegation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
    }));
    const revalidateCapabilityForMutation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
    }));
    const port = createCodingToolAuthorityPort(
      { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
      () =>
        ({
          adapterKind: "model-gateway-sidecar",
          liveFacts,
          workspaceRoot: "/managed/workspace",
          deploymentCeiling: "supervised-coding",
          nowIso: "2026-07-11T12:00:00.000Z",
          runId: "run-authority-a",
          envelopeDigest: DIGEST,
          authorityExpiresAt: "2026-07-12T12:00:00.000Z",
        }) as never,
    );

    expect(
      port.admit("runtime-capability-secret", {
        action: "read",
        actionId: "read-1",
        idempotencyKey: "read-key",
        relativePath: "src/a.ts",
      }),
    ).toMatchObject({
      ok: true,
      binding: {
        runId: "run-authority-a",
        envelopeDigest: DIGEST,
        workspaceId: "workspace-1",
        workspaceRootDigest: DIGEST,
        expiresAt: "2026-07-12T12:00:00.000Z",
      },
    });
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

  it("preflights edits without consuming the runtime replay or budget reservation owned by the editor route", () => {
    const resolveCapabilityForDelegation = vi.fn(() => ({
      ok: true as const,
      envelope: fullyAuthorizedEnvelope,
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
        nowIso: "2026-07-12T09:00:00.000Z",
      }),
    );

    const admission = port.admit("runtime-capability-secret", {
      action: "edit",
      actionId: "edit-2332",
      idempotencyKey: "edit-key-2332",
      changeset: {
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
        files: [{ file: "src/a.ts", expectedContentHash: DIGEST }],
      },
    } as unknown as import("./codingToolIpc.js").CodingToolActionRequest);

    expect(admission.ok).toBe(true);
    expect(revalidateCapabilityForMutation).toHaveBeenCalledTimes(1);
    expect(resolveCapabilityForDelegation).not.toHaveBeenCalled();
  });

  it("routes raw canonical edit bytes through the invocation registry before its one-use producer claim and terminal wipe", async () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    const stage = vi.spyOn(registry, "stage");
    const take = vi.spyOn(registry, "take");
    const authority = {
      resolveCapabilityForDelegation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
      revalidateCapabilityForMutation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
    };
    const runtime = createRuntimeCodingToolFacade(
      authority,
      () => ({
        adapterKind: "model-gateway-sidecar",
        liveFacts,
        workspaceRoot: "/managed/workspace",
        deploymentCeiling: "supervised-coding",
        nowIso: "2026-07-12T09:00:00.000Z",
        runId: "run-authority-a",
        envelopeDigest: DIGEST,
        authorityExpiresAt: "2026-07-12T12:00:00.000Z",
      }),
      governedPorts(),
      { invocationRegistry: registry },
    );
    const rawBody = Buffer.from(
      JSON.stringify({
        action: "edit",
        actionId: "registry-edit",
        idempotencyKey: "registry-key",
        changeset: {
          patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
          files: [{ file: "src/a.ts", expectedContentHash: DIGEST }],
        },
      }),
      "utf8",
    );

    await expect(
      runtime.execute({ body: rawBody, capability: "runtime-capability-secret" }),
    ).resolves.toMatchObject({
      status: "completed",
    });

    expect(stage).toHaveBeenCalledOnce();
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "registry-edit",
        idempotencyKey: "registry-key",
      }),
    );
    expect(take).toHaveBeenCalledOnce();
    expect(rawBody.every((byte) => byte === 0)).toBe(true);
    expect(registry.tombstoneFor("run-authority-a", "registry-edit", "registry-key")).toEqual({});
  });

  it("executes one productive repository read and one budget/replay charge across 1,000 reconnect duplicates", async () => {
    const successfulReservationIdentities = new Set<string>();
    const repositoryRead = vi.fn(() =>
      Promise.resolve({
        status: "completed" as const,
        read: { text: "const governed = true;\n", byteCount: 22, digest: DIGEST },
      }),
    );
    const authority = {
      resolveCapabilityForDelegation: vi.fn((input: CodingRuntimeCapabilityDelegationInput) => {
        const identity = `${input.delegationId}:${input.idempotencyKey}`;
        if (successfulReservationIdentities.has(identity))
          return { ok: false as const, reason: "authority-replayed" as const };
        successfulReservationIdentities.add(identity);
        return { ok: true as const, envelope: fullyAuthorizedEnvelope };
      }),
      revalidateCapabilityForMutation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
    };
    const runtime = createRuntimeCodingToolFacade(authority, runtimeContext, {
      ...governedPorts(),
      repositoryRead: { execute: repositoryRead },
    });
    const body = JSON.stringify({
      action: "read",
      actionId: "reconnect-read",
      idempotencyKey: "reconnect-read-key",
      relativePath: "src/a.ts",
    });

    await expect(
      runtime.execute({ body, capability: "runtime-capability-secret" }),
    ).resolves.toMatchObject({
      status: "completed",
    });
    const duplicates = await duplicateResults(runtime, body);

    expect(duplicates).toHaveLength(1_000);
    expect(duplicates.every((result) => result.status === "denied")).toBe(true);
    expect(repositoryRead).toHaveBeenCalledOnce();
    expect(successfulReservationIdentities).toEqual(new Set(["reconnect-read:reconnect-read-key"]));
    expect(successfulReservationIdentities.size).toBe(1);
    expect(authority.resolveCapabilityForDelegation).toHaveBeenCalledTimes(1_001);
  });

  it("executes one productive editor edit and one replay reservation across 1,000 reconnect duplicates", async () => {
    const registry = createCodingToolInvocationRegistry({ now: () => 0 });
    const stageOriginal = registry.stage.bind(registry);
    let successfulReservations = 0;
    let replayChecks = 0;
    const stage = vi.spyOn(registry, "stage").mockImplementation((request) => {
      const result = stageOriginal(request);
      if (result.kind === "staged") successfulReservations += 1;
      if (result.kind === "replayed" || result.kind === "duplicate") replayChecks += 1;
      return result;
    });
    const take = vi.spyOn(registry, "take");
    const editorChangeset = vi.fn(() => Promise.resolve({ status: "completed" as const }));
    const authority = {
      resolveCapabilityForDelegation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
      revalidateCapabilityForMutation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
    };
    const runtime = createRuntimeCodingToolFacade(
      authority,
      runtimeContext,
      { ...governedPorts(), editorChangeset: { execute: editorChangeset } },
      { invocationRegistry: registry },
    );
    const body = JSON.stringify({
      action: "edit",
      actionId: "reconnect-edit",
      idempotencyKey: "reconnect-edit-key",
      changeset: {
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
        files: [{ file: "src/a.ts", expectedContentHash: DIGEST }],
      },
    });

    await expect(
      runtime.execute({ body, capability: "runtime-capability-secret" }),
    ).resolves.toMatchObject({
      status: "completed",
    });
    const duplicates = await duplicateResults(runtime, body);

    expect(duplicates).toHaveLength(1_000);
    expect(duplicates.every((result) => result.status === "denied")).toBe(true);
    expect(editorChangeset).toHaveBeenCalledOnce();
    expect(stage).toHaveBeenCalledTimes(1_001);
    expect(successfulReservations).toBe(1);
    expect(replayChecks).toBe(1_000);
    expect(take).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "edit",
      {
        action: "edit",
        actionId: "a",
        idempotencyKey: "k",
        changeset: {
          patch: "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new\n",
          files: [{ file: "a.ts", expectedContentHash: DIGEST }],
        },
      },
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
      "verification after live mode narrowing",
      { action: "verification", actionId: "a", idempotencyKey: "k", verifierId: "unit" },
      { effectiveMode: "governed-assist" },
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

  it.each(["verification", "command"] as const)(
    "admits a governed-assist %s only with its exact approved proof",
    (action) => {
      const envelope = restrictedEnvelope({
        effectiveMode: "governed-assist",
        commandPolicy: {
          mode: "governed",
          allow: [],
          deny: [],
          requirePerCommandApproval: true,
        },
      });
      const authority = {
        revalidateCapabilityForMutation: vi.fn(() => ({ ok: true as const, envelope })),
        resolveCapabilityForDelegation: vi
          .fn()
          .mockReturnValueOnce({ ok: false as const, reason: "budget-exceeded" as const })
          .mockReturnValueOnce({
            ok: true as const,
            envelope: restrictedEnvelope({ actionClasses: ["workspace-read"] }),
          })
          .mockReturnValue({ ok: true as const, envelope }),
      };
      const approvalProofVerifier = createCodingToolApprovalBridge();
      const port = createCodingToolAuthorityPort(
        authority,
        () => ({
          ...runtimeContext(),
          deploymentCeiling: "supervised-coding",
          nowIso: "2026-07-12T09:00:00.000Z",
        }),
        { approvalProofVerifier },
      );
      const bareRequest = approvableRequest(action);
      const approvalProof = {
        approvalId: bareRequest.actionId,
        approvalDigest: codingToolApprovalBindingDigest("run-authority-a", bareRequest),
      };
      const request = { ...bareRequest, approvalProof };
      const targetId = request.action === "command" ? request.commandId : request.verifierId;

      expect(port.admit("runtime-capability-secret", request).ok).toBe(false);
      expect(
        approvalProofVerifier.observePermission({
          runId: "run-authority-a",
          requestId: "permission-approved",
          action: request.action,
          actionId: request.actionId,
          idempotencyKey: request.idempotencyKey,
          targetId,
          proof: approvalProof,
          expiresAt: "2026-07-12T09:05:00.000Z",
          nowMs: Date.parse("2026-07-12T09:00:00.000Z"),
        }),
      ).toBe(true);
      expect(port.admit("runtime-capability-secret", request).ok).toBe(false);
      expect(
        approvalProofVerifier.activatePermission({
          runId: "run-authority-a",
          requestId: "permission-approved",
          approvalAuthorityDigest: "c".repeat(64),
          expiresAtMs: Date.parse("2026-07-12T09:05:00.000Z"),
          nowMs: Date.parse("2026-07-12T09:00:00.000Z"),
        }),
      ).toBe(true);

      const mismatched =
        request.action === "command"
          ? { ...request, commandId: "different-command" }
          : { ...request, verifierId: "different-verifier" };
      expect(port.admit("runtime-capability-secret", mismatched).ok).toBe(false);

      expect(port.admit("runtime-capability-secret", request)).toEqual({
        ok: false,
        reason: "budget-exceeded",
      });
      expect(port.admit("runtime-capability-secret", request)).toEqual({
        ok: false,
        reason: "action-not-authorized",
      });
      expect(port.admit("runtime-capability-secret", request).ok).toBe(true);
      expect(port.admit("runtime-capability-secret", request).ok).toBe(false);
    },
  );

  describe("search admission is read-class, exactly like read and discover (#3386 H1)", () => {
    const searchRequest = {
      action: "search" as const,
      actionId: "search-1",
      idempotencyKey: "search-1",
      repositoryRequest: {
        kind: "search" as const,
        mode: "literal" as const,
        query: "safeActivity",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
        maxResults: 20,
      },
    };

    it("admits a search with only workspace-read and consumes no approval", () => {
      const envelope = restrictedEnvelope({ actionClasses: ["workspace-read"] });
      const authority = {
        revalidateCapabilityForMutation: vi.fn(() => ({ ok: true as const, envelope })),
        resolveCapabilityForDelegation: vi.fn(() => ({ ok: true as const, envelope })),
      };
      const port = createCodingToolAuthorityPort(authority, runtimeContext);

      expect(port.admit("capability", searchRequest).ok).toBe(true);
    });

    it("denies a search when workspace-read is missing, the same class read/discover require", () => {
      const envelope = restrictedEnvelope({ actionClasses: ["workspace-write"] });
      const authority = {
        revalidateCapabilityForMutation: vi.fn(() => ({ ok: true as const, envelope })),
        resolveCapabilityForDelegation: vi.fn(() => ({ ok: true as const, envelope })),
      };
      const port = createCodingToolAuthorityPort(authority, runtimeContext);

      expect(port.admit("capability", searchRequest)).toEqual({
        ok: false,
        reason: "action-not-authorized",
      });
    });

    it("previews search availability without reserving delegation or consuming an approval", () => {
      const envelope = restrictedEnvelope({ actionClasses: ["workspace-read"] });
      const resolveCapabilityForDelegation = vi.fn(() => ({ ok: true as const, envelope }));
      const revalidateCapabilityForMutation = vi.fn(() => ({ ok: true as const, envelope }));
      const preview = createCodingToolAuthorityPreview(
        { resolveCapabilityForDelegation, revalidateCapabilityForMutation },
        runtimeContext,
      );

      expect(preview("capability", searchRequest)).toEqual({ ok: true });
      expect(resolveCapabilityForDelegation).not.toHaveBeenCalled();
    });
  });

  // #3413 F8: the CatalogToolBinder lifecycle/settlement primitives were unmounted production
  // code -- nothing outside packages/keiko-server/src/tool-catalog imported them, so no
  // tool-catalog.* line was ever emitted for a real dispatch. These three tests fail before the
  // facade/authority-port wiring in this change (createRuntimeCodingToolFacade threw
  // "catalogActivityLog is not a function" / never called it -- there was no such option) and pass
  // after it.
  describe("catalog facade bridge wiring (#3413 F8)", () => {
    const authority = {
      resolveCapabilityForDelegation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
      revalidateCapabilityForMutation: vi.fn(() => ({
        ok: true as const,
        envelope: fullyAuthorizedEnvelope,
      })),
    };

    it("emits real tool-catalog.* binding + settlement lines with a correlation id and no bodies for a real discover dispatch", async () => {
      const log = createBufferedServerLogSink();
      const repositoryDiscover = vi.fn(() =>
        Promise.resolve({
          status: "completed" as const,
          read: { text: "match.ts\n", byteCount: 9, digest: DIGEST, totalLines: 1 },
        }),
      );
      const runtime = createRuntimeCodingToolFacade(
        authority,
        () => ({ ...runtimeContext(), correlationId: "b".repeat(36) }),
        { ...governedPorts(), repositoryDiscover: { execute: repositoryDiscover } },
        { catalogActivityLog: log },
      );

      const result = await runtime.execute({
        body: JSON.stringify({
          action: "discover",
          actionId: "discover-1",
          idempotencyKey: "discover-1",
          query: "top secret needle",
          maxResults: 5,
        }),
        capability: "runtime-capability-secret",
      });

      expect(result.status).toBe("completed");
      expect(repositoryDiscover).toHaveBeenCalledOnce();
      const catalogEvents = log.events.filter((event) => event.op.startsWith("tool-catalog."));
      expect(catalogEvents.map((event) => event.op)).toEqual([
        "tool-catalog.invocation-started",
        "tool-catalog.invocation-settled",
      ]);
      for (const event of catalogEvents) {
        expect(event.correlationId).toBe("b".repeat(36));
        expect(JSON.stringify(event)).not.toContain("top secret needle");
      }
      const settled = catalogEvents[1]?.extra as Record<string, unknown>;
      expect(settled.status).toBe("completed");
    });

    it("fails closed before the handler runs when the catalog budget disposition denies the call", async () => {
      const log = createBufferedServerLogSink();
      const repositoryDiscover = vi.fn(() =>
        Promise.resolve({
          status: "completed" as const,
          read: { text: "x\n", byteCount: 1, digest: DIGEST, totalLines: 1 },
        }),
      );
      const runtime = createRuntimeCodingToolFacade(
        authority,
        runtimeContext,
        { ...governedPorts(), repositoryDiscover: { execute: repositoryDiscover } },
        {
          catalogActivityLog: log,
          catalogBudget: {
            available: () => false,
            reserve: () => {
              throw new Error("must not reserve when unavailable");
            },
            commit: () => undefined,
            release: () => undefined,
          },
        },
      );

      const result = await runtime.execute({
        body: JSON.stringify({
          action: "discover",
          actionId: "discover-2",
          idempotencyKey: "discover-2",
          query: "needle",
          maxResults: 5,
        }),
        capability: "runtime-capability-secret",
      });

      expect(result).toEqual({ status: "denied", evidence: [] });
      expect(repositoryDiscover).not.toHaveBeenCalled();
      const settled = log.events.find((event) => event.op === "tool-catalog.invocation-settled");
      expect((settled?.extra as Record<string, unknown> | undefined)?.status).toBe("denied");
    });

    it("records handler-failed and releases the budget reservation when the governed delegate throws", async () => {
      const log = createBufferedServerLogSink();
      const repositoryDiscover = vi.fn(() => Promise.reject(new Error("discover blew up")));
      const runtime = createRuntimeCodingToolFacade(
        authority,
        runtimeContext,
        { ...governedPorts(), repositoryDiscover: { execute: repositoryDiscover } },
        { catalogActivityLog: log },
      );

      const result = await runtime.execute({
        body: JSON.stringify({
          action: "discover",
          actionId: "discover-3",
          idempotencyKey: "discover-3",
          query: "needle",
          maxResults: 5,
        }),
        capability: "runtime-capability-secret",
      });

      expect(result).toEqual({
        status: "failed",
        evidence: [{ kind: "governed-delegate", code: "failed" }],
      });
      expect(repositoryDiscover).toHaveBeenCalledOnce();
      const settled = log.events.find((event) => event.op === "tool-catalog.invocation-settled");
      const fields = settled?.extra as Record<string, unknown> | undefined;
      expect(fields?.status).toBe("failed");
      expect(fields?.reason).toBe("handler-failed");
      expect(fields?.budgetDisposition).toBe("released");
      expect(JSON.stringify(settled)).not.toContain("discover blew up");
    });
  });
});
