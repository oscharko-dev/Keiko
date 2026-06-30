import type { IncomingMessage } from "node:http";
import {
  parseUpdateRemediationActionRequest,
  parseUpdateRemediationStatusRequest,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import { UpdateRemediationError, type UpdateRemediationManager } from "./update-remediation.js";

const MAX_UPDATE_REMEDIATION_BODY_BYTES = 32_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("update remediation request body too large");
    this.name = "BodyTooLargeError";
  }
}

type RouteOrManager = RouteResult | UpdateRemediationManager;

function noUpdateRemediationDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody("UPDATE_REMEDIATION_UNAVAILABLE", "Update remediation is not configured."),
  };
}

function requireUpdateRemediation(deps: UiHandlerDeps): RouteOrManager {
  return deps.updateRemediation ?? noUpdateRemediationDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: UpdateRemediationError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_UPDATE_REMEDIATION_BODY_BYTES) {
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
    throw new UpdateRemediationError("BAD_REQUEST", "Request body is not valid JSON.", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UpdateRemediationError("BAD_REQUEST", "Request body must be a JSON object.", 400);
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
    if (error instanceof UpdateRemediationError) return toRouteResult(error);
    throw error;
  }
}

export function handleGetUpdateRemediation(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireUpdateRemediation(deps);
  if (isRouteResult(guard)) return guard;
  return { status: 200, body: guard.getStatus() };
}

export async function handlePostUpdateRemediationStatus(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireUpdateRemediation(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const parsed = parseUpdateRemediationStatusRequest(await readJsonObject(ctx.req));
    if (!parsed.ok) {
      throw new UpdateRemediationError("BAD_REQUEST", parsed.errors.join("; "), 400);
    }
    return { status: 200, body: guard.getStatus({ ...parsed.value, persist: true }) };
  });
}

export async function handleRunUpdateRemediationAction(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireUpdateRemediation(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const parsed = parseUpdateRemediationActionRequest(await readJsonObject(ctx.req));
    if (!parsed.ok) {
      throw new UpdateRemediationError("BAD_REQUEST", parsed.errors.join("; "), 400);
    }
    return { status: 200, body: await guard.runAction(parsed.value) };
  });
}
