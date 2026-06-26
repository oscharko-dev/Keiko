// Issue #1388 (Epic #1491, ADR-0070, D5) — five /api/containers/* BFF route handlers for the governed
// container pilot. CSRF is enforced by the server's state-changing-request gate (POST/DELETE flow
// through it); GET routes are read-only and exempt. SSE framing mirrors /api/commands/*/events.
// Layer-2 redaction is applied to the run RESULT and to EVERY SSE frame. The capability route
// additionally requires a registered project root when `root` is supplied.
//
//   GET    /api/containers/capability?root=…   active engine probe → ContainerCapabilityResponse
//   GET    /api/containers/catalog?projectId=…  catalog (503 when no engine)
//   POST   /api/containers/runs                 run a catalog task → structured result (redacted)
//   DELETE /api/containers/runs/:runId          cancel an in-flight run
//   GET    /api/containers/events               SSE stream of run lifecycle events (redacted)

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseContainerRunRequest } from "@oscharko-dev/keiko-contracts";
import type { ContainerRunnerEvent } from "@oscharko-dev/keiko-contracts";
import { ContainerRunnerError } from "./containerRunner-errors.js";
import type { ContainerRunInput, ContainerRunnerManager } from "./containerRunner.js";
import type { UiHandlerDeps } from "../deps.js";
import { SSE_HEADERS, readyMessage } from "../sse.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "../routes.js";

const MAX_CONTAINER_BODY_BYTES = 16_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("container runner request body too large");
    this.name = "BodyTooLargeError";
  }
}

function noRunnerDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "CONTAINER_ENGINE_UNAVAILABLE",
      "Container runner is not configured for this BFF.",
    ),
  };
}

type RouteOrManager = RouteResult | ContainerRunnerManager;

function requireRunner(deps: UiHandlerDeps): RouteOrManager {
  return deps.containerRunner ?? noRunnerDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: ContainerRunnerError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_CONTAINER_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContainerRunnerError("BAD_REQUEST", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ContainerRunnerError("BAD_REQUEST", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function runHandler(work: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof ContainerRunnerError) return toRouteResult(error);
    throw error;
  }
}

function redactValue(deps: UiHandlerDeps, value: unknown): unknown {
  return deps.redactor(value);
}

// GET /api/containers/capability — active daemon probe. When `root` is supplied it MUST be a
// registered project (403 WORKSPACE_NOT_REGISTERED otherwise); `root` absent is allowed because the
// capability is host-level (no workspace mount context needed for detection). The response is redacted.
export async function handleContainerCapability(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  const rawRoot = ctx.url.searchParams.get("root");
  const root = rawRoot === null ? undefined : rawRoot.trim();
  if (root !== undefined && root.length > 0) {
    if (!deps.store.listProjects().some((project) => project.path === root)) {
      return {
        status: 403,
        body: errorBody(
          "WORKSPACE_NOT_REGISTERED",
          "The workspace directory is not a registered project.",
        ),
      };
    }
  }
  return runHandler(async () => {
    const capability = await guard.capability(root ?? "");
    return { status: 200, body: redactValue(deps, capability) };
  });
}

// GET /api/containers/catalog — the allowlisted catalog for a project. 503 when no engine is
// available so the surface degrades gracefully rather than throwing.
export async function handleContainerCatalog(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const projectId = ctx.url.searchParams.get("projectId");
    if (projectId === null || projectId.length === 0) {
      throw new ContainerRunnerError("BAD_REQUEST", "Query parameter 'projectId' is required.");
    }
    const catalog = await guard.listCatalog(projectId);
    if (!catalog.engineAvailable) {
      throw new ContainerRunnerError(
        "CONTAINER_ENGINE_UNAVAILABLE",
        "No container engine is available.",
      );
    }
    return { status: 200, body: redactValue(deps, catalog) };
  });
}

// POST /api/containers/runs — run a catalog task. The result carries the structured outcome; Layer-2
// redaction is applied to stdout/stderr before the body reaches the browser. An engine-unavailable
// governance failure throws CONTAINER_ENGINE_UNAVAILABLE (503) before any run id is minted.
export async function handleCreateContainerRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const parsed = parseContainerRunRequest(body);
    if (!parsed.ok) {
      throw new ContainerRunnerError("BAD_REQUEST", parsed.errors.join("; "));
    }
    const input: ContainerRunInput = {
      projectId: parsed.value.projectId,
      taskId: parsed.value.taskId,
      ...(parsed.value.timeoutMs === undefined ? {} : { timeoutMs: parsed.value.timeoutMs }),
      ...(parsed.value.requestId === undefined ? {} : { requestId: parsed.value.requestId }),
    };
    const raw = await guard.execute(input);
    const redactStr = (value: string): string => {
      const redacted = deps.redactor(value);
      return typeof redacted === "string" ? redacted : value;
    };
    const result = { ...raw, stdout: redactStr(raw.stdout), stderr: redactStr(raw.stderr) };
    return { status: 200, body: result };
  });
}

export function handleDeleteContainerRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  const runId = ctx.params.runId ?? "";
  if (!guard.abort(runId)) {
    return { status: 404, body: errorBody("RUN_NOT_FOUND", "Container run not found.") };
  }
  return { status: 200, body: { ok: true } };
}

// SSE — one runner event becomes one message with `event: container:<kind>` and a redacted JSON
// payload. A synthetic `ready` is emitted first so the client can transition from connecting to live.
export function handleContainerEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  openContainerSseStream(ctx.res, guard, deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openContainerSseStream(
  res: ServerResponse,
  manager: ContainerRunnerManager,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  let seq = 0;
  const unsubscribe = manager.subscribe((event) => {
    seq += 1;
    writeContainerEvent(res, event, seq, redactor);
  });
  res.write(readyMessage());
  res.on("close", () => {
    unsubscribe();
  });
}

function writeContainerEvent(
  res: ServerResponse,
  event: ContainerRunnerEvent,
  seq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  const redacted = redactor(event);
  const data = JSON.stringify(redacted);
  const frame = `id: ${String(seq)}\nevent: container:${event.kind}\ndata: ${data}\n\n`;
  if (!res.write(frame)) {
    res.destroy();
  }
}
