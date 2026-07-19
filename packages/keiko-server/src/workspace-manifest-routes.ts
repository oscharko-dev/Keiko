// Issue #2524 — server routes for M11 workspace-manifest membership and focus. Every stored
// mutation carries a closed WorkspaceRootDispatch; no active/focused-root fallback exists.

import type { IncomingMessage } from "node:http";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody } from "./routes.js";
import type { RouteContext, RouteDefinition, RouteResult } from "./routes.js";
import { WorkspaceManifestError, WorkspaceManifestService } from "./workspace-manifests.js";

const MAX_BODY_BYTES = 65_536;

class InvalidWorkspaceRequest extends Error {}

function errorStatus(error: WorkspaceManifestError): number {
  if (error.code === "WORKSPACE_MANIFEST_UNAVAILABLE") return 404;
  if (error.code === "WORKSPACE_PROJECT_NOT_FOUND") return 404;
  if (error.code === "WORKSPACE_ROOT_NOT_MEMBER") return 403;
  if (error.code === "WORKSPACE_DISPATCH_INVALID") return 400;
  return 409;
}

function failure(error: unknown): RouteResult {
  if (error instanceof WorkspaceManifestError) {
    return { status: errorStatus(error), body: errorBody(error.code, error.message) };
  }
  if (error instanceof InvalidWorkspaceRequest) {
    return {
      status: 400,
      body: errorBody("WORKSPACE_REQUEST_INVALID", "Workspace request is invalid."),
    };
  }
  throw error;
}

async function bodyText(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new InvalidWorkspaceRequest());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readBody(
  req: IncomingMessage,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await bodyText(req));
  } catch (error) {
    if (error instanceof InvalidWorkspaceRequest) throw error;
    throw new InvalidWorkspaceRequest();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWorkspaceRequest();
  }
  const body = parsed as Record<string, unknown>;
  if (!Object.keys(body).every((key) => allowedKeys.includes(key))) {
    throw new InvalidWorkspaceRequest();
  }
  return body;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new InvalidWorkspaceRequest();
  return value;
}

function requiredStringArray(body: Record<string, unknown>, key: string): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new InvalidWorkspaceRequest();
  }
  return value;
}

function dispatchForWorkspace(body: Record<string, unknown>, workspaceId: string): unknown {
  const dispatch = body.dispatch;
  if (
    typeof dispatch !== "object" ||
    dispatch === null ||
    Array.isArray(dispatch) ||
    (dispatch as Record<string, unknown>).workspaceId !== workspaceId
  ) {
    throw new InvalidWorkspaceRequest();
  }
  return dispatch;
}

function recomputeTrust(deps: UiHandlerDeps, roots: readonly string[]): void {
  deps.workspaceScriptTrust?.recomputeForRoots?.(roots);
}

export function handleListWorkspaceManifests(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  try {
    return { status: 200, body: { manifests: new WorkspaceManifestService(deps.store).list() } };
  } catch (error) {
    return failure(error);
  }
}

export function handleGetWorkspaceManifest(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  try {
    const service = new WorkspaceManifestService(deps.store);
    const manifest = service.get(ctx.params.workspaceId ?? "");
    return { status: 200, body: { manifest, binding: service.binding(manifest.workspaceId) } };
  } catch (error) {
    return failure(error);
  }
}

export async function handleAddWorkspaceRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readBody(ctx.req, ["dispatch", "projectPath"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).addRoot(
      dispatchForWorkspace(body, workspaceId),
      requiredString(body, "projectPath"),
    );
    recomputeTrust(deps, result.affectedRoots);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error);
  }
}

export async function handleRemoveWorkspaceRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readBody(ctx.req, ["dispatch"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).removeRoot(
      dispatchForWorkspace(body, workspaceId),
      ctx.params.rootRef ?? "",
    );
    recomputeTrust(deps, result.affectedRoots);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error);
  }
}

export async function handleReorderWorkspaceRoots(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readBody(ctx.req, ["dispatch", "orderedRootRefs"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).reorderRoots(
      dispatchForWorkspace(body, workspaceId),
      requiredStringArray(body, "orderedRootRefs"),
    );
    recomputeTrust(deps, result.affectedRoots);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error);
  }
}

export async function handleFocusWorkspaceRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readBody(ctx.req, ["dispatch", "focusedRootRef"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).focusRoot(
      dispatchForWorkspace(body, workspaceId),
      requiredString(body, "focusedRootRef"),
    );
    recomputeTrust(deps, result.affectedRoots);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error);
  }
}

export const WORKSPACE_MANIFEST_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/workspaces", handler: handleListWorkspaceManifests },
  { method: "GET", pattern: "/api/workspaces/:workspaceId", handler: handleGetWorkspaceManifest },
  {
    method: "POST",
    pattern: "/api/workspaces/:workspaceId/roots",
    handler: handleAddWorkspaceRoot,
  },
  {
    method: "DELETE",
    pattern: "/api/workspaces/:workspaceId/roots/:rootRef",
    handler: handleRemoveWorkspaceRoot,
  },
  {
    method: "PUT",
    pattern: "/api/workspaces/:workspaceId/roots/order",
    handler: handleReorderWorkspaceRoots,
  },
  {
    method: "PUT",
    pattern: "/api/workspaces/:workspaceId/focus",
    handler: handleFocusWorkspaceRoot,
  },
];
