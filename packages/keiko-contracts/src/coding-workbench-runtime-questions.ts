import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { isCodeTaskQuestionId } from "./code-task-governance.js";
import { CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS } from "./coding-workbench-runtime-api.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  result,
  validateSafeId,
  validateUntrustedDisplayText,
} from "./coding-workbench-runtime-api-validation.js";

export const CODING_WORKBENCH_RUNTIME_QUESTION_REQUEST_MAX_COUNT = 256;
export const CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_COUNT = 32;
export const CODING_WORKBENCH_RUNTIME_QUESTION_OPTIONS_MAX_COUNT = 32;
export const CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS = 4_096;
export const CODING_WORKBENCH_RUNTIME_QUESTION_HEADER_MAX_CHARS = 30;
export const CODING_WORKBENCH_RUNTIME_QUESTION_OPTION_LABEL_MAX_CHARS = 256;
export const CODING_WORKBENCH_RUNTIME_QUESTION_ANSWERS_MAX_COUNT = 32;
export const CODING_WORKBENCH_RUNTIME_QUESTION_SELECTIONS_MAX_COUNT = 32;
export const CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES = 64 * 1_024;

export interface CodingWorkbenchRuntimeQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface CodingWorkbenchRuntimeQuestion {
  /** Untrusted runtime text for transient browser rendering only. */
  readonly question: string;
  /** Untrusted runtime text for transient browser rendering only. */
  readonly header: string;
  readonly options: readonly CodingWorkbenchRuntimeQuestionOption[];
  readonly multiple?: boolean | undefined;
  readonly custom?: boolean | undefined;
}

export interface CodingWorkbenchRuntimeQuestionRequest {
  readonly id: string;
  readonly questions: readonly CodingWorkbenchRuntimeQuestion[];
}

export interface CodingWorkbenchRuntimeQuestionsResponse {
  readonly questions: readonly CodingWorkbenchRuntimeQuestionRequest[];
}

/**
 * Bound to the observed revision and the exact question-request id, matching the
 * approval-decision and research-revoke request contracts (KEIKO-0411): a stale or forged answer
 * fails closed the same way a stale or forged revoke does. `questionRequestId` is the `que_...`
 * id the question surface already mints (see `isCodeTaskQuestionId` in code-task-governance.ts),
 * carried back on the answer.
 */
export interface CodingWorkbenchRuntimeQuestionAnswerRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly questionRequestId: string;
  readonly answers: readonly (readonly string[])[];
}

/** Session facet of a channel-carried question payload: the status of the presented cookie only. */
export const CODING_WORKBENCH_RUNTIME_QUESTIONS_SESSION_STATES = ["active", "unpaired"] as const;

export type CodingWorkbenchRuntimeQuestionsSession =
  (typeof CODING_WORKBENCH_RUNTIME_QUESTIONS_SESSION_STATES)[number];

/**
 * The question payload as carried over the authenticated app-session channel (#2478, ADR-0141).
 * `session` reflects only whether the caller's own presented cookie is a valid app session — never
 * the existence of runs, questions, or anyone else's session — so the browser can render an honest
 * re-pair state instead of a silent empty list. The question bounds are unchanged from
 * `CodingWorkbenchRuntimeQuestionsResponse`; an `unpaired` payload is content-free by construction.
 */
export interface CodingWorkbenchRuntimeQuestionsChannelPayload {
  readonly session: CodingWorkbenchRuntimeQuestionsSession;
  readonly questions: readonly CodingWorkbenchRuntimeQuestionRequest[];
}

/**
 * The single source of the constant content-free projection every unauthenticated caller of the
 * question routes receives (ADR-0141 D6): independent of run existence, runtime configuration, and
 * pending-question state, so it is not an existence oracle.
 */
export function unpairedCodingWorkbenchRuntimeQuestionsChannelPayload(): CodingWorkbenchRuntimeQuestionsChannelPayload {
  return { session: "unpaired", questions: [] };
}

export function parseCodingWorkbenchRuntimeQuestionAnswerRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionAnswerRequest> {
  if (!isRecord(value)) return invalid("question answer must be an object");
  const errors = exactKeys(
    value,
    ["requestId", "expectedRevision", "questionRequestId", "answers"],
    "questionAnswer",
  );
  validateSafeId(value.requestId, "requestId", errors, CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS);
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    errors.push("expectedRevision must be a non-negative safe integer");
  }
  if (!isCodeTaskQuestionId(value.questionRequestId)) errors.push("questionRequestId is invalid");
  validateAnswers(value.answers, errors);
  return result(value, errors);
}

export function validateCodingWorkbenchRuntimeQuestionsResponse(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsResponse> {
  if (!isRecord(value)) return invalid("questions response must be an object");
  const errors = exactKeys(value, ["questions"], "questionsResponse");
  checkBoundedQuestionRequests(value.questions, value, errors);
  return result(value, errors);
}

/**
 * Validate a channel-carried question payload (#2478): exact keys, a valid session facet, the
 * unchanged question bounds, and the invariant that an `unpaired` payload carries no questions.
 */
export function validateCodingWorkbenchRuntimeQuestionsChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsChannelPayload> {
  if (!isRecord(value)) return invalid("questions channel payload must be an object");
  const errors = exactKeys(value, ["session", "questions"], "questionsChannelPayload");
  if (!isOneOf(value.session, CODING_WORKBENCH_RUNTIME_QUESTIONS_SESSION_STATES)) {
    errors.push("questionsChannelPayload.session is invalid");
  }
  if (
    value.session === "unpaired" &&
    (!Array.isArray(value.questions) || value.questions.length > 0)
  ) {
    errors.push("questionsChannelPayload.questions must be empty when the session is unpaired");
  }
  checkBoundedQuestionRequests(value.questions, value, errors);
  return result(value, errors);
}

/** Shared question-request bounds: array cap, per-request structure, and the aggregate byte budget. */
function checkBoundedQuestionRequests(
  questions: unknown,
  container: object,
  errors: string[],
): void {
  if (
    !Array.isArray(questions) ||
    questions.length > CODING_WORKBENCH_RUNTIME_QUESTION_REQUEST_MAX_COUNT
  ) {
    errors.push("questions must be a bounded array");
    return;
  }
  validateQuestionRequests(questions, errors);
  if (
    errors.length === 0 &&
    serializedBytes(container) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES
  ) {
    errors.push("questions response exceeds the aggregate UTF-8 byte budget");
  }
}

function validateQuestionRequests(values: readonly unknown[], errors: string[]): void {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    const path = `questions[${String(index)}]`;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    errors.push(...exactKeys(value, ["id", "questions"], path));
    if (!isCodeTaskQuestionId(value.id)) errors.push(`${path}.id is invalid`);
    else if (ids.has(value.id)) errors.push("question request ids must be unique");
    else ids.add(value.id);
    validateQuestions(value.questions, path, errors);
  });
}

function validateQuestions(value: unknown, path: string, errors: string[]): void {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_COUNT
  ) {
    errors.push(`${path}.questions must be a bounded non-empty array`);
    return;
  }
  value.forEach((question, index) => {
    validateQuestion(question, `${path}.questions[${String(index)}]`, errors);
  });
}

function validateQuestion(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["question", "header", "options", "multiple", "custom"], path));
  validateText(
    value.question,
    `${path}.question`,
    CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
    errors,
  );
  validateText(
    value.header,
    `${path}.header`,
    CODING_WORKBENCH_RUNTIME_QUESTION_HEADER_MAX_CHARS,
    errors,
  );
  validateOptions(value.options, path, errors);
  for (const flag of ["multiple", "custom"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") {
      errors.push(`${path}.${flag} must be a boolean`);
    }
  }
}

function validateOptions(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_WORKBENCH_RUNTIME_QUESTION_OPTIONS_MAX_COUNT) {
    errors.push(`${path}.options must be a bounded array`);
    return;
  }
  const labels = new Set<string>();
  value.forEach((option, index) => {
    const optionPath = `${path}.options[${String(index)}]`;
    if (!isRecord(option)) {
      errors.push(`${optionPath} must be an object`);
      return;
    }
    errors.push(...exactKeys(option, ["label", "description"], optionPath));
    validateText(
      option.label,
      `${optionPath}.label`,
      CODING_WORKBENCH_RUNTIME_QUESTION_OPTION_LABEL_MAX_CHARS,
      errors,
    );
    validateText(
      option.description,
      `${optionPath}.description`,
      CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
      errors,
    );
    if (typeof option.label === "string") {
      if (labels.has(option.label)) errors.push(`${path}.option labels must be unique`);
      labels.add(option.label);
    }
  });
}

function validateAnswers(value: unknown, errors: string[]): void {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CODING_WORKBENCH_RUNTIME_QUESTION_ANSWERS_MAX_COUNT
  ) {
    errors.push("answers must be a bounded non-empty array");
    return;
  }
  value.forEach((answer, index) => {
    const valid =
      Array.isArray(answer) &&
      answer.length <= CODING_WORKBENCH_RUNTIME_QUESTION_SELECTIONS_MAX_COUNT &&
      answer.every((selection) =>
        validText(selection, CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS),
      );
    if (!valid) errors.push(`answers[${String(index)}] must contain bounded strings`);
    else if (new Set(answer).size !== answer.length)
      errors.push(`answers[${String(index)}] must not contain duplicate selections`);
  });
  // Per-array caps above bound each answer individually (32 arrays x 32 selections x 4096 chars),
  // but not their sum: matches the aggregate budget checkBoundedQuestionRequests already enforces
  // on the outbound side, gated on no per-item error the same way that function gates its own check.
  if (
    errors.length === 0 &&
    serializedBytes({ answers: value }) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES
  ) {
    errors.push("answers exceed the aggregate UTF-8 byte budget");
  }
}

function validateText(value: unknown, path: string, max: number, errors: string[]): void {
  if (!validText(value, max)) errors.push(`${path} must be a bounded non-empty string`);
}

function validText(value: unknown, max: number): value is string {
  return validateUntrustedDisplayText(value, max);
}

function serializedBytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
