// ADR-0013 D7 — Route handlers for the 10 additive store routes (13–22). All inputs are validated;
// every error path uses the redacted `{ error: { code, message } }` envelope; SECURITY_HEADERS are
// applied uniformly by the server layer. JSON body reading is bounded by MAX_STORE_BODY_BYTES.

import type { IncomingMessage } from "node:http";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  UiStoreError,
  isProjectAvailable,
  type ChatRole,
  type Project,
  type UpdateChatPatch,
  type UpdateProjectPatch,
  type WorkflowStatus,
} from "./store/index.js";

const MAX_STORE_BODY_BYTES = 256_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Body parsing helpers
// ──────────────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STORE_BODY_BYTES) {
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
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    throw new InvalidRequest("Failed to read request body.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRequest("Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

class InvalidRequest extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Error mapping
// ──────────────────────────────────────────────────────────────────────────

function uiStoreErrorResult(error: UiStoreError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function badRequest(code: string, message: string): RouteResult {
  return { status: 400, body: errorBody(code, message) };
}

function notFoundResult(message: string): RouteResult {
  return { status: 404, body: errorBody("not_found", message) };
}

function payloadTooLarge(): RouteResult {
  return {
    status: 413,
    body: errorBody("payload_too_large", "Request body exceeds the size limit."),
  };
}

async function runHandler(
  worker: () => Promise<RouteResult> | RouteResult,
): Promise<RouteResult> {
  try {
    return await worker();
  } catch (error) {
    if (error instanceof BodyTooLargeError) return payloadTooLarge();
    if (error instanceof InvalidRequest) return badRequest("invalid_request", error.message);
    if (error instanceof UiStoreError) return uiStoreErrorResult(error);
    throw error;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Field validators (typed narrowing from JSON)
// ──────────────────────────────────────────────────────────────────────────

function requireString(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new InvalidRequest(`Field "${name}" is required.`);
  }
  return v;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new InvalidRequest(`Field "${name}" must be a string.`);
  return v;
}

function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new InvalidRequest(`Field "${name}" must be a boolean.`);
  return v;
}

function requireNumber(body: Record<string, unknown>, name: string): number {
  const v = body[name];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new InvalidRequest(`Field "${name}" must be a finite number.`);
  }
  return v;
}

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);
const WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
]);

function requireRole(body: Record<string, unknown>): ChatRole {
  const v = body.role;
  if (typeof v !== "string" || !ROLES.has(v)) {
    throw new InvalidRequest('Field "role" must be one of user, assistant, system.');
  }
  return v as ChatRole;
}

function optionalWorkflowStatus(
  body: Record<string, unknown>,
): WorkflowStatus | undefined {
  const v = body.workflowStatus;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !WORKFLOW_STATUSES.has(v)) {
    throw new InvalidRequest('Field "workflowStatus" is not a recognized value.');
  }
  return v as WorkflowStatus;
}

function requireQuery(ctx: RouteContext, name: string): string {
  const v = ctx.url.searchParams.get(name);
  if (v === null || v.length === 0) throw new InvalidRequest(`Query "${name}" is required.`);
  return v;
}

// ──────────────────────────────────────────────────────────────────────────
// Response projections
// ──────────────────────────────────────────────────────────────────────────

interface ProjectWithAvailability {
  readonly path: string;
  readonly name: string;
  readonly favorite: boolean;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
  readonly available: boolean;
}

function projectWithAvailability(p: Project): ProjectWithAvailability {
  return { ...p, available: isProjectAvailable(p) };
}

// ──────────────────────────────────────────────────────────────────────────
// Route 13 — GET /api/projects
// ──────────────────────────────────────────────────────────────────────────

export function handleListProjects(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const projects = deps.store.listProjects().map(projectWithAvailability);
  return { status: 200, body: { projects } };
}

// ──────────────────────────────────────────────────────────────────────────
// Route 14 — POST /api/projects
// ──────────────────────────────────────────────────────────────────────────

export async function handleCreateProject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const path = requireString(body, "path");
    const name = optionalString(body, "name");
    const project = deps.store.createProject(path, name);
    return { status: 201, body: { project: projectWithAvailability(project) } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 15 — PATCH /api/projects?path=...
// ──────────────────────────────────────────────────────────────────────────

function buildProjectPatch(body: Record<string, unknown>): UpdateProjectPatch {
  const name = optionalString(body, "name");
  const favorite = optionalBoolean(body, "favorite");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(favorite !== undefined ? { favorite } : {}),
  };
}

export async function handleUpdateProject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const targetPath = requireQuery(ctx, "path");
    const body = await readJsonObject(ctx.req);
    const patch = buildProjectPatch(body);
    const project = deps.store.updateProject(targetPath, patch);
    return { status: 200, body: { project } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 16 — DELETE /api/projects?path=...
// ──────────────────────────────────────────────────────────────────────────

export function handleDeleteProject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  return runHandlerSync(() => {
    const targetPath = requireQuery(ctx, "path");
    deps.store.deleteProject(targetPath);
    return { status: 204, body: null };
  });
}

function runHandlerSync(worker: () => RouteResult): RouteResult {
  try {
    return worker();
  } catch (error) {
    if (error instanceof InvalidRequest) return badRequest("invalid_request", error.message);
    if (error instanceof UiStoreError) return uiStoreErrorResult(error);
    throw error;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Route 17 — GET /api/chats?projectPath=...
// ──────────────────────────────────────────────────────────────────────────

export function handleListChats(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return runHandlerSync(() => {
    const projectPath = requireQuery(ctx, "projectPath");
    const chats = deps.store.listChats(projectPath);
    return { status: 200, body: { chats } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 18 — POST /api/chats
// ──────────────────────────────────────────────────────────────────────────

export async function handleCreateChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const projectPath = requireString(body, "projectPath");
    const title = requireString(body, "title");
    const selectedModel = requireString(body, "selectedModel");
    const branchLabel = optionalString(body, "branchLabel");
    const chat = deps.store.createChat(
      projectPath,
      title,
      selectedModel,
      branchLabel === undefined ? undefined : { branchLabel },
    );
    return { status: 201, body: { chat } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 19 — PATCH /api/chats?id=...
// ──────────────────────────────────────────────────────────────────────────

function buildChatPatch(body: Record<string, unknown>): UpdateChatPatch {
  const title = optionalString(body, "title");
  const selectedModel = optionalString(body, "selectedModel");
  const branchLabel = optionalString(body, "branchLabel");
  const statusRaw = body.status;
  const patch: UpdateChatPatch = {
    ...(title !== undefined ? { title } : {}),
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(branchLabel !== undefined ? { branchLabel } : {}),
  };
  if (statusRaw === undefined) return patch;
  if (statusRaw !== "open" && statusRaw !== "closed") {
    throw new InvalidRequest('Field "status" must be "open" or "closed".');
  }
  return { ...patch, status: statusRaw };
}

export async function handleUpdateChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const id = requireQuery(ctx, "id");
    const body = await readJsonObject(ctx.req);
    const patch = buildChatPatch(body);
    const chat = deps.store.updateChat(id, patch);
    return { status: 200, body: { chat } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 20 — DELETE /api/chats?id=...
// ──────────────────────────────────────────────────────────────────────────

export function handleDeleteChat(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return runHandlerSync(() => {
    const id = requireQuery(ctx, "id");
    deps.store.deleteChat(id);
    return { status: 204, body: null };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 21 — GET /api/chats/messages?chatId=...
// ──────────────────────────────────────────────────────────────────────────

export function handleListMessages(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return runHandlerSync(() => {
    const chatId = requireQuery(ctx, "chatId");
    const messages = deps.store.listMessages(chatId);
    return { status: 200, body: { messages } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 22 — POST /api/chats/messages
// ──────────────────────────────────────────────────────────────────────────

export async function handleCreateMessage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const chatId = requireString(body, "chatId");
    const role = requireRole(body);
    const content = requireString(body, "content");
    const timestamp = requireNumber(body, "timestamp");
    const message = deps.store.createMessage({
      chatId,
      role,
      content,
      timestamp,
      runId: optionalString(body, "runId"),
      workflowId: optionalString(body, "workflowId"),
      workflowStatus: optionalWorkflowStatus(body),
      shortResult: optionalString(body, "shortResult"),
    });
    return { status: 201, body: { message } };
  });
}

// barrel-level NOT_FOUND helper used by future delete-missing paths
export { notFoundResult };
