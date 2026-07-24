import type { EditorLocalHistoryEntry } from "@oscharko-dev/keiko-contracts";
import { resolveAppSessionReadAuthority } from "../../coding-app-session/appSessionReadAuthority.js";
import type { UiHandlerDeps } from "../../deps.js";
import {
  readJsonObject,
  resolveEditorFileIdentity,
  resolveRoot,
  runFilesHandler,
} from "../../files.js";
import { errorBody } from "../../routes.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../../routes.js";
import { resolveEditorLocalHistoryRoot } from "./localHistoryCapture.js";
import {
  EditorLocalHistoryError,
  type EditorLocalHistoryRootScope,
  type EditorLocalHistoryStore,
} from "./localHistoryStore.js";

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function historyStore(deps: UiHandlerDeps): EditorLocalHistoryStore {
  if (deps.editorLocalHistoryStore === undefined) {
    throw new EditorLocalHistoryError("INDEX_UNAVAILABLE", "Local-history store is unavailable.");
  }
  return deps.editorLocalHistoryStore;
}

function hasReadAuthority(ctx: RouteContext, deps: UiHandlerDeps): boolean {
  return resolveAppSessionReadAuthority(deps, ctx.req) !== undefined;
}

function unpairedList(): RouteResult {
  return { status: 200, body: { session: "unpaired", entries: [] } };
}

function unpairedEntry(): RouteResult {
  return {
    status: 404,
    body: errorBody("ENTRY_NOT_FOUND", "Local-history entry was not found."),
  };
}

function historyError(error: unknown): RouteResult {
  if (!(error instanceof EditorLocalHistoryError)) throw error;
  const statusByCode: Partial<Record<typeof error.code, number>> = {
    ENTRY_NOT_FOUND: 404,
    PATH_OUTSIDE_WORKSPACE: 403,
    PINNED_BYTE_LIMIT: 409,
    PINNED_CAPACITY_EXHAUSTED: 409,
    ENTRY_TOO_LARGE: 413,
  };
  const status = statusByCode[error.code] ?? 503;
  return { status, body: errorBody(error.code, error.message) };
}

async function runHistoryRoute(work: () => Promise<RouteResult>): Promise<RouteResult> {
  try {
    return await runFilesHandler(work);
  } catch (error) {
    return historyError(error);
  }
}

async function rootScope(
  deps: UiHandlerDeps,
  rootInput: string | null,
): Promise<EditorLocalHistoryRootScope> {
  const root = await resolveRoot(deps.store, rootInput, deps.redactor);
  const identity = resolveEditorLocalHistoryRoot(deps, root.realRoot);
  return {
    workspaceId: identity.workspaceId,
    rootRef: identity.rootRef,
    rootIdentityDigest: identity.rootIdentityDigest,
  };
}

async function fileScope(
  deps: UiHandlerDeps,
  rootInput: string | null,
  pathInput: string | null,
): Promise<{ readonly scope: EditorLocalHistoryRootScope; readonly relativePath: string }> {
  const file = await resolveEditorFileIdentity(deps.store, rootInput, pathInput, deps.redactor);
  return { scope: await rootScope(deps, file.realRoot), relativePath: file.relativePath };
}

async function authorizedEntry(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<{
  readonly scope: EditorLocalHistoryRootScope;
  readonly entry: EditorLocalHistoryEntry;
  readonly store: EditorLocalHistoryStore;
}> {
  const rootInput = ctx.url.searchParams.get("root");
  const scope = await rootScope(deps, rootInput);
  const store = historyStore(deps);
  const entry = store.entry(scope, ctx.params.entryRef ?? "");
  await resolveEditorFileIdentity(deps.store, rootInput, entry.relativePath, deps.redactor);
  return { scope, entry, store };
}

export async function handleListEditorLocalHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHistoryRoute(async () => {
    if (!hasReadAuthority(ctx, deps)) return unpairedList();
    const rootInput = ctx.url.searchParams.get("root");
    const pathInput = ctx.url.searchParams.get("path");
    if (pathInput !== null) {
      const resolved = await fileScope(deps, rootInput, pathInput);
      return {
        status: 200,
        body: {
          session: "active",
          entries: historyStore(deps).list(resolved.scope, resolved.relativePath),
        },
      };
    }
    const scope = await rootScope(deps, rootInput);
    return { status: 200, body: { session: "active", entries: historyStore(deps).list(scope) } };
  });
}

export async function handleReadEditorLocalHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHistoryRoute(async () => {
    if (!hasReadAuthority(ctx, deps)) return unpairedEntry();
    const authorized = await authorizedEntry(ctx, deps);
    return {
      status: 200,
      body: authorized.store.read(authorized.scope, authorized.entry.entryRef),
    };
  });
}

export async function handlePinEditorLocalHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHistoryRoute(async () => {
    if (!hasReadAuthority(ctx, deps)) return unpairedEntry();
    const body = await readJsonObject(ctx.req, 1_024);
    if (isRouteResult(body)) return body;
    if (
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, "pinned") ||
      typeof body.pinned !== "boolean"
    ) {
      return { status: 400, body: errorBody("BAD_REQUEST", "pinned is required.") };
    }
    const authorized = await authorizedEntry(ctx, deps);
    const entry = authorized.store.setPinned(
      authorized.scope,
      authorized.entry.entryRef,
      body.pinned,
    );
    return { status: 200, body: { entry } };
  });
}

export async function handleDeleteEditorLocalHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHistoryRoute(async () => {
    if (!hasReadAuthority(ctx, deps)) return unpairedEntry();
    const authorized = await authorizedEntry(ctx, deps);
    authorized.store.delete(authorized.scope, authorized.entry.entryRef);
    return { status: 200, body: { deleted: true } };
  });
}

export const EDITOR_LOCAL_HISTORY_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/editor/local-history",
    handler: handleListEditorLocalHistory,
  },
  {
    method: "GET",
    pattern: "/api/editor/local-history/:entryRef",
    handler: handleReadEditorLocalHistory,
  },
  {
    method: "PATCH",
    pattern: "/api/editor/local-history/:entryRef",
    handler: handlePinEditorLocalHistory,
  },
  {
    method: "DELETE",
    pattern: "/api/editor/local-history/:entryRef",
    handler: handleDeleteEditorLocalHistory,
  },
];
