// BFF routes for the live HTML Manual Knowledge Pod create/refresh/job surface (Issue #2063).
//
// Same-origin/Content-Type/CSRF (`x-keiko-csrf`) enforcement and the top-level opaque-500 +
// correlation-id observability are applied centrally in server.ts for every state-changing method —
// these handlers never re-check them; they only thread `ctx.correlationId` into their own
// fail-closed error bodies so a UI-visible opaque error ties back to a redacted operator diagnostic
// (`check:error-observability`). Request bodies are bounded and validated against the contract
// trust-boundary validators before any job starts.

import type { IncomingMessage } from "node:http";
import {
  validateHtmlManualPodCreateRequest,
  validateHtmlManualPodRefreshRequest,
} from "@oscharko-dev/keiko-contracts/runtime/html-manual-job";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  getManualPodJob,
  startManualPodCreate,
  startManualPodRefresh,
  type StartManualPodJobResult,
} from "./manual-pod-service.js";

const MAX_MANUAL_BODY_BYTES = 16_000;

class ManualPodRequestError extends Error {
  public readonly status: number;
  public readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ManualPodRequestError";
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("manual pod request body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_MANUAL_BODY_BYTES) {
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
    throw new ManualPodRequestError(400, "VALIDATION_FAILED", "request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ManualPodRequestError(400, "VALIDATION_FAILED", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function runHandler(
  ctx: RouteContext,
  work: () => Promise<RouteResult> | RouteResult,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody(
          "PAYLOAD_TOO_LARGE",
          "Request body exceeds the size limit.",
          ctx.correlationId,
        ),
      };
    }
    if (error instanceof ManualPodRequestError) {
      return {
        status: error.status,
        body: errorBody(error.code, error.message, ctx.correlationId),
      };
    }
    throw error;
  }
}

function startResult(result: StartManualPodJobResult, ctx: RouteContext): RouteResult {
  if (result.ok) return { status: 202, body: result.job };
  if (result.reason === "no-embedding-model") {
    return {
      status: 409,
      body: errorBody(
        "NO_EMBEDDING_MODEL",
        "No configured embedding model is available. Configure the Model Gateway first.",
        ctx.correlationId,
      ),
    };
  }
  if (result.reason === "job-already-running") {
    return {
      status: 409,
      body: errorBody(
        "MANUAL_POD_JOB_ALREADY_RUNNING",
        "An indexing job is already running for this Knowledge Pod.",
        ctx.correlationId,
      ),
    };
  }
  return {
    status: 400,
    body: errorBody("VALIDATION_FAILED", "The manual source is invalid.", ctx.correlationId),
  };
}

// The service the routes drive. Injectable so the route trust-boundary (validation + correlation-id
// error bodies + success projection) is tested without exercising a crawl or the domain layer.
export interface ManualPodRouteService {
  readonly startRefresh: typeof startManualPodRefresh;
  readonly startCreate: typeof startManualPodCreate;
}

const DEFAULT_SERVICE: ManualPodRouteService = {
  startRefresh: startManualPodRefresh,
  startCreate: startManualPodCreate,
};

export function handleRefreshHtmlManualPod(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  service: ManualPodRouteService = DEFAULT_SERVICE,
): Promise<RouteResult> {
  return runHandler(ctx, async () => {
    const request = validateHtmlManualPodRefreshRequest(await readJsonObject(ctx.req));
    if (!request.ok) {
      return {
        status: 400,
        body: errorBody("VALIDATION_FAILED", request.errors.join("; "), ctx.correlationId),
      };
    }
    return startResult(service.startRefresh(deps, request.value), ctx);
  });
}

export function handleCreateHtmlManualPod(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  service: ManualPodRouteService = DEFAULT_SERVICE,
): Promise<RouteResult> {
  return runHandler(ctx, async () => {
    const request = validateHtmlManualPodCreateRequest(await readJsonObject(ctx.req));
    if (!request.ok) {
      return {
        status: 400,
        body: errorBody("VALIDATION_FAILED", request.errors.join("; "), ctx.correlationId),
      };
    }
    return startResult(await service.startCreate(deps, request.value), ctx);
  });
}

export function handleGetHtmlManualPodJob(ctx: RouteContext): RouteResult {
  const jobId = ctx.params.jobId;
  if (jobId === undefined || jobId.length === 0) {
    return {
      status: 400,
      body: errorBody("VALIDATION_FAILED", "jobId is required", ctx.correlationId),
    };
  }
  const job = getManualPodJob(jobId);
  if (job === undefined) {
    return {
      status: 404,
      body: errorBody("MANUAL_POD_JOB_NOT_FOUND", "Job not found.", ctx.correlationId),
    };
  }
  return { status: 200, body: job };
}
