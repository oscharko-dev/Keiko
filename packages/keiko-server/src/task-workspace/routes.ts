// BFF routes for managed task-workspace provisioning + activation (Issue #445, Epic #443).
//
//   POST /api/task-workspaces                     provision (create/resume) → { instance, binding }
//   GET  /api/task-workspaces/:workspaceId        read one persisted instance
//   POST /api/task-workspaces/:workspaceId/activate   activate/resume → { instance, binding }
//
// These are the controlled server-side mutating actions the Issue requires (no broad shell, no generic
// Git runner). CSRF is enforced by the server's global state-changing-request gate for POST, exactly
// like the command-runner routes; the GET is read-only. Domain failures map to the structured
// TaskWorkspaceError taxonomy; the response body is redacted before it reaches the browser.

import type { IncomingMessage } from "node:http";
import { isTaskWorkspaceLifecycleState } from "@oscharko-dev/keiko-contracts";
import type { TaskWorkspaceLifecycleState } from "@oscharko-dev/keiko-contracts";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, resolveRoot } from "../files.js";
import { TaskWorkspaceError } from "./errors.js";
import type {
  WorkspaceActivateRequest,
  WorkspaceProvisioningService,
  WorkspaceProvisionRequest,
} from "./types.js";

const MAX_BODY_BYTES = 16_000;
const MAX_FIELD_LENGTH = 512;

class WorkspaceBodyTooLargeError extends Error {
  public constructor() {
    super("task workspace request body too large");
    this.name = "WorkspaceBodyTooLargeError";
  }
}

function unavailable(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "WORKSPACE_PROVISIONING_UNAVAILABLE",
      "Task-workspace provisioning is not configured for this BFF.",
    ),
  };
}

type RouteOrService = RouteResult | WorkspaceProvisioningService;

function requireService(deps: UiHandlerDeps): RouteOrService {
  return deps.workspaceProvisioning ?? unavailable();
}

function isRouteResult(value: RouteOrService): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new WorkspaceBodyTooLargeError());
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
    throw new TaskWorkspaceError("INVALID_REQUEST", "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH
    ? value
    : undefined;
}

function toRouteResult(error: TaskWorkspaceError): RouteResult {
  const detail =
    error.reasons.length > 0 ? `${error.message}: ${error.reasons.join("; ")}` : error.message;
  return { status: error.status, body: errorBody(error.code, detail) };
}

async function runHandler(work: () => Promise<RouteResult>): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkspaceBodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof TaskWorkspaceError) return toRouteResult(error);
    if (error instanceof FilesError)
      return { status: error.status, body: errorBody(error.code, error.message) };
    throw error;
  }
}

function redacted<T>(deps: UiHandlerDeps, value: T): T {
  return deps.redactor(value) as T;
}

function parseProvisionBody(body: Record<string, unknown>): {
  readonly root: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly requestedBy: string;
} {
  const root = boundedString(body.root);
  const taskId = boundedString(body.taskId);
  const baseBranch = boundedString(body.baseBranch);
  const requestedBy = boundedString(body.requestedBy);
  const missing: string[] = [];
  if (root === undefined) missing.push("root");
  if (taskId === undefined) missing.push("taskId");
  if (baseBranch === undefined) missing.push("baseBranch");
  if (requestedBy === undefined) missing.push("requestedBy");
  if (
    root === undefined ||
    taskId === undefined ||
    baseBranch === undefined ||
    requestedBy === undefined
  ) {
    throw new TaskWorkspaceError(
      "INVALID_REQUEST",
      `missing or invalid fields: ${missing.join(", ")}`,
    );
  }
  return { root, taskId, baseBranch, requestedBy };
}

function parseExpectedState(value: unknown): TaskWorkspaceLifecycleState | undefined {
  if (value === undefined) return undefined;
  if (!isTaskWorkspaceLifecycleState(value)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "expectedLifecycleState is invalid");
  }
  return value;
}

// POST /api/task-workspaces — provision (create or resume) a managed task workspace.
export async function handleProvisionTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireService(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const parsed = parseProvisionBody(body);
    const resolvedRoot = await resolveRoot(deps.store, parsed.root, deps.redactor);
    const request: WorkspaceProvisionRequest = {
      repositoryRequestPath: resolvedRoot.realRoot,
      taskId: parsed.taskId,
      baseBranch: parsed.baseBranch,
      requestedBy: parsed.requestedBy,
    };
    const result = await guard.provision(request);
    return {
      status: result.created ? 201 : 200,
      body: redacted(deps, {
        instance: result.instance,
        binding: result.binding,
        created: result.created,
      }),
    };
  });
}

// GET /api/task-workspaces/:workspaceId — read one persisted WorkspaceInstance.
export function handleGetTaskWorkspace(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireService(deps);
  if (isRouteResult(guard)) return guard;
  const workspaceId = ctx.params.workspaceId ?? "";
  const instance = guard.getInstance(workspaceId);
  if (instance === undefined) {
    return { status: 404, body: errorBody("WORKSPACE_NOT_FOUND", "Task workspace not found.") };
  }
  return { status: 200, body: redacted(deps, { instance }) };
}

// POST /api/task-workspaces/:workspaceId/activate — activate/resume a workspace and yield its binding.
export async function handleActivateTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireService(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const workspaceId = ctx.params.workspaceId ?? "";
    const body = await readJsonObject(ctx.req);
    const requestedBy = boundedString(body.requestedBy);
    if (requestedBy === undefined) {
      throw new TaskWorkspaceError("INVALID_REQUEST", "missing or invalid field: requestedBy");
    }
    const request: WorkspaceActivateRequest = {
      workspaceId,
      taskId: boundedString(body.taskId) ?? "",
      requestedBy,
      acquireLock: body.acquireLock === true,
      ...(parseExpectedState(body.expectedLifecycleState) !== undefined
        ? { expectedLifecycleState: parseExpectedState(body.expectedLifecycleState) }
        : {}),
    };
    const result = await guard.activate(request);
    return {
      status: 200,
      body: redacted(deps, { instance: result.instance, binding: result.binding }),
    };
  });
}
