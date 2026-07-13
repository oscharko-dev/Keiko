"use client";

import {
  validateCodingWorkbenchRuntimeQuestionAcceptedResponse,
  validateCodingWorkbenchRuntimeReadiness,
  validateCodingWorkbenchRuntimeQuestionsResponse,
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeSseEvent,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeApprovalDecisionRequest,
  type CodingWorkbenchRuntimeQuestionAcceptedResponse,
  type CodingWorkbenchRuntimeQuestionAnswerRequest,
  type CodingWorkbenchRuntimeReadiness,
  type CodingWorkbenchRuntimeQuestionsResponse,
  type CodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
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

const RUNTIME_ROOT = "/api/coding-workbench/runtime";

export interface CodingWorkbenchRuntimeApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function codingWorkbenchRuntimeApiError(error: unknown): CodingWorkbenchRuntimeApiError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      retryable:
        error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500,
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
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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

function questionsValidator(path: string, value: unknown): CodingWorkbenchRuntimeQuestionsResponse {
  return validated(path, value, validateCodingWorkbenchRuntimeQuestionsResponse);
}

function questionAcceptedValidator(
  path: string,
  value: unknown,
): CodingWorkbenchRuntimeQuestionAcceptedResponse {
  return validated(path, value, validateCodingWorkbenchRuntimeQuestionAcceptedResponse);
}

function runPath(runId: string, suffix = ""): string {
  return `${RUNTIME_ROOT}/runs/${encodeURIComponent(runId)}${suffix}`;
}

function questionPath(runId: string, questionId: string, action: "answer" | "reject"): string {
  return runPath(runId, `/questions/${encodeURIComponent(questionId)}/${action}`);
}

function postQuestion(
  path: string,
  body: CodingWorkbenchRuntimeQuestionAnswerRequest | Record<string, never>,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeQuestionAcceptedResponse> {
  return bffFetchJson(
    path,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    },
    { validator: questionAcceptedValidator },
  );
}

function postSnapshot<T>(path: string, body: T): Promise<CodingWorkbenchRuntimeSnapshot> {
  return bffFetchJson(
    path,
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
    },
    { validator: snapshotValidator },
  );
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

export function getCodingWorkbenchRuntimeQuestions(
  runId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeQuestionsResponse> {
  return bffFetchJson(
    runPath(runId, "/questions"),
    { cache: "no-store", ...(signal === undefined ? {} : { signal }) },
    { validator: questionsValidator },
  );
}

export function answerCodingWorkbenchRuntimeQuestion(
  runId: string,
  questionId: string,
  input: CodingWorkbenchRuntimeQuestionAnswerRequest,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeQuestionAcceptedResponse> {
  return postQuestion(questionPath(runId, questionId, "answer"), input, signal);
}

export function rejectCodingWorkbenchRuntimeQuestion(
  runId: string,
  questionId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchRuntimeQuestionAcceptedResponse> {
  return postQuestion(questionPath(runId, questionId, "reject"), {}, signal);
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
