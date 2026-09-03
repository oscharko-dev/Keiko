// Regression coverage for the #3382 verified-head restamp.
//
// The defect: `lastVerifiedHead` had exactly ONE production writer (a healthy reconciliation pass),
// while `classifyWorkspaceReconciliation` answers `drifted` + `head-moved` for any observed head that
// differs from it. Every commit Keiko itself made inside a managed task worktree therefore moved HEAD
// away from the recorded baseline, the next pass persisted `head-moved`, and the runtime workspace
// authority — which refuses any row carrying a drift marker AND requires
// `instance.lastVerifiedHead === <live HEAD>` — could never admit that workspace again.
//
// These run against a REAL disposable git repository and the REAL narrow worktree adapter (the same
// fixture shape reconciliation.test.ts uses), so the head that is restamped is the head git actually
// reports for that worktree — the value the next pass compares against.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInfo, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import { recordVerifiedManagedHead } from "./verified-head.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import type { WorkspaceProvisioningServiceDeps, WorkspaceReconciliationService } from "./types.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
  type ServerLogEvent,
} from "../observability/index.js";

const __twMutex = createWorkspaceMutexRegistry();

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let idCounter: number;
let nowMs: number;

function git(args: readonly string[], cwd = repoRoot): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function capturingEvidence(): EvidenceStore {
  return {
    put: (id: string, json: string): string => {
      evidence.push({ id, json });
      return `/evidence/${id}.json`;
    },
    list: (): readonly string[] => [],
    get: (): string | undefined => undefined,
    delete: (): void => undefined,
  };
}

function realAdapter(workspace: WorkspaceInfo): GitWorktreeAdapter {
  return createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
}

function verifiedHeadDeps(
  activityLog: BufferedServerLogSink,
  createAdapter: (workspace: WorkspaceInfo, correlationId: string) => GitWorktreeAdapter = (
    workspace,
  ) => realAdapter(workspace),
): WorkspaceProvisioningServiceDeps {
  return {
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter,
    redactString: (value: string): string => value,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
    activityLog,
  };
}

function reconciliation(): WorkspaceReconciliationService {
  return createWorkspaceReconciliationService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (value: string): string => value,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
}

async function provisionTask(taskId: string): Promise<WorkspaceInstance> {
  const service = createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (value: string): string => value,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
  const result = await service.provision({
    repositoryRequestPath: repoRoot,
    taskId,
    baseBranch: "main",
    requestedBy: "u",
  });
  return result.instance;
}

// A single narrowing point for a captured line, so a chain of `expect(line?.field)` assertions does
// not push a linear assertion test over the repo's complexity ceiling (AGENTS.md §6).
function lastActivityLogEvent(sink: BufferedServerLogSink): ServerLogEvent {
  const line = sink.events.at(-1);
  if (line === undefined) throw new Error("no activity-log event recorded");
  return line;
}

function persisted(workspaceId: string): WorkspaceInstance {
  const instance = store.getById(workspaceId);
  if (instance === undefined) throw new Error("workspace row missing");
  return instance;
}

// A commit made INSIDE the managed worktree — the exact effect a governed
// `git-delivery/commit/execute` has on that worktree's HEAD.
function commitInWorktree(worktreePath: string, name: string): string {
  writeFileSync(join(worktreePath, name), `${name}\n`);
  git(["add", name], worktreePath);
  git(["commit", "-q", "-m", `add ${name}`], worktreePath);
  return git(["rev-parse", "HEAD"], worktreePath).trim();
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-vhead-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-vhead-mr-"))),
    "task-workspaces",
  );
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "initial"]);
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  store = buildWorkspaceInstanceStoreOverDatabase(db);
  pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  evidence = [];
  idCounter = 0;
  nowMs = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("recordVerifiedManagedHead (#3382)", () => {
  it("restamps the row so the next reconcile is healthy instead of head-moved", async () => {
    const instance = await provisionTask("t-restamp");
    await reconciliation().reconcile();
    const baseline = persisted(instance.workspaceId).lastVerifiedHead;
    expect(baseline).toBeDefined();

    const head = commitInWorktree(instance.managedWorktreePath, "governed.txt");
    expect(head).not.toBe(baseline);

    const activityLog = createBufferedServerLogSink();
    await expect(
      recordVerifiedManagedHead(verifiedHeadDeps(activityLog), {
        managedWorktreePath: instance.managedWorktreePath,
        correlationId: "req-restamp-1",
      }),
    ).resolves.toBe(true);

    // The runtime workspace authority's own requirement: the persisted baseline IS the live head.
    expect(persisted(instance.workspaceId).lastVerifiedHead).toBe(head);

    const report = await reconciliation().reconcile();
    const entry = report.entries.find((item) => item.workspaceId === instance.workspaceId);
    expect(entry?.status).toBe("healthy");
    expect(entry?.driftMarkers).toEqual([]);
    // …and the restamp itself is reconstructable from the activity log alone.
    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-restamp-1");
    expect(line.extra?.operation).toBe("verify-head");
    expect(line.errorKind).toBeUndefined();
  });

  // The defect this restamp closes, stated as the behaviour WITHOUT it: the very same commit, left
  // unrecorded, is classified as drift and the row can no longer be admitted for a run.
  it("leaves a commit it was not told about classified as head-moved", async () => {
    const instance = await provisionTask("t-unrecorded");
    await reconciliation().reconcile();
    commitInWorktree(instance.managedWorktreePath, "out-of-band.txt");

    const report = await reconciliation().reconcile();
    const entry = report.entries.find((item) => item.workspaceId === instance.workspaceId);
    expect(entry?.status).toBe("drifted");
    expect(entry?.driftMarkers).toEqual(["head-moved"]);
    // The executable exit an operator now has (#3382): a strategy the repair service can run.
    expect(entry?.recoveryHints).toEqual([
      { marker: "head-moved", strategy: "accept-moved-head", operatorActionRequired: false },
    ]);
    expect(entry?.repairable).toBe(true);
  });

  it("refuses and logs when no managed row resolves the requested root", async () => {
    const activityLog = createBufferedServerLogSink();
    await expect(
      recordVerifiedManagedHead(verifiedHeadDeps(activityLog), {
        managedWorktreePath: join(managedRoot, "repo_absent", "ws_absent"),
        correlationId: "req-restamp-2",
      }),
    ).resolves.toBe(false);

    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.errorKind).toBe("WORKSPACE_NOT_FOUND");
    expect(line.correlationId).toBe("req-restamp-2");
  });

  it("refuses and logs a classified failure when the repository cannot be consulted", async () => {
    const instance = await provisionTask("t-unreachable");
    await reconciliation().reconcile();
    const baseline = persisted(instance.workspaceId).lastVerifiedHead;
    commitInWorktree(instance.managedWorktreePath, "unreachable.txt");
    const activityLog = createBufferedServerLogSink();

    await expect(
      recordVerifiedManagedHead(
        verifiedHeadDeps(activityLog, () => {
          throw new Error("spawn git ENOENT");
        }),
        { managedWorktreePath: instance.managedWorktreePath, correlationId: "req-restamp-3" },
      ),
    ).resolves.toBe(false);

    const line = lastActivityLogEvent(activityLog);
    expect(line.errorKind).toBe("REPOSITORY_UNREACHABLE");
    expect(line.correlationId).toBe("req-restamp-3");
    // A refused restamp writes nothing: the baseline the next pass classifies against is untouched.
    expect(persisted(instance.workspaceId).lastVerifiedHead).toBe(baseline);
  });
});
