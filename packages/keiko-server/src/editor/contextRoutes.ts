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
    documentPath: body.documentPath as string,
    symbol: typeof body.symbol === "string" ? body.symbol : undefined,
    queryText: typeof body.queryText === "string" ? body.queryText : undefined,
    changedFiles: Array.isArray(body.changedFiles) ? (body.changedFiles as string[]) : undefined,
    capsuleId: typeof body.capsuleId === "string" ? body.capsuleId : undefined,
    capsuleSetId: typeof body.capsuleSetId === "string" ? body.capsuleSetId : undefined,
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
    const request = buildInternalRequest(body);
    assertContained(root.realRoot, request.documentPath);
    for (const changed of request.changedFiles ?? []) {
      assertContained(root.realRoot, changed);
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
interface RepoSearchInput {
  readonly root: string | null;
  readonly queryText: string;
  readonly symbol: string | undefined;
  readonly paths: readonly string[];
  readonly maxResults: number;
}

function clampMaxResults(value: unknown): number {
  const raw = typeof value === "number" ? value : REPO_SEARCH_MAX_RESULTS;
  return Math.max(1, Math.min(REPO_SEARCH_MAX_RESULTS, Math.trunc(raw)));
}

function parseRepoSearchInput(body: Record<string, unknown>): RepoSearchInput | RouteResult {
  if (typeof body.queryText !== "string" || body.queryText.trim().length === 0) {
    return invalidRequest("queryText must be a non-empty string.");
  }
  if (body.symbol !== undefined && typeof body.symbol !== "string") {
    return invalidRequest("symbol must be a string when provided.");
  }
  if (body.paths !== undefined && !isStringArray(body.paths)) {
    return invalidRequest("paths must be an array of strings.");
  }
  return {
    root: rootFieldOf(body),
    queryText: body.queryText,
    symbol: typeof body.symbol === "string" ? body.symbol : undefined,
    paths: isStringArray(body.paths) ? body.paths : [],
    maxResults: clampMaxResults(body.maxResults),
  };
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
    for (const path of input.paths) {
      assertContained(root.realRoot, path);
    }
    const scope: SearchScope = {
      workspace: detectWorkspaceAt(root.realRoot, nodeWorkspaceFs),
      scopeId: "editor-repo-search",
      relativePaths: input.paths,
    };
    const query: RetrievalQuery = {
      kind: input.symbol !== undefined ? "exact-symbol" : "natural-language",
      text: input.symbol ?? input.queryText,
      caseSensitive: false,
      maxResults: input.maxResults,
      emittedAtMs: Date.now(),
    };
    const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS);
    return {
      status: 200,
      body: deps.redactor({
        atoms: result.atoms,
        truncated: result.truncated,
        filesScanned: result.filesScanned,
      }),
    };
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
      status: 200,
      body: deps.redactor({
        pack: assembleGroundedContext([]),
        noEvidence: true,
        reason: outcome.reason,
      }),
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
