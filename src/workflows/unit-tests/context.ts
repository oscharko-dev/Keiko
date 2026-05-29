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
  nodeWorkspaceFs,
  type ContextPack,
  type ContextPackDeps,
  type ContextRequest,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "../../workspace/index.js";
import type { UnitTestTarget, UnitTestWorkflowInput, WorkflowLimits } from "./types.js";

export interface TestGenContextDeps {
  readonly fs?: WorkspaceFs | undefined;
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
    strategy: lexicalRetrievalStrategy,
  };
  return buildContextPack(workspace, request, packDeps);
}
