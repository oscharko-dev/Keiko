import type { RouteContext, RouteResult } from "../routes.js";
import { errorBody } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  FilesError,
  normalizeRelativePath,
  readJsonObject,
  resolveRequestRoot,
  runFilesHandler,
} from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";
import type { EditorHotExitStore, EditorHotExitStoredSnapshot } from "./hotExitStore.js";
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
  ctx: RouteContext,
  deps: UiHandlerDeps,
  store: EditorHotExitStore,
  root: string,
  relativePath: string,
): Promise<string> {
  const resolvedRoot = await resolveRequestRoot(ctx, deps, root);
  const normalizedPath = normalizeRelativePath(relativePath);
  if (pathIsDenied(normalizedPath)) {
    throw new FilesError(403, "DENIED", DENIED_MESSAGE);
  }
  return store.snapshotRefFor(resolvedRoot.root, normalizedPath);
}

async function validateSnapshotBinding(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  store: EditorHotExitStore,
  root: string,
  relativePath: string,
  snapshotRef: string,
): Promise<boolean> {
  return (await expectedSnapshotRef(ctx, deps, store, root, relativePath)) === snapshotRef;
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

// The declared read-response wire shape for a recovered snapshot (mirrors keiko-ui's
// EditorHotExitReadResponse in packages/keiko-ui/src/lib/api.ts). Deliberately narrower than
// EditorHotExitStoredSnapshot: it omits serverReceivedAt, the server-receipt clock used
// internally for TTL bookkeeping (r6/r8) that was never part of the response contract.
export interface EditorHotExitWireSnapshot {
  readonly schemaVersion: EditorHotExitStoredSnapshot["schemaVersion"];
  readonly content: string;
  readonly baseVersion: EditorHotExitStoredSnapshot["baseVersion"];
  readonly contentHash: string;
  readonly savedContentHash: string | null;
  readonly contentSizeBytes: number;
  readonly updatedAt: number;
  readonly paneId: string;
  readonly windowId: string;
}

// Projects the stored (persistence) snapshot onto exactly the declared wire fields. Built by
// destructuring the declared fields only -- never a spread -- so a future field added to
// EditorHotExitStoredSnapshot (like serverReceivedAt was) does not silently reach the wire; it
// must be added here deliberately.
function projectHotExitSnapshotForWire(
  snapshot: EditorHotExitStoredSnapshot,
): EditorHotExitWireSnapshot {
  const {
    schemaVersion,
    content,
    baseVersion,
    contentHash,
    savedContentHash,
    contentSizeBytes,
    updatedAt,
    paneId,
    windowId,
  } = snapshot;
  return {
    schemaVersion,
    content,
    baseVersion,
    contentHash,
    savedContentHash,
    contentSizeBytes,
    updatedAt,
    paneId,
    windowId,
  };
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
      ctx,
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
    const result = deps.editorHotExitStore.write(snapshot, snapshotRef);
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
        ctx,
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
    return {
      status: 200,
      body:
        snapshot === null
          ? { found: false }
          : { found: true, snapshot: projectHotExitSnapshotForWire(snapshot) },
    };
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
        ctx,
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
