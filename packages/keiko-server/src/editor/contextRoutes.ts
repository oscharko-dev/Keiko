// BFF routes for governed coding-context retrieval (Issue #1211, ADR-0042 D6). Two routes:
//   POST /api/editor/context                  — assemble a bounded, redacted coding-context pack for
//                                                an editor-originated request and return the CONTENT-
//                                                FREE wire pack (citations + tier + accounting) plus an
//                                                audit-linkage run id. Excerpt text never leaves the
//                                                process.
//   POST /api/editor/local-knowledge/retrieve — query-only Local Knowledge retrieval returning
//                                                references/citations only (NO LLM answer).
// Workspace-root containment reuses the files routes' realpath + deny-list resolution; responses are
// redacted (D9). The browser never gains direct retrieval, embedding, or model access.

import { isAbsolute, resolve } from "node:path";
import type { CodingContextPurpose, CodingContextRequest } from "@oscharko-dev/keiko-contracts";
import {
  CODING_CONTEXT_SCHEMA_VERSION,
  toCodingContextWirePack,
  validateCodingContextRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-context";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/runtime/connected-context";
import { containedRealPathInfo, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { assembleGroundedContext } from "@oscharko-dev/keiko-local-knowledge";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, readJsonObject, resolveRequestRoot, runFilesHandler } from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";
import { openStoreForDeps } from "../local-knowledge-grounded-qa.js";
import { assembleCodingContext } from "./codingContext.js";
import { recordCodingContextEvidence } from "./codingContextEvidence.js";
import { clientAbortSignal } from "./languageRoutes.js";
import {
  buildLocalKnowledgeScope,
  retrieveEditorLocalKnowledge,
} from "./localKnowledgeRetrieval.js";

const MAX_CONTEXT_BODY_BYTES = 64 * 1024;
const MAX_CONTEXT_CHANGED_FILES = 64;

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function rootFieldOf(body: Record<string, unknown>): string | null {
  return typeof body.root === "string" ? body.root : null;
}

function invalidRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("INVALID_REQUEST", message) };
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

function assertContained(realRoot: string, relativePath: string, fs: WorkspaceFs): void {
  if (isAbsolute(relativePath) || pathIsDenied(relativePath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  try {
    containedRealPathInfo(fs, realRoot, resolve(realRoot, relativePath));
  } catch {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
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

function validateCodingContextPaths(
  realRoot: string,
  fs: WorkspaceFs,
  request: CodingContextRequest,
): RouteResult | undefined {
  assertContained(realRoot, request.documentPath, fs);
  const invalidDocument = validateRelativePathShape("documentPath", request.documentPath);
  if (invalidDocument !== undefined) return invalidDocument;
  for (const changed of request.changedFiles ?? []) {
    assertContained(realRoot, changed, fs);
    const invalidChanged = validateRelativePathShape("changedFiles", changed);
    if (invalidChanged !== undefined) return invalidChanged;
  }
  return undefined;
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
    const root = await resolveRequestRoot(ctx, deps, rootInput);
    const { canonicalRoot, fs } = root.access;
    const request = sanitizeCodingContextRequest(buildInternalRequest(body));
    if (isRouteResult(request)) {
      return request;
    }
    const invalidPath = validateCodingContextPaths(canonicalRoot, fs, request);
    if (invalidPath !== undefined) return invalidPath;
    const nowMs = Date.now();
    const pack = await assembleCodingContext(request, {
      deps,
      realRoot: canonicalRoot,
      fs,
      signal: clientAbortSignal(ctx),
      nowMs,
      // The git context is assembled by calling the git routes in-process; without this their
      // failure lines would be orphaned under UNKNOWN_CORRELATION_ID (AGENTS.md §8 Rule 1).
      correlationId: ctx.correlationId,
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
