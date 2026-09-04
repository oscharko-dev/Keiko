// Integration coverage for the #447 controlled repair service (Issue #447, Epic #443). Exercises the
// real worktree adapter + provisioning re-materialization against disposable git repositories and
// proves: deterministic repair of recoverable states (AC3) — recreate a missing worktree, re-link a
// moved gitdir, release a stale lock, mark abandoned — the operator-approval gate (the #444 `repair`
// operation requires it), the "require manual intervention where needed" path (no mutation), and the
// negative gates (not applicable, lock contention, unknown workspace, invalid strategy).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  inspectManagedGitdirIdentity,
  type ManagedGitdirIdentityInspection,
} from "./gitdir-identity.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceRepairService } from "./repair.js";
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import type {
  WorkspaceProvisioningService,
  WorkspaceReconciliationService,
  WorkspaceRepairService,
} from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
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
let provisioning: WorkspaceProvisioningService;

type AdapterFactory = (workspace: WorkspaceInfo, correlationId: string) => GitWorktreeAdapter;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
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

function capturingAdapterFactory(received: string[]): AdapterFactory {
  return (workspace, correlationId): GitWorktreeAdapter => {
    received.push(correlationId);
    return realAdapter(workspace);
  };
}

function rejectingAdapterFactory(received: string[]): AdapterFactory {
  return (_workspace, correlationId): GitWorktreeAdapter => {
    received.push(correlationId);
    throw new Error("captured adapter correlation");
  };
}

function expectOnlyAdapterCorrelation(received: readonly string[], expected: string): void {
  expect(received.length).toBeGreaterThan(0);
  expect(new Set(received)).toEqual(new Set([expected]));
}

// The real adapter with ONLY `listWorktrees` rejecting, the way an unmounted repository root or a
// denied path does — the second bare call on the repair path, after the adapter build.
function listFailingAdapterFactory(): AdapterFactory {
  return (workspace: WorkspaceInfo): GitWorktreeAdapter => ({
    ...realAdapter(workspace),
    listWorktrees: (): Promise<readonly WorktreeListEntry[]> =>
      Promise.reject(new Error("spawn git ENOENT")),
  });
}

// The live #447 classifier the repair path re-enters, built over the same fixtures, so a test can
// assert what reconciliation ACTUALLY classifies a row as instead of seeding the verdict itself.
function reconciliation(): WorkspaceReconciliationService {
  return createWorkspaceReconciliationService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
}

// Single narrowing point for a captured rejection, so the assertions on it stay linear.
async function rejectionOf(thunk: () => Promise<unknown>): Promise<TaskWorkspaceError> {
  let caught: unknown;
  try {
    await thunk();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof TaskWorkspaceError)) {
    throw new Error("expected a classified TaskWorkspaceError rejection");
  }
  return caught;
}

function causeMessageOf(error: Error): string | undefined {
  const cause: unknown = error.cause;
  return cause instanceof Error ? cause.message : undefined;
}

function repairService(
  activityLog?: ServerLogSink,
  adapterFactory: AdapterFactory = realAdapter,
): WorkspaceRepairService {
  return createWorkspaceRepairService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    provisioning,
    managedRoot,
    createAdapter: adapterFactory,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
    ...(activityLog === undefined ? {} : { activityLog }),
  });
}

async function provisionTask(taskId: string): Promise<WorkspaceInstance> {
  const result = await provisioning.provision({
    repositoryRequestPath: repoRoot,
    taskId,
    baseBranch: "main",
    requestedBy: "u",
  });
  return result.instance;
}

async function rejectsWithCode(
  thunk: () => Promise<unknown>,
  code: TaskWorkspaceErrorCode,
): Promise<void> {
  let caught: unknown;
  try {
    await thunk();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TaskWorkspaceError);
  expect((caught as TaskWorkspaceError).code).toBe(code);
}

function repair(
  workspaceId: string,
  strategy: WorkspaceRecoveryStrategy,
  operatorApproved: boolean,
  requestedBy = "u",
  correlationId?: string,
  activityLog?: ServerLogSink,
): Promise<ReturnType<WorkspaceRepairService["repair"]> extends Promise<infer R> ? R : never> {
  return repairService(activityLog).repair({
    workspaceId,
    requestedBy,
    strategy,
    operatorApproved,
    correlationId,
  });
}

// Single narrowing point for a captured activity-log line, so a chain of `expect(line?.field)`
// assertions (each `?.` its own branch to ESLint's `complexity` rule) does not push an otherwise
// linear assertion test over the repo's complexity ceiling (AGENTS.md §6).
function lastActivityLogEvent(sink: BufferedServerLogSink): ServerLogEvent {
  const line = sink.events.at(-1);
  if (line === undefined) throw new Error("no activity-log event recorded");
  return line;
}

// The same single-narrowing-point rule for a searched log line.
function activityLogEventWithKind(sink: BufferedServerLogSink, errorKind: string): ServerLogEvent {
  const line = sink.events.find((event) => event.errorKind === errorKind);
  if (line === undefined) throw new Error(`no activity-log event with errorKind ${errorKind}`);
  return line;
}

function lastEventCorrelationId(): string {
  const last = evidence.at(-1);
  if (last === undefined) throw new Error("no evidence recorded");
  const parsed = JSON.parse(last.json) as { readonly event: { readonly correlationId: string } };
  return parsed.event.correlationId;
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-repair-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-repair-mr-"))),
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
  provisioning = createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("recreate-worktree (AC3: retry provisioning)", () => {
  it("rebuilds a missing managed worktree from the existing branch", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const result = await repair(instance.workspaceId, "recreate-worktree", true);
    expect(result.applied).toBe(true);
    expect(result.outcome).toBe("repaired");
    expect(result.status).toBe("healthy");
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
    expect(evidence.some((e) => e.json.includes('"operation": "repair"'))).toBe(true);
  });
});

describe("reconcile-pointer (relink known managed worktree)", () => {
  // The migration's only exit. The ordinary provision path refuses to reissue an identity for an
  // existing worktree, so a workspace registered under the retired rule would be stranded unless an
  // executable, approval-gated strategy reaches the re-materialisation. This is that strategy, and
  // the approval is what stands in for the judgement that the retired proof is genuine.
  // Both retired compositions take this exit: the v2 inode rule (#3367) and the pointer-text rule
  // every workspace provisioned before #3367 carries.
  it.each([
    {
      rule: "v2 inode composition",
      retired: (i: ManagedGitdirIdentityInspection): string => i.legacyIdentity,
    },
    {
      rule: "pre-#3367 pointer-text composition",
      retired: (i: ManagedGitdirIdentityInspection): string => i.legacyPointerIdentity,
    },
  ])(
    "reissues a retired-schema identity ($rule) only under operator approval",
    async ({ retired }) => {
      const instance = await provisionTask("t1");
      const inspection = inspectManagedGitdirIdentity(instance.managedWorktreePath, repoRoot);
      if (inspection === undefined)
        throw new Error("real linked-worktree identity was not resolved");
      const retiredIdentity = retired(inspection);
      // ONLY the retired value is seeded. The marker is NOT: pre-seeding
      // `driftMarkers: ["identity-schema-retired"]` made both variants pass with and without
      // `isRetiredIdentity` recognising the composition under test, because an approved
      // reconcile-pointer also refreshes a plain `gitdir-mismatch` row (PR #3381 review). The live
      // classification below is what distinguishes the two, so dropping either retired composition
      // from the recogniser turns THIS case red.
      store.upsert({ ...instance, gitdirIdentity: retiredIdentity });

      await reconciliation().reconcile(repoRoot, "retired-schema-0001");

      const classified = store.getById(instance.workspaceId);
      expect(classified?.driftMarkers).toEqual(["identity-schema-retired"]);
      expect(classified?.recoveryHints).toEqual([
        {
          marker: "identity-schema-retired",
          strategy: "reconcile-pointer",
          operatorActionRequired: false,
        },
      ]);
      expect(classified?.lifecycleState).toBe("recovery-required");

      await expect(repair(instance.workspaceId, "reconcile-pointer", false)).rejects.toMatchObject({
        code: "OPERATOR_APPROVAL_REQUIRED",
      });
      expect(store.getById(instance.workspaceId)?.gitdirIdentity).toBe(retiredIdentity);

      const result = await repair(instance.workspaceId, "reconcile-pointer", true);
      expect(result.applied).toBe(true);
      expect(result.status).toBe("healthy");
      const persisted = store.getById(instance.workspaceId);
      expect(persisted?.lifecycleState).toBe("active");
      expect(persisted?.gitdirIdentity).toBe(inspection.identity);
      expect(persisted?.driftMarkers).not.toContain("identity-schema-retired");
    },
  );

  it("refreshes a mismatched gitdir identity back to healthy", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, gitdirIdentity: "0000000000000000deadbeefdeadbeef" });
    const result = await repair(instance.workspaceId, "reconcile-pointer", true);
    expect(result.applied).toBe(true);
    expect(result.status).toBe("healthy");
    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.gitdirIdentity).not.toBe("0000000000000000deadbeefdeadbeef");
    expect(persisted?.health).toBe("healthy");
  });
});

// A cleanup-pending row whose worktree no longer proves its identity used to be stranded: every
// complete-cleanup was refused `ownership-unproven`, reconciliation reported the row "healthy" so
// no repair applied, and the terminal branch refused re-provisioning (audit finding, 2026-09-03).
// The live re-reconcile now classifies it stale and flags it, which makes the operator-approved
// re-registration reachable — the same exit every other unproven worktree has.
describe("cleanup-pending rows whose worktree no longer proves its identity", () => {
  it("re-registers the tree under operator approval and returns it to active", async () => {
    const instance = await provisionTask("t-pending");
    store.upsert({
      ...instance,
      lifecycleState: "cleanup-pending",
      gitdirIdentity: "0000000000000000deadbeefdeadbeef",
    });

    const result = await repair(instance.workspaceId, "reconcile-pointer", true);

    expect(result.applied).toBe(true);
    expect(result.status).toBe("healthy");
    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.lifecycleState).toBe("active");
    expect(persisted?.gitdirIdentity).toBe(instance.gitdirIdentity);
    expect(persisted?.driftMarkers).toEqual([]);
  });

  it("still refuses without operator approval and leaves the row flagged, not settled", async () => {
    const instance = await provisionTask("t-pending-refused");
    store.upsert({
      ...instance,
      lifecycleState: "cleanup-pending",
      gitdirIdentity: "0000000000000000deadbeefdeadbeef",
    });

    await rejectsWithCode(
      () => repair(instance.workspaceId, "reconcile-pointer", false),
      "OPERATOR_APPROVAL_REQUIRED",
    );

    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.lifecycleState).toBe("recovery-required");
    expect(persisted?.driftMarkers).toEqual(["gitdir-mismatch"]);
    expect(persisted?.gitdirIdentity).toBe("0000000000000000deadbeefdeadbeef");
  });
});

// #3382: `head-moved` used to map to `operator-repair`, a strategy `executeStrategy` runs for no
// marker, so a workspace whose HEAD moved outside Keiko carried a marker nothing could clear —
// `productionRuntimeWorkspaceAuthority` refuses any row with a drift marker, so the workspace was
// bricked for every further run. `accept-moved-head` is that missing executable exit: it adopts the
// worktree's CURRENT commit as its verified head, mutating neither Git nor the filesystem, and it
// runs only behind the same `operatorApproved` gate every other strategy does.
describe("accept-moved-head (adopt an out-of-band commit as the verified head)", () => {
  // A commit made in the worktree without Keiko — the operator's own terminal.
  function commitOutOfBand(worktreePath: string, name: string): string {
    writeFileSync(join(worktreePath, name), `${name}\n`);
    execFileSync("git", ["add", name], { cwd: worktreePath });
    execFileSync("git", ["commit", "-q", "-m", `add ${name}`], { cwd: worktreePath });
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();
  }

  async function driftedByMovedHead(taskId: string): Promise<{
    readonly instance: WorkspaceInstance;
    readonly head: string;
  }> {
    const instance = await provisionTask(taskId);
    await reconciliation().reconcile();
    const head = commitOutOfBand(instance.managedWorktreePath, `${taskId}.txt`);
    return { instance, head };
  }

  it("refuses without operator approval and leaves the baseline untouched", async () => {
    const { instance } = await driftedByMovedHead("t-moved-unapproved");
    const before = store.getById(instance.workspaceId)?.lastVerifiedHead;

    await rejectsWithCode(
      () => repair(instance.workspaceId, "accept-moved-head", false),
      "OPERATOR_APPROVAL_REQUIRED",
    );

    expect(store.getById(instance.workspaceId)?.lastVerifiedHead).toBe(before);
    expect(store.getById(instance.workspaceId)?.driftMarkers).toEqual(["head-moved"]);
  });

  it("restamps the head, drops the marker and derives health with approval", async () => {
    const { instance, head } = await driftedByMovedHead("t-moved-approved");

    const result = await repair(instance.workspaceId, "accept-moved-head", true);

    expect(result.applied).toBe(true);
    expect(result.outcome).toBe("repaired");
    expect(result.driftMarkers).toEqual([]);
    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.lastVerifiedHead).toBe(head);
    expect(persisted?.health).toBe("healthy");
    expect(persisted?.recoveryHints).toEqual([]);
    // The next live pass agrees: the row is settled, not merely rewritten.
    const report = await reconciliation().reconcile();
    const entry = report.entries.find((item) => item.workspaceId === instance.workspaceId);
    expect(entry?.status).toBe("healthy");
  });

  it("refuses a worktree that still holds uncommitted work", async () => {
    const { instance } = await driftedByMovedHead("t-moved-dirty");
    writeFileSync(join(instance.managedWorktreePath, "wip.txt"), "uncommitted\n");

    await rejectsWithCode(
      () => repair(instance.workspaceId, "accept-moved-head", true),
      "REPAIR_NOT_APPLICABLE",
    );

    expect(store.getById(instance.workspaceId)?.driftMarkers).toEqual(["head-moved"]);
  });

  // The repository is reachable but no longer lists a worktree at this path, so there is no head to
  // adopt. Nothing is written: the baseline the next pass classifies against stays as it was.
  it("refuses when the repository reports no readable HEAD for the worktree", async () => {
    const { instance } = await driftedByMovedHead("t-moved-headless");
    const before = store.getById(instance.workspaceId)?.lastVerifiedHead;
    const service = repairService(undefined, (workspace: WorkspaceInfo): GitWorktreeAdapter => ({
      ...realAdapter(workspace),
      listWorktrees: (): Promise<readonly WorktreeListEntry[]> => Promise.resolve([]),
    }));

    await rejectsWithCode(
      () =>
        service.repair({
          workspaceId: instance.workspaceId,
          requestedBy: "u",
          strategy: "accept-moved-head",
          operatorApproved: true,
        }),
      "REPAIR_NOT_APPLICABLE",
    );
    expect(store.getById(instance.workspaceId)?.lastVerifiedHead).toBe(before);
  });

  // The window this strategy re-gathers its facts for: the row was classified `head-moved` before
  // the repair lock was taken, and the task branch is deleted between that classification and the
  // accepting write. The second gather sees `branch-deleted` and refuses, so the moved head is never
  // settled onto a row whose only live finding is something else.
  it("refuses when the live facts change between the classification and the write", async () => {
    const { instance } = await driftedByMovedHead("t-moved-raced");
    let branchLookups = 0;
    const service = repairService(undefined, (workspace: WorkspaceInfo): GitWorktreeAdapter => {
      const adapter = realAdapter(workspace);
      return {
        ...adapter,
        localBranchExists: (branch: string): Promise<boolean> => {
          branchLookups += 1;
          return branchLookups === 1 ? adapter.localBranchExists(branch) : Promise.resolve(false);
        },
      };
    });

    await rejectsWithCode(
      () =>
        service.repair({
          workspaceId: instance.workspaceId,
          requestedBy: "u",
          strategy: "accept-moved-head",
          operatorApproved: true,
        }),
      "REPAIR_NOT_APPLICABLE",
    );
    expect(branchLookups).toBeGreaterThan(1);
    expect(store.getById(instance.workspaceId)?.driftMarkers).toEqual(["head-moved"]);
  });

  // CodeRabbit, PR #3381: `reconcileSingleInstance` has already returned by the time the acceptance
  // gathers its own facts, so the three spawns it makes (the adapter build, `listWorktrees`,
  // `worktreeStatus`) were outside every classification. A plain rejection there reached
  // `runWithWorkspaceLifecycleFailureLogging`, which only logs a TaskWorkspaceError, and the route's
  // `mapped === undefined` branch turned it into a generic 500 with no lifecycle line at all.
  it("classifies a repository it cannot consult during the acceptance", async () => {
    const { instance } = await driftedByMovedHead("t-moved-unreachable");
    const activityLog = createBufferedServerLogSink();
    let gathers = 0;
    // The FIRST consultation is the repair's own `reconcileSingleInstance` (it must still classify
    // the row as `head-moved`, or the applicability gate would refuse first and this would pin
    // nothing); the acceptance's own listing is the one that fails.
    const service = repairService(activityLog, (workspace: WorkspaceInfo): GitWorktreeAdapter => {
      const adapter = realAdapter(workspace);
      return {
        ...adapter,
        listWorktrees: (): Promise<readonly WorktreeListEntry[]> => {
          gathers += 1;
          return gathers === 1
            ? adapter.listWorktrees()
            : Promise.reject(new Error("spawn git ENOENT"));
        },
      };
    });

    const error = await rejectionOf(() =>
      service.repair({
        workspaceId: instance.workspaceId,
        requestedBy: "u",
        strategy: "accept-moved-head",
        operatorApproved: true,
      }),
    );

    expect(error.code).toBe("REPOSITORY_UNREACHABLE");
    expect(error.outcome).toBe("retry-required");
    expect(causeMessageOf(error)).toBe("spawn git ENOENT");
    expect(gathers).toBeGreaterThan(1);
    const line = activityLogEventWithKind(activityLog, "REPOSITORY_UNREACHABLE");
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.extra?.operation).toBe("repair");
    expect(Array.isArray(line.extra?.frames)).toBe(true);
    // The baseline is untouched: a repair that could not consult the repository mutates nothing.
    expect(store.getById(instance.workspaceId)?.driftMarkers).toEqual(["head-moved"]);
  });

  it("refuses a row whose live findings are not only the moved head", async () => {
    const { instance } = await driftedByMovedHead("t-moved-foreign");
    // The task branch is gone as well, so the live classification is `branch-deleted`, not
    // `head-moved`: that row keeps its own operator-guided hint and this repair must not settle it.
    store.upsert({
      ...(store.getById(instance.workspaceId) ?? instance),
      taskBranch: "keiko/task/ghost-00000000",
    });

    await rejectsWithCode(
      () => repair(instance.workspaceId, "accept-moved-head", true),
      "REPAIR_NOT_APPLICABLE",
    );
  });
});

describe("release-stale-lock (clear stale lock)", () => {
  it("clears an expired lock and returns to healthy", async () => {
    const instance = await provisionTask("t1");
    store.upsert({
      ...instance,
      lock: {
        lockId: "stale",
        owner: "u",
        reason: "mutation",
        acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
        expiresAt: new Date(nowMs - 1_800_000).toISOString(),
      },
    });
    const result = await repair(instance.workspaceId, "release-stale-lock", true);
    expect(result.applied).toBe(true);
    expect(result.status).toBe("healthy");
    expect(store.getById(instance.workspaceId)?.lock).toBeNull();
    expect(store.getById(instance.workspaceId)?.driftMarkers).not.toContain("lock-stale");
  });

  // F1: the evidence's correlationId must be the triggering request's own id, not the workspace's own
  // persisted auditCorrelationId reused for every operation across the workspace's whole life — reuse
  // would make every distinct HTTP repair request's evidence collapse onto ONE correlationId, breaking
  // the join back to the specific request that produced each line (AGENTS.md §8).
  it("threads the request's own correlationId into repair evidence, not the auditCorrelationId", async () => {
    const instance = await provisionTask("t-corr");
    store.upsert({
      ...instance,
      lock: {
        lockId: "stale",
        owner: "u",
        reason: "mutation",
        acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
        expiresAt: new Date(nowMs - 1_800_000).toISOString(),
      },
    });
    await repair(instance.workspaceId, "release-stale-lock", true, "u", "req-corr-repair-1");
    expect(lastEventCorrelationId()).toBe("req-corr-repair-1");
    expect(lastEventCorrelationId()).not.toBe(instance.auditCorrelationId);
  });

  it("falls back to UNKNOWN_CORRELATION_ID (never the auditCorrelationId) when no request scope exists", async () => {
    const received: string[] = [];
    const instance = await provisionTask("t-nocorr");
    store.upsert({
      ...instance,
      lock: {
        lockId: "stale",
        owner: "u",
        reason: "mutation",
        acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
        expiresAt: new Date(nowMs - 1_800_000).toISOString(),
      },
    });
    await repairService(undefined, capturingAdapterFactory(received)).repair({
      workspaceId: instance.workspaceId,
      strategy: "release-stale-lock",
      operatorApproved: true,
      requestedBy: "u",
    });
    expectOnlyAdapterCorrelation(received, UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).not.toBe(instance.auditCorrelationId);
  });

  describe("adapter correlation-ID boundary", () => {
    it.each([
      ["empty", ""],
      ["malformed", "req corr\ncontrol"],
      ["hostile", `req-corr-${"a".repeat(4000)}`],
      ["below the HTTP boundary", "x"],
    ] as const)(
      "normalizes a supplied %s ID before adapter construction",
      async (_label, input) => {
        const received: string[] = [];
        const instance = await provisionTask(`t-adapter-${_label.replaceAll(" ", "-")}`);
        const rejection = await rejectionOf(() =>
          repairService(undefined, rejectingAdapterFactory(received)).repair({
            workspaceId: instance.workspaceId,
            strategy: "release-stale-lock",
            operatorApproved: true,
            requestedBy: "u",
            correlationId: input,
          }),
        );
        // Strengthened, not relaxed (PR #3381 review): the adapter build inside the repair's live
        // re-reconcile is now CLASSIFIED, so the same throw arrives as the retryable
        // REPOSITORY_UNREACHABLE — and the original still rides as its cause, which is what proves
        // the adapter was actually constructed with the value asserted below.
        expect(rejection.code).toBe("REPOSITORY_UNREACHABLE");
        expect(causeMessageOf(rejection)).toBe("captured adapter correlation");
        expectOnlyAdapterCorrelation(received, UNKNOWN_CORRELATION_ID);
      },
    );

    // reconcileSingleInstance — the path EVERY operator-approved repair re-enters (repair.ts:201,
    // :453) — used to call `createAdapter` and `listWorktrees` bare. An operator clicking
    // "Repair and bind" while the repository root was unavailable therefore got an UNCLASSIFIED
    // rejection: `runWithWorkspaceLifecycleFailureLogging` logs only a TaskWorkspaceError, so
    // server.log carried no `task-workspace.lifecycle` line for the repair's correlation id and
    // routes.ts's `mapped === undefined` branch turned it into a generic 500 (PR #3381 review).
    it("classifies and logs an unreachable repository during a repair, not a bare 500", async () => {
      const instance = await provisionTask("t-repair-unreachable");
      const activityLog = createBufferedServerLogSink();

      const rejection = await rejectionOf(() =>
        repairService(activityLog, listFailingAdapterFactory()).repair({
          workspaceId: instance.workspaceId,
          strategy: "reconcile-pointer",
          operatorApproved: true,
          requestedBy: "u",
          correlationId: "repair-unreachable-0001",
        }),
      );

      expect(rejection.code).toBe("REPOSITORY_UNREACHABLE");
      // Retryable and 503, the same verdict the pass and the health report give the same fact.
      expect(rejection.status).toBe(503);
      expect(rejection.failureClass).toBe("retryable");
      const line = activityLog.events.find((event) => event.errorKind === "REPOSITORY_UNREACHABLE");
      expect(line?.correlationId).toBe("repair-unreachable-0001");
      expect(line?.extra).toMatchObject({ operation: "repair" });
      expect(Array.isArray(line?.extra?.causeChain)).toBe(true);
      // Body-free: the unreachable root never reaches the line.
      expect(JSON.stringify(line)).not.toContain(repoRoot);
    });
  });

  // IDX51: the same normalization that protects adapter termination evidence also protects lifecycle
  // evidence. A supplied value outside SAFE_CORRELATION_ID joins the explicit omitted-id fallback.
  describe("correlation-ID normalization", () => {
    function lockedInstance(taskId: string): Promise<WorkspaceInstance> {
      return provisionTask(taskId).then((instance) => {
        store.upsert({
          ...instance,
          lock: {
            lockId: "stale",
            owner: "u",
            reason: "mutation",
            acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
            expiresAt: new Date(nowMs - 1_800_000).toISOString(),
          },
        });
        return instance;
      });
    }

    it.each([
      ["empty", ""],
      ["malformed", "req\u0000corr\ncontrol"],
      ["hostile", `req-corr-${"a".repeat(4000)}`],
      ["below the HTTP boundary", "x"],
    ] as const)("normalizes a supplied %s ID in lifecycle evidence", async (_label, input) => {
      const instance = await lockedInstance(`t-corr-${_label.replaceAll(" ", "-")}`);
      await repair(instance.workspaceId, "release-stale-lock", true, "u", input);
      expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    });
  });

  // IDX61: the EvidenceStore ledger above is a SEPARATE audit surface from `<stateDir>/logs/
  // server.log` — this proves the SAME repair outcome also reaches the server activity log
  // (AGENTS.md §8), carrying the SAME correlationId the evidence assertions above just proved.
  it("emits a task-workspace.lifecycle activity-log line alongside the evidence, same correlationId", async () => {
    const activityLog = createBufferedServerLogSink();
    const received: string[] = [];
    const instance = await provisionTask("t-activity-log");
    store.upsert({
      ...instance,
      lock: {
        lockId: "stale",
        owner: "u",
        reason: "mutation",
        acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
        expiresAt: new Date(nowMs - 1_800_000).toISOString(),
      },
    });
    await repairService(activityLog, capturingAdapterFactory(received)).repair({
      workspaceId: instance.workspaceId,
      strategy: "release-stale-lock",
      operatorApproved: true,
      requestedBy: "u",
      correlationId: "req-corr-repair-activity-1",
    });
    expectOnlyAdapterCorrelation(received, "req-corr-repair-activity-1");
    const line = lastActivityLogEvent(activityLog);
    expect(line.category).toBe("diagnostic");
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-corr-repair-activity-1");
    expect(line.level).toBe("info");
    expect(line.errorKind).toBeUndefined();
    const extra = line.extra ?? {};
    expect(extra.operation).toBe("repair");
    expect(extra.outcome).toBe("repaired");
    expect(extra.workspaceId).toBe(instance.workspaceId);
  });

  it("logs a closed, correlated rejection when repair approval is missing", async () => {
    const activityLog = createBufferedServerLogSink();
    const instance = await provisionTask("t-activity-log-rejection");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    await rejectsWithCode(
      () =>
        repairService(activityLog).repair({
          workspaceId: instance.workspaceId,
          strategy: "recreate-worktree",
          operatorApproved: false,
          requestedBy: "u",
          correlationId: "req-corr-repair-rejection-1",
        }),
      "OPERATOR_APPROVAL_REQUIRED",
    );
    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-corr-repair-rejection-1");
    expect(line.errorKind).toBe("OPERATOR_APPROVAL_REQUIRED");
    expect(line.extra?.operation).toBe("repair");
    expect(line.extra?.workspaceIdentity).toMatch(/^wsref_[0-9a-f]{24}$/u);
  });
});

describe("abandon-and-cleanup (mark abandoned)", () => {
  it("transitions a recovery-required workspace to abandoned and clears the active pointer", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-01-01T00:00:00Z",
    });
    const result = await repair(instance.workspaceId, "abandon-and-cleanup", true);
    expect(result.applied).toBe(true);
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("abandoned");
    expect(pointerStore.get()).toBeUndefined();
  });
});

describe("abandon-and-cleanup legality", () => {
  it("refuses abandon from an active workspace with a clean REPAIR_NOT_APPLICABLE (not ILLEGAL_TRANSITION)", async () => {
    const instance = await provisionTask("t1");
    // a stale lock makes the workspace drifted but it stays `active` (a usable worktree) — active
    // cannot legally transition straight to abandoned.
    store.upsert({
      ...instance,
      lock: {
        lockId: "stale",
        owner: "u",
        reason: "mutation",
        acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
        expiresAt: new Date(nowMs - 1_800_000).toISOString(),
      },
    });
    await rejectsWithCode(
      () => repair(instance.workspaceId, "abandon-and-cleanup", true),
      "REPAIR_NOT_APPLICABLE",
    );
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
  });
});

describe("operator-approval gate (#444 repair operation)", () => {
  it("refuses an automatic repair without operator approval", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    await rejectsWithCode(
      () => repair(instance.workspaceId, "recreate-worktree", false),
      "OPERATOR_APPROVAL_REQUIRED",
    );
    // no mutation happened: still recovery-required, worktree still absent
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("recovery-required");
    expect(existsSync(instance.managedWorktreePath)).toBe(false);
  });
});

describe("require manual intervention where needed", () => {
  it("returns operator-required (no mutation) for an operator-guided strategy", async () => {
    const instance = await provisionTask("t1");
    // branch mismatch -> drifted (branch-deleted) -> reattach-branch is operator-guided
    store.upsert({ ...instance, taskBranch: "keiko/task/ghost-00000000" });
    const result = await repair(instance.workspaceId, "reattach-branch", true);
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe("operator-required");
    expect(result.operatorActionRequired).toBe(true);
  });

  it("returns operator-required for a corrupt git pointer (no safe auto-repair)", async () => {
    const instance = await provisionTask("t1");
    writeFileSync(join(instance.managedWorktreePath, ".git"), "garbage\n");
    const result = await repair(instance.workspaceId, "operator-repair", true);
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe("operator-required");
  });
});

describe("negative gates", () => {
  it("rejects a strategy not applicable to a healthy workspace", async () => {
    const instance = await provisionTask("t1");
    await rejectsWithCode(
      () => repair(instance.workspaceId, "recreate-worktree", true),
      "REPAIR_NOT_APPLICABLE",
    );
  });

  it("rejects when another actor holds a live lock", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    store.upsert({
      ...instance,
      lock: {
        lockId: "live",
        owner: "someone-else",
        reason: "repair",
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 600_000).toISOString(),
      },
    });
    await rejectsWithCode(
      () => repair(instance.workspaceId, "recreate-worktree", true, "u"),
      "LOCK_CONTENTION",
    );
  });

  it("rejects an unknown workspace", async () => {
    await rejectsWithCode(
      () => repair("ws_unknown", "recreate-worktree", true),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("rejects an invalid recovery strategy", async () => {
    const instance = await provisionTask("t1");
    await rejectsWithCode(
      () =>
        repairService().repair({
          workspaceId: instance.workspaceId,
          requestedBy: "u",
          strategy: "not-a-strategy" as WorkspaceRecoveryStrategy,
          operatorApproved: true,
        }),
      "INVALID_REQUEST",
    );
  });
});
