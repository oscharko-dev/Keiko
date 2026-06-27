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
import type { WorkspaceBinding, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";

export interface ActiveWorkspaceApi {
  // The repository's persisted task workspaces (switcher inventory). Empty until refreshed.
  readonly instances: readonly WorkspaceInstance[];
  // The active binding, or null in unbound mode (no active task workspace).
  readonly activeBinding: WorkspaceBinding | null;
  // The active instance (identity/branch/health/lock/drift the switcher renders), or null.
  readonly activeInstance: WorkspaceInstance | null;
  // Convenience: activeBinding?.activeRoot ?? null. The single value D4 feeds into WindowRenderContext.
  readonly activeRoot: string | null;
  // True while the initial inventory/active fetch is in flight.
  readonly loading: boolean;
  // True while a switch/pause/resume/handoff/provision mutation is in flight (atomic-switch guard).
  readonly switching: boolean;
  // The last action error (already redacted server-side), or null.
  readonly error: string | null;
  // Re-fetch the inventory (for the given repository root, if provided) and the active binding.
  readonly refresh: (root?: string) => Promise<void>;
  // Atomic switch: activate/resume the target and bind all surfaces to it.
  readonly switchTo: (workspaceId: string) => Promise<void>;
  // Clear the active pointer → unbound mode.
  readonly clearActive: () => Promise<void>;
  readonly pause: (workspaceId: string) => Promise<void>;
  readonly resume: (workspaceId: string) => Promise<void>;
  readonly prepareHandoff: (workspaceId: string) => Promise<void>;
  // Create (or idempotently resume) a managed task workspace and bind it.
  readonly provision: (input: {
    readonly root: string;
    readonly taskId: string;
    readonly baseBranch: string;
  }) => Promise<void>;
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
