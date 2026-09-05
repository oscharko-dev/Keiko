import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts";
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local authority fixtures are contextually typed. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  productionRuntimeAuthorityFacts,
  productionWorkspaceMatches,
  type ProductionWorkspaceAuthorityInput,
  resolveProductionRuntimeContext,
} from "./productionRuntimeWorkspaceAuthority.js";
import {
  CodingRuntimeLaunchResolutionError,
  type CodingRuntimeLaunchResolutionFailureReason,
} from "./launchFailure.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expectLaunchResolutionFailure(
  run: () => unknown,
  reason: CodingRuntimeLaunchResolutionFailureReason,
): void {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CodingRuntimeLaunchResolutionError);
    if (error instanceof CodingRuntimeLaunchResolutionError) expect(error.reason).toBe(reason);
    return;
  }
  throw new Error("expected launch resolution failure");
}

describe("production runtime workspace authority", () => {
  it("binds only the healthy active managed worktree and fails on live HEAD drift", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-managed-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    let head = "1".repeat(40);
    let verifiedHead = head;
    let commitResult: VerifiedCommitResult | undefined;
    const lifecycle = {
      getActive: () => ({
        instance: {
          workspaceId: "workspace-private",
          repositoryId: "repository-private",
          repositoryRoot: workspace,
          managedWorktreePath: workspace,
          taskId: "task-private",
          taskBranch: "issue/2376-runtime",
          baseBranch: "dev",
          lastVerifiedHead: verifiedHead,
          lifecycleState: "active",
          health: "healthy",
          driftMarkers: [],
        },
        binding: { activeRoot: workspace },
      }),
    };
    const input = {
      workspaceLifecycle: lifecycle as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding" as const,
      readWorkspaceHead: () => head,
      verifiedCommitResult: (): VerifiedCommitResult | undefined => commitResult,
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    };
    const context = resolveProductionRuntimeContext(input, {
      runId: "run-1",
      requestId: "request-1",
      taskIntent: "private task",
      requestedMode: "supervised-coding",
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    });

    expect(context.workspaceRoot).toBe(workspace);
    expect(context.deploymentCeiling).toBe("supervised-coding");
    expect(productionRuntimeAuthorityFacts(input, context).binding).not.toMatchObject({
      taskId: "task-private",
      workspaceId: "workspace-private",
    });
    expect(productionWorkspaceMatches(input, context)).toBe(true);
    const workspaceDigest = productionRuntimeAuthorityFacts(input, context).binding
      .workspaceRootDigest;
    head = "2".repeat(40);
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    verifiedHead = head;
    // The existing manual restamp still cannot bless an external HEAD move for a runtime.
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    const receipt: VerifiedCommitResult = {
      schemaVersion: "1",
      proposalId: "commit-1",
      runId: "run-1",
      envelopeDigest: "a".repeat(64),
      runtimeAuthorityDigest: "b".repeat(64),
      workspaceDigest,
      repositoryDigest: "c".repeat(64),
      baseSha: "1".repeat(40),
      parentSha: "1".repeat(40),
      headSha: head,
      stagedTreeDigest: "d".repeat(64),
      committedTreeDigest: "d".repeat(64),
      messageDigest: "e".repeat(64),
      verificationEvidenceId: "verification-1",
      status: "succeeded",
      reason: "completed",
      recordedAt: "2026-07-13T12:00:00.000Z",
    };
    commitResult = { ...receipt, runId: "other-run" };
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    commitResult = { ...receipt, workspaceDigest: "0".repeat(64) };
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    commitResult = receipt;
    expect(productionWorkspaceMatches(input, context)).toBe(true);
    head = "3".repeat(40);
    expect(productionWorkspaceMatches(input, context)).toBe(false);
  });

  it("derives the runtime and model source from the validated runtime preference", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-codex-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    const instance = {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: workspace,
      managedWorktreePath: workspace,
      taskId: "task-private",
      taskBranch: "issue/2376-runtime",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    };
    const context = resolveProductionRuntimeContext(
      {
        workspaceLifecycle: {
          getActive: () => ({ instance, binding: { activeRoot: workspace } }),
        } as never,
        managedTaskWorkspaceRoot: managed,
        deploymentCeiling: "supervised-coding",
        readWorkspaceHead: () => "1".repeat(40),
      },
      {
        runId: "run-codex",
        requestId: "request-codex",
        taskIntent: "private task",
        requestedMode: "supervised-coding",
        runtimePreference: "codex-subscription",
        workspaceId: "workspace-private",
        workspaceRoot: workspace,
        serverPrincipal: "operator-private",
      },
    );

    expect(context).toMatchObject({
      runtimeSource: "codex-cli-adapter",
      modelProfile: {
        source: "chatgpt-codex-subscription-profile",
      },
    });

    const managedContext = resolveProductionRuntimeContext(
      {
        workspaceLifecycle: {
          getActive: () => ({ instance, binding: { activeRoot: workspace } }),
        } as never,
        managedTaskWorkspaceRoot: managed,
        deploymentCeiling: "supervised-coding",
        readWorkspaceHead: () => "1".repeat(40),
        resolveManagedModelProfile: (modelId, reasoningEffort) => ({
          profileId: modelId ?? "default-model",
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }),
      },
      {
        runId: "run-managed",
        requestId: "request-managed",
        taskIntent: "private task",
        requestedMode: "supervised-coding",
        runtimePreference: "managed-gateway",
        modelId: "qwen-coder",
        reasoningEffort: "high",
        workspaceId: "workspace-private",
        workspaceRoot: workspace,
        serverPrincipal: "operator-private",
      },
    );

    expect(managedContext.modelProfile).toMatchObject({
      profileId: "qwen-coder",
      source: "keiko-model-gateway",
      reasoningEffort: "high",
    });
  });

  it("classifies unsupported subscription effort and unknown managed models separately", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-selection-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    const instance = {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: workspace,
      managedWorktreePath: workspace,
      taskId: "task-private",
      taskBranch: "issue/runtime",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    };
    const input: ProductionWorkspaceAuthorityInput = {
      workspaceLifecycle: {
        getActive: () => ({ instance, binding: { activeRoot: workspace } }),
      } as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding",
      readWorkspaceHead: () => "1".repeat(40),
    };
    const request = {
      runId: "run-selection",
      requestId: "request-selection",
      taskIntent: "private task",
      requestedMode: "supervised-coding" as const,
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    };

    expectLaunchResolutionFailure(
      () =>
        resolveProductionRuntimeContext(input, {
          ...request,
          runtimePreference: "codex-subscription",
          reasoningEffort: "high",
        }),
      "codex-reasoning-effort-unsupported",
    );
    expectLaunchResolutionFailure(
      () =>
        resolveProductionRuntimeContext(input, {
          ...request,
          runtimePreference: "managed-gateway",
          modelId: "unknown-model",
        }),
      "managed-model-unqualified",
    );
  });

  it("denies non-canonical and mismatched request, binding, and instance roots", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-roots-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    const other = join(managed, "repo", "other");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(other, { recursive: true });
    const alias = join(managed, "workspace-alias");
    symlinkSync(workspace, alias);
    let activeRoot = workspace;
    let managedWorktreePath = workspace;
    const instance = {
      workspaceId: "workspace-private",
      repositoryId: "repository-private",
      repositoryRoot: workspace,
      get managedWorktreePath() {
        return managedWorktreePath;
      },
      taskId: "task-private",
      taskBranch: "issue/2376-runtime",
      baseBranch: "dev",
      lastVerifiedHead: "1".repeat(40),
      lifecycleState: "active",
      health: "healthy",
      driftMarkers: [],
    };
    const input = {
      workspaceLifecycle: {
        getActive: () => ({ instance, binding: { activeRoot } }),
      } as never,
      managedTaskWorkspaceRoot: managed,
      deploymentCeiling: "supervised-coding" as const,
      readWorkspaceHead: () => "1".repeat(40),
    };
    const request = {
      runId: "run-1",
      requestId: "request-1",
      taskIntent: "private task",
      requestedMode: "supervised-coding" as const,
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    };

    expect(() =>
      resolveProductionRuntimeContext(input, { ...request, workspaceRoot: alias }),
    ).toThrow("runtime-workspace-unqualified");
    activeRoot = other;
    expect(() => resolveProductionRuntimeContext(input, request)).toThrow(
      "runtime-workspace-unqualified",
    );
    activeRoot = workspace;
    const context = resolveProductionRuntimeContext(input, request);
    managedWorktreePath = other;
    expect(productionWorkspaceMatches(input, context)).toBe(false);
  });

  it.each([
    [
      "task identity",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.taskId = "task-2"),
    ],
    [
      "project identity",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.repositoryId = "repository-2"),
    ],
    [
      "project root digest",
      (fixture: ReturnType<typeof liveFixture>) =>
        (fixture.instance.repositoryRoot = fixture.other),
    ],
    [
      "base branch",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.baseBranch = "release"),
    ],
    [
      "task branch",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.taskBranch = "issue/other"),
    ],
    [
      "workspace identity",
      (fixture: ReturnType<typeof liveFixture>) => (fixture.instance.workspaceId = "workspace-2"),
    ],
    [
      "workspace root",
      (fixture: ReturnType<typeof liveFixture>) =>
        (fixture.instance.managedWorktreePath = fixture.other),
    ],
    [
      "active root",
      (fixture: ReturnType<typeof liveFixture>) => {
        fixture.setActiveRoot(fixture.other);
      },
    ],
    [
      "verified HEAD",
      (fixture: ReturnType<typeof liveFixture>) =>
        (fixture.instance.lastVerifiedHead = "2".repeat(40)),
    ],
    [
      "live HEAD",
      (fixture: ReturnType<typeof liveFixture>) => {
        fixture.setHead("2".repeat(40));
      },
    ],
  ])("denies live %s drift before retained authority use", (_field, mutate) => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(fixture.input, fixture.request);

    mutate(fixture);

    expect(productionWorkspaceMatches(fixture.input, context)).toBe(false);
  });

  it("denies altered branch constraints even when live workspace fields still match", () => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(fixture.input, fixture.request);

    expect(
      productionWorkspaceMatches(fixture.input, {
        ...context,
        branch: { ...context.branch, allowedPrefixes: ["untrusted/"] },
      }),
    ).toBe(false);
  });

  it.each([
    [
      "governed-assist",
      [],
      ["command-execution", "delivery-substrate", "connector-access", "network-egress"],
    ],
    [
      "supervised-coding",
      ["command-execution"],
      ["delivery-substrate", "connector-access", "network-egress"],
    ],
    [
      "autonomous-delivery",
      ["command-execution", "delivery-substrate", "connector-access", "network-egress"],
      [],
    ],
  ] as const)("derives the production authority envelope for %s", (mode, included, excluded) => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(
      { ...fixture.input, deploymentCeiling: mode },
      { ...fixture.request, requestedMode: mode },
    );

    for (const actionClass of included) expect(context.actionClasses).toContain(actionClass);
    for (const actionClass of excluded) {
      expect(context.actionClasses).not.toContain(actionClass);
    }
    expect(context.commandPolicy.requirePerCommandApproval).toBe(mode !== "autonomous-delivery");
    if (mode === "autonomous-delivery") {
      expect(context.connectorScopes).toEqual(["source-control.read", "source-control.write"]);
      expect(context.networkPolicy).toEqual({
        mode: "connector-scoped-egress",
        allowLoopback: false,
        connectorScopes: ["source-control.read", "source-control.write"],
      });
    } else {
      // The lower two modes were only ever asserted through their action classes. Without this the
      // scope and network derivations were unpinned for them, which is how the clamp defect below
      // stayed invisible.
      expect(context.connectorScopes).toEqual([]);
      expect(context.networkPolicy.connectorScopes).toEqual([]);
    }
  });

  // #3384 / #3386: every capability in the envelope is derived from the EFFECTIVE mode — the
  // fail-closed minimum of requested mode and deployment ceiling (ADR-0124 D2) — not from the
  // requested mode. Deriving from the request let a run ask for `autonomous-delivery` under a lower
  // ceiling and receive a clamped `effectiveMode` while still carrying `delivery-substrate`,
  // `source-control.write` and a connector-scoped network policy, which the runtime tool port and
  // the Git-delivery route admission both accept. That is authority widening by request.
  it.each([
    ["supervised-coding", ["command-execution"], ["delivery-substrate", "connector-access"]],
    ["governed-assist", [], ["command-execution", "delivery-substrate", "connector-access"]],
  ] as const)(
    "clamps every derived capability to the deployment ceiling %s when a higher mode is requested",
    (ceiling, included, excluded) => {
      const fixture = liveFixture();
      const context = resolveProductionRuntimeContext(
        { ...fixture.input, deploymentCeiling: ceiling },
        { ...fixture.request, requestedMode: "autonomous-delivery" },
      );

      expect(context.deploymentCeiling).toBe(ceiling);
      for (const actionClass of included) expect(context.actionClasses).toContain(actionClass);
      for (const actionClass of excluded) {
        expect(context.actionClasses).not.toContain(actionClass);
      }
      expect(context.actionClasses).not.toContain("network-egress");
      expect(context.connectorScopes).toEqual([]);
      expect(context.networkPolicy).toEqual({
        mode: "deny-all",
        allowLoopback: false,
        connectorScopes: [],
      });
      expect(context.commandPolicy.requirePerCommandApproval).toBe(true);
      expect(context.commandPolicy.mode).toBe(ceiling === "governed-assist" ? "deny" : "governed");
    },
  );

  // ADR-0138's fail-closed rule: an unknown, missing or malformed mode value resolves to
  // `governed-assist`, the lowest posture. Asserted here on the production resolver, because a
  // malformed value reaching it must yield the same empty envelope a governed-assist run gets —
  // not an accidental grant from a comparison that silently fell through.
  it.each([
    ["malformed requested mode", "AUTONOMOUS-DELIVERY", "autonomous-delivery"],
    ["empty requested mode", "", "autonomous-delivery"],
    ["malformed ceiling", "autonomous-delivery", "full-access"],
    ["empty ceiling", "autonomous-delivery", ""],
    ["both malformed", "not-a-mode", "not-a-mode"],
  ] as const)("fails closed to the lowest posture for a %s", (_label, requestedMode, ceiling) => {
    const fixture = liveFixture();
    const context = resolveProductionRuntimeContext(
      { ...fixture.input, deploymentCeiling: ceiling as never },
      { ...fixture.request, requestedMode: requestedMode as never },
    );

    for (const actionClass of ["command-execution", "delivery-substrate", "connector-access"]) {
      expect(context.actionClasses).not.toContain(actionClass);
    }
    expect(context.connectorScopes).toEqual([]);
    expect(context.networkPolicy).toEqual({
      mode: "deny-all",
      allowLoopback: false,
      connectorScopes: [],
    });
    expect(context.commandPolicy.mode).toBe("deny");
    expect(context.commandPolicy.requirePerCommandApproval).toBe(true);
  });
});

function liveFixture() {
  const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-live-fields-")));
  roots.push(managed);
  const workspace = join(managed, "repo", "workspace");
  const other = join(managed, "repo", "other");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(other, { recursive: true });
  let activeRoot = workspace;
  let head = "1".repeat(40);
  const instance = {
    workspaceId: "workspace-private",
    repositoryId: "repository-private",
    repositoryRoot: workspace,
    managedWorktreePath: workspace,
    taskId: "task-private",
    taskBranch: "issue/2376-runtime",
    baseBranch: "dev",
    lastVerifiedHead: head,
    lifecycleState: "active",
    health: "healthy",
    driftMarkers: [],
  };
  const input = {
    workspaceLifecycle: {
      getActive: () => ({ instance, binding: { activeRoot } }),
    } as never,
    managedTaskWorkspaceRoot: managed,
    deploymentCeiling: "supervised-coding" as const,
    readWorkspaceHead: () => head,
  };
  return {
    input,
    instance,
    other,
    request: {
      runId: "run-live",
      requestId: "request-live",
      taskIntent: "private task",
      requestedMode: "supervised-coding" as const,
      workspaceId: "workspace-private",
      workspaceRoot: workspace,
      serverPrincipal: "operator-private",
    },
    setActiveRoot: (value: string): void => {
      activeRoot = value;
    },
    setHead: (value: string): void => {
      head = value;
    },
  };
}
