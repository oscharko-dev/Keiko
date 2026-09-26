"use client";

// Active task-workspace binding context (Issue #446, Epic #443, ADR-0090).
//
// This is the UI half of the single shared binding source of truth. The provider holds the active
// WorkspaceBinding (derived server-side from the active instance) plus the instance inventory and the
// in-flight/error state; every Studio surface that needs the active root reads `activeRoot` from here
// (threaded through WindowRenderContext) so a switch retargets all surfaces atomically. Mirrors the
// ChatSessionContext pattern: a required hook for the switcher and an optional hook for windows/tests
// that may render without a provider.

import { createContext, useContext, type ReactNode } from "react";
import type {
  WorkspaceBinding,
  WorkspaceInstance,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";

export interface ActiveWorkspaceApi {
  // Every persisted task workspace across repositories (the switcher's inventory — the active
  // pointer is global, so a switch may target any repository). Empty until refreshed.
  readonly instances: readonly WorkspaceInstance[];
  // The active binding, or null in unbound mode (no active task workspace).
  readonly activeBinding: WorkspaceBinding | null;
  // The active instance (identity/branch/health/lock/drift the switcher renders), or null.
  readonly activeInstance: WorkspaceInstance | null;
  // Convenience: activeBinding?.activeRoot ?? null. The single value D4 feeds into WindowRenderContext.
  readonly activeRoot: string | null;
  // True while the initial inventory/active fetch is in flight.
  readonly loading: boolean;
  // True when the LAST settled read could not list the inventory (the listing degrades to an empty
  // `instances` so a failed list never hides the active binding). A surface must not render its
  // empty state for this: "no managed task workspaces yet" is a claim about the repository, not a
  // report of a failed read. Cleared by the next settled read that succeeds.
  readonly inventoryUnavailable: boolean;
  // True while a switch/pause/resume/handoff/provision mutation is in flight (atomic-switch guard).
  readonly switching: boolean;
  // The last action error (already redacted server-side), or null.
  readonly error: string | null;
  // Re-fetch the inventory and the active binding.
  readonly refresh: () => Promise<boolean>;
  // Every mutation below resolves `false` if and ONLY IF the wire call was refused (the redacted
  // reason is then in `error`), and `true` once the server applied it — including when a newer
  // mutation or refresh superseded this one's reload and therefore owns the state commit.
  // Supersession is not a refusal: reporting it as `false` made the folder switcher announce that
  // an override clear "could not be released" that the server had in fact performed, and abort the
  // folder change (#3381 review). Mutations never reject, so a caller that must not proceed on a
  // refused mutation — clearing an override before switching folders — reads the outcome, not a
  // throw. `refresh` is NOT a mutation and keeps its narrower meaning: it resolves `true` only when
  // THIS operation settled the state, so a superseded refresh never announces success.
  // Atomic switch: activate/resume the target and bind all surfaces to it.
  readonly switchTo: (workspaceId: string) => Promise<boolean>;
  // Clear the active pointer → unbound mode.
  readonly clearActive: () => Promise<boolean>;
  readonly pause: (workspaceId: string) => Promise<boolean>;
  readonly resume: (workspaceId: string) => Promise<boolean>;
  readonly prepareHandoff: (workspaceId: string) => Promise<boolean>;
  // Apply one of the recovery strategies reconciliation recommended for a drifted workspace through
  // the operator-approval-gated #447 repair route; the operator's click IS the approval.
  readonly repair: (workspaceId: string, strategy: WorkspaceRecoveryStrategy) => Promise<boolean>;
  // Create (or idempotently resume) a managed task workspace and bind it.
  readonly provision: (input: {
    readonly root: string;
    readonly taskId: string;
    readonly baseBranch: string;
  }) => Promise<boolean>;
}

const ActiveWorkspaceContext = createContext<ActiveWorkspaceApi | null>(null);

interface ActiveWorkspaceProviderProps {
  readonly value: ActiveWorkspaceApi;
  readonly children: ReactNode;
}

export function ActiveWorkspaceProvider({
  value,
  children,
}: ActiveWorkspaceProviderProps): ReactNode {
  return (
    <ActiveWorkspaceContext.Provider value={value}>{children}</ActiveWorkspaceContext.Provider>
  );
}

export function useActiveWorkspace(): ActiveWorkspaceApi {
  const ctx = useContext(ActiveWorkspaceContext);
  if (ctx === null) {
    throw new Error("useActiveWorkspace must be used inside ActiveWorkspaceProvider");
  }
  return ctx;
}

// Optional read for windows/widgets (and tests) that may render outside the provider. Returns null
// when no provider is mounted, in which case surfaces fall back to their per-window cfg root.
export function useOptionalActiveWorkspace(): ActiveWorkspaceApi | null {
  return useContext(ActiveWorkspaceContext);
}
