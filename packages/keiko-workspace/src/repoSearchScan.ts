// Candidate gathering and the per-file scan loop for the repo-search facade (Issue #179).
// Kept separate from the public API surface so repoSearch.ts stays inside the 400-LOC cap.
// Every file system touch goes through the injected WorkspaceFs port; nothing here calls
// node:fs directly.

import { relative } from "node:path";
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
import { assertContainedRealPath } from "./realpath.js";
import { looksBinary } from "./binaryDetect.js";
import { evidenceAtomStableId } from "./stableId.js";
import type { LineMatcher } from "./repoSearchMatchers.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";

const BINARY_PROBE_BYTES = 512;

// Per-file cap on emitted lexical matches (Epic #177 retrieval fix). A connected-scope question
// carries several content tokens, so a prose-heavy file can match many low-signal lines. Emitting
// all of them let one alphabetically-early file exhaust the global match budget before the scan
// ever reached the file the question was actually about. Keeping only each file's best lines makes
// the evidence diverse across the scope while still surfacing every file's strongest signal for the
// downstream ranker.
const MAX_MATCHES_PER_FILE = 3;

function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split("\\").join("/");
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
): readonly DiscoveredFile[] {
  return discoverFiles(
    scope.workspace,
    { maxDepth: 12, maxFiles: limits.maxFilesScanned, applyGitignore: true },
    fs,
  );
}

function collectFromEntries(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
): { files: readonly DiscoveredFile[]; truncated: boolean } {
  const out: DiscoveredFile[] = [];
  const root = scope.workspace.root;
  let scannedSoFar = 0;
  let truncated = false;
  for (const entry of scope.relativePaths) {
    if (scannedSoFar >= limits.maxFilesScanned) {
      truncated = true;
      break;
    }
    const abs = resolveWithinWorkspace(root, entry);
    assertContainedRealPath(fs, root, abs, "scope");
    const entryRel = toRelative(root, abs);
    // Deny the directory entry itself before recursing so that a denied dir (e.g.
    // node_modules) listed explicitly in scope.relativePaths is never expanded (Finding 5).
    if (isDenied(entryRel)) {
      continue;
    }
    const stat = fs.stat(abs);
    if (stat.isDirectory) {
      const remaining = limits.maxFilesScanned - scannedSoFar;
      const nested = discoverFiles(
        { ...scope.workspace, root: abs },
        { maxDepth: 12, maxFiles: remaining, applyGitignore: true },
        fs,
      );
      for (const file of nested) {
        out.push({
          relativePath: toRelative(root, resolveWithinWorkspace(abs, file.relativePath)),
          sizeBytes: file.sizeBytes,
        });
        scannedSoFar += 1;
      }
      if (nested.length >= remaining) {
        truncated = true;
      }
      continue;
    }
    if (stat.isFile) {
      out.push({ relativePath: entryRel, sizeBytes: stat.size });
      scannedSoFar += 1;
    }
  }
  return { files: out, truncated };
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
    const files = collectFromDirectory(scope, limits, fs);
    return {
      files: [...files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1)),
      truncated: false,
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

function scanLines(
  runner: SearchTextRunner,
  relativePath: string,
  text: string,
  state: RunState,
  atoms: EvidenceAtom[],
): void {
  const lines = text.split("\n");
  // Score every line, then keep only this file's best-scoring lines (ties broken by earliest
  // line). This bounds each file's contribution to MAX_MATCHES_PER_FILE and surfaces the file's
  // strongest evidence rather than whichever lines happen to appear first.
  const scored: { readonly line: number; readonly score: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const score = runner.matcher.match(lines[i] ?? "");
    if (score > 0) {
      scored.push({ line: i + 1, score });
    }
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.line - b.line));
  const best = scored.slice(0, MAX_MATCHES_PER_FILE).sort((a, b) => a.line - b.line);
  for (const match of best) {
    if (hitLimit(runner, state)) {
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
  assertContainedRealPath(runner.fs, runner.scope.workspace.root, abs, "scope");
  if (await probeBinary(runner.fs, abs, file.sizeBytes)) {
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
