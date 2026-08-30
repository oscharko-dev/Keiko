// Integration coverage for the managed task-workspace provisioning + activation service (Issue #445).
// Exercises the real worktree adapter against disposable git repositories and proves every Acceptance
// Criterion and the enumerated negative paths: success (AC1), reject unsafe/unmanaged/conflict (AC2),
// idempotent safe retry (AC3), durable bindable instance (AC4), and the visible classified failure
// states (SC4). The single governed spawn boundary is reused throughout; no generic git runner.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  GitWorktreeAdapter,
  WorktreeOperationResult,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInfo, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import type { WorkspaceActivateResult, WorkspaceProvisioningService } from "./types.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "./naming.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
} from "../observability/index.js";

const __twMutex = createWorkspaceMutexRegistry();

const FIXED_NOW = 1_700_000_000_000;

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let evidence: { id: string; json: string }[];
let idCounter: number;

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

function makeService(
  adapterFactory?: (workspace: WorkspaceInfo) => GitWorktreeAdapter,
  ensureManagedWorkspaceIdentity?: (instance: WorkspaceInstance, initializeTrust: boolean) => void,
  activityLog?: ServerLogSink,
): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter:
      adapterFactory ??
      ((workspace: WorkspaceInfo): GitWorktreeAdapter =>
        createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } })),
    redactString: (s: string): string => s,
    now: (): number => FIXED_NOW,
    newId: (): string => `id-${String(idCounter++)}`,
    ...(ensureManagedWorkspaceIdentity === undefined ? {} : { ensureManagedWorkspaceIdentity }),
    mutex: __twMutex,
    ...(activityLog === undefined ? {} : { activityLog }),
  });
}

// The last-appended evidence record's WorkspaceEvent.correlationId — the join key an operator's
// `keiko support analyze` uses to tie this lifecycle line back to the HTTP request that produced it
// (AGENTS.md §8). Parses the SAME persisted JSON `evidence.ts` writes, never a re-derived shape.
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

function validInstance(taskId: string, overrides: Partial<WorkspaceInstance>): WorkspaceInstance {
  const repositoryId = deriveRepositoryId(repoRoot);
  const workspaceId = deriveWorkspaceId({ repositoryId, taskId });
  return {
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId,
    repositoryRoot: repoRoot,
    baseBranch: "main",
    taskBranch: deriveTaskBranchName({ taskId }),
    managedWorktreePath: deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId }),
    gitdirIdentity: "seed-identity",
    lifecycleState: "provisioning",
    health: "unknown",
    lock: null,
    createdAt: new Date(FIXED_NOW).toISOString(),
    updatedAt: new Date(FIXED_NOW).toISOString(),
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
    ...overrides,
  };
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-prov-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-prov-mr-"))),
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
  evidence = [];
  idCounter = 0;
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("provision success (AC1, AC4)", () => {
  it("creates a task branch + managed worktree, persists an active bindable instance", async () => {
    const service = makeService();
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    expect(result.created).toBe(true);
    expect(result.instance.lifecycleState).toBe("active");
    expect(result.instance.health).toBe("healthy");
    expect(result.instance.repositoryRoot).toBe(repoRoot);
    expect(result.instance.taskBranch.startsWith("keiko/task/")).toBe(true);
    expect(result.instance.managedWorktreePath.startsWith(managedRoot)).toBe(true);
    expect(existsSync(result.instance.managedWorktreePath)).toBe(true);
    expect(git(["branch", "--list", result.instance.taskBranch])).toContain(
      result.instance.taskBranch,
    );

    // AC4: durable + bindable (gitDeliveryRoot === activeRoot === editorProjectRoot).
    expect(store.getById(result.instance.workspaceId)).toEqual(result.instance);
    expect(result.binding.activeRoot).toBe(result.instance.managedWorktreePath);
    expect(result.binding.gitDeliveryRoot).toBe(result.binding.activeRoot);
    expect(result.binding.editorProjectRoot).toBe(result.binding.activeRoot);
    expect(evidence.length).toBeGreaterThan(0);
  });

  // F1: the evidence's correlationId must be the triggering request's own id, not the workspace's own
  // persisted identity (workspaceId) reused for every operation across the workspace's whole life.
  // Reusing the workspace identity collapses every distinct HTTP request's evidence onto ONE
  // correlationId, so the timeline can no longer be joined back to the specific request that produced
  // it (AGENTS.md §8) — the exact failure this pin proves fixed.
  it("threads the request's own correlationId into provision evidence, not the workspaceId", async () => {
    const service = makeService();
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-corr",
      baseBranch: "main",
      requestedBy: "u",
      correlationId: "req-corr-abc123",
    });
    expect(lastEventCorrelationId()).toBe("req-corr-abc123");
    expect(lastEventCorrelationId()).not.toBe(result.instance.workspaceId);
  });

  it("falls back to UNKNOWN_CORRELATION_ID (never the workspaceId) when no request scope exists", async () => {
    const service = makeService();
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-nocorr",
      baseBranch: "main",
      requestedBy: "u",
    });
    expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).not.toBe(result.instance.workspaceId);
  });

  // IDX51: the correlation-ID regression matrix beyond an ordinary id and an omitted property.
  // `buildWorkspaceEvent` (evidence.ts) validates `correlationId` through the #444 contract's
  // `isNonEmptyString` gate — non-empty and typeof string, nothing more — so any NON-EMPTY string
  // (malformed, hostile, or absurdly long) is accepted and persisted as-is; only the EMPTY string is
  // rejected (a genuinely distinct case from "no correlation id was supplied", which is `undefined`).
  describe("correlation-ID regression matrix", () => {
    // An empty string is NOT `undefined`, so the `correlationId ?? UNKNOWN_CORRELATION_ID` fallback
    // (provisioning.ts) never triggers for it — it reaches `buildWorkspaceEvent` verbatim, and the
    // #444 contract's `isNonEmptyString` gate rejects it, so `buildWorkspaceEvent` throws
    // synchronously. Pinned as PRESERVE-current-behavior: an empty-string correlationId currently
    // fails the WHOLE provision (not merely the audit line) with a content-free-invariant Error,
    // never a silent fallback to UNKNOWN_CORRELATION_ID, even though the git worktree mutation itself
    // may already have succeeded. A caller must never pass "" — only omit the property.
    it("rejects an empty-string correlationId by failing the provision (does not silently fall back)", async () => {
      const service = makeService();
      await expect(
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "t-corr-empty",
          baseBranch: "main",
          requestedBy: "u",
          correlationId: "",
        }),
      ).rejects.toThrow(/content-free workspace event invariant violated/u);
    });

    // A malformed-but-non-empty correlationId (fails `isValidCorrelationId`'s narrow
    // `SAFE_CORRELATION_ID` HTTP-header shape — correlation.ts — but is still a non-empty string) is
    // NOT rejected by the #444 contract gate: it is preserved verbatim into the evidence, exactly like
    // a well-formed one. This is CURRENT behavior, not a claim it is ideal — `buildWorkspaceEvent`
    // validates shape-as-"non-empty string", not shape-as-"safe correlation id".
    it("preserves a malformed (control-character) correlationId verbatim in evidence", async () => {
      const service = makeService();
      const hostile = "req corr\ncontrol";
      await service.provision({
        repositoryRequestPath: repoRoot,
        taskId: "t-corr-malformed",
        baseBranch: "main",
        requestedBy: "u",
        correlationId: hostile,
      });
      expect(lastEventCorrelationId()).toBe(hostile);
    });

    // "Hostile" here means implausibly long — the #444 contract has no length ceiling of its own, so
    // an oversized value is preserved into the EvidenceStore verbatim (the SEPARATE server-log line
    // this same provision now also emits — IDX61 — DOES cap it, via `redactLogString`'s
    // `MAX_LOG_STRING_LENGTH`; the two surfaces have different redaction rules by design, and this
    // test pins the evidence side only).
    it("preserves an implausibly long correlationId verbatim in evidence (no length ceiling)", async () => {
      const service = makeService();
      const long = `req-corr-${"a".repeat(4000)}`;
      await service.provision({
        repositoryRequestPath: repoRoot,
        taskId: "t-corr-long",
        baseBranch: "main",
        requestedBy: "u",
        correlationId: long,
      });
      expect(lastEventCorrelationId()).toBe(long);
      expect(lastEventCorrelationId().length).toBe(long.length);
    });

    // Boundary: `isValidCorrelationId`'s own shape (`SAFE_CORRELATION_ID`, correlation.ts) requires
    // 8-128 characters. A 1-character id is well below that floor but is STILL a non-empty string, so
    // the #444 contract preserves it unchanged — proving the evidence layer's validation is strictly
    // looser than `isValidCorrelationId`, not merely untested.
    it("preserves a below-the-HTTP-boundary 1-character correlationId verbatim in evidence", async () => {
      const service = makeService();
      await service.provision({
        repositoryRequestPath: repoRoot,
        taskId: "t-corr-boundary",
        baseBranch: "main",
        requestedBy: "u",
        correlationId: "x",
      });
      expect(lastEventCorrelationId()).toBe("x");
    });
  });

  // IDX61: the EvidenceStore ledger above is a SEPARATE audit surface from `<stateDir>/logs/
  // server.log` — this proves the SAME provision outcome also reaches the server activity log
  // (AGENTS.md §8), carrying the SAME correlationId the evidence assertions above just proved.
  it("emits a task-workspace.lifecycle activity-log line alongside the evidence, same correlationId", async () => {
    const activityLog = createBufferedServerLogSink();
    const service = makeService(undefined, undefined, activityLog);
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-activity-log",
      baseBranch: "main",
      requestedBy: "u",
      correlationId: "req-corr-activity-1",
    });
    const line = lastActivityLogEvent(activityLog);
    expect(line.category).toBe("diagnostic");
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-corr-activity-1");
    expect(line.level).toBe("info");
    expect(line.errorKind).toBeUndefined();
    const extra = line.extra ?? {};
    expect(extra.operation).toBe("provision");
    expect(extra.outcome).toBe("provisioned");
    expect(extra.workspaceId).toBe(result.instance.workspaceId);
    expect(extra.taskId).toBe("t-activity-log");
  });

  // A failure path carries a structured, closed-vocabulary `errorKind` — the TaskWorkspaceError code
  // — not merely the coarser evidence `outcome`, so an agent grepping the log can tell LOCK_CONTENTION
  // from POINTER_DRIFT from a bare "blocked"/"retry-required".
  it("carries the TaskWorkspaceError code as errorKind on a blocked provision", async () => {
    const activityLog = createBufferedServerLogSink();
    const service = makeService(undefined, undefined, activityLog);
    await expect(
      service.provision({
        repositoryRequestPath: repoRoot,
        taskId: "t-activity-log-blocked",
        baseBranch: "does-not-exist",
        requestedBy: "u",
      }),
    ).rejects.toBeInstanceOf(TaskWorkspaceError);
    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.level).toBe("warn");
    expect(line.errorKind).toBe("INVALID_BASE_BRANCH");
    expect(line.extra?.outcome).toBe("blocked");
  });

  it("establishes the managed workspace identity before every active exposure", async () => {
    const observed: { readonly instance: WorkspaceInstance; readonly initializeTrust: boolean }[] =
      [];
    const service = makeService(undefined, (instance, initializeTrust) => {
      observed.push({ instance, initializeTrust });
    });
    const request = {
      repositoryRequestPath: repoRoot,
      taskId: "identity",
      baseBranch: "main",
      requestedBy: "u",
    } as const;

    const provisioned = await service.provision(request);
    await service.provision(request);
    await service.activate({
      workspaceId: provisioned.instance.workspaceId,
      taskId: request.taskId,
      requestedBy: request.requestedBy,
      acquireLock: false,
    });

    expect(observed.map(({ instance }) => instance.managedWorktreePath)).toEqual([
      provisioned.instance.managedWorktreePath,
      provisioned.instance.managedWorktreePath,
      provisioned.instance.managedWorktreePath,
    ]);
    expect(observed.map(({ instance }) => instance.lifecycleState)).toEqual([
      "provisioning",
      "active",
      "active",
    ]);
    expect(observed.map(({ initializeTrust }) => initializeTrust)).toEqual([true, true, false]);
  });
});

describe("idempotent safe retry (AC3)", () => {
  it("a second provision for the same task resumes without duplicating", async () => {
    const service = makeService();
    const first = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    const second = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    expect(second.created).toBe(false);
    expect(second.instance.workspaceId).toBe(first.instance.workspaceId);
    expect(store.listByRepository(first.instance.repositoryId)).toHaveLength(1);
  });

  // Regression for S8786: gitdirIdentity's `.git` pointer parse used to be
  // `/^gitdir:\s*(.+)\s*$/mu`, whose leading/trailing `\s*` overlapped with `(.+)` and, under the
  // multiline flag, made the parse quadratic on adversarial pointer content. It is now
  // `/^gitdir:(.+)$/mu`, relying on the pre-existing `.trim()` to strip the same whitespace. This
  // pads the real `.git` pointer with a huge, otherwise-meaningless whitespace run around the
  // actual target and asserts the idempotent retry still resumes quickly with the SAME identity.
  it("resumes with an unchanged identity when the .git pointer is padded with adversarial whitespace", async () => {
    const service = makeService();
    const first = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t2",
      baseBranch: "main",
      requestedBy: "u",
    });
    const gitPointerPath = join(first.instance.managedWorktreePath, ".git");
    const rawTarget = readFileSync(gitPointerPath, "utf8")
      .replace(/^gitdir:/u, "")
      .trim();
    writeFileSync(gitPointerPath, `gitdir:${" ".repeat(20_000)}${rawTarget}${" ".repeat(5_000)}\n`);

    const start = Date.now();
    const second = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t2",
      baseBranch: "main",
      requestedBy: "u",
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(second.created).toBe(false);
    expect(second.instance.gitdirIdentity).toBe(first.instance.gitdirIdentity);
  });
});

describe("pre-write rejections (AC2)", () => {
  it("rejects an invalid base branch", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "t1",
          baseBranch: "nonexistent-base",
          requestedBy: "u",
        }),
      "INVALID_BASE_BRANCH",
    );
  });

  it("rejects a path that is not a git repository", async () => {
    const service = makeService();
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "keiko-notrepo-")));
    try {
      await rejectsWithCode(
        () =>
          service.provision({
            repositoryRequestPath: notRepo,
            taskId: "t1",
            baseBranch: "main",
            requestedBy: "u",
          }),
        "MISSING_REPOSITORY",
      );
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting pre-existing unmanaged branch", async () => {
    const branch = deriveTaskBranchName({ taskId: "conflict" });
    git(["branch", branch, "main"]);
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "conflict",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "BRANCH_CONFLICT",
    );
  });

  it("rejects an existing unmanaged worktree directory", async () => {
    const repositoryId = deriveRepositoryId(repoRoot);
    const workspaceId = deriveWorkspaceId({ repositoryId, taskId: "unmanaged" });
    mkdirSync(deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId }), {
      recursive: true,
    });
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "unmanaged",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "EXISTING_UNMANAGED_PATH",
    );
  });

  it("rejects an unsafe base branch name before touching git (INVALID_REQUEST)", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "t1",
          baseBranch: "-evil-branch",
          requestedBy: "u",
        }),
      "INVALID_REQUEST",
    );
  });

  // #449/#1587 follow-up: a control/zero-width/bidi code point in a free-form identity field is
  // rejected at the validation boundary (before any worktree/instance row), so it can never reach the
  // advisory lock owner, the persisted instance, or the lifecycle evidence.
  it("rejects a bidi-override taskId before touching git (INVALID_REQUEST)", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: `t${String.fromCodePoint(0x202e)}1`,
          baseBranch: "main",
          requestedBy: "u",
        }),
      "INVALID_REQUEST",
    );
    // Nothing was persisted — the unsafe input never produced a workspace row.
    expect(store.listByRepository(deriveRepositoryId(repoRoot))).toHaveLength(0);
  });

  it("rejects a control-character requestedBy before touching git (INVALID_REQUEST)", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "t1",
          baseBranch: "main",
          requestedBy: `actor${String.fromCodePoint(0x00)}`,
        }),
      "INVALID_REQUEST",
    );
    expect(store.listByRepository(deriveRepositoryId(repoRoot))).toHaveLength(0);
  });

  it("rejects a zero-width requestedBy on activate (INVALID_REQUEST)", async () => {
    const service = makeService();
    const created = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId: created.instance.workspaceId,
          taskId: "t1",
          requestedBy: `u${String.fromCodePoint(0x200b)}`,
          acquireLock: true,
        }),
      "INVALID_REQUEST",
    );
  });

  it("returns the terminal-state instance idempotently without re-provisioning", async () => {
    store.upsert(validInstance("archived", { lifecycleState: "archived", health: "healthy" }));
    const service = makeService();
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "archived",
      baseBranch: "main",
      requestedBy: "u",
    });
    expect(result.created).toBe(false);
    expect(result.instance.lifecycleState).toBe("archived");
    expect(store.listByRepository(deriveRepositoryId(repoRoot))).toHaveLength(1);
  });

  it("rejects when another actor holds a live provisioning lock", async () => {
    store.upsert(
      validInstance("locked", {
        lifecycleState: "provisioning",
        lock: {
          lockId: "other-lock",
          owner: "other",
          reason: "provisioning",
          acquiredAt: new Date(FIXED_NOW).toISOString(),
          expiresAt: new Date(FIXED_NOW + 60_000).toISOString(),
        },
      }),
    );
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "locked",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "LOCK_CONTENTION",
    );
  });
});

describe("drift + partial failure leave a visible classified state (SC4)", () => {
  it("rolls back and classifies a managed workspace identity failure", async () => {
    const identityFailure = new Error("identity store unavailable");
    const service = makeService(undefined, () => {
      throw identityFailure;
    });
    await expect(
      service.provision({
        repositoryRequestPath: repoRoot,
        taskId: "identity-failure",
        baseBranch: "main",
        requestedBy: "u",
      }),
    ).rejects.toMatchObject({
      code: "PROVISIONING_FAILED",
      cause: identityFailure,
    });
    const repositoryId = deriveRepositoryId(repoRoot);
    const failed = store.getById(deriveWorkspaceId({ repositoryId, taskId: "identity-failure" }));
    expect(failed?.lifecycleState).toBe("failed");
    expect(failed?.lock).toBeNull();
    expect(existsSync(failed?.managedWorktreePath ?? "")).toBe(false);
  });

  it("flags recovery-required when the managed worktree has vanished (stale pointer)", async () => {
    const service = makeService();
    const created = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "drift",
      baseBranch: "main",
      requestedBy: "u",
    });
    rmSync(created.instance.managedWorktreePath, { recursive: true, force: true });
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "drift",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "POINTER_DRIFT",
    );
    const after = store.getById(created.instance.workspaceId);
    expect(after?.lifecycleState).toBe("recovery-required");
    expect(after?.driftMarkers).toContain("worktree-missing");
  });

  it("persists a visible failed state when the worktree mutation fails", async () => {
    const failingAdapter = (workspace: WorkspaceInfo): GitWorktreeAdapter => {
      const ok: WorktreeOperationResult = {
        ok: true,
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        truncated: false,
      };
      const fail: WorktreeOperationResult = {
        ok: false,
        exitCode: 128,
        durationMs: 0,
        timedOut: false,
        truncated: false,
      };
      return {
        resolveRepositoryRoot: (): Promise<string | undefined> => Promise.resolve(workspace.root),
        refResolves: (): Promise<boolean> => Promise.resolve(true),
        localBranchExists: (): Promise<boolean> => Promise.resolve(false),
        listWorktrees: (): Promise<readonly never[]> => Promise.resolve([]),
        worktreeStatus: (): Promise<{ ok: boolean; dirty: boolean }> =>
          Promise.resolve({ ok: true, dirty: false }),
        addWorktree: (): Promise<WorktreeOperationResult> => Promise.resolve(fail),
        addWorktreeForExistingBranch: (): Promise<WorktreeOperationResult> => Promise.resolve(fail),
        removeWorktree: (): Promise<WorktreeOperationResult> => Promise.resolve(ok),
        pruneWorktrees: (): Promise<WorktreeOperationResult> => Promise.resolve(ok),
      };
    };
    const service = makeService(failingAdapter);
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "fail",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "PROVISIONING_FAILED",
    );
    const repositoryId = deriveRepositoryId(repoRoot);
    const failed = store.getById(deriveWorkspaceId({ repositoryId, taskId: "fail" }));
    expect(failed?.lifecycleState).toBe("failed");
    expect(failed?.lock).toBeNull();
  });
});

describe("activate", () => {
  it("activates an active workspace and yields its binding", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act",
      baseBranch: "main",
      requestedBy: "u",
    });
    const activated = await service.activate({
      workspaceId: provisioned.instance.workspaceId,
      taskId: "act",
      requestedBy: "u",
      acquireLock: false,
    });
    expect(activated.instance.lifecycleState).toBe("active");
    expect(activated.binding.activeRoot).toBe(provisioned.instance.managedWorktreePath);
  });

  it("resumes a paused workspace (paused -> active) and emits a resumed event", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act-resume",
      baseBranch: "main",
      requestedBy: "u",
    });
    store.upsert({ ...provisioned.instance, lifecycleState: "paused", lock: null });
    const activated = await service.activate({
      workspaceId: provisioned.instance.workspaceId,
      taskId: "act-resume",
      requestedBy: "u",
      acquireLock: false,
    });
    expect(activated.instance.lifecycleState).toBe("active");
    expect(
      evidence.some(
        (e) => e.json.includes('"type": "resumed"') || e.json.includes('"type":"resumed"'),
      ),
    ).toBe(true);
  });

  it("reactivates a handoff-ready workspace (handoff-ready -> active)", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act-handoff",
      baseBranch: "main",
      requestedBy: "u",
    });
    store.upsert({ ...provisioned.instance, lifecycleState: "handoff-ready", lock: null });
    const activated = await service.activate({
      workspaceId: provisioned.instance.workspaceId,
      taskId: "act-handoff",
      requestedBy: "u",
      acquireLock: false,
    });
    expect(activated.instance.lifecycleState).toBe("active");
    expect(activated.binding.activeRoot).toBe(provisioned.instance.managedWorktreePath);
  });

  it("rejects activation from an archived lifecycle state", async (): Promise<void> => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act-archived",
      baseBranch: "main",
      requestedBy: "u",
    });
    store.upsert({
      ...provisioned.instance,
      lifecycleState: "archived",
      health: "healthy",
      lock: null,
    });

    await rejectsWithCode(
      (): Promise<WorkspaceActivateResult> =>
        service.activate({
          workspaceId: provisioned.instance.workspaceId,
          taskId: "act-archived",
          requestedBy: "u",
          acquireLock: false,
        }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("rejects activation when the persisted managed path escapes the managed root", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act-escape",
      baseBranch: "main",
      requestedBy: "u",
    });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-prov-escape-")));
    try {
      store.upsert({ ...provisioned.instance, managedWorktreePath: outside });
      await rejectsWithCode(
        () =>
          service.activate({
            workspaceId: provisioned.instance.workspaceId,
            taskId: "act-escape",
            requestedBy: "u",
            acquireLock: false,
          }),
        "UNSAFE_PATH",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("flags drift (recovery-required) when activating a workspace whose worktree vanished", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act-drift",
      baseBranch: "main",
      requestedBy: "u",
    });
    rmSync(provisioned.instance.managedWorktreePath, { recursive: true, force: true });
    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId: provisioned.instance.workspaceId,
          taskId: "act-drift",
          requestedBy: "u",
          acquireLock: false,
        }),
      "POINTER_DRIFT",
    );
    const after = store.getById(provisioned.instance.workspaceId);
    expect(after?.lifecycleState).toBe("recovery-required");
    expect(after?.driftMarkers).toContain("worktree-missing");
  });

  it("rejects activation of an unknown workspace", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId: "ws_unknown",
          taskId: "x",
          requestedBy: "u",
          acquireLock: false,
        }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("rejects activation when the expected lifecycle state no longer matches", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act2",
      baseBranch: "main",
      requestedBy: "u",
    });
    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId: provisioned.instance.workspaceId,
          taskId: "act2",
          requestedBy: "u",
          acquireLock: false,
          expectedLifecycleState: "paused",
        }),
      "LOCK_CONTENTION",
    );
  });
});
