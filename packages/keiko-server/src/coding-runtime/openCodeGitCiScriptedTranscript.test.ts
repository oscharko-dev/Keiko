import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodingWorkbenchRuntimeEvent,
  VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { CodingRuntimeCiRepairController } from "./codingRuntimeCiRepairController.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import { createInMemoryGitDeliveryApprovalStore } from "../gitDelivery/approvalStore.js";
import { createVerifiedCommitService } from "../gitDelivery/verifiedCommitService.js";
import { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import { commitFacadeFixture } from "../gitDelivery/verifiedCommitFacadeTestSupport.js";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import { createDraftRun } from "../gitDelivery/ciObservationTest/_support.js";
import { DraftDeliveryFixture } from "../gitDelivery/draftDeliveryServiceTestSupport.js";
import type { VerifiedCommitRunContext } from "../gitDelivery/verifiedCommitTypes.js";
import {
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOLS,
  projectedGatewaySchema,
} from "./opencodeToolSchemas.js";
import { createGeneratedOpenCodeBundle } from "./opencodeRuntimeAdapter.js";
import {
  ScriptedGovernedTools,
  type ScriptedToolPhase,
} from "./opencodeFunctionalHarness/_governedTools.js";
import {
  createLiveGatewayScriptedChild,
  createScriptedGovernedTranscriptChild,
  functionalGatewayTools,
  type FakeGatewayTurn,
  type FakeToolCall,
  type ScriptedGovernedTranscriptToolResult,
} from "./opencodeFunctionalHarness/_support.js";
import { handleCodingSidecarGatewayChatCompletions } from "../coding-sidecar-gateway.js";
import { buildRedactor, type UiHandlerDeps } from "../deps.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "../diagnostics-log.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import { STREAMING, type RouteContext } from "../routes.js";

const DIGEST = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function passingReport(root: string): VerificationReport {
  return {
    workspaceRoot: root,
    overallStatus: "passed",
    startedAtMs: Date.now(),
    durationMs: 1,
    counts: {
      passed: 1,
      failed: 0,
      skipped: 0,
      denied: 0,
      cancelled: 0,
      "resource-exceeded": 0,
      "timed-out": 0,
    },
    results: [
      {
        kind: "typecheck",
        scriptName: "check",
        command: "node",
        args: ["--check"],
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 1,
        truncated: false,
        redacted: true,
        outputSummary: "",
        appliedLimits: [],
      },
    ],
  };
}

/** Grants exactly the action classes and connector scopes keiko_ci_status/keiko_verification need. */
function ciRepairEnvelope(): never {
  return {
    authority: {
      effectiveMode: "autonomous-delivery",
      actionClasses: ["workspace-read", "verification", "connector-access", "network-egress"],
      connectorScopes: ["source-control.read"],
      commandPolicy: { mode: "deny", allow: [], deny: [], requirePerCommandApproval: true },
      networkPolicy: { mode: "connector-bound", connectorScopes: ["source-control.read"] },
    },
  } as never;
}

function failingReport(root: string): VerificationReport {
  return {
    ...passingReport(root),
    overallStatus: "failed",
    counts: { ...passingReport(root).counts, passed: 0, failed: 1 },
    results: [{ ...passingReport(root).results[0], status: "failed", exitCode: 1 }],
  };
}

/** The generated tool source always serializes its request as a JSON string body. */
function requestBodyText(body: unknown): string {
  return typeof body === "string" ? body : "";
}

/** A scripted "model" call: the exact tool-call shape a real OpenCode transcript hands the server. */
function toolCall(name: string, args: Record<string, unknown>, id: string): FakeToolCall {
  return { id, name, args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The scripted model's only "context window": the last tool result it was handed, parsed. */
function lastToolResult(
  transcript: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (isRecord(message) && message.role === "tool" && typeof message.content === "string") {
      return JSON.parse(message.content) as Record<string, unknown>;
    }
  }
  return undefined;
}

type ScriptedStep = (last: Record<string, unknown> | undefined) => FakeToolCall;

/**
 * A scripted "model" turn function: on every gateway call it picks the NEXT step from a fixed
 * plan, choosing the tool call solely from the transcript's last tool result -- exactly the
 * information a real model reads from the conversation to decide its next call -- then stops the
 * turn (no further tool calls) once the plan is exhausted. This is the seam
 * `FakeOpenCodeChild.callGateway` fetches over HTTP in the full harness; here it is supplied
 * directly so the SAME `agentLoop`/`executeToolCall` dispatch runs with a swappable plan instead
 * of a live gateway.
 */
function scriptedModelPlan(
  steps: readonly ScriptedStep[],
): (transcript: readonly Record<string, unknown>[]) => FakeGatewayTurn {
  let cursor = 0;
  return (transcript): FakeGatewayTurn => {
    const step = steps[cursor];
    if (step === undefined) return { content: "", toolCalls: [] };
    cursor += 1;
    return { content: "", toolCalls: [step(lastToolResult(transcript))] };
  };
}

/**
 * One scripted OpenCode child conversation whose "model" plan can be swapped between turns --
 * models a multi-turn transcript (propose, pause for human approval, resume) on the SAME
 * in-process child, the same way a real OpenCode session keeps one conversation across turns.
 */
function swappableModelTurn(): {
  readonly modelTurn: (transcript: readonly Record<string, unknown>[]) => FakeGatewayTurn;
  readonly use: (steps: readonly ScriptedStep[]) => void;
} {
  let current = scriptedModelPlan([]);
  return {
    modelTurn: (transcript): FakeGatewayTurn => current(transcript),
    use: (steps): void => {
      current = scriptedModelPlan(steps);
    },
  };
}

function toolResult(
  results: readonly ScriptedGovernedTranscriptToolResult[],
  callId: string,
): Record<string, unknown> {
  const found = results.find((result) => result.callId === callId);
  if (found === undefined) throw new Error(`missing scripted tool result: ${callId}`);
  return JSON.parse(found.output) as Record<string, unknown>;
}

/**
 * #3386: proves that a MODEL-SELECTED call to each of keiko_git_status/diff/stage/commit reaches
 * the real generated OpenCode tool source (`createGeneratedOpenCodeBundle`, the same bundle the
 * sidecar hands the real OpenCode 1.17.17 child) and, through it, VerifiedCommitService and
 * RuntimeGitService in the production composition -- exactly the code path
 * `createProductionManagedWorktreeToolFacade` wires for a real run. The tool-call SELECTION comes
 * from a scripted model plan (`scriptedModelPlan`/`swappableModelTurn`) driving the harness's own
 * `createScriptedGovernedTranscriptChild` -- the SAME `FakeOpenCodeChild` agent loop
 * (`callGateway` -> `executeToolCall` -> `callToolFacade`) a full scripted pipeline run drives,
 * not a test-authored call sequence. The model never commits directly: keiko_git_stage/
 * keiko_git_commit only PROPOSE, the existing approval bridge (`codingToolApprovalBridge.ts`'s
 * `issueStage`/`issueCommit`, the same call the orchestrator's `decideApproval` makes once a human
 * approves) is exercised explicitly between the two turns, and only then does the shared
 * keiko_git_execute redemption tool -- itself the only tool the model can reach the write outcome
 * through -- reach the real service and produce a REAL commit in a real git repository. The
 * commit proposal's outcome is asserted directly on the run's tool-event stream
 * (`commitFacadeFixture`'s `events`, the same `onRuntimeEvent` sink
 * `createProductionManagedWorktreeToolFacade` publishes through for a real run).
 */
describe("scripted OpenCode transcript reaches VerifiedCommitService/RuntimeGitService (#3386)", () => {
  function repo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-transcript-")));
    roots.push(root);
    git(root, ["init", "-qb", "dev"]);
    git(root, ["config", "user.name", "Keiko Test"]);
    git(root, ["config", "user.email", "keiko@example.test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "code.js"), "export const value = 1;\n");
    git(root, ["add", "code.js"]);
    git(root, ["commit", "-qm", "base"]);
    git(root, ["checkout", "-qb", "codex/task"]);
    // An unstaged, uncommitted worktree change: the model must discover, stage and commit it itself.
    writeFileSync(join(root, "code.js"), "export const value = 2;\n");
    return root;
  }

  function fixture(root: string): {
    readonly facadeFetch: typeof globalThis.fetch;
    readonly bridge: ReturnType<typeof commitFacadeFixture>["bridge"];
    readonly events: CodingWorkbenchRuntimeEvent[];
  } {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const snapshots = createCodingRuntimeSnapshotStore(db);
    snapshots.create({
      schemaVersion: "1",
      runId: "run-1",
      state: "running",
      revision: 0,
      requestedMode: "autonomous-delivery",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      taskDigest: DIGEST,
      workspaceDigest: DIGEST,
      operatorDigest: DIGEST,
      authorityDigest: DIGEST,
      bindingDigest: DIGEST,
      provenanceDigest: DIGEST,
      toolCallCount: 0,
      patchByteCount: 0,
      modelRequestCount: 0,
    });
    const context = (): VerifiedCommitRunContext => ({
      runId: "run-1",
      envelopeDigest: "b".repeat(64),
      runtimeAuthorityDigest: DIGEST,
      workspaceDigest: DIGEST,
      repositoryDigest: DIGEST,
      workspace: {
        root,
        selectedRoot: root,
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
      correlationId: "scripted-transcript-3386",
      buffersClean: () => true,
      stillAuthorized: () => true,
    });
    const evidence = new Map<string, string>();
    const options = {
      context,
      snapshots,
      mutationDeps: {
        redactor: (value: unknown): unknown => value,
        evidenceStore: {
          put: (id: string, body: string): string => {
            evidence.set(id, body);
            return id;
          },
          get: (id: string): string | undefined => evidence.get(id),
          list: (): readonly string[] => [...evidence.keys()],
          delete: (id: string): void => {
            evidence.delete(id);
          },
        },
      },
      messageAllowed: (message: string): Promise<boolean> =>
        Promise.resolve(message.startsWith("feat:")),
      execution: {
        processEnv: { PATH: process.env.PATH, HOME: root },
        now: (): number => Date.now(),
        approvalStore: createInMemoryGitDeliveryApprovalStore(),
        activityLog: { write: (): void => undefined },
        branchProtectionReader: (): Promise<{ readonly outcome: "unprotected" }> =>
          Promise.resolve({ outcome: "unprotected" }),
      },
    };
    const service = createVerifiedCommitService(options);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "autonomous-delivery" => "autonomous-delivery",
      invalidateVerification: (): void => undefined,
    });
    const { facade, bridge, events } = commitFacadeFixture({
      service,
      gitService,
      root,
      mode: "autonomous-delivery",
      live: () => true,
      report: () => passingReport(root),
    });
    const facadeFetch = async (
      _url: unknown,
      init: { readonly body?: unknown },
    ): Promise<Response> => {
      const result = await facade.execute({
        body: requestBodyText(init.body),
        capability: "scripted-fixture-capability",
      });
      return new Response(JSON.stringify(result));
    };
    return { facadeFetch, bridge, events };
  }

  it("routes status, diff, a scripted-model stage/commit propose cycle and a real approved commit through the production facade", async () => {
    const root = repo();
    const { facadeFetch, bridge, events } = fixture(root);
    const plan = swappableModelTurn();
    const child = createScriptedGovernedTranscriptChild({
      runId: "run-3386",
      toolFacadeFetch: facadeFetch,
      modelTurn: plan.modelTurn,
    });

    plan.use([
      (): FakeToolCall => toolCall("keiko_git_status", {}, "call-status"),
      (): FakeToolCall =>
        toolCall("keiko_git_diff", { scope: "working-tree", paths: ["code.js"] }, "call-diff"),
      (): FakeToolCall => toolCall("keiko_git_stage", { paths: ["code.js"] }, "call-stage-propose"),
      (last): FakeToolCall => {
        const stage = (last as { readonly git: { readonly proposalId: string } }).git;
        return toolCall(
          "keiko_git_execute",
          { kind: "stage", proposalId: stage.proposalId },
          "call-stage-execute",
        );
      },
      (): FakeToolCall =>
        toolCall("keiko_verification", { verifierId: "typecheck" }, "call-verify"),
      (): FakeToolCall =>
        toolCall(
          "keiko_git_commit",
          { message: "feat: authorized scripted-transcript change" },
          "call-commit-propose",
        ),
    ]);
    const turn1 = await child.runTurn("stage and commit the pending workspace change");
    // The dispatch order was decided by the scripted model plan, not authored imperatively here --
    // this is what the loop ACTUALLY executed, in the order it executed it.
    expect(turn1.map((result) => result.tool)).toEqual([
      "keiko_git_status",
      "keiko_git_diff",
      "keiko_git_stage",
      "keiko_git_execute",
      "keiko_verification",
      "keiko_git_commit",
    ]);

    const status = toolResult(turn1, "call-status");
    expect(status.status).toBe("completed");
    expect((status.git as { readonly kind: string }).kind).toBe("status");

    const diff = toolResult(turn1, "call-diff");
    expect(diff.status).toBe("completed");
    expect((diff.git as { readonly kind: string }).kind).toBe("diff");

    const stagePropose = toolResult(turn1, "call-stage-propose");
    const stage = stagePropose.git as { readonly status: string; readonly proposalId: string };
    // Staging a workspace-contained change is routine, contained authority in autonomous-delivery
    // (ADR-0129/ADR-0138): the propose call is immediately "ready", with no approval hold -- only
    // the higher-risk commit below requires the approval channel. `keiko_git_stage` still only
    // PROPOSES; keiko_git_execute is the only tool that reaches the write outcome.
    expect(stage.status).toBe("ready");
    expect(stage.proposalId).toMatch(/^stage-\d+$/u);

    const staged = toolResult(turn1, "call-stage-execute").git as { readonly status: string };
    expect(staged.status).toBe("succeeded");
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("code.js");

    const verification = toolResult(turn1, "call-verify");
    expect(verification.status).toBe("completed");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "verification-summarized", verificationStatus: "passed" }),
    );

    const commitPropose = toolResult(turn1, "call-commit-propose");
    const commit = commitPropose.verifiedCommit as {
      readonly status: string;
      readonly proposalId: string;
    };
    expect(commit.status).toBe("approval-required");
    // The commit proposal's outcome is visible on the run's tool-event stream -- the same
    // permission-requested record the orchestrator's approval UI reads -- before a human ever
    // approves it: `createProductionManagedWorktreeToolFacade`'s own `onRuntimeEvent` sink, not a
    // second, test-invented notion of "the tool-event stream".
    const commitPermissionEvent = events.find((event) => event.kind === "permission-requested");
    expect(commitPermissionEvent).toMatchObject({
      kind: "permission-requested",
      runId: "run-1",
      permissionRequest: {
        requestId: commit.proposalId,
        actionKind: "commit",
        reasonCode: "commit-approval-required",
      },
    });

    expect(bridge.issueCommit?.("run-1", commit.proposalId)).toBeDefined();

    plan.use([
      (): FakeToolCall =>
        toolCall(
          "keiko_git_execute",
          { kind: "commit", proposalId: commit.proposalId },
          "call-commit-execute",
        ),
    ]);
    const beforeHead = git(root, ["rev-parse", "HEAD"]);
    const turn2 = await child.runTurn("the commit has been approved -- proceed");
    const executed = toolResult(turn2, "call-commit-execute").verifiedCommit as {
      readonly status: string;
    };
    expect(executed.status).toBe("succeeded");
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    expect(git(root, ["log", "-1", "--format=%s"])).toBe(
      "feat: authorized scripted-transcript change",
    );
    await child.close();
  });

  it("bounds a scripted-model observe-then-repair loop with the same cumulative CI repair budget the production controller enforces (#3388)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ci-repair-transcript-")));
    roots.push(root);
    const db = new DatabaseSync(":memory:");
    // #3388 CI observation requires a live confirmed draft delivery to observe against -- reuses
    // the existing gitDelivery test-support fixture (a verified commit + a completed push/PR
    // draft delivery record for run-1) instead of re-deriving that precondition by hand.
    const snapshots = createDraftRun(db);
    // The production budget store timestamps its own rows against the real wall clock
    // (`Date.now()`); the controller's `now()` must stay on that same clock or every freshness and
    // receipt check compares two unrelated timelines and fails closed for the wrong reason.
    let nowMs = Date.now();
    const repairContext = (): {
      readonly runId: string;
      readonly remoteDigest: string;
      readonly prNumber: number;
      readonly correlationId: string;
      readonly limits: {
        readonly maxRuntimeMs: number;
        readonly maxToolCalls: number;
        readonly maxPromptTokens: number;
      };
      readonly stillAuthorized: () => boolean;
    } => ({
      runId: "run-1",
      remoteDigest: DIGEST,
      prNumber: 17,
      correlationId: "scripted-ci-repair-3388",
      limits: { maxRuntimeMs: 600_000, maxToolCalls: 100, maxPromptTokens: 100_000 },
      stillAuthorized: (): boolean => true,
    });
    const repairController = new CodingRuntimeCiRepairController({
      store: snapshots.ciRepairBudget,
      readiness: snapshots.ciReadiness,
      context: repairContext,
      now: (): number => nowMs,
    });
    let observation = 0;
    const ciObservationService: CiObservationService = {
      observe: (): Promise<
        import("@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci").CodingRuntimeCiResult
      > => {
        observation += 1;
        nowMs += 1_000;
        const snapshot = {
          schemaVersion: "1" as const,
          runId: "run-1",
          remoteDigest: DIGEST,
          repository: "owner/repository",
          prNumber: 17,
          baseRef: "dev",
          baseSha: "1".repeat(40),
          headRef: "feature/issue-1",
          headSha: "3".repeat(40),
          requirementsVersion: "1",
          requirementsDigest: DIGEST,
          strictBaseRequired: false,
          observedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + 60_000).toISOString(),
          evidenceRef: `ci-observation-${String(observation)}`,
          complete: true,
          state: "failed" as const,
          reason: "required-checks-failed",
          failureSignatureDigest: DIGEST,
          requiredChecks: { total: 1, passed: 0, failed: 1, pending: 0, blocked: 0, unknown: 0 },
          advisoryChecks: { total: 0, passed: 0, failed: 0, pending: 0, blocked: 0, unknown: 0 },
          pullRequest: {
            status: "open" as const,
            isDraft: true,
            conflict: "clear" as const,
            baseCurrency: "current" as const,
          },
          humanReview: {
            visibility: "complete" as const,
            requiredCount: 0,
            approvedCount: 0,
            changesRequestedCount: 0,
          },
        };
        const ticket = snapshots.ciReadiness.begin("run-1");
        snapshots.ciReadiness.complete(ticket, snapshot);
        repairController.observed(snapshot);
        return Promise.resolve({ status: "observed" as const, snapshot, retryAfterMs: 0 });
      },
    };

    const events: CodingWorkbenchRuntimeEvent[] = [];
    const facade = createProductionManagedWorktreeToolFacade({
      ciObservationService,
      ciRepairBudget: repairController,
      authority: {
        resolveCapabilityForDelegation: () => ({ ok: true, envelope: ciRepairEnvelope() }),
        revalidateCapabilityForMutation: () => ({ ok: true, envelope: ciRepairEnvelope() }),
      },
      authorityRef: { runId: "run-1", envelopeDigest: "b".repeat(64) },
      workspaceRoot: root,
      resolveWorkspaceRootAccess: () => ({
        kind: "managed-task",
        canonicalRoot: root,
        repositoryRoot: root,
        fs: nodeWorkspaceFs,
      }),
      authorityExpiresAt: "2099-01-01T00:00:00.000Z",
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      liveFacts: () => ({
        binding: {
          taskId: "task-1",
          projectId: "repo-1",
          projectDigest: DIGEST,
          workspaceId: "workspace-1",
          workspaceRootDigest: DIGEST,
          branchRef: "codex/task",
          branchHeadDigest: DIGEST,
        },
        actionClasses: ["workspace-read", "verification"],
        connectorScopes: [],
        runtimeSource: "keiko-sidecar",
        modelSource: "keiko-model-gateway",
        budgetDigest: DIGEST,
        commandPolicyDigest: DIGEST,
        networkPolicyDigest: DIGEST,
        gatesDigest: DIGEST,
        branchConstraintsDigest: DIGEST,
        modelProfileDigest: DIGEST,
      }),
      secureWorkspaceTextRead: {
        readText: () => Promise.resolve({ ok: false, reason: "not-found" }),
      },
      editorAgentClient: {
        action: () =>
          Promise.resolve({
            ok: false,
            error: { kind: "route", code: "denied", message: "denied" },
          }),
      },
      invocationRegistry: createCodingToolInvocationRegistry(),
      verificationRunner: { runToReport: () => Promise.resolve(failingReport(root)) },
      onRuntimeEvent: (event): void => {
        events.push(event);
      },
    });
    const facadeFetch = async (
      _url: unknown,
      init: { readonly body?: unknown },
    ): Promise<Response> => {
      const result = await facade.execute({
        body: requestBodyText(init.body),
        capability: "scripted-fixture-capability",
      });
      return new Response(JSON.stringify(result));
    };

    const plan = swappableModelTurn();
    const child = createScriptedGovernedTranscriptChild({
      runId: "run-3388",
      toolFacadeFetch: facadeFetch,
      modelTurn: plan.modelTurn,
    });

    // Four scripted observe-then-repair cycles in one continuous transcript: the model calls
    // keiko_ci_status (a fresh failed readiness observation), then keiko_verification in response
    // -- each verification attempt fails, charging the SAME cumulative CI repair budget
    // CI_REPAIR_MAX_FAILED_ATTEMPTS bounds. Which tool runs next is picked by the scripted model
    // plan from the transcript, not authored as a direct call sequence.
    plan.use(
      Array.from({ length: 4 }, (_unused, cycle): readonly ScriptedStep[] => [
        (): FakeToolCall => toolCall("keiko_ci_status", {}, `call-ci-${String(cycle)}`),
        (): FakeToolCall =>
          toolCall(
            "keiko_verification",
            { verifierId: "typecheck" },
            `call-verify-${String(cycle)}`,
          ),
      ]).flat(),
    );
    const turn = await child.runTurn("observe CI and repair the failing checks");
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const ci = toolResult(turn, `call-ci-${String(cycle)}`);
      expect(ci.status).toBe("completed");
      expect((ci.ci as { readonly status: string }).status).toBe("observed");
    }
    const reasonCodes = [0, 1, 2, 3].map(
      (cycle) => toolResult(turn, `call-verify-${String(cycle)}`).reasonCode,
    );
    // The first CI_REPAIR_MAX_FAILED_ATTEMPTS (3) failing repair attempts are admitted and
    // executed -- each fails on its own verification merits (VERIFICATION_FAILED). The loop does
    // not run unbounded: by the fourth cycle the cumulative budget is already exhausted, and the
    // SAME keiko_verification call is denied fail-closed by the budget itself
    // ("ci-repair-budget-blocked") before the verifier ever runs again -- a materially different
    // reason than the verifier's own failure, proving the bound is enforced, not merely repeated.
    expect(reasonCodes.slice(0, 3)).toEqual([
      "VERIFICATION_FAILED",
      "VERIFICATION_FAILED",
      "VERIFICATION_FAILED",
    ]);
    expect(reasonCodes[3]).toBe("ci-repair-budget-blocked");
    // The bound is visible on the run's tool-event stream too: exactly the three attempts that
    // actually executed published a verification-summarized event -- the budget-blocked fourth
    // call never reached the verifier, so it never published a fourth.
    const verificationEvents = events.filter((event) => event.kind === "verification-summarized");
    expect(verificationEvents).toHaveLength(3);
    expect(verificationEvents.every((event) => event.verificationStatus === "failed")).toBe(true);

    // The bound holds for any further call, not just the one that tripped it.
    plan.use([
      (): FakeToolCall =>
        toolCall("keiko_verification", { verifierId: "typecheck" }, "call-verify-exhausted"),
    ]);
    const extra = await child.runTurn("try the verifier again");
    expect(toolResult(extra, "call-verify-exhausted")).toMatchObject({
      status: "failed",
      reasonCode: "ci-repair-budget-blocked",
    });
    expect(events.filter((event) => event.kind === "verification-summarized")).toHaveLength(3);
    await child.close();
  });
});

/**
 * #3386/#3388 negative: a tool the codebase removes from the advertised schema must fail closed on
 * a scripted transcript that still tries to call it -- never silently succeed. This exercises the
 * exact production seams: `hasExactOpenCodeVisibleToolContract` (the sidecar gateway's admission
 * check for the schema the underlying model is actually shown) and the scripted harness's own
 * `generatedTool` lookup against `createGeneratedOpenCodeBundle` (the same lookup the real scripted
 * child performs for every tool call).
 */
describe("removing a tool from the advertised OpenCode schema fails closed", () => {
  it("rejects a gateway tool projection missing one of the eight #3386/#3387/#3388 tools", () => {
    // Mirrors the real gateway wire projection (OpenCode 1.17.17 strips `additionalProperties`
    // from keiko_verification, and drops the empty `required: []` array for a zero-argument tool
    // such as keiko_git_status/keiko_git_push -- #3390 live-run evidence), by deriving it from
    // `projectedGatewaySchema`, the one production formula, rather than restating either
    // projection here -- exercised without restating the digest logic itself, which stays owned
    // by `hasExactOpenCodeVisibleToolContract`.
    const gatewayVisible = OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => ({
      name,
      parameters: projectedGatewaySchema(name, parameters),
    }));
    expect(hasExactOpenCodeVisibleToolContract(gatewayVisible)).toBe(true);
    const withoutStage = gatewayVisible.filter((tool) => tool.name !== "keiko_git_stage");
    expect(withoutStage).toHaveLength(gatewayVisible.length - 1);
    // #3386/#3387/#3388 fail-closed proof: dropping one tool from what the model is actually
    // shown must never be silently admitted as the full contract.
    expect(hasExactOpenCodeVisibleToolContract(withoutStage)).toBe(false);
    // The full, unmodified projection is still admitted: the check is discriminating, not broken.
    expect(hasExactOpenCodeVisibleToolContract(gatewayVisible)).toBe(true);
  });

  it("throws a closed error instead of silently succeeding when a scripted transcript calls an unknown tool", async () => {
    expect(OPENCODE_MODEL_VISIBLE_TOOL_NAMES).not.toContain("keiko_git_status_removed");
    expect(
      Object.hasOwn(createGeneratedOpenCodeBundle().toolSources, "keiko_git_status_removed"),
    ).toBe(false);
    const phases: ScriptedToolPhase[] = [];
    const tools = new ScriptedGovernedTools({
      env: { KEIKO_CODING_RUN_ID: "run-negative-3388" },
      sessionId: "ses_scripted_negative",
      broadcast: (): void => undefined,
      observePhase: (event): void => {
        phases.push(event);
      },
      fetch: vi.fn(() => Promise.resolve(new Response('{"status":"completed"}'))),
    });
    await expect(
      tools.execute(
        toolCall("keiko_git_status_removed", {}, "call-removed"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("functional-generated-tool-unavailable");
    // The failed call is observed as an explicit "unknown" tool -- never silently absorbed into an
    // apparently-successful known-tool phase.
    expect(phases).toEqual([
      { runId: "run-negative-3388", tool: "unknown", phase: "entered" },
      { runId: "run-negative-3388", tool: "unknown", phase: "failed" },
    ]);
  });

  it("denies a live scripted child mid-run through the real production sidecar-gateway route when the advertised set drops one of the eight tools", async () => {
    // #3386/#3387/#3388 fail-closed proof at the INTEGRATION layer, not only in isolation: the
    // child's own real HTTP `/chat/completions` call reaches the REAL
    // `handleCodingSidecarGatewayChatCompletions` route (the same route the real OpenCode 1.17.17
    // binary calls), which enforces `hasExactOpenCodeVisibleToolContract` on the incoming request.
    // `createScriptedGovernedTranscriptChild`'s directly-injected `modelTurn` seam never touches
    // HTTP and so can never exercise this route; `createLiveGatewayScriptedChild` performs the
    // same real fetch a genuine OpenCode child performs.
    const diagnostics: ServerDiagnosticRecord[] = [];
    const deps = liveNegativeGatewayDeps(diagnostics);
    const server = createHttpServer((request, response) => {
      void routeLiveGatewayRequest(request, response, deps);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const gatewayUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const fullToolSet = functionalGatewayTools();
      const droppedToolSet = fullToolSet.filter((tool) => tool.function.name !== "keiko_git_stage");
      expect(droppedToolSet).toHaveLength(fullToolSet.length - 1);
      const deniedChild = createLiveGatewayScriptedChild({
        runId: "run-negative-gateway-live",
        gatewayUrl,
        gatewayCapability: LIVE_GATEWAY_CAPABILITY,
        gatewayToolsOverride: droppedToolSet,
      });
      try {
        // The denial happens before the model's request is ever admitted: no tool call ever runs.
        await expect(
          deniedChild.runTurn("stage and commit the pending workspace change"),
        ).resolves.toEqual([]);
      } finally {
        await deniedChild.close();
      }
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          errorClass: "CodingSidecarGatewayToolContractRejection",
          code: "CODING_GATEWAY_TOOL_CONTRACT_DRIFT",
        }),
      );

      // The full, unmodified advertised set is admitted through the SAME live route: the denial
      // above is discriminating on the missing tool, not the route simply being broken.
      const admittedChild = createLiveGatewayScriptedChild({
        runId: "run-negative-gateway-live-admitted",
        gatewayUrl,
        gatewayCapability: LIVE_GATEWAY_CAPABILITY,
        gatewayToolsOverride: fullToolSet,
      });
      try {
        await admittedChild.runTurn("stage and commit the pending workspace change");
      } finally {
        await admittedChild.close();
      }
      expect(
        diagnostics.filter(
          (record) => record.errorClass === "CodingSidecarGatewayToolContractRejection",
        ),
      ).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

const LIVE_GATEWAY_CAPABILITY = "scripted-transcript-live-gateway-capability";
const LIVE_GATEWAY_RUN_ID = "run-negative-gateway-live";

function liveGatewayModelProvider(): ModelProviderConfig {
  return {
    modelId: "azure-coding-model",
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment",
    apiVersion: "2024-06-01",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
  };
}

function liveGatewayModelCapability(): ModelCapability {
  return {
    id: "azure-coding-model",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "test-fingerprint",
    },
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "coding-sidecar",
    preferredUseCases: ["Coding"],
    knownLimitations: [],
  };
}

function liveGatewayAssistantResponse(): NormalizedResponse {
  return {
    modelId: "azure-coding-model",
    content: "assistant-content",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "req-live-gateway-negative",
      promptTokens: 12,
      completionTokens: 8,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

/** Minimal, real production `UiHandlerDeps` for the live sidecar-gateway route: no test doubles
 * for tool-contract admission itself -- only the outbound model call is stubbed. */
function liveNegativeGatewayDeps(diagnostics: ServerDiagnosticRecord[]): UiHandlerDeps {
  const config: GatewayConfig = {
    providers: [liveGatewayModelProvider()],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [liveGatewayModelCapability()],
  };
  const diagnosticsSink: ServerDiagnosticSink = {
    record: (record): void => {
      diagnostics.push(record);
    },
  };
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    diagnostics: diagnosticsSink,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    codingSidecarGatewayChatFactory: () => () => Promise.resolve(liveGatewayAssistantResponse()),
    runtimeCapabilityAuthenticator: {
      authenticate: (capability, audience) =>
        capability === LIVE_GATEWAY_CAPABILITY && audience === "model-gateway"
          ? {
              ok: true,
              binding: { runId: LIVE_GATEWAY_RUN_ID, adapterKind: "model-gateway-sidecar" },
            }
          : { ok: false },
      reservePromptTokens: () => ({ ok: true, runId: LIVE_GATEWAY_RUN_ID }),
    },
  };
}

/** Adapts a real Node HTTP request/response to the production route contract, unmodified. */
async function routeLiveGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: UiHandlerDeps,
): Promise<void> {
  const ctx: RouteContext = {
    req: request,
    res: response,
    params: {},
    url: new URL(request.url ?? "/", "http://127.0.0.1"),
    correlationId: undefined,
  };
  const outcome = await handleCodingSidecarGatewayChatCompletions(ctx, deps);
  if (outcome === STREAMING) return;
  response.writeHead(outcome.status, { "content-type": "application/json" });
  response.end(JSON.stringify(outcome.body));
}

/**
 * A real, but never-invoked-in-this-suite, `VerifiedCommitService` -- `commitFacadeFixture`
 * requires one to build the facade at all, but the transcript below never calls
 * keiko_git_status/diff/stage/commit, only keiko_git_push/keiko_pull_request/keiko_git_execute.
 */
function unusedVerifiedCommitService(root: string): ReturnType<typeof createVerifiedCommitService> {
  const context = (): VerifiedCommitRunContext => ({
    runId: "run-1",
    envelopeDigest: "b".repeat(64),
    runtimeAuthorityDigest: DIGEST,
    workspaceDigest: DIGEST,
    repositoryDigest: DIGEST,
    workspace: {
      root,
      selectedRoot: root,
      name: "test",
      version: undefined,
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
    baseRef: "master",
    headRef: "feature/issue-1",
    correlationId: "scripted-transcript-3387",
    buffersClean: () => true,
    stillAuthorized: () => true,
  });
  const evidence = new Map<string, string>();
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return createVerifiedCommitService({
    context,
    snapshots: createCodingRuntimeSnapshotStore(db),
    mutationDeps: {
      redactor: (value: unknown): unknown => value,
      evidenceStore: {
        put: (id: string, body: string): string => {
          evidence.set(id, body);
          return id;
        },
        get: (id: string): string | undefined => evidence.get(id),
        list: (): readonly string[] => [...evidence.keys()],
        delete: (id: string): void => {
          evidence.delete(id);
        },
      },
    },
    messageAllowed: (): Promise<boolean> => Promise.resolve(true),
    execution: {
      processEnv: { PATH: process.env.PATH },
      now: (): number => Date.now(),
      approvalStore: createInMemoryGitDeliveryApprovalStore(),
      activityLog: { write: (): void => undefined },
      branchProtectionReader: (): Promise<{ readonly outcome: "unprotected" }> =>
        Promise.resolve({ outcome: "unprotected" }),
    },
  });
}

/**
 * #3387: proves that a MODEL-SELECTED call to keiko_git_push and keiko_pull_request reaches the
 * real `DraftDeliveryController` (`DraftDeliveryFixture`, the same test-support fixture
 * draftDeliveryService.test.ts/pushRoutes.test.ts/prRoutes.test.ts already use) through the SAME
 * scripted-model/tool-facade dispatch path #3386 proves for commit: the model never pushes or
 * creates a PR directly -- keiko_git_push/keiko_pull_request only PROPOSE, the real approval
 * bridge (`codingToolApprovalBridge.ts`'s `issueDelivery`, the same call the orchestrator's
 * `decideApproval` makes once a human approves a delivery-substrate action) is exercised
 * explicitly between turns, and only then does keiko_git_execute redeem -- producing a REAL `git
 * push` to a real bare remote, and a REAL pull request through the fixture's fake GitHub adapter.
 */
describe("scripted OpenCode transcript reaches DraftDeliveryController for push/pull-request (#3387)", () => {
  it("routes a scripted-model push propose/approve/execute cycle to a real bare git remote", async () => {
    const draft = new DraftDeliveryFixture();
    try {
      await draft.recordVerifiedCommit();
      const { facade, bridge } = commitFacadeFixture({
        service: unusedVerifiedCommitService(draft.root),
        root: draft.root,
        mode: "autonomous-delivery",
        live: () => true,
        report: () => passingReport(draft.root),
        draftDeliveryService: draft.service,
      });
      const facadeFetch = async (
        _url: unknown,
        init: { readonly body?: unknown },
      ): Promise<Response> => {
        const result = await facade.execute({
          body: requestBodyText(init.body),
          capability: "scripted-fixture-capability",
        });
        return new Response(JSON.stringify(result));
      };
      const plan = swappableModelTurn();
      const child = createScriptedGovernedTranscriptChild({
        runId: "run-3387-push",
        toolFacadeFetch: facadeFetch,
        modelTurn: plan.modelTurn,
      });

      plan.use([(): FakeToolCall => toolCall("keiko_git_push", {}, "call-push-propose")]);
      const turn1 = await child.runTurn("push the verified commit");
      expect(turn1.map((result) => result.tool)).toEqual(["keiko_git_push"]);
      const pushPropose = toolResult(turn1, "call-push-propose").draftDelivery as {
        readonly status: string;
        readonly record: { readonly phase: string; readonly proposalId: string };
      };
      expect(pushPropose.status).toBe("recorded");
      // Routine as this action class is, the delivery-substrate action class still needs an
      // explicit human approval before keiko_git_execute may redeem it.
      expect(pushPropose.record.phase).toBe("push-proposed");
      expect(draft.pushCount).toBe(0);

      expect(bridge.issueDelivery?.("run-1", pushPropose.record.proposalId)).toBeDefined();

      plan.use([
        (): FakeToolCall =>
          toolCall(
            "keiko_git_execute",
            { kind: "push", proposalId: pushPropose.record.proposalId },
            "call-push-execute",
          ),
      ]);
      const turn2 = await child.runTurn("the push has been approved -- proceed");
      const pushExecuted = toolResult(turn2, "call-push-execute").draftDelivery as {
        readonly status: string;
        readonly record: { readonly phase: string };
      };
      expect(pushExecuted.status).toBe("recorded");
      expect(pushExecuted.record.phase).toBe("pushed");
      // The REAL git push landed on the REAL bare remote -- not a simulated success.
      expect(draft.pushCount).toBe(1);
      const remoteHead = draft.git(
        ["for-each-ref", "--format=%(objectname)", "refs/heads/feature/issue-1"],
        draft.remote,
      );
      expect(remoteHead).toBe(draft.git(["rev-parse", "feature/issue-1"]));
      await child.close();

      // Same conversation, same run: propose a pull request against the branch just pushed.
      const prChild = createScriptedGovernedTranscriptChild({
        runId: "run-3387-pr",
        toolFacadeFetch: facadeFetch,
        modelTurn: plan.modelTurn,
      });
      plan.use([
        (): FakeToolCall =>
          toolCall("keiko_pull_request", { title: "feat: bounded change" }, "call-pr-propose"),
      ]);
      const turn3 = await prChild.runTurn("open a pull request for the pushed branch");
      const prPropose = toolResult(turn3, "call-pr-propose").draftDelivery as {
        readonly status: string;
        readonly record: { readonly phase: string; readonly proposalId: string };
      };
      expect(prPropose.status).toBe("recorded");
      expect(prPropose.record.phase).toBe("pr-proposed");
      expect(draft.createCount).toBe(0);

      expect(bridge.issueDelivery?.("run-1", prPropose.record.proposalId)).toBeDefined();

      plan.use([
        (): FakeToolCall =>
          toolCall(
            "keiko_git_execute",
            { kind: "pull-request", proposalId: prPropose.record.proposalId },
            "call-pr-execute",
          ),
      ]);
      const turn4 = await prChild.runTurn("the pull request has been approved -- proceed");
      const prExecuted = toolResult(turn4, "call-pr-execute").draftDelivery as {
        readonly status: string;
        readonly record: {
          readonly phase: string;
          readonly pullRequest?: { readonly number: number };
        };
      };
      expect(prExecuted.status).toBe("recorded");
      expect(prExecuted.record.phase).toBe("draft-created");
      // The REAL pull request was created through the fixture's fake GitHub adapter -- not merely
      // recorded as an intent.
      expect(draft.createCount).toBe(1);
      expect(draft.prs).toHaveLength(1);
      expect(prExecuted.record.pullRequest?.number).toBe(draft.prs[0]?.number);
      await prChild.close();
    } finally {
      draft.close();
    }
  });
});
