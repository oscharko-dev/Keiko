import { describe, expect, it } from "vitest";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  TASK_WORKSPACE_LIFECYCLE_STATES,
  TASK_WORKSPACE_LEGAL_TRANSITIONS,
  TASK_WORKSPACE_TRANSITION_PRECONDITIONS,
  TASK_WORKSPACE_HEALTH_STATES,
  TASK_WORKSPACE_DRIFT_MARKERS,
  WORKSPACE_LOCK_REASONS,
  WORKSPACE_RECOVERY_STRATEGIES,
  TASK_WORKSPACE_SURFACES,
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_EVENT_ALLOWED_KEYS,
  TASK_WORKSPACE_OPERATIONS,
  TASK_WORKSPACE_DELEGATED_SUBSYSTEMS,
  isTaskWorkspaceLifecycleState,
  isLegalTaskWorkspaceTransition,
  nextLegalTaskWorkspaceStates,
  isTaskWorkspaceTransitionPrecondition,
  requiredTaskWorkspaceTransitionPreconditions,
  validateTaskWorkspaceTransition,
  isTaskWorkspaceHealth,
  isTaskWorkspaceDriftMarker,
  isWorkspaceLockReason,
  isWorkspaceRecoveryStrategy,
  isWorkspaceSurface,
  isWorkspaceEventType,
  validateWorkspaceEvent,
  validateWorkspaceInstance,
  validateWorkspaceBinding,
  validateWorkspaceActivation,
  taskWorkspaceOperation,
  isReadOnlyTaskWorkspaceOperation,
  isMutatingTaskWorkspaceOperation,
  isDelegatedTaskWorkspaceConcern,
  taskWorkspaceDelegatedOwner,
} from "./task-workspace.js";
import type {
  TaskWorkspaceTransitionContext,
  WorkspaceEvent,
  WorkspaceInstance,
  WorkspaceBinding,
  WorkspaceActivation,
} from "./task-workspace.js";

const ALL_PRECONDITIONS_MET: TaskWorkspaceTransitionContext = {
  lockHeldByActor: true,
  pathContained: true,
  worktreeClean: true,
  branchReady: true,
  providerReady: true,
  operatorApproved: true,
};

const NO_PRECONDITIONS_MET: TaskWorkspaceTransitionContext = {
  lockHeldByActor: false,
  pathContained: false,
  worktreeClean: false,
  branchReady: false,
  providerReady: false,
  operatorApproved: false,
};

function validInstance(): WorkspaceInstance {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: "ws-1",
    taskId: "task-1",
    repositoryId: "repo-1",
    repositoryRoot: "/repos/keiko",
    baseBranch: "dev",
    taskBranch: "task/feat-1",
    managedWorktreePath: "/repos/keiko/.worktrees/task-1",
    gitdirIdentity: "gitdir-hash-1",
    lifecycleState: "active",
    health: "healthy",
    lock: {
      lockId: "lock-1",
      owner: "actor-1",
      reason: "activation",
      acquiredAt: "2026-06-26T00:00:00.000Z",
      expiresAt: "2026-06-26T01:00:00.000Z",
    },
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    lastVerifiedAt: "2026-06-26T00:00:00.000Z",
    lastVerifiedHead: "head-hash-1",
    driftMarkers: ["pointer-stale"],
    recoveryHints: [
      { marker: "pointer-stale", strategy: "reconcile-pointer", operatorActionRequired: false },
    ],
    auditCorrelationId: "corr-1",
  };
}

function validBinding(): WorkspaceBinding {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: "ws-1",
    taskId: "task-1",
    activeRoot: "/repos/keiko/.worktrees/task-1",
    boundSurfaces: ["chat", "editor", "git-delivery"],
    gitDeliveryRoot: "/repos/keiko/.worktrees/task-1",
    editorProjectRoot: "/repos/keiko/.worktrees/task-1",
  };
}

function validActivation(): WorkspaceActivation {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: "ws-1",
    taskId: "task-1",
    requestedBy: "actor-1",
    acquireLock: true,
    expectedLifecycleState: "provisioning",
  };
}

function validEvent(): WorkspaceEvent {
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    eventId: "evt-1",
    workspaceId: "ws-1",
    taskId: "task-1",
    type: "activated",
    at: "2026-06-26T00:00:00.000Z",
    correlationId: "corr-1",
  };
}

describe("lifecycle states + guard", () => {
  it("has exactly the 10 canonical states", () => {
    expect(TASK_WORKSPACE_LIFECYCLE_STATES).toHaveLength(10);
  });

  it("guards members true and junk false", () => {
    for (const state of TASK_WORKSPACE_LIFECYCLE_STATES) {
      expect(isTaskWorkspaceLifecycleState(state)).toBe(true);
    }
    expect(isTaskWorkspaceLifecycleState("running")).toBe(false);
    expect(isTaskWorkspaceLifecycleState(42)).toBe(false);
  });
});

describe("legal transition matrix", () => {
  it("declares a successor list for every state key", () => {
    for (const state of TASK_WORKSPACE_LIFECYCLE_STATES) {
      expect(Array.isArray(TASK_WORKSPACE_LEGAL_TRANSITIONS[state])).toBe(true);
    }
  });

  it("never permits a self-transition", () => {
    for (const state of TASK_WORKSPACE_LIFECYCLE_STATES) {
      expect(isLegalTaskWorkspaceTransition(state, state)).toBe(false);
    }
  });

  it("permits representative legal transitions", () => {
    expect(isLegalTaskWorkspaceTransition("provisioning", "active")).toBe(true);
    expect(isLegalTaskWorkspaceTransition("handoff-ready", "merged")).toBe(true);
    expect(isLegalTaskWorkspaceTransition("failed", "recovery-required")).toBe(true);
    expect(isLegalTaskWorkspaceTransition("cleanup-pending", "archived")).toBe(true);
  });

  it("rejects representative illegal transitions", () => {
    expect(isLegalTaskWorkspaceTransition("active", "merged")).toBe(false);
    expect(isLegalTaskWorkspaceTransition("archived", "active")).toBe(false);
    expect(isLegalTaskWorkspaceTransition("merged", "active")).toBe(false);
  });

  it("nextLegalTaskWorkspaceStates returns the matrix row", () => {
    expect(nextLegalTaskWorkspaceStates("merged")).toEqual(["archived", "cleanup-pending"]);
  });

  it("fails closed on non-state inputs instead of throwing (prototype-chain safe)", () => {
    // A post-deserialization / wire-supplied non-state must not throw or resolve through the
    // prototype chain (e.g. "__proto__" -> Object.prototype, "constructor" -> Object). Guards
    // return false / [] deterministically.
    for (const bad of ["", "__proto__", "constructor", "toString", "running"] as const) {
      expect(isLegalTaskWorkspaceTransition(bad as never, "active")).toBe(false);
      expect(isLegalTaskWorkspaceTransition("active", bad as never)).toBe(false);
      expect(nextLegalTaskWorkspaceStates(bad as never)).toEqual([]);
    }
    expect(isLegalTaskWorkspaceTransition(null as never, "active")).toBe(false);
    expect(nextLegalTaskWorkspaceStates(42 as never)).toEqual([]);
  });

  it("every successor is itself a known state", () => {
    for (const state of TASK_WORKSPACE_LIFECYCLE_STATES) {
      for (const next of TASK_WORKSPACE_LEGAL_TRANSITIONS[state]) {
        expect(isTaskWorkspaceLifecycleState(next)).toBe(true);
      }
    }
  });
});

describe("transition preconditions", () => {
  it("exposes the 6 precondition vocab + guard", () => {
    expect(TASK_WORKSPACE_TRANSITION_PRECONDITIONS).toHaveLength(6);
    for (const precondition of TASK_WORKSPACE_TRANSITION_PRECONDITIONS) {
      expect(isTaskWorkspaceTransitionPrecondition(precondition)).toBe(true);
    }
    expect(isTaskWorkspaceTransitionPrecondition("none")).toBe(false);
    expect(isTaskWorkspaceTransitionPrecondition(7)).toBe(false);
  });

  it("encodes representative precondition rows", () => {
    expect(requiredTaskWorkspaceTransitionPreconditions("provisioning", "active")).toEqual([
      "lock-held-by-actor",
      "path-contained",
      "branch-ready",
    ]);
    expect(requiredTaskWorkspaceTransitionPreconditions("active", "paused")).toEqual([
      "lock-held-by-actor",
    ]);
    expect(requiredTaskWorkspaceTransitionPreconditions("handoff-ready", "merged")).toEqual([
      "provider-ready",
      "operator-approval",
    ]);
    expect(requiredTaskWorkspaceTransitionPreconditions("failed", "recovery-required")).toEqual([]);
  });

  it("requires operator-approval on every legal transition into cleanup-pending", () => {
    for (const state of TASK_WORKSPACE_LIFECYCLE_STATES) {
      if (isLegalTaskWorkspaceTransition(state, "cleanup-pending")) {
        expect(requiredTaskWorkspaceTransitionPreconditions(state, "cleanup-pending")).toContain(
          "operator-approval",
        );
      }
    }
  });

  it("defaults to no preconditions for a pair absent from the table", () => {
    // An illegal/unlisted pair has no table row; the contract defaults to [].
    expect(requiredTaskWorkspaceTransitionPreconditions("archived", "active")).toEqual([]);
  });

  it("references only known preconditions in every table row", () => {
    for (const from of TASK_WORKSPACE_LIFECYCLE_STATES) {
      for (const to of TASK_WORKSPACE_LEGAL_TRANSITIONS[from]) {
        for (const precondition of requiredTaskWorkspaceTransitionPreconditions(from, to)) {
          expect(isTaskWorkspaceTransitionPrecondition(precondition)).toBe(true);
        }
      }
    }
  });
});

describe("validateTaskWorkspaceTransition", () => {
  it("rejects an illegal transition with a clear reason", () => {
    const result = validateTaskWorkspaceTransition({
      from: "active",
      to: "merged",
      context: ALL_PRECONDITIONS_MET,
    });
    expect(result).toEqual({
      ok: false,
      reasons: ["illegal transition from active to merged"],
    });
  });

  it("enumerates every unmet precondition", () => {
    const result = validateTaskWorkspaceTransition({
      from: "provisioning",
      to: "active",
      context: NO_PRECONDITIONS_MET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual([
        "unmet precondition: lock-held-by-actor",
        "unmet precondition: path-contained",
        "unmet precondition: branch-ready",
      ]);
    }
  });

  it("accepts a legal transition with all preconditions met", () => {
    expect(
      validateTaskWorkspaceTransition({
        from: "provisioning",
        to: "active",
        context: ALL_PRECONDITIONS_MET,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts a legal transition with no preconditions", () => {
    expect(
      validateTaskWorkspaceTransition({
        from: "failed",
        to: "recovery-required",
        context: NO_PRECONDITIONS_MET,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a self-transition through the full validator (never a no-op)", () => {
    // A self-transition is illegal: no state lists itself as a successor, so it falls through the
    // single legality check even when every precondition is satisfied. This pins the validator's
    // top-level rejection path (not just the isLegalTaskWorkspaceTransition lookup) so a mutation
    // dropping that check cannot pass silently. Matches ADR-0088 D2.
    for (const state of TASK_WORKSPACE_LIFECYCLE_STATES) {
      expect(
        validateTaskWorkspaceTransition({ from: state, to: state, context: ALL_PRECONDITIONS_MET }),
      ).toEqual({ ok: false, reasons: [`illegal transition from ${state} to ${state}`] });
    }
  });

  it("reports only the unmet preconditions (met ones produce no reason)", () => {
    // Partial satisfaction: exactly one required precondition of provisioning->active is false.
    // The result must list exactly that one reason — proving the per-precondition AND logic and
    // that satisfied preconditions never generate false reasons (guards against an AND->OR mutation).
    const result = validateTaskWorkspaceTransition({
      from: "provisioning",
      to: "active",
      context: { ...ALL_PRECONDITIONS_MET, pathContained: false },
    });
    expect(result).toEqual({ ok: false, reasons: ["unmet precondition: path-contained"] });
  });

  it("fails closed on a non-state from/to without throwing", () => {
    // An untrusted from/to forwarded by a future consumer must be rejected as illegal, never throw.
    expect(
      validateTaskWorkspaceTransition({
        from: "__proto__" as never,
        to: "active",
        context: ALL_PRECONDITIONS_MET,
      }),
    ).toEqual({ ok: false, reasons: ["illegal transition from __proto__ to active"] });
    expect(
      validateTaskWorkspaceTransition({
        from: "active",
        to: "nope" as never,
        context: ALL_PRECONDITIONS_MET,
      }),
    ).toEqual({ ok: false, reasons: ["illegal transition from active to nope"] });
  });
});

describe("enum vocab + guards", () => {
  it("health states", () => {
    expect(TASK_WORKSPACE_HEALTH_STATES).toHaveLength(6);
    for (const health of TASK_WORKSPACE_HEALTH_STATES) {
      expect(isTaskWorkspaceHealth(health)).toBe(true);
    }
    expect(isTaskWorkspaceHealth("ok")).toBe(false);
    expect(isTaskWorkspaceHealth(null)).toBe(false);
  });

  it("drift markers", () => {
    expect(TASK_WORKSPACE_DRIFT_MARKERS).toHaveLength(8);
    for (const marker of TASK_WORKSPACE_DRIFT_MARKERS) {
      expect(isTaskWorkspaceDriftMarker(marker)).toBe(true);
    }
    expect(isTaskWorkspaceDriftMarker("missing")).toBe(false);
  });

  it("lock reasons", () => {
    expect(WORKSPACE_LOCK_REASONS).toHaveLength(5);
    for (const reason of WORKSPACE_LOCK_REASONS) {
      expect(isWorkspaceLockReason(reason)).toBe(true);
    }
    expect(isWorkspaceLockReason("lock")).toBe(false);
  });

  it("recovery strategies", () => {
    expect(WORKSPACE_RECOVERY_STRATEGIES).toHaveLength(7);
    for (const strategy of WORKSPACE_RECOVERY_STRATEGIES) {
      expect(isWorkspaceRecoveryStrategy(strategy)).toBe(true);
    }
    expect(isWorkspaceRecoveryStrategy("retry")).toBe(false);
  });

  it("surfaces", () => {
    expect(TASK_WORKSPACE_SURFACES).toHaveLength(8);
    for (const surface of TASK_WORKSPACE_SURFACES) {
      expect(isWorkspaceSurface(surface)).toBe(true);
    }
    expect(isWorkspaceSurface("git")).toBe(false);
  });

  it("event types", () => {
    expect(WORKSPACE_EVENT_TYPES).toHaveLength(17);
    for (const type of WORKSPACE_EVENT_TYPES) {
      expect(isWorkspaceEventType(type)).toBe(true);
    }
    expect(isWorkspaceEventType("created")).toBe(false);
  });
});

describe("validateWorkspaceEvent (content-free, SC3)", () => {
  it("accepts a minimal event", () => {
    expect(validateWorkspaceEvent(validEvent())).toEqual({ ok: true });
  });

  it("accepts a full event with every optional field", () => {
    expect(
      validateWorkspaceEvent({
        ...validEvent(),
        type: "drift-detected",
        fromState: "active",
        toState: "recovery-required",
        health: "drifted",
        driftMarkers: ["head-moved", "pointer-stale"],
        lockId: "lock-1",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    expect(validateWorkspaceEvent(null)).toEqual({
      ok: false,
      reasons: ["event must be an object"],
    });
  });

  it("rejects any unknown key (content smuggling)", () => {
    const result = validateWorkspaceEvent({ ...validEvent(), sourceText: "secret payload" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("unknown key not allowed (content-free): sourceText");
    }
  });

  it("rejects bad schemaVersion, missing ids, bad enum, and bad optional types", () => {
    const result = validateWorkspaceEvent({
      schemaVersion: "9",
      eventId: "",
      workspaceId: 1,
      taskId: "task-1",
      type: "nope",
      at: "",
      correlationId: "corr-1",
      fromState: "weird",
      toState: "nope",
      health: "bad",
      driftMarkers: ["not-a-marker"],
      lockId: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "schemaVersion invalid",
          "eventId must be a non-empty string",
          "workspaceId must be a non-empty string",
          "at must be a non-empty string",
          "type invalid",
          "fromState invalid",
          "toState invalid",
          "health invalid",
          "driftMarkers contains an invalid marker",
          "lockId must be a non-empty string when present",
        ]),
      );
    }
  });

  it("rejects non-array driftMarkers", () => {
    const result = validateWorkspaceEvent({ ...validEvent(), driftMarkers: "head-moved" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("driftMarkers must be an array");
  });

  it("only allows the documented keys", () => {
    expect([...WORKSPACE_EVENT_ALLOWED_KEYS].sort()).toEqual(
      [
        "schemaVersion",
        "eventId",
        "workspaceId",
        "taskId",
        "type",
        "at",
        "correlationId",
        "fromState",
        "toState",
        "health",
        "driftMarkers",
        "lockId",
      ].sort(),
    );
  });
});

describe("validateWorkspaceInstance", () => {
  it("accepts a canonical instance", () => {
    expect(validateWorkspaceInstance(validInstance())).toEqual({ ok: true });
  });

  it("rejects an unknown content-bearing key on the persisted record (content-free, SC3)", () => {
    const result = validateWorkspaceInstance({ ...validInstance(), sourceDiff: "SECRET DIFF" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("unknown key not allowed (content-free): sourceDiff");
    }
  });

  it("accepts a null lock and empty marker/hint arrays", () => {
    expect(
      validateWorkspaceInstance({
        ...validInstance(),
        lock: null,
        driftMarkers: [],
        recoveryHints: [],
        lastVerifiedAt: undefined,
        lastVerifiedHead: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    expect(validateWorkspaceInstance(7)).toEqual({
      ok: false,
      reasons: ["instance must be an object"],
    });
  });

  it("rejects missing required strings and bad enums", () => {
    const result = validateWorkspaceInstance({
      ...validInstance(),
      schemaVersion: "9",
      workspaceId: "",
      lifecycleState: "running",
      health: "ok",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "schemaVersion invalid",
          "workspaceId must be a non-empty string",
          "lifecycleState invalid",
          "health invalid",
        ]),
      );
    }
  });

  it("rejects a malformed lock", () => {
    const result = validateWorkspaceInstance({
      ...validInstance(),
      lock: { lockId: "", owner: 1, reason: "bad", acquiredAt: "", expiresAt: 9 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "lock.lockId must be a non-empty string",
          "lock.owner must be a non-empty string",
          "lock.reason invalid",
          "lock.acquiredAt must be a non-empty string",
          "lock.expiresAt must be a non-empty string when present",
        ]),
      );
    }
  });

  it("rejects a non-object lock that is not null", () => {
    const result = validateWorkspaceInstance({ ...validInstance(), lock: "lock-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("lock must be an object or null");
  });

  it("rejects bad optional timestamps", () => {
    const result = validateWorkspaceInstance({
      ...validInstance(),
      lastVerifiedAt: 1,
      lastVerifiedHead: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "lastVerifiedAt must be a non-empty string when present",
          "lastVerifiedHead must be a non-empty string when present",
        ]),
      );
    }
  });

  it("rejects bad driftMarkers and recoveryHints", () => {
    const result = validateWorkspaceInstance({
      ...validInstance(),
      driftMarkers: ["nope"],
      recoveryHints: [
        { marker: "bad", strategy: "bad", operatorActionRequired: "yes" },
        "not-an-object",
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "driftMarkers contains an invalid marker",
          "recoveryHints[0].marker invalid",
          "recoveryHints[0].strategy invalid",
          "recoveryHints[0].operatorActionRequired must be a boolean",
          "recoveryHints[1] must be an object",
        ]),
      );
    }
  });

  it("rejects non-array driftMarkers and recoveryHints", () => {
    const result = validateWorkspaceInstance({
      ...validInstance(),
      driftMarkers: "x",
      recoveryHints: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining(["driftMarkers must be an array", "recoveryHints must be an array"]),
      );
    }
  });
});

describe("validateWorkspaceBinding", () => {
  it("accepts a canonical binding", () => {
    expect(validateWorkspaceBinding(validBinding())).toEqual({ ok: true });
  });

  it("rejects an unknown content-bearing key (content-free, SC3)", () => {
    const result = validateWorkspaceBinding({ ...validBinding(), secretPayload: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("unknown key not allowed (content-free): secretPayload");
    }
  });

  it("rejects a non-object", () => {
    expect(validateWorkspaceBinding(null)).toEqual({
      ok: false,
      reasons: ["binding must be an object"],
    });
  });

  it("rejects gitDeliveryRoot / editorProjectRoot that diverge from activeRoot", () => {
    const result = validateWorkspaceBinding({
      ...validBinding(),
      gitDeliveryRoot: "/other",
      editorProjectRoot: "/another",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "gitDeliveryRoot must equal activeRoot",
          "editorProjectRoot must equal activeRoot",
        ]),
      );
    }
  });

  it("rejects missing strings, bad enums, and skips the equality check when activeRoot is invalid", () => {
    const result = validateWorkspaceBinding({
      ...validBinding(),
      activeRoot: "",
      boundSurfaces: ["nope"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "activeRoot must be a non-empty string",
          "boundSurfaces contains an invalid surface",
        ]),
      );
      // equality check is skipped because activeRoot is not a usable string
      expect(result.reasons).not.toContain("gitDeliveryRoot must equal activeRoot");
    }
  });

  it("rejects non-array boundSurfaces", () => {
    const result = validateWorkspaceBinding({ ...validBinding(), boundSurfaces: "chat" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("boundSurfaces must be an array");
  });

  it("rejects an invalid schemaVersion", () => {
    const result = validateWorkspaceBinding({ ...validBinding(), schemaVersion: "9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("schemaVersion invalid");
  });
});

describe("validateWorkspaceActivation", () => {
  it("accepts a canonical activation", () => {
    expect(validateWorkspaceActivation(validActivation())).toEqual({ ok: true });
  });

  it("rejects an unknown content-bearing key (content-free, SC3)", () => {
    const result = validateWorkspaceActivation({ ...validActivation(), rawProviderResponse: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(
        "unknown key not allowed (content-free): rawProviderResponse",
      );
    }
  });

  it("accepts activation without expectedLifecycleState", () => {
    expect(
      validateWorkspaceActivation({ ...validActivation(), expectedLifecycleState: undefined }),
    ).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    expect(validateWorkspaceActivation(7)).toEqual({
      ok: false,
      reasons: ["activation must be an object"],
    });
  });

  it("rejects missing strings, bad acquireLock, and bad expectedLifecycleState", () => {
    const result = validateWorkspaceActivation({
      schemaVersion: "9",
      workspaceId: "",
      taskId: "",
      requestedBy: "",
      acquireLock: "yes",
      expectedLifecycleState: "running",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          "schemaVersion invalid",
          "workspaceId must be a non-empty string",
          "taskId must be a non-empty string",
          "requestedBy must be a non-empty string",
          "acquireLock must be a boolean",
          "expectedLifecycleState invalid",
        ]),
      );
    }
  });
});

describe("operation authority (AC3)", () => {
  it("classifies all 19 operations", () => {
    expect(TASK_WORKSPACE_OPERATIONS).toHaveLength(19);
  });

  it("read-only ops are exactly the 5 documented ones", () => {
    const readOnly = TASK_WORKSPACE_OPERATIONS.filter(
      (operation) => operation.authority === "read-only",
    ).map((operation) => operation.name);
    expect(readOnly.sort()).toEqual(
      ["discover", "get-instance", "get-health", "resolve-binding", "append-event"].sort(),
    );
  });

  it("read-only ops never require a lock or approval", () => {
    for (const operation of TASK_WORKSPACE_OPERATIONS) {
      if (operation.authority === "read-only") {
        expect(operation.requiresLock).toBe(false);
        expect(operation.requiresOperatorApproval).toBe(false);
      }
    }
  });

  it("exactly repair, request-cleanup, complete-cleanup require operator approval", () => {
    const approval = TASK_WORKSPACE_OPERATIONS.filter(
      (operation) => operation.requiresOperatorApproval,
    ).map((operation) => operation.name);
    expect(approval.sort()).toEqual(["repair", "request-cleanup", "complete-cleanup"].sort());
  });

  it("lock-requiring ops are the documented set", () => {
    const locked = TASK_WORKSPACE_OPERATIONS.filter((operation) => operation.requiresLock).map(
      (operation) => operation.name,
    );
    expect(locked.sort()).toEqual(
      ["provision", "activate", "resume", "repair", "complete-cleanup"].sort(),
    );
  });

  it("helpers resolve operations and classify authority", () => {
    expect(taskWorkspaceOperation("provision")?.authority).toBe("mutating-server-action");
    expect(taskWorkspaceOperation("not-an-op" as never)).toBeUndefined();
    expect(isReadOnlyTaskWorkspaceOperation("discover")).toBe(true);
    expect(isReadOnlyTaskWorkspaceOperation("provision")).toBe(false);
    expect(isMutatingTaskWorkspaceOperation("provision")).toBe(true);
    expect(isMutatingTaskWorkspaceOperation("discover")).toBe(false);
    expect(isReadOnlyTaskWorkspaceOperation("not-an-op" as never)).toBe(false);
    expect(isMutatingTaskWorkspaceOperation("not-an-op" as never)).toBe(false);
  });

  it("lock lifecycle ops are mutating-server-actions, not read-only", () => {
    // acquire-lock / release-lock mutate lock ownership, so they must be mutating-server-actions
    // even though they do not themselves require a pre-held lock. Pins the classification so a
    // mutation reclassifying them as read-only is caught.
    for (const name of ["acquire-lock", "release-lock"] as const) {
      expect(isMutatingTaskWorkspaceOperation(name)).toBe(true);
      expect(isReadOnlyTaskWorkspaceOperation(name)).toBe(false);
    }
  });
});

describe("delegated subsystems (AC4)", () => {
  it("declares exactly the four delegated concerns", () => {
    expect(TASK_WORKSPACE_DELEGATED_SUBSYSTEMS.map((entry) => entry.concern).sort()).toEqual(
      [
        "git-mutation",
        "editor-runtime-context",
        "terminal-mutation",
        "workspace-discovery-and-containment",
      ].sort(),
    );
  });

  it("predicate is true for delegated concerns and false otherwise", () => {
    expect(isDelegatedTaskWorkspaceConcern("git-mutation")).toBe(true);
    expect(isDelegatedTaskWorkspaceConcern("editor-runtime-context")).toBe(true);
    expect(isDelegatedTaskWorkspaceConcern("provision")).toBe(false);
    expect(isDelegatedTaskWorkspaceConcern(42)).toBe(false);
  });

  it("resolves the owner of each delegated concern", () => {
    expect(taskWorkspaceDelegatedOwner("git-mutation")).toBe("git-delivery (#470)");
    expect(taskWorkspaceDelegatedOwner("workspace-discovery-and-containment")).toBe(
      "@oscharko-dev/keiko-workspace",
    );
    expect(taskWorkspaceDelegatedOwner("not-a-concern" as never)).toBeUndefined();
  });

  it("none of the delegated concerns are exposed as operations", () => {
    const opNames: readonly string[] = TASK_WORKSPACE_OPERATIONS.map((operation) => operation.name);
    for (const entry of TASK_WORKSPACE_DELEGATED_SUBSYSTEMS) {
      expect(opNames).not.toContain(entry.concern);
    }
  });
});
