// Governed, deterministic, audit-friendly repository search facade (Epic #177, Issue #179).
// Composes the existing workspace primitives — discovery, deny policy, realpath gate,
// readWorkspaceFile, plus the new binaryDetect and stableId modules — into three public
// APIs that emit normalized EvidenceAtom output: searchText, findFiles, readExcerpt.
// Pure JS (no subprocess, no ripgrep — deferred). Every fs touch goes through the
// WorkspaceFs port. Stable IDs are reproducible across runs given the same inputs.

import type {
  CandidateFile,
  EvidenceAtom,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  isValidScopePath,
  validateRetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { readWorkspaceFile } from "./discovery.js";
import {
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
} from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import { buildMatcher, compileGlob, fingerprintFor } from "./repoSearchMatchers.js";
import {
  buildAtom,
  buildCandidate,
  elapsed,
  gatherCandidates,
  hitLimit,
  isImageScopePath,
  isIoError,
  probeBinary,
  scanFile,
  type CandidateSet,
  type RunState,
  type SearchTextRunner,
} from "./repoSearchScan.js";
import {
  policyOmissionReason,
  resolveSearchPolicy,
  type SearchDiagnostics,
  type SearchHints,
} from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SearchScope {
  readonly workspace: WorkspaceInfo;
  readonly scopeId: string;
  readonly relativePaths: readonly string[];
}

export interface SearchLimits {
  readonly maxFilesScanned: number;
  readonly maxMatchesReturned: number;
  readonly maxBytesPerFileScanned: number;
  readonly elapsedMsMax: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxFilesScanned: 2_000,
  maxMatchesReturned: 200,
  maxBytesPerFileScanned: 524_288,
  elapsedMsMax: 5_000,
} as const;

// Upper bound (2 MiB) on how many bytes of a file readExcerpt will load to reach a requested line
// window. The returned excerpt content is still clamped to the caller's request.maxBytes; this cap
// only governs how deep into a file we can slice. Decoupling it from request.maxBytes lets excerpts
// be read from files far larger than a single excerpt budget (a 16 KiB doc was previously unreadable
// and crashed the grounded request — Epic #177). Kept in step with the planner's 2 MiB scan cap so
// any file the search can match can also be excerpted. Files larger than this raise
// FileTooLargeError, which callers handle as a graceful omission.
const MAX_EXCERPT_FILE_BYTES = 2_097_152;

export interface SearchResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly filesScanned: number;
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly diagnostics: SearchDiagnostics | undefined;
}

export interface ReadExcerptRequest {
  readonly scopePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
}

export interface ReadExcerptResult {
  readonly atom: EvidenceAtom;
  readonly content: string;
  readonly truncated: boolean;
}

interface FacadeDeps {
  readonly fs?: WorkspaceFs;
  readonly nowMs?: () => number;
  readonly searchHints?: SearchHints | undefined;
  readonly signal?: AbortSignal;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function clampToBytes(text: string, maxBytes: number): { excerpt: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { excerpt: "", truncated: true };
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { excerpt: text, truncated: false };
  }
  const buffer = encoded.subarray(0, maxBytes);
  const excerpt = new TextDecoder("utf-8", { fatal: false }).decode(buffer).replace(/�+$/u, "");
  return { excerpt, truncated: true };
}

function assertQuery(query: RetrievalQuery): void {
  const result = validateRetrievalQuery(query);
  if (!result.ok) {
    throw new RepoSearchInvalidQueryError(`query invalid: ${result.reasons.join(", ")}`);
  }
}

function assertWorkspaceRoot(workspace: WorkspaceInfo): void {
  if (workspace.root.length === 0) {
    throw new RepoSearchInvalidQueryError("scope.workspace.root is empty");
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortedSearchResult(elapsedMs: number): SearchResult {
  return {
    atoms: [],
    candidates: [],
    filesScanned: 0,
    elapsedMs,
    truncated: true,
    diagnostics: undefined,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Yields to the event loop every SCAN_YIELD_INTERVAL files so a large cold NFS/SMB workspace
// cannot block the event loop for multiple seconds. discoverFiles() itself remains synchronous
// (sync walk is load-bearing for importGraph/testSourcePairing callers); the yield here covers
// the already-async per-file scan pass where the loop overhead is measurable.
const SCAN_YIELD_INTERVAL = 64;

function buildSearchTextRunner(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  deps: Required<Pick<FacadeDeps, "fs" | "nowMs">> & Pick<FacadeDeps, "searchHints" | "signal">,
): SearchTextRunner {
  return {
    scope,
    limits: {
      ...limits,
      maxMatchesReturned: Math.min(limits.maxMatchesReturned, query.maxResults),
    },
    fs: deps.fs,
    nowMs: deps.nowMs,
    startMs: deps.nowMs(),
    signal: deps.signal,
    matcher: buildMatcher(query),
    fingerprint: fingerprintFor(query),
    policy: resolveSearchPolicy(scope.relativePaths.length > 0, deps.searchHints),
    query,
  };
}

async function runScanLoop(
  runner: SearchTextRunner,
  candidateSet: CandidateSet,
  state: RunState,
  atoms: EvidenceAtom[],
  candidates: CandidateFile[],
): Promise<void> {
  let loopIndex = 0;
  for (const file of candidateSet.files) {
    if (hitLimit(runner, state)) {
      break;
    }
    loopIndex += 1;
    if (loopIndex % SCAN_YIELD_INTERVAL === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (hitLimit(runner, state)) {
        break;
      }
    }
    await scanFile(runner, file, state, atoms, candidates);
  }
}

export async function searchText(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertQuery(query);
  if (query.kind === "file-pattern") {
    throw new RepoSearchInvalidQueryError("searchText does not accept file-pattern queries");
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  const runner = buildSearchTextRunner(scope, query, limits, {
    fs,
    nowMs,
    ...(deps.searchHints !== undefined ? { searchHints: deps.searchHints } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  if (isAborted(deps.signal)) {
    return abortedSearchResult(elapsed(runner));
  }
  const candidateSet: CandidateSet = gatherCandidates(scope, query, limits, fs, runner.policy);
  if (isAborted(deps.signal)) {
    return { ...abortedSearchResult(elapsed(runner)), diagnostics: candidateSet.diagnostics };
  }
  const atoms: EvidenceAtom[] = [];
  const candidates: CandidateFile[] = [];
  // Seed truncated from candidate gathering so a scope.relativePaths cap is preserved.
  const state: RunState = {
    filesScanned: 0,
    matchesReturned: 0,
    truncated: candidateSet.truncated,
  };
  await runScanLoop(runner, candidateSet, state, atoms, candidates);
  return {
    atoms,
    candidates,
    filesScanned: state.filesScanned,
    elapsedMs: elapsed(runner),
    truncated: state.truncated,
    diagnostics: candidateSet.diagnostics,
  };
}

interface FindFilesContext {
  readonly scope: SearchScope;
  readonly regex: RegExp;
  readonly fingerprint: string;
  readonly nowMs: () => number;
}

interface FindFilesState {
  readonly atoms: EvidenceAtom[];
  readonly candidates: CandidateFile[];
  filesScanned: number;
  truncated: boolean;
}

function emitFileListing(ctx: FindFilesContext, relativePath: string, atoms: EvidenceAtom[]): void {
  atoms.push(
    buildAtom({
      scopeId: ctx.scope.scopeId,
      scopePath: relativePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      tool: "repo.findFiles",
      queryFingerprint: ctx.fingerprint,
      score: 1,
      emittedAtMs: ctx.nowMs(),
    }),
  );
}

function hitFileListingLimit(
  state: FindFilesState,
  maxMatches: number,
  startMs: number,
  nowMs: () => number,
  limits: SearchLimits,
  signal?: AbortSignal,
): boolean {
  return (
    isAborted(signal) ||
    state.atoms.length >= maxMatches ||
    nowMs() - startMs > limits.elapsedMsMax
  );
}

function collectFileListings(
  ctx: FindFilesContext,
  candidateSet: CandidateSet,
  policy: ReturnType<typeof resolveSearchPolicy>,
  inputs: {
    readonly limits: SearchLimits;
    readonly maxMatches: number;
    readonly startMs: number;
    readonly signal?: AbortSignal;
  },
): FindFilesState {
  const state: FindFilesState = {
    atoms: [],
    candidates: [],
    filesScanned: 0,
    truncated: candidateSet.truncated,
  };
  for (const file of candidateSet.files) {
    if (hitFileListingLimit(state, inputs.maxMatches, inputs.startMs, ctx.nowMs, inputs.limits, inputs.signal)) {
      state.truncated = true;
      break;
    }
    if (isDenied(file.relativePath)) {
      state.candidates.push(buildCandidate(file.relativePath, "ignored"));
      continue;
    }
    const omitted = policyOmissionReason(file.relativePath, policy);
    if (omitted !== undefined) {
      state.candidates.push(buildCandidate(file.relativePath, omitted));
      continue;
    }
    state.filesScanned += 1;
    if (ctx.regex.test(file.relativePath)) {
      emitFileListing(ctx, file.relativePath, state.atoms);
    }
  }
  return state;
}

function findFilesSync(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  nowMs: () => number,
  hints: SearchHints | undefined,
  signal?: AbortSignal,
): SearchResult {
  const startMs = nowMs();
  if (isAborted(signal)) {
    return abortedSearchResult(0);
  }
  // Honor the per-query cap alongside the global limit (Finding 2).
  const effectiveMaxMatches = Math.min(limits.maxMatchesReturned, query.maxResults);
  const ctx: FindFilesContext = {
    scope,
    regex: compileGlob(query.text, query.caseSensitive),
    fingerprint: fingerprintFor(query),
    nowMs,
  };
  const policy = resolveSearchPolicy(scope.relativePaths.length > 0, hints);
  const candidateSet: CandidateSet = gatherCandidates(scope, query, limits, fs, policy);
  if (isAborted(signal)) {
    return { ...abortedSearchResult(nowMs() - startMs), diagnostics: candidateSet.diagnostics };
  }
  const state = collectFileListings(ctx, candidateSet, policy, {
    limits,
    maxMatches: effectiveMaxMatches,
    startMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  return {
    atoms: state.atoms,
    candidates: state.candidates,
    filesScanned: state.filesScanned,
    elapsedMs: nowMs() - startMs,
    truncated: state.truncated,
    diagnostics: candidateSet.diagnostics,
  };
}

export async function findFiles(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
  deps: FacadeDeps = {},
): Promise<SearchResult> {
  assertWorkspaceRoot(scope.workspace);
  assertQuery(query);
  if (query.kind !== "file-pattern") {
    throw new RepoSearchInvalidQueryError("findFiles requires a file-pattern query");
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  return await Promise.resolve(
    findFilesSync(scope, query, limits, fs, nowMs, deps.searchHints, deps.signal),
  );
}

function buildExcerptFingerprint(request: ReadExcerptRequest): string {
  return fingerprintFor({
    kind: "natural-language",
    text: `${request.scopePath}:${request.startLine.toString()}-${request.endLine.toString()}`,
    caseSensitive: false,
    maxResults: 1,
    emittedAtMs: 0,
  });
}

function isWithinSelectedScope(scope: SearchScope, scopePath: string): boolean {
  if (scope.relativePaths.length === 0) {
    return true;
  }
  return scope.relativePaths.some(
    (selectedPath) => scopePath === selectedPath || scopePath.startsWith(`${selectedPath}/`),
  );
}

function normalizeScopePath(scopePath: string): string {
  return scopePath.split("\\").join("/");
}

function assertExcerptWithinSelectedScope(scope: SearchScope, scopePath: string): void {
  if (isWithinSelectedScope(scope, scopePath)) {
    return;
  }
  throw new RepoSearchUnsupportedFileError(
    `cannot read excerpt outside selected scope: ${scopePath}`,
    "outside-scope",
  );
}

function resolveExcerptTarget(
  scope: SearchScope,
  scopePath: string,
  fs: WorkspaceFs,
): { readonly path: string; readonly realScopePath: string } {
  const abs = resolveWithinWorkspace(scope.workspace.root, scopePath);
  const contained = containedRealPathInfo(fs, scope.workspace.root, abs);
  const realScopePath = normalizeScopePath(contained.realRelative);
  return { path: contained.path, realScopePath };
}

function assertExcerptReadableByPolicy(requestPath: string, realScopePath: string): void {
  // Deny gates must fire BEFORE any byte read (incl. the binary probe) so that a denied path such
  // as .env is never read at all, including through an in-workspace symlink. .gitignore is not a
  // context policy boundary; safe ignored/dot files remain readable when the user scopes them in.
  if (isDenied(requestPath) || isDenied(realScopePath)) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of denied path: ${requestPath}`,
      "denied",
    );
  }
}

function assertExcerptRange(request: ReadExcerptRequest): void {
  if (
    !Number.isInteger(request.startLine) ||
    !Number.isInteger(request.endLine) ||
    request.startLine < 1 ||
    request.endLine < request.startLine
  ) {
    throw new RepoSearchInvalidRangeError(
      `invalid line range: ${request.startLine.toString()}-${request.endLine.toString()}`,
    );
  }
  if (
    !Number.isFinite(request.maxBytes) ||
    !Number.isInteger(request.maxBytes) ||
    request.maxBytes < 0
  ) {
    throw new RepoSearchInvalidRangeError(
      `invalid maxBytes: ${String(request.maxBytes)} (must be a finite non-negative integer)`,
    );
  }
  if (!isValidScopePath(request.scopePath, { mustBeRelative: true })) {
    throw new RepoSearchInvalidRangeError(`invalid scopePath: ${request.scopePath}`);
  }
}

// Probes for binary content and throws RepoSearchUnsupportedFileError on both binary detection
// and IO errors (EACCES, ENOENT, …) so the caller can treat both as a graceful skip.
async function assertExcerptNotBinary(
  fs: WorkspaceFs,
  absolutePath: string,
  size: number,
  scopePath: string,
): Promise<void> {
  let isBinary: boolean;
  try {
    isBinary = await probeBinary(fs, absolutePath, size);
  } catch (err) {
    // TOCTOU: permissions or availability may change between stat and probe (EACCES, ENOENT, …).
    // Re-classify as an unsupported-file skip so readKeptExcerpts degrades gracefully instead
    // of crashing the whole grounded answer (the comment at grounded-orchestrator readKeptExcerpts
    // explicitly promises this invariant).
    if (isIoError(err)) {
      throw new RepoSearchUnsupportedFileError(
        `cannot read excerpt of unreadable file: ${scopePath}`,
        "io-error",
      );
    }
    throw err;
  }
  if (isBinary) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of binary file: ${scopePath}`,
      "binary",
    );
  }
}

export async function readExcerpt(
  scope: SearchScope,
  request: ReadExcerptRequest,
  deps: FacadeDeps = {},
): Promise<ReadExcerptResult> {
  if (isAborted(deps.signal)) {
    throw new RepoSearchUnsupportedFileError("repo-search operation aborted", "aborted");
  }
  assertExcerptRange(request);
  assertWorkspaceRoot(scope.workspace);
  assertExcerptWithinSelectedScope(scope, request.scopePath);
  if (isImageScopePath(request.scopePath)) {
    throw new RepoSearchUnsupportedFileError(
      `cannot read excerpt of image file: ${request.scopePath}`,
      "binary",
    );
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const nowMs = deps.nowMs ?? Date.now;
  const target = resolveExcerptTarget(scope, request.scopePath, fs);
  assertExcerptReadableByPolicy(request.scopePath, target.realScopePath);
  assertExcerptWithinSelectedScope(scope, target.realScopePath);
  const stat = fs.stat(target.path);
  await assertExcerptNotBinary(fs, target.path, stat.size, request.scopePath);
  if (isAborted(deps.signal)) {
    throw new RepoSearchUnsupportedFileError("repo-search operation aborted", "aborted");
  }
  // Read enough of the file to reach the requested line window (bounded by MAX_EXCERPT_FILE_BYTES),
  // then clamp the returned content to the caller's request.maxBytes budget. The read cap is
  // intentionally larger than request.maxBytes so a window deep in a multi-kibibyte file is still
  // reachable instead of the whole file being rejected.
  const content = readWorkspaceFile(
    scope.workspace,
    request.scopePath,
    { maxBytes: MAX_EXCERPT_FILE_BYTES },
    fs,
  );
  const allLines = content.text.split("\n");
  const slice = allLines.slice(request.startLine - 1, request.endLine).join("\n");
  const clamped = clampToBytes(slice, request.maxBytes);
  const atom = buildAtom({
    scopeId: scope.scopeId,
    scopePath: request.scopePath,
    lineRange: { startLine: request.startLine, endLine: request.endLine },
    provenanceKind: "excerpt-read",
    tool: "repo.readExcerpt",
    queryFingerprint: buildExcerptFingerprint(request),
    score: 1,
    emittedAtMs: nowMs(),
  });
  return { atom, content: clamped.excerpt, truncated: clamped.truncated };
}
