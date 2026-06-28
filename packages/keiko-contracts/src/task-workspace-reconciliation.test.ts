// Pure-contract coverage for the #447 reconciliation + repair semantics (Issue #447, Epic #443).
// Every reconciliation decision is a pure function over content-free facts, so this proves the
// classification precedence, the marker→recovery-hint map, the status/health/recovery-flag derivations,
// repair applicability, the active-restoration decision (including the ambiguity stop-condition), and
// the content-free closed-allowlist validators — all without IO.

import { describe, expect, it } from "vitest";
import {
  WORKSPACE_RECONCILIATION_STATUSES,
  WORKSPACE_ACTIVE_RESTORATION_KINDS,
  isWorkspaceReconciliationStatus,
  isWorkspaceActiveRestorationKind,
  classifyWorkspaceReconciliation,
  planWorkspaceRecoveryHints,
  reconciliationHealth,
  reconciliationRequiresRecoveryFlag,
  reconciliationStatusFromInstance,
  isAutomaticWorkspaceRepairStrategy,
  isWorkspaceRepairStrategyApplicable,
  workspaceEntryRepairable,
  workspaceEntryOperatorActionRequired,
  deriveReconciliationEntry,
  resolveActiveRestoration,
  validateWorkspaceReconciliationEntry,
  validateWorkspaceActiveRestoration,
  validateWorkspaceReconciliationReport,
} from "./task-workspace.js";
import type {
  TaskWorkspaceDriftMarker,
  WorkspaceReconciliationEntry,
  WorkspaceReconciliationFacts,
  WorkspaceRecoveryHint,
} from "./task-workspace.js";

function healthyFacts(
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

function markers(facts: WorkspaceReconciliationFacts): readonly TaskWorkspaceDriftMarker[] {
  return classifyWorkspaceReconciliation(facts).driftMarkers;
}

function entry(overrides: Partial<WorkspaceReconciliationEntry>): WorkspaceReconciliationEntry {
  return {
    schemaVersion: "1",
    workspaceId: "ws_a",
    taskId: "t",
    status: "healthy",
    lifecycleState: "active",
    health: "healthy",
    driftMarkers: [],
    recoveryHints: [],
    repairable: false,
    operatorActionRequired: false,
    ...overrides,
  };
}

describe("classifyWorkspaceReconciliation precedence", () => {
  it("classifies a fully-consistent active workspace as healthy", () => {
    const outcome = classifyWorkspaceReconciliation(healthyFacts());
    expect(outcome.status).toBe("healthy");
    expect(outcome.driftMarkers).toEqual([]);
    expect(outcome.recoveryHints).toEqual([]);
  });

  it("unmanaged-path wins over everything, even a terminal lifecycle", () => {
    const outcome = classifyWorkspaceReconciliation(
      healthyFacts({ pathContained: false, lifecycleState: "merged", worktreeDirExists: false }),
    );
    expect(outcome.status).toBe("unmanaged-path");
    expect(outcome.driftMarkers).toEqual(["path-escape"]);
  });

  it("a live foreign lock defers (locked) before any disk classification", () => {
    const outcome = classifyWorkspaceReconciliation(
      healthyFacts({ lockedByOtherActor: true, worktreeDirExists: false }),
    );
    expect(outcome.status).toBe("locked");
    expect(outcome.driftMarkers).toEqual([]);
  });

  it("treats terminal lifecycles as settled even when the worktree is gone", () => {
    for (const lifecycleState of ["merged", "archived", "abandoned", "cleanup-pending"] as const) {
      const outcome = classifyWorkspaceReconciliation(
        healthyFacts({ lifecycleState, worktreeDirExists: false }),
      );
      expect(outcome.status).toBe("healthy");
    }
  });

  it("classifies a never-completed provisioning/failed workspace as partially-created", () => {
    expect(
      classifyWorkspaceReconciliation(
        healthyFacts({ lifecycleState: "provisioning", worktreeDirExists: false }),
      ),
    ).toMatchObject({ status: "partially-created", driftMarkers: ["worktree-missing"] });
    expect(
      classifyWorkspaceReconciliation(
        healthyFacts({ lifecycleState: "failed", gitPointerPresent: false }),
      ),
    ).toMatchObject({ status: "partially-created", driftMarkers: ["pointer-stale"] });
    expect(markers(healthyFacts({ lifecycleState: "provisioning" }))).toEqual([]);
  });

  it("classifies an operational workspace whose worktree vanished as missing", () => {
    expect(markers(healthyFacts({ worktreeDirExists: false }))).toEqual(["worktree-missing"]);
    expect(classifyWorkspaceReconciliation(healthyFacts({ worktreeDirExists: false })).status).toBe(
      "missing",
    );
  });

  it("classifies a missing/malformed or moved git pointer as stale-pointer", () => {
    expect(markers(healthyFacts({ gitPointerPresent: false }))).toEqual(["pointer-stale"]);
    expect(markers(healthyFacts({ gitdirIdentityMatches: false }))).toEqual(["gitdir-mismatch"]);
    expect(classifyWorkspaceReconciliation(healthyFacts({ gitPointerPresent: false })).status).toBe(
      "stale-pointer",
    );
  });

  it("classifies branch/head/dirty drift as drifted with the matching marker", () => {
    expect(markers(healthyFacts({ taskBranchPresent: false }))).toEqual(["branch-deleted"]);
    expect(markers(healthyFacts({ headMatches: false }))).toEqual(["head-moved"]);
    expect(markers(healthyFacts({ uncommittedChanges: true }))).toEqual(["uncommitted-changes"]);
  });

  it("carries a lingering recovery-required lifecycle when disk is healthy", () => {
    expect(
      classifyWorkspaceReconciliation(healthyFacts({ lifecycleState: "recovery-required" })).status,
    ).toBe("recovery-required");
  });

  it("surfaces a stale lock on an otherwise-healthy workspace as drifted", () => {
    const outcome = classifyWorkspaceReconciliation(
      healthyFacts({ lockPresent: true, lockLive: false }),
    );
    expect(outcome.status).toBe("drifted");
    expect(outcome.driftMarkers).toEqual(["lock-stale"]);
  });

  it("appends a stale-lock marker to a disk drift marker without changing the primary status", () => {
    const outcome = classifyWorkspaceReconciliation(
      healthyFacts({ worktreeDirExists: false, lockPresent: true, lockLive: false }),
    );
    expect(outcome.status).toBe("missing");
    expect(outcome.driftMarkers).toEqual(["worktree-missing", "lock-stale"]);
  });
});

describe("planWorkspaceRecoveryHints", () => {
  const expected: Readonly<Record<TaskWorkspaceDriftMarker, WorkspaceRecoveryHint>> = {
    "worktree-missing": {
      marker: "worktree-missing",
      strategy: "recreate-worktree",
      operatorActionRequired: false,
    },
    "gitdir-mismatch": {
      marker: "gitdir-mismatch",
      strategy: "reconcile-pointer",
      operatorActionRequired: false,
    },
    "pointer-stale": {
      marker: "pointer-stale",
      strategy: "operator-repair",
      operatorActionRequired: true,
    },
    "head-moved": {
      marker: "head-moved",
      strategy: "operator-repair",
      operatorActionRequired: true,
    },
    "branch-deleted": {
      marker: "branch-deleted",
      strategy: "reattach-branch",
      operatorActionRequired: true,
    },
    "uncommitted-changes": {
      marker: "uncommitted-changes",
      strategy: "commit-or-stash-required",
      operatorActionRequired: true,
    },
    "lock-stale": {
      marker: "lock-stale",
      strategy: "release-stale-lock",
      operatorActionRequired: false,
    },
    "path-escape": {
      marker: "path-escape",
      strategy: "operator-repair",
      operatorActionRequired: true,
    },
  };

  it("maps each drift marker to its canonical recovery hint", () => {
    for (const marker of Object.keys(expected) as TaskWorkspaceDriftMarker[]) {
      expect(planWorkspaceRecoveryHints([marker])).toEqual([expected[marker]]);
    }
  });

  it("de-duplicates markers and preserves order", () => {
    expect(
      planWorkspaceRecoveryHints(["worktree-missing", "worktree-missing", "lock-stale"]),
    ).toEqual([expected["worktree-missing"], expected["lock-stale"]]);
  });

  it("ignores invalid markers", () => {
    expect(planWorkspaceRecoveryHints(["bogus" as TaskWorkspaceDriftMarker])).toEqual([]);
  });
});

describe("status/health/recovery-flag derivations", () => {
  it("maps each status to its persisted health", () => {
    expect(reconciliationHealth("healthy")).toBe("healthy");
    expect(reconciliationHealth("missing")).toBe("missing");
    expect(reconciliationHealth("drifted")).toBe("drifted");
    expect(reconciliationHealth("stale-pointer")).toBe("drifted");
    expect(reconciliationHealth("locked")).toBe("locked-out");
    expect(reconciliationHealth("partially-created")).toBe("degraded");
    expect(reconciliationHealth("unmanaged-path")).toBe("degraded");
    expect(reconciliationHealth("recovery-required")).toBe("degraded");
  });

  it("flags only operational workspaces whose worktree is gone or structurally unusable", () => {
    expect(reconciliationRequiresRecoveryFlag("missing", "active")).toBe(true);
    expect(reconciliationRequiresRecoveryFlag("stale-pointer", "handoff-ready")).toBe(true);
    expect(reconciliationRequiresRecoveryFlag("unmanaged-path", "active")).toBe(true);
    // a usable-but-diverged worktree is surfaced, not forced out of its lifecycle
    expect(reconciliationRequiresRecoveryFlag("drifted", "paused")).toBe(false);
    expect(reconciliationRequiresRecoveryFlag("healthy", "active")).toBe(false);
    expect(reconciliationRequiresRecoveryFlag("locked", "active")).toBe(false);
    expect(reconciliationRequiresRecoveryFlag("missing", "provisioning")).toBe(false);
    expect(reconciliationRequiresRecoveryFlag("missing", "recovery-required")).toBe(false);
  });

  it("reconstructs the status from persisted content-free fields", () => {
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "active",
        health: "degraded",
        driftMarkers: ["path-escape"],
      }),
    ).toBe("unmanaged-path");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "active",
        health: "locked-out",
        driftMarkers: [],
      }),
    ).toBe("locked");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "merged",
        health: "healthy",
        driftMarkers: [],
      }),
    ).toBe("healthy");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "failed",
        health: "degraded",
        driftMarkers: [],
      }),
    ).toBe("partially-created");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "recovery-required",
        health: "missing",
        driftMarkers: ["worktree-missing"],
      }),
    ).toBe("missing");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "recovery-required",
        health: "drifted",
        driftMarkers: ["gitdir-mismatch"],
      }),
    ).toBe("stale-pointer");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "active",
        health: "drifted",
        driftMarkers: ["lock-stale"],
      }),
    ).toBe("drifted");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "recovery-required",
        health: "degraded",
        driftMarkers: [],
      }),
    ).toBe("recovery-required");
    expect(
      reconciliationStatusFromInstance({
        lifecycleState: "active",
        health: "healthy",
        driftMarkers: [],
      }),
    ).toBe("healthy");
  });
});

describe("repair applicability", () => {
  it("treats only reversible strategies as automatic", () => {
    expect(isAutomaticWorkspaceRepairStrategy("recreate-worktree")).toBe(true);
    expect(isAutomaticWorkspaceRepairStrategy("reconcile-pointer")).toBe(true);
    expect(isAutomaticWorkspaceRepairStrategy("release-stale-lock")).toBe(true);
    expect(isAutomaticWorkspaceRepairStrategy("reattach-branch")).toBe(false);
    expect(isAutomaticWorkspaceRepairStrategy("operator-repair")).toBe(false);
    expect(isAutomaticWorkspaceRepairStrategy("commit-or-stash-required")).toBe(false);
    expect(isAutomaticWorkspaceRepairStrategy("abandon-and-cleanup")).toBe(false);
  });

  it("an automatic strategy is applicable only when a non-operator hint recommends it", () => {
    expect(
      isWorkspaceRepairStrategyApplicable({
        status: "missing",
        recoveryHints: planWorkspaceRecoveryHints(["worktree-missing"]),
        strategy: "recreate-worktree",
      }),
    ).toBe(true);
    expect(
      isWorkspaceRepairStrategyApplicable({
        status: "missing",
        recoveryHints: [],
        strategy: "recreate-worktree",
      }),
    ).toBe(false);
    expect(
      isWorkspaceRepairStrategyApplicable({
        status: "drifted",
        recoveryHints: planWorkspaceRecoveryHints(["branch-deleted"]),
        strategy: "reattach-branch",
      }),
    ).toBe(false);
  });

  it("abandon-and-cleanup is applicable to any non-healthy workspace", () => {
    expect(
      isWorkspaceRepairStrategyApplicable({
        status: "missing",
        recoveryHints: [],
        strategy: "abandon-and-cleanup",
      }),
    ).toBe(true);
    expect(
      isWorkspaceRepairStrategyApplicable({
        status: "healthy",
        recoveryHints: [],
        strategy: "abandon-and-cleanup",
      }),
    ).toBe(false);
  });
});

describe("entry derivation", () => {
  it("derives repairable + operatorActionRequired booleans", () => {
    expect(
      workspaceEntryRepairable({
        status: "partially-created",
        recoveryHints: [],
      }),
    ).toBe(true);
    expect(
      workspaceEntryRepairable({
        status: "drifted",
        recoveryHints: planWorkspaceRecoveryHints(["lock-stale"]),
      }),
    ).toBe(true);
    expect(
      workspaceEntryRepairable({
        status: "drifted",
        recoveryHints: planWorkspaceRecoveryHints(["branch-deleted"]),
      }),
    ).toBe(false);
    expect(
      workspaceEntryOperatorActionRequired(planWorkspaceRecoveryHints(["branch-deleted"])),
    ).toBe(true);
    expect(workspaceEntryOperatorActionRequired([])).toBe(false);
  });

  it("builds a content-free entry from persisted fields", () => {
    const built = deriveReconciliationEntry({
      workspaceId: "ws_a",
      taskId: "t",
      lifecycleState: "recovery-required",
      health: "missing",
      driftMarkers: ["worktree-missing"],
      recoveryHints: planWorkspaceRecoveryHints(["worktree-missing"]),
      lastVerifiedAt: "2026-06-26T00:00:00.000Z",
    });
    expect(built.status).toBe("missing");
    expect(built.repairable).toBe(true);
    expect(built.operatorActionRequired).toBe(false);
    expect(validateWorkspaceReconciliationEntry(built).ok).toBe(true);
  });
});

describe("resolveActiveRestoration", () => {
  it("returns none when there is no pointer and at most one active instance", () => {
    expect(resolveActiveRestoration(undefined, [])).toEqual({ kind: "none" });
    expect(
      resolveActiveRestoration(undefined, [
        entry({ workspaceId: "ws_a", lifecycleState: "active" }),
      ]),
    ).toEqual({ kind: "none" });
  });

  it("returns ambiguous (sorted) when no pointer but multiple active instances", () => {
    const result = resolveActiveRestoration(undefined, [
      entry({ workspaceId: "ws_b", lifecycleState: "active" }),
      entry({ workspaceId: "ws_a", lifecycleState: "active" }),
    ]);
    expect(result.kind).toBe("ambiguous");
    expect(result.ambiguousWorkspaceIds).toEqual(["ws_a", "ws_b"]);
  });

  it("restores a healthy pointer target", () => {
    expect(
      resolveActiveRestoration("ws_a", [entry({ workspaceId: "ws_a", status: "healthy" })]),
    ).toEqual({ kind: "restored", workspaceId: "ws_a" });
  });

  it("flags recovery-required when the pointer target is unhealthy", () => {
    expect(
      resolveActiveRestoration("ws_a", [
        entry({ workspaceId: "ws_a", status: "missing", lifecycleState: "recovery-required" }),
      ]),
    ).toEqual({ kind: "recovery-required", workspaceId: "ws_a" });
  });

  it("clears a dangling pointer that references a deleted instance", () => {
    expect(resolveActiveRestoration("ws_gone", [entry({ workspaceId: "ws_a" })])).toEqual({
      kind: "cleared-dangling",
      workspaceId: "ws_gone",
    });
  });
});

describe("content-free validators", () => {
  it("rejects an entry carrying an unknown (smuggled) key", () => {
    const result = validateWorkspaceReconciliationEntry({
      ...entry({}),
      sourceDiff: "secret",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.some((r) => r.includes("unknown key not allowed"))).toBe(true);
    }
  });

  it("rejects an entry with an invalid status or missing id", () => {
    expect(validateWorkspaceReconciliationEntry({ ...entry({}), status: "bogus" }).ok).toBe(false);
    expect(validateWorkspaceReconciliationEntry({ ...entry({}), workspaceId: "" }).ok).toBe(false);
  });

  it("validates / rejects active-restoration shapes", () => {
    expect(validateWorkspaceActiveRestoration({ kind: "none" }).ok).toBe(true);
    expect(
      validateWorkspaceActiveRestoration({ kind: "ambiguous", ambiguousWorkspaceIds: ["ws_a"] }).ok,
    ).toBe(true);
    expect(validateWorkspaceActiveRestoration({ kind: "bogus" }).ok).toBe(false);
    expect(
      validateWorkspaceActiveRestoration({ kind: "none", ambiguousWorkspaceIds: [1] }).ok,
    ).toBe(false);
    expect(validateWorkspaceActiveRestoration({ kind: "none", smuggled: "x" }).ok).toBe(false);
  });

  it("validates a well-formed report and rejects a malformed one", () => {
    const report = {
      schemaVersion: "1" as const,
      generatedAt: "2026-06-26T00:00:00.000Z",
      entries: [entry({})],
      activeRestoration: { kind: "none" as const },
    };
    expect(validateWorkspaceReconciliationReport(report).ok).toBe(true);
    expect(validateWorkspaceReconciliationReport({ ...report, generatedAt: "" }).ok).toBe(false);
    expect(
      validateWorkspaceReconciliationReport({ ...report, entries: [{ ...entry({}), status: "x" }] })
        .ok,
    ).toBe(false);
    expect(
      validateWorkspaceReconciliationReport({
        ...report,
        activeRestoration: { kind: "bogus" },
      }).ok,
    ).toBe(false);
  });
});

describe("enumerations", () => {
  it("exposes the 8 reconciliation statuses and guards them", () => {
    expect(WORKSPACE_RECONCILIATION_STATUSES).toHaveLength(8);
    for (const status of WORKSPACE_RECONCILIATION_STATUSES) {
      expect(isWorkspaceReconciliationStatus(status)).toBe(true);
    }
    expect(isWorkspaceReconciliationStatus("nope")).toBe(false);
  });

  it("exposes the 5 restoration kinds and guards them", () => {
    expect(WORKSPACE_ACTIVE_RESTORATION_KINDS).toHaveLength(5);
    for (const kind of WORKSPACE_ACTIVE_RESTORATION_KINDS) {
      expect(isWorkspaceActiveRestorationKind(kind)).toBe(true);
    }
    expect(isWorkspaceActiveRestorationKind("nope")).toBe(false);
  });
});
