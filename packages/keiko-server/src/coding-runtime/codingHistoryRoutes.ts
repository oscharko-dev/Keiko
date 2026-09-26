import type { UiHandlerDeps } from "../deps.js";
import { errorBody, type RouteContext, type RouteDefinition, type RouteResult } from "../routes.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import { readJsonRequestBody } from "../bounded-request-body.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

function unavailable(ctx: RouteContext): RouteResult {
  return {
    status: 404,
    body: errorBody("CODING_HISTORY_UNAVAILABLE", "Coding task not available.", ctx.correlationId),
  };
}

export function listCodingHistory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) return unavailable(ctx);
  const history = deps.codingRuntimeOrchestrator?.getHistory();
  if (history === undefined) return unavailable(ctx);
  return {
    status: 200,
    body: { tasks: history.list(ctx.correlationId ?? UNKNOWN_CORRELATION_ID) },
  };
}

export function readCodingHistory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) return unavailable(ctx);
  const detail = deps.codingRuntimeOrchestrator
    ?.getHistory()
    ?.detail(ctx.params.id ?? "", ctx.correlationId ?? UNKNOWN_CORRELATION_ID);
  return detail === undefined ? unavailable(ctx) : { status: 200, body: detail };
}

export async function updateCodingHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) return unavailable(ctx);
  const history = deps.codingRuntimeOrchestrator?.getHistory();
  const id = ctx.params.id ?? "";
  if (history?.detail(id, ctx.correlationId ?? UNKNOWN_CORRELATION_ID) === undefined)
    return unavailable(ctx);
  const raw = await readJsonRequestBody(ctx.req, 4096, ctx.correlationId);
  const blocked = updateBlocked(raw, ctx, deps);
  if (blocked !== undefined) return blocked;
  if (!validPatch(raw))
    return {
      status: 400,
      body: errorBody("INVALID_REQUEST", "Invalid coding task update.", ctx.correlationId),
    };
  const task = history.update(id, raw, ctx.correlationId ?? UNKNOWN_CORRELATION_ID);
  return { status: 200, body: { task } };
}

function updateBlocked(
  raw: Record<string, unknown>,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult | undefined {
  if ((raw.status === 400 || raw.status === 413) && "body" in raw)
    return { status: raw.status, body: raw.body };
  if (deps.codingRuntimeOrchestrator?.hasLiveRun() && raw.status === "completed")
    return {
      status: 409,
      body: errorBody(
        "ACTIVE_RUN_CONFLICT",
        "Stop the active run before completing a task.",
        ctx.correlationId,
      ),
    };
  return undefined;
}

function validPatch(value: unknown): value is { title?: string; status?: "active" | "completed" } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  if (
    Object.keys(patch).length === 0 ||
    Object.keys(patch).some((key) => key !== "title" && key !== "status")
  )
    return false;
  if (!validTitle(patch.title)) return false;
  return patch.status === undefined || patch.status === "active" || patch.status === "completed";
}

function validTitle(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.trim().length > 0 && value.length <= 100)
  );
}

export const CODING_HISTORY_ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/coding-workbench/history", handler: listCodingHistory },
  { method: "GET", pattern: "/api/coding-workbench/history/:id", handler: readCodingHistory },
  { method: "PATCH", pattern: "/api/coding-workbench/history/:id", handler: updateCodingHistory },
];
