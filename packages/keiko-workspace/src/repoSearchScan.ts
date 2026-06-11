// Candidate gathering and the per-file scan loop for the repo-search facade (Issue #179).
// Kept separate from the public API surface so repoSearch.ts stays inside the 400-LOC cap.
// Every file system touch goes through the injected WorkspaceFs port; nothing here calls
// node:fs directly.

import type {
  CandidateFile,
  CandidateOmissionReason,
  EvidenceAtom,
  EvidenceAtomProvenanceKind,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  isValidScopePath,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { discoverFiles, readWorkspaceFile } from "./discovery.js";
import { FileTooLargeError, RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied, isIgnored, type IgnoreMatcher } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { looksBinary } from "./binaryDetect.js";
import { collectFromEntries } from "./repoSearchEntries.js";
import { collectBestLines, type ScoredLine } from "./repoSearchLineSelection.js";
import { evidenceAtomStableId } from "./stableId.js";
import type { LineMatcher } from "./repoSearchMatchers.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";

const BINARY_PROBE_BYTES = 512;

function normalizeScopePath(scopePath: string): string {
  return scopePath.split("\\").join("/");
}

export interface ScopeShape {
  readonly workspace: WorkspaceInfo;
  readonly scopeId: string;
  readonly relativePaths: readonly string[];
}

export interface LimitsShape {
  readonly maxFilesScanned: number;
  readonly maxMatchesReturned: number;
  readonly maxBytesPerFileScanned: number;
  readonly elapsedMsMax: number;
}

export interface AtomShape {
  readonly scopeId: string;
  readonly scopePath: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number } | undefined;
  readonly provenanceKind: EvidenceAtomProvenanceKind;
  readonly tool: string;
  readonly queryFingerprint: string;
  readonly score: number;
  readonly emittedAtMs: number;
}

export function buildAtom(shape: AtomShape): EvidenceAtom {
  const stableId = evidenceAtomStableId({
    scopeId: shape.scopeId,
    scopePath: shape.scopePath,
    lineRange: shape.lineRange,
    provenanceKind: shape.provenanceKind,
    provenanceTool: shape.tool,
    queryFingerprint: shape.queryFingerprint,
  });
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId,
    scopePath: shape.scopePath,
    lineRange: shape.lineRange,
    score: shape.score,
    provenance: {
      kind: shape.provenanceKind,
      tool: shape.tool,
      queryFingerprint: shape.queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: shape.emittedAtMs,
    ledgerRef: undefined,
  };
}

export function buildCandidate(
  scopePath: string,
  omitted: CandidateOmissionReason | undefined,
): CandidateFile {
  return { scopePath, score: 0, signals: [], omitted };
}

function collectFromDirectory(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
): { files: readonly DiscoveredFile[]; truncated: boolean } {
  const files = discoverFiles(
    scope.workspace,
    { maxDepth: 12, maxFiles: limits.maxFilesScanned + 1, applyGitignore: true },
    fs,
  );
  return {
    files: files.slice(0, limits.maxFilesScanned),
    truncated: files.length > limits.maxFilesScanned,
  };
}

export interface CandidateSet {
  readonly files: readonly DiscoveredFile[];
  readonly truncated: boolean;
}

export function gatherCandidates(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
): CandidateSet {
  // Defense in depth alongside the realpath gate: validate scope.relativePaths against the
  // contracts-layer shape rules (no absolute paths, no `..`, no drive letters, no backslashes).
  // resolveWithinWorkspace + assertContainedRealPath already provide a complete barrier; this
  // pre-check rejects shape-invalid inputs at the API boundary with a typed error rather than
  // letting a normalization quirk slip past unnoticed.
  for (const entry of scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      throw new RepoSearchInvalidQueryError(`invalid scope.relativePaths entry: ${entry}`);
    }
  }
  if (scope.relativePaths.length === 0) {
    const result = collectFromDirectory(scope, limits, fs);
    return {
      files: [...result.files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)),
      truncated: result.truncated,
    };
  }
  const result = collectFromEntries(scope, limits, fs);
  return {
    files: [...result.files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)),
    truncated: result.truncated,
  };
}

export async function probeBinary(fs: WorkspaceFs, abs: string, size: number): Promise<boolean> {
  const cap = Math.min(BINARY_PROBE_BYTES, size);
  if (cap === 0) {
    return false;
  }
  if (fs.readFileBytes !== undefined) {
    return looksBinary(await fs.readFileBytes(abs, cap));
  }
  const text = fs.readFileUtf8(abs);
  return looksBinary(new TextEncoder().encode(text.slice(0, cap)));
}

export interface SearchTextRunner {
  readonly scope: ScopeShape;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly startMs: number;
  readonly matcher: LineMatcher;
  readonly ignoreMatcher: IgnoreMatcher;
  readonly fingerprint: string;
}

export interface RunState {
  filesScanned: number;
  matchesReturned: number;
  truncated: boolean;
}

export function elapsed(runner: SearchTextRunner): number {
  return runner.nowMs() - runner.startMs;
}

export function hitLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (state.filesScanned >= runner.limits.maxFilesScanned) {
    state.truncated = true;
    return true;
  }
  if (state.matchesReturned >= runner.limits.maxMatchesReturned) {
    state.truncated = true;
    return true;
  }
  if (elapsed(runner) > runner.limits.elapsedMsMax) {
    state.truncated = true;
    return true;
  }
  return false;
}

function hitEmissionLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (state.matchesReturned >= runner.limits.maxMatchesReturned) {
    state.truncated = true;
    return true;
  }
  if (elapsed(runner) > runner.limits.elapsedMsMax) {
    state.truncated = true;
    return true;
  }
  return false;
}

function readForScan(
  runner: SearchTextRunner,
  relativePath: string,
  candidates: CandidateFile[],
): string | undefined {
  try {
    return readWorkspaceFile(
      runner.scope.workspace,
      relativePath,
      { maxBytes: runner.limits.maxBytesPerFileScanned },
      runner.fs,
    ).text;
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      candidates.push(buildCandidate(relativePath, "size-exceeded"));
      return undefined;
    }
    throw err;
  }
}

function emitBestLines(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  atoms: EvidenceAtom[],
  best: readonly ScoredLine[],
): void {
  for (const match of best) {
    if (hitEmissionLimit(runner, state)) {
      return;
    }
    atoms.push(
      buildAtom({
        scopeId: runner.scope.scopeId,
        scopePath: relativePath,
        lineRange: { startLine: match.line, endLine: match.line },
        provenanceKind: "lexical-search",
        tool: "repo.searchText",
        queryFingerprint: runner.fingerprint,
        score: match.score,
        emittedAtMs: runner.nowMs(),
      }),
    );
    state.matchesReturned += 1;
  }
}

function scanLines(
  runner: SearchTextRunner,
  relativePath: string,
  text: string,
  state: RunState,
  atoms: EvidenceAtom[],
): void {
  emitBestLines(runner, relativePath, state, atoms, collectBestLines(runner, text, state));
}

export async function scanFile(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  if (isDenied(file.relativePath) || isIgnored(runner.ignoreMatcher, file.relativePath, false)) {
    candidates.push(buildCandidate(file.relativePath, "ignored"));
    return;
  }
  const abs = resolveWithinWorkspace(runner.scope.workspace.root, file.relativePath);
  const contained = containedRealPathInfo(runner.fs, runner.scope.workspace.root, abs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (isDenied(realRel) || isIgnored(runner.ignoreMatcher, realRel, false)) {
    candidates.push(buildCandidate(file.relativePath, "ignored"));
    return;
  }
  if (await probeBinary(runner.fs, contained.path, file.sizeBytes)) {
    candidates.push(buildCandidate(file.relativePath, "binary"));
    return;
  }
  state.filesScanned += 1;
  const text = readForScan(runner, file.relativePath, candidates);
  if (text === undefined) {
    return;
  }
  scanLines(runner, file.relativePath, text, state, atoms);
}
