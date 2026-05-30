// Deterministic, explainable context-pack assembly (ADR-0005 D4). Resolution order:
//   discover -> filter (deny/ignore/boundary, already applied by discovery) -> rank by an
//   explainable category heuristic (selectionReason, stable path tie-break) -> greedily add
//   excerpts until the byte budget is exhausted -> truncate each to maxBytesPerFile and
//   redact() it -> record per-entry metadata.
// No clock, no RNG: the same workspace + request always yields the same pack.

import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { discoverFiles, readWorkspaceFile } from "./discovery.js";
import { lexicalRetrievalStrategy, type RankedFile, type RetrievalStrategy } from "./retrieval.js";
import {
  DEFAULT_READ_OPTIONS,
  type ContextEntry,
  type ContextPack,
  type ContextRequest,
  type DiscoveredFile,
  type WorkspaceInfo,
} from "./types.js";

export interface ContextPackDeps {
  readonly fs: WorkspaceFs;
  readonly strategy: RetrievalStrategy;
}

const DEFAULT_DEPS: ContextPackDeps = {
  fs: nodeWorkspaceFs,
  strategy: lexicalRetrievalStrategy,
};

interface BudgetState {
  readonly entries: ContextEntry[];
  usedBytes: number;
  droppedForBudget: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// Clamps a string to at most `maxBytes` UTF-8 bytes without splitting a multi-byte char.
function clampToBytes(
  text: string,
  maxBytes: number,
): { readonly excerpt: string; readonly truncated: boolean } {
  if (maxBytes <= 0) {
    return { excerpt: "", truncated: true };
  }
  if (utf8Bytes(text) <= maxBytes) {
    return { excerpt: text, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  const excerpt = new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/�+$/u, "");
  return { excerpt, truncated: true };
}

// The read cap is the file-size safety ceiling, NOT the per-file excerpt budget: a large
// file is read up to the ceiling and then excerpted by clampToBytes. Using the small
// per-file budget here would wrongly reject any file bigger than the excerpt size.
function readEntry(
  workspace: WorkspaceInfo,
  relPath: string,
  request: ContextRequest,
  deps: ContextPackDeps,
): { readonly text: string; readonly sizeBytes: number; readonly truncated: boolean } | null {
  const readCap = Math.max(request.maxBytesPerFile, DEFAULT_READ_OPTIONS.maxBytes);
  try {
    const content = readWorkspaceFile(workspace, relPath, { maxBytes: readCap }, deps.fs);
    return { text: content.text, sizeBytes: content.sizeBytes, truncated: content.truncated };
  } catch {
    // A file that is too large, denied, or unreadable is simply not packed.
    return null;
  }
}

function buildEntry(
  workspace: WorkspaceInfo,
  ranked: RankedFile,
  request: ContextRequest,
  deps: ContextPackDeps,
  remaining: number,
): ContextEntry | null {
  const content = readEntry(workspace, ranked.file.relativePath, request, deps);
  if (content === null) {
    return null;
  }
  const perFileCap = Math.min(request.maxBytesPerFile, remaining);
  const { excerpt, truncated } = clampToBytes(content.text, perFileCap);
  if (excerpt.length === 0) {
    return null;
  }
  return {
    path: ranked.file.relativePath,
    sizeBytes: content.sizeBytes,
    excerptBytes: utf8Bytes(excerpt),
    selectionReason: ranked.selectionReason,
    truncated: truncated || content.truncated,
    excerpt,
  };
}

function tryAddEntry(
  workspace: WorkspaceInfo,
  ranked: RankedFile,
  request: ContextRequest,
  deps: ContextPackDeps,
  state: BudgetState,
): void {
  const remaining = request.budgetBytes - state.usedBytes;
  if (remaining <= 0) {
    state.droppedForBudget += 1;
    return;
  }
  const entry = buildEntry(workspace, ranked, request, deps, remaining);
  if (entry === null) {
    return;
  }
  state.entries.push(entry);
  state.usedBytes += entry.excerptBytes;
}

export function buildContextPack(
  workspace: WorkspaceInfo,
  request: ContextRequest,
  deps: ContextPackDeps = DEFAULT_DEPS,
): ContextPack {
  const candidates = discoverFiles(workspace, request.discovery, deps.fs);
  return buildContextPackFromFiles(workspace, request, candidates, deps);
}

export function buildContextPackFromFiles(
  workspace: WorkspaceInfo,
  request: ContextRequest,
  candidates: readonly DiscoveredFile[],
  deps: ContextPackDeps = DEFAULT_DEPS,
): ContextPack {
  const ranked = deps.strategy.rank(candidates, request.task);
  const state: BudgetState = { entries: [], usedBytes: 0, droppedForBudget: 0 };
  for (const item of ranked) {
    tryAddEntry(workspace, item, request, deps, state);
  }
  return {
    workspaceRoot: workspace.root,
    totalCandidates: candidates.length,
    selected: state.entries,
    usedBytes: state.usedBytes,
    budgetBytes: request.budgetBytes,
    droppedForBudget: state.droppedForBudget,
  };
}
