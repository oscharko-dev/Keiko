import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { currentAuditRedactString, type UiHandlerDeps } from "../deps.js";
import { errorBody, type RouteContext, type RouteDefinition, type RouteResult } from "../routes.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { CodingTaskExportRefusal, CodingTaskExportResult } from "./codingTaskExport.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";

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

interface ExportRefusalResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

// An unpaired caller and another operator's task read exactly like an unknown task: `unavailable`.
const EXPORT_REFUSALS: Readonly<
  Record<Exclude<CodingTaskExportRefusal, "unauthenticated" | "unavailable">, ExportRefusalResponse>
> = {
  "invalid-format": {
    status: 400,
    code: "INVALID_REQUEST",
    message: "Invalid coding task export format.",
  },
  "too-large": {
    status: 413,
    code: "CODING_HISTORY_EXPORT_TOO_LARGE",
    message: "The coding task export is too large.",
  },
  failed: { status: 500, code: "INTERNAL", message: "The coding task could not be exported." },
};

function exportRefusal(reason: CodingTaskExportRefusal, ctx: RouteContext): RouteResult {
  if (reason === "unauthenticated" || reason === "unavailable") return unavailable(ctx);
  const { status, code, message } = EXPORT_REFUSALS[reason];
  return { status, body: errorBody(code, message, ctx.correlationId) };
}

function exportOutcome(result: CodingTaskExportResult, ctx: RouteContext): RouteResult {
  if (result.kind === "refused") return exportRefusal(result.reason, ctx);
  return { status: 200, body: result.response, headers: { "Cache-Control": "no-store" } };
}

/**
 * The user-controlled local export of one task (#3904): admitted like every other Coding History
 * read, redacted again at this boundary and handed to the browser, which saves it. The server
 * keeps no copy and sends nothing anywhere.
 */
export function exportCodingHistory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const history = deps.codingRuntimeOrchestrator?.getHistory();
  if (history === undefined) return unavailable(ctx);
  const result = history.exportTask(
    {
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
      taskId: ctx.params.id ?? "",
      requestedFormat: ctx.url.searchParams.get("format"),
      authenticated: resolveAppSessionReadAuthority(deps, ctx.req) !== undefined,
    },
    {
      keikoVersion: SDK_VERSION,
      opencodeRuntimePinnedVersion: OPENCODE_PINNED_VERSION,
      redactText: currentAuditRedactString(deps),
      now: Date.now,
    },
  );
  return exportOutcome(result, ctx);
}

export async function updateCodingHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) return unavailable(ctx);
  const history = deps.codingRuntimeOrchestrator?.getHistory();
  const id = ctx.params.id ?? "";
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  if (history?.detail(id, correlationId) === undefined) return unavailable(ctx);
  const outcome = await readJsonRequestBodyOutcome(ctx.req, 4096, ctx.correlationId);
  if (outcome.kind === "rejected") return outcome.response;
  const raw = outcome.value;
  const blocked = updateBlocked(raw, ctx, deps);
  if (blocked !== undefined) return blocked;
  if (!validPatch(raw))
    return {
      status: 400,
      body: errorBody("INVALID_REQUEST", "Invalid coding task update.", ctx.correlationId),
    };
  const task = history.update(id, raw, correlationId);
  return { status: 200, body: { task } };
}

function updateBlocked(
  raw: Record<string, unknown>,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult | undefined {
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
  {
    method: "GET",
    pattern: "/api/coding-workbench/history/:id/export",
    handler: exportCodingHistory,
  },
];
