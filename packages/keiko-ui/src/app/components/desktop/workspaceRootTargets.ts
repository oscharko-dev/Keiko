import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";

export interface WorkspaceRootTarget {
  readonly id: string;
  readonly root: string;
  readonly label: string;
}

// Quick Access starts three governed searches per root. Four root workers therefore cap its
// request fan-out at twelve in-flight calls, including at the 32-root manifest limit.
export const WORKSPACE_ROOT_REQUEST_CONCURRENCY = 4 as const;

export type WorkspaceRootRequestOutcome<T> =
  | {
      readonly status: "success";
      readonly target: WorkspaceRootTarget;
      readonly value: T;
    }
  | {
      readonly status: "error";
      readonly target: WorkspaceRootTarget;
      readonly message: string;
    };

function displayNameCounts(manifest: WorkspaceManifest): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const root of manifest.roots) {
    counts.set(root.displayName, (counts.get(root.displayName) ?? 0) + 1);
  }
  return counts;
}

function rootLabels(manifest: WorkspaceManifest): readonly string[] {
  const counts = displayNameCounts(manifest);
  const positions = new Map<string, number>();
  return manifest.roots.map((root) => {
    if (counts.get(root.displayName) === 1) return root.displayName;
    const position = (positions.get(root.displayName) ?? 0) + 1;
    positions.set(root.displayName, position);
    return `${root.displayName} (${String(position)})`;
  });
}

export function workspaceRootTargets(
  fallbackRoot: string | undefined,
  manifest: WorkspaceManifest | null,
): readonly WorkspaceRootTarget[] {
  if (manifest === null) {
    return fallbackRoot === undefined
      ? []
      : [{ id: fallbackRoot, root: fallbackRoot, label: fallbackRoot }];
  }
  const labels = rootLabels(manifest);
  return manifest.roots.map((root, index) => ({
    id: root.rootRef,
    root: root.canonicalRoot,
    label: labels[index] ?? root.displayName,
  }));
}

function requestErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace request failed.";
}

interface IndexedRootTarget {
  readonly index: number;
  readonly target: WorkspaceRootTarget;
}

interface IndexedRootOutcome<T> {
  readonly index: number;
  readonly outcome: WorkspaceRootRequestOutcome<T>;
}

async function requestWorkspaceRoot<T>(
  target: WorkspaceRootTarget,
  request: (target: WorkspaceRootTarget) => Promise<T>,
): Promise<WorkspaceRootRequestOutcome<T>> {
  try {
    return { status: "success", target, value: await request(target) };
  } catch (error) {
    return { status: "error", target, message: requestErrorMessage(error) };
  }
}

async function runRootRequestWorker<T>(
  takeNext: () => IndexedRootTarget | undefined,
  request: (target: WorkspaceRootTarget) => Promise<T>,
): Promise<readonly IndexedRootOutcome<T>[]> {
  const completed: IndexedRootOutcome<T>[] = [];
  let next = takeNext();
  while (next !== undefined) {
    completed.push({
      index: next.index,
      outcome: await requestWorkspaceRoot(next.target, request),
    });
    next = takeNext();
  }
  return completed;
}

export async function requestWorkspaceRoots<T>(
  targets: readonly WorkspaceRootTarget[],
  request: (target: WorkspaceRootTarget) => Promise<T>,
): Promise<readonly WorkspaceRootRequestOutcome<T>[]> {
  let nextIndex = 0;
  const takeNext = (): IndexedRootTarget | undefined => {
    const index = nextIndex;
    const target = targets[index];
    if (target === undefined) return undefined;
    nextIndex += 1;
    return { index, target };
  };
  const workerCount = Math.min(targets.length, WORKSPACE_ROOT_REQUEST_CONCURRENCY);
  const completed = (
    await Promise.all(
      Array.from({ length: workerCount }, () => runRootRequestWorker(takeNext, request)),
    )
  ).flat();
  completed.sort((left, right) => left.index - right.index);
  return completed.map((entry) => entry.outcome);
}
