import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";

export interface WorkspaceRootTarget {
  readonly id: string;
  readonly root: string;
  readonly label: string;
}

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

export async function requestWorkspaceRoots<T>(
  targets: readonly WorkspaceRootTarget[],
  request: (target: WorkspaceRootTarget) => Promise<T>,
): Promise<readonly WorkspaceRootRequestOutcome<T>[]> {
  return Promise.all(
    targets.map(async (target): Promise<WorkspaceRootRequestOutcome<T>> => {
      try {
        return { status: "success", target, value: await request(target) };
      } catch (error) {
        return { status: "error", target, message: requestErrorMessage(error) };
      }
    }),
  );
}
