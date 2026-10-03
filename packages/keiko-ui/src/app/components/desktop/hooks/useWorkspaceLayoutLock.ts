"use client";

import { useCallback, useRef, useState } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { WorkspaceApi } from "./useWorkspace.types";
import type { AppWindow } from "../windows/types";

interface WorkspaceLayoutLock {
  readonly layoutLocked: boolean;
  readonly isLayoutLocked: () => boolean;
  readonly toggleLayoutLock: () => void;
}

/** Session-local interaction state owned by useWorkspace, alongside its selection. */
export function useWorkspaceLayoutLock(onLock: () => void): WorkspaceLayoutLock {
  const [layoutLocked, setLayoutLocked] = useState(false);
  const lockedRef = useRef(false);
  const isLayoutLocked = useCallback((): boolean => lockedRef.current, []);
  const toggleLayoutLock = useCallback((): void => {
    const locked = !lockedRef.current;
    lockedRef.current = locked;
    if (locked) onLock();
    setLayoutLocked(locked);
    reportClientDiagnostic("[keiko] workspace layout lock changed.", {
      composerActivity: locked ? "workspace-layout-locked" : "workspace-layout-unlocked",
    });
  }, [onLock]);
  return { layoutLocked, isLayoutLocked, toggleLayoutLock };
}

const GEOMETRY_FIELDS: ReadonlySet<string> = new Set(["x", "y", "w", "h", "max", "prev"]);

function contentOnlyPatch(patch: Partial<AppWindow>): Partial<AppWindow> {
  // Filtering only removes fields from an already typed patch; content configuration and
  // content zoom remain writable even when an in-flight gesture reaches the locked API.
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !GEOMETRY_FIELDS.has(key)),
  ) as Partial<AppWindow>;
}

function whenUnlocked<Args extends unknown[]>(
  isLocked: () => boolean,
  action: (...args: Args) => void,
): (...args: Args) => void {
  return (...args): void => {
    if (!isLocked()) action(...args);
  };
}

/** Guard the owning API too: command and in-flight pointer paths share these actions. */
export function protectWorkspaceLayout(api: WorkspaceApi, isLocked: () => boolean): WorkspaceApi {
  return {
    ...api,
    activateWindow: (id): void => (isLocked() ? api.focus(id) : api.activateWindow(id)),
    replaceSelection: whenUnlocked(isLocked, api.replaceSelection),
    toggleWindowSelection: whenUnlocked(isLocked, api.toggleWindowSelection),
    maximize: whenUnlocked(isLocked, api.maximize),
    tileAll: whenUnlocked(isLocked, api.tileAll),
    splitFront: whenUnlocked(isLocked, api.splitFront),
    cascade: whenUnlocked(isLocked, api.cascade),
    setSnap: whenUnlocked(isLocked, api.setSnap),
    commitSnap: whenUnlocked(isLocked, api.commitSnap),
    update: (id, patch): void => {
      const permitted = isLocked() ? contentOnlyPatch(patch) : patch;
      if (Object.keys(permitted).length > 0) api.update(id, permitted);
    },
    moveSelectedWindowsBy: (dx, dy): { readonly dx: number; readonly dy: number } =>
      isLocked() ? { dx: 0, dy: 0 } : api.moveSelectedWindowsBy(dx, dy),
  };
}
