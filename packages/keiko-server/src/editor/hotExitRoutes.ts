import type { RouteContext, RouteResult } from "../routes.js";
import { errorBody } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  FilesError,
  normalizeRelativePath,
  readJsonObject,
  resolveRoot,
  runFilesHandler,
} from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";
import type { EditorHotExitStore } from "./hotExitStore.js";
import {
  isEditorHotExitSnapshotV1,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import { containsRedactableSecret } from "@oscharko-dev/keiko-security";

const MAX_HOT_EXIT_BODY_BYTES = 8 * 1024 * 1024 + 32 * 1024;

function stringField(raw: Record<string, unknown>, field: string): string | RouteResult {
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", `${field} must be a non-empty string.`) };
  }
  return value;
}

async function expectedSnapshotRef(
  deps: UiHandlerDeps,
  store: EditorHotExitStore,
  root: string,
  relativePath: string,
): Promise<string> {
  const resolvedRoot = await resolveRoot(deps.store, root, deps.redactor);
  const normalizedPath = normalizeRelativePath(relativePath);
  if (pathIsDenied(normalizedPath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return store.snapshotRefFor(resolvedRoot.root, normalizedPath);
}

async function validateSnapshotBinding(
  deps: UiHandlerDeps,
  store: EditorHotExitStore,
  root: string,
  relativePath: string,
  snapshotRef: string,
): Promise<boolean> {
  return (await expectedSnapshotRef(deps, store, root, relativePath)) === snapshotRef;
}

function unavailableStore(): RouteResult {
  return {
    status: 503,
    body: errorBody("HOT_EXIT_UNAVAILABLE", "Editor recovery storage is unavailable."),
  };
}

function isRouteResult(value: unknown): value is RouteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly status?: unknown }).status === "number" &&
    "body" in value
  );
}

function hasStore(deps: UiHandlerDeps): deps is UiHandlerDeps & {
  readonly editorHotExitStore: EditorHotExitStore;
} {
  return deps.editorHotExitStore !== undefined;
}

function snapshotFromBody(body: Record<string, unknown>): EditorHotExitSnapshotV1 | RouteResult {
  const snapshot = body.snapshot;
  if (!isEditorHotExitSnapshotV1(snapshot)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "snapshot is not a valid hot-exit payload."),
    };
  }
  return snapshot;
}

export async function handleEditorHotExitWrite(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasStore(deps)) return unavailableStore();
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_HOT_EXIT_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const snapshot = snapshotFromBody(body);
    if (isRouteResult(snapshot)) return snapshot;
    const snapshotRef = await expectedSnapshotRef(
      deps,
      deps.editorHotExitStore,
      snapshot.workspaceRoot,
      snapshot.relativePath,
    );
    if (containsRedactableSecret(snapshot.content)) {
      deps.editorHotExitStore.delete(snapshotRef);
      return {
        status: 200,
        body: { snapshotRef, contentSizeBytes: 0, suppressed: true },
      };
    }
    const result = deps.editorHotExitStore.write(snapshot);
    return { status: 200, body: result };
  });
}

export async function handleEditorHotExitRead(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasStore(deps)) return unavailableStore();
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_HOT_EXIT_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const root = stringField(body, "workspaceRoot");
    if (typeof root !== "string") return root;
    const relativePath = stringField(body, "relativePath");
    if (typeof relativePath !== "string") return relativePath;
    const snapshotRef = stringField(body, "snapshotRef");
    if (typeof snapshotRef !== "string") return snapshotRef;
    if (
      !(await validateSnapshotBinding(
        deps,
        deps.editorHotExitStore,
        root,
        relativePath,
        snapshotRef,
      ))
    ) {
      throw new FilesError(403, "HOT_EXIT_REF_MISMATCH", "Recovery snapshot reference mismatch.");
    }
    const snapshot = deps.editorHotExitStore.read(snapshotRef);
    return { status: 200, body: snapshot === null ? { found: false } : { found: true, snapshot } };
  });
}

export async function handleEditorHotExitDelete(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasStore(deps)) return unavailableStore();
  return runFilesHandler(async () => {
    const body = await readJsonObject(ctx.req, MAX_HOT_EXIT_BODY_BYTES);
    if (isRouteResult(body)) return body;
    const root = stringField(body, "workspaceRoot");
    if (typeof root !== "string") return root;
    const relativePath = stringField(body, "relativePath");
    if (typeof relativePath !== "string") return relativePath;
    const snapshotRef = stringField(body, "snapshotRef");
    if (typeof snapshotRef !== "string") return snapshotRef;
    if (
      !(await validateSnapshotBinding(
        deps,
        deps.editorHotExitStore,
        root,
        relativePath,
        snapshotRef,
      ))
    ) {
      throw new FilesError(403, "HOT_EXIT_REF_MISMATCH", "Recovery snapshot reference mismatch.");
    }
    deps.editorHotExitStore.delete(snapshotRef);
    return { status: 204, body: undefined };
  });
}
