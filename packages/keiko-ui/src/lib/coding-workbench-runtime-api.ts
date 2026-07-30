"use client";

import {
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
  validateCodingWorkbenchRuntimeQuestionsChannelPayload,
  validateCodingWorkbenchRuntimeReadiness,
  validateCodingWorkbenchRuntimeResearchChannelPayload,
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeSseEvent,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeApprovalDecisionRequest,
  type CodingWorkbenchRuntimeApprovalReviewChannelPayload,
  type CodingWorkbenchRuntimeQuestionsChannelPayload,
  type CodingWorkbenchRuntimeReadiness,
  type CodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  type CodingWorkbenchRuntimeResearchChannelPayload,
  type CodingWorkbenchRuntimeResearchRevokeRequest,
  type CodingWorkbenchRuntimeRetryRequest,
  type CodingWorkbenchRuntimeSnapshot,
  type CodingWorkbenchRuntimeSseEvent,
  type CodingWorkbenchRuntimeStartRequest,
  type CodingWorkbenchRuntimeStopRequest,
  type CodingWorkbenchRuntimeTakeoverRequest,
  type CodingWorkbenchValidationResult,
} from "@oscharko-dev/keiko-contracts";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";
import { createSameOriginApiEventSource } from "./safe-event-source";
import { secureRandomId } from "./secure-random";

const RUNTIME_ROOT = "/api/coding-workbench/runtime";

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
}

export function codingWorkbenchRuntimeApiError(error: unknown): CodingWorkbenchRuntimeApiError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable:
        error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500,
      ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
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

function approvalReviewChannelValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  return validated(path, value, validateCodingWorkbenchRuntimeApprovalReviewChannelPayload);
}

function runPath(runId: string, suffix = ""): string {
  return `${RUNTIME_ROOT}/runs/${encodeURIComponent(runId)}${suffix}`;
}

function postSnapshot<T>(
  path: string,
  body: T,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return bffFetchJson(
    path,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
    { validator: snapshotValidator },
  );
}

/** The revision-bound envelope shared by every serialized inline runtime operation. */
export interface CodingWorkbenchRuntimeOperationRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
}

export interface CodingWorkbenchRuntimeQuestionAnswerBody extends CodingWorkbenchRuntimeOperationRequest {
  readonly questionId: string;
  readonly answers: readonly (readonly string[])[];
}

export interface CodingWorkbenchRuntimeQuestionRejectBody extends CodingWorkbenchRuntimeOperationRequest {
  readonly questionId: string;
}

export interface CodingWorkbenchRuntimeFollowUpBody extends CodingWorkbenchRuntimeOperationRequest {
  readonly taskIntent: string;
}

/** Pause and resume bind to the run by id only; the server owns the transition guard. */
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
    { cache: "no-store" },
    {
      validator: snapshotValidator,
    },
  );
}

export function getCodingWorkbenchRuntimeSnapshot(
  runId: string,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return bffFetchJson(runPath(runId), { cache: "no-store" }, { validator: snapshotValidator });
}

export function startCodingWorkbenchRuntime(
  input: CodingWorkbenchRuntimeStartRequest,
): Promise<CodingWorkbenchRuntimeSnapshot> {
  return postSnapshot(`${RUNTIME_ROOT}/runs`, input);
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
  input: CodingWorkbenchRuntimeLifecycleBody,
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
 * Read the reviewable facts of the pending edit approval over the authenticated app-session channel
 * (#2853): which workspace-relative files it would write and how large the change is. The paths are
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

export function answerCodingWorkbenchRuntimeQuestion(
  runId: string,
  input: CodingWorkbenchRuntimeQuestionAnswerBody,
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

export function createCodingWorkbenchRuntimeEventSource(runId: string): EventSource {
  const source = createSameOriginApiEventSource(runPath(runId, "/events"));
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
