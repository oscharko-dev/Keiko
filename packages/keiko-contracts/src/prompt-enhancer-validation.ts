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
  type RawPromptInput,
  type GroundingNeed,
  type OutputSchemaDescriptor,
  type EnhancedPrompt,
  type GroundingDirective,
  type GroundingPlan,
  type GroundingSourcePolicy,
  type GroundingStrategy,
  type PromptEnhancementRequest,
  type PromptTaskAnalysis,
  type PromptSignalDimension,
  type RagEvaluationHint,
  type RecencyExpectation,
  CITATION_DISCIPLINES,
  CITATION_GRANULARITIES,
  CONTRADICTION_POLICIES,
  GROUNDING_DIRECTIVES,
  GROUNDING_NEED_KINDS,
  GROUNDING_SIGNALS,
  GROUNDING_SOURCE_KINDS,
  GROUNDING_STRATEGIES,
  MISSING_CONTEXT_TOPICS,
  MISSING_INFORMATION_STRATEGIES,
  NO_ANSWER_CONDITIONS,
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
  RAG_EVALUATION_DIMENSIONS,
  RETRIEVAL_MODES,
  validatePromptEnhancerIdString,
} from "./prompt-enhancer.js";
import {
  buildDirectives,
  buildSourcePriority,
  RAG_HINT_TEMPLATES,
  RETRIEVAL_MODES_BY_STRATEGY,
  buildNoAnswerConditions,
  buildRecency,
} from "./prompt-enhancer-grounding.js";
import {
  ASSUMPTION_TEMPLATES,
  CLARIFICATION_TEMPLATES,
  STRUCTURED_FORMATS,
} from "./prompt-enhancer-analyzer.js";
import {
  PROMPT_CRITIC_DIMENSIONS,
  isPromptCandidateRejectionReason,
  type PromptCandidateScorecard,
  type PromptCandidateRejection,
  type PromptOptimizationBounds,
  type PromptCandidateSelection,
  type PromptCriticDimension,
  type PromptCriticDimensionScore,
} from "./prompt-enhancer-critic.js";
import {
  validatePromptSafetyAssessment,
  type PromptSafetyAssessment,
} from "./prompt-enhancer-safety.js";

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
  "groundingPlan",
  "outputSchema",
  "qualityCriteria",
  "uncertaintyHandling",
  "safetyRules",
]);
const GROUNDING_PLAN_KEYS: ReadonlySet<string> = new Set([
  "strategy",
  "required",
  "allowedRetrievalModes",
  "sourcePriority",
  "citation",
  "recency",
  "contradictionPolicy",
  "noAnswerConditions",
  "directives",
  "ragEvaluation",
  "untrustedContent",
]);
const SOURCE_POLICY_KEYS: ReadonlySet<string> = new Set(["source", "priority", "required"]);
const CITATION_KEYS: ReadonlySet<string> = new Set(["discipline", "granularity"]);
const RECENCY_KEYS: ReadonlySet<string> = new Set([
  "volatile",
  "requireAsOfDate",
  "flagPotentiallyStale",
]);
const RAG_HINT_KEYS: ReadonlySet<string> = new Set(["dimension", "instruction"]);
const RAG_HINT_INSTRUCTION_MAX_CHARS = 400;

interface ValidCitationShape {
  readonly discipline: (typeof CITATION_DISCIPLINES)[number];
  readonly granularity: (typeof CITATION_GRANULARITIES)[number];
}

// ─── Pure predicates ─────────────────────────────────────────────────────────────
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMember = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && new Set<string>(allowed).has(value);

// A bounded array whose every entry is a member of the allowed closed set.
function isMemberArray(value: unknown, allowed: readonly string[]): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const extent: number = value.length;
  if (!Number.isSafeInteger(extent) || extent < 0) return false;
  for (let index = 0; index < extent; index += 1) {
    const item: unknown = value[index];
    if (!isMember(item, allowed)) return false;
  }
  return true;
}

function hasInvalidMember(value: unknown, check: (entry: unknown) => boolean): boolean {
  if (!Array.isArray(value)) return true;
  const extent: number = value.length;
  if (!Number.isSafeInteger(extent) || extent < 0) return true;
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = value[index];
    if (!check(entry)) return true;
  }
  return false;
}

const arraysEqual = <T>(actual: readonly T[], expected: readonly T[]): boolean =>
  actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

// A bounded, control-free string (TAB/LF/CR permitted via the text-safety policy). Rejects bidi /
// zero-width / control code points and over-length values.
const isBoundedSafeText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && stripUnsafeFormatChars(value) === value;

function validateExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[],
): boolean {
  let admitted = true;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    errors.push(`${label} must not contain unknown fields`);
    admitted = false;
  }
  return admitted;
}

function pushIdError(value: unknown, field: string, kind: string, errors: string[]): boolean {
  const result = validatePromptEnhancerIdString(value, kind);
  if (!result.ok) errors.push(`${field}: ${result.reason}`);
  return result.ok;
}

// ─── Request validator ───────────────────────────────────────────────────────────
function validateRawInput(input: unknown, errors: string[]): input is RawPromptInput {
  let admitted = true;
  if (!isRecord(input)) {
    errors.push("request.input must be an object");
    return false;
  }
  admitted = validateExactKeys(input, RAW_INPUT_KEYS, "request.input", errors) && admitted;
  let textAdmitted = typeof input.text === "string";
  if (textAdmitted) {
    const consumedText: unknown = input.text;
    textAdmitted =
      typeof consumedText === "string" && consumedText.length <= PROMPT_REQUEST_TEXT_MAX_CHARS;
  }
  if (!textAdmitted) {
    errors.push(
      `request.input.text must be a string of at most ${String(PROMPT_REQUEST_TEXT_MAX_CHARS)} characters`,
    );
    admitted = false;
  }
  if (input.hasConnectedContext !== undefined && typeof input.hasConnectedContext !== "boolean") {
    errors.push("request.input.hasConnectedContext must be a boolean when set");
    admitted = false;
  }
  if (input.attachmentCount !== undefined && !isNonNegativeInteger(input.attachmentCount)) {
    errors.push("request.input.attachmentCount must be a non-negative integer when set");
    admitted = false;
  }
  return admitted;
}

function admitsPromptEnhancementRequest(
  input: unknown,
  errors: string[],
): input is PromptEnhancementRequest {
  if (!isRecord(input)) {
    errors.push("request must be an object");
    return false;
  }
  const admissions: boolean[] = [];
  admissions.push(validateExactKeys(input, REQUEST_KEYS, "request", errors));
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`request.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
    admissions.push(false);
  }
  admissions.push(
    pushIdError(input.requestId, "request.requestId", "PromptEnhancementRequestId", errors),
    validateRawInput(input.input, errors),
  );
  if (!isMember(input.missingInformationStrategy, MISSING_INFORMATION_STRATEGIES)) {
    errors.push(
      `request.missingInformationStrategy must be one of ${MISSING_INFORMATION_STRATEGIES.join("|")}`,
    );
    admissions.push(false);
  }
  if (
    input.profilePreference !== undefined &&
    !isMember(input.profilePreference, PROMPT_ENHANCEMENT_PROFILE_IDS)
  ) {
    errors.push(
      `request.profilePreference must be one of ${PROMPT_ENHANCEMENT_PROFILE_IDS.join("|")} when set`,
    );
    admissions.push(false);
  }
  if (input.locale !== undefined && !isBoundedSafeText(input.locale, PROMPT_LOCALE_MAX_CHARS)) {
    errors.push("request.locale must be a bounded, control-free string when set");
    admissions.push(false);
  }
  return admissions.every(Boolean);
}

export function validatePromptEnhancementRequest(
  input: unknown,
): PromptEnhancerValidation<PromptEnhancementRequest> {
  const errors: string[] = [];
  if (!admitsPromptEnhancementRequest(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Shared sub-shape validators ─────────────────────────────────────────────────
function validateGroundingNeed(value: unknown, errors: string[]): value is GroundingNeed {
  let admitted = true;
  if (!isRecord(value)) {
    errors.push("analysis.groundingNeed must be an object");
    return false;
  }
  admitted =
    validateExactKeys(value, GROUNDING_NEED_KEYS, "analysis.groundingNeed", errors) && admitted;
  if (!isMember(value.kind, GROUNDING_NEED_KINDS)) {
    errors.push(`analysis.groundingNeed.kind must be one of ${GROUNDING_NEED_KINDS.join("|")}`);
    admitted = false;
  }
  if (typeof value.volatile !== "boolean") {
    errors.push("analysis.groundingNeed.volatile must be a boolean");
    admitted = false;
  }
  if (
    !Array.isArray(value.signals) ||
    hasInvalidMember(value.signals, (entry): boolean => isMember(entry, GROUNDING_SIGNALS))
  ) {
    errors.push("analysis.groundingNeed.signals must be an array of known grounding signals");
    admitted = false;
  }
  return admitted;
}

function validateOutputFormatRelation(
  value: Record<string, unknown>,
  firstFormatAdmitted: boolean,
  errors: string[],
): boolean {
  const typeObservation: unknown = value.format;
  if (typeof typeObservation !== "string") {
    return refuseObservedOutputFormat(firstFormatAdmitted, errors);
  }
  const membershipObservation: unknown = value.format;
  if (!isMember(membershipObservation, PROMPT_OUTPUT_FORMATS)) {
    return refuseObservedOutputFormat(firstFormatAdmitted, errors);
  }
  const structuredObservation: unknown = value.structured;
  const consumedFormat: unknown = value.format;
  if (!isMember(consumedFormat, PROMPT_OUTPUT_FORMATS)) {
    return refuseObservedOutputFormat(firstFormatAdmitted, errors);
  }
  if (structuredObservation !== STRUCTURED_FORMATS.has(consumedFormat)) {
    errors.push("outputSchema.structured must match the selected output format");
    return false;
  }
  return true;
}

function refuseObservedOutputFormat(firstFormatAdmitted: boolean, errors: string[]): false {
  if (firstFormatAdmitted) {
    errors.push(`outputSchema.format must be one of ${PROMPT_OUTPUT_FORMATS.join("|")}`);
  }
  return false;
}

function validateOutputSchema(value: unknown, errors: string[]): value is OutputSchemaDescriptor {
  let admitted = true;
  if (!isRecord(value)) {
    errors.push("outputSchema must be an object");
    return false;
  }
  admitted = validateExactKeys(value, OUTPUT_SCHEMA_KEYS, "outputSchema", errors) && admitted;
  const firstFormatAdmitted = isMember(value.format, PROMPT_OUTPUT_FORMATS);
  if (!firstFormatAdmitted) {
    errors.push(`outputSchema.format must be one of ${PROMPT_OUTPUT_FORMATS.join("|")}`);
    admitted = false;
  }
  if (typeof value.structured !== "boolean") {
    errors.push("outputSchema.structured must be a boolean");
    admitted = false;
  } else {
    admitted = validateOutputFormatRelation(value, firstFormatAdmitted, errors) && admitted;
  }
  if (
    !Array.isArray(value.hints) ||
    hasInvalidMember(value.hints, (entry): boolean => isMember(entry, OUTPUT_FORMAT_HINTS))
  ) {
    errors.push("outputSchema.hints must be an array of known output-format hints");
    admitted = false;
  }
  return admitted;
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

function validateMissingContext(value: unknown, errors: string[]): boolean {
  let admitted = true;
  if (!Array.isArray(value) || hasInvalidMember(value, isValidMissingContextItem)) {
    errors.push("analysis.missingContext must be an array of clarification or assumption items");
    admitted = false;
  }
  return admitted;
}

function validateSignals(value: unknown, errors: string[]): boolean {
  let admitted = true;
  if (
    !Array.isArray(value) ||
    hasInvalidMember(value, (entry): boolean => isRecord(entry) && isValidSignal(entry))
  ) {
    errors.push("analysis.signals must be an array of {dimension, code} records");
    admitted = false;
  }
  return admitted;
}

function isCodeWithMember(code: string, prefix: string, allowed: readonly string[]): boolean {
  return code.startsWith(prefix) && allowed.includes(code.slice(prefix.length));
}

const SIGNAL_CODE_VALIDATORS: Readonly<
  Partial<Record<PromptSignalDimension, (code: string) => boolean>>
> = {
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
} satisfies Readonly<Record<PromptSignalDimension, (code: string) => boolean>>;

function isValidSignal(signal: Record<string, unknown>): boolean {
  if (
    !Object.keys(signal).every((key) => SIGNAL_KEYS.has(key)) ||
    !isMember(signal.dimension, PROMPT_SIGNAL_DIMENSIONS) ||
    !isBoundedSafeText(signal.code, PROMPT_SIGNAL_CODE_MAX_CHARS)
  ) {
    return false;
  }
  const validator = SIGNAL_CODE_VALIDATORS[signal.dimension];
  return validator?.(signal.code) === true;
}

// ─── Analysis validator ──────────────────────────────────────────────────────────
function validateAnalysisEnums(value: Record<string, unknown>, errors: string[]): boolean {
  let admitted = true;
  if (!isMember(value.taskClass, PROMPT_TASK_CLASSES)) {
    errors.push("analysis.taskClass is not a known task class");
    admitted = false;
  }
  if (!isMember(value.taskClassConfidence, PROMPT_SIGNAL_STRENGTHS)) {
    errors.push("analysis.taskClassConfidence is not a known signal strength");
    admitted = false;
  }
  if (!isMember(value.domain, PROMPT_DOMAINS)) {
    errors.push("analysis.domain is not a known domain");
    admitted = false;
  }
  if (!isMember(value.criticality, PROMPT_CRITICALITIES)) {
    errors.push("analysis.criticality is not a known criticality");
    admitted = false;
  }
  if (!isMember(value.recommendedProfile, PROMPT_ENHANCEMENT_PROFILE_IDS)) {
    errors.push("analysis.recommendedProfile is not a known profile id");
    admitted = false;
  }
  if (!Array.isArray(value.riskFlags) || !isMemberArray(value.riskFlags, PROMPT_RISK_CLASSES)) {
    errors.push("analysis.riskFlags must be an array of known risk classes");
    admitted = false;
  }
  return admitted;
}

function admitsPromptTaskAnalysis(input: unknown, errors: string[]): input is PromptTaskAnalysis {
  if (!isRecord(input)) {
    errors.push("analysis must be an object");
    return false;
  }
  const admissions: boolean[] = [];
  admissions.push(validateExactKeys(input, ANALYSIS_KEYS, "analysis", errors));
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`analysis.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
    admissions.push(false);
  }
  admissions.push(
    pushIdError(input.requestId, "analysis.requestId", "PromptEnhancementRequestId", errors),
    validateAnalysisEnums(input, errors),
    validateGroundingNeed(input.groundingNeed, errors),
    validateOutputSchema(input.outputSchema, errors),
    validateMissingContext(input.missingContext, errors),
    validateSignals(input.signals, errors),
  );
  if (!isNonNegativeInteger(input.normalizedInputLength)) {
    errors.push("analysis.normalizedInputLength must be a non-negative integer");
    admissions.push(false);
  }
  return admissions.every(Boolean);
}

export function validatePromptTaskAnalysis(
  input: unknown,
): PromptEnhancerValidation<PromptTaskAnalysis> {
  const errors: string[] = [];
  if (!admitsPromptTaskAnalysis(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Grounding plan validator (Issue #1311) ────────────────────────────────────────
function validateGroundingPlanScalars(value: Record<string, unknown>, errors: string[]): boolean {
  let admitted = true;
  if (!isMember(value.strategy, GROUNDING_STRATEGIES)) {
    errors.push(`groundingPlan.strategy must be one of ${GROUNDING_STRATEGIES.join("|")}`);
    admitted = false;
  }
  if (typeof value.required !== "boolean") {
    errors.push("groundingPlan.required must be a boolean");
    admitted = false;
  }
  if (!isMember(value.contradictionPolicy, CONTRADICTION_POLICIES)) {
    errors.push(
      `groundingPlan.contradictionPolicy must be one of ${CONTRADICTION_POLICIES.join("|")}`,
    );
    admitted = false;
  }
  if (value.untrustedContent !== true) {
    errors.push("groundingPlan.untrustedContent must be true");
    admitted = false;
  }
  return admitted;
}

function validateGroundingPlanLists(value: Record<string, unknown>, errors: string[]): boolean {
  let admitted = true;
  if (!isMemberArray(value.allowedRetrievalModes, RETRIEVAL_MODES)) {
    errors.push("groundingPlan.allowedRetrievalModes must be an array of known retrieval modes");
    admitted = false;
  }
  if (!isMemberArray(value.noAnswerConditions, NO_ANSWER_CONDITIONS)) {
    errors.push("groundingPlan.noAnswerConditions must be an array of known no-answer conditions");
    admitted = false;
  }
  if (!isMemberArray(value.directives, GROUNDING_DIRECTIVES)) {
    errors.push("groundingPlan.directives must be an array of known grounding directives");
    admitted = false;
  }
  return admitted;
}

function isValidSourcePolicy(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    Object.keys(entry).every((key) => SOURCE_POLICY_KEYS.has(key)) &&
    isMember(entry.source, GROUNDING_SOURCE_KINDS) &&
    isPositiveInteger(entry.priority) &&
    typeof entry.required === "boolean"
  );
}

function validateSourcePriority(value: unknown, errors: string[]): boolean {
  let admitted = true;
  if (!Array.isArray(value) || value.some((entry) => !isValidSourcePolicy(entry))) {
    errors.push("groundingPlan.sourcePriority must be an array of {source, priority, required}");
    admitted = false;
  }
  return admitted;
}

function validateCitation(value: unknown, errors: string[]): value is ValidCitationShape {
  let admitted = true;
  if (!isRecord(value)) {
    errors.push("groundingPlan.citation must be an object");
    return false;
  }
  admitted = validateExactKeys(value, CITATION_KEYS, "groundingPlan.citation", errors) && admitted;
  if (!isMember(value.discipline, CITATION_DISCIPLINES)) {
    errors.push(
      `groundingPlan.citation.discipline must be one of ${CITATION_DISCIPLINES.join("|")}`,
    );
    admitted = false;
  }
  if (!isMember(value.granularity, CITATION_GRANULARITIES)) {
    errors.push(
      `groundingPlan.citation.granularity must be one of ${CITATION_GRANULARITIES.join("|")}`,
    );
    admitted = false;
  }
  return admitted;
}

function validateRecency(value: unknown, errors: string[]): value is RecencyExpectation {
  let admitted = true;
  if (!isRecord(value)) {
    errors.push("groundingPlan.recency must be an object");
    return false;
  }
  admitted = validateExactKeys(value, RECENCY_KEYS, "groundingPlan.recency", errors) && admitted;
  if (typeof value.volatile !== "boolean") {
    errors.push("groundingPlan.recency.volatile must be a boolean");
    admitted = false;
  }
  if (typeof value.requireAsOfDate !== "boolean") {
    errors.push("groundingPlan.recency.requireAsOfDate must be a boolean");
    admitted = false;
  }
  if (typeof value.flagPotentiallyStale !== "boolean") {
    errors.push("groundingPlan.recency.flagPotentiallyStale must be a boolean");
    admitted = false;
  }
  return admitted;
}

function isValidRagHint(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    Object.keys(entry).every((key) => RAG_HINT_KEYS.has(key)) &&
    isMember(entry.dimension, RAG_EVALUATION_DIMENSIONS) &&
    isBoundedSafeText(entry.instruction, RAG_HINT_INSTRUCTION_MAX_CHARS)
  );
}

function validateRagEvaluation(value: unknown, errors: string[]): boolean {
  let admitted = true;
  if (!Array.isArray(value) || hasInvalidMember(value, isValidRagHint)) {
    errors.push("groundingPlan.ragEvaluation must be an array of {dimension, instruction}");
    admitted = false;
  }
  return admitted;
}

function asGroundingStrategy(value: unknown): GroundingStrategy | undefined {
  return isMember(value, GROUNDING_STRATEGIES) ? value : undefined;
}

function isValidSourcePriority(value: unknown): value is readonly GroundingSourcePolicy[] {
  return !hasInvalidMember(value, isValidSourcePolicy);
}

function sourcePoliciesEqual(
  actual: GroundingSourcePolicy,
  expected: GroundingSourcePolicy,
): boolean {
  return (
    actual.source === expected.source &&
    actual.priority === expected.priority &&
    actual.required === expected.required
  );
}

function isValidRecency(value: unknown): value is RecencyExpectation {
  return (
    isRecord(value) &&
    typeof value.volatile === "boolean" &&
    typeof value.requireAsOfDate === "boolean" &&
    typeof value.flagPotentiallyStale === "boolean"
  );
}

function isValidRagEvaluation(value: unknown): value is readonly RagEvaluationHint[] {
  return !hasInvalidMember(value, isValidRagHint);
}

function validateAllowedRetrievalModeSemantics(
  value: unknown,
  strategy: GroundingStrategy,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isMemberArray(value, RETRIEVAL_MODES)) return true;
  if (!arraysEqual(value, RETRIEVAL_MODES_BY_STRATEGY[strategy])) {
    errors.push("groundingPlan.allowedRetrievalModes must match the selected strategy");
    admitted = false;
  }
  return admitted;
}

function validateSourcePrioritySemantics(
  value: unknown,
  strategy: GroundingStrategy,
  required: boolean,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isValidSourcePriority(value)) {
    if (Array.isArray(value) && value.some((entry): boolean => !isValidSourcePolicy(entry)))
      return false;
    if (Array.isArray(value)) {
      errors.push(
        "groundingPlan.sourcePriority must match strategy ordering, 1-based priorities, and required-source rules",
      );
    }
    return false;
  }
  const expected = buildSourcePriority(strategy, required);
  const matches = value.every((entry, index) => {
    const expectedEntry = expected[index];
    return expectedEntry === undefined ? false : sourcePoliciesEqual(entry, expectedEntry);
  });
  const uniquePriorities = new Set(value.map((entry) => entry.priority));
  const uniqueSources = new Set(value.map((entry) => entry.source));
  if (
    value.length !== expected.length ||
    !matches ||
    uniquePriorities.size !== value.length ||
    uniqueSources.size !== value.length
  ) {
    errors.push(
      "groundingPlan.sourcePriority must match strategy ordering, 1-based priorities, and required-source rules",
    );
    admitted = false;
  }
  return admitted;
}

function isValidCitationShape(value: unknown): value is ValidCitationShape {
  return (
    isRecord(value) &&
    isMember(value.discipline, CITATION_DISCIPLINES) &&
    isMember(value.granularity, CITATION_GRANULARITIES)
  );
}

function validateNoGroundingCitationSemantics(
  value: ValidCitationShape,
  strategy: GroundingStrategy,
  errors: string[],
): boolean {
  let admitted = true;
  if (
    strategy === "no-grounding" &&
    (value.discipline !== "not-required" || value.granularity !== "none")
  ) {
    errors.push("groundingPlan.citation must be not-required/none for no-grounding plans");
    admitted = false;
  }
  return admitted;
}

function validateGroundedCitationSemantics(
  value: ValidCitationShape,
  strategy: GroundingStrategy,
  errors: string[],
): boolean {
  let admitted = true;
  if (strategy !== "no-grounding" && value.discipline === "not-required") {
    errors.push("groundingPlan.citation.discipline cannot be not-required for grounded plans");
    admitted = false;
  }
  return admitted;
}

function validateCitationGranularitySemantics(
  value: ValidCitationShape,
  errors: string[],
): boolean {
  let admitted = true;
  if (value.discipline === "best-effort" && value.granularity !== "per-section") {
    errors.push("groundingPlan.citation.granularity must be per-section for best-effort citation");
    admitted = false;
  }
  if (
    value.discipline !== "best-effort" &&
    value.discipline !== "not-required" &&
    value.granularity !== "per-claim"
  ) {
    errors.push("groundingPlan.citation.granularity must be per-claim when citations are required");
    admitted = false;
  }
  return admitted;
}

function validateCitationSemantics(
  value: unknown,
  strategy: GroundingStrategy,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isValidCitationShape(value)) return true;
  admitted = validateNoGroundingCitationSemantics(value, strategy, errors) && admitted;
  admitted = validateGroundedCitationSemantics(value, strategy, errors) && admitted;
  admitted = validateCitationGranularitySemantics(value, errors) && admitted;
  return admitted;
}

function validateRecencySemantics(
  value: unknown,
  strategy: GroundingStrategy,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isValidRecency(value)) return true;
  // Compared against the producer's own output rather than a re-derived formula.
  const expected = buildRecency(value, strategy);
  if (
    value.requireAsOfDate !== expected.requireAsOfDate ||
    value.flagPotentiallyStale !== expected.flagPotentiallyStale
  ) {
    errors.push(
      "groundingPlan.recency must pair volatile data with as-of dates and strategy-appropriate stale flags",
    );
    admitted = false;
  }
  return admitted;
}

function validateNoAnswerSemantics(
  value: unknown,
  recency: unknown,
  strategy: GroundingStrategy,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isMemberArray(value, NO_ANSWER_CONDITIONS) || !isValidRecency(recency)) return true;
  if (!arraysEqual(value, buildNoAnswerConditions(strategy, recency))) {
    errors.push("groundingPlan.noAnswerConditions must match strategy and recency requirements");
    admitted = false;
  }
  return admitted;
}

function validateDirectiveSemantics(
  value: unknown,
  strategy: GroundingStrategy,
  required: boolean,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isMemberArray(value, GROUNDING_DIRECTIVES)) return true;
  const expected: readonly GroundingDirective[] = buildDirectives(strategy, required);
  if (!arraysEqual(value, expected)) {
    errors.push("groundingPlan.directives must match the selected strategy and requirement level");
    admitted = false;
  }
  return admitted;
}

function validateRagEvaluationSemantics(value: unknown, errors: string[]): boolean {
  let admitted = true;
  if (!isValidRagEvaluation(value) || value.length === 0) return true;
  const matchesTemplates =
    value.length === RAG_EVALUATION_DIMENSIONS.length &&
    value.every((entry, index) => {
      const dimension = RAG_EVALUATION_DIMENSIONS[index];
      return (
        dimension !== undefined &&
        entry.dimension === dimension &&
        entry.instruction === RAG_HINT_TEMPLATES[dimension]
      );
    });
  if (!matchesTemplates) {
    errors.push("groundingPlan.ragEvaluation must use the fixed RAG hint templates");
    admitted = false;
  }
  return admitted;
}

function validateGroundingPlanSemantics(value: Record<string, unknown>, errors: string[]): boolean {
  const admissions: boolean[] = [];
  const strategy = asGroundingStrategy(value.strategy);
  const required = typeof value.required === "boolean" ? value.required : undefined;
  if (strategy === undefined || required === undefined) return true;
  admissions.push(
    validateAllowedRetrievalModeSemantics(value.allowedRetrievalModes, strategy, errors),
    validateSourcePrioritySemantics(value.sourcePriority, strategy, required, errors),
    validateCitationSemantics(value.citation, strategy, errors),
    validateRecencySemantics(value.recency, strategy, errors),
    validateNoAnswerSemantics(value.noAnswerConditions, value.recency, strategy, errors),
    validateDirectiveSemantics(value.directives, strategy, required, errors),
    validateRagEvaluationSemantics(value.ragEvaluation, errors),
  );
  return admissions.every(Boolean);
}

function collectGroundingPlanErrors(value: unknown, errors: string[]): value is GroundingPlan {
  let admitted = true;
  if (!isRecord(value)) {
    errors.push("groundingPlan must be an object");
    return false;
  }
  admitted = validateExactKeys(value, GROUNDING_PLAN_KEYS, "groundingPlan", errors) && admitted;
  admitted = validateGroundingPlanScalars(value, errors) && admitted;
  admitted = validateGroundingPlanLists(value, errors) && admitted;
  admitted = validateSourcePriority(value.sourcePriority, errors) && admitted;
  admitted = validateCitation(value.citation, errors) && admitted;
  admitted = validateRecency(value.recency, errors) && admitted;
  admitted = validateRagEvaluation(value.ragEvaluation, errors) && admitted;
  admitted = validateGroundingPlanSemantics(value, errors) && admitted;
  return admitted;
}

export function validateGroundingPlan(input: unknown): PromptEnhancerValidation<GroundingPlan> {
  const errors: string[] = [];
  if (!collectGroundingPlanErrors(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Enhanced Prompt validator ───────────────────────────────────────────────────
function isBoundedStringList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const withinLimit = value.length <= ENHANCED_PROMPT_LIST_MAX;
  if (!withinLimit) return false;
  const extent: number = value.length;
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > ENHANCED_PROMPT_LIST_MAX)
    return false;
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = value[index];
    if (!isBoundedSafeText(entry, ENHANCED_PROMPT_FIELD_MAX_CHARS)) return false;
  }
  return true;
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

function admitsEnhancedPrompt(input: unknown, errors: string[]): input is EnhancedPrompt {
  if (!isRecord(input)) {
    errors.push("enhancedPrompt must be an object");
    return false;
  }
  const admissions: boolean[] = [];
  admissions.push(validateExactKeys(input, ENHANCED_PROMPT_KEYS, "enhancedPrompt", errors));
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`enhancedPrompt.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
    admissions.push(false);
  }
  admissions.push(
    pushIdError(input.promptId, "enhancedPrompt.promptId", "EnhancedPromptId", errors),
  );
  for (const field of ENHANCED_PROMPT_STRING_FIELDS) {
    if (!isBoundedSafeText(input[field], ENHANCED_PROMPT_FIELD_MAX_CHARS)) {
      errors.push(`enhancedPrompt.${field} must be a bounded, control-free string`);
      admissions.push(false);
    }
  }
  for (const field of ENHANCED_PROMPT_LIST_FIELDS) {
    if (!isBoundedStringList(input[field])) {
      errors.push(`enhancedPrompt.${field} must be a bounded array of control-free strings`);
      admissions.push(false);
    }
  }
  admissions.push(
    validateOutputSchema(input.outputSchema, errors),
    collectGroundingPlanErrors(input.groundingPlan, errors),
  );
  return admissions.every(Boolean);
}

export function validateEnhancedPrompt(input: unknown): PromptEnhancerValidation<EnhancedPrompt> {
  const errors: string[] = [];
  if (!admitsEnhancedPrompt(input, errors)) return { ok: false, errors };
  return { ok: true, value: input };
}

// ─── Candidate-critic validators (Issue #1312) ─────────────────────────────────────
const CRITIC_RATIONALE_MAX_CHARS = 2_000;
const CANDIDATE_ID_MAX_CHARS = 256;
const CANDIDATE_LIST_MAX = 64;

const SCORECARD_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "candidateId",
  "profile",
  "dimensionScores",
  "aggregateScore",
  "estimatedTokens",
]);
const DIMENSION_SCORE_KEYS: ReadonlySet<string> = new Set(["dimension", "score", "rationale"]);
const REJECTION_KEYS: ReadonlySet<string> = new Set([
  "candidateId",
  "profile",
  "aggregateScore",
  "reason",
]);
const SELECTION_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "winner",
  "ranked",
  "rankedPrompts",
  "winnerSafetyAssessment",
  "rankedSafetyAssessments",
  "rejected",
  "bounds",
  "iterations",
  "candidatesConsidered",
  "tokensConsumed",
]);
const BOUNDS_KEYS: ReadonlySet<string> = new Set([
  "candidateCount",
  "tokenBudget",
  "maxIterations",
]);

// A finite number within the closed unit interval [0, 1] — the legal range for every score.
const isUnitInterval = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// Validate the per-dimension scores array: exactly one entry per critic dimension, in canonical order.
function collectDimensionScoreErrors(
  value: unknown,
  errors: string[],
): value is readonly PromptCriticDimensionScore[] {
  let admitted = true;
  if (!Array.isArray(value) || value.length !== PROMPT_CRITIC_DIMENSIONS.length) {
    errors.push(
      `scorecard.dimensionScores must list all ${String(PROMPT_CRITIC_DIMENSIONS.length)} dimensions`,
    );
    return false;
  }
  PROMPT_CRITIC_DIMENSIONS.forEach((dimension, index) => {
    const entry: unknown = value[index];
    if (!isRecord(entry)) {
      errors.push(`scorecard.dimensionScores[${String(index)}] must be an object`);
      admitted = false;
      return false;
    }
    admitted =
      validateExactKeys(
        entry,
        DIMENSION_SCORE_KEYS,
        `scorecard.dimensionScores[${String(index)}]`,
        errors,
      ) && admitted;
    if (entry.dimension !== dimension) {
      errors.push(`scorecard.dimensionScores[${String(index)}].dimension must be "${dimension}"`);
      admitted = false;
    }
    if (!isUnitInterval(entry.score)) {
      errors.push(`scorecard.dimensionScores[${String(index)}].score must be a number in [0, 1]`);
      admitted = false;
    }
    if (!isBoundedSafeText(entry.rationale, CRITIC_RATIONALE_MAX_CHARS)) {
      errors.push(
        `scorecard.dimensionScores[${String(index)}].rationale must be a bounded, control-free string`,
      );
      admitted = false;
    }
  });
  return admitted;
}

function collectScorecardErrors(
  input: unknown,
  label: string,
  errors: string[],
): input is PromptCandidateScorecard {
  let admitted = true;
  if (!isRecord(input)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  admitted = validateExactKeys(input, SCORECARD_KEYS, label, errors) && admitted;
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`${label}.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
    admitted = false;
  }
  if (!isBoundedSafeText(input.candidateId, CANDIDATE_ID_MAX_CHARS)) {
    errors.push(`${label}.candidateId must be a bounded, control-free string`);
    admitted = false;
  }
  if (!isMember(input.profile, PROMPT_ENHANCEMENT_PROFILE_IDS)) {
    errors.push(`${label}.profile must be a known generation profile`);
    admitted = false;
  }
  admitted = collectDimensionScoreErrors(input.dimensionScores, errors) && admitted;
  if (!isUnitInterval(input.aggregateScore)) {
    errors.push(`${label}.aggregateScore must be a number in [0, 1]`);
    admitted = false;
  }
  if (!isNonNegativeInteger(input.estimatedTokens)) {
    errors.push(`${label}.estimatedTokens must be a non-negative integer`);
    admitted = false;
  }
  return admitted;
}

/**
 * Validate a `PromptCandidateScorecard`. Pure; returns a discriminated result and never throws.
 */
export function validatePromptCandidateScorecard(
  input: unknown,
): PromptEnhancerValidation<PromptCandidateScorecard> {
  try {
    const errors: string[] = [];
    if (!collectScorecardErrors(input, "scorecard", errors)) return { ok: false, errors };
    return { ok: true, value: input };
  } catch {
    return { ok: false, errors: ["payload could not be inspected"] };
  }
}

function collectRejectionErrors(
  value: unknown,
  index: number,
  errors: string[],
): value is PromptCandidateRejection {
  let admitted = true;
  const label = `selection.rejected[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  admitted = validateExactKeys(value, REJECTION_KEYS, label, errors) && admitted;
  if (!isBoundedSafeText(value.candidateId, CANDIDATE_ID_MAX_CHARS)) {
    errors.push(`${label}.candidateId must be a bounded, control-free string`);
    admitted = false;
  }
  if (!isMember(value.profile, PROMPT_ENHANCEMENT_PROFILE_IDS)) {
    errors.push(`${label}.profile must be a known generation profile`);
    admitted = false;
  }
  if (value.aggregateScore !== null && !isUnitInterval(value.aggregateScore)) {
    errors.push(`${label}.aggregateScore must be null or a number in [0, 1]`);
    admitted = false;
  }
  if (!isPromptCandidateRejectionReason(value.reason)) {
    errors.push(`${label}.reason must be a known rejection reason`);
    admitted = false;
  }
  return admitted;
}

function collectBoundsErrors(value: unknown, errors: string[]): value is PromptOptimizationBounds {
  let admitted = true;
  if (!isRecord(value)) {
    errors.push("selection.bounds must be an object");
    return false;
  }
  admitted = validateExactKeys(value, BOUNDS_KEYS, "selection.bounds", errors) && admitted;
  for (const field of ["candidateCount", "tokenBudget", "maxIterations"] as const) {
    if (!isPositiveInteger(value[field])) {
      errors.push(`selection.bounds.${field} must be a positive integer`);
      admitted = false;
    }
  }
  return admitted;
}

function getDimensionScore(
  card: PromptCandidateScorecard,
  dimension: PromptCriticDimension,
): number {
  return card.dimensionScores.find((entry) => entry.dimension === dimension)?.score ?? 0;
}

function getProfileRank(card: PromptCandidateScorecard): number {
  const index = PROMPT_ENHANCEMENT_PROFILE_IDS.indexOf(card.profile);
  return index < 0 ? PROMPT_ENHANCEMENT_PROFILE_IDS.length : index;
}

function compareRankedScorecards(a: PromptCandidateScorecard, b: PromptCandidateScorecard): number {
  const keys: readonly number[] = [
    b.aggregateScore - a.aggregateScore,
    getDimensionScore(b, "safety") - getDimensionScore(a, "safety"),
    getDimensionScore(b, "completeness") - getDimensionScore(a, "completeness"),
    getDimensionScore(b, "token-efficiency") - getDimensionScore(a, "token-efficiency"),
    getProfileRank(a) - getProfileRank(b),
  ];
  for (const key of keys) {
    if (key !== 0) return key < 0 ? -1 : 1;
  }
  return 0;
}

function sameDimensionScore(
  left: PromptCriticDimensionScore,
  right: PromptCriticDimensionScore,
): boolean {
  return (
    left.dimension === right.dimension &&
    left.score === right.score &&
    left.rationale === right.rationale
  );
}

function sameScorecard(left: PromptCandidateScorecard, right: PromptCandidateScorecard): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.profile === right.profile &&
    left.aggregateScore === right.aggregateScore &&
    left.estimatedTokens === right.estimatedTokens &&
    left.dimensionScores.length === right.dimensionScores.length &&
    left.dimensionScores.every((entry, index) => {
      const other = right.dimensionScores[index];
      return other !== undefined && sameDimensionScore(entry, other);
    })
  );
}

function sameSafetyFinding(
  left: PromptSafetyAssessment["findings"][number],
  right: PromptSafetyAssessment["findings"][number],
): boolean {
  return (
    left.code === right.code &&
    left.ruleId === right.ruleId &&
    left.severity === right.severity &&
    left.detail === right.detail
  );
}

function sameSafetyAssessment(
  left: PromptSafetyAssessment,
  right: PromptSafetyAssessment,
): boolean {
  return (
    left.promptId === right.promptId &&
    left.decision === right.decision &&
    left.requiresHumanReview === right.requiresHumanReview &&
    left.verificationStatus === right.verificationStatus &&
    arraysEqual(left.leastPrivilege, right.leastPrivilege) &&
    left.findings.length === right.findings.length &&
    left.findings.every((entry, index) => {
      const other = right.findings[index];
      return other !== undefined && sameSafetyFinding(entry, other);
    })
  );
}

function toValidScorecard(value: unknown): PromptCandidateScorecard | undefined {
  const result = validatePromptCandidateScorecard(value);
  return result.ok ? result.value : undefined;
}

function collectSafetyAssessmentErrors(
  value: unknown,
  label: string,
  errors: string[],
): PromptSafetyAssessment | undefined {
  const result = validatePromptSafetyAssessment(value);
  if (!result.ok) {
    errors.push(`${label} must be a valid PromptSafetyAssessment`);
    return undefined;
  }
  return result.value;
}

function collectRankedMembers(ranked: readonly unknown[], errors: string[]): boolean {
  let admitted = true;
  const extent: number = ranked.length;
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > CANDIDATE_LIST_MAX) {
    errors.push(`selection.ranked must contain at most ${String(CANDIDATE_LIST_MAX)} entries`);
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = ranked[index];
    admitted =
      collectScorecardErrors(entry, `selection.ranked[${String(index)}]`, errors) && admitted;
    if (!(index in ranked)) break;
  }
  return admitted;
}

function collectRankedErrors(
  ranked: unknown,
  winner: unknown,
  errors: string[],
): ranked is readonly PromptCandidateScorecard[] {
  const admissions: boolean[] = [];
  if (!Array.isArray(ranked) || ranked.length === 0) {
    errors.push("selection.ranked must be a non-empty array");
    return false;
  }
  if (ranked.length > CANDIDATE_LIST_MAX) {
    errors.push(`selection.ranked must contain at most ${String(CANDIDATE_LIST_MAX)} entries`);
    return false;
  }
  admissions.push(collectRankedMembers(ranked, errors));
  const winnerId = isRecord(winner) ? winner.candidateId : undefined;
  const firstRanked: unknown = ranked[0];
  if (isRecord(firstRanked) && firstRanked.candidateId !== winnerId) {
    errors.push("selection.winner must be the first ranked candidate");
    admissions.push(false);
  }
  const firstScorecard = toValidScorecard(firstRanked);
  const winnerScorecard = toValidScorecard(winner);
  if (
    firstScorecard !== undefined &&
    winnerScorecard !== undefined &&
    !sameScorecard(winnerScorecard, firstScorecard)
  ) {
    errors.push("selection.winner must exactly match the first ranked candidate");
    admissions.push(false);
  }
  const scorecards = ranked.map((entry: unknown) => toValidScorecard(entry));
  scorecards.forEach((entry, index) => {
    const next = scorecards[index + 1];
    if (entry !== undefined && next !== undefined && compareRankedScorecards(entry, next) > 0) {
      errors.push("selection.ranked must be sorted in deterministic rank order");
      admissions.push(false);
    }
  });
  return admissions.every(Boolean);
}

function collectRankedPromptMember(
  entry: unknown,
  index: number,
  ranked: unknown,
  errors: string[],
): boolean {
  const result = validateEnhancedPrompt(entry);
  if (!result.ok) {
    errors.push(`selection.rankedPrompts[${String(index)}] must be a valid EnhancedPrompt`);
    return false;
  }
  const rankedEntry = Array.isArray(ranked) ? toValidScorecard(ranked[index]) : undefined;
  if (rankedEntry !== undefined && result.value.promptId !== rankedEntry.candidateId) {
    errors.push(
      `selection.rankedPrompts[${String(index)}].promptId must match the ranked candidateId`,
    );
    return false;
  }
  return true;
}

function collectRankedPromptErrors(
  ranked: unknown,
  rankedPrompts: unknown,
  errors: string[],
): rankedPrompts is readonly EnhancedPrompt[] {
  const admissions: boolean[] = [];
  if (!Array.isArray(rankedPrompts)) {
    errors.push("selection.rankedPrompts must be an array");
    return false;
  }
  if (Array.isArray(ranked) && rankedPrompts.length !== ranked.length) {
    errors.push("selection.rankedPrompts must match selection.ranked length");
    admissions.push(false);
  }
  const extent: number = rankedPrompts.length;
  if (!Number.isSafeInteger(extent) || extent < 0) {
    errors.push("selection.rankedPrompts must be an array");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = rankedPrompts[index];
    admissions.push(collectRankedPromptMember(entry, index, ranked, errors));
    if (!(index in rankedPrompts)) break;
  }
  return admissions.every(Boolean);
}

interface PromptSafetyAssessmentCollection {
  admitted: boolean;
  values: readonly (PromptSafetyAssessment | undefined)[];
}

function collectRankedSafetyAssessmentListErrors(
  ranked: unknown,
  assessments: unknown,
  errors: string[],
): PromptSafetyAssessmentCollection {
  if (!Array.isArray(assessments)) {
    errors.push("selection.rankedSafetyAssessments must be an array");
    return { admitted: false, values: [] };
  }
  let admitted = true;
  if (Array.isArray(ranked) && assessments.length !== ranked.length) {
    errors.push("selection.rankedSafetyAssessments must match selection.ranked length");
    admitted = false;
  }
  const members = collectAssessmentMembers(assessments, errors);
  admitted = members.admitted && admitted;
  members.values.forEach((assessment, index) => {
    if (assessment === undefined) return;
    if (assessment.decision === "rejected") {
      errors.push("selection.rankedSafetyAssessments must not include rejected assessments");
      admitted = false;
    }
    const rankedEntry = Array.isArray(ranked) ? toValidScorecard(ranked[index]) : undefined;
    if (rankedEntry !== undefined && assessment.promptId !== rankedEntry.candidateId) {
      errors.push(
        `selection.rankedSafetyAssessments[${String(index)}].promptId must match the ranked candidateId`,
      );
      admitted = false;
    }
  });
  return { admitted, values: members.values };
}

function collectAssessmentMembers(
  assessments: readonly unknown[],
  errors: string[],
): PromptSafetyAssessmentCollection {
  const values: (PromptSafetyAssessment | undefined)[] = [];
  const extent = assessments.length;
  if (!Number.isSafeInteger(extent) || extent < 0) {
    errors.push("selection.rankedSafetyAssessments must be an array");
    return { admitted: false, values };
  }
  let admitted = true;
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = assessments[index];
    const assessment = collectSafetyAssessmentErrors(
      entry,
      `selection.rankedSafetyAssessments[${String(index)}]`,
      errors,
    );
    if (assessment === undefined) admitted = false;
    values.push(assessment);
    if (!(index in assessments)) break;
  }
  return { admitted, values };
}

function collectWinnerSafetyAssessmentErrors(
  input: Record<string, unknown>,
  firstAssessment: PromptSafetyAssessment | undefined,
  errors: string[],
): boolean {
  let admitted = true;
  const winnerAssessment = collectSafetyAssessmentErrors(
    input.winnerSafetyAssessment,
    "selection.winnerSafetyAssessment",
    errors,
  );
  if (
    winnerAssessment !== undefined &&
    firstAssessment !== undefined &&
    !sameSafetyAssessment(winnerAssessment, firstAssessment)
  ) {
    errors.push("selection.winnerSafetyAssessment must exactly match the first ranked assessment");
    admitted = false;
  }
  if (winnerAssessment === undefined) admitted = false;
  const winner = toValidScorecard(input.winner);
  if (
    winner !== undefined &&
    winnerAssessment !== undefined &&
    winnerAssessment.promptId !== winner.candidateId
  ) {
    errors.push(
      "selection.winnerSafetyAssessment.promptId must match selection.winner.candidateId",
    );
    admitted = false;
  }
  return admitted;
}

function collectRankedSafetyAssessmentErrors(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let admitted = true;
  const assessmentReceipt = collectRankedSafetyAssessmentListErrors(
    input.ranked,
    input.rankedSafetyAssessments,
    errors,
  );
  admitted = assessmentReceipt.admitted && admitted;
  admitted =
    collectWinnerSafetyAssessmentErrors(input, assessmentReceipt.values[0], errors) && admitted;
  return admitted;
}

function collectRejectedListErrors(
  rejected: unknown,
  errors: string[],
): rejected is readonly PromptCandidateRejection[] {
  let admitted = true;
  if (!Array.isArray(rejected) || rejected.length > CANDIDATE_LIST_MAX) {
    errors.push(
      `selection.rejected must be an array of at most ${String(CANDIDATE_LIST_MAX)} entries`,
    );
    return false;
  }
  const extent: number = rejected.length;
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > CANDIDATE_LIST_MAX) {
    errors.push(
      `selection.rejected must be an array of at most ${String(CANDIDATE_LIST_MAX)} entries`,
    );
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = rejected[index];
    admitted = collectRejectionErrors(entry, index, errors) && admitted;
    if (!(index in rejected)) break;
  }
  return admitted;
}

function collectSelectionCounterErrors(input: Record<string, unknown>, errors: string[]): boolean {
  let admitted = true;
  for (const field of ["iterations", "candidatesConsidered", "tokensConsumed"] as const) {
    if (!isNonNegativeInteger(input[field])) {
      errors.push(`selection.${field} must be a non-negative integer`);
      admitted = false;
    }
  }
  return admitted;
}

function collectExceededBoundError(
  value: unknown,
  bound: unknown,
  message: string,
  errors: string[],
): boolean {
  let admitted = true;
  if (isNonNegativeInteger(value) && isPositiveInteger(bound) && value > bound) {
    errors.push(message);
    admitted = false;
  }
  return admitted;
}

function collectSelectionBoundUsageErrors(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let admitted = true;
  if (!isRecord(input.bounds)) return true;
  admitted =
    collectExceededBoundError(
      input.iterations,
      input.bounds.maxIterations,
      "selection.iterations must not exceed selection.bounds.maxIterations",
      errors,
    ) && admitted;
  admitted =
    collectExceededBoundError(
      input.candidatesConsidered,
      input.bounds.candidateCount,
      "selection.candidatesConsidered must not exceed selection.bounds.candidateCount",
      errors,
    ) && admitted;
  admitted =
    collectExceededBoundError(
      input.tokensConsumed,
      input.bounds.tokenBudget,
      "selection.tokensConsumed must not exceed selection.bounds.tokenBudget",
      errors,
    ) && admitted;
  return admitted;
}

function collectCandidatesConsideredErrors(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let admitted = true;
  if (
    Array.isArray(input.ranked) &&
    isNonNegativeInteger(input.candidatesConsidered) &&
    input.candidatesConsidered !== input.ranked.length
  ) {
    errors.push("selection.candidatesConsidered must equal selection.ranked.length");
    admitted = false;
  }
  return admitted;
}

function admitsPromptCandidateSelection(
  input: unknown,
  errors: string[],
): input is PromptCandidateSelection {
  if (!isRecord(input)) {
    errors.push("selection must be an object");
    return false;
  }
  const admissions: boolean[] = [];
  admissions.push(validateExactKeys(input, SELECTION_KEYS, "selection", errors));
  if (input.schemaVersion !== PROMPT_ENHANCER_SCHEMA_VERSION) {
    errors.push(`selection.schemaVersion must be "${PROMPT_ENHANCER_SCHEMA_VERSION}"`);
    admissions.push(false);
  }
  admissions.push(
    collectScorecardErrors(input.winner, "selection.winner", errors),
    collectRankedErrors(input.ranked, input.winner, errors),
    collectRankedPromptErrors(input.ranked, input.rankedPrompts, errors),
    collectRankedSafetyAssessmentErrors(input, errors),
    collectRejectedListErrors(input.rejected, errors),
    collectBoundsErrors(input.bounds, errors),
    collectSelectionCounterErrors(input, errors),
    collectSelectionBoundUsageErrors(input, errors),
    collectCandidatesConsideredErrors(input, errors),
  );
  return admissions.every(Boolean);
}
/**
 * Validate a `PromptCandidateSelection`. Pure; returns a discriminated result and never throws. Checks
 * structural well-formedness and the cross-field invariants that make the result auditable: the winner
 * is the first ranked entry, every ranked scorecard is well-formed, and the considered/consumed totals
 * are non-negative integers within the declared bounds.
 */
export function validatePromptCandidateSelection(
  input: unknown,
): PromptEnhancerValidation<PromptCandidateSelection> {
  try {
    const errors: string[] = [];
    if (!admitsPromptCandidateSelection(input, errors)) return { ok: false, errors };
    return { ok: true, value: input };
  } catch {
    return { ok: false, errors: ["payload could not be inspected"] };
  }
}
