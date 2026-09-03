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
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
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

  // A refusal by the verification runner (no project row, missing script trust, nothing runnable)
  // reaches the model under the runner's own closed code and leaves a body-free diagnostic; a bare
  // "failed" made the agent re-run the verifier instead of reporting the blocker (workbench
  // end-to-end run, 2026-09-03).
  //
  // The run id is ALSO the correlation handed to the runner (P2, PR #3381 review): the fixture uses
  // a shape-valid one so this pins the JOIN — the port's own line and every line the runner emits
  // for the same call carry one id — rather than the UNKNOWN_CORRELATION_ID fallback a 5-character
  // fixture id pinned instead, which stayed green with the correlation dropped entirely.
  it("forwards a verification runner refusal as its closed reason code, under the run's own correlation", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const runToReport = vi.fn(() =>
      Promise.reject(
        new VerificationRunnerError(
          "WORKSPACE_TRUST_REQUIRED",
          "Repository package scripts require server-side workspace trust before execution.",
        ),
      ),
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
      authorityRef: { runId: "run-verification-1", envelopeDigest: DIGEST },
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
      verificationRunner: { runToReport },
      diagnostics: { record: (record): void => void records.push(record) },
      onRuntimeEvent: vi.fn(),
    });

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "verification",
          actionId: "verification-1",
          idempotencyKey: "verification-key",
          verifierId: "test",
        }),
      }),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "WORKSPACE_TRUST_REQUIRED" });
    expect(runToReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: "/managed/worktree",
        kinds: ["test"],
        requestId: "verification-1",
        correlationId: "run-verification-1",
      }),
      expect.any(AbortSignal),
    );
    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.verification",
        message: "verification-refused",
        errorClass: "WORKSPACE_TRUST_REQUIRED",
        correlationId: "run-verification-1",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("server-side workspace trust");
  });

  // The two refusals BEFORE the runner is called. Both returned a bare `{ status: "failed" }` with
  // no reason code and no log line, so the model could not tell "do not retry, report this" from
  // "try again" and the activity log had nothing to reconstruct (cursor review, PR #3381).
  it.each([
    ["verifier-unknown", "sentinel-verifier", true, "verification-verifier-unsupported"],
    ["authority-revoked", "test", false, "verification-authority-revoked"],
  ] as const)(
    "refuses a verification before the runner (%s) with a closed reason code and a diagnostic",
    async (_label, verifierId, managedAccessLive, reasonCode) => {
      const records: ServerDiagnosticRecord[] = [];
      const runToReport = vi.fn();
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
        authorityRef: { runId: "run-verification-2", envelopeDigest: DIGEST },
        workspaceRoot: "/managed/worktree",
        // Authority stays valid for decades, so a refusal here can only come from the liveness
        // recheck (or the unknown verifier), never from expiry.
        resolveWorkspaceRootAccess: (): WorkspaceRootAccess | undefined =>
          managedAccessLive ? resolveWorkspaceRootAccess() : undefined,
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        effectiveMode: "autonomous-delivery",
        deploymentCeiling: "autonomous-delivery",
        liveFacts: () => liveFacts,
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
        verificationRunner: { runToReport },
        diagnostics: { record: (record): void => void records.push(record) },
        onRuntimeEvent: vi.fn(),
      });

      await expect(
        facade.execute({
          capability: "opaque-capability",
          body: JSON.stringify({
            action: "verification",
            actionId: "verification-2",
            idempotencyKey: "vkey-2",
            verifierId,
          }),
        }),
      ).resolves.toMatchObject({ status: "failed", reasonCode });
      expect(runToReport).not.toHaveBeenCalled();
      expect(records).toEqual([
        expect.objectContaining({
          operation: "coding-runtime.verification",
          source: "production-managed-worktree-tools.verification",
          message: "verification-refused",
          errorClass: reasonCode,
          correlationId: "run-verification-2",
        }),
      ]);
    },
  );

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
