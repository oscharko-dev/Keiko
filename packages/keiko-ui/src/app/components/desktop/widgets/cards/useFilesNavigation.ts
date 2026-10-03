import { useCallback, useState } from "react";
import { startFilesNavigationEvidence } from "@/lib/files-navigation-evidence";

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
  readonly visit: (path: string | null) => void;
  readonly back: () => void;
  readonly forward: () => void;
}
const HISTORY_LIMIT = 100;

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

export function useFilesNavigation(
  root: string,
  onRootChange?: (root: string) => void,
): FilesNavigation {
  const [history, setHistory] = useState<FolderHistory>({
    entries: [{ root, path: null }],
    index: 0,
  });
  const [lastRoot, setLastRoot] = useState(root);
  if (lastRoot !== root) {
    setLastRoot(root);
    setHistory((previous) =>
      reconcileRoot(previous, root, onRootChange === undefined || lastRoot.length === 0),
    );
  }
  const visit = useCallback(
    (path: string | null): void => {
      const settle = startFilesNavigationEvidence("files directory navigation");
      setHistory((previous) => appendTarget(previous, { root, path }));
      settle();
    },
    [root],
  );
  const move = useCallback(
    (offset: number): void => {
      const index = Math.max(0, Math.min(history.entries.length - 1, history.index + offset));
      const target = history.entries[index];
      if (target === undefined || index === history.index) return;
      if (target.root !== root && onRootChange === undefined) return;
      const settle = startFilesNavigationEvidence("files directory navigation");
      setHistory({ ...history, index });
      if (target.root !== root) onRootChange?.(target.root);
      settle();
    },
    [history, onRootChange, root],
  );
  const back = useCallback((): void => move(-1), [move]);
  const forward = useCallback((): void => move(1), [move]);
  return {
    path: currentPath(history, root),
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    visit,
    back,
    forward,
  };
}
