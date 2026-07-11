// BFF routes for governed coding-context retrieval (Issue #1211, ADR-0042 D6). Three routes:
//   POST /api/editor/context                  — assemble a bounded, redacted coding-context pack for
//                                                an editor-originated request and return the CONTENT-
//                                                FREE wire pack (citations + tier + accounting) plus an
//                                                audit-linkage run id. Excerpt text never leaves the
//                                                process.
//   POST /api/editor/repo-search              — governed lexical repo search returning EvidenceAtom[]
//                                                (stableId + provenance, content-free) under the same
//                                                deny/realpath/size governance as the files routes.
//   POST /api/editor/local-knowledge/retrieve — query-only Local Knowledge retrieval returning
//                                                references/citations only (NO LLM answer).
// Workspace-root containment reuses the files routes' realpath + deny-list resolution; responses are
// redacted (D9). The browser never gains direct retrieval, embedding, or model access.

import { isAbsolute, resolve } from "node:path";
import {
  CODING_CONTEXT_SCHEMA_VERSION,
  isValidScopePath,
  toCodingContextWirePack,
  validateCodingContextRequest,
  type CodingContextPurpose,
  type CodingContextRequest,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_SEARCH_LIMITS,
  containedRealPathInfo,
  detectWorkspaceAt,
  findFiles,
  readExcerpt,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  searchText,
  type SearchScope,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assembleGroundedContext } from "@oscharko-dev/keiko-local-knowledge";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";
import { openStoreForDeps } from "../local-knowledge-grounded-qa.js";
import { assembleCodingContext } from "./codingContext.js";
import { recordCodingContextEvidence } from "./codingContextEvidence.js";
import {
  buildLocalKnowledgeScope,
  retrieveEditorLocalKnowledge,
} from "./localKnowledgeRetrieval.js";

const MAX_CONTEXT_BODY_BYTES = 64 * 1024;
const REPO_SEARCH_MAX_RESULTS = 50;
const MAX_CONTEXT_CHANGED_FILES = 64;
const MAX_REPO_SEARCH_PATHS = 64;
const DEFAULT_REPO_SEARCH_EXCERPT_BYTES = 8 * 1024;
const MAX_REPO_SEARCH_EXCERPT_BYTES = 32 * 1024;

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function rootFieldOf(body: Record<string, unknown>): string | null {
  return typeof body.root === "string" ? body.root : null;
}

function invalidRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("INVALID_REQUEST", message) };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function dedupePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function invalidPathShape(field: string, path: string): RouteResult {
  return invalidRequest(`${field} contains an invalid workspace-relative path: ${path}`);
}

function validateRelativePathShape(field: string, path: string): RouteResult | undefined {
  if (!isValidScopePath(path, { mustBeRelative: true })) {
    return invalidPathShape(field, path);
  }
  return undefined;
}

function dedupeAndCapPathList(
  field: string,
  paths: readonly string[],
  maxCount: number,
): readonly string[] | RouteResult {
  const deduped = dedupePaths(paths);
  if (deduped.length > maxCount) {
    return invalidRequest(`${field} must contain at most ${maxCount.toString()} paths.`);
  }
  return deduped;
}

function assertContained(realRoot: string, relativePath: string): void {
  if (isAbsolute(relativePath) || pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  try {
    containedRealPathInfo(nodeWorkspaceFs, realRoot, resolve(realRoot, relativePath));
  } catch {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
}

function clientAbortSignal(ctx: RouteContext): AbortSignal {
  const controller = new AbortController();
  ctx.req.on("close", () => {
    controller.abort();
  });
  if (typeof ctx.res.on === "function") {
    ctx.res.on("close", () => {
      if (!ctx.res.writableEnded) {
        controller.abort();
      }
    });
  }
  return controller.signal;
}

function buildInternalRequest(body: Record<string, unknown>): CodingContextRequest {
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: body.purpose as CodingContextPurpose,
    editorSessionId: typeof body.editorSessionId === "string" ? body.editorSessionId : undefined,
    documentPath: body.documentPath as string,
    symbol: typeof body.symbol === "string" ? body.symbol : undefined,
    queryText: typeof body.queryText === "string" ? body.queryText : undefined,
    changedFiles: Array.isArray(body.changedFiles) ? (body.changedFiles as string[]) : undefined,
    capsuleId: typeof body.capsuleId === "string" ? body.capsuleId : undefined,
    capsuleSetId: typeof body.capsuleSetId === "string" ? body.capsuleSetId : undefined,
  };
}

function sanitizeCodingContextRequest(
  request: CodingContextRequest,
): CodingContextRequest | RouteResult {
  if (request.capsuleId !== undefined && request.capsuleSetId !== undefined) {
    return invalidRequest("At most one of capsuleId or capsuleSetId may be provided.");
  }
  const changedFiles = dedupeAndCapPathList(
    "changedFiles",
    request.changedFiles ?? [],
    MAX_CONTEXT_CHANGED_FILES,
  );
  if (isRouteResult(changedFiles)) {
    return changedFiles;
  }
  return {
    ...request,
    changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
  };
}

// ─── POST /api/editor/context ─────────────────────────────────────────────────────
export async function handleEditorContext(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_CONTEXT_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const validation = validateCodingContextRequest(body);
  if (!validation.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", validation.reasons.join("; ")) };
  }
  const rootInput = rootFieldOf(body);
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, rootInput, deps.redactor);
    const request = sanitizeCodingContextRequest(buildInternalRequest(body));
    if (isRouteResult(request)) {
      return request;
    }
    assertContained(root.realRoot, request.documentPath);
    const invalidDocument = validateRelativePathShape("documentPath", request.documentPath);
    if (invalidDocument !== undefined) {
      return invalidDocument;
    }
    for (const changed of request.changedFiles ?? []) {
      assertContained(root.realRoot, changed);
      const invalidChanged = validateRelativePathShape("changedFiles", changed);
      if (invalidChanged !== undefined) {
        return invalidChanged;
      }
    }
    const nowMs = Date.now();
    const pack = await assembleCodingContext(request, {
      deps,
      realRoot: root.realRoot,
      signal: clientAbortSignal(ctx),
      nowMs,
    });
    const wire = toCodingContextWirePack(pack);
    const evidenceRunId = recordCodingContextEvidence(
      deps.evidenceStore,
      deps.redactor,
      wire,
      nowMs,
    );
    return { status: 200, body: deps.redactor({ pack: wire, evidenceRunId }) };
  });
}

// ─── POST /api/editor/repo-search ──────────────────────────────────────────────────
type RepoSearchOperation = "searchText" | "findFiles" | "readExcerpt";

interface RepoSearchBaseInput {
  readonly root: string | null;
  readonly symbol: string | undefined;
  readonly paths: readonly string[];
  readonly maxResults: number;
}

interface RepoSearchQueryInput extends RepoSearchBaseInput {
  readonly operation: "searchText" | "findFiles";
  readonly queryText: string;
}

interface RepoSearchExcerptInput extends RepoSearchBaseInput {
  readonly operation: "readExcerpt";
  readonly queryText: string | undefined;
  readonly scopePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
}

type RepoSearchInput = RepoSearchQueryInput | RepoSearchExcerptInput;

function clampMaxResults(value: unknown): number {
  const raw = typeof value === "number" ? value : REPO_SEARCH_MAX_RESULTS;
  return Math.max(1, Math.min(REPO_SEARCH_MAX_RESULTS, Math.trunc(raw)));
}

function clampMaxBytes(value: unknown): number {
  const raw = typeof value === "number" ? value : DEFAULT_REPO_SEARCH_EXCERPT_BYTES;
  return Math.max(0, Math.min(MAX_REPO_SEARCH_EXCERPT_BYTES, Math.trunc(raw)));
}

function parsePositiveInteger(value: unknown, field: string): number | RouteResult {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return invalidRequest(`${field} must be a positive integer.`);
  }
  return value;
}

function parseRepoSearchOperation(value: unknown): RepoSearchOperation | RouteResult {
  if (value === undefined || value === "searchText") {
    return "searchText";
  }
  if (value === "findFiles" || value === "readExcerpt") {
    return value;
  }
  return invalidRequest("operation must be searchText, findFiles, or readExcerpt.");
}

function parseRepoSearchBase(
  body: Record<string, unknown>,
): Omit<RepoSearchBaseInput, "maxResults"> | RouteResult {
  if (body.symbol !== undefined && typeof body.symbol !== "string") {
    return invalidRequest("symbol must be a string when provided.");
  }
  if (body.paths !== undefined && !isStringArray(body.paths)) {
    return invalidRequest("paths must be an array of strings.");
  }
  const paths = dedupeAndCapPathList(
    "paths",
    isStringArray(body.paths) ? body.paths : [],
    MAX_REPO_SEARCH_PATHS,
  );
  if (isRouteResult(paths)) {
    return paths;
  }
  return {
    root: rootFieldOf(body),
    symbol: typeof body.symbol === "string" ? body.symbol : undefined,
    paths,
  };
}

function parseRepoSearchQueryInput(
  operation: "searchText" | "findFiles",
  body: Record<string, unknown>,
  base: Omit<RepoSearchBaseInput, "maxResults">,
): RepoSearchQueryInput | RouteResult {
  if (typeof body.queryText !== "string" || body.queryText.trim().length === 0) {
    return invalidRequest("queryText must be a non-empty string.");
  }
  return {
    ...base,
    operation,
    queryText: body.queryText,
    maxResults: clampMaxResults(body.maxResults),
  };
}

function parseRepoSearchExcerptInput(
  body: Record<string, unknown>,
  base: Omit<RepoSearchBaseInput, "maxResults">,
): RepoSearchExcerptInput | RouteResult {
  if (typeof body.scopePath !== "string" || body.scopePath.trim().length === 0) {
    return invalidRequest("scopePath must be a non-empty string.");
  }
  const startLine = parsePositiveInteger(body.startLine, "startLine");
  if (isRouteResult(startLine)) {
    return startLine;
  }
  const endLine = parsePositiveInteger(body.endLine, "endLine");
  if (isRouteResult(endLine)) {
    return endLine;
  }
  if (endLine < startLine) {
    return invalidRequest("endLine must be greater than or equal to startLine.");
  }
  return {
    ...base,
    operation: "readExcerpt",
    queryText: typeof body.queryText === "string" ? body.queryText : undefined,
    maxResults: clampMaxResults(body.maxResults),
    scopePath: body.scopePath,
    startLine,
    endLine,
    maxBytes: clampMaxBytes(body.maxBytes),
  };
}

function parseRepoSearchInput(body: Record<string, unknown>): RepoSearchInput | RouteResult {
  const operation = parseRepoSearchOperation(body.operation);
  if (isRouteResult(operation)) {
    return operation;
  }
  const base = parseRepoSearchBase(body);
  if (isRouteResult(base)) {
    return base;
  }
  if (operation === "readExcerpt") {
    return parseRepoSearchExcerptInput(body, base);
  }
  return parseRepoSearchQueryInput(operation, body, base);
}

function repoSearchErrorResult(error: unknown): RouteResult | undefined {
  if (
    error instanceof RepoSearchInvalidQueryError ||
    error instanceof RepoSearchInvalidRangeError
  ) {
    return invalidRequest(error.message);
  }
  if (error instanceof RepoSearchUnsupportedFileError) {
    return { status: 400, body: errorBody("UNSUPPORTED_FILE", error.message) };
  }
  return undefined;
}

function validateRepoSearchPaths(
  realRoot: string,
  input: RepoSearchInput,
): RouteResult | undefined {
  for (const path of input.paths) {
    assertContained(realRoot, path);
    const invalid = validateRelativePathShape("paths", path);
    if (invalid !== undefined) {
      return invalid;
    }
  }
  if (input.operation === "readExcerpt") {
    assertContained(realRoot, input.scopePath);
    return validateRelativePathShape("scopePath", input.scopePath);
  }
  return undefined;
}

function buildRepoSearchScope(realRoot: string, input: RepoSearchInput): SearchScope {
  return {
    workspace: detectWorkspaceAt(realRoot, nodeWorkspaceFs),
    scopeId: "editor-repo-search",
    relativePaths: input.paths,
  };
}

function buildRepoSearchQuery(input: RepoSearchQueryInput, nowMs: number): RetrievalQuery {
  return {
    kind:
      input.operation === "findFiles"
        ? "file-pattern"
        : input.symbol !== undefined
          ? "exact-symbol"
          : "natural-language",
    text: input.operation === "findFiles" ? input.queryText : (input.symbol ?? input.queryText),
    caseSensitive: false,
    maxResults: input.maxResults,
    emittedAtMs: nowMs,
  };
}

async function runReadExcerptOperation(
  deps: UiHandlerDeps,
  scope: SearchScope,
  input: RepoSearchExcerptInput,
  signal: AbortSignal,
): Promise<RouteResult> {
  const result = await readExcerpt(
    scope,
    {
      scopePath: input.scopePath,
      startLine: input.startLine,
      endLine: input.endLine,
      maxBytes: input.maxBytes,
    },
    { signal },
  );
  return {
    status: 200,
    body: deps.redactor({
      atom: result.atom,
      atoms: [result.atom],
      truncated: result.truncated,
      byteCount: new TextEncoder().encode(result.content).length,
    }),
  };
}

async function runQueryOperation(
  deps: UiHandlerDeps,
  scope: SearchScope,
  input: RepoSearchQueryInput,
  signal: AbortSignal,
): Promise<RouteResult> {
  const query = buildRepoSearchQuery(input, Date.now());
  const workspaceIndex = deps.workspaceIndexForRoot?.(scope.workspace.root);
  const result =
    input.operation === "findFiles"
      ? await findFiles(scope, query, DEFAULT_SEARCH_LIMITS, { signal })
      : await searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
          signal,
          ...(workspaceIndex === undefined ? {} : { workspaceIndex }),
        });
  return {
    status: 200,
    body: deps.redactor({
      atoms: result.atoms,
      truncated: result.truncated,
      filesScanned: result.filesScanned,
      workspaceIndex: result.workspaceIndex,
    }),
  };
}

async function runRepoSearchOperation(
  deps: UiHandlerDeps,
  scope: SearchScope,
  input: RepoSearchInput,
  signal: AbortSignal,
): Promise<RouteResult> {
  try {
    return input.operation === "readExcerpt"
      ? await runReadExcerptOperation(deps, scope, input, signal)
      : await runQueryOperation(deps, scope, input, signal);
  } catch (error) {
    const routeError = repoSearchErrorResult(error);
    if (routeError !== undefined) {
      return routeError;
    }
    throw error;
  }
}

export async function handleEditorRepoSearch(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_CONTEXT_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const input = parseRepoSearchInput(body);
  if (isRouteResult(input)) {
    return input;
  }
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, input.root, deps.redactor);
    const invalid = validateRepoSearchPaths(root.realRoot, input);
    if (invalid !== undefined) {
      return invalid;
    }
    return await runRepoSearchOperation(
      deps,
      buildRepoSearchScope(root.realRoot, input),
      input,
      clientAbortSignal(ctx),
    );
  });
}

// ─── POST /api/editor/local-knowledge/retrieve ─────────────────────────────────────
interface LocalKnowledgeRetrieveInput {
  readonly queryText: string;
  readonly capsuleId: string | undefined;
  readonly capsuleSetId: string | undefined;
}

function parseLocalKnowledgeRetrieveInput(
  body: Record<string, unknown>,
): LocalKnowledgeRetrieveInput | RouteResult {
  if (typeof body.queryText !== "string" || body.queryText.trim().length === 0) {
    return invalidRequest("queryText must be a non-empty string.");
  }
  const capsuleId = typeof body.capsuleId === "string" ? body.capsuleId : undefined;
  const capsuleSetId = typeof body.capsuleSetId === "string" ? body.capsuleSetId : undefined;
  if ((capsuleId === undefined) === (capsuleSetId === undefined)) {
    return invalidRequest("Exactly one of capsuleId or capsuleSetId is required.");
  }
  return { queryText: body.queryText, capsuleId, capsuleSetId };
}

async function localKnowledgeRetrieveResponse(
  deps: UiHandlerDeps,
  store: ReturnType<typeof openStoreForDeps>["store"],
  input: LocalKnowledgeRetrieveInput,
  signal: AbortSignal,
): Promise<RouteResult> {
  const scope = buildLocalKnowledgeScope(input.capsuleId, input.capsuleSetId);
  if (scope === undefined) {
    return invalidRequest("Exactly one of capsuleId or capsuleSetId is required.");
  }
  const outcome = await retrieveEditorLocalKnowledge(deps, store, scope, input.queryText, signal);
  if (outcome.kind === "conflict") {
    return outcome.routeResult;
  }
  if (outcome.kind === "not-ready") {
    return {
      status: 409,
      body: errorBody("LOCAL_KNOWLEDGE_CONFLICT", String(deps.redactor(outcome.message))),
    };
  }
  return {
    status: 200,
    body: deps.redactor({
      pack: assembleGroundedContext(outcome.references),
      noEvidence: outcome.noEvidence,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    }),
  };
}

export async function handleEditorLocalKnowledgeRetrieve(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_CONTEXT_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const input = parseLocalKnowledgeRetrieveInput(body);
  if (isRouteResult(input)) {
    return input;
  }
  let env: ReturnType<typeof openStoreForDeps>;
  try {
    env = openStoreForDeps(deps);
  } catch {
    return {
      status: 503,
      body: errorBody("LOCAL_KNOWLEDGE_UNAVAILABLE", "Local knowledge storage is unavailable."),
    };
  }
  try {
    return await localKnowledgeRetrieveResponse(deps, env.store, input, clientAbortSignal(ctx));
  } finally {
    env.close();
  }
}
