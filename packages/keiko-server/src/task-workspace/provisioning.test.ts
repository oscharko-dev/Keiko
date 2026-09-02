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
import { inspectManagedGitdirIdentity } from "./gitdir-identity.js";
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

function makeService(
  adapterFactory?: AdapterFactory,
  ensureManagedWorkspaceIdentity?: (instance: WorkspaceInstance, initializeTrust: boolean) => void,
  activityLog?: ServerLogSink,
): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: adapterFactory ?? realAdapter,
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

function expectLoggedRejection(
  sink: BufferedServerLogSink,
  operation: "provision" | "activate",
  errorKind: TaskWorkspaceErrorCode,
  rawIdentitySeed: string,
): void {
  expect(sink.events).toHaveLength(1);
  const line = lastActivityLogEvent(sink);
  expect(line).toMatchObject({
    op: "task-workspace.lifecycle",
    category: "diagnostic",
    errorKind,
    extra: { operation },
  });
  expect(line.extra?.workspaceIdentity).toMatch(/^wsref_[a-f0-9]{24}$/u);
  expect(sink.lines().join("\n")).not.toContain(rawIdentitySeed);
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
    const received: string[] = [];
    const service = makeService(capturingAdapterFactory(received));
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-nocorr",
      baseBranch: "main",
      requestedBy: "u",
    });
    expectOnlyAdapterCorrelation(received, UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).not.toBe(result.instance.workspaceId);
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
        const service = makeService(rejectingAdapterFactory(received));
        await expect(
          service.provision({
            repositoryRequestPath: repoRoot,
            taskId: `t-adapter-${_label.replaceAll(" ", "-")}`,
            baseBranch: "main",
            requestedBy: "u",
            correlationId: input,
          }),
        ).rejects.toThrow("captured adapter correlation");
        expectOnlyAdapterCorrelation(received, UNKNOWN_CORRELATION_ID);
      },
    );
  });

  // IDX51: the service owns one correlation-id normalization step before either the adapter's
  // termination-evidence callback or the lifecycle EvidenceStore can observe the value. This is the
  // same SAFE_CORRELATION_ID contract used by the HTTP boundary, imported by production rather than
  // re-derived here; every unshaped supplied value joins the explicit omitted-id fallback.
  describe("correlation-ID normalization", () => {
    it.each([
      ["empty", ""],
      ["malformed", "req corr\ncontrol"],
      ["hostile", `req-corr-${"a".repeat(4000)}`],
      ["below the HTTP boundary", "x"],
    ] as const)("normalizes a supplied %s ID in lifecycle evidence", async (_label, input) => {
      const service = makeService();
      await service.provision({
        repositoryRequestPath: repoRoot,
        taskId: `t-corr-${_label.replaceAll(" ", "-")}`,
        baseBranch: "main",
        requestedBy: "u",
        correlationId: input,
      });
      expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    });
  });

  // IDX61: the EvidenceStore ledger above is a SEPARATE audit surface from `<stateDir>/logs/
  // server.log` — this proves the SAME provision outcome also reaches the server activity log
  // (AGENTS.md §8), carrying the SAME correlationId the evidence assertions above just proved.
  it("emits a task-workspace.lifecycle activity-log line alongside the evidence, same correlationId", async () => {
    const activityLog = createBufferedServerLogSink();
    const received: string[] = [];
    const service = makeService(capturingAdapterFactory(received), undefined, activityLog);
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-activity-log",
      baseBranch: "main",
      requestedBy: "u",
      correlationId: "req-corr-activity-1",
    });
    expectOnlyAdapterCorrelation(received, "req-corr-activity-1");
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
    expect(extra.taskId).toBeUndefined();
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
    expect(activityLog.events).toHaveLength(1);
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

  it("fails closed instead of refreshing a mismatched persisted Git identity", async () => {
    const service = makeService();
    const first = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-identity-drift",
      baseBranch: "main",
      requestedBy: "u",
    });
    store.upsert({ ...first.instance, gitdirIdentity: "mismatched-gitdir-identity" });

    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "t-identity-drift",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "POINTER_DRIFT",
    );

    const persisted = store.getById(first.instance.workspaceId);
    expect(persisted?.lifecycleState).toBe("recovery-required");
    expect(persisted?.health).toBe("drifted");
    expect(persisted?.gitdirIdentity).toBe("mismatched-gitdir-identity");
    expect(persisted?.driftMarkers).toContain("pointer-stale");
  });

  // A workspace registered before the identity bound its pointer stamps is refused exactly like any
  // other mismatch — accepting the retired proof even once would reissue a replaced worktree as a
  // trusted one. What must differ is the sentence: telling an operator the Git identity CHANGED is a
  // false statement about their disk and sends them hunting a replacement that never happened.
  it("names the retired identity rule instead of claiming the Git identity changed", async () => {
    const service = makeService();
    const first = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-identity-schema",
      baseBranch: "main",
      requestedBy: "u",
    });
    const inspection = inspectManagedGitdirIdentity(first.instance.managedWorktreePath, repoRoot);
    if (inspection === undefined) throw new Error("real linked-worktree identity was not resolved");
    store.upsert({ ...first.instance, gitdirIdentity: inspection.legacyIdentity });

    const failure = await service
      .provision({
        repositoryRequestPath: repoRoot,
        taskId: "t-identity-schema",
        baseBranch: "main",
        requestedBy: "u",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("predates the current identity rule");
    expect((failure as Error).message).not.toContain("git identity changed");
    const persisted = store.getById(first.instance.workspaceId);
    expect(persisted?.lifecycleState).toBe("recovery-required");
    // A closed, body-free marker, so a support export can separate this migration from a real
    // pointer change without reading the thrown message.
    expect(persisted?.driftMarkers).toEqual(["identity-schema-retired"]);
    expect(persisted?.driftMarkers).not.toContain("pointer-stale");
    // The retired value is never promoted into a current one.
    expect(persisted?.gitdirIdentity).toBe(inspection.legacyIdentity);
  });

  // The refusal above persists `recovery-required`, which is in COMPLETABLE_STATES. Without an
  // explicit guard the NEXT identical request falls through to the completion path, recomputes a
  // current identity and finalizes it — reissuing the proof the refusal withheld, with no operator
  // approval anywhere.
  it("keeps refusing a retired identity on every retry instead of completing it", async () => {
    const service = makeService();
    const first = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t-identity-retry",
      baseBranch: "main",
      requestedBy: "u",
    });
    const inspection = inspectManagedGitdirIdentity(first.instance.managedWorktreePath, repoRoot);
    if (inspection === undefined) throw new Error("real linked-worktree identity was not resolved");
    store.upsert({ ...first.instance, gitdirIdentity: inspection.legacyIdentity });

    const request = {
      repositoryRequestPath: repoRoot,
      taskId: "t-identity-retry",
      baseBranch: "main",
      requestedBy: "u",
    };
    await rejectsWithCode(() => service.provision(request), "POINTER_DRIFT");
    await rejectsWithCode(() => service.provision(request), "POINTER_DRIFT");

    const persisted = store.getById(first.instance.workspaceId);
    expect(persisted?.lifecycleState).toBe("recovery-required");
    expect(persisted?.driftMarkers).toEqual(["identity-schema-retired"]);
    // The retired value is never promoted into a current one, on any attempt.
    expect(persisted?.gitdirIdentity).toBe(inspection.legacyIdentity);
  });

  // Regression for S8786: the formerly duplicated `.git` pointer parse used to be
  // `/^gitdir:\s*(.+)\s*$/mu`, whose leading/trailing `\s*` overlapped with `(.+)` and, under the
  // multiline flag, made the parse quadratic on adversarial pointer content. The shared production
  // parser now uses a literal prefix plus a bounded complete descriptor read. This pads the real
  // pointer and asserts the idempotent retry still resumes with the SAME identity.
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

describe("early rejection activity logging", () => {
  it("logs an invalid provision request without exposing its free-form task identity", async () => {
    const activityLog = createBufferedServerLogSink();
    const service = makeService(undefined, undefined, activityLog);
    const taskId = `Patient-Jane-cancer${String.fromCodePoint(0x200b)}`;

    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId,
          baseBranch: "main",
          requestedBy: "operator",
          correlationId: "provision-invalid-request-1",
        }),
      "INVALID_REQUEST",
    );

    expectLoggedRejection(activityLog, "provision", "INVALID_REQUEST", taskId);
    expect(lastActivityLogEvent(activityLog).correlationId).toBe("provision-invalid-request-1");
  });

  it("logs a missing repository before any managed-workspace row exists", async () => {
    const activityLog = createBufferedServerLogSink();
    const taskId = "missing-repository-task";
    const service = makeService(
      (workspace): GitWorktreeAdapter => ({
        ...realAdapter(workspace),
        resolveRepositoryRoot: (): Promise<string | undefined> => Promise.resolve(undefined),
      }),
      undefined,
      activityLog,
    );

    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId,
          baseBranch: "main",
          requestedBy: "operator",
          correlationId: "provision-missing-repository-1",
        }),
      "MISSING_REPOSITORY",
    );

    expectLoggedRejection(activityLog, "provision", "MISSING_REPOSITORY", taskId);
    expect(lastActivityLogEvent(activityLog).correlationId).toBe("provision-missing-repository-1");
  });

  it("logs an invalid activation before acquiring the workspace mutex", async () => {
    const activityLog = createBufferedServerLogSink();
    const workspaceId = "ws_invalid_activation_private_seed";
    const service = makeService(undefined, undefined, activityLog);

    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId,
          taskId: "task",
          requestedBy: "",
          acquireLock: false,
          correlationId: "activate-invalid-request-1",
        }),
      "INVALID_REQUEST",
    );

    expectLoggedRejection(activityLog, "activate", "INVALID_REQUEST", workspaceId);
    expect(lastActivityLogEvent(activityLog).correlationId).toBe("activate-invalid-request-1");
  });

  it("logs an unknown activation target without exposing the supplied workspace value", async () => {
    const activityLog = createBufferedServerLogSink();
    const workspaceId = "Patient Jane cancer workspace";
    const service = makeService(undefined, undefined, activityLog);

    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId,
          taskId: "task",
          requestedBy: "operator",
          acquireLock: false,
          correlationId: "activate-missing-workspace-1",
        }),
      "WORKSPACE_NOT_FOUND",
    );

    expectLoggedRejection(activityLog, "activate", "WORKSPACE_NOT_FOUND", workspaceId);
    expect(lastActivityLogEvent(activityLog).correlationId).toBe("activate-missing-workspace-1");
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
    const activityLog = createBufferedServerLogSink();
    const service = makeService(undefined, undefined, activityLog);
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act-drift",
      baseBranch: "main",
      requestedBy: "u",
    });
    activityLog.clear();
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
    expect(activityLog.events).toHaveLength(1);
    expect(lastActivityLogEvent(activityLog)).toMatchObject({
      errorKind: "POINTER_DRIFT",
      extra: { operation: "activate", outcome: "retry-required" },
    });
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
