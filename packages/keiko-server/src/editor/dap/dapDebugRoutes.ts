import { randomBytes } from "node:crypto";

import {
  DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  buildDebugVariableTree,
  buildScopeProjection,
  buildStackPage,
  buildWatchEvaluationResult,
  parseDebugBootstrapRequest,
  parseDebugSessionControlRequest,
  parseDebugSessionStartRequest,
  parseEvaluateWatchRequest,
  parseScopesRequest,
  parseSetBreakpointsRequest,
  parseSetExceptionBreakpointsRequest,
  parseSetVariableRequest,
  parseSetWatchesRequest,
  parseStackTraceRequest,
  parseVariablesRequest,
  type DebugEvent,
  type DebugParseResult,
  type DebugSession,
  type DebugSessionStatus,
  type DebugActivationSummary,
  type DebugVariableInput,
  type EvaluateWatchRequest,
  type ExceptionBreakpointFilter,
  type InstrumentationSnapshot,
  type SetVariableRequest,
  type ScopesRequest,
  type SourceBreakpoint,
  type StackTraceRequest,
  type VariablesRequest,
  type WatchExpression,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../../deps.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../../diagnostics-log.js";
import { DENIED_MESSAGE, pathIsDenied } from "../../files-deny.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../../files.js";
import {
  STREAMING,
  errorBody,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
  type RouteResult,
} from "../../routes.js";
import { SSE_HEADERS, readyMessage, startSseHeartbeat } from "../../sse.js";
import { writeOrDestroy } from "../../sse-write.js";
import {
  breakpointStoreWorkspaceFingerprint,
  createBreakpointStore,
  type BreakpointStore,
  type BreakpointStoreMutationResult,
  type RequestedExceptionBreakpointFilter,
  type RequestedSourceBreakpoint,
  type RequestedWatchExpression,
} from "./breakpointStore.js";
import { createDebugBrowserSessionRegistry } from "./dapBrowserSession.js";
import type {
  DebugBrowserSessionRegistry,
  DebugBrowserAuthorization,
} from "./dapBrowserSession.js";
import type {
  DapEventBridge,
  DebugEventEnvelope,
  DebugEventReplaySnapshot,
} from "./dapEventBridge.js";
import {
  DapProcessManagerError,
  type DapProcessManager,
  type DapSessionConfigurationPort,
} from "./dapProcessManager.js";
import { DapProtocolError } from "./dapProtocolClient.js";
import type { DapProductionService } from "./dapProductionService.js";
import { createDebugReferenceStore } from "./dapReferenceStore.js";
import { inspectDebugWorkspaceIdentity } from "./debugLaunchContext.js";
import type {
  DebugReferenceScope,
  DebugReferenceStore,
  DebugReferenceTarget,
} from "./dapReferenceStore.js";
import {
  DEBUG_IDLE_TIMEOUT_MS,
  DEBUG_WALL_TIMEOUT_MS,
  type DebugSessionProjection,
} from "./debugSessionRegistry.js";

const MAX_DEBUG_BODY_BYTES = DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes;
const CAPSULE_ROOT = "/keiko-execution-root";
const SET_VARIABLE_RESPONSE_KEYS = [
  "value",
  "type",
  "variablesReference",
  "namedVariables",
  "indexedVariables",
  "memoryReference",
  "valueLocationReference",
] as const;
const EVALUATE_RESPONSE_KEYS = [
  "result",
  "type",
  "presentationHint",
  "variablesReference",
  "namedVariables",
  "indexedVariables",
  "memoryReference",
  "valueLocationReference",
] as const;

// Deliberately not exported: files.ts's rename fan-out passes the shape structurally so no
// files.ts -> dapDebugRoutes.ts import edge exists (dapDebugRoutes.ts already imports from
// files.ts), and knip rightly rejects an export nothing names. The exported service interface
// below spells the shape inline for the same reason.
interface RenamedInstrumentationFileId {
  readonly previousFileId: string;
  readonly nextFileId: string;
}

export interface DapDebugRouteService {
  readonly manager: DapProcessManager;
  readonly breakpoints: BreakpointStore;
  readonly browserSessions: DebugBrowserSessionRegistry;
  readonly references: DebugReferenceStore;
  readonly events: DapEventBridge;
  readonly activation: (realRoot: string) => Promise<DebugActivationSummary>;
  // KEIKO-0179 follow-up (Codex P1, twice-raised on PR #3141): the single entry point files.ts's
  // rename route calls to re-key the persisted breakpoint store AND, when a debug session is live,
  // reconcile the adapter's own armed breakpoints -- clearing the old path and arming the new one --
  // through the same reconciliation helpers a normal breakpoint mutation uses. Best-effort: never
  // throws (a failure is a redacted diagnostic, not a rejected promise), so a rename can never fail
  // because reconciliation did.
  readonly renameInstrumentation: (
    realRoot: string,
    renames: readonly { readonly previousFileId: string; readonly nextFileId: string }[],
  ) => Promise<void>;
  readonly diagnosticSink?: ServerDiagnosticSink | undefined;
}

export interface DapDebugRouteServiceOptions {
  readonly production: Pick<DapProductionService, "manager" | "eventBridge">;
  readonly stateDir: string;
  readonly now: () => number;
  readonly activation: (realRoot: string) => Promise<DebugActivationSummary>;
  readonly diagnosticSink?: ServerDiagnosticSink | undefined;
}

export function createDapDebugRouteService(
  options: DapDebugRouteServiceOptions,
): DapDebugRouteService {
  const base = {
    manager: options.production.manager,
    breakpoints: createBreakpointStore({
      stateDir: options.stateDir,
      ...(options.diagnosticSink === undefined ? {} : { diagnosticSink: options.diagnosticSink }),
    }),
    browserSessions: createDebugBrowserSessionRegistry({ now: options.now }),
    references: createDebugReferenceStore(),
    events: options.production.eventBridge,
    activation: options.activation,
    ...(options.diagnosticSink === undefined ? {} : { diagnosticSink: options.diagnosticSink }),
  };
  // Self-referencing: the public method closes over `service` (assigned below) rather than
  // duplicating the object's own fields, so it always dispatches through the exact frozen instance
  // callers observe -- same pattern as any method needing the full service, just built outside the
  // literal because runRenameInstrumentation is itself implemented in terms of the other private
  // reconciliation helpers in this module.
  const service: DapDebugRouteService = Object.freeze({
    ...base,
    renameInstrumentation: (
      realRoot: string,
      renames: readonly RenamedInstrumentationFileId[],
    ): Promise<void> => runRenameInstrumentation(service, realRoot, renames),
  });
  return service;
}

interface DebugWorkspace {
  readonly workspaceId: string;
  readonly realRoot: string;
  readonly partition: string;
}

interface AuthorizedWorkspace extends DebugWorkspace {
  readonly browserSessionBinding: string;
}

interface AuthorizedSession {
  readonly service: DapDebugRouteService;
  readonly projection: DebugSessionProjection;
  readonly scope: DebugReferenceScope;
  readonly workspace: DebugWorkspace;
}

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: RouteResult };
type WorkspaceResolution =
  | { readonly ok: true; readonly workspace: DebugWorkspace }
  | { readonly ok: false; readonly result: RouteResult };
type WorkspaceAuthorization =
  | { readonly ok: true; readonly workspace: AuthorizedWorkspace }
  | { readonly ok: false; readonly result: RouteResult };

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function unavailable(deps: UiHandlerDeps): RouteResult | DapDebugRouteService {
  return (
    deps.dapDebug ?? {
      status: 503,
      body: errorBody("DEBUG_UNAVAILABLE", "The governed debug service is unavailable."),
    }
  );
}

async function parseBody<T>(
  ctx: RouteContext,
  parser: (value: unknown) => DebugParseResult<T>,
): Promise<Parsed<T>> {
  const body = await readJsonObject(ctx.req, MAX_DEBUG_BODY_BYTES);
  if (isRouteResult(body)) return { ok: false, result: body };
  const parsed = parser(body);
  return parsed.ok
    ? parsed
    : {
        ok: false,
        result: { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) },
      };
}

function workspaceNotFound(): RouteResult {
  return { status: 404, body: errorBody("WORKSPACE_NOT_FOUND", "The workspace was not found.") };
}

function deniedPath(): RouteResult {
  return { status: 403, body: errorBody("DENIED", DENIED_MESSAGE) };
}

async function resolveDebugWorkspace(
  workspaceId: string,
  deps: UiHandlerDeps,
): Promise<WorkspaceResolution> {
  const project = deps.store
    .listProjects()
    .find((candidate) => breakpointStoreWorkspaceFingerprint(candidate.path) === workspaceId);
  if (project === undefined) return { ok: false, result: workspaceNotFound() };
  const resolved = await runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, project.path, deps.redactor);
    return { status: 200, body: root };
  });
  if (resolved.status !== 200) return { ok: false, result: resolved };
  const root = resolved.body as { readonly realRoot: string };
  if (breakpointStoreWorkspaceFingerprint(root.realRoot) !== workspaceId) {
    return { ok: false, result: workspaceNotFound() };
  }
  const partition = inspectDebugWorkspaceIdentity(root.realRoot).identityDigest;
  return {
    ok: true,
    workspace: { workspaceId, realRoot: root.realRoot, partition },
  };
}

function deniedAuthorization(_authorization: DebugBrowserAuthorization): RouteResult {
  return {
    status: 403,
    body: errorBody("DEBUG_CAPABILITY_DENIED", "Debug browser authority is invalid or expired."),
  };
}

function deniedActivation(): RouteResult {
  return {
    status: 403,
    body: errorBody("DEBUG_CAPABILITY_DENIED", "Debug activation is unavailable."),
  };
}

// D7 requires that a resolver failure be treated as revocation, not a stale-allow — that security
// decision is intentional and stays in place below. But collapsing every exception from the
// injected activation resolver (deploymentPolicy/provisioning/productSupport) into a bare denial
// leaves an operator unable to tell a genuine bug in that callback apart from a legitimate policy
// denial, since both look identical from the outside. Emit a redacted diagnostic on the resolver's
// failure path so the two remain distinguishable without ever weakening the fail-closed outcome
// (mirrors the ADR-0132 LSP-activation precedent in managedLspControlFactory.ts).
function emitActivationResolverFailure(
  service: DapDebugRouteService,
  realRoot: string,
  operation: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    service.diagnosticSink,
    serverDiagnosticFromError({
      correlationId: breakpointStoreWorkspaceFingerprint(realRoot),
      operation,
      source: "dap.debug-routes.activation-resolver",
      error,
      redact: () => "Debug activation resolver failed.",
    }),
  );
}

async function activeActivationRevision(
  service: DapDebugRouteService,
  realRoot: string,
): Promise<number | undefined> {
  try {
    const activation = await service.activation(realRoot);
    return activation.state === "available" ? activation.revision : undefined;
  } catch (error) {
    emitActivationResolverFailure(service, realRoot, "dap.activation.resolve", error);
    return undefined;
  }
}

function staleActivation(): RouteResult {
  return { status: 409, body: errorBody("STALE_ACTIVATION", "Debug activation has changed.") };
}

async function revalidateSessionActivation(
  service: DapDebugRouteService,
  realRoot: string,
  sessionId: string,
  expectedRevision: number,
): Promise<RouteResult | undefined> {
  let current: DebugActivationSummary | undefined;
  try {
    current = await service.activation(realRoot);
  } catch (error) {
    emitActivationResolverFailure(service, realRoot, "dap.activation.revalidate", error);
    current = undefined;
  }
  if (current?.state === "available" && current.revision === expectedRevision) return undefined;
  await service.manager.revoke(sessionId);
  service.references.clearSession(sessionId);
  return current?.state === "available" ? staleActivation() : deniedActivation();
}

async function authorizeWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  service: DapDebugRouteService,
  workspaceId: string,
): Promise<WorkspaceAuthorization> {
  const resolved = await resolveDebugWorkspace(workspaceId, deps);
  if (!resolved.ok) return resolved;
  const authorization = service.browserSessions.authorize(
    ctx.req.headers.cookie,
    resolved.workspace.partition,
  );
  if (!authorization.ok) return { ok: false, result: deniedAuthorization(authorization) };
  const activeSessionId = service.manager.workspaceSessionId(resolved.workspace.partition);
  const boundSessionId = service.manager.boundSessionId(
    resolved.workspace.partition,
    authorization.browserSessionBinding,
  );
  if (activeSessionId !== undefined && activeSessionId !== boundSessionId) {
    return { ok: false, result: deniedAuthorization(authorization) };
  }
  return {
    ok: true,
    workspace: {
      ...resolved.workspace,
      browserSessionBinding: authorization.browserSessionBinding,
    },
  };
}

function sessionStatus(state: DebugSessionProjection["state"]): DebugSessionStatus {
  if (state === "reserved") return "reserved";
  if (state === "starting") return "starting";
  if (state === "running") return "running";
  if (state === "paused") return "paused";
  if (state === "stopping" || state === "terminationPending") return "stopping";
  if (state === "stopped") return "stopped";
  if (state === "revoked") return "revoked";
  return "failed";
}

function sessionProjection(projection: DebugSessionProjection, workspaceId: string): DebugSession {
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    sessionId: projection.sessionId,
    workspaceId,
    status: sessionStatus(projection.state),
    targetKind: projection.targetKind,
    activationRevision: projection.activationRevision,
    pauseGeneration: projection.pauseGeneration,
    startedAtMs: projection.startedAtMs,
    wallDeadlineMs: projection.startedAtMs + DEBUG_WALL_TIMEOUT_MS,
    inactivityDeadlineMs: projection.lastActivityAtMs + DEBUG_IDLE_TIMEOUT_MS,
    output: {
      acceptedBytes: projection.outputAcceptedBytes,
      truncated: projection.outputTruncatedEvents > 0,
    },
  };
}

function sessionNotFound(): RouteResult {
  return { status: 404, body: errorBody("SESSION_NOT_FOUND", "The debug session was not found.") };
}

function authorizedSession(
  service: DapDebugRouteService,
  sessionId: string,
  binding: NonNullable<ReturnType<DapProcessManager["binding"]>>,
  projection: DebugSessionProjection,
  workspace: DebugWorkspace,
): Parsed<AuthorizedSession> {
  return {
    ok: true,
    value: {
      service,
      projection,
      scope: {
        sessionId,
        workspacePartitionKey: binding.workspacePartitionKey,
        browserSessionBinding: binding.browserSessionBinding,
        pauseGeneration: projection.pauseGeneration,
      },
      workspace,
    },
  };
}

async function authorizeSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  service: DapDebugRouteService,
  sessionId: string,
  pauseGeneration?: number,
): Promise<Parsed<AuthorizedSession>> {
  const binding = service.manager.binding(sessionId);
  const projection = service.manager.health(sessionId);
  if (binding === undefined || projection === undefined)
    return { ok: false, result: sessionNotFound() };
  const resolved = await resolveDebugWorkspace(binding.workspaceId, deps);
  if (!resolved.ok || resolved.workspace.partition !== binding.workspacePartitionKey) {
    return {
      ok: false,
      result: deniedAuthorization({ ok: false, reason: "workspace_mismatch" }),
    };
  }
  const authorization = service.browserSessions.authorize(
    ctx.req.headers.cookie,
    binding.workspacePartitionKey,
  );
  if (!authorization.ok || authorization.browserSessionBinding !== binding.browserSessionBinding) {
    return { ok: false, result: deniedAuthorization(authorization) };
  }
  if (pauseGeneration !== undefined && projection.pauseGeneration !== pauseGeneration) {
    return {
      ok: false,
      result: {
        status: 409,
        body: errorBody("STALE_PAUSE", "The paused debug state has changed."),
      },
    };
  }
  const activation = await revalidateSessionActivation(
    service,
    resolved.workspace.realRoot,
    sessionId,
    projection.activationRevision,
  );
  if (activation !== undefined) return { ok: false, result: activation };
  return authorizedSession(service, sessionId, binding, projection, resolved.workspace);
}

function mintedSessionId(): string {
  return randomBytes(24).toString("base64url");
}

function requestedBreakpoints(
  breakpoints: readonly SourceBreakpoint[],
): readonly RequestedSourceBreakpoint[] {
  return breakpoints.map((breakpoint) => ({
    line: breakpoint.line,
    enabled: breakpoint.enabled,
    ...(breakpoint.column === undefined ? {} : { column: breakpoint.column }),
    ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
    ...(breakpoint.hitCondition === undefined ? {} : { hitCondition: breakpoint.hitCondition }),
    ...(breakpoint.logMessage === undefined ? {} : { logMessage: breakpoint.logMessage }),
  }));
}

function requestedExceptionFilters(
  filters: readonly ExceptionBreakpointFilter[],
): readonly RequestedExceptionBreakpointFilter[] {
  return filters.map((filter) => ({ ...filter }));
}

function dapBreakpoints(breakpoints: readonly SourceBreakpoint[]): readonly unknown[] {
  return breakpoints
    .filter((breakpoint) => breakpoint.enabled)
    .map((breakpoint) => ({
      line: breakpoint.line,
      ...(breakpoint.column === undefined ? {} : { column: breakpoint.column }),
      ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
      ...(breakpoint.hitCondition === undefined ? {} : { hitCondition: breakpoint.hitCondition }),
      ...(breakpoint.logMessage === undefined ? {} : { logMessage: breakpoint.logMessage }),
    }));
}

async function configureInstrumentation(
  port: DapSessionConfigurationPort,
  initial: InstrumentationSnapshot,
  reconcile: (
    snapshot: InstrumentationSnapshot,
    fileId: string,
    response: unknown,
  ) => InstrumentationSnapshot,
): Promise<InstrumentationSnapshot> {
  let snapshot = initial;
  const fileIds = [...new Set(snapshot.breakpoints.map((breakpoint) => breakpoint.fileId))];
  for (const fileId of fileIds) {
    const breakpoints = snapshot.breakpoints.filter((breakpoint) => breakpoint.fileId === fileId);
    const response = await port.request("setBreakpoints", {
      source: { path: `${CAPSULE_ROOT}/${fileId}` },
      breakpoints: dapBreakpoints(breakpoints),
    });
    snapshot = reconcile(snapshot, fileId, response);
  }
  const enabled = snapshot.exceptionFilters.filter((filter) => filter.enabled);
  const exceptionResponse = await port.request("setExceptionBreakpoints", {
    filters: enabled.map((filter) => filter.filterId),
    filterOptions: enabled
      .filter((filter) => filter.condition !== undefined)
      .map((filter) => ({ filterId: filter.filterId, condition: filter.condition })),
  });
  validateExceptionBreakpointResponse(exceptionResponse);
  return snapshot;
}

interface InstrumentationSnapshotLike {
  readonly breakpoints: readonly SourceBreakpoint[];
  readonly exceptionFilters: readonly ExceptionBreakpointFilter[];
}

async function handleDebugBootstrap(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseDebugBootstrapRequest);
  if (!parsed.ok) return parsed.result;
  const resolved = await resolveDebugWorkspace(parsed.value.workspaceId, deps);
  if (!resolved.ok) return resolved.result;
  const activationRevision = await activeActivationRevision(service, resolved.workspace.realRoot);
  if (activationRevision === undefined) {
    return deniedActivation();
  }
  const issued = service.browserSessions.ensure(
    resolved.workspace.partition,
    ctx.req.headers.cookie,
  );
  if (!issued.ok) {
    return {
      status: 429,
      body: errorBody("BROWSER_SESSION_LIMIT", "Debug session capacity is full."),
    };
  }
  return {
    status: 200,
    ...(issued.setCookies.length === 0 ? {} : { headers: { "Set-Cookie": issued.setCookies } }),
    body: {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      workspaceId: resolved.workspace.workspaceId,
      activationRevision,
    },
  };
}

function sessionConfiguration(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
): (port: DapSessionConfigurationPort) => Promise<void> {
  return async (port): Promise<void> => {
    // Re-read the breakpoint snapshot fresh on EVERY invocation -- including a dapProcessManager
    // internal launch retry, which reuses this same closure verbatim -- instead of closing over a
    // snapshot captured once per HTTP request. A stale snapshot makes a concurrent breakpoint edit
    // fail identically on every retry attempt and burns the 2-attempt restart-throttle budget on a
    // race, not a real adapter failure (KEIKO-0097).
    const fresh = service.breakpoints.snapshot(workspace.realRoot);
    if (!fresh.ok) throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
    await configureInstrumentation(port, fresh.snapshot, (current, fileId, response) => {
      const reconciled = service.breakpoints.setBreakpointVerifications(
        workspace.realRoot,
        current.revision,
        current.etag,
        fileId,
        verificationUpdates(fileId, current, response),
      );
      // Non-retriable: a second reconciliation conflict on a freshly re-read snapshot is a real
      // race, not stale input -- tear down instead of recursing on unchanged state.
      if (!reconciled.ok) throw new DapProcessManagerError("INVALID_CAPSULE_PLAN");
      return reconciled.snapshot;
    });
  };
}

export async function handleStartDebugSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseDebugSessionStartRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  if (request.target.kind === "file" && pathIsDenied(request.target.fileId)) return deniedPath();
  const authorized = await authorizeWorkspace(ctx, deps, service, request.workspaceId);
  if (!authorized.ok) return authorized.result;
  const activationRevision = await activeActivationRevision(service, authorized.workspace.realRoot);
  if (activationRevision === undefined) {
    return deniedActivation();
  }
  if (request.activationRevision !== activationRevision) {
    return { status: 409, body: errorBody("STALE_ACTIVATION", "Debug activation has changed.") };
  }
  const snapshot = service.breakpoints.snapshot(authorized.workspace.realRoot);
  if (!snapshot.ok) {
    return { status: 503, body: errorBody("STATE_UNAVAILABLE", "Debug state is unavailable.") };
  }
  const sessionId = mintedSessionId();
  await service.manager.start({
    identity: {
      sessionId,
      workspaceId: authorized.workspace.workspaceId,
      workspacePartitionKey: authorized.workspace.partition,
      browserSessionBinding: authorized.workspace.browserSessionBinding,
      targetKind: request.target.kind,
      activationRevision: request.activationRevision,
      network: "none",
      filesystem: "executionRoot",
    },
    adapterRuntime: "node",
    adapterProviderId: "node",
    planCandidate: request.target,
    configure: sessionConfiguration(service, authorized.workspace),
  });
  const projection = service.manager.health(sessionId);
  if (projection === undefined) throw new Error("DEBUG_SESSION_PROJECTION_UNAVAILABLE");
  return { status: 201, body: sessionProjection(projection, authorized.workspace.workspaceId) };
}

async function handleGetDebugSession(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const authorized = await authorizeSession(ctx, deps, service, ctx.params.sessionId ?? "");
  if (!authorized.ok) return authorized.result;
  return {
    status: 200,
    body: sessionProjection(authorized.value.projection, authorized.value.workspace.workspaceId),
  };
}

async function handleDeleteDebugSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const sessionId = ctx.params.sessionId ?? "";
  const authorized = await authorizeSession(ctx, deps, service, sessionId);
  if (!authorized.ok) return authorized.result;
  await service.manager.stop(sessionId);
  service.references.clearSession(sessionId);
  return { status: 200, body: { sessionId, status: "stopped" } };
}

function expectedEtag(ctx: RouteContext): string {
  const value: unknown = ctx.req.headers["if-match"];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function mutationStatus(result: BreakpointStoreMutationResult): number {
  if (result.ok) return 200;
  if (result.reason === "conflict") return 409;
  if (result.reason === "cap_exceeded") return 422;
  if (result.reason === "state_unavailable") return 503;
  return 400;
}

function mutationResponse(result: BreakpointStoreMutationResult): RouteResult {
  return {
    status: mutationStatus(result),
    body: instrumentationMutationProjection(result),
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

interface InstrumentationProjectionCounts {
  readonly breakpointRetainedCount: number;
  readonly breakpointOmittedCount: number;
  readonly exceptionFilterRetainedCount: number;
  readonly exceptionFilterOmittedCount: number;
  readonly watchRetainedCount: number;
  readonly watchOmittedCount: number;
  readonly truncated: boolean;
}

type InstrumentationProjection = Omit<
  InstrumentationSnapshot,
  "breakpoints" | "exceptionFilters" | "watches"
> &
  InstrumentationProjectionCounts & {
    readonly breakpoints: readonly SourceBreakpoint[];
    readonly exceptionFilters: readonly ExceptionBreakpointFilter[];
    readonly watches: InstrumentationSnapshot["watches"];
  };

function instrumentationProjection(
  snapshot: InstrumentationSnapshot,
  wrap: (projection: InstrumentationProjection) => unknown = (projection) => projection,
): InstrumentationProjection {
  const breakpoints = [...snapshot.breakpoints];
  const exceptionFilters = [...snapshot.exceptionFilters];
  const watches = [...snapshot.watches];
  const projection = (): InstrumentationProjection => ({
    ...snapshot,
    breakpoints,
    exceptionFilters,
    watches,
    breakpointRetainedCount: breakpoints.length,
    breakpointOmittedCount: snapshot.breakpoints.length - breakpoints.length,
    exceptionFilterRetainedCount: exceptionFilters.length,
    exceptionFilterOmittedCount: snapshot.exceptionFilters.length - exceptionFilters.length,
    watchRetainedCount: watches.length,
    watchOmittedCount: snapshot.watches.length - watches.length,
    truncated:
      breakpoints.length < snapshot.breakpoints.length ||
      exceptionFilters.length < snapshot.exceptionFilters.length ||
      watches.length < snapshot.watches.length,
  });
  let current = projection();
  while (jsonBytes(wrap(current)) > MAX_DEBUG_BODY_BYTES) {
    if (watches.length > 0) watches.pop();
    else if (exceptionFilters.length > 0) exceptionFilters.pop();
    else if (breakpoints.length > 0) breakpoints.pop();
    else throw new Error("DEBUG_HTTP_PROJECTION_OVERFLOW");
    current = projection();
  }
  return current;
}

function mutationEnvelope(
  result: BreakpointStoreMutationResult,
  snapshot: InstrumentationProjection,
): unknown {
  return { ...result, snapshot };
}

function instrumentationMutationProjection(result: BreakpointStoreMutationResult): unknown {
  const projected = instrumentationProjection(result.snapshot, (snapshot) =>
    mutationEnvelope(result, snapshot),
  );
  return mutationEnvelope(result, projected);
}

function persistedButNotArmed(result: BreakpointStoreMutationResult): RouteResult {
  return {
    status: 202,
    body: {
      result: instrumentationMutationProjection(result),
      activation: { state: "persisted", armed: false },
    },
  };
}

function instrumentationChangeEvent(
  workspaceId: string,
  result: Extract<BreakpointStoreMutationResult, { readonly ok: true }>,
): DebugEvent {
  return {
    kind: "breakpoints-changed",
    workspaceId,
    revision: result.snapshot.revision,
    breakpointCount: result.snapshot.breakpoints.length,
    verifiedCount: result.snapshot.breakpoints.filter(
      (breakpoint) => breakpoint.verification === "verified",
    ).length,
  };
}

function publishInstrumentationChange(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  result: Extract<BreakpointStoreMutationResult, { readonly ok: true }>,
): RouteResult | undefined {
  const published = service.events.publish(
    {
      workspacePartitionKey: workspace.partition,
      browserSessionBinding: workspace.browserSessionBinding,
    },
    instrumentationChangeEvent(workspace.workspaceId, result),
  );
  return published ? undefined : eventUnavailableResponse(result.snapshot);
}

function eventUnavailableResponse(snapshot: InstrumentationSnapshot): RouteResult {
  const envelope = (projection: InstrumentationProjection): unknown => ({
    ...errorBody("EVENT_UNAVAILABLE", "Debug state changed but event delivery failed."),
    snapshot: projection,
  });
  const projection = instrumentationProjection(snapshot, envelope);
  return { status: 503, body: envelope(projection) };
}

type ActiveBreakpointUpdate =
  | { readonly kind: "inactive" }
  | { readonly kind: "response"; readonly response: unknown }
  | { readonly kind: "unavailable" };

function expectedAdapterAvailabilityError(error: unknown): boolean {
  if (error instanceof DapProcessManagerError) return true;
  if (!(error instanceof DapProtocolError)) return false;
  return (
    error.code === "ADAPTER_REJECTED" ||
    error.code === "REQUEST_TIMEOUT" ||
    error.code === "REQUEST_CANCELLED" ||
    error.code === "CLIENT_DISPOSED" ||
    error.code === "WRITE_FAILED"
  );
}

async function activeSessionDispatchAllowed(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  sessionId: string,
): Promise<boolean> {
  const projection = service.manager.health(sessionId);
  if (
    projection === undefined ||
    projection.state === "stopped" ||
    projection.state === "revoked" ||
    projection.state === "failed" ||
    projection.state === "terminationPending"
  ) {
    return false;
  }
  const denied = await revalidateSessionActivation(
    service,
    workspace.realRoot,
    sessionId,
    projection.activationRevision,
  );
  return denied === undefined;
}

async function updateActiveBreakpoints(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  fileId: string,
  snapshot: InstrumentationSnapshotLike,
): Promise<ActiveBreakpointUpdate> {
  const sessionId = service.manager.boundSessionId(
    workspace.partition,
    workspace.browserSessionBinding,
  );
  if (sessionId === undefined) return { kind: "inactive" };
  if (!(await activeSessionDispatchAllowed(service, workspace, sessionId))) {
    return { kind: "unavailable" };
  }
  const breakpoints = snapshot.breakpoints.filter((breakpoint) => breakpoint.fileId === fileId);
  try {
    const response = await service.manager.request(
      sessionId,
      "setBreakpoints",
      {
        source: { path: `${CAPSULE_ROOT}/${fileId}` },
        breakpoints: dapBreakpoints(breakpoints),
      },
      "inspection",
    );
    return { kind: "response", response };
  } catch (error: unknown) {
    if (expectedAdapterAvailabilityError(error)) return { kind: "unavailable" };
    throw error;
  }
}

function verificationUpdates(
  fileId: string,
  snapshot: InstrumentationSnapshot,
  response: unknown,
): readonly { readonly id: string; readonly verification: "pending" | "verified" | "rejected" }[] {
  const breakpoints = snapshot.breakpoints.filter((breakpoint) => breakpoint.fileId === fileId);
  const responseBody = adapterShape(response, ["breakpoints"]);
  const adapterBreakpoints = adapterArray(responseBody.breakpoints);
  const enabled = breakpoints.filter((breakpoint) => breakpoint.enabled);
  if (adapterBreakpoints.length !== enabled.length) throw new Error("DAP_RESPONSE_INVALID");
  let responseIndex = 0;
  return breakpoints.map((breakpoint) => {
    if (!breakpoint.enabled) return { id: breakpoint.id, verification: "pending" };
    const adapter = adapterBreakpoint(adapterBreakpoints[responseIndex++]);
    return {
      id: breakpoint.id,
      verification: adapter.verified ? "verified" : "rejected",
    };
  });
}

function adapterBreakpoint(value: unknown): Readonly<Record<string, unknown>> {
  const breakpoint = adapterShape(value, [
    "id",
    "verified",
    "message",
    "source",
    "line",
    "column",
    "endLine",
    "endColumn",
    "instructionReference",
    "offset",
    "reason",
  ]);
  if (typeof breakpoint.verified !== "boolean") throw new Error("DAP_RESPONSE_INVALID");
  return breakpoint;
}

function validateExceptionBreakpointResponse(response: unknown): void {
  const body = adapterShape(response, ["breakpoints"]);
  if (body.breakpoints === undefined) return;
  for (const breakpoint of adapterArray(body.breakpoints)) adapterBreakpoint(breakpoint);
}

type BreakpointActivation = "inactive" | "armed" | "unavailable";

async function reconcileActiveBreakpoints(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  fileId: string,
  result: Extract<BreakpointStoreMutationResult, { readonly ok: true }>,
): Promise<{
  readonly result: BreakpointStoreMutationResult;
  readonly activation: BreakpointActivation;
}> {
  const update = await updateActiveBreakpoints(service, workspace, fileId, result.snapshot);
  if (update.kind !== "response") return { result, activation: update.kind };
  const sessionId = service.manager.boundSessionId(
    workspace.partition,
    workspace.browserSessionBinding,
  );
  if (sessionId === undefined) return { result, activation: "unavailable" };
  const updates = await projectAdapterResponse(service, sessionId, () =>
    verificationUpdates(fileId, result.snapshot, update.response),
  );
  return {
    result: service.breakpoints.setBreakpointVerifications(
      workspace.realRoot,
      result.snapshot.revision,
      result.snapshot.etag,
      fileId,
      updates,
    ),
    activation: "armed",
  };
}

function liveDebugWorkspace(
  service: DapDebugRouteService,
  realRoot: string,
  partition: string,
): AuthorizedWorkspace | undefined {
  const sessionId = service.manager.workspaceSessionId(partition);
  if (sessionId === undefined) return undefined;
  const binding = service.manager.binding(sessionId);
  if (binding === undefined) return undefined;
  return {
    workspaceId: binding.workspaceId,
    realRoot,
    partition,
    browserSessionBinding: binding.browserSessionBinding,
  };
}

interface RenamedBreakpointRecords {
  readonly applied: readonly RenamedInstrumentationFileId[];
  readonly latest: Extract<BreakpointStoreMutationResult, { readonly ok: true }> | undefined;
  readonly rejectedCount: number;
}

function renameBreakpointRecords(
  service: DapDebugRouteService,
  realRoot: string,
  renames: readonly RenamedInstrumentationFileId[],
): RenamedBreakpointRecords {
  const applied: RenamedInstrumentationFileId[] = [];
  let latest: Extract<BreakpointStoreMutationResult, { readonly ok: true }> | undefined;
  let rejectedCount = 0;
  for (const pair of renames) {
    const renamed = service.breakpoints.renameFile(realRoot, pair.previousFileId, pair.nextFileId);
    if (renamed.ok) {
      latest = renamed;
      applied.push(pair);
    } else {
      rejectedCount += 1;
    }
  }
  return { applied, latest, rejectedCount };
}

// A rename is a server-observed filesystem event, not a client-authored setBreakpoints edit, so
// there is no fresh client breakpoint list to send for the old path -- the post-rename snapshot
// already carries zero breakpoints under previousFileId, so reusing updateActiveBreakpoints as-is
// dispatches that same setBreakpoints shape with an empty list, clearing whatever the adapter had
// armed there. reconcileActiveBreakpoints is reused verbatim for the new path so its
// adapter-reported verification lands in the store exactly like any other breakpoint mutation.
//
// KEIKO-0179 review round 8 (Codex P2, PR #3141): the old-path clear's outcome used to be discarded
// outright, so an adapter timeout/reject there was invisible -- the new path still got armed and the
// change still published as a clean success, leaving the adapter possibly armed at both the old and
// the new path with nothing to diagnose it. The outcome is now inspected: a non-"response" result is
// reported through its own diagnostic tag (distinct from the outer best-effort catch below) before
// falling through to arm the new path regardless. That fallthrough is deliberate, not merely
// tolerated -- the rename already happened on disk, so a stale old-path arm cannot rebind to real
// code, while stopping here would strand the new path unarmed too, which is strictly worse than a
// degraded-but-diagnosed old-path clear.
async function reconcileRenamedPair(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  pair: RenamedInstrumentationFileId,
  latest: Extract<BreakpointStoreMutationResult, { readonly ok: true }>,
): Promise<Extract<BreakpointStoreMutationResult, { readonly ok: true }>> {
  const oldPathClear = await updateActiveBreakpoints(
    service,
    workspace,
    pair.previousFileId,
    latest.snapshot,
  );
  if (oldPathClear.kind !== "response") {
    emitRenameOldPathClearDegraded(service, workspace.realRoot);
  }
  const reconciled = await reconcileActiveBreakpoints(service, workspace, pair.nextFileId, latest);
  return reconciled.result.ok ? reconciled.result : latest;
}

function emitRenameInstrumentationFailure(
  service: DapDebugRouteService,
  realRoot: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    service.diagnosticSink,
    serverDiagnosticFromError({
      correlationId: breakpointStoreWorkspaceFingerprint(realRoot),
      operation: "dap.debug-routes.rename-instrumentation",
      source: "dap.debug-routes.rename-instrumentation",
      error,
      redact: () => "Debug adapter re-arm after a rename failed.",
    }),
  );
}

// Codex review round 5 on PR #3141: a renameFile rejection (per-file cap at the destination, store
// unavailable, invalid id) previously vanished — the pair was skipped with no diagnostic, and when
// EVERY pair rejected the whole migration returned silently, contradicting this module's stated
// best-effort-with-diagnostics contract. Counts only, never file ids: diagnostics stay body-free.
function emitRenameReKeyRejected(
  service: DapDebugRouteService,
  realRoot: string,
  rejectedCount: number,
  totalCount: number,
): void {
  emitServerDiagnostic(
    service.diagnosticSink,
    serverDiagnosticFromError({
      correlationId: breakpointStoreWorkspaceFingerprint(realRoot),
      operation: "dap.debug-routes.rename-instrumentation.re-key-rejected",
      source: "dap.debug-routes.rename-instrumentation",
      error: new Error("RENAME_RE_KEY_REJECTED"),
      redact: () =>
        `Breakpoint re-key after a rename was rejected for ${String(rejectedCount)} of ` +
        `${String(totalCount)} affected file id(s); their breakpoints remain under the old path.`,
    }),
  );
}

function emitRenameOldPathClearDegraded(service: DapDebugRouteService, realRoot: string): void {
  emitServerDiagnostic(
    service.diagnosticSink,
    serverDiagnosticFromError({
      correlationId: breakpointStoreWorkspaceFingerprint(realRoot),
      operation: "dap.debug-routes.rename-instrumentation.old-path-clear-degraded",
      source: "dap.debug-routes.rename-instrumentation",
      error: new Error("RENAME_OLD_PATH_CLEAR_DEGRADED"),
      redact: () =>
        "Debug adapter did not confirm the renamed file's old path was cleared; the new path was armed regardless.",
    }),
  );
}

async function reconcileRenamedInstrumentation(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  applied: readonly RenamedInstrumentationFileId[],
  initial: Extract<BreakpointStoreMutationResult, { readonly ok: true }>,
): Promise<void> {
  let latest = initial;
  for (const pair of applied) {
    latest = await reconcileRenamedPair(service, workspace, pair, latest);
  }
  publishInstrumentationChange(service, workspace, latest);
}

// KEIKO-0179 review round 8 (Codex P2, PR #3141): EditorDebugSessionHost opens the browser's SSE
// debug-event stream and bootstraps instrumentation before any debuggee launches, so a rename can
// land while that stream is already subscribed on this workspace's partition yet
// service.manager.workspaceSessionId(partition) still returns undefined -- liveDebugWorkspace
// returns undefined in exactly that window, and the panel would otherwise never learn the rename
// happened until its next bootstrap re-read or a conflict-triggered refresh. DapEventBridge's channel
// key ({workspacePartitionKey, browserSessionBinding}, dapEventBridge.ts channelKey()) is populated
// at stream-open (handleDebugEvents -> service.events.subscribe) independent of any
// DapProcessManager session, so channelsForPartition reads that existing subscription registry to
// find every stream already listening on this partition and publishes to each directly. There is no
// adapter to reconcile here -- no session means nothing is armed anywhere -- only the panel(s) to
// notify.
function publishSessionlessRenameInstrumentation(
  service: DapDebugRouteService,
  realRoot: string,
  partition: string,
  latest: Extract<BreakpointStoreMutationResult, { readonly ok: true }>,
): void {
  const channels = service.events.channelsForPartition(partition);
  if (channels.length === 0) return;
  const workspaceId = breakpointStoreWorkspaceFingerprint(realRoot);
  const event = instrumentationChangeEvent(workspaceId, latest);
  for (const channel of channels) {
    if (!service.events.publish(channel, event)) {
      emitRenameInstrumentationFailure(service, realRoot, new Error("EVENT_UNAVAILABLE"));
    }
  }
}

// KEIKO-0179 follow-up (Codex P1, twice-raised on PR #3141): a rename during an active debug
// session must re-arm the live adapter at the new path and clear it at the old one, not merely
// re-key the persisted store and tell the browser panel something changed. This is the owning-layer
// implementation behind DapDebugRouteService.renameInstrumentation -- files.ts's rename route calls
// the public method, never these helpers directly. Best-effort throughout: the filesystem rename
// already succeeded, so a store or adapter failure here is reported as a redacted diagnostic, never
// allowed to surface as a failed rename.
async function runRenameInstrumentation(
  service: DapDebugRouteService,
  realRoot: string,
  renames: readonly RenamedInstrumentationFileId[],
): Promise<void> {
  const { applied, latest, rejectedCount } = renameBreakpointRecords(service, realRoot, renames);
  // Rejections are reported even when nothing else proceeds: an all-rejected migration must leave a
  // diagnostic behind, not return as if there had been nothing to migrate.
  if (rejectedCount > 0) emitRenameReKeyRejected(service, realRoot, rejectedCount, renames.length);
  if (latest === undefined) return;
  // inspectDebugWorkspaceIdentity stays inside the guard: it can throw if the root becomes unreadable
  // between the store re-key and this lookup, and the method's contract is that it never rejects — a
  // failure here must degrade to a diagnostic, not a failed rename.
  try {
    const partition = inspectDebugWorkspaceIdentity(realRoot).identityDigest;
    const workspace = liveDebugWorkspace(service, realRoot, partition);
    if (workspace === undefined) {
      publishSessionlessRenameInstrumentation(service, realRoot, partition, latest);
      return;
    }
    // Codex P2 (real, PR #3141): reconciliation (adapter re-arm + verification) is nested in its own
    // try so a throw there -- a malformed adapter response or any other unexpected error -- cannot
    // strand the browser on the pre-rename snapshot. The store already committed the migrated `latest`
    // above; on a reconciliation failure this still publishes it (unverified) so the panel picks up
    // the new fileIds/revision instead of nothing. The success path is untouched: on a clean run,
    // reconcileRenamedInstrumentation publishes the verification-updated snapshot itself and this
    // fallback is never reached, so there is no double publish.
    try {
      await reconcileRenamedInstrumentation(service, workspace, applied, latest);
    } catch (error) {
      emitRenameInstrumentationFailure(service, realRoot, error);
      publishInstrumentationChange(service, workspace, latest);
    }
  } catch (error) {
    emitRenameInstrumentationFailure(service, realRoot, error);
  }
}

async function updateActiveExceptionBreakpoints(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  snapshot: InstrumentationSnapshotLike,
): Promise<"inactive" | "armed" | "unavailable"> {
  const sessionId = service.manager.boundSessionId(
    workspace.partition,
    workspace.browserSessionBinding,
  );
  if (sessionId === undefined) return "inactive";
  if (!(await activeSessionDispatchAllowed(service, workspace, sessionId))) return "unavailable";
  const enabled = snapshot.exceptionFilters.filter((filter) => filter.enabled);
  try {
    const response = await service.manager.request(
      sessionId,
      "setExceptionBreakpoints",
      {
        filters: enabled.map((filter) => filter.filterId),
        filterOptions: enabled
          .filter((filter) => filter.condition !== undefined)
          .map((filter) => ({ filterId: filter.filterId, condition: filter.condition })),
      },
      "inspection",
    );
    await projectAdapterResponse(service, sessionId, () => {
      validateExceptionBreakpointResponse(response);
    });
    return "armed";
  } catch (error: unknown) {
    if (expectedAdapterAvailabilityError(error)) return "unavailable";
    throw error;
  }
}

async function handleGetDebugInstrumentation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const workspaceId = ctx.url.searchParams.get("workspaceId") ?? "";
  const authorized = await authorizeWorkspace(ctx, deps, service, workspaceId);
  if (!authorized.ok) return authorized.result;
  const snapshot = service.breakpoints.snapshot(authorized.workspace.realRoot);
  return snapshot.ok
    ? { status: 200, body: instrumentationProjection(snapshot.snapshot) }
    : { status: 503, body: errorBody("STATE_UNAVAILABLE", "Debug state is unavailable.") };
}

export async function handleSetDebugBreakpoints(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseSetBreakpointsRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  if (pathIsDenied(request.fileId)) return deniedPath();
  const authorized = await authorizeWorkspace(ctx, deps, service, request.workspaceId);
  if (!authorized.ok) return authorized.result;
  const result = service.breakpoints.setBreakpointsForFile(
    authorized.workspace.realRoot,
    request.expectedRevision,
    expectedEtag(ctx),
    request.fileId,
    requestedBreakpoints(request.breakpoints),
  );
  if (!result.ok) return mutationResponse(result);
  const reconciled = await reconcileActiveBreakpoints(
    service,
    authorized.workspace,
    request.fileId,
    result,
  );
  if (!reconciled.result.ok) return mutationResponse(reconciled.result);
  const publication = publishInstrumentationChange(
    service,
    authorized.workspace,
    reconciled.result,
  );
  if (publication !== undefined) return publication;
  return reconciled.activation === "unavailable"
    ? persistedButNotArmed(reconciled.result)
    : mutationResponse(reconciled.result);
}

async function handleSetDebugExceptionBreakpoints(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseSetExceptionBreakpointsRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeWorkspace(ctx, deps, service, request.workspaceId);
  if (!authorized.ok) return authorized.result;
  const result = service.breakpoints.setExceptionBreakpoints(
    authorized.workspace.realRoot,
    request.expectedRevision,
    expectedEtag(ctx),
    requestedExceptionFilters(request.filters),
  );
  if (!result.ok) return mutationResponse(result);
  const activation = await updateActiveExceptionBreakpoints(
    service,
    authorized.workspace,
    result.snapshot,
  );
  const publication = publishInstrumentationChange(service, authorized.workspace, result);
  if (publication !== undefined) return publication;
  return activation === "unavailable" ? persistedButNotArmed(result) : mutationResponse(result);
}

function requestedWatches(
  watches: readonly { readonly expression: string; readonly enabled: boolean }[],
): readonly RequestedWatchExpression[] {
  return watches.map(({ expression, enabled }) => ({ expression, enabled }));
}

async function handleSetDebugWatches(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseSetWatchesRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeWorkspace(ctx, deps, service, request.workspaceId);
  if (!authorized.ok) return authorized.result;
  return mutationResponse(
    service.breakpoints.setWatches(
      authorized.workspace.realRoot,
      request.expectedRevision,
      expectedEtag(ctx),
      requestedWatches(request.watches),
    ),
  );
}

function validNonnegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function reconfigureClearedInstrumentation(
  service: DapDebugRouteService,
  workspace: AuthorizedWorkspace,
  prior: InstrumentationSnapshot,
  cleared: InstrumentationSnapshot,
): Promise<"inactive" | "armed" | "unavailable"> {
  const sessionId = service.manager.boundSessionId(
    workspace.partition,
    workspace.browserSessionBinding,
  );
  if (sessionId === undefined) return "inactive";
  let unavailable =
    (await updateActiveExceptionBreakpoints(service, workspace, cleared)) === "unavailable";
  const fileIds = new Set(prior.breakpoints.map((breakpoint) => breakpoint.fileId));
  for (const fileId of fileIds) {
    const update = await updateActiveBreakpoints(service, workspace, fileId, cleared);
    if (update.kind === "unavailable") unavailable = true;
    if (update.kind === "response") {
      await projectAdapterResponse(service, sessionId, () =>
        verificationUpdates(fileId, cleared, update.response),
      );
    }
  }
  return unavailable ? "unavailable" : "armed";
}

async function handleClearDebugInstrumentation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const workspaceId = ctx.url.searchParams.get("workspaceId") ?? "";
  const revision = validNonnegativeInteger(ctx.url.searchParams.get("expectedRevision"));
  if (revision === undefined) {
    return { status: 400, body: errorBody("INVALID_REQUEST", "Expected revision is required.") };
  }
  const authorized = await authorizeWorkspace(ctx, deps, service, workspaceId);
  if (!authorized.ok) return authorized.result;
  const prior = service.breakpoints.snapshot(authorized.workspace.realRoot);
  if (!prior.ok) {
    return { status: 503, body: errorBody("STATE_UNAVAILABLE", "Debug state is unavailable.") };
  }
  const result = service.breakpoints.clearAll(
    authorized.workspace.realRoot,
    revision,
    expectedEtag(ctx),
  );
  if (!result.ok) return mutationResponse(result);
  const activation = await reconfigureClearedInstrumentation(
    service,
    authorized.workspace,
    prior.snapshot,
    result.snapshot,
  );
  const publication = publishInstrumentationChange(service, authorized.workspace, result);
  if (publication !== undefined) return publication;
  return activation === "unavailable" ? persistedButNotArmed(result) : mutationResponse(result);
}

function adapterRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DAP_RESPONSE_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

function adapterShape(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = adapterRecord(value);
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new Error("DAP_RESPONSE_INVALID");
  }
  return record;
}

function invalidAdapterResponse(error: unknown): boolean {
  return error instanceof Error && error.message === "DAP_RESPONSE_INVALID";
}

async function projectAdapterResponse<T>(
  service: DapDebugRouteService,
  sessionId: string,
  projection: () => T,
): Promise<T> {
  try {
    return projection();
  } catch (error: unknown) {
    if (invalidAdapterResponse(error)) await service.manager.failMalformed(sessionId);
    throw error;
  }
}

function adapterArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new Error("DAP_RESPONSE_INVALID");
  }
  return value;
}

function positiveAdapterInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("DAP_RESPONSE_INVALID");
  }
  return value;
}

async function firstThreadId(service: DapDebugRouteService, sessionId: string): Promise<number> {
  const raw = await service.manager.request(sessionId, "threads", {}, "inspection");
  return projectAdapterResponse(service, sessionId, () => {
    const response = adapterShape(raw, ["threads"]);
    const first = adapterArray(response.threads)[0];
    return positiveAdapterInteger(adapterShape(first, ["id", "name"]).id);
  });
}

async function stoppedThreadId(
  service: DapDebugRouteService,
  sessionId: string,
  pauseGeneration: number,
): Promise<number> {
  const context = service.manager.pauseContext(sessionId);
  if (context?.pauseGeneration !== pauseGeneration) throw new Error("STALE_PAUSE");
  if (context.threadId !== undefined) return context.threadId;
  if (context.allThreadsStopped) return firstThreadId(service, sessionId);
  throw new Error("DAP_RESPONSE_INVALID");
}

function pauseStillCurrent(
  service: DapDebugRouteService,
  sessionId: string,
  pauseGeneration: number,
): boolean {
  const projection = service.manager.health(sessionId);
  return projection?.state === "paused" && projection.pauseGeneration === pauseGeneration;
}

function pauseProjectionStillCurrent(
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  projectionEpoch: number | undefined,
): boolean {
  return (
    projectionEpoch !== undefined &&
    pauseStillCurrent(service, scope.sessionId, scope.pauseGeneration) &&
    service.references.projectionEpoch(scope) === projectionEpoch
  );
}

function stalePause(): RouteResult {
  return { status: 409, body: errorBody("STALE_PAUSE", "The paused debug state has changed.") };
}

function controlAllowed(projection: DebugSessionProjection, action: string): boolean {
  return action === "pause" ? projection.state === "running" : projection.state === "paused";
}

async function handleControlDebugSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseDebugSessionControlRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeSession(
    ctx,
    deps,
    service,
    request.sessionId,
    request.pauseGeneration,
  );
  if (!authorized.ok) return authorized.result;
  if (request.action === "stop") {
    await service.manager.stop(request.sessionId);
    service.references.clearSession(request.sessionId);
    return { status: 200, body: { sessionId: request.sessionId, status: "stopped" } };
  }
  if (!controlAllowed(authorized.value.projection, request.action)) {
    return {
      status: 409,
      body: errorBody("INVALID_SESSION_STATE", "Debug control is not valid now."),
    };
  }
  const threadId =
    request.action === "pause"
      ? await firstThreadId(service, request.sessionId)
      : await stoppedThreadId(service, request.sessionId, request.pauseGeneration);
  const command = request.action === "continue" ? "continue" : request.action;
  await service.manager.request(request.sessionId, command, { threadId }, "control");
  if (request.action !== "pause") service.references.clearSession(request.sessionId);
  return {
    status: 200,
    body: { sessionId: request.sessionId, action: request.action, accepted: true },
  };
}

function requirePaused(authorized: AuthorizedSession): RouteResult | undefined {
  return authorized.projection.state === "paused"
    ? undefined
    : { status: 409, body: errorBody("NOT_PAUSED", "The debug session is not paused.") };
}

function adapterString(value: unknown): string {
  if (typeof value !== "string") throw new Error("DAP_RESPONSE_INVALID");
  return value;
}

function nonnegativeAdapterInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("DAP_RESPONSE_INVALID");
  }
  return value;
}

function mintReference(
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  target: DebugReferenceTarget,
): string {
  const minted = service.references.mint(scope, target);
  if (!minted.ok) throw new Error("DEBUG_REFERENCE_CAPACITY");
  return minted.reference;
}

function tryMintReference(
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  target: DebugReferenceTarget,
): string | undefined {
  const minted = service.references.mint(scope, target);
  return minted.ok ? minted.reference : undefined;
}

function canonicalSourceFileId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const path = (value as Readonly<Record<string, unknown>>).path;
  if (typeof path !== "string" || !path.startsWith(`${CAPSULE_ROOT}/`)) return undefined;
  const fileId = path.slice(CAPSULE_ROOT.length + 1);
  if (!validCanonicalFileId(fileId)) return undefined;
  return Buffer.byteLength(fileId, "utf8") <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFileIdBytes
    ? fileId
    : undefined;
}

function validCanonicalFileId(fileId: string): boolean {
  if (fileId.length === 0 || fileId.includes("\\") || fileId.includes("\0")) return false;
  return fileId.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function stackFrameInput(
  value: unknown,
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
): {
  readonly frameRef: string;
  readonly name: string;
  readonly sourceFileId?: string | undefined;
  readonly line: number;
  readonly column: number;
} {
  const record = adapterShape(value, [
    "id",
    "name",
    "source",
    "line",
    "column",
    "endLine",
    "endColumn",
    "canRestart",
    "instructionPointerReference",
    "moduleId",
    "presentationHint",
  ]);
  const frameId = positiveAdapterInteger(record.id);
  const sourceFileId = canonicalSourceFileId(record.source);
  return {
    frameRef: mintReference(service, scope, { kind: "frame", frameId }),
    name: adapterString(record.name),
    ...(sourceFileId === undefined ? {} : { sourceFileId }),
    line: positiveAdapterInteger(record.line),
    column: positiveAdapterInteger(record.column),
  };
}

function stackTraceResult(
  request: StackTraceRequest,
  startFrame: number,
  response: Readonly<Record<string, unknown>>,
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
): RouteResult {
  service.references.activatePause(scope);
  const inputs = adapterArray(response.stackFrames)
    .slice(0, request.levels)
    .map((frame) => stackFrameInput(frame, service, scope));
  const frames = [...buildStackPage(inputs, 0).frames];
  const reportedTotal = response.totalFrames;
  const totalCount =
    typeof reportedTotal === "number" && Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
      ? reportedTotal
      : startFrame + inputs.length;
  const projection = (nextCursor: string | undefined): unknown => {
    const nextStart = startFrame + frames.length;
    return {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      sessionId: request.sessionId,
      pauseGeneration: request.pauseGeneration,
      frames,
      totalCount,
      retainedCount: frames.length,
      omittedCount: Math.max(0, totalCount - nextStart),
      truncated: totalCount > nextStart,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  };
  const cursorPlaceholder = "x".repeat(32);
  while (jsonBytes(projection(cursorPlaceholder)) > MAX_DEBUG_BODY_BYTES) {
    if (frames.length === 0) throw new Error("DEBUG_HTTP_PROJECTION_OVERFLOW");
    frames.pop();
  }
  const nextStart = startFrame + frames.length;
  const nextCursor =
    nextStart < Math.min(totalCount, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames)
      ? tryMintReference(service, scope, { kind: "cursor", startFrame: nextStart })
      : undefined;
  return { status: 200, body: projection(nextCursor) };
}

function stackStartFrame(
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  request: StackTraceRequest,
): Parsed<number> {
  if (request.cursor === undefined) return { ok: true, value: request.startFrame ?? 0 };
  const resolved = service.references.resolve(scope, request.cursor, "cursor");
  return resolved.ok
    ? { ok: true, value: resolved.target.startFrame }
    : {
        ok: false,
        result: { status: 409, body: errorBody("STALE_CURSOR", "Stack cursor is invalid.") },
      };
}

async function handleDebugStackTrace(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseStackTraceRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeSession(
    ctx,
    deps,
    service,
    request.sessionId,
    request.pauseGeneration,
  );
  if (!authorized.ok) return authorized.result;
  const paused = requirePaused(authorized.value);
  if (paused !== undefined) return paused;
  service.references.activatePause(authorized.value.scope);
  const projectionEpoch = service.references.projectionEpoch(authorized.value.scope);
  const startFrame = stackStartFrame(service, authorized.value.scope, request);
  if (!startFrame.ok) return startFrame.result;
  const threadId = await stoppedThreadId(service, request.sessionId, request.pauseGeneration);
  const raw = await service.manager.request(
    request.sessionId,
    "stackTrace",
    { threadId, startFrame: startFrame.value, levels: request.levels },
    "inspection",
  );
  if (!pauseProjectionStillCurrent(service, authorized.value.scope, projectionEpoch))
    return stalePause();
  return projectAdapterResponse(service, request.sessionId, () =>
    stackTraceResult(
      request,
      startFrame.value,
      adapterShape(raw, ["stackFrames", "totalFrames"]),
      service,
      authorized.value.scope,
    ),
  );
}

function resolveReference(
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  reference: string,
  kind: "frame" | "variable",
): Parsed<Extract<DebugReferenceTarget, { readonly kind: "frame" | "scope" | "variable" }>> {
  if (kind === "frame") {
    const resolved = service.references.resolve(scope, reference, "frame");
    return resolved.ok
      ? { ok: true, value: resolved.target }
      : {
          ok: false,
          result: {
            status: 409,
            body: errorBody("STALE_REFERENCE", "Debug reference is invalid."),
          },
        };
  }
  const scopeTarget = service.references.resolve(scope, reference, "scope");
  if (scopeTarget.ok) return { ok: true, value: scopeTarget.target };
  const variableTarget = service.references.resolve(scope, reference, "variable");
  return variableTarget.ok
    ? { ok: true, value: variableTarget.target }
    : {
        ok: false,
        result: { status: 409, body: errorBody("STALE_REFERENCE", "Debug reference is invalid.") },
      };
}

interface ValidatedScopeInput {
  readonly variablesReference: number;
  readonly name: string;
  readonly expensive: boolean;
  readonly variableCount?: number | undefined;
}

function validatedScopeInput(value: unknown): ValidatedScopeInput {
  const record = adapterShape(value, [
    "name",
    "presentationHint",
    "variablesReference",
    "namedVariables",
    "indexedVariables",
    "expensive",
    "source",
    "line",
    "column",
    "endLine",
    "endColumn",
  ]);
  const variablesReference = positiveAdapterInteger(record.variablesReference);
  const namedVariables = record.namedVariables;
  const validCount =
    typeof namedVariables === "number" &&
    Number.isSafeInteger(namedVariables) &&
    namedVariables >= 0;
  return {
    variablesReference,
    name: adapterString(record.name),
    expensive: record.expensive === true,
    ...(validCount ? { variableCount: namedVariables } : {}),
  };
}

function mintScopeInput(
  input: ValidatedScopeInput,
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
): Parameters<typeof buildScopeProjection>[0][number] {
  const minted = service.references.mint(scope, {
    kind: "scope",
    variablesReference: input.variablesReference,
    depth: 0,
  });
  if (!minted.ok) throw new Error("DAP_RESPONSE_INVALID");
  return {
    scopeRef: minted.reference,
    name: input.name,
    expensive: input.expensive,
    ...(input.variableCount === undefined ? {} : { variableCount: input.variableCount }),
  };
}

function scopesResult(
  request: ScopesRequest,
  raw: unknown,
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
): RouteResult {
  const response = adapterShape(raw, ["scopes"]);
  const validated = adapterArray(response.scopes).map(validatedScopeInput);
  const scopes = validated
    .slice(0, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxScopesPerFrame)
    .map((input) => mintScopeInput(input, service, scope));
  const projection = buildScopeProjection(scopes);
  const omittedCount = validated.length - projection.retainedCount;
  return {
    status: 200,
    body: {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      sessionId: request.sessionId,
      pauseGeneration: request.pauseGeneration,
      ...projection,
      omittedCount,
      truncated: omittedCount > 0,
    },
  };
}

async function handleDebugScopes(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseScopesRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeSession(
    ctx,
    deps,
    service,
    request.sessionId,
    request.pauseGeneration,
  );
  if (!authorized.ok) return authorized.result;
  const paused = requirePaused(authorized.value);
  if (paused !== undefined) return paused;
  service.references.activatePause(authorized.value.scope);
  const projectionEpoch = service.references.projectionEpoch(authorized.value.scope);
  const frame = resolveReference(service, authorized.value.scope, request.frameRef, "frame");
  if (!frame.ok || frame.value.kind !== "frame") return frame.ok ? sessionNotFound() : frame.result;
  const raw = await service.manager.request(
    request.sessionId,
    "scopes",
    { frameId: frame.value.frameId },
    "inspection",
  );
  if (!pauseProjectionStillCurrent(service, authorized.value.scope, projectionEpoch))
    return stalePause();
  return projectAdapterResponse(service, request.sessionId, () =>
    scopesResult(request, raw, service, authorized.value.scope),
  );
}

function variablePresentation(
  record: Readonly<Record<string, unknown>>,
): DebugVariableInput["presentation"] {
  const hint = record.presentationHint;
  if (typeof hint !== "object" || hint === null || Array.isArray(hint)) return "data";
  const kind = (hint as Readonly<Record<string, unknown>>).kind;
  if (kind === "method" || kind === "property") return kind;
  if (kind === "virtual") return "virtual";
  return "data";
}

function variableInput(
  value: unknown,
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  parentVariablesReference: number,
  depth: number,
): DebugVariableInput | undefined {
  const record = adapterShape(value, [
    "name",
    "value",
    "type",
    "presentationHint",
    "evaluateName",
    "variablesReference",
    "namedVariables",
    "indexedVariables",
    "memoryReference",
    "declarationLocationReference",
    "valueLocationReference",
  ]);
  const name = adapterString(record.name);
  const childReference = nonnegativeAdapterInteger(record.variablesReference);
  const variableRef = tryMintReference(service, scope, {
    kind: "variable",
    variablesReference: childReference,
    parentVariablesReference,
    depth,
    name,
    settable: true,
  });
  if (variableRef === undefined) return undefined;
  return {
    variableRef,
    name,
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    value: adapterString(record.value),
    presentation: variablePresentation(record),
    children: [],
  };
}

interface CollectedVariables {
  readonly variables: readonly DebugVariableInput[];
  readonly omittedCount: number;
}

function collectVariableInputs(
  values: readonly unknown[],
  service: DapDebugRouteService,
  scope: DebugReferenceScope,
  parentVariablesReference: number,
  depth: number,
): CollectedVariables {
  const variables: DebugVariableInput[] = [];
  for (const value of values) {
    const input = variableInput(value, service, scope, parentVariablesReference, depth);
    if (input === undefined) break;
    variables.push(input);
  }
  return { variables, omittedCount: values.length - variables.length };
}

function variableParentReference(
  target: Extract<DebugReferenceTarget, { readonly kind: "scope" | "variable" }>,
): number {
  return target.variablesReference;
}

function variableDepth(
  target: Extract<DebugReferenceTarget, { readonly kind: "scope" | "variable" }>,
): number {
  return target.depth;
}

function variableTruncationMarker(
  reason: "depth" | "width" | "nodeLimit",
  omittedCount: number,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ kind: "truncated", reason, omittedCount, truncated: true });
}

function depthTruncatedVariableResponse(request: {
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly variableRef: string;
}): unknown {
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    sessionId: request.sessionId,
    pauseGeneration: request.pauseGeneration,
    parentRef: request.variableRef,
    nodes: [variableTruncationMarker("depth", 1)],
    retainedCount: 0,
    omittedCount: 1,
    nodeCount: 1,
    truncated: true,
  };
}

function boundedVariableResponse(
  request: {
    readonly sessionId: string;
    readonly pauseGeneration: number;
    readonly variableRef: string;
  },
  variables: readonly DebugVariableInput[],
  capacityOmittedCount = 0,
): unknown {
  const retained = [...variables];
  const body = (): unknown => {
    const tree = buildDebugVariableTree(retained);
    const projectionOmittedCount = variables.length - retained.length;
    const omittedCount = capacityOmittedCount + projectionOmittedCount;
    const reason = capacityOmittedCount > 0 ? "nodeLimit" : "width";
    const nodes =
      omittedCount > 0
        ? [...tree.nodes, variableTruncationMarker(reason, omittedCount)]
        : tree.nodes;
    return {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      sessionId: request.sessionId,
      pauseGeneration: request.pauseGeneration,
      parentRef: request.variableRef,
      ...tree,
      nodes,
      nodeCount: tree.nodeCount + (omittedCount > 0 ? 1 : 0),
      retainedCount: retained.length,
      omittedCount,
      truncated: tree.truncated || omittedCount > 0,
    };
  };
  let projection = body();
  while (jsonBytes(projection) > MAX_DEBUG_BODY_BYTES) {
    if (retained.length === 0) throw new Error("DEBUG_HTTP_PROJECTION_OVERFLOW");
    retained.pop();
    projection = body();
  }
  return projection;
}

function expandedVariableResult(
  request: VariablesRequest,
  authorized: AuthorizedSession,
  parentReference: number,
  parentDepth: number,
  raw: unknown,
): RouteResult {
  const response = adapterShape(raw, ["variables"]);
  const values = adapterArray(response.variables).slice(
    0,
    DEFAULT_DEBUG_PAYLOAD_LIMITS.maxVariablesPerExpansion,
  );
  const collected = collectVariableInputs(
    values,
    authorized.service,
    authorized.scope,
    parentReference,
    parentDepth + 1,
  );
  return {
    status: 200,
    body: boundedVariableResponse(request, collected.variables, collected.omittedCount),
  };
}

async function expandVariables(
  request: VariablesRequest,
  authorized: AuthorizedSession,
): Promise<RouteResult> {
  const service = authorized.service;
  const resolved = resolveReference(service, authorized.scope, request.variableRef, "variable");
  if (!resolved.ok) return resolved.result;
  if (resolved.value.kind === "frame") return sessionNotFound();
  const parentDepth = variableDepth(resolved.value);
  if (parentDepth >= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxDepth)
    return { status: 200, body: depthTruncatedVariableResponse(request) };
  const parentReference = variableParentReference(resolved.value);
  if (parentReference === 0) {
    return { status: 409, body: errorBody("NOT_EXPANDABLE", "This variable has no children.") };
  }
  const projectionEpoch = service.references.projectionEpoch(authorized.scope);
  const raw = await service.manager.request(
    request.sessionId,
    "variables",
    {
      variablesReference: parentReference,
      start: 0,
      count: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxVariablesPerExpansion,
    },
    "inspection",
  );
  if (!pauseProjectionStillCurrent(service, authorized.scope, projectionEpoch)) return stalePause();
  return projectAdapterResponse(service, request.sessionId, () =>
    expandedVariableResult(request, authorized, parentReference, parentDepth, raw),
  );
}

async function handleDebugVariables(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseVariablesRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeSession(
    ctx,
    deps,
    service,
    request.sessionId,
    request.pauseGeneration,
  );
  if (!authorized.ok) return authorized.result;
  const paused = requirePaused(authorized.value);
  if (paused !== undefined) return paused;
  service.references.activatePause(authorized.value.scope);
  return expandVariables(request, authorized.value);
}

async function setVariable(
  request: SetVariableRequest,
  authorized: AuthorizedSession,
): Promise<RouteResult> {
  const service = authorized.service;
  if (!authorized.projection.supportsSetVariable) {
    return {
      status: 403,
      body: errorBody("SET_VARIABLE_DENIED", "Variable editing is unavailable."),
    };
  }
  const resolved = service.references.resolve(authorized.scope, request.variableRef, "variable");
  if (!resolved.ok) {
    return { status: 409, body: errorBody("STALE_REFERENCE", "Debug reference is invalid.") };
  }
  if (!resolved.target.settable) {
    return { status: 403, body: errorBody("SET_VARIABLE_DENIED", "This value is read-only.") };
  }
  const projectionEpoch = service.references.projectionEpoch(authorized.scope);
  const raw = await service.manager.request(
    request.sessionId,
    "setVariable",
    {
      variablesReference: resolved.target.parentVariablesReference,
      name: resolved.target.name,
      value: request.value,
    },
    "inspection",
  );
  if (!pauseProjectionStillCurrent(service, authorized.scope, projectionEpoch)) return stalePause();
  return projectAdapterResponse(service, request.sessionId, () =>
    setVariableResult(
      request,
      authorized,
      resolved.target,
      adapterShape(raw, SET_VARIABLE_RESPONSE_KEYS),
    ),
  );
}

function setVariableResult(
  request: SetVariableRequest,
  authorized: AuthorizedSession,
  target: Extract<DebugReferenceTarget, { readonly kind: "variable" }>,
  response: Readonly<Record<string, unknown>>,
): RouteResult {
  const service = authorized.service;
  service.references.resetPause(authorized.scope);
  const input = variableInput(
    {
      name: target.name,
      value: response.value,
      type: response.type,
      variablesReference: response.variablesReference ?? 0,
    },
    service,
    authorized.scope,
    target.parentVariablesReference,
    target.depth,
  );
  return {
    status: 200,
    body: {
      schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
      sessionId: request.sessionId,
      pauseGeneration: request.pauseGeneration,
      result:
        input === undefined
          ? variableTruncationMarker("nodeLimit", 1)
          : buildDebugVariableTree([input]).nodes[0],
    },
  };
}

async function handleDebugSetVariable(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseSetVariableRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeSession(
    ctx,
    deps,
    service,
    request.sessionId,
    request.pauseGeneration,
  );
  if (!authorized.ok) return authorized.result;
  const paused = requirePaused(authorized.value);
  return paused ?? setVariable(request, authorized.value);
}

function registeredWatch(
  request: EvaluateWatchRequest,
  authorized: AuthorizedSession,
): Parsed<WatchExpression> {
  const snapshot = authorized.service.breakpoints.snapshot(authorized.workspace.realRoot);
  if (!snapshot.ok) {
    return {
      ok: false,
      result: {
        status: 503,
        body: errorBody("STATE_UNAVAILABLE", "Debug state is unavailable."),
      },
    };
  }
  const watch = snapshot.snapshot.watches.find(
    (candidate) => candidate.watchId === request.watchId && candidate.enabled,
  );
  return watch === undefined
    ? {
        ok: false,
        result: { status: 404, body: errorBody("WATCH_NOT_FOUND", "The watch was not found.") },
      }
    : { ok: true, value: watch };
}

type OptionalFrameResolution =
  | { readonly ok: true; readonly frameId: number | undefined }
  | { readonly ok: false; readonly result: RouteResult };

function optionalFrameId(
  request: EvaluateWatchRequest,
  authorized: AuthorizedSession,
): OptionalFrameResolution {
  if (request.frameRef === undefined) return { ok: true, frameId: undefined };
  const frame = authorized.service.references.resolve(authorized.scope, request.frameRef, "frame");
  return frame.ok
    ? { ok: true, frameId: frame.target.frameId }
    : {
        ok: false,
        result: { status: 409, body: errorBody("STALE_REFERENCE", "Debug reference is invalid.") },
      };
}

async function evaluateWatch(
  request: EvaluateWatchRequest,
  authorized: AuthorizedSession,
  watch: WatchExpression,
  frameId: number | undefined,
): Promise<RouteResult> {
  const service = authorized.service;
  const projectionEpoch = service.references.projectionEpoch(authorized.scope);
  const raw = await service.manager.request(
    request.sessionId,
    "evaluate",
    {
      expression: watch.expression,
      context: "watch",
      ...(frameId === undefined ? {} : { frameId }),
    },
    "inspection",
  );
  if (!pauseProjectionStillCurrent(service, authorized.scope, projectionEpoch)) return stalePause();
  return projectAdapterResponse(service, request.sessionId, () =>
    watchEvaluationResult(request, authorized, watch, adapterShape(raw, EVALUATE_RESPONSE_KEYS)),
  );
}

function watchEvaluationResult(
  request: EvaluateWatchRequest,
  authorized: AuthorizedSession,
  watch: WatchExpression,
  response: Readonly<Record<string, unknown>>,
): RouteResult {
  const service = authorized.service;
  const variablesReference = nonnegativeAdapterInteger(response.variablesReference ?? 0);
  const variableRef =
    variablesReference === 0
      ? undefined
      : mintReference(service, authorized.scope, {
          kind: "variable",
          variablesReference,
          parentVariablesReference: 0,
          depth: 0,
          name: watch.expression,
          settable: false,
        });
  return {
    status: 200,
    body: buildWatchEvaluationResult({
      watchId: watch.watchId,
      pauseGeneration: request.pauseGeneration,
      state: "value",
      value: adapterString(response.result),
      ...(typeof response.type === "string" ? { type: response.type } : {}),
      ...(variableRef === undefined ? {} : { variableRef }),
    }),
  };
}

async function handleEvaluateDebugWatch(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const parsed = await parseBody(ctx, parseEvaluateWatchRequest);
  if (!parsed.ok) return parsed.result;
  const request = parsed.value;
  const authorized = await authorizeSession(
    ctx,
    deps,
    service,
    request.sessionId,
    request.pauseGeneration,
  );
  if (!authorized.ok) return authorized.result;
  const paused = requirePaused(authorized.value);
  if (paused !== undefined) return paused;
  const watch = registeredWatch(request, authorized.value);
  if (!watch.ok) return watch.result;
  const frame = optionalFrameId(request, authorized.value);
  return frame.ok
    ? evaluateWatch(request, authorized.value, watch.value, frame.frameId)
    : frame.result;
}

function parseLastSequence(ctx: RouteContext): number | undefined {
  const raw = ctx.req.headers["last-event-id"] ?? ctx.url.searchParams.get("lastEventId");
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function frameDebugEvent(envelope: DebugEventEnvelope): string {
  return `id: ${String(envelope.sequence)}\nevent: editor-debug:${envelope.event.kind}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function frameDebugSnapshot(snapshot: DebugEventReplaySnapshot, required: boolean): string {
  const event = required ? "editor-debug:snapshot-required" : "editor-debug:snapshot";
  return `id: ${String(snapshot.sequence)}\nevent: ${event}\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

function openDebugStream(
  ctx: RouteContext,
  result: Extract<ReturnType<DapEventBridge["subscribe"]>, { readonly kind: "ok" }>,
  controller: AbortController,
): typeof STREAMING {
  ctx.res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(ctx.res);
  const stop = (): void => {
    stopHeartbeat();
    controller.abort();
    result.unsubscribe();
  };
  ctx.res.on("close", stop);
  writeOrDestroy(ctx.res, frameDebugSnapshot(result.snapshot, result.snapshotRequired), controller);
  for (const event of result.replay) {
    if (controller.signal.aborted) break;
    writeOrDestroy(ctx.res, frameDebugEvent(event), controller);
  }
  if (!controller.signal.aborted) writeOrDestroy(ctx.res, readyMessage(), controller);
  return STREAMING;
}

export async function handleDebugEvents(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const service = unavailable(deps);
  if (isRouteResult(service)) return service;
  const workspaceId = ctx.url.searchParams.get("workspaceId") ?? "";
  const authorized = await authorizeWorkspace(ctx, deps, service, workspaceId);
  if (!authorized.ok) return authorized.result;
  const controller = new AbortController();
  const result = service.events.subscribe({
    channel: {
      workspacePartitionKey: authorized.workspace.partition,
      browserSessionBinding: authorized.workspace.browserSessionBinding,
    },
    lastSequence: parseLastSequence(ctx),
    onEvent: (event) => writeOrDestroy(ctx.res, frameDebugEvent(event), controller),
  });
  if (result.kind === "subscriberLimit") {
    return { status: 429, body: errorBody("SUBSCRIBER_LIMIT", "Too many debug subscribers.") };
  }
  return openDebugStream(ctx, result, controller);
}

export const DAP_DEBUG_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/editor/debug/bootstrap", handler: handleDebugBootstrap },
  { method: "POST", pattern: "/api/editor/debug/sessions", handler: handleStartDebugSession },
  {
    method: "GET",
    pattern: "/api/editor/debug/sessions/:sessionId",
    handler: handleGetDebugSession,
  },
  {
    method: "DELETE",
    pattern: "/api/editor/debug/sessions/:sessionId",
    handler: handleDeleteDebugSession,
  },
  { method: "POST", pattern: "/api/editor/debug/control", handler: handleControlDebugSession },
  {
    method: "GET",
    pattern: "/api/editor/debug/instrumentation",
    handler: handleGetDebugInstrumentation,
  },
  {
    method: "DELETE",
    pattern: "/api/editor/debug/instrumentation",
    handler: handleClearDebugInstrumentation,
  },
  { method: "PUT", pattern: "/api/editor/debug/breakpoints", handler: handleSetDebugBreakpoints },
  {
    method: "PUT",
    pattern: "/api/editor/debug/exception-breakpoints",
    handler: handleSetDebugExceptionBreakpoints,
  },
  { method: "PUT", pattern: "/api/editor/debug/watches", handler: handleSetDebugWatches },
  { method: "POST", pattern: "/api/editor/debug/stack", handler: handleDebugStackTrace },
  { method: "POST", pattern: "/api/editor/debug/scopes", handler: handleDebugScopes },
  { method: "POST", pattern: "/api/editor/debug/variables", handler: handleDebugVariables },
  {
    method: "POST",
    pattern: "/api/editor/debug/variables/set",
    handler: handleDebugSetVariable,
  },
  {
    method: "POST",
    pattern: "/api/editor/debug/watches/evaluate",
    handler: handleEvaluateDebugWatch,
  },
  { method: "GET", pattern: "/api/editor/debug/events", handler: handleDebugEvents },
];
