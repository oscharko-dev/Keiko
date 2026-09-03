// Coverage for the #446 active-binding lifecycle service. Proves the atomic switch (setActive sets the
// derived-binding pointer), pause (clears the pointer + walks active→paused), resume (paused→active +
// re-binds), handoff (clean-only, pointer untouched), the legal-transition gate, lock contention, the
// dangling-pointer self-heal, and list-by-repository — all over the real stores + a fake #445
// provisioning service so the lifecycle walk delegation is exercised without real git worktrees.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { buildBinding } from "./binding.js";
import { deriveRepositoryId } from "./naming.js";
import { createWorkspaceLifecycleService } from "./lifecycle.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import type {
  WorkspaceActivateResult,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
} from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
} from "../observability/index.js";
import { runWithWorkspaceLifecycleFailureLogging } from "./activity-log.js";
import type { ManagedIdentityDrift } from "./gitdir-identity.js";

const __twMutex = createWorkspaceMutexRegistry();

const REPO_ROOT = "/repo";
const REPO_ID = deriveRepositoryId(REPO_ROOT);

let db: DatabaseSync;
let managedRoot: string;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let service: WorkspaceLifecycleService;
let idCounter: number;

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

function instance(taskId: string, overrides: Partial<WorkspaceInstance> = {}): WorkspaceInstance {
  const workspaceId = `ws_${taskId.padEnd(24, "x").slice(0, 24)}`;
  const managedWorktreePath = join(managedRoot, REPO_ID, workspaceId);
  mkdirSync(managedWorktreePath, { recursive: true });
  return {
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId: REPO_ID,
    repositoryRoot: REPO_ROOT,
    baseBranch: "main",
    taskBranch: `keiko/task/${taskId}`,
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
    ...overrides,
  };
}

// A fake #445 provisioning service: activate reads the instance, walks it to `active`, and persists —
// the same contract the lifecycle service delegates the switch/resume walk to.
function fakeProvisioning(
  ensureIdentity: ((instance: WorkspaceInstance) => void) | "omit" = (): void => undefined,
): WorkspaceProvisioningService {
  return {
    provision: () => Promise.reject(new Error("provision not used in lifecycle tests")),
    activate: ({ workspaceId }): Promise<WorkspaceActivateResult> => {
      const inst = store.getById(workspaceId);
      if (inst === undefined) {
        return Promise.reject(new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "not found"));
      }
      const next = store.upsert({
        ...inst,
        lifecycleState: "active",
        updatedAt: "2026-06-26T01:00:00.000Z",
      });
      return Promise.resolve({ instance: next, binding: buildBinding(next) });
    },
    getInstance: (id) => store.getById(id),
    ...(ensureIdentity === "omit" ? {} : { ensureIdentity }),
  };
}

// The fixture worktrees are plain directories, not linked Git worktrees, so the live identity proof
// is injected: `matches` by default, and one of the refusing verdicts where a pin needs it.
function lifecycleWith(
  provisioning: WorkspaceProvisioningService,
  activityLog?: ServerLogSink,
  evidenceStore: EvidenceStore = capturingEvidence(),
  identityDrift: (instance: WorkspaceInstance) => ManagedIdentityDrift = (): ManagedIdentityDrift =>
    "matches",
): WorkspaceLifecycleService {
  return createWorkspaceLifecycleService({
    store,
    activePointerStore: pointerStore,
    managedRoot,
    provisioning,
    evidenceStore,
    redactString: (s: string): string => s,
    now: (): number => 1_700_000_000_000,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
    identityDrift,
    ...(activityLog === undefined ? {} : { activityLog }),
  });
}

// Single narrowing point for a captured activity-log line, so a chain of `expect(line?.field)`
// assertions (each `?.` its own branch to ESLint's `complexity` rule) does not push an otherwise
// linear assertion test over the repo's complexity ceiling (AGENTS.md §6).
function activityLogEventAt(sink: BufferedServerLogSink, index: number): ServerLogEvent {
  const line = sink.events.at(index);
  if (line === undefined) throw new Error("no activity-log event recorded");
  return line;
}

function lastActivityLogEvent(sink: BufferedServerLogSink): ServerLogEvent {
  return activityLogEventAt(sink, -1);
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

beforeEach(() => {
  managedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lifecycle-managed-")));
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  store = buildWorkspaceInstanceStoreOverDatabase(db);
  pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  evidence = [];
  idCounter = 0;
  service = lifecycleWith(fakeProvisioning());
});

afterEach(() => {
  db.close();
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("getActive / list", () => {
  it("returns undefined in unbound mode", () => {
    expect(service.getActive()).toBeUndefined();
  });

  it("lists the persisted instances for a repository root", () => {
    store.upsert(instance("a"));
    store.upsert(instance("b"));
    expect(service.list(REPO_ROOT)).toHaveLength(2);
    expect(service.list("/other")).toHaveLength(0);
  });

  it("rejects an empty repository root", () => {
    expect(() => service.list("")).toThrow(TaskWorkspaceError);
  });

  // The switcher's inventory: the pointer is global, so it spans every repository.
  it("lists every persisted instance across repositories", () => {
    store.upsert(instance("a"));
    store.upsert(instance("b", { repositoryId: "repo_other", repositoryRoot: "/other" }));
    expect(service.listAll()).toHaveLength(2);
    expect(service.list(REPO_ROOT)).toHaveLength(1);
  });

  it("self-heals a dangling pointer (instance gone) to unbound mode", () => {
    const inst = store.upsert(instance("a"));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    store.delete(inst.workspaceId);
    expect(service.getActive()).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();
  });

  it("self-heals an active pointer whose persisted path no longer contains to the managed root", () => {
    const inst = store.upsert(instance("a"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lifecycle-escape-")));
    try {
      store.upsert({ ...inst, managedWorktreePath: outside });
      pointerStore.set({
        workspaceId: inst.workspaceId,
        setBy: "op",
        atIso: "2026-06-26T00:00:00.000Z",
      });
      expect(service.getActive()).toBeUndefined();
      expect(pointerStore.get()).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("backfills managed identity before exposing a persisted active pointer after restart", () => {
    const inst = store.upsert(instance("restart"));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    const observed: string[] = [];
    const restarted = lifecycleWith(
      fakeProvisioning((candidate) => {
        observed.push(candidate.managedWorktreePath);
      }),
    );

    expect(restarted.getActive()?.instance.workspaceId).toBe(inst.workspaceId);
    expect(observed).toEqual([inst.managedWorktreePath]);
  });

  it("fails closed when persisted active identity cannot be repaired after restart", () => {
    const inst = store.upsert(instance("restart-failure"));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    const restarted = lifecycleWith(
      fakeProvisioning(() => {
        throw new Error("identity store unavailable");
      }),
    );

    expect(restarted.getActive()).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();
  });

  // Observed live on 2026-09-03: a startup reconcile had flagged the pointed-at workspace
  // `recovery-required`, the read cleared the pointer, and the log carried nothing an operator could
  // tie their vanished binding to.
  it("logs why a pointer to a non-bindable lifecycle is cleared on the active read", () => {
    const inst = store.upsert(instance("restart-flagged", { lifecycleState: "recovery-required" }));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    const activityLog = createBufferedServerLogSink();
    const restarted = lifecycleWith(fakeProvisioning(), activityLog);

    expect(restarted.getActive("active-read-0001")).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();
    const line = activityLog.events.find((event) => event.errorKind === "ILLEGAL_TRANSITION");
    expect(line?.correlationId).toBe("active-read-0001");
    expect(line?.extra).toMatchObject({
      operation: "activate",
      outcome: "blocked",
      workspaceId: inst.workspaceId,
    });
  });

  it("fails closed and clears the active pointer when identity repair is unavailable", () => {
    const inst = store.upsert(instance("restart-without-identity-hook"));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    const restarted = lifecycleWith(fakeProvisioning("omit"));

    expect(restarted.getActive()).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();
  });
});

describe("setActive (atomic switch)", () => {
  it("activates the target and records it as the active pointer", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "paused" }));
    const view = await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    expect(view.instance.lifecycleState).toBe("active");
    expect(view.binding.activeRoot).toBe(inst.managedWorktreePath);
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
    expect(service.getActive()?.binding.activeRoot).toBe(inst.managedWorktreePath);
  });

  it("switching to a different workspace re-points atomically", async () => {
    const a = store.upsert(instance("a"));
    const b = store.upsert(instance("b"));
    await service.setActive({ workspaceId: a.workspaceId, requestedBy: "op", acquireLock: false });
    await service.setActive({ workspaceId: b.workspaceId, requestedBy: "op", acquireLock: false });
    expect(service.getActive()?.instance.workspaceId).toBe(b.workspaceId);
  });

  it("rejects an unknown workspace via the delegated activation", async () => {
    await rejectsWithCode(
      () => service.setActive({ workspaceId: "ws-missing", requestedBy: "op", acquireLock: false }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("does not duplicate an invalid activation logged by the delegated provisioning boundary", async () => {
    const activityLog = createBufferedServerLogSink();
    const delegated = fakeProvisioning();
    const provisioning: WorkspaceProvisioningService = {
      ...delegated,
      activate: (request): Promise<WorkspaceActivateResult> =>
        runWithWorkspaceLifecycleFailureLogging(
          { activityLog },
          {
            operation: "activate",
            workspaceIdentitySeed: request.workspaceId || request.taskId || "invalid-activation",
            correlationId: request.correlationId,
          },
          () => Promise.reject(new TaskWorkspaceError("INVALID_REQUEST", "hostile body")),
        ),
    };
    const withLog = lifecycleWith(provisioning, activityLog);

    await rejectsWithCode(
      () =>
        withLog.setActive({
          workspaceId: "",
          requestedBy: "op",
          acquireLock: false,
          correlationId: "req-corr-nested-activation-1",
        }),
      "INVALID_REQUEST",
    );

    expect(activityLog.events).toHaveLength(1);
    expect(lastActivityLogEvent(activityLog)).toMatchObject({
      correlationId: "req-corr-nested-activation-1",
      errorKind: "INVALID_REQUEST",
      extra: { operation: "activate" },
    });
    expect(activityLog.lines().join("\n")).not.toContain("hostile body");
  });

  // #449/#1587 follow-up: requestedBy is persisted as the active-pointer setBy, so a control/bidi
  // code point is rejected before the pointer is ever bound.
  it("rejects a bidi-override requestedBy and leaves the pointer unbound", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "paused" }));
    await rejectsWithCode(
      () =>
        service.setActive({
          workspaceId: inst.workspaceId,
          requestedBy: `op${String.fromCodePoint(0x202e)}`,
          acquireLock: false,
        }),
      "INVALID_REQUEST",
    );
    expect(pointerStore.get()).toBeUndefined();
  });
});

describe("pause", () => {
  it("walks active→paused and clears the pointer when it was active", async () => {
    const inst = store.upsert(instance("a"));
    await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    const result = await service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("paused");
    expect(pointerStore.get()).toBeUndefined();
    expect(evidence.some((e) => e.json.includes('"paused"'))).toBe(true);
  });

  // F1: the evidence's correlationId must be the triggering request's own id, not the workspace's own
  // persisted identity reused for every operation across the workspace's whole life — reusing it would
  // make every distinct HTTP request against this workspace collapse onto ONE correlationId, breaking
  // the join back to the specific request that produced each line (AGENTS.md §8).
  it("threads the request's own correlationId into pause evidence, not the workspaceId", async () => {
    const inst = store.upsert(instance("corr"));
    await service.pause({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      correlationId: "req-corr-pause-1",
    });
    expect(lastEventCorrelationId()).toBe("req-corr-pause-1");
    expect(lastEventCorrelationId()).not.toBe(inst.workspaceId);
  });

  it("falls back to UNKNOWN_CORRELATION_ID (never the workspaceId) when no request scope exists", async () => {
    const inst = store.upsert(instance("nocorr"));
    await service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
    expect(lastEventCorrelationId()).not.toBe(inst.workspaceId);
  });

  // Service entry points fail closed before values reach either persisted evidence or an adapter's
  // termination callback. This matrix pins the same safe shape the HTTP boundary accepts rather than
  // relying on the evidence contract's intentionally generic non-empty-string validation.
  describe("correlation-ID regression matrix", () => {
    it.each([
      ["empty", ""],
      ["malformed", "req corr\ncontrol"],
      ["oversized", `req-corr-${"a".repeat(4000)}`],
      ["below the minimum length", "x"],
    ] as const)(
      "normalizes a %s correlationId before persisting evidence",
      async (_label, value) => {
        const inst = store.upsert(instance("corr-invalid"));
        await service.pause({
          workspaceId: inst.workspaceId,
          requestedBy: "op",
          correlationId: value,
        });
        expect(lastEventCorrelationId()).toBe(UNKNOWN_CORRELATION_ID);
      },
    );
  });

  // IDX61: the EvidenceStore ledger above is a SEPARATE audit surface from `<stateDir>/logs/
  // server.log` — this proves the SAME pause outcome also reaches the server activity log
  // (AGENTS.md §8), carrying the SAME correlationId the evidence assertions above just proved.
  it("emits a task-workspace.lifecycle activity-log line alongside the evidence, same correlationId", async () => {
    const activityLog = createBufferedServerLogSink();
    const withLog = lifecycleWith(fakeProvisioning(), activityLog);
    const inst = store.upsert(instance("activity-log"));
    await withLog.pause({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      correlationId: "req-corr-pause-activity-1",
    });
    const line = lastActivityLogEvent(activityLog);
    expect(line.category).toBe("diagnostic");
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-corr-pause-activity-1");
    expect(line.level).toBe("info");
    expect(line.errorKind).toBeUndefined();
    const extra = line.extra ?? {};
    expect(extra.operation).toBe("pause");
    expect(extra.outcome).toBe("paused");
    expect(extra.workspaceId).toBe(inst.workspaceId);
  });

  it("logs a closed, correlated rejection when an illegal pause throws before lifecycle evidence", async () => {
    const activityLog = createBufferedServerLogSink();
    const withLog = lifecycleWith(fakeProvisioning(), activityLog);
    const inst = store.upsert(instance("activity-log-rejection", { lifecycleState: "archived" }));
    await rejectsWithCode(
      () =>
        withLog.pause({
          workspaceId: inst.workspaceId,
          requestedBy: "op",
          correlationId: "req-corr-pause-rejection-1",
        }),
      "ILLEGAL_TRANSITION",
    );
    const line = lastActivityLogEvent(activityLog);
    expect(line.op).toBe("task-workspace.lifecycle");
    expect(line.correlationId).toBe("req-corr-pause-rejection-1");
    expect(line.errorKind).toBe("ILLEGAL_TRANSITION");
    expect(line.extra?.operation).toBe("pause");
    expect(line.extra?.workspaceIdentity).toMatch(/^wsref_[0-9a-f]{24}$/u);
    const formatted = activityLog.lines().at(-1) ?? "{}";
    const parsed = JSON.parse(formatted) as Readonly<Record<string, unknown>>;
    expect(formatted).not.toContain(inst.workspaceId);
    expect(parsed.operation).toBe("pause");
    expect(parsed.workspaceIdentity).toMatch(/^wsref_[0-9a-f]{24}$/u);
  });

  it("logs a correlated evidence-persistence diagnostic while retaining the lifecycle outcome", async () => {
    let putAttempts = 0;
    let attemptedEventId: string | undefined;
    const persistedEvidence = new Map<string, string>();
    const throwingStore: EvidenceStore = {
      put: (id: string): string => {
        putAttempts += 1;
        attemptedEventId = id;
        throw new Error("disk full with secret payload");
      },
      list: (): readonly string[] => [...persistedEvidence.keys()],
      get: (id: string): string | undefined => persistedEvidence.get(id),
      delete: (id: string): void => {
        persistedEvidence.delete(id);
      },
    };
    const activityLog = createBufferedServerLogSink();
    const withLog = lifecycleWith(fakeProvisioning(), activityLog, throwingStore);
    const inst = store.upsert(instance("activity-log-evidence-failure"));
    await withLog.pause({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      correlationId: "req-corr-evidence-failure-1",
    });
    expect(putAttempts).toBe(1);
    expect(attemptedEventId).toBeDefined();
    expect(throwingStore.get(attemptedEventId ?? "")).toBeUndefined();
    expect(activityLog.events).toHaveLength(2);
    const diagnostic = activityLogEventAt(activityLog, 0);
    const lifecycle = activityLogEventAt(activityLog, 1);
    const diagnosticExtra = diagnostic.extra ?? {};
    expect(diagnostic.errorKind).toBe("EVIDENCE_PERSISTENCE_FAILED");
    expect(diagnostic.correlationId).toBe("req-corr-evidence-failure-1");
    expect(diagnosticExtra.operation).toBe("pause");
    expect(diagnosticExtra.evidencePersistence).toBe("failed");
    expect(diagnosticExtra.workspaceId).toBe(inst.workspaceId);
    expect(diagnosticExtra.eventId).toBe(attemptedEventId);
    expect(lifecycle.extra?.outcome).toBe("paused");
    expect(activityLog.lines().join("\n")).not.toContain("secret payload");
  });

  it("leaves the active pointer untouched when pausing a DIFFERENT (non-active) workspace", async () => {
    const a = store.upsert(instance("a"));
    const b = store.upsert(instance("b"));
    await service.setActive({ workspaceId: a.workspaceId, requestedBy: "op", acquireLock: false });
    const result = await service.pause({ workspaceId: b.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("paused");
    // A stays the active workspace — pausing B must not clear A's pointer.
    expect(pointerStore.get()?.workspaceId).toBe(a.workspaceId);
  });

  it("rejects an illegal transition (cannot pause an archived workspace)", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "archived" }));
    await rejectsWithCode(
      () => service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("rejects when another actor holds a live lock", async () => {
    const inst = store.upsert(
      instance("a", {
        lock: {
          lockId: "l1",
          owner: "someone-else",
          reason: "mutation",
          acquiredAt: new Date(1_700_000_000_000).toISOString(),
          expiresAt: new Date(1_700_000_000_000 + 600_000).toISOString(),
        },
      }),
    );
    await rejectsWithCode(
      () => service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "LOCK_CONTENTION",
    );
  });

  it("rejects an unknown workspace", async () => {
    await rejectsWithCode(
      () => service.pause({ workspaceId: "ws-missing", requestedBy: "op" }),
      "WORKSPACE_NOT_FOUND",
    );
  });
});

describe("resume", () => {
  it("walks paused→active and re-binds the pointer", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "paused" }));
    const result = await service.resume({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("active");
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
  });

  it("walks handoff-ready→active and re-binds the pointer", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "handoff-ready" }));
    const result = await service.resume({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("active");
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
  });
});

describe("prepareHandoff", () => {
  it("walks active→handoff-ready on a clean worktree and leaves the pointer untouched", async () => {
    const inst = store.upsert(instance("a"));
    await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    const result = await service.prepareHandoff({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
    });
    expect(result.instance.lifecycleState).toBe("handoff-ready");
    // handoff does not clear the active pointer (the workspace stays the active context).
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
  });

  it("rejects handoff when the worktree is dirty (uncommitted changes)", async () => {
    const inst = store.upsert(instance("a", { driftMarkers: ["uncommitted-changes"] }));
    await rejectsWithCode(
      () => service.prepareHandoff({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "ILLEGAL_TRANSITION",
    );
  });
});

describe("clearActive", () => {
  it("clears the pointer → unbound mode", async () => {
    const inst = store.upsert(instance("a"));
    await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    service.clearActive();
    expect(service.getActive()).toBeUndefined();
  });
});

// No path exposes an operational binding or readiness state on path existence alone: the active
// pointer read and the handoff transition run the same four-way identity verdict activation and
// resume run, and a retired, unsupported or changed identity is refused with its own marker
// (#3376 review P1).
describe("identity proof before bindings and readiness", () => {
  it("clears an active pointer whose registration is under the retired identity rule, and logs why", async () => {
    const activityLog = createBufferedServerLogSink();
    const provisioning = fakeProvisioning();
    const trusted = lifecycleWith(provisioning, activityLog);
    const inst = store.upsert(instance("a"));
    await trusted.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    expect(trusted.getActive()?.instance.workspaceId).toBe(inst.workspaceId);

    // The same persisted pointer, read by a server whose identity rule has moved on.
    const upgraded = lifecycleWith(
      provisioning,
      activityLog,
      capturingEvidence(),
      () => "schema-retired",
    );

    expect(upgraded.getActive()).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();
    const line = activityLog.events.find((event) => event.errorKind === "POINTER_DRIFT");
    expect(line?.extra).toMatchObject({
      operation: "activate",
      outcome: "retry-required",
      workspaceId: inst.workspaceId,
      driftMarker: "identity-schema-retired",
    });
    // The row has to AGREE with the pointer that was just dropped. Logging the refusal alone left
    // inventory showing `active`/`healthy` with no markers while `GET /active` was already unbound,
    // and Repair only appears where a hint exists — so the operator saw an active-looking workspace
    // with no way to fix it until the next startup reconcile ran (PR #3381 review).
    const flagged = store.getById(inst.workspaceId);
    expect(flagged?.lifecycleState).toBe("recovery-required");
    expect(flagged?.health).toBe("drifted");
    expect(flagged?.driftMarkers).toEqual(["identity-schema-retired"]);
    expect(flagged?.recoveryHints).toEqual([
      {
        marker: "identity-schema-retired",
        strategy: "reconcile-pointer",
        operatorActionRequired: false,
      },
    ]);
    expect(flagged?.lock).toBeNull();
  });

  // Every identity verdict the read refuses leaves the SAME row shape, through the same owner as a
  // readiness transition, so a bind refusal and a handoff refusal cannot describe one fact
  // differently.
  it.each([
    { drift: "unsupported", marker: "identity-unsupported" },
    { drift: "changed", marker: "gitdir-mismatch" },
    { drift: "unproven", marker: "pointer-stale" },
  ] as const)(
    "flags the row with $marker when the active read finds a $drift identity",
    ({ drift, marker }) => {
      const inst = store.upsert(instance(`read-${marker}`.slice(0, 20)));
      pointerStore.set({
        workspaceId: inst.workspaceId,
        setBy: "op",
        atIso: "2026-06-26T00:00:00.000Z",
      });
      const refusing = lifecycleWith(
        fakeProvisioning(),
        undefined,
        capturingEvidence(),
        () => drift,
      );

      expect(refusing.getActive()).toBeUndefined();

      const flagged = store.getById(inst.workspaceId);
      expect(flagged?.lifecycleState).toBe("recovery-required");
      expect(flagged?.driftMarkers).toEqual([marker]);
      expect(flagged?.recoveryHints).not.toEqual([]);
    },
  );

  // The other structural refusal on the read path: the worktree directory is gone. It used to
  // return false with no line and no row at all.
  it("flags a vanished worktree on the active read instead of refusing silently", () => {
    const inst = store.upsert(instance("read-missing"));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    rmSync(inst.managedWorktreePath, { recursive: true, force: true });
    const activityLog = createBufferedServerLogSink();
    const reading = lifecycleWith(fakeProvisioning(), activityLog);

    expect(reading.getActive("active-read-missing")).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();

    const flagged = store.getById(inst.workspaceId);
    expect(flagged?.lifecycleState).toBe("recovery-required");
    expect(flagged?.health).toBe("missing");
    expect(flagged?.driftMarkers).toEqual(["worktree-missing"]);
    const line = activityLog.events.find((event) => event.errorKind === "POINTER_DRIFT");
    expect(line?.correlationId).toBe("active-read-missing");
    expect(line?.extra).toMatchObject({
      operation: "activate",
      outcome: "retry-required",
      workspaceId: inst.workspaceId,
      driftMarker: "worktree-missing",
    });
  });

  // `changed` (a readable pointer proving another identity) carries the contract's
  // `gitdir-mismatch` marker — the SAME marker reconciliation persists for that fact, with the
  // executable `reconcile-pointer` strategy; `unproven` (no readable pointer at all) keeps the
  // operator-guided `pointer-stale`. Relocated pin: `changed` used to map to `pointer-stale`.
  it.each([
    { drift: "schema-retired", marker: "identity-schema-retired", strategy: "reconcile-pointer" },
    { drift: "unsupported", marker: "identity-unsupported", strategy: "operator-repair" },
    { drift: "changed", marker: "gitdir-mismatch", strategy: "reconcile-pointer" },
    { drift: "unproven", marker: "pointer-stale", strategy: "operator-repair" },
  ] as const)(
    "refuses handoff on a $drift identity and flags the row with $marker",
    async ({ drift, marker, strategy }) => {
      const activityLog = createBufferedServerLogSink();
      const refusing = lifecycleWith(
        fakeProvisioning(),
        activityLog,
        capturingEvidence(),
        () => drift,
      );
      const inst = store.upsert(instance("a"));

      await rejectsWithCode(
        () =>
          refusing.prepareHandoff({
            workspaceId: inst.workspaceId,
            requestedBy: "op",
            correlationId: "handoff-drift-0001",
          }),
        "POINTER_DRIFT",
      );

      const persisted = store.getById(inst.workspaceId);
      expect(persisted?.lifecycleState).toBe("recovery-required");
      expect(persisted?.driftMarkers).toEqual([marker]);
      expect(persisted?.recoveryHints).toContainEqual(expect.objectContaining({ strategy }));
      const line = activityLog.events.find((event) => event.correlationId === "handoff-drift-0001");
      expect(line?.extra).toMatchObject({
        operation: "handoff",
        outcome: "retry-required",
        driftMarker: marker,
      });
    },
  );

  // A proof that could not run is answered as the classified, retryable IDENTITY_PROOF_FAILED: the
  // read does not pretend the application is unbound (the pointer stays), and a readiness transition
  // neither flags nor moves the row (Cursor review on f50133b95).
  it("answers a failed proof on the active read and on handoff with IDENTITY_PROOF_FAILED, keeping state", async () => {
    const provisioning = fakeProvisioning();
    const trusted = lifecycleWith(provisioning);
    const inst = store.upsert(instance("a"));
    await trusted.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    const failing = lifecycleWith(provisioning, undefined, capturingEvidence(), () => {
      throw new TaskWorkspaceError("IDENTITY_PROOF_FAILED", "proof failed", [], {
        cause: new Error("EIO: input/output error"),
      });
    });

    expect(() => failing.getActive()).toThrow(
      expect.objectContaining({ code: "IDENTITY_PROOF_FAILED" }),
    );
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);

    await rejectsWithCode(
      () => failing.prepareHandoff({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "IDENTITY_PROOF_FAILED",
    );
    const persisted = store.getById(inst.workspaceId);
    expect(persisted?.lifecycleState).toBe("active");
    expect(persisted?.driftMarkers).toEqual([]);
  });

  // The contract's legality comes first: a terminal workspace cannot hand off, and no proof may move
  // it to recovery-required on the way to that refusal (#3376 review).
  it.each(["archived", "merged", "abandoned"] as const)(
    "refuses handoff from %s as ILLEGAL_TRANSITION before any identity proof runs",
    async (lifecycleState) => {
      const refusing = lifecycleWith(
        fakeProvisioning(),
        undefined,
        capturingEvidence(),
        () => "changed",
      );
      const inst = store.upsert(instance("a", { lifecycleState }));

      await rejectsWithCode(
        () => refusing.prepareHandoff({ workspaceId: inst.workspaceId, requestedBy: "op" }),
        "ILLEGAL_TRANSITION",
      );

      const persisted = store.getById(inst.workspaceId);
      expect(persisted?.lifecycleState).toBe(lifecycleState);
      expect(persisted?.driftMarkers).toEqual([]);
    },
  );

  // Another actor's live lock refuses as LOCK_CONTENTION before the proof could flag the row and
  // clear that lock (#3376 review).
  it("refuses handoff under another actor's live lock before the identity proof can touch the row", async () => {
    const refusing = lifecycleWith(
      fakeProvisioning(),
      undefined,
      capturingEvidence(),
      () => "changed",
    );
    const lock = {
      lockId: "L-other",
      owner: "someone-else",
      reason: "mutation" as const,
      acquiredAt: new Date(1_700_000_000_000).toISOString(),
      expiresAt: new Date(1_700_000_000_000 + 60_000).toISOString(),
    };
    const inst = store.upsert(instance("a", { lock }));

    await rejectsWithCode(
      () => refusing.prepareHandoff({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "LOCK_CONTENTION",
    );

    const persisted = store.getById(inst.workspaceId);
    expect(persisted?.lifecycleState).toBe("active");
    expect(persisted?.lock?.lockId).toBe("L-other");
    expect(persisted?.driftMarkers).toEqual([]);
  });

  it("still pauses a workspace whose identity is not current (pause exposes nothing)", async () => {
    const pausing = lifecycleWith(
      fakeProvisioning(),
      undefined,
      capturingEvidence(),
      () => "changed",
    );
    const inst = store.upsert(instance("a"));

    const result = await pausing.pause({ workspaceId: inst.workspaceId, requestedBy: "op" });

    expect(result.instance.lifecycleState).toBe("paused");
  });
});
