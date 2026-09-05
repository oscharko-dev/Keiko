import { describe, expect, it, vi } from "vitest";

import type {
  CodeTaskGrantId,
  CommandTaskRunResult,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAuthorityFacts,
  VerificationReport,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayFetchOptions } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type { VerifiedCommitService } from "../gitDelivery/verifiedCommitTypes.js";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import { readySnapshot } from "../gitDelivery/ciObservationTest/_support.js";
import { createResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";

const DIGEST = "a".repeat(64);
const resolveWorkspaceRootAccess = (): WorkspaceRootAccess => ({
  kind: "managed-task" as const,
  canonicalRoot: "/managed/worktree",
  fs: nodeWorkspaceFs,
  repositoryRoot: "/repository",
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
  it("routes a CI tool call to the confirmed-PR observer through the existing facade", async () => {
    const observe = vi.fn<CiObservationService["observe"]>(() =>
      Promise.resolve({ status: "observed", snapshot: readySnapshot(), retryAfterMs: 0 }),
    );
    const facade = verificationFacade({
      runToReport: vi.fn(),
      records: [],
      ciObservationService: { observe },
    });
    const result = await facade.execute({
      capability: "runtime-capability",
      body: JSON.stringify({
        action: "git",
        operation: "ci",
        actionId: "ci-1",
        idempotencyKey: "ci-1",
      }),
    });
    expect(result).toMatchObject({
      status: "completed",
      ci: { status: "observed", snapshot: readySnapshot() },
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith();
  });
  it("keeps an unavailable CI backend explicit and rejects model-selected PR targets", async () => {
    const facade = verificationFacade({ runToReport: vi.fn(), records: [] });
    const request = { action: "git", operation: "ci", actionId: "ci-1", idempotencyKey: "ci-1" };
    expect(
      await facade.execute({ capability: "runtime-capability", body: JSON.stringify(request) }),
    ).toMatchObject({ status: "failed", reasonCode: "capability-backend-unavailable" });
    expect(
      await facade.execute({
        capability: "runtime-capability",
        body: JSON.stringify({ ...request, prNumber: 99 }),
      }),
    ).toMatchObject({ status: "invalid" });
  });
  it("does not publish or complete verification after its repair lease expires in the runner", async () => {
    let repairLive = true;
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const records: ServerDiagnosticRecord[] = [];
    const completeVerification = vi.fn<VerifiedCommitService["completeVerification"]>(() =>
      Promise.resolve(true),
    );
    const service = { ...verificationService(), completeVerification };
    const settle = vi.fn();
    const facade = verificationFacade({
      records,
      events,
      verifiedCommitService: service,
      ciRepairBudget: {
        admitTool: () => ({ check: (): boolean => repairLive, settle }),
        chargePrompt: () => true,
        observed: vi.fn(),
      },
      runToReport: async () => {
        await Promise.resolve();
        repairLive = false;
        return verificationReport("passed");
      },
    });
    expect(
      await facade.execute({
        capability: "runtime-capability",
        body: JSON.stringify({
          action: "verification",
          verifierId: "test",
          actionId: "late",
          idempotencyKey: "late",
        }),
      }),
    ).toMatchObject({ status: "failed" });
    expect(completeVerification).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "coding-runtime.verification",
        errorClass: "verification-authority-revoked",
      }),
    );
    expect(settle).toHaveBeenCalledOnce();
  });
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

  // Only a run that executed and went RED is a red run. VERIFICATION_FAILED used to be the answer
  // for every non-passed status, so a cancelled, skipped, denied, timed-out or resource-exceeded
  // run told the model its tests had failed and sent it back to code that was fine (PR #3381
  // review). One row per non-passed status, so a status losing its own code fails here.
  it.each([
    ["failed", "VERIFICATION_FAILED"],
    ["timed-out", "VERIFICATION_TIMED_OUT"],
    ["resource-exceeded", "VERIFICATION_RESOURCE_EXCEEDED"],
    ["skipped", "VERIFICATION_NOT_RUN"],
    ["denied", "VERIFICATION_NOT_RUN"],
    ["cancelled", "VERIFICATION_NOT_RUN"],
  ] as const satisfies readonly (readonly [Exclude<VerificationStatus, "passed">, string])[])(
    "answers a %s verification outcome with its own closed reason code",
    async (overallStatus, reasonCode) => {
      const facade = verificationFacade({
        runToReport: () => Promise.resolve(verificationReport(overallStatus)),
        records: [],
      });

      await expect(
        facade.execute({
          capability: "opaque-capability",
          body: JSON.stringify({
            action: "verification",
            actionId: "verification-outcome",
            idempotencyKey: "verification-outcome-key",
            verifierId: "test",
          }),
        }),
      ).resolves.toMatchObject({ status: "failed", reasonCode });
    },
  );

  it("reports a passed run as completed", async () => {
    const facade = verificationFacade({
      runToReport: () => Promise.resolve(verificationReport("passed")),
      records: [],
    });

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "verification",
          actionId: "verification-passed",
          idempotencyKey: "verification-passed-key",
          verifierId: "test",
        }),
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  // `Error.name` is a writable own property; a library that assigns a message or a path to it would
  // put that text on the `[keiko-server:diagnostic]` stderr line and the activity log's `errorKind`
  // verbatim, because the sink redacts neither. The repository's own hardening
  // (`contentFreeErrorClass`) is what refuses it, and this port has to go through it like every
  // other producer (PR #3381 review).
  it("degrades an overridden error name to the declared class on a non-runner verification throw", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const hostile = new Error("boom");
    hostile.name = "SENSITIVE-/Users/someone/.env-leaked-through-error-name";
    const facade = verificationFacade({ runToReport: () => Promise.reject(hostile), records });

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "verification",
          actionId: "verification-hostile",
          idempotencyKey: "verification-hostile-key",
          verifierId: "test",
        }),
      }),
    ).resolves.toEqual({
      status: "failed",
      evidence: [{ kind: "governed-delegate", code: "failed" }],
    });
    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.verification",
        source: "production-managed-worktree-tools.verification",
        message: "verification-failed",
        errorClass: "Error",
        correlationId: "run-verification-3",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("SENSITIVE");
    expect(JSON.stringify(records)).not.toContain("boom");
  });

  it("revokes liveness the instant resolveWorkspaceRootAccess stops proving managed authority, even before expiry (#3347)", async () => {
    let access: ReturnType<typeof resolveWorkspaceRootAccess> | undefined = {
      kind: "managed-task" as const,
      canonicalRoot: "/managed/worktree",
      fs: nodeWorkspaceFs,
      repositoryRoot: "/repository",
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
    ["delivery", { intent: "commit", phase: "propose", message: "feat: reviewed candidate" }],
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

function verificationReport(overallStatus: VerificationStatus): VerificationReport {
  return {
    workspaceRoot: "/managed/worktree",
    results: [],
    overallStatus,
    startedAtMs: 1,
    durationMs: 2,
    counts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
  };
}

// The minimal live-and-authorized verification wiring: authority granted, managed access proven,
// expiry decades away, so every refusal these tests observe comes from the run OUTCOME (or the
// thrown error) and never from a liveness or policy check.
function verificationFacade(options: {
  readonly ciRepairBudget?: CiRepairExecutionBudget;
  readonly verifiedCommitService?: VerifiedCommitService;
  readonly events?: CodingWorkbenchRuntimeEvent[];
  readonly ciObservationService?: CiObservationService;
  readonly runToReport: () => Promise<VerificationReport>;
  readonly records: ServerDiagnosticRecord[];
}): ReturnType<typeof createProductionManagedWorktreeToolFacade> {
  return createProductionManagedWorktreeToolFacade({
    ...(options.ciRepairBudget === undefined ? {} : { ciRepairBudget: options.ciRepairBudget }),
    ...(options.verifiedCommitService === undefined
      ? {}
      : { verifiedCommitService: options.verifiedCommitService }),
    ...(options.ciObservationService === undefined
      ? {}
      : { ciObservationService: options.ciObservationService }),
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
    authorityRef: { runId: "run-verification-3", envelopeDigest: DIGEST },
    workspaceRoot: "/managed/worktree",
    resolveWorkspaceRootAccess,
    authorityExpiresAt: "2099-01-01T00:00:00.000Z",
    effectiveMode: "autonomous-delivery",
    deploymentCeiling: "autonomous-delivery",
    liveFacts: () => ({
      ...FACTS,
      actionClasses: ["workspace-read", "workspace-write", "verification", "command-execution"],
    }),
    secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: false, reason: "denied" }) },
    editorAgentClient: {
      action: () =>
        Promise.resolve({
          ok: false as const,
          error: { kind: "route" as const, code: "denied", message: "denied" },
        }),
    },
    invocationRegistry: createCodingToolInvocationRegistry(),
    verificationRunner: { runToReport: options.runToReport },
    diagnostics: { record: (record): void => void options.records.push(record) },
    onRuntimeEvent: (event): void => {
      options.events?.push(event);
    },
  });
}

function verificationService(): VerifiedCommitService {
  return {
    beginVerification: vi.fn(() => Promise.resolve({})),
    completeVerification: vi.fn(() => Promise.resolve(true)),
    propose: vi.fn(),
    approve: vi.fn(),
    issueApproval: vi.fn(),
    execute: vi.fn(),
    matchesApproval: vi.fn(),
    consumeApproval: vi.fn(),
    executeApproved: vi.fn(),
    review: vi.fn(),
    invalidate: vi.fn(),
    reconcile: vi.fn(),
  };
}

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
