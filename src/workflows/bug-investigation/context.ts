// Context assembly for the investigation call (ADR-0009 D8). Delegates to #5 buildContextPack so
// the implicated source, nearby tests, manifests/config, and type definitions are selected, ranked,
// and excerpted under a byte budget — every excerpt already redacted by #5 at the IO boundary. The
// failure-frame files and developer-provided targetFiles are folded into the lexical `task` hint so
// the Wave-1 lexical strategy ranks them up (the #5 ContextRequest is reused unchanged; we do not
// add a new "seed files" field to #5). Pure except for the WorkspaceFs seam threaded into #5.

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
import type { BugWorkflowLimits, FailureEvidence } from "./types.js";

export interface BugContextDeps {
  readonly fs?: WorkspaceFs | undefined;
}

// The lexical task hint: the bug description (or a generic fallback) plus the implicated file paths
// so the lexical ranker pulls those files into the pack. Deduped; bounded by the frame cap upstream.
function taskHint(description: string | undefined, evidence: FailureEvidence): string {
  const base =
    description !== undefined && description.trim().length > 0
      ? description.trim()
      : "investigate failing test and locate the root cause";
  const files = Array.from(new Set(evidence.frames.map((frame) => frame.file)));
  return files.length === 0 ? base : `${base} ${files.join(" ")}`;
}

export function buildBugContext(
  workspace: WorkspaceInfo,
  description: string | undefined,
  evidence: FailureEvidence,
  limits: BugWorkflowLimits,
  deps: BugContextDeps = {},
): ContextPack {
  const request: ContextRequest = {
    task: taskHint(description, evidence),
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
