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
import {
  isTaskWorkspaceLifecycleState,
  isWorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import type {
  TaskWorkspaceLifecycleState,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, resolveRoot } from "../files.js";
import { TaskWorkspaceError } from "./errors.js";
import { assertSafeFieldValue } from "./field-safety.js";
import type {
  WorkspaceActivateRequest,
  WorkspaceCleanupMode,
  WorkspaceCleanupService,
  WorkspaceHealthService,
  WorkspaceLifecycleActionRequest,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
  WorkspaceProvisionRequest,
  WorkspaceReconciliationService,
  WorkspaceRepairService,
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
type RouteOrLifecycle = RouteResult | WorkspaceLifecycleService;
type RouteOrReconciliation = RouteResult | WorkspaceReconciliationService;
type RouteOrRepair = RouteResult | WorkspaceRepairService;
type RouteOrHealth = RouteResult | WorkspaceHealthService;
type RouteOrCleanup = RouteResult | WorkspaceCleanupService;

function requireService(deps: UiHandlerDeps): RouteOrService {
  return deps.workspaceProvisioning ?? unavailable();
}

function requireLifecycle(deps: UiHandlerDeps): RouteOrLifecycle {
  return deps.workspaceLifecycle ?? unavailable();
}

function requireReconciliation(deps: UiHandlerDeps): RouteOrReconciliation {
  return deps.workspaceReconciliation ?? unavailable();
}

function requireRepair(deps: UiHandlerDeps): RouteOrRepair {
  return deps.workspaceRepair ?? unavailable();
}

function requireHealth(deps: UiHandlerDeps): RouteOrHealth {
  return deps.workspaceHealth ?? unavailable();
}

function requireCleanup(deps: UiHandlerDeps): RouteOrCleanup {
  return deps.workspaceCleanup ?? unavailable();
}

function isRouteResult(
  value:
    | RouteOrService
    | RouteOrLifecycle
    | RouteOrReconciliation
    | RouteOrRepair
    | RouteOrHealth
    | RouteOrCleanup,
): value is RouteResult {
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

// Extract a REQUIRED free-form identity field (requestedBy / taskId): length-bounded AND free of
// control / zero-width / bidirectional-override code points (#449 PR #1587 follow-up). These values
// flow into the advisory lock owner, the active-pointer setBy, and operator-visible evidence, so the
// route boundary rejects rather than strips them (see field-safety.ts). Missing/empty/oversized fields
// keep the existing "missing or invalid field" message; a present-but-unsafe value throws a distinct
// "forbidden characters" reason.
function requireSafeField(value: unknown, field: string): string {
  const bounded = boundedString(value);
  if (bounded === undefined) {
    throw new TaskWorkspaceError("INVALID_REQUEST", `missing or invalid field: ${field}`);
  }
  assertSafeFieldValue(bounded, field);
  return bounded;
}

// As requireSafeField, but for an OPTIONAL field: absent → undefined, present → must be safe.
function optionalSafeField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const bounded = boundedString(value);
  if (bounded === undefined) {
    throw new TaskWorkspaceError("INVALID_REQUEST", `missing or invalid field: ${field}`);
  }
  assertSafeFieldValue(bounded, field);
  return bounded;
}

function mapError(error: unknown): RouteResult | undefined {
  if (error instanceof WorkspaceBodyTooLargeError) {
    return {
      status: 413,
      body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
    };
  }
  if (error instanceof TaskWorkspaceError) {
    const detail =
      error.reasons.length > 0 ? `${error.message}: ${error.reasons.join("; ")}` : error.message;
    // Surface the caller-facing failure class (#449, ADR-0093 D3) alongside the code so a BFF/UI caller
    // can branch on a stable signal (retryable / repairable / blocked / policy-denied / terminal) instead
    // of the raw code list. The base body stays the redacted { error: { code, message } } envelope.
    const base = errorBody(error.code, detail);
    return {
      status: error.status,
      body: { ...base, error: { ...base.error, failureClass: error.failureClass } },
    };
  }
  if (error instanceof FilesError) {
    return { status: error.status, body: errorBody(error.code, error.message) };
  }
  return undefined;
}

// Error responses are redacted with the SAME defense-in-depth scrubbing as success bodies, so a
// future failure detail that ever carries a path/secret-shaped value cannot leak to the browser.
async function runHandler(
  deps: UiHandlerDeps,
  work: () => Promise<RouteResult>,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    const mapped = mapError(error);
    if (mapped === undefined) throw error;
    return { status: mapped.status, body: redacted(deps, mapped.body) };
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
  // The free-form identity fields additionally reject control / zero-width / bidi code points.
  assertSafeFieldValue(taskId, "taskId");
  assertSafeFieldValue(requestedBy, "requestedBy");
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
  return runHandler(deps, async () => {
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
  return runHandler(deps, async () => {
    const workspaceId = ctx.params.workspaceId ?? "";
    const body = await readJsonObject(ctx.req);
    const requestedBy = requireSafeField(body.requestedBy, "requestedBy");
    const expectedLifecycleState = parseExpectedState(body.expectedLifecycleState);
    const request: WorkspaceActivateRequest = {
      workspaceId,
      taskId: optionalSafeField(body.taskId, "taskId") ?? "",
      requestedBy,
      acquireLock: body.acquireLock === true,
      ...(expectedLifecycleState !== undefined ? { expectedLifecycleState } : {}),
    };
    const result = await guard.activate(request);
    return {
      status: 200,
      body: redacted(deps, { instance: result.instance, binding: result.binding }),
    };
  });
}

// ─── #446 active-binding + lifecycle routes ──────────────────────────────────────────────────────
// The shared active-workspace binding the Studio/editor/runtime/Git-Delivery surfaces consume. These
// are registered BEFORE `GET /api/task-workspaces/:workspaceId` so the literal `active` and the
// collection (`?root`) paths win over the `:workspaceId` param route.

function parseLifecycleActionBody(
  workspaceId: string,
  body: Record<string, unknown>,
): WorkspaceLifecycleActionRequest {
  const requestedBy = requireSafeField(body.requestedBy, "requestedBy");
  return { workspaceId, requestedBy };
}

// GET /api/task-workspaces?root=<repoRoot> — list the persisted instances for a repository root.
export async function handleListTaskWorkspaces(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireLifecycle(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const rootInput = ctx.url.searchParams.get("root");
    const resolvedRoot = await resolveRoot(deps.store, rootInput, deps.redactor);
    const instances = guard.list(resolvedRoot.realRoot);
    return { status: 200, body: redacted(deps, { instances }) };
  });
}

// GET /api/task-workspaces/active — the current active binding, or null in unbound mode.
export function handleGetActiveTaskWorkspace(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireLifecycle(deps);
  if (isRouteResult(guard)) return guard;
  return { status: 200, body: redacted(deps, { active: guard.getActive() ?? null }) };
}

// POST /api/task-workspaces/active — atomic switch: activate/resume the target and set it active.
export async function handleSetActiveTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireLifecycle(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const body = await readJsonObject(ctx.req);
    const workspaceId = boundedString(body.workspaceId);
    const requestedBy = boundedString(body.requestedBy);
    if (workspaceId === undefined || requestedBy === undefined) {
      throw new TaskWorkspaceError(
        "INVALID_REQUEST",
        "missing or invalid fields: workspaceId, requestedBy",
      );
    }
    // requestedBy is persisted as the active-pointer setBy — reject control/zero-width/bidi chars.
    assertSafeFieldValue(requestedBy, "requestedBy");
    const result = await guard.setActive({
      workspaceId,
      requestedBy,
      acquireLock: body.acquireLock === true,
    });
    return {
      status: 200,
      body: redacted(deps, { instance: result.instance, binding: result.binding }),
    };
  });
}

// DELETE /api/task-workspaces/active — clear the active pointer → unbound mode.
export function handleClearActiveTaskWorkspace(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const guard = requireLifecycle(deps);
  if (isRouteResult(guard)) return guard;
  guard.clearActive();
  return { status: 200, body: redacted(deps, { active: null }) };
}

type LifecycleAction = (
  request: WorkspaceLifecycleActionRequest,
) => Promise<{ readonly instance: unknown; readonly binding: unknown }>;

async function runLifecycleAction(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  pick: (lifecycle: WorkspaceLifecycleService) => LifecycleAction,
): Promise<RouteResult> {
  const guard = requireLifecycle(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const workspaceId = ctx.params.workspaceId ?? "";
    const body = await readJsonObject(ctx.req);
    const request = parseLifecycleActionBody(workspaceId, body);
    const result = await pick(guard)(request);
    return {
      status: 200,
      body: redacted(deps, { instance: result.instance, binding: result.binding }),
    };
  });
}

// POST /api/task-workspaces/:workspaceId/pause — active → paused (clears the pointer if it was active).
export function handlePauseTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runLifecycleAction(ctx, deps, (lifecycle) => lifecycle.pause);
}

// POST /api/task-workspaces/:workspaceId/resume — paused → active (sets the pointer).
export function handleResumeTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runLifecycleAction(ctx, deps, (lifecycle) => lifecycle.resume);
}

// POST /api/task-workspaces/:workspaceId/handoff — active|paused → handoff-ready (requires clean worktree).
export function handleHandoffTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runLifecycleAction(ctx, deps, (lifecycle) => lifecycle.prepareHandoff);
}

// ─── #447 reconciliation + repair routes ───────────────────────────────────────────────────────
// A `root` of undefined reconciles/reports across ALL repositories; a provided root scopes to one
// repository (resolved + realpath'd through the same containment as the other routes).

async function resolveOptionalRoot(
  deps: UiHandlerDeps,
  rootInput: string | null | undefined,
): Promise<string | undefined> {
  if (rootInput === null || rootInput === undefined || rootInput.length === 0) return undefined;
  const resolved = await resolveRoot(deps.store, rootInput, deps.redactor);
  return resolved.realRoot;
}

// GET /api/task-workspaces/reconciliation[?root=<repoRoot>] — read-only reconciliation report derived
// from the persisted (content-free) instance fields, no filesystem/git IO.
export async function handleGetTaskWorkspaceReconciliation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireReconciliation(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const root = await resolveOptionalRoot(deps, ctx.url.searchParams.get("root"));
    const report = guard.report(root);
    return { status: 200, body: redacted(deps, { report }) };
  });
}

// POST /api/task-workspaces/reconciliation — run a live reconciliation pass (verifies disk + git,
// persists the classification) and return the fresh report. CSRF is enforced for this POST.
export async function handleReconcileTaskWorkspaces(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireReconciliation(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const body = await readJsonObject(ctx.req);
    const root = await resolveOptionalRoot(deps, optionalSafeField(body.root, "root"));
    const report = await guard.reconcile(root);
    return { status: 200, body: redacted(deps, { report }) };
  });
}

function parseRepairStrategy(value: unknown): WorkspaceRecoveryStrategy {
  if (!isWorkspaceRecoveryStrategy(value)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "missing or invalid field: strategy");
  }
  return value;
}

// POST /api/task-workspaces/:workspaceId/repair — controlled, operator-approval-gated repair.
export async function handleRepairTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRepair(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const workspaceId = ctx.params.workspaceId ?? "";
    const body = await readJsonObject(ctx.req);
    const requestedBy = requireSafeField(body.requestedBy, "requestedBy");
    const result = await guard.repair({
      workspaceId,
      requestedBy,
      strategy: parseRepairStrategy(body.strategy),
      operatorApproved: body.operatorApproved === true,
    });
    return {
      status: 200,
      body: redacted(deps, {
        instance: result.instance,
        binding: result.binding,
        strategy: result.strategy,
        applied: result.applied,
        outcome: result.outcome,
        status: result.status,
        driftMarkers: result.driftMarkers,
        operatorActionRequired: result.operatorActionRequired,
      }),
    };
  });
}

// ─── #448 health + governed cleanup routes ──────────────────────────────────────────────────────
// The literal `health` and `cleanup/orphans` paths are registered BEFORE `:workspaceId` so they win by
// literal-segment specificity. A `root` of undefined scopes health/orphan-cleanup across ALL managed
// repositories; a provided root scopes to one (resolved + realpath'd through the same containment).

// GET /api/task-workspaces/health[?root=<repoRoot>] — content-free operational health + drift + orphan
// report (read-only; live filesystem + git probing, no persistence).
export async function handleGetTaskWorkspaceHealth(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireHealth(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const root = await resolveOptionalRoot(deps, ctx.url.searchParams.get("root"));
    const report = await guard.report(root);
    return { status: 200, body: redacted(deps, { report }) };
  });
}

function parseCleanupMode(value: unknown): WorkspaceCleanupMode {
  if (value === "request" || value === "complete") return value;
  throw new TaskWorkspaceError(
    "INVALID_REQUEST",
    "missing or invalid field: mode (expected 'request' or 'complete')",
  );
}

// POST /api/task-workspaces/:workspaceId/cleanup — request (settled → cleanup-pending) or complete
// (governed, live-verified physical removal). Operator-approval gated; CSRF inherited.
export async function handleCleanupTaskWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireCleanup(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const workspaceId = ctx.params.workspaceId ?? "";
    const body = await readJsonObject(ctx.req);
    const requestedBy = requireSafeField(body.requestedBy, "requestedBy");
    const result = await guard.cleanup({
      workspaceId,
      requestedBy,
      operatorApproved: body.operatorApproved === true,
      mode: parseCleanupMode(body.mode),
    });
    return {
      status: 200,
      body: redacted(deps, {
        outcome: result.outcome,
        workspaceId: result.workspaceId,
        ...(result.instance !== undefined ? { instance: result.instance } : {}),
        ...(result.refusalReason !== undefined ? { refusalReason: result.refusalReason } : {}),
      }),
    };
  });
}

// POST /api/task-workspaces/cleanup/orphans — governed removal of orphaned managed worktrees (on-disk
// directories with no persisted record). Operator-approval gated; CSRF inherited.
export async function handleCleanupOrphanTaskWorkspaces(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireCleanup(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(deps, async () => {
    const body = await readJsonObject(ctx.req);
    const requestedBy = requireSafeField(body.requestedBy, "requestedBy");
    const root = await resolveOptionalRoot(deps, optionalSafeField(body.root, "root"));
    const result = await guard.cleanupOrphans({
      ...(root !== undefined ? { repositoryRoot: root } : {}),
      requestedBy,
      operatorApproved: body.operatorApproved === true,
    });
    return {
      status: 200,
      body: redacted(deps, { removed: result.removed, refused: result.refused }),
    };
  });
}
