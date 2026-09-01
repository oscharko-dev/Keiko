// Integration coverage for the #447 startup reconciliation service (Issue #447, Epic #443). Exercises
// the real worktree adapter against disposable git repositories and the real provisioning service to
// materialize genuine managed worktrees, then proves every Acceptance Criterion and the enumerated
// negative paths: restart restoration when safe (AC1), explicit recoverable/degraded states for
// missing/externally-changed workspaces (AC2), partial-provisioning classification (AC3), content-free
// persistence (AC4), and the negative cases the Issue lists — external deletion, stale/moved pointer,
// branch/head drift, partial provisioning, stale lock, ambiguous active binding, unmanaged-path
// collision. The single governed spawn boundary is reused throughout; no generic git runner.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  GitWorktreeAdapter,
  WorktreeListEntry,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInfo, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointer,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import type { WorkspaceProvisioningService, WorkspaceReconciliationService } from "./types.js";
import { createWorkspaceMutexRegistry, workspaceKey } from "./mutex.js";
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

type AdapterFactory = (workspace: WorkspaceInfo, correlationId: string) => GitWorktreeAdapter;

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

// Single narrowing point for a captured activity-log line, so a chain of `expect(line?.field)`
// assertions (each `?.` its own branch to ESLint's `complexity` rule) does not push an otherwise
// linear assertion test over the repo's complexity ceiling (AGENTS.md §6).
function lastActivityLogEvent(sink: BufferedServerLogSink): ServerLogEvent {
  const line = sink.events.at(-1);
  if (line === undefined) throw new Error("no activity-log event recorded");
  return line;
}

function lastEventCorrelationId(): string {
  const last = evidence.at(-1);
  if (last === undefined) throw new Error("no evidence recorded");
  const parsed = JSON.parse(last.json) as { readonly event: { readonly correlationId: string } };
  return parsed.event.correlationId;
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

function provisioning(): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
}

function reconciliation(
  activityLog?: ServerLogSink,
  adapterFactory: AdapterFactory = realAdapter,
): WorkspaceReconciliationService {
  return createWorkspaceReconciliationService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
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
  const result = await provisioning().provision({
    repositoryRequestPath: repoRoot,
    taskId,
    baseBranch: "main",
    requestedBy: "u",
  });
  return result.instance;
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-recon-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-recon-mr-"))),
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

describe("healthy reconciliation (AC4)", () => {
  it("classifies a provisioned workspace as healthy and records its verified HEAD", async () => {
    const instance = await provisionTask("t1");
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("healthy");
    expect(reportEntry?.driftMarkers).toEqual([]);
    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.health).toBe("healthy");
    expect(persisted?.lifecycleState).toBe("active");
    expect(persisted?.lastVerifiedHead).toBeDefined();
    // content-free report: no path/branch leaks into entries
    expect(JSON.stringify(report)).not.toContain(managedRoot);
  });

  // F1: a live reconcile driven by the explicit-refresh route has a real request-scoped correlation id
  // in scope (RouteContext.correlationId) and must thread it into the evidence — reusing the
  // workspace's own persisted auditCorrelationId instead would make every reconcile pass against this
  // workspace collapse onto ONE correlationId, breaking the join back to the specific request that
  // produced each line (AGENTS.md §8).
  it("threads the caller's own correlationId into reconcile evidence, not the auditCorrelationId", async () => {
    const instance = await provisionTask("t-corr");
    await reconciliation().reconcile(undefined, "req-corr-reconcile-1");
    expect(lastEventCorrelationId()).toBe("req-corr-reconcile-1");
    expect(lastEventCorrelationId()).not.toBe(instance.auditCorrelationId);
  });

  // The other half of that join, and the one that was broken (PR #3355 review, P2). The evidence
  // above is emitted by this module; the git process's TERMINATION evidence is emitted by the
  // adapter, which deps.ts composed with a hardcoded UNKNOWN_CORRELATION_ID because the port took
  // only a workspace. So a worktree git process killed during a reconcile logged `command.terminated`
  // under UNKNOWN while every surrounding line of the SAME operation carried the real id.
  //
  // Asserted at the port rather than at the log line, because the port is where the id was lost: a
  // spying factory records what the service actually hands it. Before the fix this receives one
  // argument and `received[0]` is undefined.
  it("hands the caller's correlationId to createAdapter, so termination evidence joins the same timeline", async () => {
    const received: string[] = [];
    const service = reconciliation(undefined, capturingAdapterFactory(received));
    await provisionTask("t-adapter-corr");
    await service.reconcile(undefined, "req-corr-adapter-1");
    expectOnlyAdapterCorrelation(received, "req-corr-adapter-1");
  });

  // The startup reconciliation pass has no HTTP request behind it at all: no correlationId is
  // reachable, so this is the one genuinely correlation-free call site in the module.
  it("falls back to UNKNOWN_CORRELATION_ID (never the auditCorrelationId) when no request scope exists", async () => {
    const received: string[] = [];
    const instance = await provisionTask("t-nocorr");
    await reconciliation(undefined, capturingAdapterFactory(received)).reconcile();
    expectOnlyAdapterCorrelation(received, UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).not.toBe(instance.auditCorrelationId);
  });

  // The adapter's `onTerminated` callback writes directly to the activity log, so an unshaped id
  // must be normalized before adapter construction. This capture-only adapter throws immediately:
  // the assertion therefore observes the exact value at that boundary without pinning any later
  // EvidenceStore behavior as part of the adapter contract.
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
        await provisionTask(`t-adapter-${_label.replaceAll(" ", "-")}`);
        await expect(
          reconciliation(undefined, rejectingAdapterFactory(received)).reconcile(undefined, input),
        ).rejects.toThrow("captured adapter correlation");
        expectOnlyAdapterCorrelation(received, UNKNOWN_CORRELATION_ID);
      },
    );
  });

  // IDX61: the EvidenceStore ledger above is a SEPARATE audit surface from `<stateDir>/logs/
  // server.log` — this proves the SAME reconcile pass also reaches the server activity log
  // (AGENTS.md §8), carrying the SAME correlationId. The evidence `outcome` is always the fixed
  // "reconciled" (this pass always completes); the classification an agent actually needs — was the
  // workspace found healthy or drifted — rides in `errorKind` as the live `WorkspaceReconciliationStatus`
  // instead (see activity-log.ts).
  it("emits a task-workspace.lifecycle activity-log line for a healthy reconcile, no errorKind", async () => {
    const activityLog = createBufferedServerLogSink();
    const instance = await provisionTask("t-activity-healthy");
    await reconciliation(activityLog).reconcile(undefined, "req-corr-reconcile-activity-1");
    const line = lastActivityLogEvent(activityLog);
    expect(line.category).toBe("diagnostic");
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-corr-reconcile-activity-1");
    expect(line.level).toBe("info");
    expect(line.errorKind).toBeUndefined();
    const extra = line.extra ?? {};
    expect(extra.operation).toBe("reconcile");
    expect(extra.outcome).toBe("reconciled");
    expect(extra.workspaceId).toBe(instance.workspaceId);
  });

  it("carries the live WorkspaceReconciliationStatus as errorKind for a drifted reconcile", async () => {
    const activityLog = createBufferedServerLogSink();
    const instance = await provisionTask("t-activity-missing");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    await reconciliation(activityLog).reconcile();
    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.level).toBe("warn");
    expect(line.errorKind).toBe("missing");
    expect(line.extra?.outcome).toBe("reconciled");
  });
});

describe("restart restoration (AC1)", () => {
  it("restores the last active workspace when its pointer target is healthy", async () => {
    const instance = await provisionTask("t1");
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-01-01T00:00:00Z",
    });
    // simulate a restart: a fresh reconciliation service over the same persisted store/pointer
    const report = await reconciliation().reconcile();
    expect(report.activeRestoration).toEqual({
      kind: "restored",
      workspaceId: instance.workspaceId,
    });
  });

  it("never silently chooses among ambiguous active workspaces (stop condition)", async () => {
    const a = await provisionTask("task-a");
    const b = await provisionTask("task-b");
    pointerStore.clear();
    const report = await reconciliation().reconcile();
    expect(report.activeRestoration.kind).toBe("ambiguous");
    expect(report.activeRestoration.ambiguousWorkspaceIds).toEqual(
      [a.workspaceId, b.workspaceId].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  });
});

describe("external change surfaced as explicit recoverable state (AC2)", () => {
  it("flags a deleted worktree as missing + recovery-required, not silently gone", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("missing");
    expect(reportEntry?.repairable).toBe(true);
    const persisted = store.getById(instance.workspaceId);
    expect(persisted).toBeDefined(); // still present, not silently dropped
    expect(persisted?.lifecycleState).toBe("recovery-required");
    expect(persisted?.health).toBe("missing");
    expect(persisted?.driftMarkers).toContain("worktree-missing");
    expect(evidence.some((e) => e.json.includes('"operation": "reconcile"'))).toBe(true);
  });

  it("flags an out-of-root (unmanaged) persisted path as unmanaged-path + recovery-required", async () => {
    const instance = await provisionTask("t1");
    const escaped = realpathSync(mkdtempSync(join(tmpdir(), "keiko-escape-")));
    try {
      store.upsert({ ...instance, managedWorktreePath: escaped });
      const report = await reconciliation().reconcile();
      const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
      expect(reportEntry?.status).toBe("unmanaged-path");
      expect(reportEntry?.operatorActionRequired).toBe(true);
      expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("recovery-required");
    } finally {
      rmSync(escaped, { recursive: true, force: true });
    }
  });
});

describe("pointer drift (negative: corrupted / moved gitdir)", () => {
  it("classifies a corrupted .git pointer as stale-pointer + recovery-required", async () => {
    const instance = await provisionTask("t1");
    writeFileSync(join(instance.managedWorktreePath, ".git"), "garbage not a gitdir pointer\n");
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("stale-pointer");
    expect(reportEntry?.driftMarkers).toContain("pointer-stale");
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("recovery-required");
  });

  it("classifies a mismatched gitdir identity as stale-pointer (gitdir-mismatch)", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, gitdirIdentity: "0000000000000000deadbeefdeadbeef" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("stale-pointer");
    expect(reportEntry?.driftMarkers).toContain("gitdir-mismatch");
  });

  // S8786 pointer-drift regression: the shared production parser replaced both formerly duplicated
  // regex parsers with a literal prefix plus a bounded complete descriptor read.
  // This pads the real `.git` pointer with a huge whitespace run around the actual target and asserts
  // reconciliation still classifies it healthy: the parse still extracts the right target and matches
  // the identity computed at provision time despite the padding. That correctness guarantee is real and
  // stays pinned here, unweakened.
  //
  // A PR #3348 review finding caught that this pin ALSO carried a wall-clock assertion
  // (`elapsedMs < Nms`) presented as an S8786 regression guard, which it never was: this fixture is a
  // SUCCESSFULLY-MATCHING single-line input, dominated by two real `git` subprocess spawns via the real
  // adapter (this suite intentionally never stubs that out — see Finding 2's comment above this describe
  // block), not by the regex. The guarantee is RELOCATED, not relaxed, to
  // reconciliation-gitdir-pointer-parse.bench.ts, which measures parseGitdirPointerTarget directly with
  // no subprocess/IO in the timed path — the one place a quadratic regression WOULD be visible if it
  // existed. That bench's own header is equally honest about what was found: rigorous A/B measurement
  // (three methods, including vitest's own bench harness with call order reversed to rule out an
  // ordering artifact) could NOT make the pre-fix pattern show up as reliably slower for this
  // always-matching input shape, at any size up to 1,600,000 padding characters — the S8786
  // classification is a static, structural finding (guarded by `npm run gates:sonar`, mandatory before
  // every PR), not one with a demonstrated dynamic exploit in this codebase's actual usage. No wall-clock
  // bound at ANY layer — this end-to-end test included — can carry that invariant, so none is asserted
  // here anymore; the padded-input classification above is this test's real, remaining, unweakened job.
  it("still classifies healthy when the .git pointer is padded with adversarial whitespace", async () => {
    const instance = await provisionTask("t1");
    const gitPointerPath = join(instance.managedWorktreePath, ".git");
    const rawTarget = readFileSync(gitPointerPath, "utf8")
      .replace(/^gitdir:/u, "")
      .trim();
    writeFileSync(gitPointerPath, `gitdir:${" ".repeat(20_000)}${rawTarget}${" ".repeat(5_000)}\n`);

    const report = await reconciliation().reconcile();

    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("healthy");
    expect(reportEntry?.driftMarkers).toEqual([]);
  });
});

describe("branch / HEAD drift (negative: branch mismatch, moved HEAD)", () => {
  it("classifies a missing task branch as drifted (branch-deleted), keeping a usable worktree active", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, taskBranch: "keiko/task/ghost-00000000" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("drifted");
    expect(reportEntry?.driftMarkers).toContain("branch-deleted");
    // a usable-but-diverged worktree stays in its lifecycle, surfaced via health/markers
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
    expect(store.getById(instance.workspaceId)?.health).toBe("drifted");
  });

  it("classifies a moved HEAD as drifted (head-moved)", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, lastVerifiedHead: "0000000000000000000000000000000000000000" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("drifted");
    expect(reportEntry?.driftMarkers).toContain("head-moved");
  });
});

describe("partial provisioning + stale lock", () => {
  it("classifies a never-completed provisioning instance as partially-created", async () => {
    const instance = await provisionTask("t1");
    // simulate a crash mid-provision: lifecycle stuck at provisioning, worktree gone
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    store.upsert({ ...instance, lifecycleState: "provisioning", health: "unknown" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("partially-created");
    expect(reportEntry?.repairable).toBe(true);
    // partial creation is left for the provisioning retry path, not force-flagged
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("provisioning");
  });

  it("surfaces a stale lock as drifted with a release-stale-lock hint, staying active", async () => {
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
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("drifted");
    expect(reportEntry?.driftMarkers).toContain("lock-stale");
    expect(reportEntry?.recoveryHints.some((h) => h.strategy === "release-stale-lock")).toBe(true);
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
  });

  it("defers to a live foreign lock (locked), without flagging recovery", async () => {
    const instance = await provisionTask("t1");
    store.upsert({
      ...instance,
      lock: {
        lockId: "live",
        owner: "someone-else",
        reason: "mutation",
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 600_000).toISOString(),
      },
    });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("locked");
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
  });
});

describe("stored-derived report (read-only) matches a live reconcile", () => {
  it("report() reconstructs the same status from persisted fields without IO", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    await reconciliation().reconcile();
    const stored = reconciliation().report();
    const reportEntry = stored.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("missing");
  });

  it("scopes the report to a single repository root when given", async () => {
    await provisionTask("t1");
    const stored = reconciliation().report(repoRoot);
    expect(stored.entries).toHaveLength(1);
  });
});

describe("dangling active pointer", () => {
  it("clears the pointer when its instance no longer exists", async () => {
    const instance = await provisionTask("t1");
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-01-01T00:00:00Z",
    });
    store.delete(instance.workspaceId);
    const report = await reconciliation().reconcile();
    expect(["cleared-dangling", "none"]).toContain(report.activeRestoration.kind);
    expect(pointerStore.get()).toBeUndefined();
  });

  it("report() is read-only: it reports a dangling pointer but never calls clear(); reconcile() does", async () => {
    await provisionTask("t1");
    // a pointer that references a workspace id absent from the store (a dangling pointer the FK
    // cascade would normally prevent) lets us prove the read vs. write behavior directly.
    let clearCount = 0;
    const dangling: ActiveWorkspacePointer = {
      workspaceId: "ws_ghost",
      setBy: "u",
      setAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const stubPointer: ActiveWorkspacePointerStore = {
      get: () => dangling,
      set: () => dangling,
      clear: () => {
        clearCount += 1;
      },
    };
    const svc = createWorkspaceReconciliationService({
      store,
      activePointerStore: stubPointer,
      evidenceStore: capturingEvidence(),
      managedRoot,
      createAdapter: realAdapter,
      redactString: (s: string): string => s,
      now: (): number => nowMs,
      newId: (): string => `id-${String(idCounter++)}`,
      mutex: __twMutex,
    });
    const read = svc.report();
    expect(read.activeRestoration.kind).toBe("cleared-dangling");
    expect(clearCount).toBe(0); // read-only GET path never mutates the pointer store
    await svc.reconcile();
    expect(clearCount).toBe(1); // the live reconcile self-heals the dangling pointer
  });
});

// KEIKO-0996 (#3339): reconcileImpl writes a persisted classification via the SAME store.upsert every
// other mutating workspace flow uses, but — unlike WorkspaceCleanupServiceDeps — never took the shared
// #449 ws:<workspaceId> mutex key before doing so. An operator-triggered POST /reconciliation racing the
// startup pass, or racing any other ws:-keyed flow (activate/pause/repair/cleanup), could interleave its
// read-then-write with theirs.
//
// Both tests below are DETERMINISTIC, never duration-based: an earlier version of this suite asserted
// `evidence.length` was unchanged after a fixed `setTimeout(..., 250)`, on the assumption that real
// fact-gathering (git subprocess calls) for one tiny repo completes in single-digit ms. That assumption
// is false under load — the git spawn can take far longer than 250ms — so the assertion passed whether
// or not the mutex wrap was present, proving nothing (a red-then-green check against the unwrapped code
// showed 4/4 false-green runs). Both tests below replace the real git adapter with a `createAdapter` test
// double whose `listWorktrees`/`localBranchExists` resolve through promises THIS TEST controls, so
// "fact-gathering has completed" is an event under the test's control rather than a wall-clock guess, and
// use `runExclusive`'s synchronous registration (mutex.ts: keys are captured and installed in one
// uninterrupted step, no `await`, before `fn` ever runs) to guarantee ordering between the external hold
// and reconcile's own lock acquisition without any timer.
describe("per-instance mutex serialization (KEIKO-0996, #3339)", () => {
  // Builds a createAdapter whose listWorktrees returns a pre-fetched, real snapshot instantly (no repeat
  // git spawn during the race) and whose localBranchExists resolves only once the test releases `gate` —
  // deterministic control over when reconcile's fact-gathering completes.
  function gatingAdapter(
    worktreesSnapshot: readonly WorktreeListEntry[],
    gate: Promise<void>,
  ): (workspace: WorkspaceInfo) => GitWorktreeAdapter {
    return (workspace: WorkspaceInfo): GitWorktreeAdapter => {
      const inner = realAdapter(workspace);
      return {
        ...inner,
        listWorktrees: (): Promise<readonly WorktreeListEntry[]> =>
          Promise.resolve(worktreesSnapshot),
        localBranchExists: async (): Promise<boolean> => {
          await gate;
          return true;
        },
      };
    };
  }

  it("blocks reconcile's write for a workspace while another flow holds its ws: key", async () => {
    const instance = await provisionTask("t1");
    const evidenceCountBeforeReconcile = evidence.length;
    const worktreesSnapshot = await realAdapter(detectWorkspaceAt(repoRoot)).listWorktrees();

    let releaseFacts: () => void = () => undefined;
    const factsGate = new Promise<void>((resolve) => {
      releaseFacts = resolve;
    });

    let releaseHold: () => void = () => undefined;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    // Simulates a concurrent ws:-keyed flow (e.g. repair/pause) already mid-critical-section for this
    // exact workspace when reconcile() starts. Registered synchronously BEFORE reconcile() is even
    // called, so mutex.ts's synchronous registration guarantees this hold is queued ahead of reconcile's
    // own runExclusive call regardless of how the two promise chains later interleave.
    const holdPromise = __twMutex.runExclusive(
      [workspaceKey(instance.workspaceId)],
      () => holdGate,
    );

    const svc = createWorkspaceReconciliationService({
      store,
      activePointerStore: pointerStore,
      evidenceStore: capturingEvidence(),
      managedRoot,
      createAdapter: gatingAdapter(worktreesSnapshot, factsGate),
      redactString: (s: string): string => s,
      now: (): number => nowMs,
      newId: (): string => `id-${String(idCounter++)}`,
      mutex: __twMutex,
    });
    const reconcilePromise = svc.reconcile();

    // Let fact-gathering complete WHILE the external hold is still active. Against the unwrapped
    // production code this is sufficient for reconcile's write to land immediately — reconcileWithContext
    // is fully synchronous once facts are in hand (Finding 2), so there is no further await standing
    // between "facts ready" and "evidence appended". `setImmediate` flushes the entire pending microtask
    // queue (everything gated here resolves via promise microtasks, no real IO), so by the time it fires,
    // the unwrapped write would already have happened if nothing were serializing it.
    releaseFacts();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(evidence).toHaveLength(evidenceCountBeforeReconcile);

    releaseHold();
    await holdPromise;
    const report = await reconcilePromise;

    expect(evidence.length).toBeGreaterThan(evidenceCountBeforeReconcile);
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("healthy");
    expect(store.getById(instance.workspaceId)?.health).toBe("healthy");
  });

  // Finding 2's exact demonstrated hazard: a concurrent ws:-keyed flow (e.g. completeCleanupImpl,
  // cleanup.ts:394) deletes the workspace row from inside its OWN critical section while reconcile is
  // queued behind it. Wrapping only the write over a pre-lock snapshot (the first version of this fix)
  // could not see the deletion and resurrected the row via a stale-instance `upsert`. The fix re-reads
  // `store.getById` AFTER the lock is held, so the deletion is observed and this instance is skipped.
  it("does not resurrect a workspace deleted by another flow while reconcile awaited its ws: hold", async () => {
    const instance = await provisionTask("t1");
    const evidenceCountBeforeReconcile = evidence.length;
    const worktreesSnapshot = await realAdapter(detectWorkspaceAt(repoRoot)).listWorktrees();

    // Registered — and its delete run to completion — synchronously ahead of reconcile() the same way as
    // above: mutex.ts's synchronous registration guarantees causality without any timer.
    const holdPromise = __twMutex.runExclusive([workspaceKey(instance.workspaceId)], () => {
      store.delete(instance.workspaceId);
    });

    const svc = createWorkspaceReconciliationService({
      store,
      activePointerStore: pointerStore,
      evidenceStore: capturingEvidence(),
      managedRoot,
      createAdapter: gatingAdapter(worktreesSnapshot, Promise.resolve()),
      redactString: (s: string): string => s,
      now: (): number => nowMs,
      newId: (): string => `id-${String(idCounter++)}`,
      mutex: __twMutex,
    });
    const report = await svc.reconcile();
    await holdPromise;

    expect(store.getById(instance.workspaceId)).toBeUndefined();
    expect(evidence).toHaveLength(evidenceCountBeforeReconcile);
    expect(report.entries.find((e) => e.workspaceId === instance.workspaceId)).toBeUndefined();
  });
});

// PR #3348 review finding on the KEIKO-0996 change above: widening the lock around fact-gathering
// closed the TOCTOU for the persisted INSTANCE ROW, but `worktrees` was still fetched once per
// repository, BEFORE any instance in the group attempted its `ws:<workspaceId>` lock — so a concurrent
// repair/cleanup that changed the git worktree state while this reconcile was queued behind that exact
// key was invisible: `gatherFacts` still classified the instance against the pre-lock worktree-list
// snapshot. The fix makes reconciliation.ts's `gatherFacts` accept a LAZY `() => adapter.listWorktrees()`
// factory for the live batch path, invoked only once this instance's lock is held (and only when its
// worktree still exists on disk).
//
// This test is DETERMINISTIC, not duration-based, for the same reason the KEIKO-0996 tests above are:
// it uses a `createAdapter` test double whose `listWorktrees()` result flips from a "pre-mutation" to a
// "post-mutation" snapshot on a test-controlled boolean (never a timer), and `runExclusive`'s synchronous
// registration (mutex.ts) to guarantee the external hold is queued ahead of reconcile's own lock attempt.
describe("worktree-list freshness inside the critical section (PR #3348 review finding)", () => {
  // Wraps the real adapter, overriding only `listWorktrees`: it returns `preMutation` until the test
  // calls the returned `applyMutation`, then `postMutation` for every call after. `localBranchExists`
  // and every other verb stay real — only the worktree-list staleness this finding is about is faked.
  function worktreeMutationAdapter(
    preMutation: readonly WorktreeListEntry[],
    postMutation: readonly WorktreeListEntry[],
  ): {
    createAdapter: (workspace: WorkspaceInfo) => GitWorktreeAdapter;
    applyMutation: () => void;
  } {
    let mutated = false;
    return {
      createAdapter: (workspace: WorkspaceInfo): GitWorktreeAdapter => ({
        ...realAdapter(workspace),
        listWorktrees: (): Promise<readonly WorktreeListEntry[]> =>
          Promise.resolve(mutated ? postMutation : preMutation),
      }),
      applyMutation: (): void => {
        mutated = true;
      },
    };
  }

  it("classifies against the worktree list observed AFTER the lock, not a pre-lock snapshot", async () => {
    const instance = await provisionTask("t1");
    const preMutation = await realAdapter(detectWorkspaceAt(repoRoot)).listWorktrees();
    const managedRealPath = realpathSync(instance.managedWorktreePath);
    const mutatedHead = "f".repeat(40);
    const postMutation = preMutation.map((entry) =>
      realpathSync(entry.path) === managedRealPath ? { ...entry, head: mutatedHead } : entry,
    );
    // Sanity: the fixture actually targets this instance's own worktree entry, not a no-op mutation.
    expect(postMutation.some((entry) => entry.head === mutatedHead)).toBe(true);
    const { createAdapter, applyMutation } = worktreeMutationAdapter(preMutation, postMutation);

    let releaseHold: () => void = () => undefined;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    // Simulates a concurrent ws:-keyed flow (e.g. repair's reconcile-pointer strategy) that reconciles
    // this instance to a NEW head — persisting it via the SAME store.upsert every mutating flow uses —
    // while this reconcile() pass is still queued behind the same ws:<workspaceId> key. Registered
    // synchronously ahead of reconcile(), so mutex.ts's synchronous registration guarantees this hold is
    // queued first regardless of how the two promise chains later interleave.
    const holdPromise = __twMutex.runExclusive([workspaceKey(instance.workspaceId)], async () => {
      await holdGate;
      const current = store.getById(instance.workspaceId);
      if (current !== undefined) store.upsert({ ...current, lastVerifiedHead: mutatedHead });
      applyMutation();
    });

    const svc = createWorkspaceReconciliationService({
      store,
      activePointerStore: pointerStore,
      evidenceStore: capturingEvidence(),
      managedRoot,
      createAdapter,
      redactString: (s: string): string => s,
      now: (): number => nowMs,
      newId: (): string => `id-${String(idCounter++)}`,
      mutex: __twMutex,
    });
    // Against the pre-fix code, calling reconcile() synchronously fires the pre-loop `listWorktrees()`
    // right here — BEFORE the mutation below — capturing `preMutation` into a closure variable reused
    // for every instance in the group regardless of when each one's lock is actually granted.
    const reconcilePromise = svc.reconcile();

    releaseHold();
    await holdPromise;
    const report = await reconcilePromise;

    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    // Fixed code: gatherFacts's lazy factory fires only once this instance's lock is granted, i.e. AFTER
    // the concurrent mutation above — it observes `postMutation` (mutatedHead), matching the
    // freshly-re-read `lastVerifiedHead`, so this classifies healthy. Pre-fix code: the pre-loop
    // `listWorktrees()` call already captured `preMutation` (the ORIGINAL head) before the mutation ran,
    // so `observedHead` (original) mismatches the freshly-re-read `lastVerifiedHead` (mutatedHead) —
    // a false "head-moved" drift immediately after the concurrent mutation completed, exactly the false
    // unhealthy outcome the review finding describes.
    expect(reportEntry?.status).toBe("healthy");
    expect(reportEntry?.driftMarkers).toEqual([]);
    expect(store.getById(instance.workspaceId)?.health).toBe("healthy");
  });
});
