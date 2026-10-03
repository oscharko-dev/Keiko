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
import { readWorkspaceFileBytesPrefixForInternalUse } from "./discovery.js";
import { FileTooLargeError, WorkspaceReadError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { searchText, type SearchLimits, type SearchScope } from "./repoSearch.js";
import { isImageScopePath } from "./repoSearchScan.js";
import {
  assertStructuralExecutionActive,
  executionControlledWorkspaceFs,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import type { WorkspaceInfo } from "./types.js";

import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import { boundCodingRepositoryResult } from "./codingRepositorySearchResult.js";
import { buildMatcher } from "./repoSearchMatchers.js";
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
      startedAtMs + (CODING_REPOSITORY_LIMITS.elapsedMs ?? Infinity),
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
  const read = await readWorkspaceFileBytesPrefixForInternalUse(
    context.scope.workspace,
    path,
    CODING_REPOSITORY_LIMITS.fileBytes,
    context.fs,
  );
  if (!read.complete) {
    throw new FileTooLargeError(
      "file exceeds coding size cap",
      path,
      read.stat.size,
      CODING_REPOSITORY_LIMITS.fileBytes,
    );
  }
  const decoded = decodeTextFileBytes(read.bytes, { scopePath: path });
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
    deadlineAtMs: context.control.deadlineAtMs,
    ...(context.control.signal === undefined ? {} : { signal: context.control.signal }),
    contentLane: "editor",
    searchHints: { retrievalIntent: "targeted-code-search" },
    candidatePathGlobs: { include: request.includeGlobs, exclude: request.excludeGlobs },
  });
  assertStructuralExecutionActive(context.control);
  const hits: CodingRepositoryHit[] = [];
  for (const atom of result.atoms) {
    hits.push(await projectSearchHit(context, query, atom, request.mode === "literal"));
  }
  const truncationReasons: CodingRepositoryTruncationReason[] = [];
  if (result.candidates.some((file) => file.omitted === "size-exceeded"))
    truncationReasons.push("file-too-large");
  if (result.coverage.reasons.includes("match-cap")) truncationReasons.push("result-limit");
  return boundCodingRepositoryResult({
    ok: true,
    kind: "search",
    hits,
    truncationReasons,
    metrics: {
      candidatesDiscovered: result.coverage.filesDiscovered,
      filesScanned: result.filesScanned,
      skippedFiles: result.coverage.filesSkipped,
      durationMs: Math.max(0, context.control.nowMs() - context.startedAtMs),
    },
  });
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
  if (
    !text
      .split("\n")
      .slice(range.startLine - 1, range.endLine)
      .some((line) => matcher.match(line) > 0)
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
