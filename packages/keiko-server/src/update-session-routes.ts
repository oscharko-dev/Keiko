import type { IncomingMessage } from "node:http";
import {
  parseUpdateRestartVerificationRequest,
  parseUpdateSessionStartRequest,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import {
  errorBody,
  type RouteContext,
  type RouteResult,
} from "./routes.js";
import { UpdateSessionError, type UpdateSessionManager } from "./update-session.js";

const MAX_UPDATE_SESSION_BODY_BYTES = 16_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("update session request body too large");
    this.name = "BodyTooLargeError";
  }
}

type RouteOrManager = RouteResult | UpdateSessionManager;

function noUpdateSessionDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody("UPDATE_SESSION_UNAVAILABLE", "Update session runner is not configured."),
  };
}

function requireUpdateSession(deps: UiHandlerDeps): RouteOrManager {
  return deps.updateSession ?? noUpdateSessionDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: UpdateSessionError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_UPDATE_SESSION_BODY_BYTES) {
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
      if (!capped) resolveBody(Buffer.concat(chunks).toString("utf8"));
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
    throw new UpdateSessionError("BAD_REQUEST", "Request body is not valid JSON.", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UpdateSessionError("BAD_REQUEST", "Request body must be a JSON object.", 400);
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
    if (error instanceof UpdateSessionError) return toRouteResult(error);
    throw error;
  }
}

export function handleGetUpdateSession(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const guard = requireUpdateSession(deps);
  if (isRouteResult(guard)) return guard;
  return { status: 200, body: guard.getStatus() };
}

export async function handleCreateUpdateSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireUpdateSession(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const parsed = parseUpdateSessionStartRequest(await readJsonObject(ctx.req));
    if (!parsed.ok) {
      throw new UpdateSessionError("BAD_REQUEST", parsed.errors.join("; "), 400);
    }
    const outcome = guard.start(parsed.value);
    return { status: outcome.reused ? 200 : 202, body: outcome.session };
  });
}

export function handleRetryUpdateSession(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const guard = requireUpdateSession(deps);
  if (isRouteResult(guard)) return guard;
  try {
    const outcome = guard.retry();
    return { status: outcome.reused ? 200 : 202, body: outcome.session };
  } catch (error) {
    if (error instanceof UpdateSessionError) return toRouteResult(error);
    throw error;
  }
}

export function handleCancelUpdateSession(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const guard = requireUpdateSession(deps);
  if (isRouteResult(guard)) return guard;
  try {
    return { status: 200, body: guard.cancel() };
  } catch (error) {
    if (error instanceof UpdateSessionError) return toRouteResult(error);
    throw error;
  }
}

export async function handleVerifyUpdateRestart(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireUpdateSession(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const parsed = parseUpdateRestartVerificationRequest(await readJsonObject(ctx.req));
    if (!parsed.ok) {
      throw new UpdateSessionError("BAD_REQUEST", parsed.errors.join("; "), 400);
    }
    return { status: 200, body: guard.verifyRestart(parsed.value.targetVersion) };
  });
}
