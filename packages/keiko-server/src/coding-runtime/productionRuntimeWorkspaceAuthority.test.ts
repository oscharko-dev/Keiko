import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { WorkspaceBinding, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";

import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import {
  productionRuntimeAuthorityFacts,
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
} from "./productionRuntimeWorkspaceAuthority.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";

describe("production runtime workspace authority", () => {
  it("rejects admission and live use when Git HEAD moves behind the cached workspace snapshot", () => {
    const fixture = workspaceFixture();
    let liveHead = fixture.instance.lastVerifiedHead;
    const input = {
      workspaceLifecycle: fixture.lifecycle,
      managedTaskWorkspaceRoot: fixture.managedRoot,
      readWorkspaceHead: (): string | undefined => liveHead,
    };
    const context = resolveProductionRuntimeContext(input, launchRequest(fixture.workspaceRoot));
    expect(productionWorkspaceMatches(input, context)).toBe(true);

    liveHead = "b".repeat(40);
    expect(productionWorkspaceMatches(input, context)).toBe(false);
    expect(() =>
      resolveProductionRuntimeContext(input, launchRequest(fixture.workspaceRoot)),
    ).toThrow("runtime-workspace-unqualified");
  });

  it("projects live facts using the authority labels and never includes raw workspace metadata", () => {
    const fixture = workspaceFixture();
    const input = {
      workspaceLifecycle: fixture.lifecycle,
      managedTaskWorkspaceRoot: fixture.managedRoot,
      readWorkspaceHead: (): string | undefined => fixture.instance.lastVerifiedHead,
    };
    const context = resolveProductionRuntimeContext(input, launchRequest(fixture.workspaceRoot));
    const facts = productionRuntimeAuthorityFacts(input, context);

    expect(facts.binding).toMatchObject({
      taskId: projectRuntimeAuthorityValue("task", fixture.instance.taskId),
      projectId: projectRuntimeAuthorityValue("project", fixture.instance.repositoryId),
      workspaceId: projectRuntimeAuthorityValue("workspace", fixture.instance.workspaceId),
      branchRef: projectRuntimeAuthorityValue("branch", fixture.instance.taskBranch),
    });
    expect(JSON.stringify(facts)).not.toContain(fixture.instance.taskBranch);
    expect(JSON.stringify(facts)).not.toContain(fixture.instance.repositoryId);
  });
});

function launchRequest(workspaceRoot: string): {
  readonly runId: string;
  readonly requestId: string;
  readonly taskIntent: string;
  readonly requestedMode: "autonomous-delivery";
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly serverPrincipal: string;
} {
  return {
    runId: "run-2258",
    requestId: "request-2258",
    taskIntent: "Implement issue 2258",
    requestedMode: "autonomous-delivery" as const,
    workspaceId: "workspace-2258",
    workspaceRoot,
    serverPrincipal: "operator-2258",
  };
}

function workspaceFixture(): {
  readonly managedRoot: string;
  readonly workspaceRoot: string;
  readonly instance: WorkspaceInstance;
  readonly lifecycle: WorkspaceLifecycleService;
} {
  const managedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-managed-")));
  const workspaceRoot = join(managedRoot, "workspace-2258");
  mkdirSync(workspaceRoot);
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId: "workspace-2258",
    taskId: "task-2258",
    repositoryId: "repo_aaaaaaaaaaaaaaaa",
    repositoryRoot: managedRoot,
    baseBranch: "dev",
    taskBranch: "issue/2258-real-runtime-qualification",
    managedWorktreePath: workspaceRoot,
    gitdirIdentity: "gitdir-2258",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "audit-2258",
    lastVerifiedHead: "a".repeat(40),
  };
  const binding = workspaceBinding(workspaceRoot);
  const active = {
    instance,
    binding,
    pointer: {
      workspaceId: instance.workspaceId,
      setBy: "operator-2258",
      setAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:00:00.000Z",
    },
  };
  const lifecycle: WorkspaceLifecycleService = {
    list: () => [instance],
    getActive: () => active,
    setActive: () => Promise.resolve(active),
    clearActive: () => undefined,
    pause: () => Promise.resolve({ instance, binding }),
    resume: () => Promise.resolve({ instance, binding }),
    prepareHandoff: () => Promise.resolve({ instance, binding }),
  };
  return { managedRoot, workspaceRoot, instance, lifecycle };
}

function workspaceBinding(root: string): WorkspaceBinding {
  return {
    schemaVersion: "1",
    workspaceId: "workspace-2258",
    taskId: "task-2258",
    activeRoot: root,
    boundSurfaces: ["git-delivery", "editor"],
    gitDeliveryRoot: root,
    editorProjectRoot: root,
  };
}
