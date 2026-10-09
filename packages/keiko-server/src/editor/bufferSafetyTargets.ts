import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { EditorAgentSessionSnapshot } from "@oscharko-dev/keiko-contracts";
import { isContainedAgentPath } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { isWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import type { UiStore } from "../store/index.js";
import {
  editorAgentSnapshotLocation,
  resolveEditorAgentRuntimeRoot,
  resolveEditorAgentSessionRoot,
  type EditorAgentContainmentDeps,
} from "./agentRootBoundary.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { workspaceRootAccessOrUndefined } from "../task-workspace/workspace-root-access.js";

/** Retained safety-only publications participate without becoming executable agent sessions. */
export function retainedDirtyTargets(
  workspaceRoot: string,
  targets: readonly string[],
  store?: UiStore,
  resolveAccess?: EditorAgentContainmentDeps["workspaceRootAccessResolver"],
): readonly string[] {
  const dirty = new Set<string>();
  const targetSet = new Set(targets);
  for (const snapshot of editorAgentRegistry.listSessions()) {
    if (snapshot.dirtyFiles.length === 0) continue;
    const recorded = editorAgentSnapshotLocation(snapshot, store);
    if (!rootsOverlap(workspaceRoot, recorded)) continue;
    const root = dirtySnapshotRoot(snapshot, store, resolveAccess);
    if (!rootsOverlap(workspaceRoot, root)) continue;
    for (const file of snapshot.dirtyFiles) {
      if (!isContainedAgentPath(file)) throw new Error("Buffer safety path is invalid");
      const mapped = relative(workspaceRoot, resolve(root, file)).replaceAll("\\", "/");
      if (targetSet.has(mapped)) dirty.add(mapped);
    }
  }
  return [...dirty];
}

function rootsOverlap(left: string, right: string): boolean {
  return isWithinWorkspace(left, right) || isWithinWorkspace(right, left);
}

function dirtySnapshotRoot(
  snapshot: EditorAgentSessionSnapshot,
  store?: UiStore,
  resolveAccess?: EditorAgentContainmentDeps["workspaceRootAccessResolver"],
): string {
  let bound = resolveEditorAgentSessionRoot(snapshot, store);
  if (!bound.ok && resolveAccess !== undefined) {
    const access = workspaceRootAccessOrUndefined(resolveAccess(snapshot.workspaceRoot));
    if (access !== undefined) bound = resolveEditorAgentRuntimeRoot(snapshot, access, store);
  }
  if (!bound.ok) throw new Error("Buffer safety root is unresolved");
  return realpathSync(bound.root.workspaceRoot);
}
