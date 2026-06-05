// ADR-0013 D7 — Route handlers for UI-local store routes. All inputs are validated;
// every error path uses the redacted `{ error: { code, message } }` envelope; SECURITY_HEADERS are
// applied uniformly by the server layer. JSON body reading is bounded by MAX_STORE_BODY_BYTES.

import type { IncomingMessage } from "node:http";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig } from "./deps.js";
import { findCapability, findConfiguredCapability } from "@oscharko-dev/keiko-model-gateway";
import {
  UiStoreError,
  assertUiDbOutsideProject,
  isProjectAvailable,
  validateProjectPath,
  type Chat,
  type ChatConnectedScope,
  type ChatLocalKnowledgeScope,
  type ChatRole,
  type NewChatMessage,
  type Project,
  type UpdateChatMessagePatch,
  type UpdateChatPatch,
  type UpdateProjectPatch,
  type WorkflowStatus,
} from "./store/index.js";
import { pathIsDenied } from "./files-deny.js";
import {
  clearGroundedContextIndexesForConversation,
  clearGroundedContextIndexesForWorkspace,
} from "./grounded-context-index.js";
// Issue #184 — workspace-relative path gate. isValidScopePath is the canonical validator from
// @oscharko-dev/keiko-contracts/connected-context (issue #178). Reusing it here keeps the BFF
// boundary aligned with the rest of the connected-repo surface and avoids regex drift.
import {
  SELECTED_SCOPE_KINDS,
  isValidScopePath,
  type SelectedScopeKind,
} from "@oscharko-dev/keiko-contracts/connected-context";

const MAX_STORE_BODY_BYTES = 256_000;
const SELECTED_SCOPE_KIND_SET: ReadonlySet<SelectedScopeKind> = new Set(SELECTED_SCOPE_KINDS);

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

async function runHandler(worker: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
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

function assertChatModelId(deps: UiHandlerDeps, modelId: string): void {
  const config = currentGatewayConfig(deps);
  const capability =
    config === undefined ? findCapability(modelId) : findConfiguredCapability(config, modelId);
  if (capability?.kind !== "chat") {
    throw new InvalidRequest('Field "selectedModel" must be a configured chat model id.');
  }
}

function requireChatModelId(
  deps: UiHandlerDeps,
  body: Record<string, unknown>,
  name: string,
): string {
  const modelId = requireString(body, name);
  assertChatModelId(deps, modelId);
  return modelId;
}

function optionalChatModelId(
  deps: UiHandlerDeps,
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const modelId = optionalString(body, name);
  if (modelId !== undefined) assertChatModelId(deps, modelId);
  return modelId;
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

function requireObject(body: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = body[name];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new InvalidRequest(`Field "${name}" must be a JSON object.`);
  }
  return v as Record<string, unknown>;
}

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);
const WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// Issue #66 — taskType labels non-workflow harness runs (verify, explain-plan) so the chat can
// render a non-ambiguous label. Constrained to a-z/0-9/`-` so the value stays URL-safe and
// matches the BFF descriptor taskType identifiers (verify, explain-plan).
const MAX_TASK_TYPE = 64;
const TASK_TYPE_RE = /^[a-z][a-z0-9-]*$/;

function optionalTaskType(body: Record<string, unknown>): string | undefined {
  const v = body.taskType;
  if (v === undefined) return undefined;
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    v.length > MAX_TASK_TYPE ||
    !TASK_TYPE_RE.test(v)
  ) {
    throw new InvalidRequest('Field "taskType" must match [a-z][a-z0-9-]* (≤ 64 chars).');
  }
  return v;
}

function requireRole(body: Record<string, unknown>): ChatRole {
  const v = body.role;
  if (typeof v !== "string" || !ROLES.has(v)) {
    throw new InvalidRequest('Field "role" must be one of user, assistant, system.');
  }
  return v as ChatRole;
}

function optionalWorkflowStatus(body: Record<string, unknown>): WorkflowStatus | undefined {
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

function chatBelongsToProject(deps: UiHandlerDeps, projectPath: string, chatId: string): boolean {
  return deps.store.listChats(projectPath).some((chat) => chat.id === chatId);
}

function findChatById(deps: UiHandlerDeps, chatId: string): Chat | undefined {
  for (const project of deps.store.listProjects()) {
    const chat = deps.store.listChats(project.path).find((candidate) => candidate.id === chatId);
    if (chat !== undefined) return chat;
  }
  return undefined;
}

function messageBelongsToChat(deps: UiHandlerDeps, chatId: string, messageId: string): boolean {
  return deps.store.listMessages(chatId).some((message) => message.id === messageId);
}

// ──────────────────────────────────────────────────────────────────────────
// Route 13 — GET /api/projects
// ──────────────────────────────────────────────────────────────────────────

export function handleListProjects(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
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
    const normalizedPath = validateProjectPath(path, { mustExist: true });
    assertUiDbOutsideProject(deps.uiDbPath, normalizedPath);
    const project = deps.store.createProject(normalizedPath, name);
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
    return { status: 200, body: { project: projectWithAvailability(project) } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 16 — DELETE /api/projects?path=...
// ──────────────────────────────────────────────────────────────────────────

export function handleDeleteProject(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return runHandlerSync(() => {
    const targetPath = requireQuery(ctx, "path");
    const normalizedPath = validateProjectPath(targetPath, { mustExist: false });
    deps.store.deleteProject(normalizedPath);
    clearGroundedContextIndexesForWorkspace(normalizedPath);
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
    const selectedModel = requireChatModelId(deps, body, "selectedModel");
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

// Issue #184 — bound the number of paths the BFF will accept on one binding. Higher than the
// realistic ad-hoc selection size (Files window selection caps at a handful) but low enough to
// prevent JSON-blob inflation in connected_scope_paths. The store enforces the same cap as a
// defense-in-depth subset of this gate.
const MAX_CONNECTED_SCOPE_PATHS = 50;

function isSelectedScopeKind(value: unknown): value is SelectedScopeKind {
  return typeof value === "string" && SELECTED_SCOPE_KIND_SET.has(value as SelectedScopeKind);
}

function validateScopeKind(value: unknown): SelectedScopeKind {
  if (!isSelectedScopeKind(value)) {
    throw new InvalidRequest('Field "connectedScope.kind" must be a recognized scope kind.');
  }
  return value;
}

function assertScopePathCount(kind: SelectedScopeKind, count: number): void {
  if (kind === "workspace-root") {
    if (count !== 0) {
      throw new InvalidRequest(
        'Field "connectedScope.relativePaths" must be empty for repository scope.',
      );
    }
    return;
  }
  if (kind === "directory") {
    if (count !== 1) {
      throw new InvalidRequest(
        'Field "connectedScope.relativePaths" must contain exactly one folder path.',
      );
    }
    return;
  }
  if (count === 0) {
    throw new InvalidRequest('Field "connectedScope.relativePaths" must not be empty.');
  }
  if (count > MAX_CONNECTED_SCOPE_PATHS) {
    throw new InvalidRequest(
      `Field "connectedScope.relativePaths" must have at most ${String(
        MAX_CONNECTED_SCOPE_PATHS,
      )} entries.`,
    );
  }
}

// Issue #184 — validates the relativePaths sub-array. Pulled out of optionalConnectedScope so
// the outer function's cyclomatic complexity stays within the project's ≤10 bound.
function validateScopeRelativePaths(kind: SelectedScopeKind, paths: unknown): readonly string[] {
  if (!Array.isArray(paths)) {
    throw new InvalidRequest('Field "connectedScope.relativePaths" must be an array.');
  }
  assertScopePathCount(kind, paths.length);
  const validated: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string") {
      throw new InvalidRequest('Field "connectedScope.relativePaths" entries must be strings.');
    }
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      throw new InvalidRequest(
        'Field "connectedScope.relativePaths" entry is not a valid workspace-relative path.',
      );
    }
    validated.push(entry);
  }
  return validated;
}

function isContainedPath(root: string, target: string): boolean {
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const targetCmp = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(rootCmp, targetCmp);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scopeTargetPath(realProjectRoot: string, relativePath: string): string {
  if (relativePath.length === 0) return realProjectRoot;
  return resolve(realProjectRoot, ...relativePath.split("/").filter((part) => part.length > 0));
}

function assertScopePathMetadataSafe(deps: UiHandlerDeps, relativePath: string): void {
  if (pathIsDenied(relativePath)) {
    throw new InvalidRequest("Connected scope is excluded from Keiko's safe read surface.");
  }
  const redacted = deps.redactor(relativePath);
  if (typeof redacted === "string" && redacted !== relativePath) {
    throw new InvalidRequest("Connected scope path contains credential-shaped metadata.");
  }
}

function validateScopePathAccess(
  deps: UiHandlerDeps,
  realProjectRoot: string,
  kind: SelectedScopeKind,
  entry: string,
): void {
  assertScopePathMetadataSafe(deps, entry);
  const candidate = scopeTargetPath(realProjectRoot, entry);
  let targetReal: string;
  try {
    targetReal = realpathSync(candidate);
  } catch {
    throw new InvalidRequest("Connected scope path is not accessible from the selected project.");
  }
  if (!isContainedPath(realProjectRoot, targetReal)) {
    throw new InvalidRequest("Connected scope path must stay inside the selected project.");
  }
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(targetReal);
  } catch {
    throw new InvalidRequest("Connected scope path is not accessible from the selected project.");
  }
  if (kind === "directory" && !info.isDirectory()) {
    throw new InvalidRequest("Connected folder scope must reference a folder.");
  }
  if (!info.isDirectory() && !info.isFile()) {
    throw new InvalidRequest("Connected scope path must reference a file or folder.");
  }
}

function validateConnectedScopeAccess(
  deps: UiHandlerDeps,
  chat: Chat,
  scope: ChatConnectedScope,
): void {
  const projectRoot = validateProjectPath(chat.projectPath, { mustExist: true });
  let realProjectRoot: string;
  try {
    realProjectRoot = realpathSync(projectRoot);
  } catch {
    throw new InvalidRequest("Selected project is not accessible.");
  }
  if (scope.kind === "workspace-root") return;
  for (const entry of scope.relativePaths) {
    validateScopePathAccess(deps, realProjectRoot, scope.kind, entry);
  }
}

function validateScopeConnectedAtMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidRequest(
      'Field "connectedScope.connectedAtMs" must be a finite non-negative integer.',
    );
  }
  return value;
}

function parseCapsuleLocalKnowledgeScope(
  scope: Record<string, unknown>,
  connectedAtMs: number,
): Extract<ChatLocalKnowledgeScope, { readonly kind: "capsule" }> {
  if (typeof scope.capsuleId !== "string" || scope.capsuleId.trim().length === 0) {
    throw new InvalidRequest('Field "localKnowledgeScope.capsuleId" must be a non-empty string.');
  }
  return {
    kind: "capsule",
    capsuleId: scope.capsuleId.trim() as Extract<
      ChatLocalKnowledgeScope,
      { readonly kind: "capsule" }
    >["capsuleId"],
    connectedAtMs,
  };
}

function parseCapsuleSetLocalKnowledgeScope(
  scope: Record<string, unknown>,
  connectedAtMs: number,
): Extract<ChatLocalKnowledgeScope, { readonly kind: "capsule-set" }> {
  if (typeof scope.capsuleSetId !== "string" || scope.capsuleSetId.trim().length === 0) {
    throw new InvalidRequest(
      'Field "localKnowledgeScope.capsuleSetId" must be a non-empty string.',
    );
  }
  return {
    kind: "capsule-set",
    capsuleSetId: scope.capsuleSetId.trim() as Extract<
      ChatLocalKnowledgeScope,
      { readonly kind: "capsule-set" }
    >["capsuleSetId"],
    connectedAtMs,
  };
}

function optionalLocalKnowledgeScope(
  body: Record<string, unknown>,
): ChatLocalKnowledgeScope | null | undefined {
  if (!("localKnowledgeScope" in body)) return undefined;
  const raw = body.localKnowledgeScope;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidRequest('Field "localKnowledgeScope" must be an object or null.');
  }
  const scope = raw as Record<string, unknown>;
  const connectedAtMs = validateScopeConnectedAtMs(scope.connectedAtMs);
  if (scope.kind === "capsule") {
    return parseCapsuleLocalKnowledgeScope(scope, connectedAtMs);
  }
  if (scope.kind === "capsule-set") {
    return parseCapsuleSetLocalKnowledgeScope(scope, connectedAtMs);
  }
  throw new InvalidRequest('Field "localKnowledgeScope.kind" must be "capsule" or "capsule-set".');
}

// Issue #184 — three return states: undefined → field absent (leave unchanged); null →
// explicit clear (forward through to the store); ChatConnectedScope → fully validated value.
// All input has crossed the wire and is `unknown` until proven otherwise.
function optionalConnectedScope(
  body: Record<string, unknown>,
): ChatConnectedScope | null | undefined {
  if (!("connectedScope" in body)) return undefined;
  const raw = body.connectedScope;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidRequest('Field "connectedScope" must be an object or null.');
  }
  const scope = raw as Record<string, unknown>;
  const kind = validateScopeKind(scope.kind);
  const relativePaths = validateScopeRelativePaths(kind, scope.relativePaths);
  const connectedAtMs = validateScopeConnectedAtMs(scope.connectedAtMs);
  return { kind, relativePaths, connectedAtMs };
}

function buildChatPatch(deps: UiHandlerDeps, body: Record<string, unknown>): UpdateChatPatch {
  const title = optionalString(body, "title");
  const selectedModel = optionalChatModelId(deps, body, "selectedModel");
  const branchLabel = optionalString(body, "branchLabel");
  const statusRaw = body.status;
  const connectedScope = optionalConnectedScope(body);
  const localKnowledgeScope = optionalLocalKnowledgeScope(body);
  const patch: UpdateChatPatch = {
    ...(title !== undefined ? { title } : {}),
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(branchLabel !== undefined ? { branchLabel } : {}),
    ...(connectedScope !== undefined ? { connectedScope } : {}),
    ...(localKnowledgeScope !== undefined ? { localKnowledgeScope } : {}),
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
    const patch = buildChatPatch(deps, body);
    if (patch.connectedScope !== undefined && patch.connectedScope !== null) {
      const existing = findChatById(deps, id);
      if (existing === undefined) return notFoundResult("Chat not found.");
      validateConnectedScopeAccess(deps, existing, patch.connectedScope);
    }
    const chat = deps.store.updateChat(id, patch);
    if (patch.connectedScope !== undefined || patch.status === "closed") {
      clearGroundedContextIndexesForConversation(id);
    }
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
    clearGroundedContextIndexesForConversation(id);
    return { status: 204, body: null };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 21 — GET /api/chats/messages?chatId=...
// ──────────────────────────────────────────────────────────────────────────

export function handleListMessages(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return runHandlerSync(() => {
    const chatId = requireQuery(ctx, "chatId");
    const projectPath = requireQuery(ctx, "projectPath");
    if (!chatBelongsToProject(deps, projectPath, chatId)) {
      return notFoundResult("Chat not found.");
    }
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
    const projectPath = requireString(body, "projectPath");
    if (!chatBelongsToProject(deps, projectPath, chatId)) {
      return notFoundResult("Chat not found.");
    }
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
      taskType: optionalTaskType(body),
    });
    return { status: 201, body: { message } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 23 — POST /api/chats/messages/run-summary-pair (issue #66)
// ──────────────────────────────────────────────────────────────────────────

function buildRunSummaryPair(
  body: Record<string, unknown>,
): readonly [NewChatMessage, NewChatMessage] {
  const chatId = requireString(body, "chatId");
  const user = requireObject(body, "user");
  const summary = requireObject(body, "summary");
  const workflowId = optionalString(summary, "workflowId");
  const taskType = optionalTaskType(summary);
  if ((workflowId === undefined) === (taskType === undefined)) {
    throw new InvalidRequest('Run summary requires exactly one of "workflowId" or "taskType".');
  }
  const userMessage: NewChatMessage = {
    chatId,
    role: "user",
    content: requireString(user, "content"),
    timestamp: requireNumber(user, "timestamp"),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
  const summaryMessage: NewChatMessage = {
    chatId,
    role: "system",
    content: requireString(summary, "content"),
    timestamp: requireNumber(summary, "timestamp"),
    runId: requireString(summary, "runId"),
    workflowId,
    workflowStatus: optionalWorkflowStatus(summary),
    shortResult: optionalString(summary, "shortResult"),
    taskType,
  };
  if (summaryMessage.workflowStatus === undefined) {
    throw new InvalidRequest('Field "summary.workflowStatus" is required.');
  }
  return [userMessage, summaryMessage];
}

export async function handleCreateRunSummaryPair(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const chatId = requireString(body, "chatId");
    const projectPath = requireString(body, "projectPath");
    if (!chatBelongsToProject(deps, projectPath, chatId)) {
      return notFoundResult("Chat not found.");
    }
    const messages = deps.store.createMessages(buildRunSummaryPair(body));
    return { status: 201, body: { messages } };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Route 24 — PATCH /api/chats/messages?id=... (issue #66)
// ──────────────────────────────────────────────────────────────────────────

// Builds a typed UpdateChatMessagePatch from the JSON body. At least one updatable field must
// appear; the store layer also fails-closed on this, but throwing here surfaces the friendlier
// INVALID_REQUEST envelope without spending a SQL prepare.
function buildMessagePatch(body: Record<string, unknown>): UpdateChatMessagePatch {
  const workflowStatus = optionalWorkflowStatus(body);
  const shortResult = optionalString(body, "shortResult");
  const taskType = optionalTaskType(body);
  if (workflowStatus === undefined && shortResult === undefined && taskType === undefined) {
    throw new InvalidRequest("PATCH body must include at least one updatable field.");
  }
  return {
    ...(workflowStatus !== undefined ? { workflowStatus } : {}),
    ...(shortResult !== undefined ? { shortResult } : {}),
    ...(taskType !== undefined ? { taskType } : {}),
  };
}

export async function handleUpdateMessage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const id = requireQuery(ctx, "id");
    const chatId = requireQuery(ctx, "chatId");
    const projectPath = requireQuery(ctx, "projectPath");
    if (
      !chatBelongsToProject(deps, projectPath, chatId) ||
      !messageBelongsToChat(deps, chatId, id)
    ) {
      return notFoundResult("Message not found.");
    }
    const body = await readJsonObject(ctx.req);
    const patch = buildMessagePatch(body);
    const message = deps.store.updateMessage(id, patch);
    return { status: 200, body: { message } };
  });
}

// barrel-level NOT_FOUND helper used by future delete-missing paths
export { notFoundResult };
