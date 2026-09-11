import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodeTaskGrantId,
  CommandTaskRunResult,
  CodingWorkbenchAuxiliaryStatus,
  CodingWorkbenchMode,
  CodingWorkbenchOperatorDecision,
  CodingWorkbenchRuntimeAuthorityFacts,
  VerificationReport,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayFetchOptions } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { GitWorktreeReadError } from "@oscharko-dev/keiko-tools/internal/git-worktree-snapshot-node";
import { GitRawWorktreeReadError } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import {
  VerificationRunnerError,
  WorkspaceTrustRequiredError,
} from "../editor/verificationRunnerErrors.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  createProductionManagedWorktreeToolFacade,
  codingVerificationTargetDigest,
  deriveOptionalToolAvailability,
  recordProposalApprovalResolutionFailure,
  resolveChildModelForRun,
  waitForRuntimeProposalApproval,
  waitForWorkspaceScriptTrust,
  verificationLivenessRefusal,
  SCRIPT_TRUST_WAIT_CEILING_MS,
  type ProductionManagedWorktreeToolInput,
} from "./productionManagedWorktreeTools.js";
import { dependencyBootstrapFailureSummary } from "./codingToolIpc.js";
import { CODING_TOOL_INVOCATION_MAX_TTL_MS } from "./codingToolInvocationRegistry.js";
import type { SkillCatalog } from "./skillCatalog.js";
import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import type {
  VerifiedCommitProposal,
  VerifiedCommitService,
} from "../gitDelivery/verifiedCommitTypes.js";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import { readySnapshot } from "../gitDelivery/ciObservationTest/_support.js";
import { createResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import type { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import {
  createVerificationRunnerManager,
  type VerificationExecutePort,
  type ScriptTrustDecision,
  type VerificationRunnerManager,
  type VerificationRunInput,
} from "../editor/verificationRunner.js";
import type { VerificationStepOutput } from "@oscharko-dev/keiko-verification";
import { createInMemoryUiStore } from "../store/index.js";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createGeneratedOpenCodeBundle } from "./opencodeRuntimeAdapter.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../observability/index.js";

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
  it("settles a detached approval wait when live proposal review fails closed", async () => {
    const activity: ServerLogEvent[] = [];
    const diagnostics: ServerDiagnosticRecord[] = [];
    const failure = new Error("PRIVATE_WORKSPACE_PATH_SENTINEL");
    const probe = {
      review: (): never => {
        throw failure;
      },
      matchesApproval: vi.fn(() => false),
    };

    await expect(
      waitForRuntimeProposalApproval(probe, "proposal-drift", undefined, (error) => {
        recordProposalApprovalResolutionFailure(
          {
            authorityRef: { runId: "run-proposal-drift", envelopeDigest: DIGEST },
            activityLog: { write: (event): void => void activity.push(event) },
            diagnostics: { record: (record): void => void diagnostics.push(record) },
          },
          "commit",
          "proposal-drift",
          error,
        );
      }),
    ).resolves.toBe("unavailable");
    expect(activity).toEqual([
      expect.objectContaining({
        op: "coding-runtime.tool-result",
        correlationId: "run-proposal-drift",
        errorKind: "Error",
        extra: expect.objectContaining({
          actionKind: "commit",
          proposalId: "proposal-drift",
          state: "approval-wait-failed",
          reason: "authority-resolution-failed",
          frames: expect.any(Array) as unknown,
          causeChain: expect.any(Array) as unknown,
        }) as unknown,
      }),
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.tool-result",
        correlationId: "run-proposal-drift",
        errorClass: "Error",
        message: "runtime-approval-resolution-failed",
      }),
    ]);
    expect(JSON.stringify({ activity, diagnostics })).not.toContain(
      "PRIVATE_WORKSPACE_PATH_SENTINEL",
    );
    expect(probe.matchesApproval).not.toHaveBeenCalled();
  });

  it("holds an approval-required stage proposal until its exact approval is issued", async () => {
    vi.useFakeTimers();
    try {
      let approved = false;
      const proposal = {
        kind: "stage" as const,
        proposalId: "stage-3384",
        status: "approval-required" as const,
        reason: "approval-required" as const,
        pathCount: 1,
      };
      const requestStageApproval = vi.fn();
      const log: ServerLogEvent[] = [];
      const service = {
        execute: vi.fn(() => Promise.resolve(proposal)),
        review: vi.fn(() => proposal),
        matchesApproval: vi.fn(() => approved),
      } as unknown as RuntimeGitService;
      const facade = verificationFacade({
        runToReport: vi.fn(),
        records: [],
        runtimeGitService: service,
        requestStageApproval,
        log,
      });

      const pending = facade.execute({
        capability: "runtime-capability",
        body: JSON.stringify({
          action: "git",
          operation: "stage",
          phase: "propose",
          paths: ["src/index.ts"],
          actionId: "stage-1",
          idempotencyKey: "stage-1",
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestStageApproval).toHaveBeenCalledExactlyOnceWith("stage-3384");
      let settled = false;
      void pending.then((): void => {
        settled = true;
      });
      expect(settled).toBe(false);

      approved = true;
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toMatchObject({
        status: "completed",
        git: { proposalId: "stage-3384", status: "ready", reason: "none" },
      });
      expect(log).toContainEqual(
        expect.objectContaining({
          op: "coding-runtime.tool-result",
          correlationId: "run-verification-3",
          extra: {
            actionKind: "git-stage",
            proposalId: "stage-3384",
            state: "approval-wait-settled",
            reason: "approved",
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Coding Workbench run 13 (2026-09-10): the runtime Git service answered `undefined` for every
  // refusal it could not express as a Git result, and this port turned each one into
  // `git-authority-revoked`. A stage proposal refused for its size therefore told the model its Git
  // authority was gone, and the model stopped delivering. The service now names its refusal; only
  // `authority-revoked` may keep that code, and the two the model can act on carry guidance.
  it.each([
    ["authority-revoked", "git-authority-revoked", false],
    ["proposal-unknown", "git-proposal-unknown", true],
    ["execution-failed", "git-execution-failed", true],
  ] as const)(
    "reports a %s refusal of the runtime Git service as %s",
    async (reason, reasonCode, coached) => {
      const service = {
        execute: vi.fn(() => Promise.resolve({ kind: "refused", reason })),
      } as unknown as RuntimeGitService;
      const facade = verificationFacade({
        runToReport: vi.fn(),
        records: [],
        runtimeGitService: service,
      });
      const result = await facade.execute({
        capability: "runtime-capability",
        body: JSON.stringify({
          action: "git",
          operation: "stage",
          phase: "execute",
          proposalId: "stage-3384",
          actionId: "stage-redeem",
          idempotencyKey: "stage-redeem",
        }),
      });
      expect(result).toMatchObject({ status: "failed", reasonCode });
      expect("guidance" in result).toBe(coached);
    },
  );

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
  // #3388: keiko_ci_status's bounded optional forceFresh threads through to the observer exactly
  // as supplied -- an omitted forceFresh keeps calling observe() with no argument at all (the
  // prior test pins that shape), never an explicit `undefined`.
  it("forwards an explicit forceFresh to the CI observer", async () => {
    const observe = vi.fn<CiObservationService["observe"]>(() =>
      Promise.resolve({ status: "observed", snapshot: readySnapshot(), retryAfterMs: 0 }),
    );
    const facade = verificationFacade({
      runToReport: vi.fn(),
      records: [],
      ciObservationService: { observe },
    });
    await facade.execute({
      capability: "runtime-capability",
      body: JSON.stringify({
        action: "git",
        operation: "ci",
        actionId: "ci-2",
        idempotencyKey: "ci-2",
        forceFresh: true,
      }),
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith(true);
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
        canChargePrompt: () => true,
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
        // The lapsed repair lease is a GUARD rejection; the diagnostic says so (run 12, 2026-09-10).
        code: "guard-rejected",
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
        mutationLeaseCoordinator: {
          register,
          discard: vi.fn((): boolean => true),
          waitForMutation: () => Promise.resolve("succeeded"),
        },
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

  it("returns bounded actionable diagnostics for a failed verifier without exposing its workspace root", async () => {
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const facade = verificationFacade({
      runToReport: () => Promise.resolve(failedVerificationReport()),
      records: [],
      events,
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-diagnostics",
        idempotencyKey: "verification-diagnostics-key",
        verifierId: "test",
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      reasonCode: "VERIFICATION_FAILED",
      verificationFailure: {
        summary: "test failed; 1 structured failure location",
        locations: [
          {
            file: "ci/numerical-stability.test.js",
            line: 19,
            column: 5,
            message: "expected the stable average to remain finite",
          },
        ],
        truncated: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("/managed/worktree");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FAILURE_CANARY");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "verification-summarized",
        failureLocationCount: 1,
        failureLocationsTruncated: true,
        verificationTargetDigest: codingVerificationTargetDigest("test"),
      }),
    );
  });

  // #3452: modelVerificationFailure/stepFailure/dependencyBootstrapFailure match a failureOutput
  // entry to the step it names (kind + scriptName), or to "dependencies" when the bootstrap itself
  // failed, and attach only that excerpt to the model-facing failure.
  it("attaches the failed step's matching failureOutput excerpt to verificationFailure.excerpt", async () => {
    const facade = verificationFacade({
      runToReport: () => Promise.resolve(failedVerificationReport()),
      failureOutput: [
        { step: "test", scriptName: "test", excerpt: "1 test failed: expected true, got false" },
      ],
      records: [],
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-excerpt",
        idempotencyKey: "verification-excerpt-key",
        verifierId: "test",
      }),
    });

    if (result.status !== "failed") throw new Error("expected a failed verification result");
    expect(result.verificationFailure?.excerpt).toBe("1 test failed: expected true, got false");
  });

  // The producer half of the bootstrap-failure pin; the facade half is
  // codingToolFacade.dependencyFailure.test.ts. A failed dependency install reaches the model with its
  // closed summary, the install's own output excerpt and the dependency record. Before bb585534a the
  // summary carried free text, the facade's closed admission refused it, and the whole failure
  // (reason, excerpt and record) was dropped before the model saw it (found by this test pass).
  it("forwards a failed dependency bootstrap to the model with its summary, excerpt and record", async () => {
    const dependencies = {
      state: "failed",
      lockfile: "absent",
      exitCode: 1,
      durationMs: 900,
      detail: "npm install failed (exit 1)",
    } as const;
    const facade = verificationFacade({
      runToReport: () =>
        Promise.resolve({ ...verificationReport("failed"), results: [], dependencies }),
      failureOutput: [
        { step: "dependencies", scriptName: undefined, excerpt: "npm ERR! code E404" },
      ],
      records: [],
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-bootstrap",
        idempotencyKey: "verification-bootstrap-key",
        verifierId: "test",
      }),
    });

    if (result.status !== "failed") throw new Error("expected a failed verification result");
    expect(result.verificationFailure).toEqual({
      summary: dependencyBootstrapFailureSummary("failed"),
      locations: [],
      truncated: false,
      excerpt: "npm ERR! code E404",
      dependencies,
    });
  });

  it("does not attach an excerpt captured for a different step", async () => {
    const facade = verificationFacade({
      runToReport: () => Promise.resolve(failedVerificationReport()),
      failureOutput: [
        { step: "lint", scriptName: "lint", excerpt: "unrelated lint failure output" },
      ],
      records: [],
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-mismatched-excerpt",
        idempotencyKey: "verification-mismatched-excerpt-key",
        verifierId: "test",
      }),
    });

    if (result.status !== "failed") throw new Error("expected a failed verification result");
    expect(result.verificationFailure?.excerpt).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("unrelated lint failure output");
  });

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

    const result = await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "egress",
        actionId: "research-1",
        idempotencyKey: "research-key-1",
        target: "https://docs.example.org/",
      }),
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(calls[0]?.egress).toMatchObject({
      httpsProxy: "https://proxy.example",
      httpProxy: "http://proxy.example",
      noProxy: ["docs.example.org"],
      caBundlePath: "/etc/keiko/ca.pem",
      denyLoopback: true,
    });
  });

  // ADR-0147 D3, autonomous-delivery amendment (owner decision, 2026-09-10): a completed governed
  // effect in `autonomous-delivery` admits the worktree's current manifest for the run; a failed
  // effect admits nothing, and the two modes that ask before risky work never admit.
  it.each([
    ["autonomous-delivery", "none", 1],
    ["autonomous-delivery", "timed-out", 0],
    ["autonomous-delivery", "non-zero-exit", 0],
    ["supervised-coding", "none", 0],
    ["governed-assist", "none", 0],
  ] as const)(
    "admits the run's manifest after a completed command in %s (failure %s → %d admission)",
    async (mode, failureReason, admissions) => {
      const admitRunManifest = vi.fn();
      const execute = vi.fn((): Promise<CommandTaskRunResult> =>
        Promise.resolve({
          schemaVersion: "1",
          runId: "command-run-1",
          taskId: "npm-script:test",
          kind: "test",
          exitCode: failureReason === "none" ? 0 : 1,
          durationMs: 1,
          truncated: false,
          timedOut: failureReason === "timed-out",
          failureReason,
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
        effectiveMode: mode,
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
        commandRunner: { execute },
        verificationRunner: { runToReport: vi.fn() },
        admitRunManifest,
        onRuntimeEvent: vi.fn(),
      });

      await facade.execute({
        capability: "runtime-capability",
        body: JSON.stringify({
          action: "command",
          commandId: "npm-script:test",
          actionId: "command-1",
          idempotencyKey: "command-1",
        }),
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(admitRunManifest).toHaveBeenCalledTimes(admissions);
    },
  );

  // Same admittingRunManifest wrapper as the command port above, applied to the edit port: a
  // completed edit effect in `autonomous-delivery` admits the run's manifest, a failed one admits
  // nothing (ADR-0147 D3, autonomous-delivery amendment, owner decision 2026-09-10).
  function baseEditAdmissionInput(): Omit<
    ProductionManagedWorktreeToolInput,
    "editorAgentClient" | "admitRunManifest" | "onRuntimeEvent"
  > {
    return {
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
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      liveFacts: () => FACTS,
      secureWorkspaceTextRead: {
        readText: () => Promise.resolve({ ok: false, reason: "denied" }),
      },
      // registerMutationLease requires a coordinator once a producer binding is present (it is,
      // via liveFacts) — its absence is a silent EDIT_PREPARE_FAILED before the mocked editor
      // action ever runs, never a signal about the edit outcome under test.
      mutationLeaseCoordinator: {
        register: () => true,
        discard: () => true,
        waitForMutation: () => Promise.resolve("succeeded"),
      },
      invocationRegistry: createCodingToolInvocationRegistry(),
      verificationRunner: { runToReport: vi.fn() },
    };
  }

  it.each([
    ["completed", 1],
    ["failed", 0],
  ] as const)(
    "admits the run's manifest after a %s edit in autonomous-delivery (→ %d admission)",
    async (outcome, admissions) => {
      const admitRunManifest = vi.fn();
      const action = vi.fn(() =>
        outcome === "completed"
          ? Promise.resolve({
              ok: true as const,
              value: {
                result: {
                  schemaVersion: "1" as const,
                  actionId: "edit-1",
                  sessionId: "session-1",
                  status: "queued" as const,
                },
              },
            })
          : Promise.resolve({
              ok: false as const,
              error: { kind: "route" as const, code: "denied", message: "denied" },
            }),
      );
      const facade = createProductionManagedWorktreeToolFacade({
        ...baseEditAdmissionInput(),
        editorAgentClient: { action },
        admitRunManifest,
        onRuntimeEvent: vi.fn(),
      });

      await facade.execute({
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
      });
      expect(action).toHaveBeenCalledOnce();
      expect(admitRunManifest).toHaveBeenCalledTimes(admissions);
    },
  );

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

  it("runs targeted-test against the exact bounded target and logs only its digest", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-targeted-tool-")));
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ name: "targeted-fixture", devDependencies: { vitest: "^3.0.0" } })}\n`,
    );
    writeFileSync(join(workspaceRoot, "src", "math.test.ts"), "export {};\n");
    const execute = vi.fn<VerificationExecutePort>((args) =>
      Promise.resolve({
        report: { ...verificationReport("passed"), workspaceRoot: args.workspace.root },
        probe: { available: true, backend: "test-backend" },
      }),
    );
    const store = createInMemoryUiStore();
    store.createProject(workspaceRoot, "targeted-fixture");
    const manager = createVerificationRunnerManager({
      store,
      evidenceStore: createInMemoryEvidenceStore(),
      execute,
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task",
        canonicalRoot: workspaceRoot,
        repositoryRoot: workspaceRoot,
        fs: nodeWorkspaceFs,
      }),
    });
    const log: ServerLogEvent[] = [];
    const facade = verificationFacade({
      runToReport: (input, signal) =>
        manager.runToReport(input, signal).then((outcome) => outcome.report),
      records: [],
      log,
      workspaceRoot,
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-targeted",
        idempotencyKey: "verification-targeted-key",
        verifierId: "targeted-test",
        targetPath: "src/math.test.ts",
      }),
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        plan: {
          workspaceRoot,
          steps: [
            expect.objectContaining({
              kind: "targeted-test",
              command: "npx",
              args: ["vitest", "run", "src/math.test.ts"],
            }),
          ],
        },
      }),
    );
    expect(log).toContainEqual(
      expect.objectContaining({
        op: "coding-runtime.verification",
        correlationId: "run-verification-3",
        extra: {
          state: "target-bound",
          verifierId: "targeted-test",
          targetCount: 1,
          targetPathSha256: createHash("sha256").update("src/math.test.ts").digest("hex"),
        },
      }),
    );
    expect(JSON.stringify(log)).not.toContain("src/math.test.ts");
    store.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("writes the body-free target binding through the production process sink fallback", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      const facade = verificationFacade({
        runToReport: () => Promise.resolve(verificationReport("passed")),
        records: [],
      });
      await facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "verification",
          actionId: "verification-target-log",
          idempotencyKey: "verification-target-log-key",
          verifierId: "targeted-test",
          targetPath: "src/math.test.ts",
        }),
      });
      const targetEvent = sink.events.find(
        (event) =>
          event.op === "coding-runtime.verification" && event.extra?.state === "target-bound",
      );
      expect(targetEvent).toMatchObject({
        correlationId: "run-verification-3",
        extra: {
          state: "target-bound",
          targetCount: 1,
          targetPathSha256: createHash("sha256").update("src/math.test.ts").digest("hex"),
        },
      });
      expect(JSON.stringify(sink.events)).not.toContain("src/math.test.ts");
    } finally {
      resetServerLogger();
    }
  });

  it("routes the generated native target through IPC, catalog admission, and the real verifier port", async () => {
    const runToReport = vi.fn(() => Promise.resolve(verificationReport("passed")));
    const facade = verificationFacade({ runToReport, records: [] });
    const tool = loadGeneratedVerificationTool((_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected generated request body");
      return facade
        .execute({ capability: "runtime-capability", body: init.body })
        .then((result) => new Response(JSON.stringify(result)));
    });
    await tool.execute(
      { verifierId: "targeted-test", targetPath: "src/math.test.ts" },
      generatedToolContext("native-targeted"),
    );
    expect(runToReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kinds: ["targeted-test"], targetPath: "src/math.test.ts" }),
      expect.any(AbortSignal),
    );
  });

  it.each([
    [
      "vanished run context",
      { kind: "unavailable" } as const,
      true,
      {
        commitProof: "unavailable",
        reasonCode: "candidate-not-staged",
        nextAction: "stage-then-verify",
      },
    ],
    // Coding Workbench run 16 (2026-09-10): the untracked lockfile the dependency install had
    // created blocked every proof, and the model read "candidate-not-staged" seven times without a
    // path to act on. The refusal now names what has to be staged.
    [
      "unstaged candidate",
      {
        kind: "refused",
        reason: "candidate-not-staged",
        blocking: {
          unstagedCount: 1,
          untrackedCount: 1,
          unstaged: ["src/App.tsx"],
          untracked: ["package-lock.json"],
        },
      } as const,
      true,
      {
        commitProof: "unavailable",
        reasonCode: "candidate-not-staged",
        nextAction: "stage-then-verify",
        blocking: {
          unstagedCount: 1,
          untrackedCount: 1,
          unstaged: ["src/App.tsx"],
          untracked: ["package-lock.json"],
        },
      },
    ],
    [
      "candidate drift",
      { kind: "ticket", ticket: {} } as const,
      false,
      { commitProof: "unavailable", reasonCode: "candidate-drift", nextAction: "verify-again" },
    ],
    ["recorded proof", { kind: "ticket", ticket: {} } as const, true, { commitProof: "recorded" }],
  ] as const)(
    "reports a passed run with %s commit-proof status",
    async (_label, ticket, recorded, expected) => {
      const beginVerification = vi.fn<VerifiedCommitService["beginVerification"]>(() =>
        Promise.resolve(ticket),
      );
      const completeVerification = vi.fn<VerifiedCommitService["completeVerification"]>(() =>
        Promise.resolve(recorded),
      );
      const facade = verificationFacade({
        runToReport: () => Promise.resolve(verificationReport("passed")),
        records: [],
        verifiedCommitService: {
          ...verificationService(),
          beginVerification,
          completeVerification,
        },
      });

      await expect(
        facade.execute({
          capability: "opaque-capability",
          body: JSON.stringify({
            action: "verification",
            actionId: "verification-proof",
            idempotencyKey: "verification-proof-key",
            verifierId: "test",
          }),
        }),
      ).resolves.toMatchObject({ status: "completed", verification: expected });
      expect(beginVerification).toHaveBeenCalledOnce();
      expect(completeVerification).toHaveBeenCalledTimes(ticket.kind === "ticket" ? 1 : 0);
    },
  );

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

  it("retains body-free stack and cause evidence for a worktree read failure", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const secret = "SENSITIVE-/Users/someone/private-worktree";
    const failure = new GitWorktreeReadError(secret);
    Object.defineProperty(failure, "cause", { value: new TypeError(secret) });
    const facade = verificationFacade({ runToReport: () => Promise.reject(failure), records });

    await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-read-failure",
        idempotencyKey: "verification-read-failure-key",
        verifierId: "test",
      }),
    });

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record).toMatchObject({
      operation: "coding-runtime.verification",
      errorClass: "GitWorktreeReadError",
      correlationId: "run-verification-3",
      causeChain: ["TypeError"],
    });
    expect(record.frames).toHaveLength(1);
    expect(record.frames?.[0]).toMatch(/^packages\/keiko-server\/src\//u);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  // Run 6 (2026-09-10): every verification failed with `errorKind: "Error"`; which of the raw status
  // reader's three exits had thrown could be reconstructed only from the dist frames. A coded throw
  // now names its closed reason on the line; the code is a fixed token, never text.
  it("carries the raw status reader's closed code on a verification read failure", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const facade = verificationFacade({
      runToReport: () => Promise.reject(new GitRawWorktreeReadError("git-raw-snapshot-incomplete")),
      records,
    });

    await facade.execute({
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId: "verification-coded-failure",
        idempotencyKey: "verification-coded-failure-key",
        verifierId: "test",
      }),
    });

    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.verification",
        message: "verification-failed",
        errorClass: "GitRawWorktreeReadError",
        code: "git-raw-snapshot-incomplete",
        correlationId: "run-verification-3",
      }),
    ]);
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
  // #3390: the tool-result projection is a transparent pass-through of the verified-commit
  // record, so the closed violation codes the pure message-policy validator computed reach the
  // model on the SAME "completed" tool result that told the model its commit was blocked --
  // proving the model can self-correct instead of asking the operator which format to use.
  it("carries message-policy violation codes on the commit tool-result projection", async () => {
    const blockedResult = {
      schemaVersion: "1" as const,
      proposalId: "commit-3390",
      runId: "run-1",
      envelopeDigest: DIGEST,
      runtimeAuthorityDigest: DIGEST,
      workspaceDigest: DIGEST,
      repositoryDigest: DIGEST,
      baseSha: "1".repeat(40),
      parentSha: "2".repeat(40),
      stagedTreeDigest: DIGEST,
      verificationEvidenceId: "verification-1",
      messageDigest: DIGEST,
      status: "blocked" as const,
      reason: "message-policy" as const,
      recordedAt: "2026-09-05T13:24:40.039Z",
      violations: ["missing-conventional-prefix" as const],
    };
    const approvalRequiredResult = {
      schemaVersion: "1" as const,
      proposalId: "commit-3390-ready",
      runId: "run-1",
      envelopeDigest: DIGEST,
      runtimeAuthorityDigest: DIGEST,
      workspaceDigest: DIGEST,
      repositoryDigest: DIGEST,
      baseSha: "1".repeat(40),
      parentSha: "2".repeat(40),
      stagedTreeDigest: DIGEST,
      verificationEvidenceId: "verification-1",
      messageDigest: DIGEST,
      status: "approval-required" as const,
      reason: "approval-required" as const,
      recordedAt: "2026-09-05T13:24:40.039Z",
    };
    const commitProposal: VerifiedCommitProposal = {
      binding: approvalRequiredResult,
      command: {
        kind: "commit",
        message: "feat: approved",
        allowEmpty: false,
        verified: {
          headSha: approvalRequiredResult.parentSha,
          stagedTreeDigest: approvalRequiredResult.stagedTreeDigest,
          branchName: "codex/task",
          baseRef: "dev",
          baseSha: approvalRequiredResult.baseSha,
        },
      },
      context: {
        runId: approvalRequiredResult.runId,
        envelopeDigest: approvalRequiredResult.envelopeDigest,
        runtimeAuthorityDigest: approvalRequiredResult.runtimeAuthorityDigest,
        workspaceDigest: approvalRequiredResult.workspaceDigest,
        repositoryDigest: approvalRequiredResult.repositoryDigest,
        workspace: {
          root: "/managed/worktree",
          selectedRoot: "/managed/worktree",
          name: "test",
          version: undefined,
          testFramework: "vitest",
          sourceDirs: [],
          testDirs: [],
          languages: [],
          ignoreLines: [],
        },
        baseRef: "dev",
        headRef: "codex/task",
        correlationId: "run-1",
        buffersClean: () => true,
        stillAuthorized: () => true,
      },
      expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
      review: {
        requestId: approvalRequiredResult.proposalId,
        paths: ["src/index.ts"],
        pathsTruncated: false,
        fileCount: 1,
        addedLines: 1,
        deletedLines: 1,
        verifiedCommit: { result: approvalRequiredResult, message: "feat: approved" },
      },
    };
    const requestCommitApproval = vi.fn();
    const activityLog: ServerLogEvent[] = [];
    const service = {
      ...verificationService(),
      propose: vi.fn((message: string) =>
        Promise.resolve(message === "feat: approved" ? approvalRequiredResult : blockedResult),
      ),
      review: vi.fn<VerifiedCommitService["review"]>(() => commitProposal),
      matchesApproval: vi.fn(() => true),
    };
    const facade = createProductionManagedWorktreeToolFacade({
      verifiedCommitService: service,
      requestCommitApproval,
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
        ],
        connectorScopes: ["source-control.read", "source-control.write"],
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
      verificationRunner: { runToReport: vi.fn() },
      activityLog: { write: (event): void => void activityLog.push(event) },
      onRuntimeEvent: vi.fn(),
    });
    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "delivery",
          actionId: "delivery-1",
          idempotencyKey: "delivery-key",
          intent: "commit",
          phase: "propose",
          message: "rejected commit message",
        }),
      }),
    ).resolves.toMatchObject({
      status: "completed",
      verifiedCommit: {
        status: "blocked",
        reason: "message-policy",
        violations: blockedResult.violations,
      },
    });
    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "delivery",
          actionId: "delivery-2",
          idempotencyKey: "delivery-key-2",
          intent: "commit",
          phase: "propose",
          message: "feat: approved",
        }),
      }),
    ).resolves.toEqual({
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "approval-required" }],
      verifiedCommit: approvalRequiredResult,
      approvalDisposition: "ready",
    });
    expect(requestCommitApproval).not.toHaveBeenCalled();
    expect(activityLog).toContainEqual(
      expect.objectContaining({
        op: "coding-runtime.tool-result",
        extra: {
          actionKind: "commit",
          proposalId: "commit-3390-ready",
          state: "proposal-ready",
          reason: "policy-authorized",
        },
      }),
    );

    service.review.mockReturnValue(undefined);
    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: JSON.stringify({
          action: "delivery",
          actionId: "delivery-3",
          idempotencyKey: "delivery-key-3",
          intent: "commit",
          phase: "propose",
          message: "feat: approved",
        }),
      }),
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "delivery-authority-revoked",
      evidence: [{ kind: "governed-delegate", code: "delivery-authority-revoked" }],
    });
  });
});

describe("H1 repository search mounted into production composition (#3386)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "keiko-h1-production-"));
    roots.push(root);
    return root;
  }

  function searchBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      action: "search",
      actionId: "search-1",
      idempotencyKey: "search-1",
      repositoryRequest: {
        kind: "search",
        mode: "literal",
        query: "parseConfig",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
        maxResults: 50,
        ...overrides,
      },
    });
  }

  function readBody(path: string): string {
    return JSON.stringify({
      action: "search",
      actionId: "search-1",
      idempotencyKey: "search-1",
      repositoryRequest: { kind: "read", path, startLine: 1, endLine: 1, maxBytes: 4096 },
    });
  }

  function searchFacade(input: {
    readonly resolveWorkspaceRootAccess: () => WorkspaceRootAccess | undefined;
    readonly authorityExpiresAt?: string;
    readonly activityLog?: { write: (event: ServerLogEvent) => void };
  }): ReturnType<typeof createProductionManagedWorktreeToolFacade> {
    return createProductionManagedWorktreeToolFacade({
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
      authorityRef: { runId: "run-h1-search", envelopeDigest: DIGEST },
      workspaceRoot: "/managed/worktree",
      resolveWorkspaceRootAccess: input.resolveWorkspaceRootAccess,
      authorityExpiresAt: input.authorityExpiresAt ?? "2099-01-01T00:00:00.000Z",
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      liveFacts: () => ({
        ...FACTS,
        actionClasses: ["workspace-read", "workspace-write", "verification"],
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
      verificationRunner: { runToReport: vi.fn() },
      onRuntimeEvent: vi.fn(),
      ...(input.activityLog === undefined ? {} : { activityLog: input.activityLog }),
    });
  }

  it("returns a real bounded search result from a temp workspace through the actual production composition", async () => {
    const root = tempWorkspace();
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "example.ts"),
      'const token = "private-credential-value";\nexport const parseConfig = true;\n',
    );
    const events: ServerLogEvent[] = [];
    const facade = searchFacade({
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task" as const,
        canonicalRoot: root,
        fs: nodeWorkspaceFs,
        repositoryRoot: root,
      }),
      activityLog: { write: (event): void => void events.push(event) },
    });

    const result = await facade.execute({ capability: "opaque-capability", body: searchBody() });

    expect(result).toMatchObject({ status: "completed" });
    const search = result as { search: { ok: true; hits: readonly unknown[] } };
    expect(search.search.ok).toBe(true);
    expect(search.search.hits[0]).toMatchObject({
      path: "src/example.ts",
      snippet: "export const parseConfig = true;",
    });
    expect(JSON.stringify(result)).not.toContain("private-credential-value");
    // Body-free evidence reaches the activity log through the real production path. "search" is
    // now a catalog-covered action (#3413 F8): its tool-catalog.* lifecycle pair wraps the H1
    // search handler's own started/settled pair, both threaded with this run's correlation id.
    expect(events.map((event) => event.op)).toEqual([
      "tool-catalog.bind-unavailable",
      "tool-catalog.projection",
      "tool-catalog.invocation-started",
      "coding-repository-handler.started",
      "coding-repository-handler.settled",
      "tool-catalog.invocation-settled",
    ]);
    for (const event of events) {
      if (event.op.startsWith("tool-catalog.")) expect(event.correlationId).toBe("run-h1-search");
    }
    expect(JSON.stringify(events)).not.toContain("parseConfig");
  });

  it("denies a workspace-denylisted path as a completed domain outcome, never invented coverage", async () => {
    const root = tempWorkspace();
    writeFileSync(join(root, ".env"), "SECRET=sentinel-value\n");
    const facade = searchFacade({
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task" as const,
        canonicalRoot: root,
        fs: nodeWorkspaceFs,
        repositoryRoot: root,
      }),
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: readBody(".env"),
    });

    expect(result).toMatchObject({
      status: "completed",
      search: { ok: false, reason: "scope-denied" },
    });
  });

  it("reports a result-limit truncation instead of inventing exhaustive coverage", async () => {
    const root = tempWorkspace();
    mkdirSync(join(root, "src"));
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      writeFileSync(join(root, "src", name), "export const truncationProbe = true;\n");
    }
    const facade = searchFacade({
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task" as const,
        canonicalRoot: root,
        fs: nodeWorkspaceFs,
        repositoryRoot: root,
      }),
    });

    const result = await facade.execute({
      capability: "opaque-capability",
      body: searchBody({ query: "truncationProbe", maxResults: 2 }),
    });

    const search = result as {
      search: { ok: true; hits: readonly unknown[]; truncationReasons: readonly string[] };
    };
    expect(search.search.ok).toBe(true);
    expect(search.search.hits).toHaveLength(2);
    expect(search.search.truncationReasons).toContain("result-limit");
  });

  it("fails closed when authority resolves live at admission but is revoked before the handler binds", async () => {
    const root = tempWorkspace();
    let calls = 0;
    const facade = searchFacade({
      resolveWorkspaceRootAccess: (): WorkspaceRootAccess | undefined => {
        calls += 1;
        return calls === 1
          ? {
              kind: "managed-task" as const,
              canonicalRoot: root,
              fs: nodeWorkspaceFs,
              repositoryRoot: root,
            }
          : undefined;
      },
    });

    await expect(
      facade.execute({ capability: "opaque-capability", body: searchBody() }),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "capability-backend-unavailable" });
  });

  it("fails closed with a distinct reason when the run's authority already expired", async () => {
    const root = tempWorkspace();
    const facade = searchFacade({
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task" as const,
        canonicalRoot: root,
        fs: nodeWorkspaceFs,
        repositoryRoot: root,
      }),
      authorityExpiresAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(
      facade.execute({ capability: "opaque-capability", body: searchBody() }),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "search-authority-revoked" });
  });

  it("cancels an already-aborted search before the workspace is ever touched", async () => {
    const root = tempWorkspace();
    const facade = searchFacade({
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task" as const,
        canonicalRoot: root,
        fs: nodeWorkspaceFs,
        repositoryRoot: root,
      }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      facade.execute({
        capability: "opaque-capability",
        body: searchBody(),
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });
});

// #3414-AC9: optional research/skill/child-agent tools must be absent from what the model is told
// exists when their real handler/readiness/policy prerequisite is unavailable, not merely denied
// at call time. These pin `deriveOptionalToolAvailability`'s real, non-fake per-run signal against
// the same fields the production dispatch ports already key off (`buildEgressAuthority`'s live
// #2387 grant check, `auxiliaryPorts`' skill catalog, and the child-agent model resolution
// comment), rather than a second, parallel policy source.
describe("deriveOptionalToolAvailability (#3414-AC9)", () => {
  const runId = "run-availability-1";

  function emptySkillCatalog(): SkillCatalog {
    return {
      has: () => false,
      get: () => undefined,
      list: () => [],
      isImplicitAllowed: () => false,
    };
  }

  it("marks research and child-agent unavailable, and skill available from the server default catalog, when nothing else is wired", () => {
    // No explicit skillCatalog falls back to `createServerApprovedSkillCatalog()` -- the same
    // default `auxiliaryPorts` itself falls back to -- which is non-empty, so `keiko_skill` is
    // available by default; research and child-agent have no such non-empty default.
    const unavailable = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
    });
    expect(unavailable).toEqual(new Set(["keiko_research_fetch", "keiko_child_agent"]));
  });

  it("offers research only when its configured approval-capable handler is bound", () => {
    const registry = createResearchGrantRegistry();
    const wired = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      researchGrantRegistry: registry,
      gatewayEgress: () => ({ noProxy: [] }),
      requestResearchApproval: () => undefined,
    });
    expect(wired.has("keiko_research_fetch")).toBe(false);

    // A registry and egress transport without the callback that opens the approval loop cannot
    // serve the first ungranted request, so the tool stays hidden.
    const noApprovalPath = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      researchGrantRegistry: registry,
      gatewayEgress: () => ({ noProxy: [] }),
    });
    expect(noApprovalPath.has("keiko_research_fetch")).toBe(true);

    // A bound gateway getter that currently resolves no transport remains unavailable.
    const noEgress = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      researchGrantRegistry: registry,
      gatewayEgress: () => undefined,
      requestResearchApproval: () => undefined,
    });
    expect(noEgress.has("keiko_research_fetch")).toBe(true);

    const events: ServerLogEvent[] = [];
    const throwingConfig = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      researchGrantRegistry: registry,
      gatewayEgress: () => {
        throw new Error("private configuration failure");
      },
      requestResearchApproval: () => undefined,
      activityLog: { write: (event): void => void events.push(event) },
    });
    expect(throwingConfig.has("keiko_research_fetch")).toBe(true);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    const extra = event.extra ?? {};
    expect(event.op).toBe("coding-runtime.tool-availability.failed");
    expect(event.correlationId).toBe(runId);
    expect(event.errorKind).toBe("Error");
    expect(extra.runId).toBe(runId);
    expect(extra.optionalTool).toBe("keiko_research_fetch");
    expect(extra.stage).toBe("research-egress-config");
    expect(extra.reason).toBe("configuration-resolution-failed");
    expect(Array.isArray(extra.frames)).toBe(true);
    expect(extra.causeChain).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("private configuration failure");
  });

  it("marks skill available only when the catalog actually lists an approved entry", () => {
    const empty = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      skillCatalog: emptySkillCatalog(),
    });
    expect(empty.has("keiko_skill")).toBe(true);

    const nonEmpty = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      skillCatalog: {
        has: () => true,
        get: () => undefined,
        list: () => [
          { skillId: "skl_demo@1" as never, implicitAllowed: false, category: "public-research" },
        ],
        isImplicitAllowed: () => false,
      },
    });
    expect(nonEmpty.has("keiko_skill")).toBe(false);
  });

  it("marks child-agent available only when the configured model resolves through the factory", () => {
    const noModel = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      childModelPortFactory: () => undefined,
    });
    expect(noModel.has("keiko_child_agent")).toBe(true);

    const emptyModelId = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "",
      childModelPortFactory: () => undefined,
    });
    expect(emptyModelId.has("keiko_child_agent")).toBe(true);

    const noFactory = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
    });
    expect(noFactory.has("keiko_child_agent")).toBe(true);

    const unresolved = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
      childModelPortFactory: () => undefined,
    });
    expect(unresolved.has("keiko_child_agent")).toBe(true);

    const resolvable = deriveOptionalToolAvailability({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
      childModelPortFactory: () => ({
        call: (): Promise<never> => Promise.reject(new Error("unused test model")),
      }),
    });
    expect(resolvable.has("keiko_child_agent")).toBe(false);
  });

  it("removes child-agent readiness when the run's model stops resolving", () => {
    const model = {
      call: (): Promise<never> => Promise.reject(new Error("unused test model")),
    };
    let current: typeof model | undefined = model;
    const factory = vi.fn(() => current);
    const childModel = resolveChildModelForRun({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
      childModelPortFactory: factory,
    });

    expect(
      deriveOptionalToolAvailability({
        authorityRef: { runId, envelopeDigest: DIGEST },
        ...childModel,
      }).has("keiko_child_agent"),
    ).toBe(false);
    current = undefined;
    expect(
      deriveOptionalToolAvailability({
        authorityRef: { runId, envelopeDigest: DIGEST },
        ...childModel,
      }).has("keiko_child_agent"),
    ).toBe(true);
    expect(childModel.childModelPortFactory?.("other-model")).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("uses rotated child-model provider state at dispatch", () => {
    const first = {
      call: (): Promise<never> => Promise.reject(new Error("unused first test model")),
    };
    const rotated = {
      call: (): Promise<never> => Promise.reject(new Error("unused rotated test model")),
    };
    let current = first;
    const factory = vi.fn(() => current);
    const childModel = resolveChildModelForRun({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
      childModelPortFactory: factory,
    });

    expect(childModel.childModelPortFactory?.("coding-safe-model")).toBe(first);
    current = rotated;
    expect(childModel.childModelPortFactory?.("coding-safe-model")).toBe(rotated);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("fails child-model resolution closed with body-free activity evidence", () => {
    const events: ServerLogEvent[] = [];
    const childModel = resolveChildModelForRun({
      authorityRef: { runId, envelopeDigest: DIGEST },
      modelId: "coding-safe-model",
      childModelPortFactory: () => {
        throw new Error("private child configuration failure");
      },
      activityLog: { write: (event): void => void events.push(event) },
    });

    expect(childModel).toEqual({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "coding-runtime.tool-availability.failed",
      correlationId: runId,
      errorKind: "Error",
      extra: {
        runId,
        optionalTool: "keiko_child_agent",
        stage: "child-model-resolution",
        reason: "configuration-resolution-failed",
      },
    });
    expect(JSON.stringify(events)).not.toContain("private child configuration failure");
  });
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

function failedVerificationReport(): VerificationReport {
  return {
    ...verificationReport("failed"),
    results: [
      {
        kind: "test",
        scriptName: "test",
        command: "npm",
        args: ["run", "test"],
        status: "failed",
        exitCode: 1,
        signal: null,
        durationMs: 2,
        truncated: false,
        redacted: true,
        outputSummary: "command output captured (320 bytes) and omitted from summary",
        appliedLimits: [],
        locations: [
          {
            file: "ci/numerical-stability.test.js",
            line: 19,
            column: 5,
            message: "expected the stable average to remain finite",
          },
          {
            file: "/managed/worktree/private/customer.test.js",
            line: 1,
            message: "PRIVATE_FAILURE_CANARY",
          },
        ],
      },
    ],
    counts: {
      ...verificationReport("failed").counts,
      failed: 1,
    },
  };
}

// The minimal live-and-authorized verification wiring: authority granted, managed access proven,
// expiry decades away, so every refusal these tests observe comes from the run OUTCOME (or the
// thrown error) and never from a liveness or policy check.
// Run 10 of the Workbench engagement (2026-09-10). Verification was refused because the run had
// rewritten `package.json`, so the repository's ADR-0147 grant no longer covered the worktree's
// scripts. The tool handed the model the bare refusal, the model correctly reported the blocker and
// stopped, and no surface ever told the operator a decision was waiting on them.
//
// The tool now waits in place — the same shape a git-stage or commit proposal already waits in —
// announces the open decision so the run can report itself paused, and makes ONE further attempt
// once the decision lands. The second attempt is a whole attempt, not a bare `runToReport` retry:
// the candidate-verification ticket brackets each run.
describe("verification waiting on the operator's package-script trust decision", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function trustRefusedThenGranted(granted: () => boolean) {
    return (): ScriptTrustDecision =>
      granted()
        ? { trusted: true, basis: "worktree-human-grant" }
        : { trusted: false, refusal: "worktree-manifest-drift" };
  }

  function verificationCall(actionId: string): { capability: string; body: string } {
    return {
      capability: "opaque-capability",
      body: JSON.stringify({
        action: "verification",
        actionId,
        idempotencyKey: `${actionId}-key`,
        verifierId: "test",
      }),
    };
  }

  it("announces the decision, waits, and verifies once the operator allows the scripts", async () => {
    vi.useFakeTimers();
    let granted = false;
    const announced: { decision: string; outcome?: string }[] = [];
    const runToReport = vi.fn(() =>
      granted
        ? Promise.resolve(verificationReport("passed"))
        : Promise.reject(new WorkspaceTrustRequiredError("worktree-manifest-drift")),
    );
    const log: ServerLogEvent[] = [];
    const facade = verificationFacade({
      runToReport,
      scriptTrustFor: trustRefusedThenGranted(() => granted),
      requestOperatorDecision: (decision, outcome): void => {
        announced.push({ decision, ...(outcome === undefined ? {} : { outcome }) });
        // Stands for the operator clicking Allow while the tool waits.
        if (outcome === undefined) granted = true;
      },
      records: [],
      log,
    });

    const pending = facade.execute(verificationCall("verification-trust-wait"));
    await vi.advanceTimersByTimeAsync(600);

    await expect(pending).resolves.toMatchObject({ status: "completed" });
    expect(runToReport).toHaveBeenCalledTimes(2);
    expect(announced).toEqual([
      { decision: "workspace-script-trust" },
      { decision: "workspace-script-trust", outcome: "accepted" },
    ]);
    expect(log.find((event) => event.op === "coding-runtime.operator-decision")).toMatchObject({
      level: "info",
      correlationId: "run-verification-3",
      extra: { decision: "workspace-script-trust", state: "settled", reason: "granted" },
    });
  });

  // Owner review, PR #3452: the registry's and the catalog's ceilings run from admission, the
  // wait's clock used to start only after the first attempt had failed — so a slow first attempt
  // pushed the wait past the invocation's own ceiling and the model got an opaque cancellation. The
  // wait is now measured from the handler's entry: with 10 s spent before the refusal, it ends at
  // 25 s from entry with the tool's own refusal, and the log records the 15 s it actually waited.
  it("measures the grace window from the handler's entry, not from the refusal", async () => {
    vi.useFakeTimers();
    const runToReport = vi.fn(() =>
      Promise.reject(new WorkspaceTrustRequiredError("worktree-manifest-drift")),
    );
    const log: ServerLogEvent[] = [];
    const facade = verificationFacade({
      runToReport,
      scriptTrustFor: trustRefusedThenGranted(() => false),
      requestOperatorDecision: (): void => undefined,
      verifiedCommitService: {
        beginVerification: () =>
          new Promise<object>((resolve) => {
            setTimeout(() => {
              resolve({});
            }, 10_000);
          }),
      } as unknown as VerifiedCommitService,
      records: [],
      log,
    });

    const pending = facade.execute(verificationCall("verification-trust-clock"));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: "failed",
      reasonCode: "WORKSPACE_TRUST_REQUIRED",
    });
    expect(log.find((event) => event.op === "coding-runtime.operator-decision")).toMatchObject({
      extra: { state: "settled", reason: "expired", waitCeilingMs: 15_000 },
    });
  });

  // A decision that never comes must not hold the run for ever: the wait expires on the same
  // ceiling every other approval wait uses, and the model then gets exactly the refusal it used to
  // get immediately.
  it("returns the runner's refusal when the decision never arrives", async () => {
    vi.useFakeTimers();
    const announced: { decision: string; outcome?: string }[] = [];
    const runToReport = vi.fn(() =>
      Promise.reject(new WorkspaceTrustRequiredError("worktree-manifest-drift")),
    );
    const log: ServerLogEvent[] = [];
    const facade = verificationFacade({
      runToReport,
      scriptTrustFor: trustRefusedThenGranted(() => false),
      requestOperatorDecision: (decision, outcome): void => {
        announced.push({ decision, ...(outcome === undefined ? {} : { outcome }) });
      },
      records: [],
      log,
    });

    const pending = facade.execute(verificationCall("verification-trust-expiry"));
    // Past the wait's own ceiling but still inside the governed invocation's life, which is the
    // whole point of pinning one below the other: the tool answers with its own refusal rather than
    // the caller seeing an opaque cancellation.
    await vi.advanceTimersByTimeAsync(SCRIPT_TRUST_WAIT_CEILING_MS + 600);

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      reasonCode: "WORKSPACE_TRUST_REQUIRED",
    });
    expect(runToReport).toHaveBeenCalledTimes(1);
    expect(announced.at(-1)).toEqual({
      decision: "workspace-script-trust",
      outcome: "limit-reached",
    });
    expect(log.find((event) => event.op === "coding-runtime.operator-decision")).toMatchObject({
      level: "warn",
      extra: { state: "settled", reason: "expired" },
    });
  });

  // A composition with no way to announce the decision — no runtime event sink — must behave
  // exactly as it did before the wait existed, rather than blocking on a decision nobody can see.
  it("keeps the immediate refusal when no decision can be announced", async () => {
    const runToReport = vi.fn(() =>
      Promise.reject(new WorkspaceTrustRequiredError("repository-not-trusted")),
    );
    const facade = verificationFacade({
      runToReport,
      scriptTrustFor: trustRefusedThenGranted(() => false),
      records: [],
    });

    await expect(
      facade.execute(verificationCall("verification-trust-none")),
    ).resolves.toMatchObject({ status: "failed", reasonCode: "WORKSPACE_TRUST_REQUIRED" });
    expect(runToReport).toHaveBeenCalledTimes(1);
  });

  // The load-bearing relation between the wait and the governed invocation's own ceiling. A wait
  // allowed to run to that ceiling is settled as an opaque cancellation before the tool can answer
  // — proven on this fixture: at a 30 s wait the call returned `cancelled`, at 29 s the refusal.
  it("settles its wait strictly inside the governed invocation's life", () => {
    expect(SCRIPT_TRUST_WAIT_CEILING_MS).toBeGreaterThan(0);
    expect(SCRIPT_TRUST_WAIT_CEILING_MS).toBeLessThan(CODING_TOOL_INVOCATION_MAX_TTL_MS);
  });

  // The wait itself, in isolation: an unresolvable workspace is not a verdict a human can change,
  // so waiting on it would hold the run for the full ceiling with nothing to decide.
  it("settles unavailable rather than waiting when the decision cannot be read", async () => {
    vi.useFakeTimers();
    const outcome = waitForWorkspaceScriptTrust(() => undefined);
    await vi.advanceTimersByTimeAsync(600);
    await expect(outcome).resolves.toBe("unavailable");
  });

  // A probe that throws (a workspace resolver failing closed mid-wait) settles the wait through its
  // closed `unavailable` outcome and releases the interval, instead of rejecting from inside a timer
  // callback and leaving the run paused with no settled decision (CodeRabbit review, 2026-09-10).
  it("settles unavailable and releases its timers when the probe throws", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const outcome = waitForWorkspaceScriptTrust((): { readonly trusted: boolean } => {
      probes += 1;
      throw new Error("workspace resolver failed closed");
    });
    await expect(outcome).resolves.toBe("unavailable");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The path the fix above exists for (owner review, PR #3452): the first probe keeps the wait open,
  // and the one fired by the interval — after the promise executor has long returned — throws. The
  // wait still settles through its closed `unavailable` outcome and releases every timer; before the
  // fix that throw escaped the timer callback and the wait never settled.
  it("settles unavailable when a probe fired by the interval throws", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const outcome = waitForWorkspaceScriptTrust((): { readonly trusted: boolean } => {
      probes += 1;
      if (probes === 1) return { trusted: false };
      throw new Error("workspace resolver failed closed");
    });
    expect(probes).toBe(1);

    await vi.advanceTimersToNextTimerAsync();

    await expect(outcome).resolves.toBe("unavailable");
    expect(probes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // An aborted tool call ends the wait immediately; the run is going away and nobody is deciding.
  it("settles cancelled when the tool call is aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const outcome = waitForWorkspaceScriptTrust(
      () => ({ trusted: false, refusal: "worktree-manifest-drift" }),
      controller.signal,
    );
    controller.abort();
    await expect(outcome).resolves.toBe("cancelled");
  });
});

// Trusted unless a test says otherwise, so every case that is not about script trust keeps its
// single-attempt behaviour and never announces a decision.
// The runner returns its report beside the orchestrator's failure output (ADR-0126 D3); these
// doubles produce the report and the helper wraps it in the outcome the port actually consumes, so
// a fixture that only cares about the report keeps saying exactly that.
type ReportRunner = (
  input: VerificationRunInput,
  signal: AbortSignal,
) => Promise<VerificationReport>;

function outcomeRunner(
  runToReport: ReportRunner,
  failureOutput: readonly VerificationStepOutput[] = [],
): VerificationRunnerManager["runToReport"] {
  return async (input, signal) => ({
    report: await runToReport(input, signal),
    failureOutput,
  });
}

function verificationRunnerOptions(options: {
  readonly runToReport: ReportRunner;
  readonly scriptTrustFor?: VerificationRunnerManager["scriptTrustFor"];
  readonly requestOperatorDecision?: (
    decision: CodingWorkbenchOperatorDecision,
    outcome?: CodingWorkbenchAuxiliaryStatus,
  ) => void;
  // #3452: the orchestrator's redacted output tail(s) the port hands back beside the report
  // (ADR-0126 D3). Defaulted to none, exactly as before, so only a test that cares provides one.
  readonly failureOutput?: readonly VerificationStepOutput[];
}): Pick<
  Parameters<typeof createProductionManagedWorktreeToolFacade>[0],
  "verificationRunner" | "requestOperatorDecision"
> {
  return {
    verificationRunner: {
      runToReport: outcomeRunner(options.runToReport, options.failureOutput),
      scriptTrustFor:
        options.scriptTrustFor ??
        ((): ScriptTrustDecision => ({ trusted: true, basis: "repository" })),
    },
    ...(options.requestOperatorDecision === undefined
      ? {}
      : { requestOperatorDecision: options.requestOperatorDecision }),
  };
}

function verificationFacade(options: {
  readonly ciRepairBudget?: CiRepairExecutionBudget;
  readonly verifiedCommitService?: VerifiedCommitService;
  readonly runtimeGitService?: RuntimeGitService;
  readonly requestStageApproval?: (proposalId: string) => void;
  readonly log?: ServerLogEvent[];
  readonly events?: CodingWorkbenchRuntimeEvent[];
  readonly ciObservationService?: CiObservationService;
  readonly runToReport: ReportRunner;
  readonly scriptTrustFor?: VerificationRunnerManager["scriptTrustFor"];
  readonly requestOperatorDecision?: (
    decision: CodingWorkbenchOperatorDecision,
    outcome?: CodingWorkbenchAuxiliaryStatus,
  ) => void;
  readonly failureOutput?: readonly VerificationStepOutput[];
  readonly workspaceRoot?: string;
  readonly records: ServerDiagnosticRecord[];
}): ReturnType<typeof createProductionManagedWorktreeToolFacade> {
  return createProductionManagedWorktreeToolFacade({
    ...(options.ciRepairBudget === undefined ? {} : { ciRepairBudget: options.ciRepairBudget }),
    ...(options.verifiedCommitService === undefined
      ? {}
      : { verifiedCommitService: options.verifiedCommitService }),
    ...(options.runtimeGitService === undefined
      ? {}
      : { runtimeGitService: options.runtimeGitService }),
    ...(options.requestStageApproval === undefined
      ? {}
      : { requestStageApproval: options.requestStageApproval }),
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
    workspaceRoot: options.workspaceRoot ?? "/managed/worktree",
    resolveWorkspaceRootAccess:
      options.workspaceRoot === undefined
        ? resolveWorkspaceRootAccess
        : (): WorkspaceRootAccess => ({
            kind: "managed-task" as const,
            canonicalRoot: options.workspaceRoot ?? "/managed/worktree",
            fs: nodeWorkspaceFs,
            repositoryRoot: options.workspaceRoot ?? "/managed/worktree",
          }),
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
    ...verificationRunnerOptions(options),
    diagnostics: { record: (record): void => void options.records.push(record) },
    ...(options.log === undefined
      ? {}
      : { activityLog: { write: (event): void => void options.log?.push(event) } }),
    onRuntimeEvent: (event): void => {
      options.events?.push(event);
    },
  });
}

interface GeneratedVerificationTool {
  readonly execute: (
    args: { readonly verifierId: string; readonly targetPath: string },
    context: {
      readonly sessionID: string;
      readonly callID: string;
      readonly abort: AbortSignal;
      readonly ask: (request: Record<string, unknown>) => Promise<void>;
    },
  ) => Promise<unknown>;
}

function generatedToolContext(callID: string): Parameters<GeneratedVerificationTool["execute"]>[1] {
  return {
    sessionID: "session-native-target",
    callID,
    abort: new AbortController().signal,
    ask: (): Promise<void> => Promise.resolve(),
  };
}

function loadGeneratedVerificationTool(fetchImpl: typeof fetch): GeneratedVerificationTool {
  const source = createGeneratedOpenCodeBundle().toolSources.keiko_verification;
  if (source === undefined) throw new Error("keiko_verification tool source missing");
  const value: unknown = new Script(
    `${source.replace("export default", "const generated =")}\ngenerated;`,
  ).runInNewContext({
    process: {
      env: {
        KEIKO_CODING_MODE: "autonomous-delivery",
        KEIKO_TOOL_FACADE_URL: "https://tool-facade.internal/invoke",
        KEIKO_TOOL_FACADE_CAPABILITY: "runtime-capability",
      },
    },
    fetch: fetchImpl,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
  });
  if (
    typeof value !== "object" ||
    value === null ||
    !("execute" in value) ||
    typeof value.execute !== "function"
  ) {
    throw new Error("generated verification tool invalid");
  }
  return value as GeneratedVerificationTool;
}

function verificationService(): VerifiedCommitService {
  return {
    beginVerification: vi.fn(() => Promise.resolve({ kind: "ticket" as const, ticket: {} })),
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

// Run 12 (2026-09-10): a verification refused while its sibling waited on the operator's trust
// decision was logged as `verification-authority-revoked` and nothing else, although three different
// conditions produce that one code. The condition is the diagnostic's `code`; these pins hold the
// mapping so the next refusal in a customer log names what actually fired.
describe("verificationLivenessRefusal", () => {
  const liveInput = {
    liveFacts: (): CodingWorkbenchRuntimeAuthorityFacts => FACTS,
    resolveWorkspaceRootAccess,
    authorityExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const liveGuard = { check: (): boolean => true };

  it("names an aborted signal before anything else", () => {
    const controller = new AbortController();
    controller.abort();
    expect(verificationLivenessRefusal(liveInput, { check: () => false }, controller.signal)).toBe(
      "signal-aborted",
    );
  });

  it("names a rejecting guard", () => {
    expect(verificationLivenessRefusal(liveInput, { check: () => false }, undefined)).toBe(
      "guard-rejected",
    );
  });

  it.each([
    [
      "a workspace that no longer resolves as a managed task",
      { resolveWorkspaceRootAccess: (): WorkspaceRootAccess | undefined => undefined },
    ],
    ["an expired authority", { authorityExpiresAt: "2000-01-01T00:00:00.000Z" }],
    [
      "live facts that throw",
      {
        liveFacts: (): CodingWorkbenchRuntimeAuthorityFacts => {
          throw new Error("facts unavailable");
        },
      },
    ],
  ] as const)("names a run that is not live: %s", (_label, override) => {
    expect(verificationLivenessRefusal({ ...liveInput, ...override }, liveGuard, undefined)).toBe(
      "run-not-live",
    );
  });

  it("reports nothing while every condition holds", () => {
    expect(
      verificationLivenessRefusal(liveInput, liveGuard, new AbortController().signal),
    ).toBeUndefined();
  });
});
