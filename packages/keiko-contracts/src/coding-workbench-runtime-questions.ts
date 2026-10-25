import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { isCodeTaskQuestionId } from "./code-task-governance.js";
import { CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS } from "./coding-workbench-runtime-api.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  validateCodingPhysicalMembers,
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
 * fails closed the same way a stale or forged revoke does. `questionId` is the `que_...` id the
 * question surface already mints (see `isCodeTaskQuestionId` in code-task-governance.ts), carried
 * back on the answer — the single name every layer (UI, server route, server coordinator) speaks
 * for this field; there is no separate `questionRequestId` on the wire (defect: two parallel
 * definitions of one body, epic #3384).
 */
export interface CodingWorkbenchRuntimeQuestionAnswerRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly questionId: string;
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
    ["requestId", "expectedRevision", "questionId", "answers"],
    "questionAnswer",
  );
  const admitted = checkQuestionAnswer(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkQuestionAnswer(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeQuestionAnswerRequest {
  const request = validateSafeId(
    value.requestId,
    "requestId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  const revision = validAnswerRevision(value);
  if (!revision) errors.push("expectedRevision must be a non-negative safe integer");
  const question = isCodeTaskQuestionId(value.questionId);
  if (!question) errors.push("questionId is invalid");
  const answers = validateAnswers(value.answers, errors);
  return request && revision && question && answers;
}

function validAnswerRevision(value: Record<string, unknown>): boolean {
  if (!Number.isSafeInteger(value.expectedRevision)) return false;
  const revision: unknown = value.expectedRevision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
}

export function validateCodingWorkbenchRuntimeQuestionsResponse(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsResponse> {
  if (!isRecord(value)) return invalid("questions response must be an object");
  const errors = exactKeys(value, ["questions"], "questionsResponse");
  const admitted = checkQuestionsResponse(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkQuestionsResponse(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeQuestionsResponse {
  return checkBoundedQuestionRequests(value.questions, value, errors);
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
  const admitted = checkQuestionsChannel(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkQuestionsChannel(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeQuestionsChannelPayload {
  const session = isOneOf(value.session, CODING_WORKBENCH_RUNTIME_QUESTIONS_SESSION_STATES);
  if (!session) errors.push("questionsChannelPayload.session is invalid");
  if (
    value.session === "unpaired" &&
    (!Array.isArray(value.questions) || value.questions.length > 0)
  )
    errors.push("questionsChannelPayload.questions must be empty when the session is unpaired");
  const questions = checkBoundedQuestionRequests(value.questions, value, errors);
  return session && questions;
}

/** Shared question-request bounds: array cap, per-request structure, and the aggregate byte budget. */
function checkBoundedQuestionRequests(
  questions: unknown,
  container: object,
  errors: string[],
): questions is readonly CodingWorkbenchRuntimeQuestionRequest[] {
  if (
    !Array.isArray(questions) ||
    questions.length > CODING_WORKBENCH_RUNTIME_QUESTION_REQUEST_MAX_COUNT
  ) {
    errors.push("questions must be a bounded array");
    return false;
  }
  const admitted = validateQuestionRequests(questions, errors);
  if (
    errors.length === 0 &&
    serializedBytes(container) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES
  )
    errors.push("questions response exceeds the aggregate UTF-8 byte budget");
  return admitted;
}

function validateQuestionRequests(
  values: readonly unknown[],
  errors: string[],
): values is readonly CodingWorkbenchRuntimeQuestionRequest[] {
  const ids = new Set<unknown>();
  const count = values.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const path = `questions[${String(index)}]`;
    if (!(index in values)) {
      errors.push(`${path} must be an object`);
      return false;
    }
    admitted = validateQuestionRequest(values[index], path, ids, errors) && admitted;
  }
  return admitted;
}

function validateQuestionRequest(
  value: unknown,
  path: string,
  ids: Set<unknown>,
  errors: string[],
): value is CodingWorkbenchRuntimeQuestionRequest {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["id", "questions"], path));
  const id = isCodeTaskQuestionId(value.id);
  if (!id) errors.push(`${path}.id is invalid`);
  else if (ids.has(value.id)) errors.push("question request ids must be unique");
  else ids.add(value.id);
  const questions = validateQuestions(value.questions, path, errors);
  return id && questions;
}

function validateQuestions(
  value: unknown,
  path: string,
  errors: string[],
): value is readonly CodingWorkbenchRuntimeQuestion[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_COUNT
  ) {
    errors.push(`${path}.questions must be a bounded non-empty array`);
    return false;
  }
  return validateCodingPhysicalMembers(value, `${path}.questions`, errors, validateQuestion);
}

function validateQuestion(
  value: unknown,
  path: string,
  errors: string[],
): value is CodingWorkbenchRuntimeQuestion {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["question", "header", "options", "multiple", "custom"], path));
  const question = validateText(
    value.question,
    `${path}.question`,
    CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
    errors,
  );
  const header = validateText(
    value.header,
    `${path}.header`,
    CODING_WORKBENCH_RUNTIME_QUESTION_HEADER_MAX_CHARS,
    errors,
  );
  const options = validateOptions(value.options, path, errors);
  let flags = true;
  for (const flag of ["multiple", "custom"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") {
      errors.push(`${path}.${flag} must be a boolean`);
      flags = false;
    }
  }
  return question && header && options && flags;
}

function validateOptions(
  value: unknown,
  path: string,
  errors: string[],
): value is readonly CodingWorkbenchRuntimeQuestionOption[] {
  if (!Array.isArray(value) || value.length > CODING_WORKBENCH_RUNTIME_QUESTION_OPTIONS_MAX_COUNT) {
    errors.push(`${path}.options must be a bounded array`);
    return false;
  }
  const labels = new Set<string>();
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const optionPath = `${path}.options[${String(index)}]`;
    if (!(index in value)) {
      errors.push(`${optionPath} must be an object`);
      return false;
    }
    const option: unknown = value[index];
    admitted = validateOption(option, optionPath, path, labels, errors) && admitted;
  }
  return admitted;
}

function validateOption(
  value: unknown,
  optionPath: string,
  path: string,
  labels: Set<string>,
  errors: string[],
): value is CodingWorkbenchRuntimeQuestionOption {
  if (!isRecord(value)) {
    errors.push(`${optionPath} must be an object`);
    return false;
  }
  errors.push(...exactKeys(value, ["label", "description"], optionPath));
  const label = validateText(
    value.label,
    `${optionPath}.label`,
    CODING_WORKBENCH_RUNTIME_QUESTION_OPTION_LABEL_MAX_CHARS,
    errors,
  );
  const description = validateText(
    value.description,
    `${optionPath}.description`,
    CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
    errors,
  );
  if (typeof value.label === "string") {
    if (labels.has(value.label)) errors.push(`${path}.option labels must be unique`);
    labels.add(value.label);
  }
  return label && description;
}

function validateAnswers(
  value: unknown,
  errors: string[],
): value is readonly (readonly string[])[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CODING_WORKBENCH_RUNTIME_QUESTION_ANSWERS_MAX_COUNT
  ) {
    errors.push("answers must be a bounded non-empty array");
    return false;
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const answer: unknown = value[index];
    if (!validAnswerMembers(answer)) {
      errors.push(`answers[${String(index)}] must contain bounded strings`);
      admitted = false;
      if (!(index in value)) return false;
    } else if (new Set(answer).size !== answer.length) {
      errors.push(`answers[${String(index)}] must not contain duplicate selections`);
    }
  }
  // Per-array caps above bound each answer individually (32 arrays x 32 selections x 4096 chars),
  // but not their sum: matches the aggregate budget checkBoundedQuestionRequests already enforces
  // on the outbound side, gated on no per-item error the same way that function gates its own check.
  if (
    errors.length === 0 &&
    serializedBytes({ answers: value }) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES
  )
    errors.push("answers exceed the aggregate UTF-8 byte budget");
  return admitted;
}

function validAnswerMembers(value: unknown): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > CODING_WORKBENCH_RUNTIME_QUESTION_SELECTIONS_MAX_COUNT
  )
    return false;
  const count = value.length;
  for (let index = 0; index < count; index += 1) {
    const selection: unknown = value[index];
    if (!validText(selection, CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS)) return false;
  }
  return true;
}

function validateText(
  value: unknown,
  path: string,
  max: number,
  errors: string[],
): value is string {
  const admitted = validText(value, max);
  if (!admitted) errors.push(`${path} must be a bounded non-empty string`);
  return admitted;
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
