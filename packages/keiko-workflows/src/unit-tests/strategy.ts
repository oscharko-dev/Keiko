// Resolves the convention-driven test strategy for a workflow target (Issue #1203). Bridges the pure
// frontend detector/selector (frontend.ts) to the workflow's UnitTestTarget and the already-assembled
// ContextPack: it derives the anchor source path, detects the project's frontend test stack from local
// manifests/config, samples the target's redacted source excerpt from the pack, and selects the style.
// The only effect is the manifest/config read delegated to the injected WorkspaceFs.

import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { ContextPack, WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { detectFrontendStack, selectTestStrategy, type TestStrategy } from "./frontend.js";
import type { TestConventions, UnitTestTarget } from "./types.js";

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

// The single source path the strategy is anchored on: the file under test, the first changed file, or
// the module directory. Used both for stack detection (walk-up) and component classification.
export function strategyAnchorPath(target: UnitTestTarget): string {
  if (target.kind === "file") {
    return toPosix(target.filePath);
  }
  if (target.kind === "changedFiles") {
    return toPosix(target.filePaths[0] ?? "");
  }
  return toPosix(target.moduleDir);
}

// The target file's redacted source excerpt, if it was selected into the ContextPack. A secondary
// classification signal for non-`.tsx` modules; absent when the target was dropped for budget.
function targetSourceExcerpt(pack: ContextPack, anchorPath: string): string | undefined {
  return pack.selected.find((entry) => toPosix(entry.path) === anchorPath)?.excerpt;
}

export function resolveTestStrategy(
  workspace: WorkspaceInfo,
  target: UnitTestTarget,
  conventions: TestConventions,
  pack: ContextPack,
  fs: WorkspaceFs = nodeWorkspaceFs,
): TestStrategy {
  const anchorPath = strategyAnchorPath(target);
  const stack = detectFrontendStack(workspace, fs, anchorPath);
  return selectTestStrategy({
    targetPath: anchorPath,
    targetSource: targetSourceExcerpt(pack, anchorPath),
    framework: conventions.framework,
    stack,
  });
}
