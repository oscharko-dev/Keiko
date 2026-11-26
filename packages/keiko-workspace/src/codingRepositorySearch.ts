import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CODING_REPOSITORY_LIMITS,
  captureCodingRepositoryRequest,
  type CodingRepositoryHit,
  type CodingRepositoryReadRequest,
  type CodingRepositoryRequest,
  type CodingRepositoryResult,
  type CodingRepositorySearchRequest,
  type CodingRepositorySearchObservation,
  type CodingRepositoryTruncationReason,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { readWorkspaceFileBytesForTextInspection } from "./discovery.js";
import { FileTooLargeError, WorkspaceReadError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import {
  searchText,
  type SearchLimits,
  type SearchScope,
  type SearchResult,
} from "./repoSearch.js";
import { isImageScopePath } from "./repoSearchScan.js";
import {
  assertStructuralExecutionActive,
  executionControlledWorkspaceFs,
  StructuralExecutionStoppedError,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import type { WorkspaceInfo } from "./types.js";

import {
  codingRepositoryExcerpt,
  codingRepositorySourceExcerpt,
  prepareCodingRepositorySource,
  type CodingRepositorySource,
} from "./codingRepositorySearchProjection.js";
import { boundCodingRepositoryResult } from "./codingRepositorySearchResult.js";
import { buildMatcher } from "./repoSearchMatchers.js";
import { repositoryPhysicalLines } from "./repoSearchLineSelection.js";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";
import { decodeTextFileBytes } from "./binaryDetect.js";
import {
  CodingRepositorySearchError,
  codingRepositoryFailure,
} from "./codingRepositorySearchError.js";
export { CodingRepositorySearchError } from "./codingRepositorySearchError.js";

export interface CodingRepositorySearchOptions {
  readonly fs?: WorkspaceFs | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly deadlineAtMs?: number | undefined;
  /** Soft phases within the caller's hard deadline; neither is a corpus eligibility limit. */
  readonly scanDeadlineAtMs?: number | undefined;
  readonly projectionDeadlineAtMs?: number | undefined;
  readonly onSearchObservation?:
    ((observation: CodingRepositorySearchObservation) => void) | undefined;
}

export function codingRepositoryBackendReady(options: CodingRepositorySearchOptions = {}): boolean {
  const fs = options.fs ?? nodeWorkspaceFs;
  return (
    typeof fs.readFileBytes === "function" &&
    typeof fs.readFileUtf8SameDescriptor === "function" &&
    typeof fs.readFileUtf8WithinRootSameDescriptor === "function"
  );
}

interface CodingRepositoryContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly control: StructuralExecutionControl;
  readonly startedAtMs: number;
  readonly scanDeadlineAtMs: number;
  readonly projectionDeadlineAtMs: number;
  readonly onSearchObservation: CodingRepositorySearchOptions["onSearchObservation"];
}

const LIMITS: SearchLimits = {
  maxFilesScanned: CODING_REPOSITORY_LIMITS.scannedFiles,
  maxMatchesReturned: CODING_REPOSITORY_LIMITS.returnedHits,
  maxBytesPerFileScanned: CODING_REPOSITORY_LIMITS.fileBytes,
  elapsedMsMax: CODING_REPOSITORY_LIMITS.elapsedMs,
};

function createContext(
  workspace: WorkspaceInfo,
  options: CodingRepositorySearchOptions,
): CodingRepositoryContext {
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  const control = {
    nowMs,
    deadlineAtMs: options.deadlineAtMs ?? Infinity,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return {
    scope: { workspace, scopeId: "coding-repository-handler", relativePaths: [] },
    fs: executionControlledWorkspaceFs(options.fs ?? nodeWorkspaceFs, control),
    control,
    startedAtMs,
    scanDeadlineAtMs: Math.min(options.scanDeadlineAtMs ?? Infinity, control.deadlineAtMs),
    projectionDeadlineAtMs: Math.min(
      options.projectionDeadlineAtMs ?? Infinity,
      control.deadlineAtMs,
    ),
    onSearchObservation: options.onSearchObservation,
  };
}

export function retrievalKind(mode: CodingRepositorySearchRequest["mode"]): RetrievalQuery["kind"] {
  if (mode === "lexical") return "natural-language";
  if (mode === "symbol" || mode === "literal") return "exact-symbol";
  return "regex";
}

function retrievalQuery(request: CodingRepositorySearchRequest, nowMs: number): RetrievalQuery {
  return {
    kind: retrievalKind(request.mode),
    text: request.query,
    caseSensitive: request.caseSensitive,
    maxResults: request.maxResults,
    emittedAtMs: nowMs,
  };
}

async function readCodingText(context: CodingRepositoryContext, path: string): Promise<string> {
  if (isImageScopePath(path)) throw new WorkspaceReadError("non-text source", path);
  const read = await readWorkspaceFileBytesForTextInspection(
    context.scope.workspace,
    path,
    CODING_REPOSITORY_LIMITS.fileBytes,
    context.fs,
  );
  if (read.binary) throw new WorkspaceReadError("non-text source", path);
  if (!read.complete) {
    throw new FileTooLargeError(
      "file exceeds coding size cap",
      path,
      read.stat.size,
      CODING_REPOSITORY_LIMITS.fileBytes,
    );
  }
  const decoded = decodeTextFileBytes(read.bytes, {
    scopePath: path,
    requireSupportedEncoding: true,
  });
  if (decoded === undefined) {
    throw new WorkspaceReadError("non-text source", path);
  }
  return decoded.text;
}

async function readHit(
  context: CodingRepositoryContext,
  path: string,
  startLine: number,
  endLine: number,
  maxBytes: number,
): Promise<CodingRepositoryHit> {
  const text = await readCodingText(context, path);
  return codingRepositoryExcerpt(path, text, startLine, endLine, maxBytes);
}

async function searchHits(
  context: CodingRepositoryContext,
  request: CodingRepositorySearchRequest,
): Promise<CodingRepositoryResult> {
  const query = retrievalQuery(request, context.startedAtMs);
  const result = await searchText(context.scope, query, LIMITS, {
    ...(request.mode === "literal" ? { queryInterpretation: { kind: "literal" } as const } : {}),
    fs: context.fs,
    nowMs: context.control.nowMs,
    deadlineAtMs: context.scanDeadlineAtMs,
    ...(context.control.signal === undefined ? {} : { signal: context.control.signal }),
    contentLane: "editor",
    searchHints: { retrievalIntent: "targeted-code-search" },
    candidatePathGlobs: { include: request.includeGlobs, exclude: request.excludeGlobs },
  });
  const observation = searchObservation(result, context);
  context.onSearchObservation?.(observation);
  assertStructuralExecutionActive(context.control);
  const projected = await projectSearchHits(
    context,
    query,
    result.atoms,
    request.mode === "literal",
  );
  const finalObservation = projectionObservation(observation, context, projected);
  context.onSearchObservation?.(finalObservation);
  return boundCodingRepositoryResult({
    ok: true,
    kind: "search",
    hits: projected.hits,
    truncationReasons: searchTruncationReasons(finalObservation),
    metrics: finalObservation.metrics,
    diagnostics: finalObservation.diagnostics,
  });
}

function searchTruncationReasons(
  observation: CodingRepositorySearchObservation,
): readonly CodingRepositoryTruncationReason[] {
  const truncationReasons: CodingRepositoryTruncationReason[] = [];
  if (observation.diagnostics.oversizedFilesSkipped > 0) truncationReasons.push("file-too-large");
  if (observation.diagnostics.coverageReasons.includes("match-cap"))
    truncationReasons.push("result-limit");
  if (observation.diagnostics.coverageReasons.includes("io-error"))
    truncationReasons.push("io-error");
  if (observation.diagnostics.coverageReasons.includes("timeout"))
    truncationReasons.push("time-limit");
  if (observation.diagnostics.coverageReasons.includes("unrepresentable-path"))
    truncationReasons.push("unrepresentable-path");
  return truncationReasons;
}

function projectionObservation(
  observation: CodingRepositorySearchObservation,
  context: CodingRepositoryContext,
  projected: ProjectedSearchHits,
): CodingRepositorySearchObservation {
  const reasons = observation.diagnostics.coverageReasons;
  const skipped = projected.staleHits + projected.misplacedHits + projected.unreadableHits;
  const added = [
    ...(projected.truncated ? (["timeout"] as const) : []),
    ...(skipped > 0 ? (["io-error"] as const) : []),
  ];
  return {
    metrics: {
      ...observation.metrics,
      durationMs: Math.max(0, context.control.nowMs() - context.startedAtMs),
    },
    diagnostics: {
      ...observation.diagnostics,
      coverageIncomplete: observation.diagnostics.coverageIncomplete || added.length > 0,
      coverageReasons: added.length === 0 ? reasons : [...new Set([...reasons, ...added])],
      staleHitsSkipped: projected.staleHits,
      misplacedHitsSkipped: projected.misplacedHits,
      unreadableHitsSkipped: projected.unreadableHits,
    },
  };
}

interface ProjectionState {
  readonly matcher: ReturnType<typeof buildMatcher>;
  readonly query: RetrievalQuery;
  /**
   * The most recently projected files, so a file's hits share one read, one redaction and one line
   * index. Bounded: each entry holds up to several copies of a file of up to 2 MiB.
   */
  readonly sources: Map<string, ProjectedSource>;
  hits: CodingRepositoryHit[];
  staleHits: number;
  misplacedHits: number;
  unreadableHits: number;
}

interface ProjectedSource {
  readonly prepared: CodingRepositorySource;
  readonly physicalLines: readonly string[];
  readonly sourceLines: ReturnType<typeof repositorySourceLines> | undefined;
}

async function projectSearchHits(
  context: CodingRepositoryContext,
  query: RetrievalQuery,
  atoms: readonly EvidenceAtom[],
  literal: boolean,
): Promise<ProjectedSearchHits> {
  const control = { ...context.control, deadlineAtMs: context.projectionDeadlineAtMs };
  const projection = { ...context, fs: executionControlledWorkspaceFs(context.fs, control) };
  const state: ProjectionState = {
    matcher: buildMatcher(query, literal ? { kind: "literal" } : undefined),
    query,
    sources: new Map(),
    hits: [],
    staleHits: 0,
    misplacedHits: 0,
    unreadableHits: 0,
  };
  for (const atom of atoms) {
    assertStructuralExecutionActive(context.control);
    try {
      assertStructuralExecutionActive(control);
      await projectAtom(projection, state, atom);
    } catch (error) {
      assertStructuralExecutionActive(context.control);
      if (error instanceof StructuralExecutionStoppedError && error.reason === "timeout") {
        return { ...projectedHits(state), truncated: true };
      }
      throw error;
    }
  }
  return { ...projectedHits(state), truncated: false };
}

function projectedHits(state: ProjectionState): Omit<ProjectedSearchHits, "truncated"> {
  return {
    hits: state.hits,
    staleHits: state.staleHits,
    misplacedHits: state.misplacedHits,
    unreadableHits: state.unreadableHits,
  };
}

interface ProjectedSearchHits {
  readonly hits: readonly CodingRepositoryHit[];
  readonly truncated: boolean;
  /** Hits whose file no longer holds the match at all: it changed after the scan. */
  readonly staleHits: number;
  /**
   * Hits whose file still holds the match, but not at the reported lines. With an unchanged file
   * that is a defect in the scan's line selection, so it is counted apart from a stale hit.
   */
  readonly misplacedHits: number;
  /** Hits whose file could no longer be read after the scan. */
  readonly unreadableHits: number;
}

async function projectAtom(
  context: CodingRepositoryContext,
  state: ProjectionState,
  atom: EvidenceAtom,
): Promise<void> {
  const hit = await projectSearchHit(context, state, atom).catch((error: unknown): "unreadable" => {
    // A file the projection can no longer read (it vanished, its identity changed, it is no
    // longer text or exceeds the size cap) loses its hits alone; nothing of it is shown. Denied and
    // escaping paths, timeouts and cancellation are other error classes and still end the search.
    if (error instanceof WorkspaceReadError || error instanceof FileTooLargeError)
      return "unreadable";
    throw error;
  });
  if (hit === "unreadable") state.unreadableHits += 1;
  else if (hit === "stale") state.staleHits += 1;
  else if (hit === "misplaced") state.misplacedHits += 1;
  else state.hits.push(hit);
}

function searchObservation(
  result: SearchResult,
  context: CodingRepositoryContext,
): CodingRepositorySearchObservation {
  return {
    metrics: {
      candidatesDiscovered: result.coverage.filesDiscovered,
      filesScanned: result.filesScanned,
      skippedFiles: result.coverage.filesSkipped,
      durationMs: Math.max(0, context.control.nowMs() - context.startedAtMs),
    },
    diagnostics: { ...searchPolicyObservation(result), ...searchExclusionObservation(result) },
  };
}

function searchPolicyObservation(
  result: SearchResult,
): Pick<
  CodingRepositorySearchObservation["diagnostics"],
  | "policyMode"
  | "lowValuePolicyApplied"
  | "lowValueRescueApplied"
  | "coverageIncomplete"
  | "coverageReasons"
> {
  return {
    policyMode: result.diagnostics?.policyMode ?? "workspace-root-default",
    lowValuePolicyApplied: result.diagnostics?.lowValuePolicyApplied === true,
    lowValueRescueApplied: result.diagnostics?.lowValueRescueFilesScanned !== undefined,
    coverageIncomplete: result.coverage.incomplete,
    coverageReasons: result.coverage.reasons,
  };
}

function searchExclusionObservation(
  result: SearchResult,
): Pick<
  CodingRepositorySearchObservation["diagnostics"],
  | "ignoredEntries"
  | "deniedEntries"
  | "binaryFilesSkipped"
  | "oversizedFilesSkipped"
  | "unreadableFilesSkipped"
  | "staleHitsSkipped"
  | "misplacedHitsSkipped"
  | "unreadableHitsSkipped"
> {
  const exclusions = result.diagnostics?.fileExclusionCounts ?? {
    binary: 0,
    oversized: 0,
    unreadable: 0,
  };
  return {
    ignoredEntries: result.diagnostics?.ignoredByDiscovery ?? 0,
    deniedEntries: result.diagnostics?.deniedByDiscovery ?? 0,
    binaryFilesSkipped: exclusions.binary,
    oversizedFilesSkipped: exclusions.oversized,
    unreadableFilesSkipped: exclusions.unreadable,
    staleHitsSkipped: 0,
    misplacedHitsSkipped: 0,
    unreadableHitsSkipped: 0,
  };
}

async function readLines(
  context: CodingRepositoryContext,
  request: CodingRepositoryReadRequest,
): Promise<CodingRepositoryResult> {
  const excerpt = await readHit(
    context,
    request.path,
    request.startLine,
    request.endLine,
    request.maxBytes,
  );
  const truncationReasons: CodingRepositoryTruncationReason[] = excerpt.snippetTruncated
    ? ["output-limit"]
    : [];
  return boundCodingRepositoryResult({
    ok: true,
    kind: "read",
    excerpt,
    truncationReasons,
    metrics: {
      candidatesDiscovered: 1,
      filesScanned: 1,
      skippedFiles: 0,
      durationMs: Math.max(0, context.control.nowMs() - context.startedAtMs),
    },
  });
}

/** Only redacted display data crosses this workspace-owned raw-coordinate boundary. */
export async function executeCodingRepositoryRequest(
  workspace: WorkspaceInfo,
  request: CodingRepositoryRequest,
  options: CodingRepositorySearchOptions = {},
): Promise<CodingRepositoryResult> {
  const captured = captureCodingRepositoryRequest(request);
  if (captured === undefined) throw new CodingRepositorySearchError("invalid-request");
  if (!codingRepositoryBackendReady(options))
    throw new CodingRepositorySearchError("backend-unavailable");
  const context = createContext(workspace, options);
  try {
    assertStructuralExecutionActive(context.control);
    const result =
      captured.kind === "search"
        ? await searchHits(context, captured)
        : await readLines(context, captured);
    assertStructuralExecutionActive(context.control);
    return result;
  } catch (error) {
    throw codingRepositoryFailure(error, context.control);
  }
}

const PROJECTED_SOURCE_CACHE_FILES = 4;

function matchesWithin(
  state: ProjectionState,
  source: ProjectedSource,
  firstIndex: number,
  lastIndex: number,
): boolean {
  for (let index = Math.max(0, firstIndex); index <= lastIndex; index += 1) {
    const line = source.physicalLines[index];
    if (line === undefined) return false;
    if (state.matcher.match(line, source.sourceLines?.[index]) > 0) return true;
  }
  return false;
}

async function projectedSource(
  context: CodingRepositoryContext,
  state: ProjectionState,
  path: string,
): Promise<ProjectedSource> {
  const cached = state.sources.get(path);
  if (cached !== undefined) {
    // Most recently used last, so the bound below evicts the file used longest ago.
    state.sources.delete(path);
    state.sources.set(path, cached);
    return cached;
  }
  const text = await readCodingText(context, path);
  const source: ProjectedSource = {
    prepared: prepareCodingRepositorySource(text),
    physicalLines: repositoryPhysicalLines(text),
    sourceLines:
      state.query.kind === "natural-language" ? repositorySourceLines(text, path) : undefined,
  };
  state.sources.set(path, source);
  for (const oldest of state.sources.keys()) {
    if (state.sources.size <= PROJECTED_SOURCE_CACHE_FILES) break;
    state.sources.delete(oldest);
  }
  return source;
}

/**
 * The hit's excerpt, or why it is left out: its file no longer holds the match (`stale`), or holds
 * it only outside the reported lines (`misplaced`). Such a hit is never shown, and it no longer
 * fails the search and every other hit with it.
 */
async function projectSearchHit(
  context: CodingRepositoryContext,
  state: ProjectionState,
  atom: EvidenceAtom,
): Promise<CodingRepositoryHit | "stale" | "misplaced"> {
  const range = atom.lineRange;
  if (range === undefined) return "misplaced";
  const source = await projectedSource(context, state, atom.scopePath);
  const firstIndex = range.startLine - 1;
  const lastIndex = range.endLine - 1;
  if (!matchesWithin(state, source, firstIndex, lastIndex)) {
    return matchesWithin(state, source, 0, source.physicalLines.length - 1) ? "misplaced" : "stale";
  }
  return codingRepositorySourceExcerpt(
    atom.scopePath,
    source.prepared,
    range.startLine,
    range.endLine,
    CODING_REPOSITORY_LIMITS.snippetBytes,
  );
}
