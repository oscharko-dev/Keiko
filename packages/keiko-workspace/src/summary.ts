// The structured, redacted view CLI/SDK/UI render WITHOUT touching the filesystem. Every
// string that could carry file content is already redacted upstream (context excerpts pass
// through redact() in discovery/contextPack). This module only reshapes already-safe data;
// it performs no IO and adds no raw file contents. Pure and deterministic.

import type {
  AuditSummary,
  ContextPack,
  ContextPackSummary,
  DiscoveryStats,
  WorkspaceInfo,
  WorkspaceSummary,
} from "./types.js";

function toContextSummary(pack: ContextPack): ContextPackSummary {
  return {
    totalCandidates: pack.totalCandidates,
    usedBytes: pack.usedBytes,
    budgetBytes: pack.budgetBytes,
    droppedForBudget: pack.droppedForBudget,
    entries: pack.selected.map((entry) => ({
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      excerptBytes: entry.excerptBytes,
      selectionReason: entry.selectionReason,
      truncated: entry.truncated,
      excerpt: entry.excerpt,
    })),
  };
}

function statsFor(pack: ContextPack | undefined): DiscoveryStats {
  return { discovered: pack?.totalCandidates ?? 0, denied: 0, ignored: 0 };
}

export function buildWorkspaceSummary(
  workspace: WorkspaceInfo,
  pack?: ContextPack,
  stats?: DiscoveryStats,
): WorkspaceSummary {
  return {
    root: workspace.root,
    name: workspace.name,
    version: workspace.version,
    testFramework: workspace.testFramework,
    sourceDirs: workspace.sourceDirs,
    testDirs: workspace.testDirs,
    languages: workspace.languages,
    counts: stats ?? statsFor(pack),
    context: pack === undefined ? undefined : toContextSummary(pack),
  };
}

// Selected-context metadata for audit evidence: paths, sizes, reasons, and budget usage.
// Deliberately excludes excerpt TEXT so an audit record carries no file content at all.
export function summarizeForAudit(pack: ContextPack): AuditSummary {
  return {
    workspaceRoot: pack.workspaceRoot,
    totalCandidates: pack.totalCandidates,
    usedBytes: pack.usedBytes,
    budgetBytes: pack.budgetBytes,
    droppedForBudget: pack.droppedForBudget,
    entries: pack.selected.map((entry) => ({
      path: entry.path,
      sizeBytes: entry.sizeBytes,
      excerptBytes: entry.excerptBytes,
      selectionReason: entry.selectionReason,
      truncated: entry.truncated,
    })),
  };
}
