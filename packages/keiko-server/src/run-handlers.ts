// The five run-engine BFF endpoints (ADR-0011 D5 routes 5–9). POST /api/runs starts a dry-run-first
// run in the background and returns 202 {runId, fingerprint}; the SSE route replays the bounded ring
// buffer (respecting Last-Event-ID) then streams live redacted events, closing after the terminal
// event; cancel propagates to the underlying harness/workflow AbortController; GET returns the
// redacted final report projection (or status:"running"); apply is the ONLY write path, re-invoking
// the same workflow with apply:true through the existing gated path. No model is ever called
// directly; no guard is reimplemented; no secret reaches any response (live payloads are redacted).

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseRunRequest } from "./run-request.js";
import type { RunRequest, RunVoiceOrigin } from "./run-request.js";
import { startRun, applyRun, type EngineContext } from "./run-engine.js";
import { ActiveRunLimitError, type AppliableSnapshot, type RunRecord } from "./runs.js";
import { SSE_HEADERS, writeMessageEvent, readyMessage, startSseHeartbeat } from "./sse.js";
import type { SseWriter, StreamEvent } from "./sink.js";
import type { RouteContext, RouteResult, HandlerOutcome } from "./routes.js";
import { errorBody, STREAMING } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";
import {
  VOICE_TRANSCRIPT_SCHEMA_VERSION,
  type CommittedVoiceTranscriptProjection,
  type VoiceProfile,
} from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createNodeToolResultArtifactStore } from "@oscharko-dev/keiko-evidence";
import { validateWorkflowHandoffRequest } from "@oscharko-dev/keiko-contracts/workflow-handoff";
import { WorkspaceError } from "@oscharko-dev/keiko-workspace";
import { approvalTokenInputFor, createApprovalToken } from "./governed-workflow.js";
import { isVoiceDictationCapable, isVoiceRealtimeCapable } from "./read-handlers.js";
import { evaluateSpokenActionGovernance } from "./voice-action-governance.js";
import { resolveRegisteredOrManagedWorkspaceRoot } from "./task-workspace/authorization.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { evidenceRetentionDiagnosticObserver } from "./diagnostics-log.js";
import {
  agentRunSessionMatches,
  authorizeAgentRunMutation,
  createAgentRunGovernance,
  reserveAgentRunBudget,
  revokeAgentRunGovernance,
  type AgentRunGovernanceBinding,
} from "./agent-run-governance.js";

const MAX_BODY_BYTES = 1_000_000;
const AGGREGATE_RUN_EVENTS_SNAPSHOT_LIMIT = 128;
const AGENT_RUN_DEFAULT_PATCH_BUDGET_BYTES = 65_536;

const VERIFY_NOOP_MODEL: ModelPort = {
  call: () => Promise.reject(new Error("verify runs must not call the model")),
};

// Sentinel thrown (and caught in handleCreateRun) when the body exceeds MAX_BODY_BYTES. Using a
// typed class avoids fragile string matching and clearly separates this case from I/O errors.
class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

// Reads the request body up to a byte cap (a bounded read protects the loopback BFF from an
// oversized body). Resolves the decoded UTF-8 text, or rejects with BodyTooLargeError past the cap.
// When the cap is exceeded the stream is switched to flowing/drain mode (req.resume) so Node.js
// continues consuming the socket data and the HTTP server can still write the 413 response over
// the same connection (FIX H). The chunks array is cleared at that point to free accumulated memory.
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
          chunks.length = 0; // release accumulated buffers before draining
          reject(new BodyTooLargeError());
          req.resume(); // drain without buffering; lets the server write the 413 response
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

// Composer-launched runs operate on the host filesystem. Reject workspaceRoot paths not registered
// in the local project store so a CSRF-equipped local client cannot trigger workflows in arbitrary
// directories. Returns a RouteResult to return, or null when the check passes.
function rejectUnregisteredWorkspace(parsed: RunRequest, deps: UiHandlerDeps): RouteResult | null {
  const root = typeof parsed.input.workspaceRoot === "string" ? parsed.input.workspaceRoot : "";
  const registered = resolveRegisteredOrManagedWorkspaceRoot(deps, root) !== undefined;
  return registered
    ? null
    : {
        status: 403,
        body: errorBody(
          "WORKSPACE_NOT_REGISTERED",
          "The workspaceRoot is not a registered project.",
        ),
      };
}

/**
 * The apply-time half of `rejectUnregisteredWorkspace`: the same registered-or-managed root
 * authorization, re-asked at the only route that writes to the working tree. A payload with no
 * string `workspaceRoot` fails closed — an unnameable root can never be an authorized one.
 */
function rejectUnauthorizedApplyWorkspace(
  snapshot: AppliableSnapshot,
  deps: UiHandlerDeps,
): RouteResult | null {
  const payload = isRecord(snapshot.payload) ? snapshot.payload : {};
  const root = typeof payload.workspaceRoot === "string" ? payload.workspaceRoot : "";
  if (root.length > 0 && resolveRegisteredOrManagedWorkspaceRoot(deps, root) !== undefined) {
    return null;
  }
  return {
    status: 403,
    body: errorBody("WORKSPACE_NOT_REGISTERED", "The workspaceRoot is not a registered project."),
  };
}

function resolveRunModel(parsed: RunRequest, deps: UiHandlerDeps): ModelPort | undefined {
  return parsed.kind === "verify" ? VERIFY_NOOP_MODEL : deps.modelPortFactory(parsed.modelId);
}

function validateTextGovernedHandoff(parsed: RunRequest): RouteResult | null {
  if (parsed.governedHandoff === undefined || parsed.governedHandoffVoiceOrigin !== undefined) {
    return null;
  }
  const validation = validateWorkflowHandoffRequest(parsed.governedHandoff);
  if (!validation.ok) {
    return { status: 400, body: errorBody("BAD_REQUEST", validation.reasons.join("; ")) };
  }
  const expectedToken = createApprovalToken(approvalTokenInputFor(parsed.governedHandoff));
  if (parsed.governedHandoff.userApprovalToken !== expectedToken) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "governedHandoff approval token does not match the request."),
    };
  }
  return null;
}

function serverTrustedVoiceProfile(deps: UiHandlerDeps): VoiceProfile {
  if (isVoiceRealtimeCapable(deps)) {
    return "full-realtime";
  }
  if (isVoiceDictationCapable(deps)) {
    return "speech-to-text";
  }
  return "none";
}

function committedProjectionFor(origin: RunVoiceOrigin): CommittedVoiceTranscriptProjection {
  return {
    schemaVersion: VOICE_TRANSCRIPT_SCHEMA_VERSION,
    segments: [],
    text: origin.committedText,
    segmentCount: origin.committedSegments,
  };
}

function applyVoiceGovernance(parsed: RunRequest, deps: UiHandlerDeps): RunRequest | RouteResult {
  if (parsed.governedHandoffVoiceOrigin === undefined) {
    const invalidTextHandoff = validateTextGovernedHandoff(parsed);
    return invalidTextHandoff ?? parsed;
  }
  if (parsed.governedHandoff === undefined) {
    return { status: 400, body: errorBody("BAD_REQUEST", "voiceOrigin requires governedHandoff.") };
  }
  const trustedProfile = serverTrustedVoiceProfile(deps);
  const decision = evaluateSpokenActionGovernance({
    projection: committedProjectionFor(parsed.governedHandoffVoiceOrigin),
    profile: trustedProfile,
    turnIndex: parsed.governedHandoffVoiceOrigin.turnIndex,
    source: parsed.governedHandoffVoiceOrigin.source,
    request: parsed.governedHandoff,
    providedConfirmationDigest: parsed.governedHandoffVoiceOrigin.confirmationDigest,
  });
  if (!decision.allowed) {
    return { status: 403, body: errorBody("VOICE_ACTION_DENIED", decision.reason) };
  }
  return {
    ...parsed,
    governedHandoffVoiceOrigin: undefined,
    governedHandoffVoiceAction: decision.audit,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Static, path-safe message for workspace errors surfaced during run launch. The underlying
// WorkspaceError messages may carry absolute paths — we never echo them (ADR-0005, CWE-209).
const WORKSPACE_RUN_ERROR_MESSAGE =
  "The selected workspace could not be prepared: no recognized project workspace marker was found, or the target file could not be read.";

function workspaceRunErrorResult(): RouteResult {
  return {
    status: 400,
    body: errorBody("WORKSPACE_UNAVAILABLE", WORKSPACE_RUN_ERROR_MESSAGE),
  };
}

function mapRunStartError(error: unknown): RouteResult {
  if (error instanceof ActiveRunLimitError) {
    return { status: 429, body: errorBody("TOO_MANY_RUNS", "The active run limit is reached.") };
  }
  if (error instanceof WorkspaceError) {
    return workspaceRunErrorResult();
  }
  throw error;
}

function buildEngineContext(
  request: RunRequest,
  model: ModelPort,
  deps: UiHandlerDeps,
  governance?: AgentRunGovernanceBinding,
): EngineContext {
  return {
    request,
    model,
    registry: deps.registry,
    ...(governance === undefined ? {} : { governance }),
    evidence: {
      store: deps.evidenceStore,
      env: deps.env,
      additionalSecrets: currentRedactionSecrets(deps),
      onRetentionDeleted: evidenceRetentionDiagnosticObserver(deps.diagnostics, "run-engine"),
    },
    ...(deps.evidenceDir === undefined
      ? {}
      : { toolArtifacts: createNodeToolResultArtifactStore(deps.evidenceDir) }),
  };
}

function isGovernedAgentRun(request: RunRequest): boolean {
  return request.kind === "unit-tests" || request.kind === "bug-investigation";
}

function workspaceRootFor(request: RunRequest): string {
  const workspaceRoot = request.input.workspaceRoot;
  return typeof workspaceRoot === "string" ? workspaceRoot : "";
}

type AgentRunGovernancePreparation =
  | { readonly ok: true; readonly binding: AgentRunGovernanceBinding }
  | { readonly ok: false; readonly response: RouteResult };

function prepareAgentRunGovernance(
  ctx: RouteContext,
  request: RunRequest,
  deps: UiHandlerDeps,
  runId: string,
): AgentRunGovernancePreparation {
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined) {
    return {
      ok: false,
      response: {
        status: 403,
        body: errorBody("AGENT_RUN_AUTHORITY_REQUIRED", "The local app session is not paired."),
      },
    };
  }
  const created = createAgentRunGovernance({
    runId,
    workflow: request.kind === "unit-tests" ? "unit-tests" : "bug-investigation",
    workspaceRoot: workspaceRootFor(request),
    modelId: request.modelId,
    requestedMode: request.requestedMode ?? "governed-assist",
    deploymentCeiling: deps.codingRuntimeDeploymentCeiling ?? "governed-assist",
    session,
    nowIso: new Date().toISOString(),
  });
  return created.ok
    ? { ok: true, binding: created.binding }
    : {
        ok: false,
        response: {
          status: 403,
          body: errorBody("AGENT_RUN_AUTHORITY_INVALID", "Agent run authority was rejected."),
        },
      };
}

function agentRunGovernanceProjection(binding: AgentRunGovernanceBinding): Record<string, unknown> {
  return {
    requestedMode: binding.requestedMode,
    effectiveMode: binding.effectiveMode,
    deploymentCeiling: binding.deploymentCeiling,
    connectorExecution: binding.connectorExecution,
    deliveryExecution: binding.deliveryExecution,
  };
}

function launchRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: RunRequest,
  model: ModelPort,
): RouteResult {
  const runId = randomUUID();
  const governance = isGovernedAgentRun(request)
    ? prepareAgentRunGovernance(ctx, request, deps, runId)
    : undefined;
  if (governance !== undefined && !governance.ok) return governance.response;
  const binding = governance?.binding;
  try {
    const started = startRun(buildEngineContext(request, model, deps, binding), deps.redactor, {
      runId,
    });
    return {
      status: 202,
      body: {
        runId: started.runId,
        fingerprint: started.fingerprint,
        ...(binding === undefined ? {} : { governance: agentRunGovernanceProjection(binding) }),
      },
    };
  } catch (error) {
    if (binding !== undefined) revokeAgentRunGovernance(binding);
    return mapRunStartError(error);
  }
}

function requireVerifyAppSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  request: RunRequest,
): RouteResult | undefined {
  if (request.kind !== "verify" || resolveAppSessionReadAuthority(deps, ctx.req) !== undefined) {
    return undefined;
  }
  return {
    status: 403,
    body: errorBody("VERIFY_AUTHORITY_REQUIRED", "The local app session is not paired."),
  };
}

// Route 5 — POST /api/runs. Validates the body, resolves the ModelPort, starts the run, returns 202.
export async function handleCreateRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  const parsed = parseRunRequest(raw);
  if ("code" in parsed) {
    return { status: 400, body: errorBody(parsed.code, parsed.message) };
  }
  const verifyAuthority = requireVerifyAppSession(ctx, deps, parsed);
  if (verifyAuthority !== undefined) return verifyAuthority;
  const governed = applyVoiceGovernance(parsed, deps);
  if ("status" in governed) {
    return governed;
  }
  const unregistered = rejectUnregisteredWorkspace(governed, deps);
  if (unregistered !== null) {
    return unregistered;
  }
  const model = resolveRunModel(governed, deps);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return launchRun(ctx, deps, governed, model);
}

async function hasExplicitApplyConfirmation(ctx: RouteContext): Promise<boolean> {
  try {
    const raw = await readBody(ctx.req);
    const parsed: unknown = JSON.parse(raw);
    return (
      isRecord(parsed) &&
      parsed.confirm === true &&
      Object.keys(parsed).every((key) => key === "confirm")
    );
  } catch {
    return false;
  }
}

function lastEventId(req: IncomingMessage): number {
  const header = req.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return -1;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

// Route 6 — GET /api/runs/:runId/events (SSE). Replays the ring buffer (after Last-Event-ID), sends
// `ready`, then streams live events, closing after the run terminates. The writer is detached on
// client disconnect to avoid leaks and unbounded fan-out.
export function handleRunEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (!agentRecordSessionMatches(record, ctx, deps)) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  openSseStream(ctx.res, record, lastEventId(ctx.req), deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

// Shared run-event stream for the desktop. It replays bounded buffers for recent records, then
// attaches to newly registered runs so multiple AgentRun windows do not consume one SSE slot each.
export function handleAllRunEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const detachByRunId = new Map<string, () => void>();
  let closed = false;

  ctx.res.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startSseHeartbeat(ctx.res);

  const detachRun = (runId: string): void => {
    const detach = detachByRunId.get(runId);
    if (detach === undefined) return;
    detachByRunId.delete(runId);
    detach();
  };

  const attachRun = (record: RunRecord): void => {
    if (closed || detachByRunId.has(record.runId)) return;
    if (!agentRecordSessionMatches(record, ctx, deps)) return;
    const writer = aggregateRunWriter(record, ctx, deps, detachRun);
    const detach = record.sink.attach(writer, -1);
    detachByRunId.set(record.runId, detach);
    if (record.sink.isTerminated()) {
      detachRun(record.runId);
    }
  };

  for (const record of deps.registry.snapshot?.(AGGREGATE_RUN_EVENTS_SNAPSHOT_LIMIT) ?? []) {
    attachRun(record);
  }
  const unsubscribeRegistry = deps.registry.subscribe?.(attachRun) ?? ((): void => undefined);
  ctx.res.write(readyMessage());

  const close = (): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    unsubscribeRegistry();
    for (const runId of Array.from(detachByRunId.keys())) {
      detachRun(runId);
    }
  };
  ctx.req.on("close", close);
  ctx.res.on("close", close);
  return STREAMING;
}

function aggregateRunWriter(
  record: RunRecord,
  ctx: RouteContext,
  deps: UiHandlerDeps,
  detachRun: (runId: string) => void,
): SseWriter {
  return {
    write: (event: StreamEvent): boolean => {
      if (!agentRecordSessionMatches(record, ctx, deps)) return false;
      const accepted = writeMessageEvent(ctx.res, event, deps.redactor);
      if (!accepted) ctx.res.destroy();
      return accepted;
    },
    // A single run reaching terminal must not close the aggregate desktop stream.
    close: (): void => {
      detachRun(record.runId);
    },
  };
}

function agentRecordSessionMatches(
  record: RunRecord,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): boolean {
  if (record.governance === undefined) return true;
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  return session !== undefined && agentRunSessionMatches(record.governance, session);
}

function openSseStream(
  res: ServerResponse,
  record: RunRecord,
  afterSeq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  startSseHeartbeat(res);
  const writer: SseWriter = {
    write: (event: StreamEvent): boolean => {
      const accepted = writeMessageEvent(res, event, redactor);
      if (!accepted) {
        res.destroy();
      }
      return accepted;
    },
    close: (): void => {
      res.end();
    },
  };
  const detach = record.sink.attach(writer, afterSeq);
  res.write(readyMessage());
  res.on("close", detach);
  if (record.sink.isTerminated()) {
    detach();
    res.end();
  }
}

// Route 7 — POST /api/runs/:runId/cancel. Idempotent; 404 unknown.
export function handleCancelRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (!agentRecordSessionMatches(record, ctx, deps)) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  record.cancel("cancelled via UI");
  return { status: 200, body: { ok: true } };
}

// Route 8 — GET /api/runs/:runId. Final redacted report projection, or status:"running".
export function handleGetRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (!agentRecordSessionMatches(record, ctx, deps)) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (record.status === "running") {
    return { status: 200, body: { report: { status: "running" } } };
  }
  return {
    status: 200,
    body: { report: reportWithApply(record.report, record.applyReport, record.appliedAt) },
  };
}

function reportWithApply(
  report: unknown,
  applyReport: unknown,
  appliedAt: number | undefined,
): unknown {
  if (applyReport === undefined || appliedAt === undefined) {
    return report;
  }
  if (!isRecord(report)) {
    return { report, applyReport, appliedAt };
  }
  return { ...report, applyReport, appliedAt };
}

function invalidAgentRunAuthorityResult(): RouteResult {
  return {
    status: 403,
    body: errorBody(
      "AGENT_RUN_AUTHORITY_INVALID",
      "Agent run authority is missing, invalid, or expired.",
    ),
  };
}

async function rejectUnauthorizedAgentApply(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  record: RunRecord,
  snapshot: AppliableSnapshot,
): Promise<RouteResult | null> {
  if (record.governance === undefined) return null;
  if (!(await hasExplicitApplyConfirmation(ctx))) {
    return {
      status: 403,
      body: errorBody("APPROVAL_REQUIRED", "Explicit apply confirmation is required."),
    };
  }
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined) return invalidAgentRunAuthorityResult();
  const payload = isRecord(snapshot.payload) ? snapshot.payload : {};
  const workspaceRoot = typeof payload.workspaceRoot === "string" ? payload.workspaceRoot : "";
  const authorized = authorizeAgentRunMutation({
    binding: record.governance,
    workspaceRoot,
    session,
    nowIso: new Date().toISOString(),
  });
  if (!authorized.ok) return invalidAgentRunAuthorityResult();
  return authorized.effect === "denied"
    ? { status: 403, body: errorBody("POLICY_DENIED", "Agent run apply is denied by policy.") }
    : null;
}

function agentRunApplyPatchBudget(snapshot: AppliableSnapshot): number {
  if (snapshot.kind !== "bug-investigation") return AGENT_RUN_DEFAULT_PATCH_BUDGET_BYTES;
  const configured = snapshot.limits?.maxPatchBytes;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : AGENT_RUN_DEFAULT_PATCH_BUDGET_BYTES;
}

function reserveAgentRunApplyBudget(
  record: RunRecord,
  snapshot: AppliableSnapshot,
): RouteResult | null {
  if (record.governance === undefined) return null;
  const payload = isRecord(snapshot.payload) ? snapshot.payload : {};
  const workspaceRoot = typeof payload.workspaceRoot === "string" ? payload.workspaceRoot : "";
  const reserved = reserveAgentRunBudget({
    binding: record.governance,
    workspaceRoot,
    usage: {
      toolCalls: 0,
      patchBytes: agentRunApplyPatchBudget(snapshot),
      promptTokens: 0,
    },
    nowIso: new Date().toISOString(),
  });
  if (reserved.ok) return null;
  return reserved.reason === "budget-exceeded"
    ? {
        status: 403,
        body: errorBody("AGENT_RUN_BUDGET_EXCEEDED", "Agent run budget is exhausted."),
      }
    : invalidAgentRunAuthorityResult();
}

// Route 9 — POST /api/runs/:runId/apply. The ONLY write path. 404 unknown; 409 when not in an
// appliable (dry-run-success) state; otherwise re-invokes the gated workflow with apply:true.
//
// Issue #638: the pending snapshot is claimed atomically (set to `undefined`) BEFORE we await
// `applyRun`, so a second overlapping request sees `record.appliable === undefined` and 409s
// out. Clearing AFTER the await would let two requests both observe the same pending patch and
// double-apply the workspace mutation, which is the race the regression test reproduces.
export async function handleApplyRun(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  const snapshot = record.appliable;
  if (snapshot === undefined) {
    return {
      status: 409,
      body: errorBody("NOT_APPLIABLE", "The run is not in an appliable state."),
    };
  }
  const agentApplyRejection = await rejectUnauthorizedAgentApply(ctx, deps, record, snapshot);
  if (agentApplyRejection !== null) return agentApplyRejection;
  // Re-prove the workspace authorization AT the write boundary. `handleCreateRun` authorizes the
  // root so a CSRF-equipped local client cannot drive workflows in an arbitrary directory; the
  // decision is not durable authority, and this route — not the dry run — is what mutates the
  // working tree. Checking here closes the window in which a root is de-registered after the run
  // started, and refuses any appliable record whose payload cannot name an authorized root at all.
  // The refusal precedes the atomic claim of `record.appliable`, so a denied write consumes nothing.
  const unauthorized = rejectUnauthorizedApplyWorkspace(snapshot, deps);
  if (unauthorized !== null) return unauthorized;
  const model = deps.modelPortFactory(record.modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const budgetRejection = reserveAgentRunApplyBudget(record, snapshot);
  if (budgetRejection !== null) return budgetRejection;
  record.appliable = undefined;
  const report = await applyRun(
    snapshot,
    model,
    record.modelId,
    deps.redactor,
    record.governance,
    record.runId,
  );
  record.applyReport = report;
  record.appliedAt = Date.now();
  return {
    status: 200,
    body: { report: reportWithApply(record.report, record.applyReport, record.appliedAt) },
  };
}
