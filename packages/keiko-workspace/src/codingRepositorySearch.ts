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

import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
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
  const finalObservation = projectionObservation(observation, context, projected.truncated);
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
  truncated: boolean,
): CodingRepositorySearchObservation {
  return {
    metrics: {
      ...observation.metrics,
      durationMs: Math.max(0, context.control.nowMs() - context.startedAtMs),
    },
    diagnostics: {
      ...observation.diagnostics,
      coverageIncomplete: observation.diagnostics.coverageIncomplete || truncated,
      coverageReasons: truncated
        ? [...new Set([...observation.diagnostics.coverageReasons, "timeout" as const])]
        : observation.diagnostics.coverageReasons,
    },
  };
}

async function projectSearchHits(
  context: CodingRepositoryContext,
  query: RetrievalQuery,
  atoms: readonly EvidenceAtom[],
  literal: boolean,
): Promise<{ readonly hits: readonly CodingRepositoryHit[]; readonly truncated: boolean }> {
  const control = { ...context.control, deadlineAtMs: context.projectionDeadlineAtMs };
  const projection = { ...context, fs: executionControlledWorkspaceFs(context.fs, control) };
  const hits: CodingRepositoryHit[] = [];
  for (const atom of atoms) {
    assertStructuralExecutionActive(context.control);
    try {
      assertStructuralExecutionActive(control);
      hits.push(await projectSearchHit(projection, query, atom, literal));
    } catch (error) {
      assertStructuralExecutionActive(context.control);
      if (error instanceof StructuralExecutionStoppedError && error.reason === "timeout") {
        return { hits, truncated: true };
      }
      throw error;
    }
  }
  return { hits, truncated: false };
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

async function projectSearchHit(
  context: CodingRepositoryContext,
  query: RetrievalQuery,
  atom: EvidenceAtom,
  literal: boolean,
): Promise<CodingRepositoryHit> {
  if (atom.lineRange === undefined)
    throw new WorkspaceReadError("search coordinate missing", atom.scopePath);
  const text = await readCodingText(context, atom.scopePath);
  const range = atom.lineRange;
  const matcher = buildMatcher(query, literal ? { kind: "literal" } : undefined);
  const sourceLines =
    query.kind === "natural-language" ? repositorySourceLines(text, atom.scopePath) : undefined;
  if (
    !repositoryPhysicalLines(text)
      .slice(range.startLine - 1, range.endLine)
      .some((line, index) => matcher.match(line, sourceLines?.[range.startLine - 1 + index]) > 0)
  ) {
    throw new WorkspaceReadError("search source changed", atom.scopePath);
  }
  return codingRepositoryExcerpt(
    atom.scopePath,
    text,
    range.startLine,
    range.endLine,
    CODING_REPOSITORY_LIMITS.snippetBytes,
  );
}
