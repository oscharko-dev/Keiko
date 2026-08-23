/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local authority fixtures are contextually typed. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  productionRuntimeAuthorityFacts,
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
} from "./productionRuntimeWorkspaceAuthority.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production runtime workspace authority", () => {
  it("binds only the healthy active managed worktree and fails on live HEAD drift", () => {
    const managed = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-managed-")));
    roots.push(managed);
    const workspace = join(managed, "repo", "workspace");
    mkdirSync(workspace, { recursive: true });
    let head = "1".repeat(40);
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
          lastVerifiedHead: "1".repeat(40),
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
    head = "2".repeat(40);
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
