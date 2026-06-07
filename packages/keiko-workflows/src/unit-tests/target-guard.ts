// Workspace-containment guard for the unit-test workflow input target (issue #641 / ADR-0005 D2).
// Runs BEFORE any model call so escaped, denied, or realpath-escape targets fail closed with
// modelCallCount=0 and no diff. Mirrors the discovery boundary rules: lexical containment via
// resolveWithinWorkspace, denylist via isDenied on the normalized relative path, and realpath
// containment via assertContainedRealPath for existing targets. Pure with respect to non-FS state.

import { relative } from "node:path";
import {
  PathDeniedError,
  assertContainedRealPath,
  isDenied,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import type { UnitTestTarget } from "./types.js";

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

export function targetInputPaths(target: UnitTestTarget): readonly string[] {
  if (target.kind === "file") {
    return [target.filePath];
  }
  if (target.kind === "module") {
    return [target.moduleDir];
  }
  return target.filePaths;
}

export function assertTargetWithinWorkspace(
  workspace: WorkspaceInfo,
  target: UnitTestTarget,
  fs: WorkspaceFs,
): void {
  for (const candidate of targetInputPaths(target)) {
    const absolute = resolveWithinWorkspace(workspace.root, candidate);
    const normalizedRelative = toPosix(relative(workspace.root, absolute));
    if (normalizedRelative !== "" && isDenied(normalizedRelative)) {
      throw new PathDeniedError(
        `path is denied by workspace policy: ${candidate}`,
        candidate,
      );
    }
    assertContainedRealPath(fs, workspace.root, absolute, "unit-test-target");
  }
}
