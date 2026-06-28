// Issue #1387 — four /api/commands/* BFF route handlers for the controlled command runner. CSRF is
// enforced by the server's state-changing-request gate (POST/DELETE flow through it); GET routes are
// read-only and exempt. SSE framing mirrors /api/terminal/*/events and /api/browser/*/events.
//
//   GET    /api/commands/catalog?projectId=…   discovered task catalog (no runner deps required)
//   POST   /api/commands/runs                  run a catalog task → structured result (redacted)
//   DELETE /api/commands/runs/:runId           cancel an in-flight run
//   GET    /api/commands/events                SSE stream of run lifecycle events

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCommandTaskRunRequest } from "@oscharko-dev/keiko-contracts";
import { CommandRunnerError } from "./command-runner-errors.js";
import type { CommandRunInput, CommandRunnerManager } from "./command-runner.js";
import type { CommandRunnerEvent } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { SSE_HEADERS, readyMessage } from "./sse.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "./routes.js";

const MAX_COMMAND_BODY_BYTES = 16_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("command runner request body too large");
    this.name = "BodyTooLargeError";
  }
}

function noRunnerDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody("COMMAND_RUNNER_UNAVAILABLE", "Command runner is not configured for this BFF."),
  };
}

type RouteOrManager = RouteResult | CommandRunnerManager;

function requireRunner(deps: UiHandlerDeps): RouteOrManager {
  return deps.commandRunner ?? noRunnerDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: CommandRunnerError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_COMMAND_BODY_BYTES) {
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
    throw new CommandRunnerError("BAD_REQUEST", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CommandRunnerError("BAD_REQUEST", "Request body must be a JSON object.");
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
    if (error instanceof CommandRunnerError) return toRouteResult(error);
    throw error;
  }
}

// GET /api/commands/catalog — the discovered, vetted task list for a project. Requires the runner so
// discovery uses the same workspace containment as execution.
export async function handleCommandCatalog(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const projectId = ctx.url.searchParams.get("projectId");
    if (projectId === null || projectId.length === 0) {
      throw new CommandRunnerError("BAD_REQUEST", "Query parameter 'projectId' is required.");
    }
    return { status: 200, body: guard.discover(projectId) };
  });
}

// POST /api/commands/runs — run a catalog task. The result carries the structured outcome (exit code,
// duration, truncation, failure reason). Layer-2 redaction is applied to stdout/stderr before the
// body reaches the browser; runCommand already applied Layer-1 env-value redaction.
export async function handleCreateCommandRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const parsed = parseCommandTaskRunRequest(body);
    if (!parsed.ok) {
      throw new CommandRunnerError("BAD_REQUEST", parsed.errors.join("; "));
    }
    const input: CommandRunInput = {
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

export function handleDeleteCommandRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  const runId = ctx.params.runId ?? "";
  if (!guard.abort(runId)) {
    return { status: 404, body: errorBody("RUN_NOT_FOUND", "Command run not found.") };
  }
  return { status: 200, body: { ok: true } };
}

// SSE — one runner event becomes one message with `event: command:<kind>` and a JSON payload. A
// synthetic `ready` is emitted first so the client can transition from connecting to live.
export function handleCommandEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  openCommandSseStream(ctx.res, guard, deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openCommandSseStream(
  res: ServerResponse,
  manager: CommandRunnerManager,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  let seq = 0;
  const unsubscribe = manager.subscribe((event) => {
    seq += 1;
    writeCommandEvent(res, event, seq, redactor);
  });
  res.write(readyMessage());
  res.on("close", () => {
    unsubscribe();
  });
}

function writeCommandEvent(
  res: ServerResponse,
  event: CommandRunnerEvent,
  seq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  const redacted = redactor(event);
  const data = JSON.stringify(redacted);
  const frame = `id: ${String(seq)}\nevent: command:${event.kind}\ndata: ${data}\n\n`;
  if (!res.write(frame)) {
    res.destroy();
  }
}
