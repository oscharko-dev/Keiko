import { useCallback, useEffect, useRef, useState } from "react";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import {
  startFilesNavigationEvidence,
  type FilesNavigationRead,
} from "@/lib/files-navigation-evidence";

interface FolderTarget {
  readonly root: string;
  readonly path: string | null;
}
interface FolderHistory {
  readonly entries: readonly FolderTarget[];
  readonly index: number;
}
export interface FilesNavigation {
  readonly path: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly selectRoot: (root: string) => void;
  readonly takeRead: (path: string) => FilesNavigationRead | undefined;
  readonly visit: (path: string | null) => void;
  readonly back: () => void;
  readonly forward: () => void;
}
const HISTORY_LIMIT = 100;
interface PendingNavigation extends FilesNavigationRead {
  readonly target: FolderTarget;
}
function beginNavigation(
  target: FolderTarget,
  stage: "files directory navigation" | "files project selection",
): PendingNavigation {
  const correlationId = newClientCorrelationId();
  return { target, correlationId, settle: startFilesNavigationEvidence(stage, correlationId) };
}

function appendTarget(history: FolderHistory, target: FolderTarget): FolderHistory {
  const current = history.entries[history.index];
  if (current?.root === target.root && current.path === target.path) return history;
  const entries = [...history.entries.slice(0, history.index + 1), target].slice(-HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

function reconcileRoot(history: FolderHistory, root: string, reset: boolean): FolderHistory {
  if (reset) return { entries: [{ root, path: null }], index: 0 };
  return history.entries[history.index]?.root === root
    ? history
    : appendTarget(history, { root, path: null });
}

function currentPath(history: FolderHistory, root: string): string | null {
  const current = history.entries[history.index];
  return current?.root === root ? current.path : null;
}

function usePendingNavigation(root: string): {
  readonly begin: (
    target: FolderTarget,
    stage: "files directory navigation" | "files project selection",
  ) => void;
  readonly takeRead: (path: string) => FilesNavigationRead | undefined;
} {
  const pending = useRef<PendingNavigation | null>(null);
  const begin = useCallback(
    (
      target: FolderTarget,
      stage: "files directory navigation" | "files project selection",
    ): void => {
      pending.current?.settle(undefined, "cancelled");
      pending.current = beginNavigation(target, stage);
    },
    [],
  );
  const takeRead = useCallback(
    (path: string): FilesNavigationRead | undefined => {
      const request = pending.current;
      if (request?.target.root !== root || (request.target.path ?? "") !== path) return undefined;
      pending.current = null;
      return request;
    },
    [root],
  );
  useEffect(() => (): void => pending.current?.settle(undefined, "cancelled"), []);
  return { begin, takeRead };
}

function moveInHistory(
  history: FolderHistory,
  root: string,
  onRootChange: ((root: string) => void) | undefined,
  begin: ReturnType<typeof usePendingNavigation>["begin"],
  setHistory: (history: FolderHistory) => void,
  offset: number,
): void {
  const index = Math.max(0, Math.min(history.entries.length - 1, history.index + offset));
  const target = history.entries[index];
  if (target === undefined || index === history.index) return;
  if (target.root !== root && onRootChange === undefined) return;
  begin(target, "files directory navigation");
  setHistory({ ...history, index });
  if (target.root !== root) onRootChange?.(target.root);
}

export function useFilesNavigation(
  root: string,
  onRootChange?: (root: string) => void,
): FilesNavigation {
  const [history, setHistory] = useState<FolderHistory>({
    entries: [{ root, path: null }],
    index: 0,
  });
  const [lastRoot, setLastRoot] = useState(root);
  const { begin, takeRead } = usePendingNavigation(root);
  if (lastRoot !== root) {
    setLastRoot(root);
    setHistory((previous) =>
      reconcileRoot(previous, root, onRootChange === undefined || lastRoot.length === 0),
    );
  }
  const visit = useCallback(
    (path: string | null): void => {
      if (currentPath(history, root) === path) return;
      begin({ root, path }, "files directory navigation");
      setHistory((previous) => appendTarget(previous, { root, path }));
    },
    [begin, history, root],
  );
  const move = useCallback(
    (offset: number): void => moveInHistory(history, root, onRootChange, begin, setHistory, offset),
    [begin, history, onRootChange, root],
  );
  const selectRoot = useCallback(
    (targetRoot: string): void => {
      if (onRootChange === undefined || targetRoot === root) return;
      begin({ root: targetRoot, path: null }, "files project selection");
      onRootChange(targetRoot);
    },
    [begin, onRootChange, root],
  );
  const back = useCallback((): void => move(-1), [move]);
  const forward = useCallback((): void => move(1), [move]);
  return {
    path: currentPath(history, root),
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    selectRoot,
    takeRead,
    visit,
    back,
    forward,
  };
}
