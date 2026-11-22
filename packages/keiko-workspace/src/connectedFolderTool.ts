import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  CONNECTED_FOLDER_TOOL_LIMITS,
  captureConnectedFolderToolRequest,
  type ConnectedFolderListRequest,
  type ConnectedFolderReadRequest,
  type ConnectedFolderSearchRequest,
  type ConnectedFolderToolExcerpt,
  type ConnectedFolderToolFailureReason,
  type ConnectedFolderToolRequest,
  type ConnectedFolderToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/connected-folder-tool";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  WorkspaceReadError,
} from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { pathCaseKey, workspacePathCase } from "./pathCase.js";
import { workspaceFsBoundToCanonicalRoot } from "./realpath.js";
import {
  DEFAULT_SEARCH_LIMITS,
  readExcerpt,
  searchText,
  type ReadExcerptResult,
  type SearchScope,
} from "./repoSearch.js";
import { admittedSearchScopeEntry } from "./repoSearchEntries.js";
import {
  assertStructuralExecutionActive,
  StructuralExecutionStoppedError,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import type { WorkspacePathDiscoveryEntry } from "./types.js";
import type { WorkspaceIndex } from "./workspaceIndex.js";
import { discoverWorkspacePaths } from "./workspacePathDiscovery.js";

// The model drives retrieval on a connected folder through three views that compose the existing
// workspace primitives: `discoverWorkspacePaths` (list), `searchText` (search) and `readExcerpt`
// (snippets and read). Containment, the deny-list, ignore rules and the evidence-lane redaction are
// the ones those primitives already enforce; this module adds only the request boundary, the
// selected-scope check for a narrowed directory and one budget shared by all calls of a turn.

export interface ConnectedFolderToolBudgetLimits {
  /** Wall time all search calls of one turn may spend together. */
  readonly searchElapsedMs: number;
  /** UTF-8 bytes of paths and text all calls of one turn may return together. */
  readonly resultBytes: number;
}

export interface ConnectedFolderToolUsage {
  readonly calls: number;
  readonly searchElapsedMs: number;
  readonly resultBytes: number;
}

/** One instance per Chat turn, handed to every call of that turn. */
export interface ConnectedFolderToolBudget {
  readonly remainingSearchMs: () => number;
  readonly remainingResultBytes: () => number;
  readonly charge: (searchElapsedMs: number, resultBytes: number) => void;
  readonly usage: () => ConnectedFolderToolUsage;
}

export function createConnectedFolderToolBudget(
  limits: ConnectedFolderToolBudgetLimits,
): ConnectedFolderToolBudget {
  let calls = 0;
  let searchElapsedMs = 0;
  let resultBytes = 0;
  return {
    remainingSearchMs: (): number => Math.max(0, limits.searchElapsedMs - searchElapsedMs),
    remainingResultBytes: (): number => Math.max(0, limits.resultBytes - resultBytes),
    charge: (elapsedMs: number, bytes: number): void => {
      calls += 1;
      searchElapsedMs += Math.max(0, elapsedMs);
      resultBytes += Math.max(0, bytes);
    },
    usage: (): ConnectedFolderToolUsage => ({ calls, searchElapsedMs, resultBytes }),
  };
}

export interface ConnectedFolderToolOptions {
  readonly fs?: WorkspaceFs | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly deadlineAtMs?: number | undefined;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly budget?: ConnectedFolderToolBudget | undefined;
  /**
   * Receives the cause of every failed result, and of every search hit whose lines could no longer
   * be read (that call still succeeds and counts the hit), so the owning layer can log it body-free.
   */
  readonly onFailure?:
    ((reason: ConnectedFolderToolFailureReason, cause: unknown) => void) | undefined;
  /**
   * Receives every excerpt of the result with the evidence atom of the lines it carries, before the
   * result is returned. The owner decides which excerpts reach the model; only those may be cited.
   */
  readonly onExcerpt?:
    ((excerpt: ConnectedFolderToolExcerpt, atom: EvidenceAtom) => void) | undefined;
}

interface ToolContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly control: StructuralExecutionControl;
  readonly startedAtMs: number;
  readonly workspaceIndex: WorkspaceIndex | undefined;
  readonly budget: ConnectedFolderToolBudget | undefined;
  readonly onFailure: ConnectedFolderToolOptions["onFailure"];
  readonly onExcerpt: ConnectedFolderToolOptions["onExcerpt"];
}

type ToolSuccess = Extract<ConnectedFolderToolResult, { readonly ok: true }>;

function createContext(scope: SearchScope, options: ConnectedFolderToolOptions): ToolContext {
  const nowMs = options.nowMs ?? Date.now;
  return {
    scope,
    fs: options.fs ?? nodeWorkspaceFs,
    control: {
      nowMs,
      deadlineAtMs: options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    startedAtMs: nowMs(),
    workspaceIndex: options.workspaceIndex,
    budget: options.budget,
    onFailure: options.onFailure,
    onExcerpt: options.onExcerpt,
  };
}

function elapsedMs(context: ToolContext): number {
  return Math.max(0, context.control.nowMs() - context.startedAtMs);
}

function remainingResultBytes(context: ToolContext): number {
  return context.budget?.remainingResultBytes() ?? Number.POSITIVE_INFINITY;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** What is left of the turn's result bytes cannot hold even the path of the requested file. */
class ResultBudgetExhaustedError extends Error {}

/** A narrowed directory or a read target must lie inside what the person connected. */
function selectedScopeContains(scope: SearchScope, path: string): boolean {
  if (scope.relativePaths.length === 0) return true;
  const pathCase = workspacePathCase(scope.workspace);
  const key = pathCaseKey(path, pathCase);
  return scope.relativePaths.some((entry) => {
    const entryKey = pathCaseKey(entry, pathCase);
    return key === entryKey || key.startsWith(`${entryKey}/`);
  });
}

function assertSelected(scope: SearchScope, path: string): void {
  if (!selectedScopeContains(scope, path)) {
    throw new PathDeniedError("Path is outside the connected scope.", ".");
  }
}

function readDeps(context: ToolContext): Parameters<typeof readExcerpt>[2] {
  return {
    fs: context.fs,
    nowMs: context.control.nowMs,
    deadlineAtMs: context.control.deadlineAtMs,
    ...(context.control.signal === undefined ? {} : { signal: context.control.signal }),
  };
}

function excerptOf(
  context: ToolContext,
  path: string,
  read: ReadExcerptResult,
  startLine: number,
  endLine: number,
): ConnectedFolderToolExcerpt {
  const excerpt = {
    path,
    startLine: read.atom.lineRange?.startLine ?? startLine,
    endLine: read.atom.lineRange?.endLine ?? endLine,
    text: read.content,
    truncated: read.truncated,
  };
  context.onExcerpt?.(excerpt, read.atom);
  return excerpt;
}

/** A search hit whose source changed or became unreadable between the scan and its read. */
function reportUnavailableHit(context: ToolContext, cause: unknown): void {
  context.onFailure?.(failureReason(cause), cause);
}

// ─── list ────────────────────────────────────────────────────────────────────────

function scopeEntry(
  context: ToolContext,
  fs: WorkspaceFs,
  path: string,
): WorkspacePathDiscoveryEntry | undefined {
  try {
    const entry = admittedSearchScopeEntry(fs, context.scope.workspace.root, path);
    if (entry === undefined) return undefined;
    return entry.stat.isDirectory
      ? { relativePath: entry.relativePath, kind: "directory", sizeBytes: 0 }
      : { relativePath: entry.relativePath, kind: "file", sizeBytes: entry.stat.size };
  } catch (error) {
    // A connected entry that disappeared is reported as incomplete coverage, not as a failed call.
    if (error instanceof RepoSearchInvalidQueryError) return undefined;
    throw error;
  }
}

/** The root of a narrowed scope lists what the person connected, never its siblings. */
function listSelectedEntries(
  context: ToolContext,
  request: ConnectedFolderListRequest,
): ToolSuccess {
  const fs = workspaceFsBoundToCanonicalRoot(context.fs, context.scope.workspace.root);
  const remaining = [...context.scope.relativePaths]
    .sort(compareStrings)
    .filter((path) => request.after === "" || compareStrings(path, request.after) > 0);
  const page = remaining.slice(0, CONNECTED_FOLDER_TOOL_LIMITS.listEntries);
  const entries = page.flatMap((path) => scopeEntry(context, fs, path) ?? []);
  return listResult(context, request, entries, {
    more: remaining.length > page.length,
    coverageIncomplete: entries.length < page.length,
    lastPath: page.at(-1),
  });
}

function listResult(
  context: ToolContext,
  request: ConnectedFolderListRequest,
  entries: readonly WorkspacePathDiscoveryEntry[],
  page: {
    readonly more: boolean;
    readonly coverageIncomplete: boolean;
    readonly lastPath: string | undefined;
  },
): ToolSuccess {
  const kept = entriesWithinResultBytes(context, entries);
  const cut = kept.entries.length < entries.length;
  const lastPath = cut ? kept.entries.at(-1)?.relativePath : page.lastPath;
  return {
    ok: true,
    view: "list",
    directory: request.directory,
    entries: kept.entries,
    ...((page.more || cut) && lastPath !== undefined ? { nextAfter: lastPath } : {}),
    coverageIncomplete: page.coverageIncomplete,
    durationMs: elapsedMs(context),
    resultBytes: kept.resultBytes,
  };
}

/** The longest prefix of a listing that fits what is left of the turn's result bytes. */
function entriesWithinResultBytes(
  context: ToolContext,
  entries: readonly WorkspacePathDiscoveryEntry[],
): { readonly entries: readonly WorkspacePathDiscoveryEntry[]; readonly resultBytes: number } {
  const remaining = remainingResultBytes(context);
  let resultBytes = 0;
  let count = 0;
  for (const entry of entries) {
    const next = resultBytes + byteLength(entry.relativePath);
    if (next > remaining) break;
    resultBytes = next;
    count += 1;
  }
  if (count === 0 && entries.length > 0) throw new ResultBudgetExhaustedError();
  return { entries: entries.slice(0, count), resultBytes };
}

async function listView(
  context: ToolContext,
  request: ConnectedFolderListRequest,
): Promise<ToolSuccess> {
  if (request.directory === "" && context.scope.relativePaths.length > 0) {
    return listSelectedEntries(context, request);
  }
  if (request.directory !== "") assertSelected(context.scope, request.directory);
  const found = await discoverWorkspacePaths(
    context.scope.workspace,
    {
      mode: "directory",
      directory: request.directory,
      query: "*",
      maxResults: CONNECTED_FOLDER_TOOL_LIMITS.listEntries,
    },
    { ...context.control, ...(request.after === "" ? {} : { afterPath: request.after }) },
    context.fs,
  );
  const paged = found.truncationReasons.filter(
    (reason) => reason === "result-limit" || reason === "output-limit",
  );
  return listResult(context, request, found.entries, {
    more: paged.length > 0,
    coverageIncomplete: found.truncationReasons.length > paged.length,
    lastPath: found.entries.at(-1)?.relativePath,
  });
}

// ─── search ──────────────────────────────────────────────────────────────────────

function retrievalQuery(request: ConnectedFolderSearchRequest, nowMs: number): RetrievalQuery {
  return {
    kind: request.mode === "keywords" ? "natural-language" : "exact-symbol",
    text: request.query,
    caseSensitive: false,
    maxResults: request.maxResults,
    emittedAtMs: nowMs,
  };
}

/** A search may use only what is left of the turn's search time, within the caller's deadline. */
function searchDeadlineAtMs(context: ToolContext): number {
  const remaining = context.budget?.remainingSearchMs() ?? Number.POSITIVE_INFINITY;
  return Math.min(context.control.deadlineAtMs, context.startedAtMs + remaining);
}

async function snippetFor(
  context: ToolContext,
  atom: EvidenceAtom,
  maxBytes: number,
): Promise<ConnectedFolderToolExcerpt | undefined> {
  if (atom.lineRange === undefined) return undefined;
  const startLine = Math.max(1, atom.lineRange.startLine - 1);
  const endLine = atom.lineRange.endLine + 1;
  try {
    const read = await readExcerpt(
      context.scope,
      { scopePath: atom.scopePath, startLine, endLine, maxBytes },
      readDeps(context),
    );
    return excerptOf(context, atom.scopePath, read, startLine, endLine);
  } catch (error) {
    // The source can change or become unreadable between the scan and this read; cancellation and
    // the caller's deadline still end the call.
    assertStructuralExecutionActive(context.control);
    reportUnavailableHit(context, error);
    return undefined;
  }
}

interface ProjectedHits {
  readonly hits: readonly ConnectedFolderToolExcerpt[];
  readonly resultBytes: number;
  readonly unavailableHits: number;
  readonly truncated: boolean;
}

// `searchText` already returns no more atoms than the query asked for.
async function projectHits(
  context: ToolContext,
  atoms: readonly EvidenceAtom[],
): Promise<ProjectedHits> {
  const hits: ConnectedFolderToolExcerpt[] = [];
  let resultBytes = 0;
  let unavailableHits = 0;
  for (const atom of atoms) {
    const remaining = remainingResultBytes(context) - resultBytes - byteLength(atom.scopePath);
    if (remaining <= 0) {
      return { hits, resultBytes, unavailableHits, truncated: true };
    }
    const maxBytes = Math.min(CONNECTED_FOLDER_TOOL_LIMITS.snippetBytes, remaining);
    const hit = await snippetFor(context, atom, maxBytes); // NOSONAR typescript:S9382 -- each snippet's byte limit is what the earlier ones left of the turn's budget
    if (hit === undefined) {
      unavailableHits += 1;
      continue;
    }
    hits.push(hit);
    resultBytes += byteLength(hit.path) + byteLength(hit.text);
  }
  return { hits, resultBytes, unavailableHits, truncated: false };
}

async function searchView(
  context: ToolContext,
  request: ConnectedFolderSearchRequest,
): Promise<ToolSuccess> {
  if (request.directory !== "") assertSelected(context.scope, request.directory);
  const scope =
    request.directory === ""
      ? context.scope
      : { ...context.scope, relativePaths: [request.directory] };
  const result = await searchText(
    scope,
    retrievalQuery(request, context.startedAtMs),
    DEFAULT_SEARCH_LIMITS,
    {
      ...readDeps(context),
      deadlineAtMs: searchDeadlineAtMs(context),
      ...(request.mode === "literal" ? { queryInterpretation: { kind: "literal" } as const } : {}),
      ...(context.workspaceIndex === undefined ? {} : { workspaceIndex: context.workspaceIndex }),
    },
  );
  assertStructuralExecutionActive(context.control);
  const projected = await projectHits(context, result.atoms);
  return {
    ok: true,
    view: "search",
    hits: projected.hits,
    filesScanned: result.filesScanned,
    truncated: result.truncated || projected.truncated,
    unavailableHits: projected.unavailableHits,
    durationMs: elapsedMs(context),
    resultBytes: projected.resultBytes,
  };
}

// ─── read ────────────────────────────────────────────────────────────────────────

async function readView(
  context: ToolContext,
  request: ConnectedFolderReadRequest,
): Promise<ToolSuccess> {
  assertSelected(context.scope, request.path);
  const endLine = request.startLine + request.maxLines - 1;
  const maxBytes = Math.min(
    CONNECTED_FOLDER_TOOL_LIMITS.readBytes,
    remainingResultBytes(context) - byteLength(request.path),
  );
  if (maxBytes <= 0) throw new ResultBudgetExhaustedError();
  const read = await readExcerpt(
    context.scope,
    { scopePath: request.path, startLine: request.startLine, endLine, maxBytes },
    readDeps(context),
  );
  const excerpt = excerptOf(context, request.path, read, request.startLine, endLine);
  const more = excerpt.truncated || excerpt.endLine >= endLine;
  return {
    ok: true,
    view: "read",
    excerpt,
    ...(more ? { nextStartLine: excerpt.endLine + 1 } : {}),
    durationMs: elapsedMs(context),
    resultBytes: byteLength(excerpt.path) + byteLength(excerpt.text),
  };
}

// ─── boundary ────────────────────────────────────────────────────────────────────

function isScopeDenial(error: unknown): boolean {
  return error instanceof PathDeniedError || error instanceof PathEscapeError;
}

function isInvalidRequest(error: unknown): boolean {
  return (
    error instanceof RepoSearchInvalidQueryError || error instanceof RepoSearchInvalidRangeError
  );
}

/** Only the turn's own budget can stop a call whose caller is still active. */
function isBudgetStop(error: unknown): boolean {
  return (
    error instanceof ResultBudgetExhaustedError || error instanceof StructuralExecutionStoppedError
  );
}

function isUnreadable(error: unknown): boolean {
  return error instanceof WorkspaceReadError || error instanceof FileTooLargeError;
}

/** The read path reports why it refused a file as a closed reason on one error class. */
const UNSUPPORTED_FILE_REASONS: ReadonlyMap<string, ConnectedFolderToolFailureReason> = new Map([
  ["outside-scope", "scope-denied"],
  ["denied", "scope-denied"],
  ["outside-range", "out-of-range"],
  ["binary", "not-text"],
]);

function failureReason(error: unknown): ConnectedFolderToolFailureReason {
  if (isScopeDenial(error)) return "scope-denied";
  if (isInvalidRequest(error)) return "invalid-request";
  if (error instanceof RepoSearchUnsupportedFileError) {
    return UNSUPPORTED_FILE_REASONS.get(error.reason) ?? "unreadable";
  }
  if (isUnreadable(error)) return "unreadable";
  return isBudgetStop(error) ? "budget-exhausted" : "failed";
}

function budgetExhausted(context: ToolContext, request: ConnectedFolderToolRequest): boolean {
  if (context.budget === undefined) return false;
  if (context.budget.remainingResultBytes() <= 0) return true;
  return request.view === "search" && context.budget.remainingSearchMs() <= 0;
}

function runView(context: ToolContext, request: ConnectedFolderToolRequest): Promise<ToolSuccess> {
  if (request.view === "list") return listView(context, request);
  if (request.view === "search") return searchView(context, request);
  return readView(context, request);
}

function failed(
  options: ConnectedFolderToolOptions,
  reason: ConnectedFolderToolFailureReason,
  cause: unknown,
): ConnectedFolderToolResult {
  options.onFailure?.(reason, cause);
  return { ok: false, reason };
}

/**
 * Runs one model-requested view on a connected folder. `request` is untrusted. A refused or failed
 * call is a result the model can react to; cancellation and the caller's own deadline are not, and
 * reject with the original stop so the owning turn ends.
 */
export async function executeConnectedFolderToolRequest(
  scope: SearchScope,
  request: unknown,
  options: ConnectedFolderToolOptions = {},
): Promise<ConnectedFolderToolResult> {
  const captured = captureConnectedFolderToolRequest(request);
  if (captured === undefined) return failed(options, "invalid-request", undefined);
  const context = createContext(scope, options);
  assertStructuralExecutionActive(context.control);
  if (budgetExhausted(context, captured)) return failed(options, "budget-exhausted", undefined);
  try {
    const result = await runView(context, captured);
    assertStructuralExecutionActive(context.control);
    context.budget?.charge(captured.view === "search" ? result.durationMs : 0, result.resultBytes);
    return result;
  } catch (error) {
    if (structuralExecutionStopped(context.control)) throw error;
    context.budget?.charge(captured.view === "search" ? elapsedMs(context) : 0, 0);
    return failed(options, failureReason(error), error);
  }
}
