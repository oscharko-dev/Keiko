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
  SELECTION_REASON_PRIORITY,
  type ContextPack,
  type ContextPackDeps,
  type ContextRequest,
  type DiscoveredFile,
  type RankedFile,
  type RetrievalStrategy,
  type SelectionReason,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
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

function toPosix(path: string): string {
  return path.split("\\").join("/");
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

function underDir(path: string, dir: string): boolean {
  const normalized = toPosix(dir);
  return path === normalized || path.startsWith(`${normalized}/`);
}

function toWorkspaceRelative(path: string, workspace: WorkspaceInfo): string {
  const normalized = toPosix(path);
  const root = toPosix(workspace.root);
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

interface EvidenceIndex {
  readonly paths: ReadonlySet<string>;
  readonly stems: ReadonlySet<string>;
}

function buildEvidenceIndex(evidence: FailureEvidence, workspace: WorkspaceInfo): EvidenceIndex {
  const paths = new Set(evidence.frames.map((frame) => toWorkspaceRelative(frame.file, workspace)));
  return { paths, stems: new Set([...paths].map(stem)) };
}

function isEvidenceTarget(path: string, evidence: EvidenceIndex): boolean {
  return evidence.paths.has(toPosix(path));
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

function isNearbyEvidenceTest(
  path: string,
  workspace: WorkspaceInfo,
  evidence: EvidenceIndex,
  selectionReason: SelectionReason,
): boolean {
  if (!isTestCandidate(path, workspace, selectionReason)) {
    return false;
  }
  const candidateStem = testStem(path);
  return evidence.stems.has(candidateStem);
}

function priorityIndex(reason: SelectionReason): number {
  return SELECTION_REASON_PRIORITY.indexOf(reason);
}

function evidencePriority(
  ranked: RankedFile,
  workspace: WorkspaceInfo,
  evidence: EvidenceIndex,
): number {
  const path = toPosix(ranked.file.relativePath);
  if (isEvidenceTarget(path, evidence)) {
    return 0;
  }
  if (isNearbyEvidenceTest(path, workspace, evidence, ranked.selectionReason)) {
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
  evidence: EvidenceIndex,
): readonly RankedFile[] {
  const focused = ranked.filter(
    (item) => evidencePriority(item, workspace, evidence) < 2 || isSupportContext(item),
  );
  return focused.length === 0 ? ranked : focused;
}

function createBugRetrievalStrategy(
  workspace: WorkspaceInfo,
  evidence: FailureEvidence,
): RetrievalStrategy {
  const index = buildEvidenceIndex(evidence, workspace);
  return {
    rank: (files: readonly DiscoveredFile[], task: string | undefined): readonly RankedFile[] => {
      const ranked = focusedContext(lexicalRetrievalStrategy.rank(files, task), workspace, index);
      return [...ranked].sort((a, b) => {
        const byEvidence =
          evidencePriority(a, workspace, index) - evidencePriority(b, workspace, index);
        if (byEvidence !== 0) {
          return byEvidence;
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
    strategy: createBugRetrievalStrategy(workspace, evidence),
  };
  return buildContextPack(workspace, request, packDeps);
}
