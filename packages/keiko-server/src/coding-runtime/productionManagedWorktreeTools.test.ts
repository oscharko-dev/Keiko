import { describe, expect, it, vi } from "vitest";

import type {
  CodeTaskGrantId,
  CommandTaskRunResult,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAuthorityFacts,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayFetchOptions } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import { createResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";

const DIGEST = "a".repeat(64);
const resolveWorkspaceRootAccess = (): WorkspaceRootAccess => ({
  kind: "managed-task" as const,
  canonicalRoot: "/managed/worktree",
  fs: nodeWorkspaceFs,
});
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
      resolveWorkspaceRootAccess,
      authorityExpiresAt: "2099-01-01T00:00:00.000Z",
      effectiveMode: "supervised-coding",
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

  it.each([
    ["governed-assist", true],
    ["supervised-coding", true],
    ["autonomous-delivery", false],
  ] as const)(
    "derives editor review policy for %s (requiresReview=%s)",
    async (effectiveMode: CodingWorkbenchMode, requiresReview: boolean) => {
      const register = vi.fn((): boolean => true);
      const facade = createProductionManagedWorktreeToolFacade({
        authority: {
          revalidateCapabilityForMutation: () => ({
            ok: true as const,
            envelope: authorizedEnvelope(),
          }),
          resolveCapabilityForDelegation: () => ({
            ok: true as const,
            envelope: authorizedEnvelope(),
          }),
        },
        authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
        workspaceRoot: "/managed/worktree",
        resolveWorkspaceRootAccess,
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        effectiveMode,
        deploymentCeiling: "autonomous-delivery",
        liveFacts: () => FACTS,
        secureWorkspaceTextRead: {
          readText: () => Promise.resolve({ ok: false, reason: "denied" }),
        },
        editorAgentClient: {
          action: (action) =>
            Promise.resolve({
              ok: true as const,
              value: {
                result: {
                  schemaVersion: "1" as const,
                  actionId: action.actionId,
                  sessionId: action.sessionId,
                  status: "queued" as const,
                },
              },
            }),
        },
        mutationLeaseCoordinator: { register, discard: vi.fn((): boolean => true) },
        invocationRegistry: createCodingToolInvocationRegistry(),
        verificationRunner: { runToReport: vi.fn() },
        onRuntimeEvent: vi.fn(),
      });

      await expect(
        facade.execute({
          capability: "opaque-capability",
          body: JSON.stringify({
            action: "edit",
            actionId: "edit-1",
            idempotencyKey: "edit-key-1",
            changeset: {
              patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
              files: [{ file: "src/a.ts", expectedContentHash: DIGEST }],
            },
          }),
        }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ requiresReview }));
    },
  );

  it("threads live proxy and CA settings into the governed research transport", async () => {
    const registry = createResearchGrantRegistry();
    const now = Date.now();
    registry.register(
      "run-1",
      {
        grantId: "grant-1" as CodeTaskGrantId,
        domains: ["docs.example.org"],
        expiresAt: new Date(now + 60_000).toISOString(),
        queryTextDigest: { outcome: "absent" },
      },
      undefined,
      DIGEST,
      now,
    );
    const calls: GatewayFetchOptions[] = [];
    const facade = createProductionManagedWorktreeToolFacade({
      authority: {
        revalidateCapabilityForMutation: () => ({
          ok: true as const,
          envelope: authorizedEnvelope(true),
        }),
        resolveCapabilityForDelegation: () => ({
          ok: true as const,
          envelope: authorizedEnvelope(true),
        }),
      },
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      workspaceRoot: "/managed/worktree",
      resolveWorkspaceRootAccess,
      authorityExpiresAt: "2099-01-01T00:00:00.000Z",
      effectiveMode: "supervised-coding",
      deploymentCeiling: "supervised-coding",
      liveFacts: () => ({ ...FACTS, actionClasses: [...FACTS.actionClasses, "network-egress"] }),
      secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: false, reason: "denied" }) },
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
      researchGrantRegistry: registry,
      gatewayEgress: () => ({
        httpsProxy: "https://proxy.example",
        httpProxy: "http://proxy.example",
        noProxy: ["docs.example.org"],
        caBundlePath: "/etc/keiko/ca.pem",
      }),
      researchFetchImpl: (_url, options) => {
        calls.push(options);
        return Promise.resolve(new Response("ok", { status: 200 }));
      },
    });

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "egress",
          actionId: "research-1",
          idempotencyKey: "research-key-1",
          target: "https://docs.example.org/",
        }),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(calls[0]?.egress).toMatchObject({
      httpsProxy: "https://proxy.example",
      httpProxy: "http://proxy.example",
      noProxy: ["docs.example.org"],
      caBundlePath: "/etc/keiko/ca.pem",
      denyLoopback: true,
    });
  });

  it("completes a governed command through production wiring", async () => {
    const execute = vi.fn((): Promise<CommandTaskRunResult> =>
      Promise.resolve({
        schemaVersion: "1",
        runId: "command-run-1",
        taskId: "npm-script:test",
        kind: "test",
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        failureReason: "none",
        stdout: "",
        stderr: "",
      }),
    );
    const liveFacts: CodingWorkbenchRuntimeAuthorityFacts = {
      ...FACTS,
      actionClasses: ["workspace-read", "workspace-write", "verification", "command-execution"],
    };
    const facade = createProductionManagedWorktreeToolFacade({
      authority: {
        revalidateCapabilityForMutation: () => ({
          ok: true as const,
          envelope: authorizedEnvelope(true),
        }),
        resolveCapabilityForDelegation: () => ({
          ok: true as const,
          envelope: authorizedEnvelope(true),
        }),
      },
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      workspaceRoot: "/managed/worktree",
      resolveWorkspaceRootAccess,
      authorityExpiresAt: "2099-01-01T00:00:00.000Z",
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      liveFacts: () => liveFacts,
      secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: false, reason: "denied" }) },
      editorAgentClient: {
        action: () =>
          Promise.resolve({
            ok: false as const,
            error: { kind: "route" as const, code: "denied", message: "denied" },
          }),
      },
      invocationRegistry: createCodingToolInvocationRegistry(),
      commandRunner: { execute },
      verificationRunner: { runToReport: vi.fn() },
      onRuntimeEvent: vi.fn(),
    });

    const controller = new AbortController();
    await expect(
      facade.execute({
        capability: "opaque-capability",
        signal: controller.signal,
        body: JSON.stringify({
          action: "command",
          actionId: "command-1",
          idempotencyKey: "command-key",
          commandId: "npm-script:test",
        }),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "/managed/worktree",
        taskId: "npm-script:test",
        requestId: "command-1",
        signal: controller.signal,
        timeoutMs: 10_000,
      }),
    );
  });

  it("revokes liveness the instant resolveWorkspaceRootAccess stops proving managed authority, even before expiry (#3347)", async () => {
    let access: ReturnType<typeof resolveWorkspaceRootAccess> | undefined = {
      kind: "managed-task" as const,
      canonicalRoot: "/managed/worktree",
      fs: nodeWorkspaceFs,
    };
    const execute = vi.fn((): Promise<CommandTaskRunResult> =>
      Promise.resolve({
        schemaVersion: "1",
        runId: "command-run-1",
        taskId: "npm-script:test",
        kind: "test",
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        failureReason: "none",
        stdout: "",
        stderr: "",
      }),
    );
    const liveFacts: CodingWorkbenchRuntimeAuthorityFacts = {
      ...FACTS,
      actionClasses: ["workspace-read", "workspace-write", "verification", "command-execution"],
    };
    const facade = createProductionManagedWorktreeToolFacade({
      authority: {
        revalidateCapabilityForMutation: () => ({
          ok: true as const,
          envelope: authorizedEnvelope(true),
        }),
        resolveCapabilityForDelegation: () => ({
          ok: true as const,
          envelope: authorizedEnvelope(true),
        }),
      },
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      workspaceRoot: "/managed/worktree",
      resolveWorkspaceRootAccess: () => access,
      // Authority stays valid for decades: only resolveWorkspaceRootAccess flips, so a status
      // change here can only be attributed to the new liveness check, never to expiry.
      authorityExpiresAt: "2099-01-01T00:00:00.000Z",
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      liveFacts: () => liveFacts,
      secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: false, reason: "denied" }) },
      editorAgentClient: {
        action: () =>
          Promise.resolve({
            ok: false as const,
            error: { kind: "route" as const, code: "denied", message: "denied" },
          }),
      },
      invocationRegistry: createCodingToolInvocationRegistry(),
      commandRunner: { execute },
      verificationRunner: { runToReport: vi.fn() },
      onRuntimeEvent: vi.fn(),
    });

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "command",
          actionId: "command-1",
          idempotencyKey: "command-key-1",
          commandId: "npm-script:test",
        }),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(execute).toHaveBeenCalledOnce();

    // Simulate mid-run revocation: lifecycle state or gitdir identity no longer proves managed
    // authority (the resolver re-checks both on every call), even though authorityExpiresAt has
    // not been reached.
    access = undefined;

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "command",
          actionId: "command-2",
          idempotencyKey: "command-key-2",
          commandId: "npm-script:test",
        }),
      }),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "command-authority-revoked" });
    // The command backend must never have been re-invoked once liveness flipped to false.
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["git", { operation: "read" }],
    ["delivery", { intent: "commit" }],
    ["connector", { scope: "source-control.read" }],
  ] as const)(
    "fails closed when the governed %s backend is unavailable",
    async (action, detail) => {
      const facade = createProductionManagedWorktreeToolFacade({
        authority: {
          revalidateCapabilityForMutation: () => ({
            ok: true as const,
            envelope: authorizedEnvelope(true),
          }),
          resolveCapabilityForDelegation: () => ({
            ok: true as const,
            envelope: authorizedEnvelope(true),
          }),
        },
        authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
        workspaceRoot: "/managed/worktree",
        resolveWorkspaceRootAccess,
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        effectiveMode: "autonomous-delivery",
        deploymentCeiling: "autonomous-delivery",
        liveFacts: () => ({
          ...FACTS,
          actionClasses: [
            "workspace-read",
            "workspace-write",
            "verification",
            "delivery-substrate",
            "connector-access",
            "network-egress",
          ],
          connectorScopes: ["source-control.read", "source-control.write"],
        }),
        secureWorkspaceTextRead: {
          readText: () => Promise.resolve({ ok: false, reason: "denied" }),
        },
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

      await expect(
        facade.execute({
          capability: "opaque-capability",
          body: JSON.stringify({
            action,
            actionId: `${action}-1`,
            idempotencyKey: `${action}-key`,
            ...detail,
          }),
        }),
      ).resolves.toMatchObject({
        status: "failed",
        reasonCode: "capability-backend-unavailable",
      });
    },
  );
});

function authorizedEnvelope(network = false): never {
  return {
    authority: {
      effectiveMode: "autonomous-delivery",
      actionClasses: [
        "workspace-read",
        "workspace-write",
        "verification",
        "command-execution",
        "delivery-substrate",
        "connector-access",
        ...(network ? ["network-egress"] : []),
      ],
      connectorScopes: ["source-control.read", "source-control.write"],
      commandPolicy: {
        mode: "allowlisted",
        allow: ["npm-script:test"],
        deny: [],
        maxCommandTimeoutMs: 10_000,
        requirePerCommandApproval: false,
      },
      networkPolicy: {
        mode: network ? "governed-egress" : "deny-all",
        allowLoopback: false,
        connectorScopes: network ? ["source-control.read", "source-control.write"] : [],
      },
    },
  } as never;
}
