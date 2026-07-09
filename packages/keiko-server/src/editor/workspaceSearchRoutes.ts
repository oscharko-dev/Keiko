import {
  validateWorkspaceReplaceApplyRequest,
  validateWorkspaceReplacePreviewRequest,
  validateWorkspaceSearchRequest,
  validateWorkspaceSymbolSearchRequest,
  type RetrievalQuery,
  type WorkspaceReplaceApplyConflict,
  type WorkspaceReplaceApplyFile,
  type WorkspaceReplaceApplyRequest,
  type WorkspaceReplaceApplyResponse,
  type WorkspaceReplacePreviewEdit,
  type WorkspaceReplacePreviewFileEdit,
  type WorkspaceReplacePreviewRequest,
  type WorkspaceReplacePreviewResponse,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
  type WorkspaceSymbolSearchRequest,
  type WorkspaceSymbolSearchResponse,
  type WorkspaceSymbolSearchResult,
} from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  PathDeniedError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  buildSymbolGraph,
  detectWorkspaceAt,
  findFiles,
  readExcerpt,
  readWorkspaceFile,
  searchText,
  type SymbolGraphRecord,
  type SearchScope,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createContainedNodeWorkspaceWriter } from "@oscharko-dev/keiko-tools/internal/writer";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";

const MAX_WORKSPACE_SEARCH_BODY_BYTES = 64 * 1024;
const MAX_WORKSPACE_REPLACE_APPLY_BODY_BYTES = 2 * 1024 * 1024;
const WORKSPACE_SEARCH_SCOPE_ID = "editor-workspace-search";
const WORKSPACE_SEARCH_SNIPPET_BYTES = 8 * 1024;

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function invalidRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("INVALID_REQUEST", message) };
}

function rootFieldOf(body: Record<string, unknown>): string | null {
  return typeof body.root === "string" ? body.root : null;
}

function clientAbortSignal(ctx: RouteContext): AbortSignal {
  const controller = new AbortController();
  ctx.req.on("close", () => {
    controller.abort();
  });
  if (typeof ctx.res.on === "function") {
    ctx.res.on("close", () => {
      if (!ctx.res.writableEnded) controller.abort();
    });
  }
  return controller.signal;
}

function buildSearchScope(realRoot: string): SearchScope {
  return {
    workspace: detectWorkspaceAt(realRoot, nodeWorkspaceFs),
    scopeId: WORKSPACE_SEARCH_SCOPE_ID,
    relativePaths: [],
  };
}

function assertAllowedGlobScopes(
  request: WorkspaceSearchRequest | WorkspaceReplacePreviewRequest,
): void {
  for (const pattern of [...request.includeGlobs, ...request.excludeGlobs]) {
    if (pathIsDenied(pattern)) {
      throw new FilesError(403, "DENIED", DENIED_MESSAGE);
    }
  }
}

function assertAllowedApplyFiles(request: WorkspaceReplaceApplyRequest): void {
  for (const file of request.files) {
    if (pathIsDenied(file.path)) {
      throw new PathDeniedError(file.path, DENIED_MESSAGE);
    }
  }
}

function escapeLiteralForRegex(value: string): string {
  let escaped = "";
  for (const ch of value) {
    escaped += ".+*?^${}()|[]\\".includes(ch) ? `\\${ch}` : ch;
  }
  return escaped;
}

function patternForRequest(
  request: WorkspaceSearchRequest | WorkspaceReplacePreviewRequest,
): string {
  return request.mode === "literal" ? escapeLiteralForRegex(request.query) : request.query;
}

function queryForRequest(
  request: WorkspaceSearchRequest | WorkspaceReplacePreviewRequest,
  maxResults: number,
): RetrievalQuery {
  return {
    kind: "regex",
    text: patternForRequest(request),
    caseSensitive: request.caseSensitive,
    maxResults,
    emittedAtMs: Date.now(),
  };
}

async function filesForGlobs(
  scope: SearchScope,
  globs: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlySet<string> | undefined> {
  if (globs.length === 0) return undefined;
  const paths = new Set<string>();
  for (const glob of globs) {
    const result = await findFiles(
      scope,
      {
        kind: "file-pattern",
        text: glob,
        caseSensitive: true,
        maxResults: DEFAULT_SEARCH_LIMITS.maxMatchesReturned,
        emittedAtMs: Date.now(),
      },
      DEFAULT_SEARCH_LIMITS,
      { signal },
    );
    for (const atom of result.atoms) {
      paths.add(atom.scopePath);
    }
  }
  return paths;
}

async function buildGlobFilter(
  scope: SearchScope,
  request: WorkspaceSearchRequest | WorkspaceReplacePreviewRequest,
  signal: AbortSignal,
): Promise<(path: string) => boolean> {
  const include = await filesForGlobs(scope, request.includeGlobs, signal);
  const exclude = await filesForGlobs(scope, request.excludeGlobs, signal);
  return (path: string): boolean => {
    if (include !== undefined && !include.has(path)) return false;
    return !exclude?.has(path);
  };
}

function searchRouteErrorResult(error: unknown): RouteResult | undefined {
  if (
    error instanceof RepoSearchInvalidQueryError ||
    error instanceof RepoSearchInvalidRangeError
  ) {
    return invalidRequest(error.message);
  }
  if (error instanceof RepoSearchUnsupportedFileError) {
    return { status: 400, body: errorBody("UNSUPPORTED_FILE", error.message) };
  }
  if (error instanceof PathDeniedError) {
    return { status: 403, body: errorBody("DENIED", error.message) };
  }
  if (error instanceof FileTooLargeError) {
    return { status: 400, body: errorBody("UNSUPPORTED_FILE", error.message) };
  }
  return undefined;
}

function buildMatchRegex(request: WorkspaceSearchRequest | WorkspaceReplacePreviewRequest): RegExp {
  return new RegExp(patternForRequest(request), request.caseSensitive ? "gu" : "giu");
}

async function snippetForMatch(
  scope: SearchScope,
  path: string,
  startLine: number,
  endLine: number,
  signal: AbortSignal,
): Promise<string> {
  const result = await readExcerpt(
    scope,
    {
      scopePath: path,
      startLine: Math.max(1, startLine - 1),
      endLine: endLine + 1,
      maxBytes: WORKSPACE_SEARCH_SNIPPET_BYTES,
    },
    { signal },
  );
  return result.content;
}

async function buildSearchResponse(
  scope: SearchScope,
  request: WorkspaceSearchRequest,
  signal: AbortSignal,
): Promise<WorkspaceSearchResponse> {
  const query = queryForRequest(request, request.maxResults);
  const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, { signal });
  const keepPath = await buildGlobFilter(scope, request, signal);
  const matches = [];
  for (const atom of result.atoms) {
    if (matches.length >= request.maxResults) break;
    if (atom.lineRange === undefined || !keepPath(atom.scopePath)) continue;
    matches.push({
      path: atom.scopePath,
      lineRange: atom.lineRange,
      snippet: await snippetForMatch(
        scope,
        atom.scopePath,
        atom.lineRange.startLine,
        atom.lineRange.endLine,
        signal,
      ),
      score: atom.score,
    });
  }
  return {
    results: matches,
    truncated: result.truncated || result.atoms.length > request.maxResults,
    filesScanned: result.filesScanned,
    elapsedMs: result.elapsedMs,
  };
}

function lineOffsets(text: string): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function lineForOffset(offsets: readonly number[], offset: number): number {
  let line = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const next = offsets[index + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < next) {
      line = index;
      break;
    }
  }
  return line;
}

function editForMatch(
  offsets: readonly number[],
  startOffset: number,
  text: string,
  replacement: string,
): WorkspaceReplacePreviewEdit {
  const endOffset = startOffset + text.length;
  const startLineIndex = lineForOffset(offsets, startOffset);
  const endLineIndex = lineForOffset(offsets, endOffset);
  const startLineOffset = offsets[startLineIndex] ?? 0;
  const endLineOffset = offsets[endLineIndex] ?? startLineOffset;
  return {
    range: {
      startLine: startLineIndex + 1,
      startColumn: startOffset - startLineOffset + 1,
      endLine: endLineIndex + 1,
      endColumn: endOffset - endLineOffset + 1,
    },
    originalText: text,
    newText: replacement,
  };
}

function editsForContent(
  content: string,
  regex: RegExp,
  replacement: string,
  lineNumbers: ReadonlySet<number>,
): readonly WorkspaceReplacePreviewEdit[] {
  const offsets = lineOffsets(content);
  const edits: WorkspaceReplacePreviewEdit[] = [];
  const lines = content.split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (!lineNumbers.has(lineNumber)) continue;
    const lineStart = offsets[lineIndex] ?? 0;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      edits.push(editForMatch(offsets, lineStart + match.index, match[0], replacement));
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
  return edits;
}

function buildReplaceFileEdit(
  scope: SearchScope,
  path: string,
  regex: RegExp,
  replacement: string,
  lineNumbers: ReadonlySet<number>,
): WorkspaceReplacePreviewFileEdit | undefined {
  const content = readWorkspaceFile(
    scope.workspace,
    path,
    { maxBytes: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned },
    nodeWorkspaceFs,
  );
  const edits = editsForContent(content.text, regex, replacement, lineNumbers);
  return edits.length === 0
    ? undefined
    : { path, baseContentHash: contentHash(content.text), edits };
}

function collectMatchedLines(
  atoms: Awaited<ReturnType<typeof searchText>>["atoms"],
  keepPath: (path: string) => boolean,
): Map<string, Set<number>> {
  const linesByPath = new Map<string, Set<number>>();
  for (const atom of atoms) {
    if (atom.lineRange === undefined || !keepPath(atom.scopePath)) continue;
    const lines = linesByPath.get(atom.scopePath) ?? new Set<number>();
    for (let line = atom.lineRange.startLine; line <= atom.lineRange.endLine; line += 1) {
      lines.add(line);
    }
    linesByPath.set(atom.scopePath, lines);
  }
  return linesByPath;
}

function buildReplacePreviewFiles(
  scope: SearchScope,
  request: WorkspaceReplacePreviewRequest,
  linesByPath: ReadonlyMap<string, ReadonlySet<number>>,
): readonly WorkspaceReplacePreviewFileEdit[] {
  const regex = buildMatchRegex(request);
  const files: WorkspaceReplacePreviewFileEdit[] = [];
  for (const path of linesByPath.keys()) {
    if (files.length >= request.maxFiles) break;
    const lineNumbers = linesByPath.get(path) ?? new Set<number>();
    const file = buildReplaceFileEdit(scope, path, regex, request.replacement, lineNumbers);
    if (file !== undefined) files.push(file);
  }
  return files;
}

async function buildReplacePreviewResponse(
  scope: SearchScope,
  request: WorkspaceReplacePreviewRequest,
  signal: AbortSignal,
): Promise<WorkspaceReplacePreviewResponse> {
  const query = queryForRequest(request, DEFAULT_SEARCH_LIMITS.maxMatchesReturned);
  const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, { signal });
  const keepPath = await buildGlobFilter(scope, request, signal);
  const linesByPath = collectMatchedLines(result.atoms, keepPath);
  const files = buildReplacePreviewFiles(scope, request, linesByPath);
  const editCount = files.reduce((total, file) => total + file.edits.length, 0);
  const omittedFileCount = Math.max(0, linesByPath.size - files.length);
  return {
    files,
    fileCount: files.length,
    editCount,
    truncated: result.truncated || omittedFileCount > 0,
    omittedFileCount,
  };
}

function parseWorkspaceSearchRequest(body: Record<string, unknown>): WorkspaceSearchRequest {
  return {
    root: rootFieldOf(body) ?? "",
    query: body.query as string,
    mode: body.mode as WorkspaceSearchRequest["mode"],
    caseSensitive: body.caseSensitive as boolean,
    includeGlobs: body.includeGlobs as readonly string[],
    excludeGlobs: body.excludeGlobs as readonly string[],
    maxResults: body.maxResults as number,
  };
}

function parseWorkspaceSymbolSearchRequest(
  body: Record<string, unknown>,
): WorkspaceSymbolSearchRequest {
  return {
    root: rootFieldOf(body) ?? "",
    query: body.query as string,
    maxResults: body.maxResults as number,
  };
}

function symbolScore(record: SymbolGraphRecord, normalizedQuery: string): number {
  const symbol = record.symbol.toLowerCase();
  if (symbol === normalizedQuery) return 1;
  if (symbol.startsWith(normalizedQuery)) return Math.max(0.85, record.confidence);
  return Math.min(0.75, record.confidence);
}

function symbolResult(
  record: SymbolGraphRecord,
  normalizedQuery: string,
): WorkspaceSymbolSearchResult | null {
  if (record.kind !== "definition" || record.definitionKind === undefined) return null;
  if (!record.symbol.toLowerCase().includes(normalizedQuery)) return null;
  return {
    symbol: record.symbol,
    kind: record.definitionKind,
    path: record.scopePath,
    line: record.line,
    score: symbolScore(record, normalizedQuery),
    ...(record.enclosingSymbol === undefined ? {} : { enclosingSymbol: record.enclosingSymbol }),
  };
}

async function buildSymbolSearchResponse(
  scope: SearchScope,
  request: WorkspaceSymbolSearchRequest,
): Promise<WorkspaceSymbolSearchResponse> {
  const startedAt = Date.now();
  const graph = await buildSymbolGraph(scope, DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs);
  const normalizedQuery = request.query.trim().toLowerCase();
  const allResults = graph.records
    .map((record) => symbolResult(record, normalizedQuery))
    .filter((result): result is WorkspaceSymbolSearchResult => result !== null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return {
    results: allResults.slice(0, request.maxResults),
    truncated: graph.diagnostics.truncated || allResults.length > request.maxResults,
    filesScanned: graph.diagnostics.filesScanned,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

function parseWorkspaceReplacePreviewRequest(
  body: Record<string, unknown>,
): WorkspaceReplacePreviewRequest {
  return {
    root: rootFieldOf(body) ?? "",
    query: body.query as string,
    mode: body.mode as WorkspaceReplacePreviewRequest["mode"],
    caseSensitive: body.caseSensitive as boolean,
    includeGlobs: body.includeGlobs as readonly string[],
    excludeGlobs: body.excludeGlobs as readonly string[],
    replacement: body.replacement as string,
    maxFiles: body.maxFiles as number,
  };
}

function parseWorkspaceReplaceApplyRequest(
  body: Record<string, unknown>,
): WorkspaceReplaceApplyRequest {
  return {
    root: rootFieldOf(body) ?? "",
    files: body.files as readonly WorkspaceReplaceApplyFile[],
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function offsetForPosition(content: string, line: number, column: number): number | null {
  let currentLine = 1;
  let lineStart = 0;
  for (let index = 0; index < content.length && currentLine < line; index += 1) {
    if (content[index] === "\n") {
      currentLine += 1;
      lineStart = index + 1;
    }
  }
  if (currentLine !== line) return null;
  const offset = lineStart + column - 1;
  return offset <= content.length ? offset : null;
}

function applyReplaceEditsToText(
  content: string,
  edits: readonly WorkspaceReplacePreviewEdit[],
): string | null {
  const ranges = edits
    .map((edit) => {
      const start = offsetForPosition(content, edit.range.startLine, edit.range.startColumn);
      const end = offsetForPosition(content, edit.range.endLine, edit.range.endColumn);
      return start === null || end === null ? null : { edit, start, end };
    })
    .filter(
      (entry): entry is { edit: WorkspaceReplacePreviewEdit; start: number; end: number } =>
        entry !== null,
    )
    .sort((a, b) => b.start - a.start);
  if (ranges.length !== edits.length) return null;
  let next = content;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (
      range.end > previousStart ||
      content.slice(range.start, range.end) !== range.edit.originalText
    ) {
      return null;
    }
    next = `${next.slice(0, range.start)}${range.edit.newText}${next.slice(range.end)}`;
    previousStart = range.start;
  }
  return next;
}

function conflictFor(
  file: WorkspaceReplaceApplyFile,
  detail: string,
): WorkspaceReplaceApplyConflict {
  return { path: file.path, reason: "write-conflict", detail };
}

function applyReplaceFile(
  scope: SearchScope,
  file: WorkspaceReplaceApplyFile,
): WorkspaceReplaceApplyConflict | null {
  const content = readWorkspaceFile(
    scope.workspace,
    file.path,
    { maxBytes: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned },
    nodeWorkspaceFs,
  );
  if (contentHash(content.text) !== file.baseContentHash) {
    return conflictFor(file, "file changed since preview");
  }
  const next = applyReplaceEditsToText(content.text, file.edits);
  if (next === null) return conflictFor(file, "preview edits no longer match current content");
  const writer = createContainedNodeWorkspaceWriter(scope.workspace.root);
  writer.writeFileUtf8(join(scope.workspace.root, file.path), next);
  return null;
}

function buildReplaceApplyResponse(
  scope: SearchScope,
  request: WorkspaceReplaceApplyRequest,
): WorkspaceReplaceApplyResponse {
  let appliedCount = 0;
  const conflicts: WorkspaceReplaceApplyConflict[] = [];
  for (const file of request.files) {
    try {
      const conflict = applyReplaceFile(scope, file);
      if (conflict === null) appliedCount += 1;
      else conflicts.push(conflict);
    } catch (error) {
      conflicts.push({
        path: file.path,
        reason: "out-of-scope",
        detail: error instanceof Error ? error.message : "replace apply failed",
      });
    }
  }
  return { appliedCount, conflictCount: conflicts.length, conflicts };
}

export async function handleEditorWorkspaceSearch(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_WORKSPACE_SEARCH_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const request = parseWorkspaceSearchRequest(body);
  const validation = validateWorkspaceSearchRequest(request);
  if (!validation.ok) return invalidRequest(validation.reasons.join("; "));
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    assertAllowedGlobScopes(request);
    const scope = buildSearchScope(root.realRoot);
    try {
      const response = await buildSearchResponse(scope, request, clientAbortSignal(ctx));
      return { status: 200, body: deps.redactor(response) };
    } catch (error) {
      const routeError = searchRouteErrorResult(error);
      if (routeError !== undefined) return routeError;
      throw error;
    }
  });
}

export async function handleEditorWorkspaceSymbols(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_WORKSPACE_SEARCH_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const request = parseWorkspaceSymbolSearchRequest(body);
  const validation = validateWorkspaceSymbolSearchRequest(request);
  if (!validation.ok) return invalidRequest(validation.reasons.join("; "));
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    const scope = buildSearchScope(root.realRoot);
    const response = await buildSymbolSearchResponse(scope, request);
    return { status: 200, body: deps.redactor(response) };
  });
}

export async function handleEditorWorkspaceReplacePreview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_WORKSPACE_SEARCH_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const request = parseWorkspaceReplacePreviewRequest(body);
  const validation = validateWorkspaceReplacePreviewRequest(request);
  if (!validation.ok) return invalidRequest(validation.reasons.join("; "));
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    assertAllowedGlobScopes(request);
    const scope = buildSearchScope(root.realRoot);
    try {
      const response = await buildReplacePreviewResponse(scope, request, clientAbortSignal(ctx));
      return { status: 200, body: deps.redactor(response) };
    } catch (error) {
      const routeError = searchRouteErrorResult(error);
      if (routeError !== undefined) return routeError;
      throw error;
    }
  });
}

export async function handleEditorWorkspaceReplaceApply(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_WORKSPACE_REPLACE_APPLY_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const request = parseWorkspaceReplaceApplyRequest(body);
  const validation = validateWorkspaceReplaceApplyRequest(request);
  if (!validation.ok) return invalidRequest(validation.reasons.join("; "));
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    try {
      assertAllowedApplyFiles(request);
      const scope = buildSearchScope(root.realRoot);
      const response = buildReplaceApplyResponse(scope, request);
      return { status: 200, body: deps.redactor(response) };
    } catch (error) {
      const routeError = searchRouteErrorResult(error);
      if (routeError !== undefined) return routeError;
      throw error;
    }
  });
}
