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
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  WorkspaceInfo,
  WorkspaceInstance,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceRepairService } from "./repair.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import type { WorkspaceProvisioningService, WorkspaceRepairService } from "./types.js";
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

function repairService(activityLog?: ServerLogSink): WorkspaceRepairService {
  return createWorkspaceRepairService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    provisioning,
    managedRoot,
    createAdapter: realAdapter,
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
    await repair(instance.workspaceId, "release-stale-lock", true);
    expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).not.toBe(instance.auditCorrelationId);
  });

  // IDX51: the correlation-ID regression matrix beyond an ordinary id and an omitted property.
  // `buildWorkspaceEvent` (evidence.ts) validates `correlationId` through the #444 contract's
  // `isNonEmptyString` gate — non-empty and typeof string, nothing more — so any NON-EMPTY string
  // (malformed, hostile, or absurdly long) is accepted and persisted as-is; only the EMPTY string is
  // rejected (a genuinely distinct case from "no correlation id was supplied", which is `undefined`).
  describe("correlation-ID regression matrix", () => {
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

    // An empty string is NOT `undefined`, so the `correlationId ?? UNKNOWN_CORRELATION_ID` fallback
    // (repair.ts) never triggers for it — it reaches `buildWorkspaceEvent` verbatim, and the #444
    // contract's `isNonEmptyString` gate rejects it, so `buildWorkspaceEvent` throws synchronously.
    // Pinned as PRESERVE-current-behavior: an empty-string correlationId currently fails the WHOLE
    // repair (not merely the audit line) with a content-free-invariant Error, never a silent
    // fallback to UNKNOWN_CORRELATION_ID. A caller must never pass "" — only omit the property.
    it("rejects an empty-string correlationId by failing the repair (does not silently fall back)", async () => {
      const instance = await lockedInstance("t-corr-empty");
      await expect(
        repair(instance.workspaceId, "release-stale-lock", true, "u", ""),
      ).rejects.toThrow(/content-free workspace event invariant violated/u);
    });

    // A malformed-but-non-empty correlationId (fails `isValidCorrelationId`'s narrow
    // `SAFE_CORRELATION_ID` HTTP-header shape — correlation.ts — but is still a non-empty string) is
    // NOT rejected by the #444 contract gate: it is preserved verbatim into the evidence, exactly like
    // a well-formed one. This is CURRENT behavior, not a claim it is ideal — `buildWorkspaceEvent`
    // validates shape-as-"non-empty string", not shape-as-"safe correlation id".
    it("preserves a malformed (control-character) correlationId verbatim in evidence", async () => {
      const instance = await lockedInstance("t-corr-malformed");
      const hostile = "req corr\ncontrol";
      await repair(instance.workspaceId, "release-stale-lock", true, "u", hostile);
      expect(lastEventCorrelationId()).toBe(hostile);
    });

    // "Hostile" here means implausibly long — the #444 contract has no length ceiling of its own, so
    // an oversized value is preserved into the EvidenceStore verbatim (the SEPARATE server-log line
    // this same repair now also emits — IDX61 — DOES cap it, via `redactLogString`'s
    // `MAX_LOG_STRING_LENGTH`; the two surfaces have different redaction rules by design, and this
    // test pins the evidence side only).
    it("preserves an implausibly long correlationId verbatim in evidence (no length ceiling)", async () => {
      const instance = await lockedInstance("t-corr-long");
      const long = `req-corr-${"a".repeat(4000)}`;
      await repair(instance.workspaceId, "release-stale-lock", true, "u", long);
      expect(lastEventCorrelationId()).toBe(long);
      expect(lastEventCorrelationId().length).toBe(long.length);
    });

    // Boundary: `isValidCorrelationId`'s own shape (`SAFE_CORRELATION_ID`, correlation.ts) requires
    // 8-128 characters. A 1-character id is well below that floor but is STILL a non-empty string, so
    // the #444 contract preserves it unchanged — proving the evidence layer's validation is strictly
    // looser than `isValidCorrelationId`, not merely untested.
    it("preserves a below-the-HTTP-boundary 1-character correlationId verbatim in evidence", async () => {
      const instance = await lockedInstance("t-corr-boundary");
      await repair(instance.workspaceId, "release-stale-lock", true, "u", "x");
      expect(lastEventCorrelationId()).toBe("x");
    });
  });

  // IDX61: the EvidenceStore ledger above is a SEPARATE audit surface from `<stateDir>/logs/
  // server.log` — this proves the SAME repair outcome also reaches the server activity log
  // (AGENTS.md §8), carrying the SAME correlationId the evidence assertions above just proved.
  it("emits a task-workspace.lifecycle activity-log line alongside the evidence, same correlationId", async () => {
    const activityLog = createBufferedServerLogSink();
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
    await repair(
      instance.workspaceId,
      "release-stale-lock",
      true,
      "u",
      "req-corr-repair-activity-1",
      activityLog,
    );
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
