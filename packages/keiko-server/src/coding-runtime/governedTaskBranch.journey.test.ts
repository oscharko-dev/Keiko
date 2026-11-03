import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type { GitLocalMutationAdapter, GitMutationOutcome } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import { createInMemoryUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createInMemoryGitDeliveryApprovalStore } from "../gitDelivery/approvalStore.js";
import { executeGovernedMutation } from "../gitDelivery/execution.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../task-workspace/active-store.js";
import { withLocalCheckout } from "../task-workspace/local-checkout.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../task-workspace/store.js";
import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { createGovernedTaskBranches } from "./governedTaskBranches.js";
import { createProductionTaskBranchPort } from "./productionTaskBranchPort.js";
import {
  productionWorkspaceMatches,
  resolveProductionRuntimeContext,
  type ProductionWorkspaceAuthorityInput,
} from "./productionRuntimeWorkspaceAuthority.js";
import { readProductionWorkspaceHead } from "./productionWorkspaceHeadReader.js";
import {
  createProductionRuntimeGitService,
  resolveVerifiedCommitContext,
  type VerifiedCommitRuntimeBinding,
  type VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";

// #3907 (owner decision 2026-10-31): the journey the Coding Workbench lab asks of a model on a Local
// checkout of `main`. A commit there is blocked as a protected branch; the model asks Keiko for a
// task branch; the same checkout, authority and delivery context then stand on that branch with
// `main` as the base, and the commit gate no longer blocks. Everything here is the production
// composition against a real fixture-owned repository: the Local checkout lifecycle, the runtime Git
// service with its Git kernel, the per-run branch record, the workspace authority and the
// verified-commit context. Only the OpenCode runtime and the signing of a commit are not part of it.

let base: string;
let root: string;
let db: DatabaseSync;
let events: ServerLogEvent[];

function git(...args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: base,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Keiko Test",
      GIT_AUTHOR_EMAIL: "keiko@example.test",
      GIT_COMMITTER_NAME: "Keiko Test",
      GIT_COMMITTER_EMAIL: "keiko@example.test",
    },
  }).trim();
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-task-branch-journey-")));
  root = join(base, "repo");
  execFileSync("git", ["init", "-qb", "main", root]);
  writeFileSync(join(root, "code.js"), "export const value = 1;\n");
  git("add", "code.js");
  git("commit", "-qm", "base");
  events = [];
  db = new DatabaseSync(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

// A commit adapter that records what it was asked and succeeds: the governed commit itself needs a
// signing key, and what this journey proves is the kernel's decision about the branch.
function committingAdapter(commits: string[]): GitLocalMutationAdapter {
  const succeeded = (): Promise<never> => Promise.reject(new Error("not used by this journey"));
  return {
    createBranch: succeeded,
    switchBranch: succeeded,
    stage: succeeded,
    unstage: succeeded,
    abort: succeeded,
    recover: succeeded,
    commit: (request: { readonly message: string }) => {
      commits.push(request.message);
      return Promise.resolve({
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        outcome: "succeeded",
        durationMs: 0,
      });
    },
  } as unknown as GitLocalMutationAdapter;
}

async function commitDecision(
  workspace: WorkspaceInfo,
  commits: string[],
): Promise<GitMutationOutcome> {
  const outcome = await executeGovernedMutation(
    { kind: "commit", message: "feat: change the value", allowEmpty: false },
    { required: false },
    workspace,
    mutationDeps(),
    {
      adapterFactory: () => committingAdapter(commits),
      approvalStore: createInMemoryGitDeliveryApprovalStore(),
      activityLog: { write: (event): void => void events.push(event) },
    },
    "journey-commit",
  );
  return outcome.outcome;
}

function workspaceInfo(workspaceRoot: string): WorkspaceInfo {
  return {
    root: workspaceRoot,
    selectedRoot: workspaceRoot,
    name: "journey",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function mutationDeps(): VerifiedCommitRuntimeDependencies["mutationDeps"] {
  return {
    redactor: (value): unknown => value,
    evidenceStore: {
      put: (id): string => id,
      get: (): undefined => undefined,
      list: (): readonly string[] => [],
      delete: (): void => undefined,
    },
  };
}

describe("a model on a Local checkout of main gets a task branch of its own (#3907)", () => {
  it("is blocked on main, creates feature/x through Keiko, and then stands on it with main as its base", async () => {
    // The Local checkout, as the Workbench selects it, and the run's envelope on `main`.
    const uiStore = createInMemoryUiStore();
    uiStore.createProject(root, "journey");
    const instances = buildWorkspaceInstanceStoreOverDatabase(db);
    const pointer = buildActiveWorkspacePointerStoreOverDatabase(db);
    const lifecycle = withLocalCheckout(
      {
        list: (): readonly [] => [],
        listAll: (): readonly [] => [],
        getActive: (): undefined => undefined,
        clearActive: (): void => {
          pointer.clear();
        },
      } as unknown as WorkspaceLifecycleService,
      pointer,
      uiStore,
      instances,
      {
        evidenceStore: {
          put: (id): string => id,
          list: (): readonly string[] => [],
          get: (): undefined => undefined,
          delete: (): void => undefined,
        },
        redactString: (value): string => value,
        now: Date.now,
      },
    );
    const selected = lifecycle.selectLocal({ root, branch: "main", requestedBy: "journey" });
    const records = createGovernedTaskBranches();
    const runtime: ProductionWorkspaceAuthorityInput = {
      workspaceLifecycle: lifecycle,
      managedTaskWorkspaceRoot: root,
      deploymentCeiling: "autonomous-delivery",
      readWorkspaceHead: readProductionWorkspaceHead,
      governedTaskBranch: records.latest,
    };
    const workspaceDigest = createHash("sha256").update(root, "utf8").digest("hex");
    const trusted: CodingRuntimeTrustedContext = {
      ...resolveProductionRuntimeContext(runtime, {
        runId: "run-journey",
        requestId: "request-journey",
        taskIntent: "Change the value and deliver it",
        requestedMode: "autonomous-delivery",
        workspaceId: selected.instance.workspaceId,
        workspaceRoot: root,
        serverPrincipal: "journey",
      }),
      repositoryIdentity: { kind: "local", digest: workspaceDigest },
    };
    expect(trusted.branch).toMatchObject({ baseRef: "main", headRef: "main" });

    const snapshots = createCodingRuntimeSnapshotStore(db);
    snapshots.create({
      schemaVersion: "1",
      runId: "run-journey",
      state: "running",
      revision: 0,
      requestedMode: "autonomous-delivery",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
      taskDigest: workspaceDigest,
      workspaceDigest,
      operatorDigest: workspaceDigest,
      authorityDigest: workspaceDigest,
      bindingDigest: workspaceDigest,
      provenanceDigest: workspaceDigest,
      toolCallCount: 0,
      patchByteCount: 0,
      modelRequestCount: 0,
    });
    const deps: VerifiedCommitRuntimeDependencies = {
      snapshots,
      resolveWorkspace: workspaceInfo,
      buffersClean: () => true,
      mutationDeps: mutationDeps(),
      messageAllowed: () => Promise.resolve(true),
      execution: {
        processEnv: { PATH: process.env.PATH, HOME: base },
        approvalStore: createInMemoryGitDeliveryApprovalStore(),
        activityLog: { write: (event): void => void events.push(event) },
      },
      governedTaskBranch: records.latest,
    };
    const binding: VerifiedCommitRuntimeBinding = {
      runId: "run-journey",
      envelopeDigest: "b".repeat(64),
      context: trusted,
      stillAuthorized: () => productionWorkspaceMatches(runtime, trusted),
      signal: new AbortController().signal,
    };
    const rebinds: string[] = [];
    let invalidations = 0;
    const gitService = createProductionRuntimeGitService(
      deps,
      binding,
      () => "autonomous-delivery",
      () => {
        invalidations += 1;
      },
      {
        port: createProductionTaskBranchPort({
          workspaceId: selected.instance.workspaceId,
          lifecycle,
          branches: records,
          authority: {
            rebindGitDeliveryBranch: (runId, rebound) => {
              rebinds.push(`${runId}:${rebound.headRef}:${rebound.baseRef}`);
              return (): void => undefined;
            },
          },
        }),
        invalidateDelivery: () => undefined,
      },
    );
    if (gitService === undefined) throw new Error("expected the runtime Git service");

    // An edit, staged: the run's work, on `main`.
    writeFileSync(join(root, "code.js"), "export const value = 2;\n");
    git("add", "code.js");
    const workspace = workspaceInfo(root);
    expect(resolveVerifiedCommitContext(deps, binding)).toMatchObject({
      headRef: "main",
      baseRef: "main",
    });

    // 1. The commit is blocked: `main` is protected, and Keiko never commits there.
    const commits: string[] = [];
    await expect(commitDecision(workspace, commits)).resolves.toMatchObject({
      status: "blocked",
      category: "policy-block",
      blockReason: "protected-branch",
    });
    expect(commits).toEqual([]);

    // 2. The model asks Keiko for a task branch.
    await expect(
      gitService.execute(
        {
          action: "git",
          actionId: "branch-1",
          idempotencyKey: "branch-1",
          operation: "branch",
          branchName: "feature/x",
        },
        { check: (): boolean => true },
      ),
    ).resolves.toEqual({
      kind: "branch",
      status: "succeeded",
      reason: "none",
      branch: "feature/x",
    });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x");
    expect(git("status", "--porcelain")).toBe("M  code.js");
    expect(rebinds).toEqual(["run-journey:feature/x:main"]);
    expect(invalidations).toBe(1);

    // 3. The run, its workspace record and its delivery context all stand on feature/x now, with
    //    main as the base; the envelope itself is unchanged.
    expect(trusted.branch).toMatchObject({ baseRef: "main", headRef: "main" });
    expect(productionWorkspaceMatches(runtime, trusted)).toBe(true);
    expect(lifecycle.getActive()?.instance).toMatchObject({
      taskBranch: "feature/x",
      baseBranch: "main",
    });
    expect(resolveVerifiedCommitContext(deps, binding)).toMatchObject({
      headRef: "feature/x",
      baseRef: "main",
    });

    // 4. The commit is no longer blocked: the kernel judges it on feature/x.
    await expect(commitDecision(workspace, commits)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(commits).toEqual(["feat: change the value"]);

    // 5. A checkout somebody else switched away is not the branch Keiko moved the run to.
    git("switch", "-q", "main");
    expect(productionWorkspaceMatches(runtime, trusted)).toBe(false);
  });
});
