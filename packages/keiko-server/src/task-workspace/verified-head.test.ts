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
import type {
  GitWorktreeAdapter,
  WorktreeListEntry,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  WorkspaceInfo,
  WorkspaceInstance,
  WorkspaceLock,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import { recordVerifiedManagedHead } from "./verified-head.js";
import { createWorkspaceMutexRegistry, workspaceKey } from "./mutex.js";
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

  // CodeRabbit, PR #3381: the row was captured BEFORE the head observation (a git spawn) and the
  // whole snapshot was written back afterwards, so anything a concurrent repair, reconcile or cleanup
  // persisted during that await was silently replayed away — a live repair lock resurrected as
  // `null`, newer drift state undone. The restamp now runs under the workspace's own `ws:` key and
  // merges onto the row read immediately BEFORE the write, so it is a single-field update. The lock
  // here is written from inside `listWorktrees`, i.e. strictly between the two reads, which is the
  // window the mutex alone cannot close.
  it("preserves state written while the head observation is in flight", async () => {
    const instance = await provisionTask("t-interleaved");
    await reconciliation().reconcile();
    const head = commitInWorktree(instance.managedWorktreePath, "interleaved.txt");
    const lock: WorkspaceLock = {
      lockId: "lock-concurrent-repair",
      owner: "other-actor",
      reason: "repair",
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    };
    const activityLog = createBufferedServerLogSink();
    let listings = 0;

    await expect(
      recordVerifiedManagedHead(
        verifiedHeadDeps(activityLog, (workspace) => {
          const adapter = realAdapter(workspace);
          return {
            ...adapter,
            listWorktrees: async (): Promise<readonly WorktreeListEntry[]> => {
              const listed = await adapter.listWorktrees();
              listings += 1;
              const current = persisted(instance.workspaceId);
              store.upsert({ ...current, lock, driftMarkers: ["uncommitted-changes"] });
              return listed;
            },
          };
        }),
        {
          managedWorktreePath: instance.managedWorktreePath,
          correlationId: "req-restamp-interleaved",
        },
      ),
    ).resolves.toBe(true);

    expect(listings).toBe(1);
    const after = persisted(instance.workspaceId);
    // The head IS recorded…
    expect(after.lastVerifiedHead).toBe(head);
    // …and nothing the concurrent writer persisted during the await was replayed away.
    expect(after.lock).toEqual(lock);
    expect(after.driftMarkers).toEqual(["uncommitted-changes"]);
  });

  // Serialization proper: while the restamp holds the workspace key, no other `ws:` holder runs.
  it("holds the workspace mutex for the whole restamp", async () => {
    const instance = await provisionTask("t-serialized");
    await reconciliation().reconcile();
    commitInWorktree(instance.managedWorktreePath, "serialized.txt");
    const order: string[] = [];
    const activityLog = createBufferedServerLogSink();

    const restamp = recordVerifiedManagedHead(
      verifiedHeadDeps(activityLog, (workspace) => {
        const adapter = realAdapter(workspace);
        return {
          ...adapter,
          listWorktrees: async (): Promise<readonly WorktreeListEntry[]> => {
            order.push("observe:start");
            const listed = await adapter.listWorktrees();
            order.push("observe:end");
            return listed;
          },
        };
      }),
      { managedWorktreePath: instance.managedWorktreePath },
    );
    const contender = __twMutex.runExclusive([workspaceKey(instance.workspaceId)], () => {
      order.push("contender");
      return Promise.resolve();
    });

    await expect(restamp).resolves.toBe(true);
    await contender;
    expect(order).toEqual(["observe:start", "observe:end", "contender"]);
  });

  // The half of the deadline the seam cannot enforce: `runExclusive` has no cancellation, so an
  // attempt whose caller has already given up still runs. It must run to a NO-OP. Without the check
  // immediately before the write, an attempt that acquired the key late would observe a head and
  // persist it — a baseline appearing after the request it belonged to was answered (CodeRabbit,
  // PR #3381).
  it("writes nothing once its caller has abandoned the restamp", async () => {
    const instance = await provisionTask("t-abandoned");
    await reconciliation().reconcile();
    const before = persisted(instance.workspaceId);
    commitInWorktree(instance.managedWorktreePath, "abandoned.txt");
    const controller = new AbortController();
    const activityLog = createBufferedServerLogSink();
    let listings = 0;

    await expect(
      recordVerifiedManagedHead(
        // The caller gives up WHILE the head is being observed — the widest window there is, and
        // the one the second check exists for. The observation itself still completes.
        verifiedHeadDeps(activityLog, (workspace) => {
          const adapter = realAdapter(workspace);
          return {
            ...adapter,
            listWorktrees: async (): Promise<readonly WorktreeListEntry[]> => {
              const listed = await adapter.listWorktrees();
              listings += 1;
              controller.abort();
              return listed;
            },
          };
        }),
        {
          managedWorktreePath: instance.managedWorktreePath,
          correlationId: "req-restamp-abandoned",
          signal: controller.signal,
        },
      ),
    ).resolves.toBe(false);

    expect(listings).toBe(1);
    const after = persisted(instance.workspaceId);
    expect(after.lastVerifiedHead).toBe(before.lastVerifiedHead);
    expect(after.updatedAt).toBe(before.updatedAt);
    // Refused, never silent.
    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.errorKind).toBe("LOCK_CONTENTION");
    expect(line.correlationId).toBe("req-restamp-abandoned");
  });

  // A signal that is already aborted when the port is entered never reaches the git spawn at all.
  it("does not even observe the head when the signal is already aborted", async () => {
    const instance = await provisionTask("t-abandoned-early");
    await reconciliation().reconcile();
    commitInWorktree(instance.managedWorktreePath, "early.txt");
    const activityLog = createBufferedServerLogSink();
    let listings = 0;

    await expect(
      recordVerifiedManagedHead(
        verifiedHeadDeps(activityLog, (workspace) => {
          const adapter = realAdapter(workspace);
          return {
            ...adapter,
            listWorktrees: (): Promise<readonly WorktreeListEntry[]> => {
              listings += 1;
              return adapter.listWorktrees();
            },
          };
        }),
        {
          managedWorktreePath: instance.managedWorktreePath,
          correlationId: "req-restamp-abandoned-early",
          signal: AbortSignal.abort(),
        },
      ),
    ).resolves.toBe(false);

    expect(listings).toBe(0);
    expect(lastActivityLogEvent(activityLog).errorKind).toBe("LOCK_CONTENTION");
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
