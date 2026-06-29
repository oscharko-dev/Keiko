// Integration coverage for the governed local Git execution core (Issue #475, Epic #470). Exercises
// executeGovernedMutation with its DEFAULT seams (the real node adapter + the real read-only snapshot
// reader) against a disposable hermetic git repository, plus the pure response projection across every
// outcome status. This proves the whole local-execution stack end-to-end and covers the default-seam
// branches the route tests inject around.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryRepoPolicyPack,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import type { GitMutationLifecycleResult } from "@oscharko-dev/keiko-tools";
import { buildRedactor } from "../index.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryUiStore } from "../store/index.js";
import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
  KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK,
  resolveProjectWorkspace,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "../task-workspace/naming.js";

let root: string;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function workspaceInfo(rootPath: string): WorkspaceInfo {
  return {
    root: rootPath,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const ALLOW_LOCAL: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: {
    decision: "constrained",
    constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
  },
};

function captureStore(): { store: EvidenceStore; count: () => number } {
  const docs = new Map<string, string>();
  return {
    store: {
      put: (id, json): string => {
        docs.set(id, json);
        return id;
      },
      list: () => [...docs.keys()],
      get: (id) => docs.get(id),
      delete: (id) => docs.delete(id),
    },
    count: (): number => {
      let n = 0;
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: unknown[] };
        n += Array.isArray(doc.records) ? doc.records.length : 0;
      }
      return n;
    },
  };
}

// Real adapter + real snapshot reader: only the trusted policy pack is supplied (no adapter/reader/now
// seam), exercising the default-seam branches and the live read-only inspection + mutation boundary.
const REAL_SEAMS: GitDeliveryExecutionSeams = { policyPacks: { repoPack: ALLOW_LOCAL } };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-exec-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("executeGovernedMutation — real git through the default seams", () => {
  it("creates a branch and records evidence", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    const result = await executeGovernedMutation(
      {
        kind: "branch-create",
        branchName: "feature/x",
        baseBranchName: "main",
        startPointRefHash: "HEAD",
      },
      { required: false },
      workspaceInfo(root),
      deps,
      REAL_SEAMS,
    );
    expect(result.outcome.status).toBe("succeeded");
    expect(git(["branch", "--list", "feature/x"])).toContain("feature/x");
    expect(cap.count()).toBe(1);
  });

  it("switches branch, stages a file, and commits — all through the kernel", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    git(["branch", "feature/y"]);
    const ws = workspaceInfo(root);

    const switched = await executeGovernedMutation(
      { kind: "branch-switch", branchName: "feature/y" },
      { required: false },
      ws,
      deps,
      REAL_SEAMS,
    );
    expect(switched.outcome.status).toBe("succeeded");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/y");

    writeFileSync(join(root, "b.txt"), "x\n", "utf8");
    const staged = await executeGovernedMutation(
      { kind: "stage", pathspecs: ["b.txt"], includeUntracked: true },
      { required: false },
      ws,
      deps,
      REAL_SEAMS,
    );
    expect(staged.outcome.status).toBe("succeeded");

    const committed = await executeGovernedMutation(
      { kind: "commit", message: "feat: add b", allowEmpty: false },
      { required: false },
      ws,
      deps,
      REAL_SEAMS,
    );
    expect(committed.outcome.status).toBe("succeeded");
    expect(git(["log", "--oneline"])).toContain("feat: add b");
    expect(cap.count()).toBe(3);
  });

  it("blocks a commit at preflight when nothing is staged (no mutation)", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    const result = await executeGovernedMutation(
      { kind: "commit", message: "feat: nothing", allowEmpty: false },
      { required: false },
      workspaceInfo(root),
      deps,
      REAL_SEAMS,
    );
    expect(result.outcome.status).toBe("blocked");
    expect(gitDeliveryMutationResponse(result).preflightFindingCodes).toContain(
      "nothing-staged-to-commit",
    );
  });

  it("uses the default policy pack (local-mutation permitted) when no packs are injected", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    // No seams at all → default node adapter, default reader, default clock/id, default local pack.
    const result = await executeGovernedMutation(
      {
        kind: "branch-create",
        branchName: "feature/z",
        baseBranchName: "main",
        startPointRefHash: "HEAD",
      },
      { required: false },
      workspaceInfo(root),
      deps,
      {},
    );
    expect(result.outcome.status).toBe("succeeded");
    expect(KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK.defaultRule?.decision).toBe("constrained");
  });

  it("surfaces a worktree read failure as a thrown error outside a git repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-nonrepo-")));
    const deps = { evidenceStore: captureStore().store, redactor: buildRedactor({}) };
    try {
      await expect(
        executeGovernedMutation(
          { kind: "branch-switch", branchName: "main" },
          { required: false },
          workspaceInfo(bare),
          deps,
          REAL_SEAMS,
        ),
      ).rejects.toBeTruthy();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ─── Pure response projection across every outcome status ────────────────────────────────────────

function lifecycle(outcome: GitMutationLifecycleResult["outcome"]): GitMutationLifecycleResult {
  return {
    envelope: {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      actionId: "a1",
      kind: "commit",
      resolvedInputs: {
        kind: "commit",
        messageByteLength: 4,
        stagedPathCount: 1,
        allowEmptyCommit: false,
      },
      policyDecision: { outcome: "allowed" },
      approvalRequirement: { required: false },
      preview: {
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        wouldCreateRemoteBranch: false,
        wouldTriggerChecks: false,
      },
    },
    outcome,
    phaseReached: "result",
    preflight: { ok: true, findings: [], blocking: [], advisory: [] },
  };
}

const exec = {
  schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
  outcome: "failed" as const,
  durationMs: 1,
  errorCode: "internal-error" as const,
};

describe("gitDeliveryMutationResponse — content-free projection of every outcome", () => {
  it("succeeded", () => {
    expect(
      gitDeliveryMutationResponse(
        lifecycle({
          status: "succeeded",
          executionResult: { ...exec, outcome: "succeeded", errorCode: undefined },
        }),
      ).status,
    ).toBe("succeeded");
  });
  it("approval-required carries the required approvers", () => {
    const body = gitDeliveryMutationResponse(
      lifecycle({ status: "approval-required", requiredApprovers: ["lead"] }),
    );
    expect(body.status).toBe("approval-required");
    expect(body.requiredApprovers).toEqual(["lead"]);
  });
  it("policy-block carries the typed block reason", () => {
    const body = gitDeliveryMutationResponse(
      lifecycle({
        status: "blocked",
        category: "policy-block",
        blockReason: "policy-pack-blocked",
      }),
    );
    expect(body.blockReason).toBe("policy-pack-blocked");
  });
  it("failed and recovery-required carry the execution error code", () => {
    expect(
      gitDeliveryMutationResponse(
        lifecycle({ status: "failed", category: "execution-failure", executionResult: exec }),
      ).executionErrorCode,
    ).toBe("internal-error");
    expect(
      gitDeliveryMutationResponse(
        lifecycle({
          status: "recovery-required",
          category: "recovery-required",
          executionResult: exec,
        }),
      ).executionErrorCode,
    ).toBe("internal-error");
  });
});

describe("resolveProjectWorkspace", () => {
  it("resolves a registered project path and rejects an unknown one", () => {
    const store = createInMemoryUiStore();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-rp-")));
    try {
      const proj = store.createProject(dir);
      expect(resolveProjectWorkspace({ store }, proj.path)?.root).toBe(proj.path);
      expect(resolveProjectWorkspace({ store }, "/repo/missing")).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a persisted managed task workspace root without legacy project registration", () => {
    const store = createInMemoryUiStore();
    const managedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-managed-root-")));
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-managed-repo-")));
    const repositoryId = deriveRepositoryId(repoRoot);
    const workspaceId = deriveWorkspaceId({ repositoryId, taskId: "task-443" });
    const managedWorktreePath = deriveManagedWorktreePath({
      managedRoot,
      repositoryId,
      workspaceId,
    });
    mkdirSync(managedWorktreePath, { recursive: true });
    const instance: WorkspaceInstance = {
      schemaVersion: "1",
      workspaceId,
      taskId: "task-443",
      repositoryId,
      repositoryRoot: repoRoot,
      baseBranch: "main",
      taskBranch: deriveTaskBranchName({ taskId: "task-443" }),
      managedWorktreePath,
      gitdirIdentity: "gitdir-hash",
      lifecycleState: "active",
      health: "healthy",
      lock: null,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      driftMarkers: [],
      recoveryHints: [],
      auditCorrelationId: workspaceId,
    };
    try {
      expect(
        resolveProjectWorkspace(
          {
            store,
            managedTaskWorkspaceRoot: managedRoot,
            workspaceProvisioning: {
              getInstance: (id: string) => (id === workspaceId ? instance : undefined),
              provision: () => Promise.reject(new Error("not used")),
              activate: () => Promise.reject(new Error("not used")),
            },
          },
          managedWorktreePath,
        )?.root,
      ).toBe(managedWorktreePath);
    } finally {
      store.close();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(managedRoot, { recursive: true, force: true });
    }
  });
});
