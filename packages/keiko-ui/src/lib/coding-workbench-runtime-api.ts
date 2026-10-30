"use client";

import type {
  CodingWorkbenchMcpAuthorizationStart,
  CodingWorkbenchMcpAuthorizationStatus,
  CodingWorkbenchRuntimeMcpChannelPayload,
  CodingWorkbenchMode,
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchModelRefusalReason,
  CodingWorkbenchRuntimeApprovalDecisionRequest,
  CodingWorkbenchRuntimeApprovalReviewChannelPayload,
  CodingWorkbenchRuntimeFollowUpRequest,
  CodingWorkbenchRuntimeQuestionAnswerRequest,
  CodingWorkbenchRuntimeQuestionsChannelPayload,
  CodingWorkbenchRuntimeReadiness,
  CodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  CodingWorkbenchRuntimeResearchChannelPayload,
  CodingWorkbenchRuntimeResearchRevokeRequest,
  CodingWorkbenchRuntimeSkillsChannelPayload,
  CodingWorkbenchRuntimeResumeRequest,
  CodingWorkbenchRuntimeRetryRequest,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStartRequest,
  CodingWorkbenchRuntimeStopRequest,
  CodingWorkbenchRuntimeTakeoverRequest,
  CodingWorkbenchValidationResult,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { validateCodingWorkbenchRuntimeQuestionsChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-questions";
import {
  validateCodingWorkbenchRuntimeCommandsChannelPayload,
  validateCodingWorkbenchRuntimeInboxChannelPayload,
  validateCodingWorkbenchRuntimeReadiness,
  validateCodingWorkbenchRuntimeRevertChannelPayload,
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeSseEvent,
  type CodingWorkbenchRuntimeCommandsChannelPayload,
  type CodingWorkbenchRuntimeInboxChannelPayload,
  type CodingWorkbenchRuntimeInboxRequest,
  type CodingWorkbenchRuntimeRevertChannelPayload,
  type CodingWorkbenchRuntimeRevertRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { validateCodingWorkbenchRuntimeSkillsChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import { validateCodingWorkbenchRuntimeResearchChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-research";
import {
  isWorkbenchDescriptionDraftReview,
  type WorkbenchDescriptionDraftReview,
} from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
import {
  parseCodingWorkbenchMcpAuthorizationStart,
  parseCodingWorkbenchMcpAuthorizationStatus,
  parseCodingWorkbenchRuntimeMcpChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { ClientCodingRuntimeCall } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { ApiError } from "./api";
import { bffFetchJson, bffRequestErrorKind, newClientCorrelationId } from "./http";
import { repairLocalCodingAppSessionWithEvidence } from "./coding-app-session-client";
import { reportClientDiagnostic } from "./client-diagnostics";
import { reportCodingWorkbenchRequestTimeout } from "./coding-workbench-request-timeout";
import { createSameOriginApiEventSource } from "./safe-event-source";
import { runtimeIssueFailure, runtimeModelRefusal } from "./coding-workbench-issue-errors";
import { secureRandomId } from "./secure-random";

const RUNTIME_ROOT = "/api/coding-workbench/runtime";

// A request the BFF accepts but never answers would hold the serialized mutation queue and the run
// refresh join forever, taking away Stop/Approve/Deny (stability audit item 1). Every call kind has
// its own client-side deadline, set from what was measured (issue #4109: real Gemma through LiteLLM
// under shared load, warm models, n = 3..6 per call). A timeout is reported with its call kind and
// deadline (`client.coding-workbench.request-timed-out`), so each bound can be judged from the log.
//
// - status and snapshot reads: p50 3.5 ms / p95 6 ms mid-turn (idle p95 4 ms). 10 s is about 1,700x
//   the measured p95: a read that has not answered by then is hung, not slow.
// - Stop: p50 1,568 ms / p95 2,558 ms (it waits for the runtime to settle). 15 s is about 6x the
//   measured p95, and short enough that a hung Stop gives control back before a minute passes.
// - start: p50 4,029 ms / p95 4,591 ms for a WARM model. A cold model load and a cold OpenCode start
//   are not measured and a Start can wait on workspace preparation, so it keeps the longest bound
//   (180 s, about 39x the warm p95) rather than being cut off while it is making progress.
// - every other mutation (approve, deny, takeover, retry, recovery acknowledgement, pause, resume,
//   follow-up, undo, inbox, research revoke, question answers) is NOT measured, so it keeps the 60 s
//   bound it always had until a measurement justifies a tighter one.
const RUNTIME_STATUS_TIMEOUT_MS = 10_000;
const RUNTIME_STOP_TIMEOUT_MS = 15_000;
const RUNTIME_MUTATION_TIMEOUT_MS = 60_000;
const RUNTIME_START_TIMEOUT_MS = 180_000;

// Exhaustive over the closed report vocabulary: a new call kind cannot ship without a decision on
// its deadline.
const RUNTIME_CALL_DEADLINE_MS: Readonly<Record<ClientCodingRuntimeCall, number>> = {
  status: RUNTIME_STATUS_TIMEOUT_MS,
  snapshot: RUNTIME_STATUS_TIMEOUT_MS,
  start: RUNTIME_START_TIMEOUT_MS,
  stop: RUNTIME_STOP_TIMEOUT_MS,
  approval: RUNTIME_MUTATION_TIMEOUT_MS,
  takeover: RUNTIME_MUTATION_TIMEOUT_MS,
  retry: RUNTIME_MUTATION_TIMEOUT_MS,
  "recovery-ack": RUNTIME_MUTATION_TIMEOUT_MS,
  pause: RUNTIME_MUTATION_TIMEOUT_MS,
  resume: RUNTIME_MUTATION_TIMEOUT_MS,
  "follow-up": RUNTIME_MUTATION_TIMEOUT_MS,
  revert: RUNTIME_MUTATION_TIMEOUT_MS,
  inbox: RUNTIME_MUTATION_TIMEOUT_MS,
  "research-revoke": RUNTIME_MUTATION_TIMEOUT_MS,
  "question-answer": RUNTIME_MUTATION_TIMEOUT_MS,
  "question-reject": RUNTIME_MUTATION_TIMEOUT_MS,
};

/** The closed code of a request that hit its own deadline (see `codingWorkbenchRuntimeApiError`). */
export const RUNTIME_REQUEST_TIMEOUT_CODE = "CODING_RUNTIME_REQUEST_TIMEOUT";

function isDeadlineError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * Why a mutation's client wait ended without an answer: Stop took its place. The request may still
 * be applied by the server; the run state reconciles through the Stop answer or a re-read. It is
 * not a failure of the mutation and never a timeout, so nothing reports it as either.
 */
export class CodingWorkbenchPreemptedError extends Error {
  constructor() {
    super("The request was preempted by Stop.");
    this.name = "CodingWorkbenchPreemptedError";
  }
}

export function isCodingWorkbenchPreempted(error: unknown): error is CodingWorkbenchPreemptedError {
  return error instanceof CodingWorkbenchPreemptedError;
}

/**
 * Sends one runtime request under its call kind's deadline and the caller's own signal. The request
 * carries a correlation id minted here, so an expired deadline (which fails the request before any
 * response could carry an id) is still reported under the id the BFF would have logged it by. Only
 * the call's own deadline is a timeout: a caller's abort, a preemption and a server refusal are not.
 */
async function sendBounded<T>(
  call: ClientCodingRuntimeCall,
  callerSignal: AbortSignal | undefined,
  send: (signal: AbortSignal, correlationId: string) => Promise<T>,
  correlationId: string = newClientCorrelationId(),
): Promise<T> {
  const deadlineMs = RUNTIME_CALL_DEADLINE_MS[call];
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = callerSignal === undefined ? deadline : AbortSignal.any([callerSignal, deadline]);
  try {
    return await send(signal, correlationId);
  } catch (error) {
    if (deadline.aborted && isDeadlineError(error)) {
      reportCodingWorkbenchRequestTimeout(call, deadlineMs, correlationId);
    }
    throw error;
  }
}

export interface CodingWorkbenchRuntimeApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /**
   * The request correlation id for this failure when the transport carried one (RB-6). Surfaces on
   * mutation alerts as the copyable support id tying the visible failure to exactly one redacted
   * server-side diagnostic record — a rejected start must never be a dead button (F-09a).
   */
  readonly correlationId?: string;
  readonly issueBindingFailure?: CodingWorkbenchIssueBindingFailure;
  readonly modelRefusalReason?: CodingWorkbenchModelRefusalReason;
}

export function codingWorkbenchRuntimeApiError(error: unknown): CodingWorkbenchRuntimeApiError {
  if (error instanceof ApiError) {
    const issueBindingFailure = runtimeIssueFailure(error);
    const modelRefusalReason = runtimeModelRefusal(error);
    return {
      code: error.code,
      message: error.message,
      retryable:
        error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500,
      ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
      ...(issueBindingFailure === undefined ? {} : { issueBindingFailure }),
      ...(modelRefusalReason === undefined ? {} : { modelRefusalReason }),
    };
  }
  if (isDeadlineError(error)) {
    return {
      code: RUNTIME_REQUEST_TIMEOUT_CODE,
      message: "The runtime request did not answer in time.",
      retryable: true,
    };
  }
  return {
    code: "CODING_RUNTIME_CLIENT_ERROR",
    message: error instanceof Error ? error.message : "The runtime request failed.",
    retryable: true,
  };
}

export function codingWorkbenchFailureStatus(
  error: CodingWorkbenchRuntimeApiError,
): "unavailable" | "error" {
  return error.code.includes("UNAVAILABLE") ? "unavailable" : "error";
}

export function newCodingWorkbenchRuntimeRequestId(): string {
  return secureRandomId("ui");
}

export function codingWorkbenchRuntimeActionError(message: string): Error {
  return new ApiError("CODING_RUNTIME_ACTION_UNAVAILABLE", message, 409);
}

function validated<T>(
  path: string,
  value: unknown,
  validator: (candidate: unknown) => CodingWorkbenchValidationResult<T>,
): T {
  const result = validator(value);
  if (result.ok) return result.value;
  throw new ApiError(
    "CONTRACT_VALIDATION_FAILED",
    `BFF response for ${path} failed contract validation.`,
    502,
  );
}

function parsedOrRefused<T>(path: string, value: T | undefined): T {
  if (value !== undefined) return value;
  throw new ApiError(
    "CONTRACT_VALIDATION_FAILED",
    `BFF response for ${path} failed contract validation.`,
    502,
  );
}

function snapshotValidator(path: string, value: unknown): CodingWorkbenchRuntimeSnapshot {
  return validated(path, value, validateCodingWorkbenchRuntimeSnapshot);
}

function readinessValidator(path: string, value: unknown): CodingWorkbenchRuntimeReadiness {
  return validated(path, value, validateCodingWorkbenchRuntimeReadiness);
}

function questionsValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeQuestionsChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeQuestionsChannelPayload);
}

function researchChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeResearchChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeResearchChannelPayload);
}

function skillsChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeSkillsChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeSkillsChannelPayload);
}

function approvalReviewChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeApprovalReviewChannelPayload);
}

function revertChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeRevertChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeRevertChannelPayload);
}

function commandsChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeCommandsChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeCommandsChannelPayload);
}

function inboxChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeInboxChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeInboxChannelPayload);
}

export interface CodingWorkbenchDescriptionDraftResult {
  readonly outcome: "draft";
  readonly draft: WorkbenchDescriptionDraftReview;
}

function isDescriptionDraftResult(value: unknown): value is CodingWorkbenchDescriptionDraftResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.outcome === "draft" && isWorkbenchDescriptionDraftReview(result.draft);
}

function descriptionDraftValidator(
  proposalId: string,
  snapshotDigest: string,
  draftDigest: string,
): (path: string, value: unknown) => CodingWorkbenchDescriptionDraftResult {
  return (path, value): CodingWorkbenchDescriptionDraftResult => {
    if (
      isDescriptionDraftResult(value) &&
      value.draft.proposalId === proposalId &&
      value.draft.artifact.binding.snapshotDigest === snapshotDigest &&
      value.draft.artifact.artifactDigest === draftDigest
    ) {
      return value;
    }
    throw new ApiError(
      "CONTRACT_VALIDATION_FAILED",
      `BFF response for ${path} failed contract validation.`,
      502,
    );
  };
}

function runPath(runId: string, suffix = ""): string {
  return `${RUNTIME_ROOT}/runs/${encodeURIComponent(runId)}${suffix}`;
}

function enrichRuntimeIssueFailure(error: ApiError, envelope: unknown): void {
  const failure = runtimeIssueFailure(envelope);
  if (failure !== undefined) Object.assign(error, { issueBindingFailure: failure });
  const modelRefusalReason = runtimeModelRefusal(envelope);
  if (modelRefusalReason !== undefined) Object.assign(error, { modelRefusalReason });
  if (
    typeof envelope === "object" &&
    envelope !== null &&
    "preBodySessionDenied" in envelope &&
    envelope.preBodySessionDenied === true
  ) {
    Object.assign(error, { preBodySessionDenied: true });
  }
}

function postSnapshot<T>(
  call: ClientCodingRuntimeCall,
  path: string,
  body: T,
  signal?: AbortSignal,
  repairedCorrelationId?: string,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return sendBounded(
    call,
    signal,
    (deadline, correlationId) =>
      bffFetchJson(
        path,
        { method: "POST", cache: "no-store", body: JSON.stringify(body), signal: deadline },
        {
          validator: snapshotValidator,
          enrichError: enrichRuntimeIssueFailure,
          correlationId,
          ...(repairedCorrelationId === undefined ? {} : { repairSession: false }),
        },
      ),
    repairedCorrelationId,
  );
}

// The start route rejects a stale app session before reading the request body. Its distinct error
// code makes this one POST safe to repeat after the launcher-backed session has been repaired.
// Other mutation failures may have applied work and must never be replayed here.
function isPreBodyStartDenial(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === "CODING_RUNTIME_AUTHORITY_RESOLUTION_FAILED" &&
    "preBodySessionDenied" in error &&
    error.preBodySessionDenied === true
  );
}

async function retryStartAfterSessionRepair(
  input: CodingWorkbenchRuntimeStartRequest,
  denied: ApiError,
  signal: AbortSignal | undefined,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  const repair = await repairLocalCodingAppSessionWithEvidence(signal);
  signal?.throwIfAborted();
  const correlationId = denied.correlationId ?? newClientCorrelationId();
  const report = (outcome: "repair-failed" | "replayed" | "replay-failed"): void => {
    reportClientDiagnostic(`[keiko] coding start session repair: ${outcome}`, {
      correlationId,
      sessionRepairReport: {
        outcome,
        repairCorrelationId: repair.correlationId,
        ...(outcome === "repair-failed" && repair.errorKind !== undefined
          ? { errorKind: repair.errorKind }
          : {}),
      },
    });
  };
  if (!repair.repaired) {
    report("repair-failed");
    throw denied;
  }
  try {
    const snapshot = await postSnapshot(
      "start",
      `${RUNTIME_ROOT}/runs`,
      input,
      signal,
      correlationId,
    );
    report("replayed");
    return snapshot;
  } catch (error) {
    reportClientDiagnostic("[keiko] coding start session repair: replay-failed", {
      correlationId,
      sessionRepairReport: {
        outcome: "replay-failed",
        repairCorrelationId: repair.correlationId,
        errorKind: bffRequestErrorKind(error),
      },
    });
    throw error;
  }
}

/** The revision-bound envelope shared by every serialized inline runtime operation. */
export interface CodingWorkbenchRuntimeOperationRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
}

export interface CodingWorkbenchRuntimeQuestionRejectBody extends CodingWorkbenchRuntimeOperationRequest {
  readonly questionId: string;
}

/** The follow-up body is the shared wire contract, which also carries the optional primary agent. */
export type CodingWorkbenchRuntimeFollowUpBody = CodingWorkbenchRuntimeFollowUpRequest;

/** Pause binds to the run by id only; the server owns the transition guard. */
export interface CodingWorkbenchRuntimeLifecycleBody {
  readonly requestId: string;
}

export function getCodingWorkbenchRuntimeReadiness(
  requestedMode: CodingWorkbenchMode,
): Promise<CodingWorkbenchRuntimeReadiness> {
  const query = new URLSearchParams({ requestedMode });
  return bffFetchJson(
    `${RUNTIME_ROOT}/readiness?${query.toString()}`,
    { cache: "no-store" },
    {
      validator: readinessValidator,
    },
  );
}

export function getCodingWorkbenchRuntimeStatus(): Promise<CodingWorkbenchRuntimeSnapshot> {
  return sendBounded("status", undefined, (signal, correlationId) =>
    bffFetchJson(
      `${RUNTIME_ROOT}/status`,
      { cache: "no-store", signal },
      { validator: snapshotValidator, correlationId },
    ),
  );
}

export function getCodingWorkbenchRuntimeSnapshot(
  runId: string,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return sendBounded("snapshot", undefined, (signal, correlationId) =>
    bffFetchJson(
      runPath(runId),
      { cache: "no-store", signal },
      { validator: snapshotValidator, correlationId },
    ),
  );
}

// `signal` is the queue's preemption signal: Stop aborts the wait of a mutation it takes the place
// of (#4109). Every mutation below takes one and joins it to its own deadline.
/** A run-scoped lifecycle POST: every one validates and returns the run's snapshot. */
function runSnapshotPost<Body>(
  call: ClientCodingRuntimeCall,
  suffix: string,
): (runId: string, input: Body, signal?: AbortSignal) => Promise<CodingWorkbenchRuntimeSnapshot> {
  return (runId, input, signal) => postSnapshot(call, runPath(runId, suffix), input, signal);
}

export async function startCodingWorkbenchRuntime(
  input: CodingWorkbenchRuntimeStartRequest,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  try {
    return await postSnapshot("start", `${RUNTIME_ROOT}/runs`, input, signal);
  } catch (error) {
    if (!isPreBodyStartDenial(error)) throw error;
    return retryStartAfterSessionRepair(input, error, signal);
  }
}

export const decideCodingWorkbenchRuntimeApproval =
  runSnapshotPost<CodingWorkbenchRuntimeApprovalDecisionRequest>("approval", "/approvals");

// The server refuses a stop whose `requestId` is not the run id (`isEndRequestConsistent`).
export const stopCodingWorkbenchRuntime = runSnapshotPost<CodingWorkbenchRuntimeStopRequest>(
  "stop",
  "/stop",
);

// Likewise for a takeover: `requestId` must equal `runId`.
export const takeOverCodingWorkbenchRuntime =
  runSnapshotPost<CodingWorkbenchRuntimeTakeoverRequest>("takeover", "/takeover");

export const retryCodingWorkbenchRuntime = runSnapshotPost<CodingWorkbenchRuntimeRetryRequest>(
  "retry",
  "/retry",
);

export const acknowledgeCodingWorkbenchRuntimeRecovery =
  runSnapshotPost<CodingWorkbenchRuntimeRecoveryAcknowledgementRequest>(
    "recovery-ack",
    "/recovery-ack",
  );

export const pauseCodingWorkbenchRuntime = runSnapshotPost<CodingWorkbenchRuntimeLifecycleBody>(
  "pause",
  "/pause",
);

export const resumeCodingWorkbenchRuntime = runSnapshotPost<CodingWorkbenchRuntimeResumeRequest>(
  "resume",
  "/resume",
);

export const submitCodingWorkbenchRuntimeFollowUp =
  runSnapshotPost<CodingWorkbenchRuntimeFollowUpBody>("follow-up", "/follow-up");

/**
 * Undo the run's newest turn or restore an undo (B3, S04). The server stops the turn in flight, if
 * any, and restores the workspace files that turn changed; the run stays live until it is stopped.
 */
export const revertCodingWorkbenchRuntime = runSnapshotPost<CodingWorkbenchRuntimeRevertRequest>(
  "revert",
  "/revert",
);

/**
 * Reads what an undo would do or has done over the authenticated app-session channel: counts only,
 * never a path. Absent `revert` means the run offers no undo; an unpaired window receives the
 * constant `{ session: "unpaired" }` projection instead of an error.
 */
export function getCodingWorkbenchRuntimeRevertState(
  runId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeRevertChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/revert"),
    { cache: "no-store", ...(signal ? { signal } : {}) },
    { validator: revertChannelValidator },
  );
}

/**
 * Lists the slash commands a live run's runtime offers over the authenticated app-session channel
 * (ADR-0137 D10). The names and descriptions are runtime-authored display text, bounded by the
 * contract validator. Absent `commands` means the run offers none or could not list them; an
 * unpaired window receives the constant `{ session: "unpaired" }` projection instead of an error.
 */
export function fetchCodingWorkbenchRuntimeCommands(
  runId: string,
  init?: { readonly signal?: AbortSignal | undefined },
): Promise<CodingWorkbenchRuntimeCommandsChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/commands"),
    { cache: "no-store", ...(init?.signal ? { signal: init.signal } : {}) },
    { validator: commandsChannelValidator },
  );
}

/**
 * Lists a live native run's MCP servers over the authenticated app-session channel (#3903 AC3):
 * each admitted server's name, a closed status and whether it authorizes through OAuth. Absent
 * `servers` means the run offers none; an unpaired window receives `{ session: "unpaired" }`.
 */
export function fetchCodingWorkbenchRuntimeMcp(
  runId: string,
  init?: { readonly signal?: AbortSignal | undefined },
): Promise<CodingWorkbenchRuntimeMcpChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/mcp"),
    { cache: "no-store", ...(init?.signal ? { signal: init.signal } : {}) },
    {
      validator: (path, value) =>
        parsedOrRefused(path, parseCodingWorkbenchRuntimeMcpChannelPayload(value)),
    },
  );
}

/**
 * Starts the runtime's own OAuth authorization of one MCP server. The server answers with an
 * authorization URL only once it addresses the validated endpoint of the operator's expected issuer;
 * the human opens it in their browser and the runtime's loopback callback completes the attempt.
 */
export function startCodingWorkbenchMcpAuthorization(
  runId: string,
  server: string,
): Promise<CodingWorkbenchMcpAuthorizationStart> {
  return bffFetchJson(
    runPath(runId, "/mcp/authorization"),
    { method: "POST", cache: "no-store", body: JSON.stringify({ server }) },
    {
      validator: (path, value) =>
        parsedOrRefused(path, parseCodingWorkbenchMcpAuthorizationStart(value)),
    },
  );
}

/** Reads, or with `cancel` abandons, an authorization attempt started for `server`. */
export function readCodingWorkbenchMcpAuthorization(
  runId: string,
  request: { readonly server: string; readonly attemptId: string },
  cancel = false,
): Promise<CodingWorkbenchMcpAuthorizationStatus> {
  return bffFetchJson(
    runPath(runId, cancel ? "/mcp/authorization/cancel" : "/mcp/authorization/status"),
    { method: "POST", cache: "no-store", body: JSON.stringify(request) },
    {
      validator: (path, value) =>
        parsedOrRefused(path, parseCodingWorkbenchMcpAuthorizationStatus(value)),
    },
  );
}

/**
 * Withdraw a message waiting for the running turn, or change a queued one to Send now (S07, ADR-0137
 * D10). Bound to the observed revision like a follow-up; the server proves the message is one the
 * operator delivered into this turn and answers one the runtime already took as delivered.
 */
export const submitCodingWorkbenchRuntimeInboxAction =
  runSnapshotPost<CodingWorkbenchRuntimeInboxRequest>("inbox", "/inbox");

/**
 * Reads the messages still waiting for the running turn over the authenticated app-session channel:
 * the id, the delivery and the operator's own one-line preview, in the order the model receives
 * them. Absent `items` means the run offers none; an unpaired window receives the constant
 * `{ session: "unpaired" }` projection instead of an error.
 */
export function fetchCodingWorkbenchRuntimeInbox(
  runId: string,
  init?: { readonly signal?: AbortSignal | undefined },
): Promise<CodingWorkbenchRuntimeInboxChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/inbox"),
    { cache: "no-store", ...(init?.signal ? { signal: init.signal } : {}) },
    { validator: inboxChannelValidator },
  );
}

/**
 * Revoke the live internet research grant. The server drops the grant for the parent run and every
 * child in one revision bump; general runtime snapshots never carry grant content (#2644).
 */
export const revokeCodingWorkbenchRuntimeResearchGrant =
  runSnapshotPost<CodingWorkbenchRuntimeResearchRevokeRequest>(
    "research-revoke",
    "/research/revoke",
  );

/**
 * Read pending and approved research state over the authenticated app-session channel. Both the
 * proposed and granted domains are model-selected content and therefore never ride the general
 * runtime snapshot (#2387, #2644).
 */
export function getCodingWorkbenchRuntimeResearch(
  runId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeResearchChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/research"),
    { cache: "no-store", ...(signal ? { signal } : {}) },
    { validator: researchChannelValidator },
  );
}

/**
 * Read the approved skills of a run over the authenticated app-session channel (#3417): every
 * approved skill with the readiness the catalog can tell. The record is closed and body-free, and an
 * unpaired browser receives the constant re-pair projection instead.
 */
export function getCodingWorkbenchRuntimeSkills(
  runId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeSkillsChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/skills"),
    { cache: "no-store", ...(signal ? { signal } : {}) },
    { validator: skillsChannelValidator },
  );
}

/**
 * Read the reviewable facts of the pending edit approval over the authenticated app-session channel
 * (#2802): which workspace-relative files it would write and how large the change is. The paths are
 * model-selected content and therefore never ride the general runtime snapshot (#2644); no patch
 * bytes and no model prose cross this boundary. An unpaired window receives the constant
 * `{ session: "unpaired" }` projection instead of an error.
 */
export function getCodingWorkbenchRuntimeApprovalReview(
  runId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeApprovalReviewChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/approval-review"),
    { cache: "no-store", ...(signal ? { signal } : {}) },
    { validator: approvalReviewChannelValidator },
  );
}

/** Reads the exact transient server-held draft for a generic run with no pull-request target. */
export function getCodingWorkbenchRuntimeDescriptionDraft(
  runId: string,
  proposalId: string,
  snapshotDigest: string,
  draftDigest: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchDescriptionDraftResult> {
  const query = new URLSearchParams({ proposalId, snapshotDigest });
  const path = `${runPath(runId, "/description-draft")}?${query.toString()}`;
  return bffFetchJson(
    path,
    { cache: "no-store", ...(signal ? { signal } : {}) },
    { validator: descriptionDraftValidator(proposalId, snapshotDigest, draftDigest) },
  );
}

/**
 * List the run's required questions over the authenticated app-session channel (#2478). The server
 * keeps the run revision unchanged because listing is a read. An unpaired window receives the
 * constant content-free
 * `{ session: "unpaired", questions: [] }` projection instead of an error.
 */
export function listCodingWorkbenchRuntimeQuestions(
  runId: string,
  input: CodingWorkbenchRuntimeOperationRequest,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeQuestionsChannelPayload> {
  return bffFetchJson(
    runPath(runId, "/questions"),
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    },
    { validator: questionsValidator },
  );
}

// The answer body imports the contract type directly (epic #3384 defect A) rather than
// re-declaring the requestId/expectedRevision/questionId/answers shape locally: the server route
// parses this exact wire body with parseCodingWorkbenchRuntimeQuestionAnswerRequest, so there is
// exactly one definition of what an answer looks like, not two that can drift apart.
export const answerCodingWorkbenchRuntimeQuestion =
  runSnapshotPost<CodingWorkbenchRuntimeQuestionAnswerRequest>(
    "question-answer",
    "/questions/answer",
  );

export const rejectCodingWorkbenchRuntimeQuestion =
  runSnapshotPost<CodingWorkbenchRuntimeQuestionRejectBody>("question-reject", "/questions/reject");

export function createCodingWorkbenchRuntimeEventSource(
  runId: string,
  cursor?: string,
): EventSource {
  const suffix =
    cursor === undefined || cursor.length === 0
      ? "/events"
      : `/events?cursor=${encodeURIComponent(cursor)}`;
  const source = createSameOriginApiEventSource(runPath(runId, suffix));
  if (source !== null) return source;
  throw new ApiError(
    "CODING_RUNTIME_STREAM_UNAVAILABLE",
    "The runtime event stream is unavailable in this browser context.",
    0,
  );
}

export function parseCodingWorkbenchRuntimeEvent(data: string): CodingWorkbenchRuntimeSseEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ApiError(
      "CODING_RUNTIME_STREAM_INVALID",
      "The runtime event stream returned an invalid event.",
      502,
    );
  }
  return validated("runtime event stream", value, validateCodingWorkbenchRuntimeSseEvent);
}
