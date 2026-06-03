// Context assembly for the generation call (ADR-0008 D1). Delegates to #5 buildContextPack so the
// target file, nearby test files, manifests/config, and type definitions are selected, ranked, and
// excerpted under a byte budget — every excerpt already redacted by #5 at the IO boundary. Pure
// except for the WorkspaceFs seam threaded into buildContextPack. The `task` hint is a forward-
// compatible natural-language description of the target for a future embedding ranker; the Wave-1
// lexical strategy tolerates it.

import {
  buildContextPack,
  DEFAULT_DISCOVERY_OPTIONS,
  lexicalRetrievalStrategy,
  SELECTION_REASON_PRIORITY,
  type ContextPack,
  type ContextPackDeps,
  type ContextRequest,
  type DiscoveredFile,
  type RankedFile,
  type RetrievalStrategy,
  type SelectionReason,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { UnitTestTarget, UnitTestWorkflowInput, WorkflowLimits } from "./types.js";

export interface TestGenContextDeps {
  readonly fs?: WorkspaceFs | undefined;
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function underDir(path: string, dir: string): boolean {
  const normalized = toPosix(dir);
  return path === normalized || path.startsWith(`${normalized}/`);
}

function basename(path: string): string {
  const normalized = toPosix(path);
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function stem(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? base : base.slice(0, idx);
}

function testStem(path: string): string {
  const parts = stem(path).split(".");
  const marker = parts.findIndex((part) => part === "test" || part === "spec");
  return marker === -1 ? parts.join(".") : parts.slice(0, marker).join(".");
}

function targetPaths(target: UnitTestTarget): readonly string[] {
  if (target.kind === "file") {
    return [toPosix(target.filePath)];
  }
  if (target.kind === "changedFiles") {
    return target.filePaths.map(toPosix);
  }
  return [];
}

function moduleDir(target: UnitTestTarget): string | undefined {
  return target.kind === "module" ? toPosix(target.moduleDir) : undefined;
}

function isRequestedTarget(path: string, input: UnitTestWorkflowInput): boolean {
  const module = moduleDir(input.target);
  return (
    targetPaths(input.target).includes(path) || (module !== undefined && underDir(path, module))
  );
}

function isTestCandidate(
  path: string,
  workspace: WorkspaceInfo,
  selectionReason: SelectionReason,
): boolean {
  return (
    selectionReason === "test" ||
    workspace.testDirs.some((testDir) => underDir(path, testDir)) ||
    stem(path)
      .split(".")
      .some((part) => part === "test" || part === "spec")
  );
}

function isNearbyTest(
  path: string,
  workspace: WorkspaceInfo,
  input: UnitTestWorkflowInput,
  selectionReason: SelectionReason,
): boolean {
  if (!isTestCandidate(path, workspace, selectionReason)) {
    return false;
  }
  const targets = targetPaths(input.target);
  if (targets.length === 0) {
    const module = moduleDir(input.target);
    return module !== undefined && path.includes(basename(module));
  }
  const candidateStem = testStem(path);
  return targets.some((target) => candidateStem === stem(target));
}

function priorityIndex(reason: SelectionReason): number {
  return SELECTION_REASON_PRIORITY.indexOf(reason);
}

function issue8Priority(
  ranked: RankedFile,
  workspace: WorkspaceInfo,
  input: UnitTestWorkflowInput,
): number {
  const path = toPosix(ranked.file.relativePath);
  if (isRequestedTarget(path, input)) {
    return 0;
  }
  if (isNearbyTest(path, workspace, input, ranked.selectionReason)) {
    return 1;
  }
  return 2;
}

function isSupportContext(ranked: RankedFile): boolean {
  return ranked.selectionReason === "manifest" || ranked.selectionReason === "config";
}

function focusedContext(
  ranked: readonly RankedFile[],
  workspace: WorkspaceInfo,
  input: UnitTestWorkflowInput,
): readonly RankedFile[] {
  const focused = ranked.filter(
    (item) => issue8Priority(item, workspace, input) < 2 || isSupportContext(item),
  );
  return focused.length === 0 ? ranked : focused;
}

function createUnitTestRetrievalStrategy(
  workspace: WorkspaceInfo,
  input: UnitTestWorkflowInput,
): RetrievalStrategy {
  return {
    rank: (files: readonly DiscoveredFile[], task: string | undefined): readonly RankedFile[] => {
      const ranked = focusedContext(lexicalRetrievalStrategy.rank(files, task), workspace, input);
      return [...ranked].sort((a, b) => {
        const byIssue8 = issue8Priority(a, workspace, input) - issue8Priority(b, workspace, input);
        if (byIssue8 !== 0) {
          return byIssue8;
        }
        const byReason = priorityIndex(a.selectionReason) - priorityIndex(b.selectionReason);
        if (byReason !== 0) {
          return byReason;
        }
        return a.file.relativePath.localeCompare(b.file.relativePath);
      });
    },
  };
}

function taskHint(target: UnitTestTarget): string {
  if (target.kind === "file") {
    return target.targetFunction === undefined
      ? `unit tests for ${target.filePath}`
      : `unit tests for ${target.targetFunction} in ${target.filePath}`;
  }
  if (target.kind === "module") {
    return `unit tests for module ${target.moduleDir}`;
  }
  return `unit tests for ${target.filePaths.join(", ")}`;
}

export function buildTestGenContext(
  workspace: WorkspaceInfo,
  input: UnitTestWorkflowInput,
  limits: WorkflowLimits,
  deps: TestGenContextDeps = {},
): ContextPack {
  const request: ContextRequest = {
    task: taskHint(input.target),
    budgetBytes: limits.contextBudgetBytes,
    maxBytesPerFile: limits.maxBytesPerFile,
    discovery: DEFAULT_DISCOVERY_OPTIONS,
  };
  // buildContextPack defaults to the lexical strategy, but ContextPackDeps requires the field; pass
  // the #5 barrel default explicitly so we hand a complete deps object without reaching past #5.
  const packDeps: ContextPackDeps = {
    fs: deps.fs ?? nodeWorkspaceFs,
    strategy: createUnitTestRetrievalStrategy(workspace, input),
  };
  return buildContextPack(workspace, request, packDeps);
}
