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
import { ApiError } from "./api";
import { bffFetchJson, bffRequestErrorKind, newClientCorrelationId } from "./http";
import { repairLocalCodingAppSessionWithEvidence } from "./coding-app-session-client";
import { reportClientDiagnostic } from "./client-diagnostics";
import { createSameOriginApiEventSource } from "./safe-event-source";
import { runtimeIssueFailure, runtimeModelRefusal } from "./coding-workbench-issue-errors";
import { secureRandomId } from "./secure-random";

const RUNTIME_ROOT = "/api/coding-workbench/runtime";

// A request the BFF accepts but never answers would hold the serialized mutation queue and the run
// refresh join forever, taking away Stop/Approve/Deny (stability audit item 1). The bounds are
// generous: a Start can legitimately wait on workspace preparation, so it gets the longest one.
const RUNTIME_STATUS_TIMEOUT_MS = 20_000;
const RUNTIME_MUTATION_TIMEOUT_MS = 60_000;
const RUNTIME_START_TIMEOUT_MS = 180_000;

function withRuntimeDeadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

function isDeadlineError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
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
      code: "CODING_RUNTIME_REQUEST_TIMEOUT",
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
  path: string,
  body: T,
  signal?: AbortSignal,
  repairedCorrelationId?: string,
  timeoutMs: number = RUNTIME_MUTATION_TIMEOUT_MS,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return bffFetchJson(
    path,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
      signal: withRuntimeDeadline(timeoutMs, signal),
    },
    {
      validator: snapshotValidator,
      enrichError: enrichRuntimeIssueFailure,
      ...(repairedCorrelationId === undefined
        ? {}
        : { correlationId: repairedCorrelationId, repairSession: false }),
    },
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
): Promise<CodingWorkbenchRuntimeSnapshot> {
  const repair = await repairLocalCodingAppSessionWithEvidence();
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
      `${RUNTIME_ROOT}/runs`,
      input,
      undefined,
      correlationId,
      RUNTIME_START_TIMEOUT_MS,
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
  return bffFetchJson(
    `${RUNTIME_ROOT}/status`,
    { cache: "no-store", signal: AbortSignal.timeout(RUNTIME_STATUS_TIMEOUT_MS) },
    {
      validator: snapshotValidator,
    },
  );
}

export function getCodingWorkbenchRuntimeSnapshot(
  runId: string,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return bffFetchJson(
    runPath(runId),
    { cache: "no-store", signal: AbortSignal.timeout(RUNTIME_STATUS_TIMEOUT_MS) },
    { validator: snapshotValidator },
  );
}

export async function startCodingWorkbenchRuntime(
  input: CodingWorkbenchRuntimeStartRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  try {
    return await postSnapshot(
      `${RUNTIME_ROOT}/runs`,
      input,
      undefined,
      undefined,
      RUNTIME_START_TIMEOUT_MS,
    );
  } catch (error) {
    if (!isPreBodyStartDenial(error)) throw error;
    return retryStartAfterSessionRepair(input, error);
  }
}

export function decideCodingWorkbenchRuntimeApproval(
  runId: string,
  input: CodingWorkbenchRuntimeApprovalDecisionRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/approvals"), input);
}

export function stopCodingWorkbenchRuntime(
  runId: string,
  input: CodingWorkbenchRuntimeStopRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/stop"), input);
}

export function takeOverCodingWorkbenchRuntime(
  runId: string,
  input: CodingWorkbenchRuntimeTakeoverRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/takeover"), input);
}

export function retryCodingWorkbenchRuntime(
  runId: string,
  input: CodingWorkbenchRuntimeRetryRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/retry"), input);
}

export function acknowledgeCodingWorkbenchRuntimeRecovery(
  runId: string,
  input: CodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/recovery-ack"), input);
}

export function pauseCodingWorkbenchRuntime(
  runId: string,
  input: CodingWorkbenchRuntimeLifecycleBody,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/pause"), input);
}

export function resumeCodingWorkbenchRuntime(
  runId: string,
  input: CodingWorkbenchRuntimeResumeRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/resume"), input);
}

export function submitCodingWorkbenchRuntimeFollowUp(
  runId: string,
  input: CodingWorkbenchRuntimeFollowUpBody,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/follow-up"), input);
}

/**
 * Undo the run's newest turn or restore an undo (B3, S04). The server stops the turn in flight, if
 * any, and restores the workspace files that turn changed; the run stays live until it is stopped.
 */
export function revertCodingWorkbenchRuntime(
  runId: string,
  input: CodingWorkbenchRuntimeRevertRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/revert"), input);
}

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
export function submitCodingWorkbenchRuntimeInboxAction(
  runId: string,
  input: CodingWorkbenchRuntimeInboxRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/inbox"), input);
}

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
export function revokeCodingWorkbenchRuntimeResearchGrant(
  runId: string,
  input: CodingWorkbenchRuntimeResearchRevokeRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/research/revoke"), input);
}

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
export function answerCodingWorkbenchRuntimeQuestion(
  runId: string,
  input: CodingWorkbenchRuntimeQuestionAnswerRequest,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/questions/answer"), input, signal);
}

export function rejectCodingWorkbenchRuntimeQuestion(
  runId: string,
  input: CodingWorkbenchRuntimeQuestionRejectBody,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(runPath(runId, "/questions/reject"), input, signal);
}

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
