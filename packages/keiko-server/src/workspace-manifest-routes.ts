// Issue #2524 — server routes for M11 workspace-manifest membership and focus. Every stored
// mutation carries a closed WorkspaceRootDispatch; no active/focused-root fallback exists.

import type { IncomingMessage } from "node:http";
import { workspaceManifestAccessResponse } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "./diagnostics-log.js";
import { errorBody } from "./routes.js";
import type { RouteContext, RouteDefinition, RouteResult } from "./routes.js";
// KEIKO-0622: errorStatus lives in ./workspace-manifest-error-status.js so unit tests can import
// it without triggering the routes.ts <-> workspace-manifest-routes.ts import cycle.
import { errorStatus } from "./workspace-manifest-error-status.js";
import { WorkspaceManifestError, WorkspaceManifestService } from "./workspace-manifests.js";
import type { WorkspaceManifestMutationResult } from "./workspace-manifests.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";

const MAX_BODY_BYTES = 65_536;

class InvalidWorkspaceRequest extends Error {}

// Every successful route in this group projects a manifest or binding containing canonical roots.
// Mutations therefore check the existing launcher-paired read authority before parsing the body or
// touching membership; the cookie admits disclosure, while the closed dispatch remains the sole
// routing intent and is revalidated independently before any effect.
function hasWorkspacePathReadAuthority(ctx: RouteContext, deps: UiHandlerDeps): boolean {
  return resolveAppSessionReadAuthority(deps, ctx.req) !== undefined;
}

function unpairedWorkspaceList(): RouteResult {
  return { status: 200, body: workspaceManifestAccessResponse("unpaired", []) };
}

function unpairedWorkspaceRequest(correlationId: string | undefined): RouteResult {
  return {
    status: 403,
    body: errorBody("APP_SESSION_REQUIRED", "The local app session is not paired.", correlationId),
  };
}

function failure(error: unknown, correlationId: string | undefined): RouteResult {
  if (error instanceof WorkspaceManifestError) {
    return {
      status: errorStatus(error),
      body: errorBody(error.code, error.message, correlationId),
    };
  }
  if (error instanceof InvalidWorkspaceRequest) {
    return {
      status: 400,
      body: errorBody("WORKSPACE_REQUEST_INVALID", "Workspace request is invalid.", correlationId),
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

/** Declared, code-owned class name for the diagnostic below — never derived from request data. */
class WorkspaceRootNotRestoredError extends Error {}

/**
 * Redacted operator signal for a post-commit propagation step that could not complete.
 * `occurrenceCount` carries a bounded numeric fact (e.g. how many roots were affected) through the
 * same record the error class travels in, rather than being baked into a message string the
 * diagnostic sink never reads (#2768).
 */
function reportRootBindingFailure(
  deps: UiHandlerDeps,
  workspaceId: string,
  operation: string,
  error: unknown,
  occurrenceCount?: number,
): void {
  const record = serverDiagnosticFromError({
    correlationId: workspaceId,
    operation,
    source: "workspace-manifest-routes",
    error,
    redact: (message): string => {
      const redacted = deps.redactor(message);
      return typeof redacted === "string" ? redacted : "[REDACTED]";
    },
  });
  emitServerDiagnostic(
    deps.diagnostics,
    occurrenceCount === undefined ? record : { ...record, occurrenceCount },
  );
}

/**
 * `restoreFailureClasses` names every restore that threw while the store attempted to give a
 * released root back its own standalone workspace. It is independent of `unrestoredProjectPaths`
 * and NOT index-aligned with it — a restore can leave a project unrestored without throwing at
 * all — so the two facts are never zipped into one record. Each distinct class is reported on its
 * own, grouped only with occurrences of itself, as the reason half of the count-and-reason pair
 * this diagnostic exists to carry.
 */
function reportRestoreFailureClasses(
  deps: UiHandlerDeps,
  workspaceId: string,
  restoreFailureClasses: readonly string[],
): void {
  const occurrencesByClass = new Map<string, number>();
  for (const errorClass of restoreFailureClasses) {
    occurrencesByClass.set(errorClass, (occurrencesByClass.get(errorClass) ?? 0) + 1);
  }
  for (const [errorClass, occurrenceCount] of occurrencesByClass) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId: workspaceId,
      timestamp: new Date().toISOString(),
      operation: "workspace.root.restore.reason",
      source: "workspace-manifest-routes",
      errorClass,
      message: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      occurrenceCount,
    });
  }
}

/**
 * The one seam where a membership change is turned into binding invalidation. ADR-0147 requires
 * root removal and replacement to invalidate grants, settings bindings, sessions, and envelopes;
 * before #2620 only trust listened here, so per-root settings survived their root.
 *
 * The two inputs are deliberately different sets. `affectedRoots` is the whole workspace, because
 * changing membership changes every member's composed authority. `invalidatedRoots` is only the
 * roots that left or were replaced — dropping a surviving root's per-root settings because a
 * sibling was removed would destroy state the human never touched.
 */
async function applyRootBindingChanges(
  deps: UiHandlerDeps,
  result: WorkspaceManifestMutationResult,
): Promise<void> {
  const workspaceId = result.manifest.workspaceId;
  deps.workspaceScriptTrust?.recomputeForRoots?.(result.affectedRoots);
  // A root that left with no workspace of its own stays registered and undispatchable. The
  // membership change is already committed and must not be undone for it, but the loss is a real
  // degradation and is surfaced here rather than dying inside the store transaction — with both
  // the count and the failure reason reaching the operator record, not just a message string the
  // diagnostic sink never reads (#2768).
  if (result.unrestoredProjectPaths.length > 0) {
    reportRootBindingFailure(
      deps,
      workspaceId,
      "workspace.root.restore",
      new WorkspaceRootNotRestoredError(),
      result.unrestoredProjectPaths.length,
    );
  }
  reportRestoreFailureClasses(deps, workspaceId, result.restoreFailureClasses);
  const invalidate = deps.editorSettingsControl?.invalidateRoot;
  if (invalidate === undefined) return;
  for (const root of result.invalidatedRoots) {
    // The membership change is already committed, so a propagation failure must not be reported as
    // a failed mutation: the caller would see a 500 for a removal that did happen, and retrying it
    // would then fail as a non-member. It is reported as a redacted operator diagnostic instead,
    // the same shape managed-LSP restriction propagation uses. This stays defence in depth — the
    // record binds the root's filesystem identity, so a replaced root cannot inherit it even when
    // this rewrite never lands.
    await invalidate(root).catch((error: unknown): void => {
      reportRootBindingFailure(deps, workspaceId, "workspace.root.settings.invalidate", error);
    });
  }
}

export function handleListWorkspaceManifests(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  if (!hasWorkspacePathReadAuthority(ctx, deps)) return unpairedWorkspaceList();
  try {
    // The pairing marker is asserted on BOTH outcomes, never left to be inferred from its absence:
    // clients read it as an authority input (an unpaired window cannot resolve run authority,
    // ADR-0141), so silence must stay indistinguishable from "not asserted" rather than being
    // coerced into a pairing this route never granted. The contracts-owned producer is what makes
    // that structural (ADR-0019) — the marker is part of the shape, not of this call site.
    return {
      status: 200,
      body: workspaceManifestAccessResponse(
        "paired",
        new WorkspaceManifestService(deps.store).list(),
      ),
    };
  } catch (error) {
    return failure(error, ctx.correlationId);
  }
}

export function handleGetWorkspaceManifest(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  if (!hasWorkspacePathReadAuthority(ctx, deps)) {
    return unpairedWorkspaceRequest(ctx.correlationId);
  }
  try {
    const service = new WorkspaceManifestService(deps.store);
    const manifest = service.get(ctx.params.workspaceId ?? "");
    // KEIKO-0538: the previous `binding` field repurposed WorkspaceBindingV2.taskId to hold the
    // plain workspaceId (via WorkspaceManifestService.binding), a latent trap for any future
    // consumer expecting a genuine Coding Workbench task id. No UI consumer reads it today, so
    // we drop it rather than propagate the ambiguity.
    return { status: 200, body: { manifest } };
  } catch (error) {
    return failure(error, ctx.correlationId);
  }
}

export async function handleAddWorkspaceRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasWorkspacePathReadAuthority(ctx, deps)) {
    return unpairedWorkspaceRequest(ctx.correlationId);
  }
  try {
    const body = await readBody(ctx.req, ["dispatch", "projectPath"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).addRoot(
      dispatchForWorkspace(body, workspaceId),
      requiredString(body, "projectPath"),
    );
    await applyRootBindingChanges(deps, result);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error, ctx.correlationId);
  }
}

export async function handleRemoveWorkspaceRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasWorkspacePathReadAuthority(ctx, deps)) {
    return unpairedWorkspaceRequest(ctx.correlationId);
  }
  try {
    const body = await readBody(ctx.req, ["dispatch"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).removeRoot(
      dispatchForWorkspace(body, workspaceId),
      ctx.params.rootRef ?? "",
    );
    await applyRootBindingChanges(deps, result);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error, ctx.correlationId);
  }
}

export async function handleReorderWorkspaceRoots(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasWorkspacePathReadAuthority(ctx, deps)) {
    return unpairedWorkspaceRequest(ctx.correlationId);
  }
  try {
    const body = await readBody(ctx.req, ["dispatch", "orderedRootRefs"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).reorderRoots(
      dispatchForWorkspace(body, workspaceId),
      requiredStringArray(body, "orderedRootRefs"),
    );
    await applyRootBindingChanges(deps, result);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error, ctx.correlationId);
  }
}

export async function handleFocusWorkspaceRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (!hasWorkspacePathReadAuthority(ctx, deps)) {
    return unpairedWorkspaceRequest(ctx.correlationId);
  }
  try {
    const body = await readBody(ctx.req, ["dispatch", "focusedRootRef"]);
    const workspaceId = ctx.params.workspaceId ?? "";
    const result = new WorkspaceManifestService(deps.store).focusRoot(
      dispatchForWorkspace(body, workspaceId),
      requiredString(body, "focusedRootRef"),
    );
    await applyRootBindingChanges(deps, result);
    return { status: 200, body: { manifest: result.manifest } };
  } catch (error) {
    return failure(error, ctx.correlationId);
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
