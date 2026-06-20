// Pure validators for the Prompt Enhancer contract surface (Issue #1309). Sibling of
// `prompt-enhancer.ts` and `prompt-enhancer-analyzer.ts`.
//
// Every validator is pure: no IO, no clock, no crypto, no randomness, no module-level side effects.
// Each returns a discriminated `{ ok: true; value } | { ok: false; errors }` so downstream code can
// branch without throwing. Error messages are short, deterministic, machine-readable, one per failed
// invariant, and never echo raw user input (safe-error discipline, ADR-0044 §5). Leaf-package rule
// (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports.

import { stripUnsafeFormatChars } from "./text-safety.js";
import {
  type ClarificationOrAssumption,
  type EnhancedPrompt,
  type PromptEnhancementRequest,
  type PromptTaskAnalysis,
  GROUNDING_NEED_KINDS,
  GROUNDING_SIGNALS,
  MISSING_CONTEXT_TOPICS,
  MISSING_INFORMATION_STRATEGIES,
  OUTPUT_FORMAT_HINTS,
  PROMPT_ANALYSIS_MAX_SCAN_CHARS,
  PROMPT_CRITICALITIES,
  PROMPT_DOMAINS,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_OUTPUT_FORMATS,
  PROMPT_RISK_CLASSES,
  PROMPT_SIGNAL_DIMENSIONS,
  PROMPT_SIGNAL_STRENGTHS,
  PROMPT_TASK_CLASSES,
  validatePromptEnhancerIdString,
} from "./prompt-enhancer.js";

// ─── Result types ────────────────────────────────────────────────────────────────
export interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type PromptEnhancerValidation<T> = ValidationOk<T> | ValidationFail;

// Maximum length of a raw draft accepted by the request validator. Generous enough for large pasted
// drafts while ensuring analyzer risk classification cannot silently ignore unvalidated suffix text.
export const PROMPT_REQUEST_TEXT_MAX_CHARS = PROMPT_ANALYSIS_MAX_SCAN_CHARS;
const PROMPT_LOCALE_MAX_CHARS = 35;
const PROMPT_SIGNAL_CODE_MAX_CHARS = 128;
const ENHANCED_PROMPT_FIELD_MAX_CHARS = 20_000;
const ENHANCED_PROMPT_LIST_MAX = 256;
const STRUCTURED_OUTPUT_FORMATS: ReadonlySet<string> = new Set(["json", "yaml", "csv", "table"]);

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "requestId",
  "input",
  "missingInformationStrategy",
  "profilePreference",
  "locale",
]);
const RAW_INPUT_KEYS: ReadonlySet<string> = new Set([
  "text",
  "hasConnectedContext",
  "attachmentCount",
]);
const ANALYSIS_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "requestId",
  "taskClass",
  "taskClassConfidence",
  "domain",
  "criticality",
  "groundingNeed",
  "outputSchema",
  "missingContext",
  "riskFlags",
  "recommendedProfile",
  "normalizedInputLength",
  "signals",
]);
const GROUNDING_NEED_KEYS: ReadonlySet<string> = new Set(["kind", "volatile", "signals"]);
const OUTPUT_SCHEMA_KEYS: ReadonlySet<string> = new Set(["format", "structured", "hints"]);
const SIGNAL_KEYS: ReadonlySet<string> = new Set(["dimension", "code"]);
const CLARIFICATION_KEYS: ReadonlySet<string> = new Set(["kind", "topic", "question"]);
const ASSUMPTION_KEYS: ReadonlySet<string> = new Set(["kind", "topic", "statement"]);
const ENHANCED_PROMPT_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "promptId",
  "role",
  "goal",
  "context",
  "input",
  "taskDecomposition",
  "constraints",
  "groundingRules",
  "outputSchema",
  "qualityCriteria",
  "uncertaintyHandling",
  "safetyRules",
]);

const CLARIFICATION_TEMPLATES: Readonly<Record<string, string>> = {
  subject: "What specific subject or task should this prompt address?",
  scope: "Which part of the work should the task focus on?",
  audience: "Who is the intended audience for the output?",
  "output-format": "What output format is expected (for example JSON, a table, or prose)?",
  constraints: "Are there language, framework, or length constraints to honor?",
  "data-source": "Which files, documents, or sources should ground the answer?",
  "success-criteria": "What defines a successful outcome for this task?",
};

const ASSUMPTION_TEMPLATES: Readonly<Record<string, string>> = {
  subject: "Assuming the broadest reasonable interpretation of the requested subject.",
  scope: "Assuming the task applies to the most relevant available scope.",
  audience: "Assuming a general professional audience.",
  "output-format": "Assuming a structured format appropriate to the task.",
  constraints: "Assuming no constraints beyond standard best practices.",
  "data-source": "Assuming the answer should rely only on supplied context, with gaps flagged.",
  "success-criteria": "Assuming correctness and completeness are the primary success criteria.",
};

// ─── Pure predicates ─────────────────────────────────────────────────────────────
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMember = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

// A bounded, control-free string (TAB/LF/CR permitted via the text-safety policy). Rejects bidi /
// zero-width / control code points and over-length values.
const isBoundedSafeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && stripUnsafeFormatChars(value) === value;

function validateExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[],
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    errors.push(`${label} must not contain unknown fields`);
  }
}

function pushIdError(value: unknown, field: string, kind: string, errors: string[]): void {
  const result = validatePromptEnhancerIdString(value, kind);
  if (!result.ok) errors.push(`${field}: ${result.reason}`);
}

// ─── Request validator ───────────────────────────────────────────────────────────
function validateRawInput(input: unknown, errors: string[]): void {
  if (!isRecord(input)) {
    errors.push("request.input must be an object");
    return;
  }
  validateExactKeys(input, RAW_INPUT_KEYS, "request.input", errors);
  if (typeof input.text !== "string" || input.text.length > PROMPT_REQUEST_TEXT_MAX_CHARS) {
    errors.push(
      `request.input.text must be a string of at most ${String(PROMPT_REQUEST_TEXT_MAX_CHARS)} characters`,
    );
  }
  if (input.hasConnectedContext !== undefined && typeof input.hasConnectedContext !== "boolean") {
    errors.push("request.input.hasConnectedContext must be a boolean when set");
  }
  if (input.attachmentCount !== undefined && !isNonNegativeInteger(input.attachmentCount)) {
    errors.push("request.input.attachmentCount must be a non-negative integer when set");
  }
}

export function validatePromptEnhancementRequest(
  input: unknown,
): PromptEnhancerValidation<PromptEnhancementRequest> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors: string[] = [];
  validateExactKeys(input, REQUEST_KEYS, "request", errors);
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`request.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
  }
  pushIdError(input.requestId, "request.requestId", "PromptEnhancementRequestId", errors);
  validateRawInput(input.input, errors);
  if (!isMember(input.missingInformationStrategy, MISSING_INFORMATION_STRATEGIES)) {
    errors.push(
      `request.missingInformationStrategy must be one of ${MISSING_INFORMATION_STRATEGIES.join("|")}`,
    );
  }
  if (
    input.profilePreference !== undefined &&
    !isMember(input.profilePreference, PROMPT_ENHANCEMENT_PROFILE_IDS)
  ) {
    errors.push(
      `request.profilePreference must be one of ${PROMPT_ENHANCEMENT_PROFILE_IDS.join("|")} when set`,
    );
  }
  if (input.locale !== undefined && !isBoundedSafeText(input.locale, PROMPT_LOCALE_MAX_CHARS)) {
    errors.push("request.locale must be a bounded, control-free string when set");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as PromptEnhancementRequest };
}

// ─── Shared sub-shape validators ─────────────────────────────────────────────────
function validateGroundingNeed(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("analysis.groundingNeed must be an object");
    return;
  }
  validateExactKeys(value, GROUNDING_NEED_KEYS, "analysis.groundingNeed", errors);
  if (!isMember(value.kind, GROUNDING_NEED_KINDS)) {
    errors.push(`analysis.groundingNeed.kind must be one of ${GROUNDING_NEED_KINDS.join("|")}`);
  }
  if (typeof value.volatile !== "boolean") {
    errors.push("analysis.groundingNeed.volatile must be a boolean");
  }
  if (!Array.isArray(value.signals) || value.signals.some((s) => !isMember(s, GROUNDING_SIGNALS))) {
    errors.push("analysis.groundingNeed.signals must be an array of known grounding signals");
  }
}

function validateOutputSchema(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("outputSchema must be an object");
    return;
  }
  validateExactKeys(value, OUTPUT_SCHEMA_KEYS, "outputSchema", errors);
  if (!isMember(value.format, PROMPT_OUTPUT_FORMATS)) {
    errors.push(`outputSchema.format must be one of ${PROMPT_OUTPUT_FORMATS.join("|")}`);
  }
  if (typeof value.structured !== "boolean") {
    errors.push("outputSchema.structured must be a boolean");
  } else if (
    typeof value.format === "string" &&
    PROMPT_OUTPUT_FORMATS.includes(value.format as (typeof PROMPT_OUTPUT_FORMATS)[number]) &&
    value.structured !== STRUCTURED_OUTPUT_FORMATS.has(value.format)
  ) {
    errors.push("outputSchema.structured must match the selected output format");
  }
  if (!Array.isArray(value.hints) || value.hints.some((h) => !isMember(h, OUTPUT_FORMAT_HINTS))) {
    errors.push("outputSchema.hints must be an array of known output-format hints");
  }
}

function isValidMissingContextItem(item: unknown): item is ClarificationOrAssumption {
  if (!isRecord(item) || !isMember(item.topic, MISSING_CONTEXT_TOPICS)) return false;
  if (item.kind === "clarification") {
    return (
      Object.keys(item).every((key) => CLARIFICATION_KEYS.has(key)) &&
      item.question === CLARIFICATION_TEMPLATES[item.topic]
    );
  }
  if (item.kind === "assumption") {
    return (
      Object.keys(item).every((key) => ASSUMPTION_KEYS.has(key)) &&
      item.statement === ASSUMPTION_TEMPLATES[item.topic]
    );
  }
  return false;
}

function validateMissingContext(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.some((item) => !isValidMissingContextItem(item))) {
    errors.push("analysis.missingContext must be an array of clarification or assumption items");
  }
}

function validateSignals(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.some((s) => !isRecord(s) || !isValidSignal(s))) {
    errors.push("analysis.signals must be an array of {dimension, code} records");
  }
}

function isCodeWithMember(code: string, prefix: string, allowed: readonly string[]): boolean {
  return code.startsWith(prefix) && allowed.includes(code.slice(prefix.length));
}

const SIGNAL_CODE_VALIDATORS: Readonly<Record<string, (code: string) => boolean>> = {
  "task-class": (code) => isCodeWithMember(code, "class:", PROMPT_TASK_CLASSES),
  domain: (code) => isCodeWithMember(code, "domain:", PROMPT_DOMAINS),
  grounding: (code) =>
    isCodeWithMember(code, "grounding:", GROUNDING_NEED_KINDS) ||
    isCodeWithMember(code, "signal:", GROUNDING_SIGNALS),
  output: (code) =>
    isCodeWithMember(code, "format:", PROMPT_OUTPUT_FORMATS) ||
    isCodeWithMember(code, "hint:", OUTPUT_FORMAT_HINTS),
  risk: (code) => isCodeWithMember(code, "risk:", PROMPT_RISK_CLASSES),
  "missing-context": (code) => isCodeWithMember(code, "topic:", MISSING_CONTEXT_TOPICS),
};

function isValidSignal(signal: Record<string, unknown>): boolean {
  if (
    !Object.keys(signal).every((key) => SIGNAL_KEYS.has(key)) ||
    !isMember(signal.dimension, PROMPT_SIGNAL_DIMENSIONS) ||
    !isBoundedSafeText(signal.code, PROMPT_SIGNAL_CODE_MAX_CHARS)
  ) {
    return false;
  }
  return SIGNAL_CODE_VALIDATORS[signal.dimension]?.(signal.code) ?? false;
}

// ─── Analysis validator ──────────────────────────────────────────────────────────
function validateAnalysisEnums(value: Record<string, unknown>, errors: string[]): void {
  if (!isMember(value.taskClass, PROMPT_TASK_CLASSES))
    errors.push("analysis.taskClass is not a known task class");
  if (!isMember(value.taskClassConfidence, PROMPT_SIGNAL_STRENGTHS)) {
    errors.push("analysis.taskClassConfidence is not a known signal strength");
  }
  if (!isMember(value.domain, PROMPT_DOMAINS)) errors.push("analysis.domain is not a known domain");
  if (!isMember(value.criticality, PROMPT_CRITICALITIES))
    errors.push("analysis.criticality is not a known criticality");
  if (!isMember(value.recommendedProfile, PROMPT_ENHANCEMENT_PROFILE_IDS)) {
    errors.push("analysis.recommendedProfile is not a known profile id");
  }
  if (
    !Array.isArray(value.riskFlags) ||
    value.riskFlags.some((f) => !isMember(f, PROMPT_RISK_CLASSES))
  ) {
    errors.push("analysis.riskFlags must be an array of known risk classes");
  }
}

export function validatePromptTaskAnalysis(
  input: unknown,
): PromptEnhancerValidation<PromptTaskAnalysis> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["analysis must be an object"] };
  }
  const errors: string[] = [];
  validateExactKeys(input, ANALYSIS_KEYS, "analysis", errors);
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`analysis.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
  }
  pushIdError(input.requestId, "analysis.requestId", "PromptEnhancementRequestId", errors);
  validateAnalysisEnums(input, errors);
  validateGroundingNeed(input.groundingNeed, errors);
  validateOutputSchema(input.outputSchema, errors);
  validateMissingContext(input.missingContext, errors);
  validateSignals(input.signals, errors);
  if (!isNonNegativeInteger(input.normalizedInputLength)) {
    errors.push("analysis.normalizedInputLength must be a non-negative integer");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as PromptTaskAnalysis };
}

// ─── Enhanced Prompt validator ───────────────────────────────────────────────────
function isBoundedStringList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= ENHANCED_PROMPT_LIST_MAX &&
    value.every((entry) => isBoundedSafeText(entry, ENHANCED_PROMPT_FIELD_MAX_CHARS))
  );
}

const ENHANCED_PROMPT_STRING_FIELDS: readonly string[] = ["role", "goal", "input"];
const ENHANCED_PROMPT_LIST_FIELDS: readonly string[] = [
  "context",
  "taskDecomposition",
  "constraints",
  "groundingRules",
  "qualityCriteria",
  "uncertaintyHandling",
  "safetyRules",
];

export function validateEnhancedPrompt(input: unknown): PromptEnhancerValidation<EnhancedPrompt> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["enhancedPrompt must be an object"] };
  }
  const errors: string[] = [];
  validateExactKeys(input, ENHANCED_PROMPT_KEYS, "enhancedPrompt", errors);
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`enhancedPrompt.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
  }
  pushIdError(input.promptId, "enhancedPrompt.promptId", "EnhancedPromptId", errors);
  for (const field of ENHANCED_PROMPT_STRING_FIELDS) {
    if (!isBoundedSafeText(input[field], ENHANCED_PROMPT_FIELD_MAX_CHARS)) {
      errors.push(`enhancedPrompt.${field} must be a bounded, control-free string`);
    }
  }
  for (const field of ENHANCED_PROMPT_LIST_FIELDS) {
    if (!isBoundedStringList(input[field])) {
      errors.push(`enhancedPrompt.${field} must be a bounded array of control-free strings`);
    }
  }
  validateOutputSchema(input.outputSchema, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as EnhancedPrompt };
}
