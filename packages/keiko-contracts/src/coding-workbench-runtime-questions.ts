import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { exactKeys, invalid, isRecord, result } from "./coding-workbench-runtime-api-validation.js";

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

export interface CodingWorkbenchRuntimeQuestionAnswerRequest {
  readonly answers: readonly (readonly string[])[];
}

export function parseCodingWorkbenchRuntimeQuestionAnswerRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionAnswerRequest> {
  if (!isRecord(value)) return invalid("question answer must be an object");
  const errors = exactKeys(value, ["answers"], "questionAnswer");
  validateAnswers(value.answers, errors);
  return result(value, errors);
}

export function validateCodingWorkbenchRuntimeQuestionsResponse(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsResponse> {
  if (!isRecord(value)) return invalid("questions response must be an object");
  const errors = exactKeys(value, ["questions"], "questionsResponse");
  if (
    !Array.isArray(value.questions) ||
    value.questions.length > CODING_WORKBENCH_RUNTIME_QUESTION_REQUEST_MAX_COUNT
  ) {
    errors.push("questions must be a bounded array");
  } else {
    validateQuestionRequests(value.questions, errors);
    if (
      errors.length === 0 &&
      serializedBytes(value) > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES
    ) {
      errors.push("questions response exceeds the aggregate UTF-8 byte budget");
    }
  }
  return result(value, errors);
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
    if (!isQuestionId(value.id)) errors.push(`${path}.id is invalid`);
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
}

function validateText(value: unknown, path: string, max: number, errors: string[]): void {
  if (!validText(value, max)) errors.push(`${path} must be a bounded non-empty string`);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function serializedBytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isQuestionId(value: unknown): value is string {
  return typeof value === "string" && /^que_[A-Za-z0-9_-]{1,251}$/u.test(value);
}
