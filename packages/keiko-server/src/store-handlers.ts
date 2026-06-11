// ADR-0013 D7 — Route handlers for UI-local store routes. All inputs are validated;
// every error path uses the redacted `{ error: { code, message } }` envelope; SECURITY_HEADERS are
// applied uniformly by the server layer. JSON body reading is bounded by MAX_STORE_BODY_BYTES.

import type { IncomingMessage } from "node:http";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig, currentGroundingLimits } from "./deps.js";
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
import {
  clearGroundedTurnsForConversation,
  clearGroundedTurnsForWorkspace,
} from "./grounded-turn-registry.js";
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
const DEFAULT_CHAT_LIST_LIMIT = 100;
const MAX_CHAT_LIST_LIMIT = 200;
const DEFAULT_MESSAGE_LIST_LIMIT = 200;
const MAX_MESSAGE_LIST_LIMIT = 500;

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

function optionalBoundedQueryInteger(
  ctx: RouteContext,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null || raw.length === 0) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new InvalidRequest(`Query "${name}" must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new InvalidRequest(`Query "${name}" must be between 1 and ${String(max)}.`);
  }
  return value;
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

function putPreferredProjectFirst(
  projects: readonly ProjectWithAvailability[],
  preferredProjectPath: string | undefined,
): readonly ProjectWithAvailability[] {
  if (preferredProjectPath === undefined) return projects;
  const preferred = projects.find((project) => project.path === preferredProjectPath);
  if (preferred === undefined) return projects;
  return [preferred, ...projects.filter((project) => project.path !== preferredProjectPath)];
}

function chatBelongsToProject(deps: UiHandlerDeps, projectPath: string, chatId: string): boolean {
  return deps.store.findChatById(chatId)?.projectPath === projectPath;
}

// Epic #177 audit: the chat PATCH path scanned every project's chat list per request
// (O(projects × chats)). The chat id is unique across projects, so `UiStore.findChatById` is a
// single-row SELECT. Helper preserved so callers stay decoupled from the store interface.
function findChatById(deps: UiHandlerDeps, chatId: string): Chat | undefined {
  return deps.store.findChatById(chatId);
}

function messageBelongsToChat(deps: UiHandlerDeps, chatId: string, messageId: string): boolean {
  return deps.store.findMessageById(messageId)?.chatId === chatId;
}

// ──────────────────────────────────────────────────────────────────────────
// Route 13 — GET /api/projects
// ──────────────────────────────────────────────────────────────────────────

export function handleListProjects(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const projects = putPreferredProjectFirst(
    deps.store.listProjects().map(projectWithAvailability),
    deps.preferredProjectPath,
  );
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
    clearGroundedTurnsForWorkspace(normalizedPath);
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
    const limit = optionalBoundedQueryInteger(
      ctx,
      "limit",
      DEFAULT_CHAT_LIST_LIMIT,
      MAX_CHAT_LIST_LIMIT,
    );
    const chats = deps.store.listChats(projectPath, limit);
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

function scopeRelativePath(realProjectRoot: string, absolutePath: string): string {
  return relative(realProjectRoot, absolutePath).split("\\").join("/");
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
  if (pathIsDenied(scopeRelativePath(realProjectRoot, targetReal))) {
    throw new InvalidRequest("Connected scope is excluded from Keiko's safe read surface.");
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

function resolveRealRoot(
  rootInput: string,
  notAccessibleMessage: string,
): { readonly root: string; readonly realRoot: string } {
  const root = validateProjectPath(rootInput, { mustExist: true });
  try {
    return { root, realRoot: realpathSync(root) };
  } catch {
    throw new InvalidRequest(notAccessibleMessage);
  }
}

// Epic #532 — a connected scope may carry its OWN absolute root pointing anywhere on the machine
// (a folder outside the chat's project, so non-developers can connect any folder). Validate it like
// a project root, then refuse credential/secret locations (deny-list) and credential-shaped path
// metadata so home-directory browsing can never bind a secret folder as a grounded scope.
function validateAccessibleRoot(
  deps: UiHandlerDeps,
  rootInput: string,
  notAccessibleMessage: string,
  deniedMessage: string,
): string {
  const { root, realRoot } = resolveRealRoot(rootInput, notAccessibleMessage);
  if (pathIsDenied(root) || pathIsDenied(realRoot)) {
    throw new InvalidRequest(deniedMessage);
  }
  const redacted = deps.redactor(realRoot);
  if (typeof redacted === "string" && redacted !== realRoot) {
    throw new InvalidRequest("Connected scope root contains credential-shaped metadata.");
  }
  return realRoot;
}

function validateConnectedScopeRoot(deps: UiHandlerDeps, rootInput: string): string {
  return validateAccessibleRoot(
    deps,
    rootInput,
    "Connected scope root is not accessible.",
    "Connected scope root is excluded from Keiko's safe read surface.",
  );
}

function validateFallbackProjectRoot(deps: UiHandlerDeps, projectPath: string): string {
  return validateAccessibleRoot(
    deps,
    projectPath,
    "Selected project is not accessible.",
    "Selected project is excluded from Keiko's safe read surface.",
  );
}

function validateConnectedScopeAccess(
  deps: UiHandlerDeps,
  chat: Chat,
  scope: ChatConnectedScope,
): void {
  const realRoot =
    scope.root !== undefined
      ? validateConnectedScopeRoot(deps, scope.root)
      : validateFallbackProjectRoot(deps, chat.projectPath);
  if (scope.kind === "workspace-root") return;
  for (const entry of scope.relativePaths) {
    validateScopePathAccess(deps, realRoot, scope.kind, entry);
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

// Epic #532 — shape check for the optional connected-scope root. Deep validation (existence,
// deny-list, realpath containment) runs in validateConnectedScopeAccess against the live filesystem.
function validateOptionalScopeRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequest(
      'Field "connectedScope.root" must be a non-empty string when provided.',
    );
  }
  return value.trim();
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

// Shared per-connector shape validator. Used by both the single localKnowledgeScope field and each
// entry of the Epic #189 localKnowledgeScopes list, so the two surfaces never drift.
function parseLocalKnowledgeScopeObject(raw: unknown): ChatLocalKnowledgeScope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
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

function optionalLocalKnowledgeScope(
  body: Record<string, unknown>,
): ChatLocalKnowledgeScope | null | undefined {
  if (!("localKnowledgeScope" in body)) return undefined;
  const raw = body.localKnowledgeScope;
  if (raw === null) return null;
  return parseLocalKnowledgeScopeObject(raw);
}

// Epic #189 — parse the multi-source connector list (capsules/capsule-sets). undefined → absent;
// null → clear all; array → fully validated list bounded by the runtime maxLocalKnowledgeSources
// cap. Each entry runs the same shape validator as the single field. Capsule existence is checked
// in the grounded path, not here (shape-only, like optionalConnectedScopes).
function optionalLocalKnowledgeScopes(
  body: Record<string, unknown>,
  maxSources: number,
): readonly ChatLocalKnowledgeScope[] | null | undefined {
  if (!("localKnowledgeScopes" in body)) return undefined;
  const raw = body.localKnowledgeScopes;
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new InvalidRequest('Field "localKnowledgeScopes" must be an array or null.');
  }
  if (raw.length > maxSources) {
    throw new InvalidRequest(
      `Field "localKnowledgeScopes" must contain at most ${String(maxSources)} sources.`,
    );
  }
  return raw.map((entry) => parseLocalKnowledgeScopeObject(entry));
}

// Issue #184 — three return states: undefined → field absent (leave unchanged); null →
// explicit clear (forward through to the store); ChatConnectedScope → fully validated value.
// All input has crossed the wire and is `unknown` until proven otherwise.
// Shared per-scope shape validator. Used by both the single connectedScope field and each entry
// of the Epic #532 connectedScopes list, so the two surfaces never drift.
function parseConnectedScopeObject(raw: unknown): ChatConnectedScope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidRequest('Field "connectedScope" must be an object or null.');
  }
  const scope = raw as Record<string, unknown>;
  const kind = validateScopeKind(scope.kind);
  const relativePaths = validateScopeRelativePaths(kind, scope.relativePaths);
  const connectedAtMs = validateScopeConnectedAtMs(scope.connectedAtMs);
  const root = validateOptionalScopeRoot(scope.root);
  return { kind, relativePaths, connectedAtMs, ...(root !== undefined ? { root } : {}) };
}

function optionalConnectedScope(
  body: Record<string, unknown>,
): ChatConnectedScope | null | undefined {
  if (!("connectedScope" in body)) return undefined;
  const raw = body.connectedScope;
  if (raw === null) return null;
  return parseConnectedScopeObject(raw);
}

// Epic #532 — parse the multi-source connectedScopes list. undefined → field absent; null →
// clear all; array → fully validated list. Each entry runs the same shape validators (incl. the
// optional root) as the single field; the list is bounded by the runtime maxConnectedSources cap.
// Live-filesystem access (realpath + deny-list + redaction) for each scope runs later in
// handleUpdateChat.
function optionalConnectedScopes(
  body: Record<string, unknown>,
  maxSources: number,
): readonly ChatConnectedScope[] | null | undefined {
  if (!("connectedScopes" in body)) return undefined;
  const raw = body.connectedScopes;
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new InvalidRequest('Field "connectedScopes" must be an array or null.');
  }
  if (raw.length > maxSources) {
    throw new InvalidRequest(
      `Field "connectedScopes" must contain at most ${String(maxSources)} sources.`,
    );
  }
  return raw.map((entry) => parseConnectedScopeObject(entry));
}

// Epic #189/#532 — the four grounding-source patch fields (connected folders + local-knowledge
// connectors, each single + plural). Extracted so buildChatPatch stays under the complexity gate.
// Receives deps so runtime-resolved grounding limits are used for the source-count caps.
function groundingScopePatchFields(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): Partial<UpdateChatPatch> {
  const limits = currentGroundingLimits(deps);
  const connectedScope = optionalConnectedScope(body);
  const connectedScopes = optionalConnectedScopes(body, limits.maxConnectedSources);
  const localKnowledgeScope = optionalLocalKnowledgeScope(body);
  const localKnowledgeScopes = optionalLocalKnowledgeScopes(body, limits.maxLocalKnowledgeSources);
  return {
    ...(connectedScope !== undefined ? { connectedScope } : {}),
    ...(connectedScopes !== undefined ? { connectedScopes } : {}),
    ...(localKnowledgeScope !== undefined ? { localKnowledgeScope } : {}),
    ...(localKnowledgeScopes !== undefined ? { localKnowledgeScopes } : {}),
  };
}

function buildChatPatch(deps: UiHandlerDeps, body: Record<string, unknown>): UpdateChatPatch {
  const title = optionalString(body, "title");
  const selectedModel = optionalChatModelId(deps, body, "selectedModel");
  const branchLabel = optionalString(body, "branchLabel");
  const statusRaw = body.status;
  const patch: UpdateChatPatch = {
    ...(title !== undefined ? { title } : {}),
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(branchLabel !== undefined ? { branchLabel } : {}),
    ...groundingScopePatchFields(body, deps),
  };
  if (statusRaw === undefined) return patch;
  if (statusRaw !== "open" && statusRaw !== "closed") {
    throw new InvalidRequest('Field "status" must be "open" or "closed".');
  }
  return { ...patch, status: statusRaw };
}

// Epic #532 — the connectedScopes list SUPERSEDES the single connectedScope. The effective set of
// sources to access-validate is the list when present (non-null), else the single field. Returns
// an empty list when the patch only clears or omits the binding (no filesystem checks needed).
function scopesRequiringAccessValidation(patch: UpdateChatPatch): readonly ChatConnectedScope[] {
  if (patch.connectedScopes !== undefined) {
    return patch.connectedScopes ?? [];
  }
  if (patch.connectedScope !== undefined && patch.connectedScope !== null) {
    return [patch.connectedScope];
  }
  return [];
}

// Epic #189 — the grounded index is invalidated when ANY grounding source changes: a connected
// folder scope (#532) OR a local-knowledge connector scope. The hybrid path reads both.
function patchTouchesGroundingScope(patch: UpdateChatPatch): boolean {
  return (
    patch.connectedScopes !== undefined ||
    patch.connectedScope !== undefined ||
    patch.localKnowledgeScopes !== undefined ||
    patch.localKnowledgeScope !== undefined
  );
}

export async function handleUpdateChat(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const id = requireQuery(ctx, "id");
    const body = await readJsonObject(ctx.req);
    const patch = buildChatPatch(deps, body);
    const scopesToCheck = scopesRequiringAccessValidation(patch);
    if (scopesToCheck.length > 0) {
      const existing = findChatById(deps, id);
      if (existing === undefined) return notFoundResult("Chat not found.");
      for (const scope of scopesToCheck) {
        validateConnectedScopeAccess(deps, existing, scope);
      }
    }
    const chat = deps.store.updateChat(id, patch);
    if (patchTouchesGroundingScope(patch) || patch.status === "closed") {
      clearGroundedContextIndexesForConversation(id);
      clearGroundedTurnsForConversation(id);
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
    clearGroundedTurnsForConversation(id);
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
    const limit = optionalBoundedQueryInteger(
      ctx,
      "limit",
      DEFAULT_MESSAGE_LIST_LIMIT,
      MAX_MESSAGE_LIST_LIMIT,
    );
    if (!chatBelongsToProject(deps, projectPath, chatId)) {
      return notFoundResult("Chat not found.");
    }
    const messages = deps.store.listMessages(chatId, limit);
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
