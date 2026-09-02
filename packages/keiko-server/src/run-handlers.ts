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
import { markSseStreamBackpressureKilled } from "./sse-write.js";
import { getServerLogger } from "./observability/index.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { SseWriter, StreamEvent } from "./sink.js";
import type { RouteContext, RouteResult, HandlerOutcome } from "./routes.js";
import { errorBody, STREAMING } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";
import type {
  CommittedVoiceTranscriptProjection,
  VoiceProfile,
} from "@oscharko-dev/keiko-contracts";
import { VOICE_TRANSCRIPT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/voice-transcript";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createNodeToolResultArtifactStore } from "@oscharko-dev/keiko-evidence";
import { validateWorkflowHandoffRequest } from "@oscharko-dev/keiko-contracts/workflow-handoff";
import { WorkspaceError } from "@oscharko-dev/keiko-workspace";
import { approvalTokenInputFor, createApprovalToken } from "./governed-workflow.js";
import { isVoiceDictationCapable, isVoiceRealtimeCapable } from "./read-handlers.js";
import { evaluateSpokenActionGovernance } from "./voice-action-governance.js";
import { resolveRegisteredOrManagedWorkspaceRoot } from "./task-workspace/workspace-root-access.js";
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
  openSseStream(ctx.res, record, lastEventId(ctx.req), deps.redactor, ctx.correlationId);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

// User finding #2456 — the wake-up replay burst. A reconnecting desktop (e.g. after tab
// visibility-hidden) names the runs it still follows as comma-separated `runId:seq` pairs in an
// optional `resume` query parameter. Parsed from the RAW query string, never `searchParams`:
// URLSearchParams percent-decodes the value BEFORE we could split it, so a runId containing an
// encoded ":" or "," would corrupt the pair framing. Each runId is percent-encoded by the client;
// it is decoded here after framing. A malformed cursor maps to -1 (full replay) — over-delivery is
// safe (the client dedupes by seq), under-delivery would lose events. Never throws.
//
// A present-but-empty (or all-empty-entries) `resume=` value parses to NO usable pairs. Treating
// that as an empty (defined) Map would make `resumeAfterSeq` fall through to its "unnamed run"
// branch — live-only — for EVERY run, which is under-delivery, not the safe over-delivery this
// function promises. Falling back to `undefined` here keeps that shape byte-identical to "no
// `resume` parameter at all": full replay for every run.
//
// This function has no view of the snapshot, so it cannot itself detect the case where every
// parsed entry is well-formed AS A PAIR but names no run that actually exists (`resume=garbage`
// with no `:` delimiter, or `resume=%` with invalid percent-encoding, both parse to one entry keyed
// by nonsense text). That check — a cursor set is usable only once it matches at least one
// snapshotted run — lives one layer up, in `usableResumeCursors` (PR #3305 review finding 1).
function parseResumeCursors(url: URL): ReadonlyMap<string, number> | undefined {
  const raw = rawQueryParameter(url, "resume");
  if (raw === undefined) return undefined;
  const cursors = new Map<string, number>();
  for (const entry of raw.split(",")) {
    if (entry === "") continue;
    const colon = entry.lastIndexOf(":");
    const runId = decodeResumeRunId(colon === -1 ? entry : entry.slice(0, colon));
    if (runId === "") continue;
    cursors.set(runId, parseResumeSeq(colon === -1 ? "" : entry.slice(colon + 1)));
  }
  return cursors.size === 0 ? undefined : cursors;
}

// The still-percent-encoded value of `name` in `url`'s query, or undefined when absent.
function rawQueryParameter(url: URL, name: string): string | undefined {
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if ((eq === -1 ? pair : pair.slice(0, eq)) !== name) continue;
    return eq === -1 ? "" : pair.slice(eq + 1);
  }
  return undefined;
}

// Invalid percent-encoding falls back to the raw text: the entry still names SOME identifier, and
// matching it best-effort fails toward over-delivery rather than throwing or dropping the entry.
function decodeResumeRunId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// The client's explicit "subscribed, but nothing observed yet — send everything" marker. It is a
// named request for full replay, NOT a malformed cursor: a run the client still follows must never
// be treated like an unnamed (live-only) one, or its buffered history is lost. Pinned by
// run-handlers-sse-resume.test.ts; keep it accepted even if the malformed fallback is ever
// tightened.
const RESUME_FULL_REPLAY_MARKER = "*";
const RESUME_FULL_REPLAY = -1;

// A cursor is the full-replay marker, or a base-10 non-negative safe integer; anything else is
// malformed and also means full replay (over-delivery is safe, under-delivery would lose events).
function parseResumeSeq(raw: string): number {
  if (raw === RESUME_FULL_REPLAY_MARKER) return RESUME_FULL_REPLAY;
  if (!/^\d+$/u.test(raw)) return RESUME_FULL_REPLAY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : RESUME_FULL_REPLAY;
}

// The replay boundary for one snapshot run under the parsed cursors: no `resume` parameter means
// full replay for every run (exactly the pre-#2456 behaviour); a named run resumes after its
// cursor (or fully, when the cursor was malformed); an unnamed run attaches live-only — at reopen
// time the client keeps no subscriber for it, so its replay would be parsed and discarded anyway.
function resumeAfterSeq(cursors: ReadonlyMap<string, number> | undefined, runId: string): number {
  if (cursors === undefined) return -1;
  return cursors.get(runId) ?? Number.MAX_SAFE_INTEGER;
}

// Repository-owner review finding on PR #3305 (P1): a parsed cursor map is trusted only once it
// actually authorizes at least one run present in THIS snapshot — i.e. at least one cursor key
// equals a snapshotted run's id. `parseResumeCursors` cannot see the snapshot, so a malformed
// `resume` value with no `:` delimiter (`resume=garbage`) or invalid percent-encoding
// (`resume=%`) still parses into a non-empty, single-entry map keyed by nonsense text. Passed
// straight to `resumeAfterSeq`, that map is non-`undefined` for every real run, so each one falls
// through to the "unnamed run" branch (live-only) — malformed client input would silently suppress
// ALL buffered history, the exact under-delivery `parseResumeCursors`'s own contract forbids.
// A well-formed request that names at least one real run is unaffected: it still marks any other,
// truly unnamed run live-only (the deliberate #2456 optimization) because the match check below
// passes and the parsed map is returned unchanged.
function usableResumeCursors(
  cursors: ReadonlyMap<string, number> | undefined,
  records: readonly RunRecord[],
  attachable: (record: RunRecord) => boolean,
): ReadonlyMap<string, number> | undefined {
  if (cursors === undefined) return undefined;
  for (const record of records) {
    // The match must be a run this connection can actually attach to. An
    // id-only check would let a cursor naming ANOTHER session's run mark the
    // whole set usable, after which every accessible run the client did not
    // name attaches live-only and loses its buffered history — under-delivery
    // driven by a run the caller cannot even see.
    if (cursors.has(record.runId) && attachable(record)) return cursors;
  }
  return undefined;
}

interface ResumeAttachStats {
  resumedRuns: number;
  liveOnlyRuns: number;
  fullReplayRuns: number;
}

function recordResumeDecision(stats: ResumeAttachStats, afterSeq: number): void {
  if (afterSeq === Number.MAX_SAFE_INTEGER) {
    stats.liveOnlyRuns += 1;
  } else if (afterSeq >= 0) {
    stats.resumedRuns += 1;
  } else {
    stats.fullReplayRuns += 1;
  }
}

// Body-free evidence for the resume decision (ADR-0173): counts per attach class, never runIds.
// `cursorsUnusable` is only added (as `true`) when the request carried a `resume` parameter that
// yielded no usable pair, so a malformed-but-present request is distinguishable in the log from
// an ordinary, fully-honoured resume request — without changing the shape of the ordinary line.
// Repository-owner review finding on PR #3305 (P2): `RouteContext.correlationId` is optional, so a
// direct/internal handler composition can reach this line with none in scope. ADR-0173 requires
// every line of one logical operation to carry a correlation id, and names `UNKNOWN_CORRELATION_ID`
// (correlation.ts) as the only sanctioned fallback — resolve it here rather than omitting the field.
function logResumeDecision(
  correlationId: string | undefined,
  stats: ResumeAttachStats,
  cursorsUnusable: boolean,
): void {
  getServerLogger().info({
    category: "http",
    op: "sse.run-events.resume",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: { ...stats, ...(cursorsUnusable ? { cursorsUnusable: true } : {}) },
  });
}

// Attaches every snapshot run at its resume boundary, then logs the per-class attach counts once
// when (and only when) the connection actually carried a `resume` parameter — including when that
// parameter was present but unusable (`resume=`, `resume=,,`, or a parsed cursor set that names
// nothing in this snapshot — see `usableResumeCursors`), which still causes a full-replay burst and
// must not be indistinguishable in the log from a connection that never asked to resume.
function attachSnapshotRuns(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  attachRun: (record: RunRecord, afterSeq: number) => boolean,
): void {
  const resumeRequested = rawQueryParameter(ctx.url, "resume") !== undefined;
  const records = deps.registry.snapshot?.(AGGREGATE_RUN_EVENTS_SNAPSHOT_LIMIT) ?? [];
  const resumeCursors = usableResumeCursors(parseResumeCursors(ctx.url), records, (record) =>
    agentRecordSessionMatches(record, ctx, deps),
  );
  const stats: ResumeAttachStats = { resumedRuns: 0, liveOnlyRuns: 0, fullReplayRuns: 0 };
  for (const record of records) {
    const afterSeq = resumeAfterSeq(resumeCursors, record.runId);
    if (attachRun(record, afterSeq)) {
      recordResumeDecision(stats, afterSeq);
    }
  }
  if (resumeRequested) {
    logResumeDecision(ctx.correlationId, stats, resumeCursors === undefined);
  }
}

// Shared run-event stream for the desktop. It replays bounded buffers for recent records, then
// attaches to newly registered runs so multiple AgentRun windows do not consume one SSE slot each.
// Snapshot runs honour the optional `resume` cursors (#2456); runs registered AFTER connect keep
// full replay unconditionally — a new run's buffer is small and the client has no cursor for it.
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

  const attachRun = (record: RunRecord, afterSeq: number): boolean => {
    if (closed || detachByRunId.has(record.runId)) return false;
    if (!agentRecordSessionMatches(record, ctx, deps)) return false;
    const writer = aggregateRunWriter(record, ctx, deps, detachRun);
    const detach = record.sink.attach(writer, afterSeq);
    detachByRunId.set(record.runId, detach);
    if (record.sink.isTerminated()) {
      detachRun(record.runId);
    }
    return true;
  };

  attachSnapshotRuns(ctx, deps, attachRun);
  const unsubscribeRegistry =
    deps.registry.subscribe?.((record: RunRecord): void => {
      attachRun(record, -1);
    }) ?? ((): void => undefined);
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
      const accepted = writeMessageEvent(ctx.res, event, deps.redactor, ctx.correlationId);
      if (!accepted) {
        markSseStreamBackpressureKilled(ctx.res);
        ctx.res.destroy();
      }
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
  correlationId?: string,
): void {
  res.writeHead(200, SSE_HEADERS);
  startSseHeartbeat(res);
  const writer: SseWriter = {
    write: (event: StreamEvent): boolean => {
      const accepted = writeMessageEvent(res, event, redactor, correlationId);
      if (!accepted) {
        markSseStreamBackpressureKilled(res);
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
