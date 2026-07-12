import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  compileEditorM7SnippetBody,
  parseEditorM7WorkspaceSnippetCollection,
  type EditorM7WorkspaceSnippetInput,
  type EditorM7WorkspaceSnippetMutationResult,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../../files.js";
import { errorBody, STREAMING, type RouteContext, type RouteResult } from "../../routes.js";
import { SSE_HEADERS, startSseHeartbeat } from "../../sse.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ROOT_CHARS = 4_096;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function singleHeader(ctx: RouteContext, name: "idempotency-key" | "if-match"): string | undefined {
  const value = ctx.req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function validIdempotencyKey(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_IDEMPOTENCY_KEY_CHARS &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code > 0xffff) index += 1;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ROOT_CHARS;
}

function validSnippetInputs(value: unknown): value is readonly EditorM7WorkspaceSnippetInput[] {
  return Array.isArray(value);
}

function parseMutationBody(value: unknown):
  | {
      readonly root: string;
      readonly expectedRevision: number;
      readonly action: "replace" | "reset";
      readonly snippets?: readonly EditorM7WorkspaceSnippetInput[] | undefined;
    }
  | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "root", "expectedRevision", "action", "snippets"])
  ) {
    return undefined;
  }
  if (value.schemaVersion !== EDITOR_M7_SNIPPET_COLLECTION_VERSION) return undefined;
  if (!validRoot(value.root) || !validRevision(value.expectedRevision)) return undefined;
  if (value.action === "reset" && value.snippets === undefined) {
    return { root: value.root, expectedRevision: value.expectedRevision, action: "reset" };
  }
  if (value.action === "replace" && validSnippetInputs(value.snippets)) {
    return {
      root: value.root,
      expectedRevision: value.expectedRevision,
      action: "replace",
      snippets: value.snippets,
    };
  }
  return undefined;
}

function revisionFromEtag(value: string | undefined): number | undefined {
  const match = value === undefined ? null : /^"edsn-(\d+)-[A-Za-z0-9_-]{4,64}"$/u.exec(value);
  return match === null ? undefined : Number(match[1]);
}

async function resolvedRoot(root: string, deps: UiHandlerDeps): Promise<string | undefined> {
  const resolved = await resolveRoot(deps.store, root, deps.redactor);
  return resolved.realRoot;
}

function snippetMutationRouteResult(result: EditorM7WorkspaceSnippetMutationResult): RouteResult {
  if (result.kind === "ok") {
    return {
      status: 200,
      body: result,
      headers: { ETag: result.etag, "Cache-Control": "no-store" },
    };
  }
  if (result.kind === "conflict") {
    return {
      status: 409,
      body: errorBody(result.code, "The snippet revision is stale."),
      headers: { ETag: result.etag },
    };
  }
  if (result.kind === "idempotencyConflict") {
    return {
      status: 409,
      body: errorBody(result.code, "The idempotency key was reused."),
      headers: { ETag: result.etag },
    };
  }
  if (result.kind === "invalid") {
    return { status: 400, body: errorBody(result.code, "The snippet collection is invalid.") };
  }
  return { status: 503, body: errorBody(result.code, "Workspace snippets are unavailable.") };
}

export async function handleGetWorkspaceSnippets(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.workspaceSnippets === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Workspace snippets are unavailable."),
    };
  }
  return runFilesHandler(async () => {
    const root = ctx.url.searchParams.get("root");
    if (root === null || !validRoot(root)) {
      return { status: 400, body: errorBody("INVALID_REQUEST", "A workspace root is required.") };
    }
    const realRoot = await resolvedRoot(root, deps);
    if (realRoot === undefined) {
      return { status: 400, body: errorBody("UNSAFE_PATH", "Workspace root is unavailable.") };
    }
    const snapshot = deps.workspaceSnippets?.read(realRoot);
    return {
      status: 200,
      body: snapshot,
      headers: { ETag: snapshot?.etag ?? "", "Cache-Control": "no-store" },
    };
  });
}

export async function handleMutateWorkspaceSnippets(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.workspaceSnippets === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Workspace snippets are unavailable."),
    };
  }
  const service = deps.workspaceSnippets;
  const idempotencyKey = singleHeader(ctx, "idempotency-key")?.trim();
  if (!validIdempotencyKey(idempotencyKey)) {
    return { status: 400, body: errorBody("INVALID_REQUEST", "Missing idempotency key.") };
  }
  const body = parseMutationBody(await readJsonObject(ctx.req, MAX_BODY_BYTES));
  if (
    body === undefined ||
    revisionFromEtag(singleHeader(ctx, "if-match")) !== body.expectedRevision
  ) {
    return { status: 400, body: errorBody("INVALID_REQUEST", "Invalid snippet mutation.") };
  }
  return runFilesHandler(async () => {
    const realRoot = await resolvedRoot(body.root, deps);
    if (realRoot === undefined) {
      return { status: 400, body: errorBody("UNSAFE_PATH", "Workspace root is unavailable.") };
    }
    return snippetMutationRouteResult(await service.mutate({ ...body, realRoot, idempotencyKey }));
  });
}

export async function handleValidateWorkspaceSnippets(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_BODY_BYTES);
  const parsed = parseEditorM7WorkspaceSnippetCollection(body);
  if (!parsed.ok) return { status: 400, body: { ok: false, reasonCode: parsed.reasonCode } };
  return { status: 200, body: { ok: true, snippetCount: parsed.value.snippets.length } };
}

export async function handlePreviewWorkspaceSnippet(ctx: RouteContext): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_BODY_BYTES);
  const parsed =
    isRecord(body) && Array.isArray(body.body)
      ? compileEditorM7SnippetBody(body.body)
      : { ok: false as const, reasonCode: "INVALID_INPUT" as const };
  if (!parsed.ok) return { status: 400, body: parsed };
  return { status: 200, body: { ok: true, preview: parsed.value } };
}

export function handleWorkspaceSnippetsEvents(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult | typeof STREAMING {
  if (deps.workspaceSnippets === undefined) {
    return {
      status: 503,
      body: errorBody("STATE_UNAVAILABLE", "Workspace snippets are unavailable."),
    };
  }
  ctx.res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(ctx.res);
  const unsubscribe = deps.workspaceSnippets.subscribe((event) => {
    ctx.res.write(`event: editor-snippets:changed\n`);
    ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  ctx.res.on("close", () => {
    stopHeartbeat();
    unsubscribe();
  });
  ctx.res.write(`event: ready\ndata: {"ok":true}\n\n`);
  return STREAMING;
}
