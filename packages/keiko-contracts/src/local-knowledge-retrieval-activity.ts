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

const PII_LIKE_RE =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}[- ]?\d{2}[- ]?\d{4}\b|\b(?:\+?\d[\d .()-]{7,}\d)\b)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return isKnowledgePodEvidenceSafeText(value) && !PII_LIKE_RE.test(value);
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
