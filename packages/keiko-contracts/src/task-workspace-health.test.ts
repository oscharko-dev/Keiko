// Pure-contract coverage for the #448 operational-health + governed-cleanup semantics (Issue #448,
// Epic #443). Every health classification and cleanup-safety decision is a pure function over
// content-free facts, so this proves: the 10-member classification precedence (incl. dirty / orphaned /
// archived / cleanup-ready), the single cleanup-safety gate's refusal precedence (SC1/SC2/SC4), the
// cleanup-eligible lifecycle predicate, the content-free closed-allowlist validators (instance AND
// orphan entries, with unknown-key + kind-mismatch rejection), and the derive builders — all without IO.

import { describe, expect, it } from "vitest";
import {
  WORKSPACE_HEALTH_CLASSIFICATIONS,
  WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES,
  WORKSPACE_CLEANUP_REFUSAL_REASONS,
  WORKSPACE_HEALTH_ENTRY_KINDS,
  isWorkspaceHealthClassification,
  isCleanupEligibleLifecycleState,
  isWorkspaceCleanupRefusalReason,
  isWorkspaceHealthEntryKind,
  evaluateWorkspaceCleanupSafety,
  classifyWorkspaceHealth,
  deriveWorkspaceHealthEntry,
  deriveOrphanWorktreeHealthEntry,
  validateWorkspaceHealthEntry,
  validateWorkspaceHealthReport,
} from "./task-workspace.js";
import type {
  TaskWorkspaceLifecycleState,
  WorkspaceCleanupSafetyFacts,
  WorkspaceHealthEntry,
  WorkspaceHealthSignals,
  WorkspaceReconciliationFacts,
} from "./task-workspace.js";

function healthyReconFacts(
  overrides: Partial<WorkspaceReconciliationFacts> = {},
): WorkspaceReconciliationFacts {
  return {
    lifecycleState: "active",
    pathContained: true,
    worktreeDirExists: true,
    gitPointerPresent: true,
    gitdirIdentityMatches: true,
    taskBranchPresent: true,
    headMatches: true,
    uncommittedChanges: false,
    lockPresent: false,
    lockLive: false,
    lockedByOtherActor: false,
    ...overrides,
  };
}

function signals(overrides: Partial<WorkspaceHealthSignals> = {}): WorkspaceHealthSignals {
  return {
    reconciliation: healthyReconFacts(overrides.reconciliation),
    worktreeDirty: false,
    ownershipProven: true,
    ...(overrides.worktreeDirty !== undefined ? { worktreeDirty: overrides.worktreeDirty } : {}),
    ...(overrides.ownershipProven !== undefined
      ? { ownershipProven: overrides.ownershipProven }
      : {}),
  };
}

function safetyFacts(
  overrides: Partial<WorkspaceCleanupSafetyFacts> = {},
): WorkspaceCleanupSafetyFacts {
  return {
    lifecycleState: "archived",
    hasRecord: true,
    pathContained: true,
    ownershipProven: true,
    worktreeDirty: false,
    lockLive: false,
    ...overrides,
  };
}

describe("WorkspaceHealthClassification enum", () => {
  it("has exactly the ten AC1 members and a fail-closed guard", () => {
    expect([...WORKSPACE_HEALTH_CLASSIFICATIONS]).toEqual([
      "healthy",
      "dirty",
      "drifted",
      "missing",
      "stale-pointer",
      "locked",
      "orphaned",
      "archived",
      "cleanup-ready",
      "recovery-required",
    ]);
    for (const value of WORKSPACE_HEALTH_CLASSIFICATIONS) {
      expect(isWorkspaceHealthClassification(value)).toBe(true);
    }
    for (const bad of ["", "Healthy", "__proto__", 1, null, undefined, {}]) {
      expect(isWorkspaceHealthClassification(bad)).toBe(false);
    }
  });
});

describe("isCleanupEligibleLifecycleState", () => {
  it("admits exactly the settled/disposal states", () => {
    expect([...WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES]).toEqual([
      "archived",
      "merged",
      "abandoned",
      "failed",
      "cleanup-pending",
    ]);
    for (const state of WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES) {
      expect(isCleanupEligibleLifecycleState(state)).toBe(true);
    }
    const ineligible: readonly TaskWorkspaceLifecycleState[] = [
      "provisioning",
      "active",
      "paused",
      "handoff-ready",
      "recovery-required",
    ];
    for (const state of ineligible) expect(isCleanupEligibleLifecycleState(state)).toBe(false);
  });

  it("fails closed on a non-state value", () => {
    expect(isCleanupEligibleLifecycleState("__proto__" as TaskWorkspaceLifecycleState)).toBe(false);
  });
});

describe("evaluateWorkspaceCleanupSafety — refusal precedence (SC1/SC2/SC4)", () => {
  it("refuses ownership-unproven first (most fundamental)", () => {
    expect(
      evaluateWorkspaceCleanupSafety(
        safetyFacts({
          ownershipProven: false,
          pathContained: false,
          lockLive: true,
          worktreeDirty: true,
        }),
      ),
    ).toEqual({ allowed: false, refusalReason: "ownership-unproven" });
  });

  it("refuses path-escape before lock/dirty", () => {
    expect(
      evaluateWorkspaceCleanupSafety(
        safetyFacts({ pathContained: false, lockLive: true, worktreeDirty: true }),
      ),
    ).toEqual({ allowed: false, refusalReason: "path-escape" });
  });

  it("refuses a live lock before dirty (cleanup is destructive — any live lock blocks)", () => {
    expect(
      evaluateWorkspaceCleanupSafety(safetyFacts({ lockLive: true, worktreeDirty: true })),
    ).toEqual({ allowed: false, refusalReason: "lock-live" });
  });

  it("refuses a dirty worktree (SC4)", () => {
    expect(evaluateWorkspaceCleanupSafety(safetyFacts({ worktreeDirty: true }))).toEqual({
      allowed: false,
      refusalReason: "worktree-dirty",
    });
  });

  it("refuses an ineligible lifecycle state for a persisted record (SC4)", () => {
    for (const state of ["active", "paused", "handoff-ready", "recovery-required"] as const) {
      expect(evaluateWorkspaceCleanupSafety(safetyFacts({ lifecycleState: state }))).toEqual({
        allowed: false,
        refusalReason: "not-eligible-state",
      });
    }
  });

  it("allows a settled, owned, contained, clean, unlocked instance", () => {
    for (const state of WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES) {
      expect(evaluateWorkspaceCleanupSafety(safetyFacts({ lifecycleState: state }))).toEqual({
        allowed: true,
      });
    }
  });

  it("allows an orphan (no record) regardless of lifecycle once owned/contained/clean/unlocked", () => {
    expect(
      evaluateWorkspaceCleanupSafety(safetyFacts({ hasRecord: false, lifecycleState: "active" })),
    ).toEqual({ allowed: true });
  });

  it("still blocks an orphan that is dirty / uncontained / unowned / locked", () => {
    expect(
      evaluateWorkspaceCleanupSafety(safetyFacts({ hasRecord: false, worktreeDirty: true }))
        .allowed,
    ).toBe(false);
    expect(
      evaluateWorkspaceCleanupSafety(safetyFacts({ hasRecord: false, pathContained: false }))
        .refusalReason,
    ).toBe("path-escape");
  });

  it("exposes a typed refusal-reason guard", () => {
    for (const reason of WORKSPACE_CLEANUP_REFUSAL_REASONS) {
      expect(isWorkspaceCleanupRefusalReason(reason)).toBe(true);
    }
    expect(isWorkspaceCleanupRefusalReason("nope")).toBe(false);
  });
});

describe("classifyWorkspaceHealth — operational classification", () => {
  it("classifies a clean active workspace healthy and not cleanup-eligible", () => {
    const evaluation = classifyWorkspaceHealth(signals());
    expect(evaluation.classification).toBe("healthy");
    expect(evaluation.cleanupEligible).toBe(false);
  });

  it("classifies a structurally healthy but dirty workspace as dirty", () => {
    const evaluation = classifyWorkspaceHealth(signals({ worktreeDirty: true }));
    expect(evaluation.classification).toBe("dirty");
    expect(evaluation.cleanupEligible).toBe(false);
  });

  it("classifies a missing worktree as missing", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({ reconciliation: healthyReconFacts({ worktreeDirExists: false }) }),
    );
    expect(evaluation.classification).toBe("missing");
  });

  it("classifies a stale/missing git pointer as stale-pointer", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({ reconciliation: healthyReconFacts({ gitPointerPresent: false }) }),
    );
    expect(evaluation.classification).toBe("stale-pointer");
  });

  it("classifies a moved HEAD as drifted", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({ reconciliation: healthyReconFacts({ headMatches: false }) }),
    );
    expect(evaluation.classification).toBe("drifted");
  });

  it("classifies a live foreign lock as locked", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({
        reconciliation: healthyReconFacts({
          lockPresent: true,
          lockLive: true,
          lockedByOtherActor: true,
        }),
      }),
    );
    expect(evaluation.classification).toBe("locked");
  });

  it("classifies a path-escape and partial-creation as recovery-required (never auto-cleanable)", () => {
    expect(
      classifyWorkspaceHealth(
        signals({ reconciliation: healthyReconFacts({ pathContained: false }) }),
      ).classification,
    ).toBe("recovery-required");
    expect(
      classifyWorkspaceHealth(
        signals({ reconciliation: healthyReconFacts({ lifecycleState: "provisioning" }) }),
      ).classification,
    ).toBe("recovery-required");
    expect(
      classifyWorkspaceHealth(
        signals({ reconciliation: healthyReconFacts({ lifecycleState: "recovery-required" }) }),
      ).classification,
    ).toBe("recovery-required");
  });

  it("classifies a settled archived/merged instance as archived (retained), cleanup-eligible", () => {
    for (const state of ["archived", "merged"] as const) {
      const evaluation = classifyWorkspaceHealth(
        signals({ reconciliation: healthyReconFacts({ lifecycleState: state }) }),
      );
      expect(evaluation.classification).toBe("archived");
      expect(evaluation.cleanupEligible).toBe(true);
    }
  });

  it("classifies a clean abandoned/cleanup-pending instance as cleanup-ready", () => {
    for (const state of ["abandoned", "cleanup-pending"] as const) {
      const evaluation = classifyWorkspaceHealth(
        signals({ reconciliation: healthyReconFacts({ lifecycleState: state }) }),
      );
      expect(evaluation.classification).toBe("cleanup-ready");
      expect(evaluation.cleanupEligible).toBe(true);
    }
  });

  it("keeps a failed instance recovery-required (operator must decide) yet still cleanup-eligible", () => {
    // `failed` is a partial-creation reconciliation state, so its health stays recovery-required (it may
    // be repairable). It is still cleanup-eligible — the operator can choose cleanup over repair.
    const evaluation = classifyWorkspaceHealth(
      signals({ reconciliation: healthyReconFacts({ lifecycleState: "failed" }) }),
    );
    expect(evaluation.classification).toBe("recovery-required");
    expect(evaluation.cleanupEligible).toBe(true);
  });

  it("downgrades a dirty cleanup-pending instance to dirty (cleanup blocked until clean, SC4)", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({
        reconciliation: healthyReconFacts({ lifecycleState: "cleanup-pending" }),
        worktreeDirty: true,
      }),
    );
    expect(evaluation.classification).toBe("dirty");
    expect(evaluation.cleanupEligible).toBe(false);
  });

  it("marks an archived instance NOT cleanup-eligible when ownership is unproven", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({
        reconciliation: healthyReconFacts({ lifecycleState: "archived" }),
        ownershipProven: false,
      }),
    );
    expect(evaluation.cleanupEligible).toBe(false);
    expect(evaluation.classification).toBe("archived");
  });
});

describe("health entry builders + validators (content-free closed allowlist)", () => {
  it("derives a valid instance entry from the evaluation", () => {
    const evaluation = classifyWorkspaceHealth(
      signals({ reconciliation: healthyReconFacts({ lifecycleState: "archived" }) }),
    );
    const entry = deriveWorkspaceHealthEntry({
      workspaceId: "ws_a",
      taskId: "t-1",
      lifecycleState: "archived",
      health: "healthy",
      evaluation,
      lastVerifiedAt: "2026-06-26T00:00:00.000Z",
    });
    expect(entry.kind).toBe("instance");
    expect(entry.classification).toBe("archived");
    expect(entry.cleanupEligible).toBe(true);
    expect(validateWorkspaceHealthEntry(entry).ok).toBe(true);
  });

  it("derives a valid orphan entry that always classifies orphaned", () => {
    const entry = deriveOrphanWorktreeHealthEntry({ orphanId: "orph_abc", cleanupEligible: true });
    expect(entry.kind).toBe("orphan-worktree");
    expect(entry.classification).toBe("orphaned");
    expect(validateWorkspaceHealthEntry(entry).ok).toBe(true);
  });

  it("rejects an unknown key (content-free invariant, SC3)", () => {
    const entry = deriveOrphanWorktreeHealthEntry({ orphanId: "orph_abc", cleanupEligible: true });
    const smuggled = { ...entry, secret: "s3cr3t" };
    const result = validateWorkspaceHealthEntry(smuggled);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.includes("unknown key not allowed"))).toBe(true);
    }
  });

  it("rejects an instance entry carrying an orphanId, and an orphan entry carrying instance fields", () => {
    const instance: WorkspaceHealthEntry = {
      schemaVersion: "1",
      kind: "instance",
      classification: "healthy",
      driftMarkers: [],
      recoveryHints: [],
      cleanupEligible: false,
      workspaceId: "ws_a",
      taskId: "t",
      lifecycleState: "active",
      health: "healthy",
      orphanId: "orph_x",
    };
    expect(validateWorkspaceHealthEntry(instance).ok).toBe(false);

    const orphan: WorkspaceHealthEntry = {
      schemaVersion: "1",
      kind: "orphan-worktree",
      classification: "orphaned",
      driftMarkers: [],
      recoveryHints: [],
      cleanupEligible: true,
      orphanId: "orph_y",
      workspaceId: "ws_b",
    };
    expect(validateWorkspaceHealthEntry(orphan).ok).toBe(false);
  });

  it("rejects an orphan entry that does not classify as orphaned", () => {
    const orphan = {
      schemaVersion: "1",
      kind: "orphan-worktree",
      classification: "healthy",
      driftMarkers: [],
      recoveryHints: [],
      cleanupEligible: true,
      orphanId: "orph_z",
    };
    const result = validateWorkspaceHealthEntry(orphan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.includes("must classify as orphaned"))).toBe(true);
    }
  });

  it("rejects non-objects and an invalid kind", () => {
    expect(validateWorkspaceHealthEntry(null).ok).toBe(false);
    expect(validateWorkspaceHealthEntry({ kind: "nope" }).ok).toBe(false);
    for (const kind of WORKSPACE_HEALTH_ENTRY_KINDS)
      expect(isWorkspaceHealthEntryKind(kind)).toBe(true);
    expect(isWorkspaceHealthEntryKind("nope")).toBe(false);
  });

  it("validates a full report and rejects one with a bad entry", () => {
    const evaluation = classifyWorkspaceHealth(signals());
    const good = {
      schemaVersion: "1" as const,
      generatedAt: "2026-06-26T00:00:00.000Z",
      entries: [
        deriveWorkspaceHealthEntry({
          workspaceId: "ws_a",
          taskId: "t",
          lifecycleState: "active",
          health: "healthy",
          evaluation,
        }),
        deriveOrphanWorktreeHealthEntry({ orphanId: "orph_a", cleanupEligible: true }),
      ],
    };
    expect(validateWorkspaceHealthReport(good).ok).toBe(true);

    expect(
      validateWorkspaceHealthReport({ schemaVersion: "1", generatedAt: "", entries: [] }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceHealthReport({
        schemaVersion: "1",
        generatedAt: "2026-06-26T00:00:00.000Z",
        entries: [{ kind: "instance" }],
      }).ok,
    ).toBe(false);
    expect(validateWorkspaceHealthReport(null).ok).toBe(false);
    expect(validateWorkspaceHealthReport({ schemaVersion: "2" }).ok).toBe(false);
  });
});
