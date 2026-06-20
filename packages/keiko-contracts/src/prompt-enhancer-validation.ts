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
  PROMPT_CRITICALITIES,
  PROMPT_DOMAINS,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_MISSING_CONTEXT_MAX_CHARS,
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
// drafts; the analyzer separately truncates to its scan bound.
export const PROMPT_REQUEST_TEXT_MAX_CHARS = 1_000_000;
const PROMPT_LOCALE_MAX_CHARS = 35;
const PROMPT_SIGNAL_CODE_MAX_CHARS = 128;
const ENHANCED_PROMPT_FIELD_MAX_CHARS = 20_000;
const ENHANCED_PROMPT_LIST_MAX = 256;

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
  if (!isMember(value.format, PROMPT_OUTPUT_FORMATS)) {
    errors.push(`outputSchema.format must be one of ${PROMPT_OUTPUT_FORMATS.join("|")}`);
  }
  if (typeof value.structured !== "boolean") {
    errors.push("outputSchema.structured must be a boolean");
  }
  if (!Array.isArray(value.hints) || value.hints.some((h) => !isMember(h, OUTPUT_FORMAT_HINTS))) {
    errors.push("outputSchema.hints must be an array of known output-format hints");
  }
}

function isValidMissingContextItem(item: unknown): item is ClarificationOrAssumption {
  if (!isRecord(item) || !isMember(item.topic, MISSING_CONTEXT_TOPICS)) return false;
  if (item.kind === "clarification") {
    return isBoundedSafeText(item.question, PROMPT_MISSING_CONTEXT_MAX_CHARS);
  }
  if (item.kind === "assumption") {
    return isBoundedSafeText(item.statement, PROMPT_MISSING_CONTEXT_MAX_CHARS);
  }
  return false;
}

function validateMissingContext(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.some((item) => !isValidMissingContextItem(item))) {
    errors.push("analysis.missingContext must be an array of clarification or assumption items");
  }
}

function validateSignals(value: unknown, errors: string[]): void {
  if (
    !Array.isArray(value) ||
    value.some(
      (s) =>
        !isRecord(s) ||
        !isMember(s.dimension, PROMPT_SIGNAL_DIMENSIONS) ||
        !isBoundedSafeText(s.code, PROMPT_SIGNAL_CODE_MAX_CHARS),
    )
  ) {
    errors.push("analysis.signals must be an array of {dimension, code} records");
  }
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
