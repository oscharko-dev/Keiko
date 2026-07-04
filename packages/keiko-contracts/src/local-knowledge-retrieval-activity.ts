import type { CapsuleSetId, KnowledgeCapsuleId, KnowledgeSourceId } from "./local-knowledge.js";
import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";
import { isKnowledgePodEvidenceSafeText } from "./local-knowledge-pods.js";

export const KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION = "1" as const;

export const KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_STATES = [
  "searched",
  "skipped",
  "degraded",
  "denied",
  "unavailable",
  "not-selected",
] as const;

export type KnowledgePodRetrievalActivityState =
  (typeof KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_STATES)[number];

export const KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_MODES = [
  "lexical",
  "vector",
  "hybrid",
  "reranked",
  "local-only",
  "sealed",
  "remote",
  "federated",
] as const;

export type KnowledgePodRetrievalActivityMode =
  (typeof KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_MODES)[number];

export const KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_REASON_CODES = [
  "selected-for-search",
  "searched",
  "not-selected",
  "source-skipped",
  "scope-not-ready",
  "indexing-in-progress",
  "stale-capsule",
  "retrieval-failure",
  "no-scope",
  "no-vectors",
  "incompatible-embedding-identity",
  "dense-scan-too-large",
  "below-min-score",
  "answer-grounding-rejected",
  "no-evidence-stated",
  "no-evidence",
  "empty-query",
  "empty-answer",
  "embedding-failed",
  "embedding-unavailable",
  "reranker-unavailable",
  "reranker-invalid-response",
  "policy-denied",
  "capability-missing",
  "remote-unavailable",
  "pack-validation-failed",
  "max-sources-exceeded",
] as const;

export type KnowledgePodRetrievalActivityReasonCode =
  (typeof KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_REASON_CODES)[number];

export interface KnowledgePodRetrievalActivityPrivacy {
  readonly localFirst: true;
  readonly rawContentExposed: false;
  readonly rawQueryExposed: false;
  readonly privatePathsExposed: false;
  readonly directVectorScoreComparison: false;
}

export interface KnowledgePodRetrievalActivitySummary {
  readonly searchedCount: number;
  readonly skippedCount: number;
  readonly degradedCount: number;
  readonly deniedCount: number;
  readonly unavailableCount: number;
  readonly notSelectedCount: number;
  readonly denseCandidateCount: number;
  readonly lexicalCandidateCount: number;
  readonly fusedCandidateCount: number;
  readonly referenceCount: number;
  readonly citationCount: number;
}

export interface KnowledgePodRetrievalActivityPodCounts {
  readonly sourceCount: number;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly vectorCount: number;
  readonly referenceCount: number;
  readonly citationCount: number;
}

export interface KnowledgePodRetrievalActivityPod {
  readonly podId: KnowledgeCapsuleId | CapsuleSetId;
  readonly podKind: "pod" | "pod-set";
  readonly displayName: string;
  readonly state: KnowledgePodRetrievalActivityState;
  readonly modes: readonly KnowledgePodRetrievalActivityMode[];
  readonly reasonCodes: readonly KnowledgePodRetrievalActivityReasonCode[];
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly counts: KnowledgePodRetrievalActivityPodCounts;
}

export interface KnowledgePodRetrievalActivity {
  readonly schemaVersion: typeof KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION;
  readonly summary: KnowledgePodRetrievalActivitySummary;
  readonly privacy: KnowledgePodRetrievalActivityPrivacy;
  readonly pods: readonly KnowledgePodRetrievalActivityPod[];
}

const ACTIVITY_KEYS = ["schemaVersion", "summary", "privacy", "pods"] as const;
const SUMMARY_KEYS = [
  "searchedCount",
  "skippedCount",
  "degradedCount",
  "deniedCount",
  "unavailableCount",
  "notSelectedCount",
  "denseCandidateCount",
  "lexicalCandidateCount",
  "fusedCandidateCount",
  "referenceCount",
  "citationCount",
] as const;
const PRIVACY_KEYS = [
  "localFirst",
  "rawContentExposed",
  "rawQueryExposed",
  "privatePathsExposed",
  "directVectorScoreComparison",
] as const;
const POD_KEYS = [
  "podId",
  "podKind",
  "displayName",
  "state",
  "modes",
  "reasonCodes",
  "sourceIds",
  "counts",
] as const;
const POD_COUNT_KEYS = [
  "sourceCount",
  "documentCount",
  "chunkCount",
  "vectorCount",
  "referenceCount",
  "citationCount",
] as const;
const POD_KINDS = ["pod", "pod-set"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiAlphaNumericCode(code: number): boolean {
  return isAsciiLetterCode(code) || isAsciiDigitCode(code);
}

function isEmailLocalCode(code: number): boolean {
  return (
    isAsciiAlphaNumericCode(code) ||
    code === 37 ||
    code === 43 ||
    code === 45 ||
    code === 46 ||
    code === 95
  );
}

function isEmailDomainCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 45 || code === 46;
}

function hasEmailDomainSuffix(value: string, start: number, end: number): boolean {
  let finalDot = -1;
  for (let i = start; i < end; i += 1) {
    if (value.charCodeAt(i) === 46) finalDot = i;
  }
  if (finalDot <= start || end - finalDot - 1 < 2) return false;
  for (let i = finalDot + 1; i < end; i += 1) {
    if (!isAsciiLetterCode(value.charCodeAt(i))) return false;
  }
  return true;
}

function containsEmailLikeText(value: string): boolean {
  for (let at = 1; at < value.length - 3; at += 1) {
    if (value.charCodeAt(at) !== 64) continue;
    let localStart = at;
    while (localStart > 0 && isEmailLocalCode(value.charCodeAt(localStart - 1))) localStart -= 1;
    if (localStart === at) continue;
    let domainEnd = at + 1;
    while (domainEnd < value.length && isEmailDomainCode(value.charCodeAt(domainEnd))) {
      domainEnd += 1;
    }
    if (hasEmailDomainSuffix(value, at + 1, domainEnd)) return true;
  }
  return false;
}

function skipOptionalSsnSeparator(value: string, index: number): number {
  const code = value.charCodeAt(index);
  return code === 32 || code === 45 ? index + 1 : index;
}

function hasDigitsAt(value: string, start: number, count: number): boolean {
  if (start + count > value.length) return false;
  for (let i = start; i < start + count; i += 1) {
    if (!isAsciiDigitCode(value.charCodeAt(i))) return false;
  }
  return true;
}

function isDigitBoundary(value: string, index: number): boolean {
  return index < 0 || index >= value.length || !isAsciiDigitCode(value.charCodeAt(index));
}

function containsSsnLikeText(value: string): boolean {
  for (let start = 0; start <= value.length - 9; start += 1) {
    if (!isDigitBoundary(value, start - 1) || !hasDigitsAt(value, start, 3)) continue;
    let index = skipOptionalSsnSeparator(value, start + 3);
    if (!hasDigitsAt(value, index, 2)) continue;
    index = skipOptionalSsnSeparator(value, index + 2);
    if (hasDigitsAt(value, index, 4) && isDigitBoundary(value, index + 4)) return true;
  }
  return false;
}

function isPhoneBodyCode(code: number): boolean {
  return (
    isAsciiDigitCode(code) ||
    code === 32 ||
    code === 40 ||
    code === 41 ||
    code === 45 ||
    code === 46
  );
}

function scanPhoneLikeText(value: string, start: number): boolean {
  let digits = 0;
  let lastWasDigit = false;
  const first = value.charCodeAt(start);
  let index = first === 43 ? start + 1 : start;
  for (; index < value.length && isPhoneBodyCode(value.charCodeAt(index)); index += 1) {
    lastWasDigit = isAsciiDigitCode(value.charCodeAt(index));
    if (lastWasDigit) digits += 1;
  }
  return digits >= 8 && lastWasDigit && isDigitBoundary(value, index);
}

function containsPhoneLikeText(value: string): boolean {
  for (let start = 0; start < value.length; start += 1) {
    const code = value.charCodeAt(start);
    if ((code === 43 || isAsciiDigitCode(code)) && isDigitBoundary(value, start - 1)) {
      if (scanPhoneLikeText(value, start)) return true;
    }
  }
  return false;
}

function containsPiiLikeText(value: string): boolean {
  return containsEmailLikeText(value) || containsSsnLikeText(value) || containsPhoneLikeText(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  errors: string[],
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      errors.push(`${field} must not include ${key}`);
      return;
    }
  }
}

function isSafeActivityText(value: unknown): value is string {
  return isKnowledgePodEvidenceSafeText(value) && !containsPiiLikeText(value);
}

export function isKnowledgePodRetrievalActivitySafeText(value: unknown): value is string {
  return isSafeActivityText(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateNonNegativeInteger(value: unknown, field: string, errors: string[]): void {
  if (!isNonNegativeInteger(value)) errors.push(`${field} must be a non-negative integer`);
}

function validateSummary(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("summary must be an object");
    return;
  }
  onlyKeys(value, SUMMARY_KEYS, "summary", errors);
  for (const key of SUMMARY_KEYS) {
    validateNonNegativeInteger(value[key], `summary.${key}`, errors);
  }
}

function validatePrivacy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("privacy must be an object");
    return;
  }
  onlyKeys(value, PRIVACY_KEYS, "privacy", errors);
  if (
    value.localFirst !== true ||
    value.rawContentExposed !== false ||
    value.rawQueryExposed !== false ||
    value.privatePathsExposed !== false ||
    value.directVectorScoreComparison !== false
  ) {
    errors.push("privacy must preserve the retrieval activity redaction posture");
  }
}

function validateEnumArray(
  value: unknown,
  allowed: readonly string[],
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
    return;
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      errors.push(`${field} entries are invalid`);
      return;
    }
  }
}

function validateSourceIds(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("pod.sourceIds must be an array");
    return;
  }
  for (const entry of value) {
    if (!isSafeActivityText(entry)) {
      errors.push("pod.sourceIds entries must be evidence-safe strings");
      return;
    }
  }
}

function validatePodCounts(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("pod.counts must be an object");
    return;
  }
  onlyKeys(value, POD_COUNT_KEYS, "pod.counts", errors);
  for (const key of POD_COUNT_KEYS) {
    validateNonNegativeInteger(value[key], `pod.counts.${key}`, errors);
  }
}

function validatePod(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("pod must be an object");
    return;
  }
  onlyKeys(value, POD_KEYS, "pod", errors);
  if (!isSafeActivityText(value.podId)) errors.push("pod.podId must be evidence-safe");
  if (typeof value.podKind !== "string" || !POD_KINDS.includes(value.podKind as never)) {
    errors.push("pod.podKind is invalid");
  }
  if (!isSafeActivityText(value.displayName)) {
    errors.push("pod.displayName must be evidence-safe");
  }
  if (
    typeof value.state !== "string" ||
    !KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_STATES.includes(value.state as never)
  ) {
    errors.push("pod.state is invalid");
  }
  validateEnumArray(value.modes, KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_MODES, "pod.modes", errors);
  validateEnumArray(
    value.reasonCodes,
    KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_REASON_CODES,
    "pod.reasonCodes",
    errors,
  );
  validateSourceIds(value.sourceIds, errors);
  validatePodCounts(value.counts, errors);
}

export function validateKnowledgePodRetrievalActivity(
  input: unknown,
): LocalKnowledgeValidation<KnowledgePodRetrievalActivity> {
  if (!isRecord(input)) return { ok: false, errors: ["activity must be an object"] };
  const errors: string[] = [];
  onlyKeys(input, ACTIVITY_KEYS, "activity", errors);
  if (input.schemaVersion !== KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION) {
    errors.push("activity.schemaVersion is invalid");
  }
  validateSummary(input.summary, errors);
  validatePrivacy(input.privacy, errors);
  if (!Array.isArray(input.pods)) {
    errors.push("activity.pods must be an array");
  } else {
    for (const pod of input.pods) validatePod(pod, errors);
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: input as unknown as KnowledgePodRetrievalActivity };
}
