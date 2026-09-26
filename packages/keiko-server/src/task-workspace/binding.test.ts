import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  validateWorkspaceBinding,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { createSingleRootWorkspaceManifest } from "../workspace-manifest-identity.js";
import { buildBinding } from "./binding.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function instance(): WorkspaceInstance {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: "workspace-code-task",
    taskId: "task-code",
    repositoryId: "repository-keiko",
    repositoryRoot: "/repos/keiko",
    baseBranch: "dev",
    taskBranch: "issue/2524",
    managedWorktreePath: "/worktrees/code-task",
    gitdirIdentity: "a".repeat(64),
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "correlation-code-task",
  };
}

describe("buildBinding", () => {
  it("keeps the OpenCode single-root V1 fixture byte-identical", () => {
    expect(JSON.stringify(buildBinding(instance()))).toBe(
      '{"schemaVersion":"1","workspaceId":"workspace-code-task","taskId":"task-code","activeRoot":"/worktrees/code-task","boundSurfaces":["chat","files","terminal","browser","editor","runtime","git-delivery","review"],"gitDeliveryRoot":"/worktrees/code-task","editorProjectRoot":"/worktrees/code-task"}',
    );
  });

  it("derives a valid V2 binding per manifest root through the same helper", () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-binding-v2-"));
    roots.push(tmp);
    const project = join(tmp, "project");
    mkdirSync(project);
    const manifest = createSingleRootWorkspaceManifest(project, "Project");
    const binding = buildBinding(manifest, "editor-workspace");

    expect(validateWorkspaceBinding(binding)).toEqual({ ok: true });
    expect(binding.roots[0]).toMatchObject({
      rootPath: manifest.roots[0]?.canonicalRoot,
      gitDeliveryRoot: manifest.roots[0]?.canonicalRoot,
      editorProjectRoot: manifest.roots[0]?.canonicalRoot,
    });
  });
});
