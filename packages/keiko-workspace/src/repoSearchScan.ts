// Candidate gathering and the per-file scan loop for the repo-search facade (Issue #179).
// Kept separate from the public API surface so repoSearch.ts stays inside the 400-LOC cap.
// Every file system touch goes through the injected WorkspaceFs port; nothing here calls
// node:fs directly.

import type {
  CandidateFile,
  CandidateOmissionReason,
  EvidenceAtom,
  EvidenceEdge,
  EvidenceAtomProvenanceKind,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  isValidScopePath,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import { discoverWithStats, readWorkspaceFile } from "./discovery.js";
import { FileTooLargeError, RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { DEFAULT_BINARY_PROBE, looksBinary } from "./binaryDetect.js";
import { collectFromEntries } from "./repoSearchEntries.js";
import { collectBestLines, type ScoredLine } from "./repoSearchLineSelection.js";
import { evidenceAtomStableId } from "./stableId.js";
import type { LineMatcher } from "./repoSearchMatchers.js";
import {
  extraIgnoreLinesForSearch,
  legacyDiscoveryPolicy,
  orderCandidatesForSearch,
  policyOmissionReason,
  resolveSearchPolicy,
  scoreContentForSearch,
  shouldScoreContent,
  type SearchDiagnostics,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { DiscoveredFile, WorkspaceInfo } from "./types.js";

const BINARY_PROBE_BYTES = DEFAULT_BINARY_PROBE.maxProbeBytes;
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

function normalizeScopePath(scopePath: string): string {
  return scopePath.split("\\").join("/");
}

export function isImageScopePath(scopePath: string): boolean {
  const lastSlash = Math.max(scopePath.lastIndexOf("/"), scopePath.lastIndexOf("\\"));
  const basename = scopePath.slice(lastSlash + 1).toLowerCase();
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(basename.slice(dot));
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
  readonly edge?: EvidenceEdge | undefined;
  readonly score: number;
  readonly emittedAtMs: number;
}

export function buildAtom(shape: AtomShape): EvidenceAtom {
  const stableId = evidenceAtomStableId({
    scopeId: shape.scopeId,
    scopePath: shape.scopePath,
    lineRange: shape.lineRange,
    edge: shape.edge,
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
    edge: shape.edge,
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
  policy: SearchPolicy,
): {
  files: readonly DiscoveredFile[];
  truncated: boolean;
  ignored: number;
  denied: number;
  depthPruned: number;
  maxFilesPruned: number;
} {
  const extraIgnoreLines = extraIgnoreLinesForSearch(policy);
  const workspace =
    extraIgnoreLines.length === 0
      ? scope.workspace
      : { ...scope.workspace, ignoreLines: [...scope.workspace.ignoreLines, ...extraIgnoreLines] };
  const discoveryMaxFiles = Math.max(limits.maxFilesScanned * 25, limits.maxFilesScanned + 1);
  const result = discoverWithStats(
    workspace,
    {
      maxDepth: 40,
      maxFiles: discoveryMaxFiles,
      applyGitignore: policy.applyGitignore,
    },
    fs,
  );
  const files = result.files;
  return {
    files,
    truncated: result.stats.maxFilesPruned > 0,
    ignored: result.stats.ignored,
    denied: result.stats.denied,
    depthPruned: result.stats.depthPruned,
    maxFilesPruned: result.stats.maxFilesPruned,
  };
}

export interface CandidateSet {
  readonly files: readonly DiscoveredFile[];
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics;
}

const DEFAULT_GATHER_QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "generic repository search",
  caseSensitive: false,
  maxResults: 100,
  emittedAtMs: 0,
};

const CONTENT_PRESCORE_MAX_BYTES = 65_536;
const CONTENT_PRESCORE_MAX_FILES = 5_000;

function isRetrievalQuery(value: unknown): value is RetrievalQuery {
  return typeof value === "object" && value !== null && "kind" in value && "text" in value;
}

interface GatherInputs {
  readonly query: RetrievalQuery;
  readonly limits: LimitsShape;
  readonly fs: WorkspaceFs;
  readonly policy: SearchPolicy;
  readonly prescoreContent: boolean;
}

function shouldPrescoreContent(query: RetrievalQuery): boolean {
  return query.kind === "natural-language" || query.kind === "exact-symbol";
}

function contentPrescoreLimit(limits: LimitsShape, fileCount: number): number {
  return Math.min(fileCount, CONTENT_PRESCORE_MAX_FILES, Math.max(limits.maxFilesScanned * 25, 0));
}

function readContentPreview(
  scope: ScopeShape,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): string | undefined {
  if (file.sizeBytes > CONTENT_PRESCORE_MAX_BYTES) {
    return undefined;
  }
  try {
    return readWorkspaceFile(
      scope.workspace,
      file.relativePath,
      { maxBytes: CONTENT_PRESCORE_MAX_BYTES },
      fs,
    ).text;
  } catch {
    return undefined;
  }
}

function contentScoresForOrdering(
  scope: ScopeShape,
  files: readonly DiscoveredFile[],
  inputs: GatherInputs,
): ReadonlyMap<string, number> | undefined {
  if (!inputs.prescoreContent || !shouldPrescoreContent(inputs.query) || files.length === 0) {
    return undefined;
  }
  const scores = new Map<string, number>();
  const limit = contentPrescoreLimit(inputs.limits, files.length);
  for (const file of files.slice(0, limit)) {
    const preview = readContentPreview(scope, file, inputs.fs);
    if (preview === undefined) {
      continue;
    }
    const score = scoreContentForSearch(inputs.query, preview, inputs.policy);
    if (score > 0) {
      scores.set(file.relativePath, score);
    }
  }
  return scores.size === 0 ? undefined : scores;
}

function resolveGatherInputs(
  scope: ScopeShape,
  queryOrLimits: RetrievalQuery | LimitsShape,
  limitsOrFs: LimitsShape | WorkspaceFs,
  fsOrPolicy?: WorkspaceFs | SearchPolicy,
  policy?: SearchPolicy,
): GatherInputs {
  if (isRetrievalQuery(queryOrLimits)) {
    return {
      query: queryOrLimits,
      limits: limitsOrFs as LimitsShape,
      fs: fsOrPolicy as WorkspaceFs,
      policy: policy ?? resolveSearchPolicy(scope.relativePaths.length > 0, undefined),
      prescoreContent: true,
    };
  }
  return {
    query: DEFAULT_GATHER_QUERY,
    limits: queryOrLimits,
    fs: limitsOrFs as WorkspaceFs,
    policy: legacyDiscoveryPolicy(scope.relativePaths.length > 0),
    prescoreContent: false,
  };
}

export function gatherCandidates(
  scope: ScopeShape,
  limits: LimitsShape,
  fs: WorkspaceFs,
): CandidateSet;
export function gatherCandidates(
  scope: ScopeShape,
  query: RetrievalQuery,
  limits: LimitsShape,
  fs: WorkspaceFs,
  policy: SearchPolicy,
): CandidateSet;
export function gatherCandidates(
  scope: ScopeShape,
  queryOrLimits: RetrievalQuery | LimitsShape,
  limitsOrFs: LimitsShape | WorkspaceFs,
  fsOrPolicy?: WorkspaceFs | SearchPolicy,
  policy?: SearchPolicy,
): CandidateSet {
  const inputs = resolveGatherInputs(scope, queryOrLimits, limitsOrFs, fsOrPolicy, policy);
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
    const result = collectFromDirectory(scope, inputs.limits, inputs.fs, inputs.policy);
    const contentScores = contentScoresForOrdering(scope, result.files, inputs);
    const ordered = orderCandidatesForSearch(
      result.files,
      inputs.query,
      inputs.policy,
      result.ignored,
      result.denied,
      result.depthPruned,
      result.maxFilesPruned,
      contentScores,
    );
    return {
      files: ordered.files,
      truncated: result.truncated || result.depthPruned > 0,
      diagnostics: ordered.diagnostics,
    };
  }
  const result = collectFromEntries(scope, inputs.limits, inputs.fs);
  const contentScores = contentScoresForOrdering(scope, result.files, inputs);
  const ordered = orderCandidatesForSearch(
    result.files,
    inputs.query,
    inputs.policy,
    0,
    0,
    result.depthPruned,
    result.maxFilesPruned,
    contentScores,
  );
  return {
    files: ordered.files,
    truncated: result.truncated || result.depthPruned > 0 || result.maxFilesPruned > 0,
    diagnostics: ordered.diagnostics,
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
  readonly signal?: AbortSignal | undefined;
  readonly matcher: LineMatcher;
  readonly fingerprint: string;
  readonly policy: SearchPolicy;
  readonly query: RetrievalQuery;
}

export interface RunState {
  filesScanned: number;
  matchesReturned: number;
  oversizedFilesScanned?: number | undefined;
  truncated: boolean;
}

export function elapsed(runner: SearchTextRunner): number {
  return runner.nowMs() - runner.startMs;
}

function isRunnerAborted(runner: SearchTextRunner): boolean {
  return runner.signal?.aborted === true;
}

export function hitLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (isRunnerAborted(runner)) {
    state.truncated = true;
    return true;
  }
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

export function hitScanLimit(runner: SearchTextRunner, state: RunState): boolean {
  if (isRunnerAborted(runner)) {
    state.truncated = true;
    return true;
  }
  if (state.filesScanned >= runner.limits.maxFilesScanned) {
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
  if (isRunnerAborted(runner)) {
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

// Returns true for NodeJS.ErrnoException (EACCES, ENOENT, EIO, …). Checked by the presence of a
// string `code` property so TypeError and other programmer errors are NOT swallowed.
export function isIoError(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  const { code } = err as Record<"code", unknown>;
  return typeof code === "string";
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/�+$/u, "");
}

async function readOversizePrefix(
  runner: SearchTextRunner,
  relativePath: string,
): Promise<string | undefined> {
  const readFileBytes = runner.fs.readFileBytes;
  if (readFileBytes === undefined) {
    return undefined;
  }
  const abs = resolveWithinWorkspace(runner.scope.workspace.root, relativePath);
  const contained = containedRealPathInfo(runner.fs, runner.scope.workspace.root, abs);
  try {
    const bytes = await readFileBytes(contained.path, runner.limits.maxBytesPerFileScanned);
    return redact(decodeUtf8Prefix(bytes));
  } catch (err) {
    if (isIoError(err)) {
      return undefined;
    }
    throw err;
  }
}

async function readForScan(
  runner: SearchTextRunner,
  relativePath: string,
  state: RunState,
  candidates: CandidateFile[],
): Promise<string | undefined> {
  try {
    return readWorkspaceFile(
      runner.scope.workspace,
      relativePath,
      { maxBytes: runner.limits.maxBytesPerFileScanned },
      runner.fs,
    ).text;
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      state.truncated = true;
      const prefix = await readOversizePrefix(runner, relativePath);
      if (prefix !== undefined) {
        state.oversizedFilesScanned = (state.oversizedFilesScanned ?? 0) + 1;
        return prefix;
      }
      candidates.push(buildCandidate(relativePath, "size-exceeded"));
      return undefined;
    }
    // TOCTOU: permissions or availability may change between discovery and read.
    // A single unreadable file must degrade to a skip, not crash the whole scan.
    if (isIoError(err)) {
      candidates.push(buildCandidate(relativePath, "tool-unavailable"));
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
        lineRange: { startLine: match.line, endLine: match.endLine },
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

export interface FileMatches {
  readonly relativePath: string;
  readonly order: number;
  readonly best: readonly ScoredLine[];
  readonly maxScore: number;
}

function maxLineScore(best: readonly ScoredLine[]): number {
  return best.reduce((max, line) => Math.max(max, line.score), 0);
}

function scanLines(runner: SearchTextRunner, text: string, state: RunState): readonly ScoredLine[] {
  return collectBestLines(runner, text, state);
}

function filePolicyOmission(
  runner: SearchTextRunner,
  file: DiscoveredFile,
): { readonly omitted?: CandidateOmissionReason | undefined; readonly path?: string | undefined } {
  if (isImageScopePath(file.relativePath)) {
    return { omitted: "binary" };
  }
  if (isDenied(file.relativePath)) {
    return { omitted: "ignored" };
  }
  const abs = resolveWithinWorkspace(runner.scope.workspace.root, file.relativePath);
  const contained = containedRealPathInfo(runner.fs, runner.scope.workspace.root, abs);
  const realRel = normalizeScopePath(contained.realRelative);
  if (isDenied(realRel)) {
    return { omitted: "ignored" };
  }
  return { omitted: policyOmissionReason(file.relativePath, runner.policy), path: contained.path };
}

async function binaryOmission(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  path: string,
): Promise<CandidateOmissionReason | undefined> {
  try {
    return (await probeBinary(runner.fs, path, file.sizeBytes)) ? "binary" : undefined;
  } catch (err) {
    // TOCTOU: file may have become unreadable (EACCES, ENOENT, …) between discovery and probe.
    if (isIoError(err)) {
      return "tool-unavailable";
    }
    throw err;
  }
}

export async function scanFile(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  const matches = await collectFileMatches(runner, file, state, candidates, 0);
  if (matches !== undefined) {
    emitFileMatches(runner, state, atoms, matches);
  }
}

export async function collectFileMatches(
  runner: SearchTextRunner,
  file: DiscoveredFile,
  state: RunState,
  candidates: CandidateFile[],
  order: number,
): Promise<FileMatches | undefined> {
  if (isRunnerAborted(runner)) {
    state.truncated = true;
    return undefined;
  }
  const policy = filePolicyOmission(runner, file);
  if (policy.omitted !== undefined) {
    candidates.push(buildCandidate(file.relativePath, policy.omitted));
    return undefined;
  }
  const binary =
    policy.path === undefined ? "binary" : await binaryOmission(runner, file, policy.path);
  if (binary !== undefined) {
    candidates.push(buildCandidate(file.relativePath, binary));
    return undefined;
  }
  if (isRunnerAborted(runner)) {
    state.truncated = true;
    return undefined;
  }
  state.filesScanned += 1;
  const text = await readForScan(runner, file.relativePath, state, candidates);
  if (text === undefined || !shouldScoreContent(runner.query, text, runner.policy)) {
    return undefined;
  }
  const best = scanLines(runner, text, state);
  if (best.length === 0) {
    return undefined;
  }
  return { relativePath: file.relativePath, order, best, maxScore: maxLineScore(best) };
}

export function emitFileMatches(
  runner: SearchTextRunner,
  state: RunState,
  atoms: EvidenceAtom[],
  matches: FileMatches,
): void {
  emitBestLines(runner, matches.relativePath, state, atoms, matches.best);
}
