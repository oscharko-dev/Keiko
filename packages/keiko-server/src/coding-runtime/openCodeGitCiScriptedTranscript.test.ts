import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VerificationReport } from "@oscharko-dev/keiko-contracts";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import { runMigrations } from "../store/schema.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import {
  CodingRuntimeCiRepairController,
  type CiRepairExecutionBudget,
} from "./codingRuntimeCiRepairController.js";
import { createProductionManagedWorktreeToolFacade } from "./productionManagedWorktreeTools.js";
import { createInMemoryGitDeliveryApprovalStore } from "../gitDelivery/approvalStore.js";
import { createVerifiedCommitService } from "../gitDelivery/verifiedCommitService.js";
import { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import { commitFacadeFixture } from "../gitDelivery/verifiedCommitFacadeTestSupport.js";
import type { CiObservationService } from "../gitDelivery/ciObservationService.js";
import type { VerifiedCommitRunContext } from "../gitDelivery/verifiedCommitTypes.js";
import {
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOLS,
} from "./opencodeToolSchemas.js";
import { createGeneratedOpenCodeBundle } from "./opencodeRuntimeAdapter.js";
import { ScriptedGovernedTools, type ScriptedToolPhase } from "./opencodeFunctionalHarness/_governedTools.js";

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

/** A scripted "model" call: the exact tool-call shape a real OpenCode transcript hands the server. */
function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
): { readonly id: string; readonly name: string; readonly args: Record<string, unknown> } {
  return { id, name, args };
}

async function jsonResult(
  tools: ScriptedGovernedTools,
  name: string,
  args: Record<string, unknown>,
  id: string,
): Promise<Record<string, unknown>> {
  const output = await tools.execute(toolCall(name, args, id), new AbortController().signal);
  return JSON.parse(output) as Record<string, unknown>;
}

/**
 * #3386: proves that a MODEL-SELECTED call to each of keiko_git_status/diff/stage/commit reaches
 * the real generated OpenCode tool source (`createGeneratedOpenCodeBundle`, the same bundle the
 * sidecar hands the real OpenCode 1.17.17 child) and, through it, VerifiedCommitService and
 * RuntimeGitService in the production composition -- exactly the code path
 * `createProductionManagedWorktreeToolFacade` wires for a real run. The model never commits
 * directly: keiko_git_stage/keiko_git_commit only PROPOSE, the existing approval bridge
 * (`codingToolApprovalBridge.ts`'s `issueStage`/`issueCommit`, the same call the orchestrator's
 * `decideApproval` makes once a human approves) is exercised explicitly, and only then does the
 * shared keiko_git_execute redemption tool -- itself the only tool the model can reach the write
 * outcome through -- reach the real service and produce a REAL commit in a real git repository.
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
    readonly tools: ScriptedGovernedTools;
    readonly bridge: ReturnType<typeof commitFacadeFixture>["bridge"];
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
      mode: () => "autonomous-delivery",
      invalidateVerification: (): void => undefined,
    });
    const { facade, bridge } = commitFacadeFixture({
      service,
      gitService,
      root,
      mode: "autonomous-delivery",
      live: () => true,
      report: () => passingReport(root),
    });
    const fetch = async (_url: unknown, init: { readonly body?: unknown }): Promise<Response> => {
      const result = await facade.execute({
        body: String(init.body ?? ""),
        capability: "scripted-fixture-capability",
      });
      return new Response(JSON.stringify(result));
    };
    const tools = new ScriptedGovernedTools({
      env: {
        KEIKO_CODING_MODE: "autonomous-delivery",
        KEIKO_CODING_RUN_ID: "run-3386",
        KEIKO_TOOL_FACADE_URL: "http://scripted-fixture.invalid/tool-facade",
        KEIKO_TOOL_FACADE_CAPABILITY: "scripted-fixture-capability",
      },
      sessionId: "ses_scripted0000000003386",
      broadcast: (): void => undefined,
      fetch: fetch as typeof globalThis.fetch,
    });
    return { tools, bridge };
  }

  it("routes status, diff, a stage propose/approve/execute cycle and a real commit through the production facade", async () => {
    const root = repo();
    const { tools, bridge } = fixture(root);

    const status = await jsonResult(tools, "keiko_git_status", {}, "call-status");
    expect(status.status).toBe("completed");
    expect((status.git as { readonly kind: string }).kind).toBe("status");

    const diff = await jsonResult(
      tools,
      "keiko_git_diff",
      { scope: "working-tree", paths: ["code.js"] },
      "call-diff",
    );
    expect(diff.status).toBe("completed");
    expect((diff.git as { readonly kind: string }).kind).toBe("diff");

    const stagePropose = await jsonResult(
      tools,
      "keiko_git_stage",
      { paths: ["code.js"] },
      "call-stage-propose",
    );
    const stage = stagePropose.git as { readonly status: string; readonly proposalId: string };
    // Staging a workspace-contained change is routine, contained authority in autonomous-delivery
    // (ADR-0129/ADR-0138): the propose call is immediately "ready", with no approval hold -- only
    // the higher-risk commit below requires the approval channel. `keiko_git_stage` still only
    // PROPOSES; keiko_git_execute is the only tool that reaches the write outcome.
    expect(stage.status).toBe("ready");
    expect(stage.proposalId).toMatch(/^stage-\d+$/u);

    const stageExecute = await jsonResult(
      tools,
      "keiko_git_execute",
      { kind: "stage", proposalId: stage.proposalId },
      "call-stage-execute",
    );
    const staged = stageExecute.git as { readonly status: string };
    expect(staged.status).toBe("succeeded");
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("code.js");

    const verification = await jsonResult(
      tools,
      "keiko_verification",
      { verifierId: "typecheck" },
      "call-verify",
    );
    expect(verification.status).toBe("completed");

    const commitPropose = await jsonResult(
      tools,
      "keiko_git_commit",
      { message: "feat: authorized scripted-transcript change" },
      "call-commit-propose",
    );
    const commit = commitPropose.verifiedCommit as {
      readonly status: string;
      readonly proposalId: string;
    };
    expect(commit.status).toBe("approval-required");

    expect(bridge.issueCommit?.("run-1", commit.proposalId)).toBeDefined();

    const beforeHead = git(root, ["rev-parse", "HEAD"]);
    const commitExecute = await jsonResult(
      tools,
      "keiko_git_execute",
      { kind: "commit", proposalId: commit.proposalId },
      "call-commit-execute",
    );
    const executed = commitExecute.verifiedCommit as { readonly status: string };
    expect(executed.status).toBe("succeeded");
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    expect(git(root, ["log", "-1", "--format=%s"])).toBe(
      "feat: authorized scripted-transcript change",
    );
  });

  it("bounds a scripted repair loop with the same cumulative CI repair budget the production controller enforces (#3388)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ci-repair-transcript-")));
    roots.push(root);
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
    let nowMs = 1_000_000;
    const repairController = new CodingRuntimeCiRepairController({
      store: snapshots.ciRepairBudget,
      readiness: snapshots.ciReadiness,
      context: () => ({
        runId: "run-1",
        remoteDigest: DIGEST,
        prNumber: 1,
        correlationId: "scripted-ci-repair-3388",
        limits: { maxRuntimeMs: 600_000, maxToolCalls: 100, maxPromptTokens: 100_000 },
        stillAuthorized: () => true,
      }),
      now: () => nowMs,
    });
    let observation = 0;
    const ciObservationService: CiObservationService = {
      observe: (): Promise<import("@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci").CodingRuntimeCiResult> => {
        observation += 1;
        nowMs += 1_000;
        const snapshot = {
          schemaVersion: "1" as const,
          runId: "run-1",
          remoteDigest: DIGEST,
          repository: "owner/repository",
          prNumber: 1,
          baseRef: "dev",
          baseSha: "1".repeat(40),
          headRef: "codex/task",
          headSha: "2".repeat(40),
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
          humanReview: { visibility: "complete" as const, requiredCount: 0, approvedCount: 0 },
        };
        const ticket = snapshots.ciReadiness.begin("run-1");
        snapshots.ciReadiness.complete(ticket, snapshot);
        repairController.observed(snapshot);
        return Promise.resolve({ status: "observed" as const, snapshot, retryAfterMs: 0 });
      },
    };

    const facade = createProductionManagedWorktreeToolFacade({
      ciObservationService,
      ciRepairBudget: repairController as unknown as CiRepairExecutionBudget,
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
      secureWorkspaceTextRead: { readText: () => Promise.resolve({ ok: false, reason: "not-found" }) },
      editorAgentClient: {
        action: () =>
          Promise.resolve({ ok: false, error: { kind: "route", code: "denied", message: "denied" } }),
      },
      invocationRegistry: createCodingToolInvocationRegistry(),
      verificationRunner: { runToReport: () => Promise.resolve(failingReport(root)) },
      onRuntimeEvent: (): void => undefined,
    });
    const fetch = async (_url: unknown, init: { readonly body?: unknown }): Promise<Response> => {
      const result = await facade.execute({
        body: String(init.body ?? ""),
        capability: "scripted-fixture-capability",
      });
      return new Response(JSON.stringify(result));
    };
    const tools = new ScriptedGovernedTools({
      env: {
        KEIKO_CODING_MODE: "autonomous-delivery",
        KEIKO_CODING_RUN_ID: "run-3388",
        KEIKO_TOOL_FACADE_URL: "http://scripted-fixture.invalid/tool-facade",
        KEIKO_TOOL_FACADE_CAPABILITY: "scripted-fixture-capability",
      },
      sessionId: "ses_scripted0000000003388",
      broadcast: (): void => undefined,
      fetch: fetch as typeof globalThis.fetch,
    });

    // Three observe-then-repair cycles: the model calls keiko_ci_status (a fresh failed
    // readiness observation), then keiko_verification in response -- each verification attempt
    // fails, charging the SAME cumulative CI repair budget CI_REPAIR_MAX_FAILED_ATTEMPTS bounds.
    const outcomes: string[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const ci = await jsonResult(tools, "keiko_ci_status", {}, `call-ci-${String(cycle)}`);
      expect(ci.status).toBe("completed");
      expect((ci.ci as { readonly status: string }).status).toBe("observed");
      const verify = await jsonResult(
        tools,
        "keiko_verification",
        { verifierId: "typecheck" },
        `call-verify-${String(cycle)}`,
      );
      outcomes.push(verify.status as string);
    }
    // The first CI_REPAIR_MAX_FAILED_ATTEMPTS (3) failing repair attempts are admitted and
    // executed (they fail on their own verification merits); the loop does not run unbounded --
    // the fourth is denied by the budget itself, fail-closed, before verification ever runs again.
    expect(outcomes.slice(0, 3)).toEqual(["failed", "failed", "failed"]);
    expect(outcomes[3]).not.toBe("failed");
    const denied = await jsonResult(
      tools,
      "keiko_verification",
      { verifierId: "typecheck" },
      "call-verify-exhausted",
    );
    expect(denied.status).toBe("failed");
    expect(JSON.stringify(denied)).toContain("ci-repair-budget-blocked");
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
    // Mirrors the real gateway wire projection: OpenCode 1.17.17 strips `additionalProperties`
    // from keiko_verification before forwarding it, so the admission check is keyed on the
    // PROJECTED schema, not the raw generated one -- exercised here without restating the digest
    // logic itself, which stays owned by `hasExactOpenCodeVisibleToolContract`.
    const gatewayVisible = OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => ({
      name,
      parameters:
        name === "keiko_verification"
          ? {
              type: "object",
              properties: (parameters as { properties: unknown }).properties,
              required: (parameters as { required: unknown }).required,
            }
          : parameters,
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
    expect(Object.hasOwn(createGeneratedOpenCodeBundle().toolSources, "keiko_git_status_removed")).toBe(
      false,
    );
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
});
