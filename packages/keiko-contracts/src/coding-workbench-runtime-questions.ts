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
// Polling is intentionally frequent; 64 KiB keeps each untrusted projection reviewable while
// allowing many ordinary prompts and aligning the raw OpenCode read with the canonical BFF output.
export const CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES = 64 * 1_024;

const TEXT_ENCODER = new TextEncoder();

export interface CodingWorkbenchRuntimeQuestionsPath {
  readonly runId: string;
}

export interface CodingWorkbenchRuntimeQuestionPath extends CodingWorkbenchRuntimeQuestionsPath {
  readonly questionId: string;
}

export interface CodingWorkbenchRuntimeQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface CodingWorkbenchRuntimeQuestion {
  /** Untrusted runtime text for browser rendering only; never an evidence-safe label. */
  readonly question: string;
  /** Untrusted runtime text for browser rendering only; never an evidence-safe label. */
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

export type CodingWorkbenchRuntimeQuestionRejectRequest = Readonly<Record<never, never>>;

export interface CodingWorkbenchRuntimeQuestionAcceptedResponse {
  readonly accepted: true;
}

export function parseCodingWorkbenchRuntimeQuestionsPath(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsPath> {
  if (!isRecord(value)) return invalid("questions path must be an object");
  const errors = exactKeys(value, ["runId"], "questionsPath");
  if (!isRunId(value.runId)) errors.push("runId is invalid");
  return result(value, errors);
}

export function parseCodingWorkbenchRuntimeQuestionPath(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionPath> {
  if (!isRecord(value)) return invalid("question path must be an object");
  const errors = exactKeys(value, ["runId", "questionId"], "questionPath");
  if (!isRunId(value.runId)) errors.push("runId is invalid");
  if (!isQuestionId(value.questionId)) errors.push("questionId is invalid");
  return result(value, errors);
}

export function parseCodingWorkbenchRuntimeQuestionAnswerRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionAnswerRequest> {
  if (!isRecord(value)) return invalid("question answer must be an object");
  const errors = exactKeys(value, ["answers"], "questionAnswer");
  validateAnswers(value.answers, errors);
  return result(value, errors);
}

export function parseCodingWorkbenchRuntimeQuestionRejectRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionRejectRequest> {
  if (!isRecord(value)) return invalid("question rejection must be an object");
  return result(value, exactKeys(value, [], "questionRejection"));
}

export function validateCodingWorkbenchRuntimeQuestionAcceptedResponse(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionAcceptedResponse> {
  if (!isRecord(value)) return invalid("question acknowledgement must be an object");
  const errors = exactKeys(value, ["accepted"], "questionAcknowledgement");
  if (value.accepted !== true) errors.push("accepted must be true");
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
  } else if (questionResponseExceedsByteBudget(value.questions)) {
    errors.push("questions response exceeds the aggregate UTF-8 byte budget");
  } else {
    const ids = new Set<string>();
    value.questions.forEach((request, index) => {
      validateQuestionRequest(request, index, errors);
      if (isRecord(request) && isQuestionId(request.id)) {
        if (ids.has(request.id)) errors.push("question request ids must be unique");
        ids.add(request.id);
      }
    });
  }
  return result(value, errors);
}

interface JsonByteMeter {
  bytes: number;
}

function questionResponseExceedsByteBudget(questions: readonly unknown[]): boolean {
  const meter: JsonByteMeter = { bytes: 0 };
  addLiteral(meter, '{"questions":[');
  for (const [index, request] of questions.entries()) {
    addLiteral(meter, index === 0 ? "" : ",");
    if (!measureQuestionRequest(request, meter)) return false;
    if (meter.bytes > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES) return true;
  }
  addLiteral(meter, "]}");
  return meter.bytes > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES;
}

function measureQuestionRequest(value: unknown, meter: JsonByteMeter): boolean {
  if (!isRecord(value) || !Array.isArray(value.questions) || !isQuestionId(value.id)) return false;
  addLiteral(meter, '{"id":');
  addJsonString(meter, value.id);
  addLiteral(meter, ',"questions":[');
  for (const [index, question] of value.questions.entries()) {
    addLiteral(meter, index === 0 ? "" : ",");
    if (!measureQuestion(question, meter)) return false;
    if (meter.bytes > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES) return true;
  }
  addLiteral(meter, "]}");
  return true;
}

function measureQuestion(value: unknown, meter: JsonByteMeter): boolean {
  if (!isRecord(value) || !Array.isArray(value.options)) return false;
  addLiteral(meter, '{"question":');
  if (
    !addBoundedJsonString(meter, value.question, CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS)
  )
    return false;
  addLiteral(meter, ',"header":');
  if (
    !addBoundedJsonString(meter, value.header, CODING_WORKBENCH_RUNTIME_QUESTION_HEADER_MAX_CHARS)
  )
    return false;
  addLiteral(meter, ',"options":[');
  if (!measureOptions(value.options, meter)) return false;
  if (!measureFlag("multiple", value.multiple, meter)) return false;
  if (!measureFlag("custom", value.custom, meter)) return false;
  addLiteral(meter, "}");
  return true;
}

function measureOptions(options: readonly unknown[], meter: JsonByteMeter): boolean {
  for (const [index, option] of options.entries()) {
    addLiteral(meter, index === 0 ? "" : ",");
    if (!isRecord(option)) return false;
    addLiteral(meter, '{"label":');
    if (
      !addBoundedJsonString(
        meter,
        option.label,
        CODING_WORKBENCH_RUNTIME_QUESTION_OPTION_LABEL_MAX_CHARS,
      )
    )
      return false;
    addLiteral(meter, ',"description":');
    if (
      !addBoundedJsonString(
        meter,
        option.description,
        CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
      )
    )
      return false;
    addLiteral(meter, "}");
    if (meter.bytes > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES) return true;
  }
  addLiteral(meter, "]");
  return true;
}

function measureFlag(name: "multiple" | "custom", value: unknown, meter: JsonByteMeter): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") return false;
  addLiteral(meter, `,"${name}":${String(value)}`);
  return true;
}

function addBoundedJsonString(meter: JsonByteMeter, value: unknown, maxChars: number): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) return false;
  addJsonString(meter, value);
  return true;
}

function addJsonString(meter: JsonByteMeter, value: string): void {
  addLiteral(meter, JSON.stringify(value));
}

function addLiteral(meter: JsonByteMeter, value: string): void {
  meter.bytes += TEXT_ENCODER.encode(value).length;
}

function validateQuestionRequest(value: unknown, index: number, errors: string[]): void {
  const path = `questions[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["id", "questions"], path));
  if (!isQuestionId(value.id)) errors.push(`${path}.id is invalid`);
  if (
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_COUNT
  ) {
    errors.push(`${path}.questions must be a bounded non-empty array`);
    return;
  }
  value.questions.forEach((question, questionIndex) => {
    validateQuestion(question, `${path}.questions[${String(questionIndex)}]`, errors);
  });
}

function validateQuestion(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["question", "header", "options", "multiple", "custom"], path));
  validateBoundedText(
    value.question,
    `${path}.question`,
    CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
    errors,
  );
  validateBoundedText(
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
    validateBoundedText(
      option.label,
      `${optionPath}.label`,
      CODING_WORKBENCH_RUNTIME_QUESTION_OPTION_LABEL_MAX_CHARS,
      errors,
    );
    if (typeof option.label === "string") {
      if (labels.has(option.label)) errors.push(`${path}.option labels must be unique`);
      labels.add(option.label);
    }
    validateBoundedText(
      option.description,
      `${optionPath}.description`,
      CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
      errors,
    );
  });
}

function validateBoundedText(
  value: unknown,
  path: string,
  maxChars: number,
  errors: string[],
): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) {
    errors.push(`${path} must be a bounded non-empty string`);
  }
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
    if (
      !Array.isArray(answer) ||
      answer.length > CODING_WORKBENCH_RUNTIME_QUESTION_SELECTIONS_MAX_COUNT ||
      !answer.every(
        (selection) =>
          typeof selection === "string" &&
          selection.length >= 1 &&
          selection.length <= CODING_WORKBENCH_RUNTIME_QUESTION_TEXT_MAX_CHARS,
      )
    ) {
      errors.push(`answers[${String(index)}] must contain bounded strings`);
    } else if (new Set(answer).size !== answer.length) {
      errors.push(`answers[${String(index)}] must not contain duplicate selections`);
    }
  });
}

function isRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isQuestionId(value: unknown): value is string {
  return typeof value === "string" && /^que_[A-Za-z0-9_-]{1,251}$/u.test(value);
}
