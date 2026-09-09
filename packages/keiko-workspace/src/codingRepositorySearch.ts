import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CODING_REPOSITORY_LIMITS,
  captureCodingRepositoryRequest,
  type CodingRepositoryHit,
  type CodingRepositoryReadRequest,
  type CodingRepositoryRequest,
  type CodingRepositoryResult,
  type CodingRepositorySearchRequest,
  type CodingRepositoryTruncationReason,
} from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { readWorkspaceFileForEditing } from "./discovery.js";
import { WorkspaceReadError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import {
  searchText,
  type SearchLimits,
  type SearchScope,
  type SearchResult,
} from "./repoSearch.js";
import { deriveCandidateSetFromInventory, type CandidateSet } from "./repoSearchScan.js";
import {
  assertStructuralExecutionActive,
  executionControlledWorkspaceFs,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import type { WorkspaceInfo } from "./types.js";
import { codingRepositoryInventory } from "./codingRepositorySearchInventory.js";
import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import {
  boundCodingRepositoryResult,
  searchTruncationReasons,
} from "./codingRepositorySearchResult.js";
import { buildMatcher } from "./repoSearchMatchers.js";
import { looksBinary } from "./binaryDetect.js";
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
    deadlineAtMs: Math.min(
      startedAtMs + CODING_REPOSITORY_LIMITS.elapsedMs,
      options.deadlineAtMs ?? Infinity,
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return {
    scope: { workspace, scopeId: "coding-repository-handler", relativePaths: [] },
    fs: executionControlledWorkspaceFs(options.fs ?? nodeWorkspaceFs, control),
    control,
    startedAtMs,
  };
}

function retrievalKind(mode: CodingRepositorySearchRequest["mode"]): RetrievalQuery["kind"] {
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

function readHit(
  context: CodingRepositoryContext,
  path: string,
  startLine: number,
  endLine: number,
  maxBytes: number,
): CodingRepositoryHit {
  const raw = readWorkspaceFileForEditing(
    context.scope.workspace,
    path,
    { maxBytes: CODING_REPOSITORY_LIMITS.fileBytes },
    context.fs,
  );
  if (looksBinary(new TextEncoder().encode(raw.rawText)))
    throw new WorkspaceReadError("non-text source", path);
  return codingRepositoryExcerpt(path, raw.rawText, startLine, endLine, maxBytes);
}

async function searchHits(
  context: CodingRepositoryContext,
  request: CodingRepositorySearchRequest,
): Promise<CodingRepositoryResult> {
  const query = retrievalQuery(request, context.startedAtMs);
  const discovered = await codingRepositoryInventory(
    context.scope,
    query,
    context.fs,
    context.control,
  );
  assertStructuralExecutionActive(context.control);
  const files = discovered.files.filter(
    (file) => file.sizeBytes <= CODING_REPOSITORY_LIMITS.fileBytes,
  );
  const skippedFiles = discovered.files.length - files.length;
  const inventory = { ...discovered, files };
  const result = await searchInventory(context, request, query, inventory);
  assertStructuralExecutionActive(context.control);
  const hits = result.atoms.map((atom): CodingRepositoryHit =>
    projectSearchHit(context, query, atom, request.mode === "literal"),
  );
  const truncationReasons = searchTruncationReasons(result, discovered, skippedFiles);
  return boundCodingRepositoryResult({
    ok: true,
    kind: "search",
    hits,
    truncationReasons,
    metrics: {
      candidatesDiscovered: discovered.diagnostics.filesDiscovered,
      filesScanned: result.filesScanned,
      skippedFiles:
        skippedFiles + result.candidates.filter((file) => file.omitted !== undefined).length,
      durationMs: Math.max(0, context.control.nowMs() - context.startedAtMs),
    },
  });
}

function readLines(
  context: CodingRepositoryContext,
  request: CodingRepositoryReadRequest,
): CodingRepositoryResult {
  const excerpt = readHit(
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
        : readLines(context, captured);
    assertStructuralExecutionActive(context.control);
    return result;
  } catch (error) {
    throw codingRepositoryFailure(error, context.control);
  }
}

async function searchInventory(
  context: CodingRepositoryContext,
  request: CodingRepositorySearchRequest,
  query: RetrievalQuery,
  inventory: CandidateSet,
): Promise<SearchResult> {
  return searchText(context.scope, query, LIMITS, {
    ...(request.mode === "literal" ? { queryInterpretation: { kind: "literal" } as const } : {}),
    fs: context.fs,
    nowMs: context.control.nowMs,
    deadlineAtMs: context.control.deadlineAtMs,
    ...(context.control.signal === undefined ? {} : { signal: context.control.signal }),
    contentLane: "editor",
    searchHints: { retrievalIntent: "targeted-code-search" },
    candidatePathGlobs: { include: request.includeGlobs, exclude: request.excludeGlobs },
    candidateSetFor: (candidateQuery, limits, policy, predicate): CandidateSet =>
      deriveCandidateSetFromInventory({
        scope: context.scope,
        query: candidateQuery,
        limits,
        policy,
        fs: context.fs,
        inventory,
        candidatePathPredicate: predicate,
        prescoreContent: false,
        executionControl: context.control,
      }),
  });
}

function projectSearchHit(
  context: CodingRepositoryContext,
  query: RetrievalQuery,
  atom: EvidenceAtom,
  literal: boolean,
): CodingRepositoryHit {
  if (atom.lineRange === undefined)
    throw new WorkspaceReadError("search coordinate missing", atom.scopePath);
  const raw = readWorkspaceFileForEditing(
    context.scope.workspace,
    atom.scopePath,
    { maxBytes: CODING_REPOSITORY_LIMITS.fileBytes },
    context.fs,
  );
  const range = atom.lineRange;
  const matcher = buildMatcher(query, literal ? { kind: "literal" } : undefined);
  if (
    !raw.rawText
      .split("\n")
      .slice(range.startLine - 1, range.endLine)
      .some((line) => matcher.match(line) > 0)
  ) {
    throw new WorkspaceReadError("search source changed", atom.scopePath);
  }
  return codingRepositoryExcerpt(
    atom.scopePath,
    raw.rawText,
    range.startLine,
    range.endLine,
    CODING_REPOSITORY_LIMITS.snippetBytes,
  );
}
