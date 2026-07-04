// User-facing Knowledge Pods projection contracts for Epic #1815.
//
// This module is a compatibility layer over the existing Local Knowledge contracts. It does not
// rename persisted state, add a retrieval store, or change ranking behavior. The summary shape is
// intentionally redacted: product labels plus counts, lifecycle/readiness, retrieval capabilities,
// privacy posture, and compatibility lineage. It carries no document bodies, source paths, prompts,
// endpoints, credentials, vectors, or raw evidence.

import type {
  CapsuleLifecycleState,
  CapsuleSetId,
  EmbeddingVectorMetric,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  KnowledgeSourceScopeKind,
} from "./local-knowledge.js";
import {
  CAPSULE_LIFECYCLE_STATES,
  EMBEDDING_VECTOR_METRICS,
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
} from "./local-knowledge.js";
import {
  isSafeDisplaySummary,
  type LocalKnowledgeValidation,
} from "./local-knowledge-validation.js";

export const KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION = "1" as const;

export type KnowledgePodSummaryKind = "pod" | "pod-set";
export type KnowledgePodBackingKind = "knowledge-capsule" | "capsule-set";
export type KnowledgePodReadiness =
  "draft" | "indexing" | "ready" | "stale" | "degraded" | "unavailable" | "error";
export type KnowledgePodSourceKind = KnowledgeSourceScopeKind | "remote" | "policy" | "unknown";
export type KnowledgePodEvidenceMode = "counts-hashes-and-status";
export type KnowledgePodLocationKind = "local" | "remote" | "federated";
export type KnowledgePodSealingPosture =
  "local-store-policy" | "sealed-pod-policy" | "not-declared";
export type KnowledgePodPolicyPosture = "none" | "policy-pack" | "not-declared";

export interface KnowledgePodCounts {
  readonly capsuleCount: number;
  readonly sourceCount: number;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly vectorCount: number;
}

export interface KnowledgePodRetrievalCapabilities {
  readonly lexicalIndex: boolean;
  readonly vectorIndex: boolean;
  readonly hybridGrounding: boolean;
  readonly crossSpaceScoreMixing: false;
  readonly embeddingProvider?: string;
  readonly embeddingModelId?: string;
  readonly embeddingSpaceFingerprint?: string;
  readonly vectorDimensions?: number;
  readonly vectorMetric?: EmbeddingVectorMetric;
}

export interface KnowledgePodPrivacySummary {
  readonly localFirst: true;
  readonly modelOpen: true;
  readonly rawContentExposed: false;
  readonly privatePathsExposed: false;
  readonly evidenceMode: KnowledgePodEvidenceMode;
  readonly storageLocation: "local-runtime-state";
}

export interface KnowledgePodGovernanceSummary {
  readonly locationKind: KnowledgePodLocationKind;
  readonly sealingPosture: KnowledgePodSealingPosture;
  readonly policyPosture: KnowledgePodPolicyPosture;
  readonly managedServiceDependency: boolean;
}

export interface KnowledgePodCompatibilitySummary {
  readonly backingKind: KnowledgePodBackingKind;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly localKnowledgeSchemaVersion: typeof LOCAL_KNOWLEDGE_SCHEMA_VERSION;
  readonly migrationRequired: false;
  readonly persistedStateRenamed: false;
}

export interface KnowledgePodSummary {
  readonly schemaVersion: typeof KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION;
  readonly id: KnowledgeCapsuleId | CapsuleSetId;
  readonly kind: KnowledgePodSummaryKind;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly readiness: KnowledgePodReadiness;
  readonly lifecycleState?: CapsuleLifecycleState;
  readonly counts: KnowledgePodCounts;
  readonly sourceKinds: readonly KnowledgePodSourceKind[];
  readonly retrieval: KnowledgePodRetrievalCapabilities;
  readonly privacy: KnowledgePodPrivacySummary;
  readonly governance: KnowledgePodGovernanceSummary;
  readonly compatibility: KnowledgePodCompatibilitySummary;
  readonly updatedAt: number;
  readonly degradationReasons: readonly string[];
}

export interface LocalKnowledgeCapsuleListEntry {
  readonly id: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly lifecycleState: CapsuleLifecycleState;
  readonly sourceCount: number;
  readonly updatedAt: number;
}

export interface LocalKnowledgeCapsulesResponse {
  readonly capsules: readonly LocalKnowledgeCapsuleListEntry[];
  readonly knowledgePods?: readonly KnowledgePodSummary[];
}

export interface LocalKnowledgeCapsuleSetListEntry {
  readonly id: CapsuleSetId;
  readonly displayName: string;
  readonly capsuleCount: number;
  readonly composedAt: number;
}

export interface LocalKnowledgeCapsuleSetsResponse {
  readonly capsuleSets: readonly LocalKnowledgeCapsuleSetListEntry[];
  readonly knowledgePods?: readonly KnowledgePodSummary[];
}

const SUMMARY_KEYS = [
  "schemaVersion",
  "id",
  "kind",
  "displayName",
  "description",
  "tags",
  "readiness",
  "lifecycleState",
  "counts",
  "sourceKinds",
  "retrieval",
  "privacy",
  "governance",
  "compatibility",
  "updatedAt",
  "degradationReasons",
] as const;

const COUNT_KEYS = ["capsuleCount", "sourceCount", "documentCount", "chunkCount", "vectorCount"];
const RETRIEVAL_KEYS = [
  "lexicalIndex",
  "vectorIndex",
  "hybridGrounding",
  "crossSpaceScoreMixing",
  "embeddingProvider",
  "embeddingModelId",
  "embeddingSpaceFingerprint",
  "vectorDimensions",
  "vectorMetric",
] as const;
const PRIVACY_KEYS = [
  "localFirst",
  "modelOpen",
  "rawContentExposed",
  "privatePathsExposed",
  "evidenceMode",
  "storageLocation",
] as const;
const GOVERNANCE_KEYS = [
  "locationKind",
  "sealingPosture",
  "policyPosture",
  "managedServiceDependency",
] as const;
const COMPATIBILITY_KEYS = [
  "backingKind",
  "capsuleIds",
  "sourceIds",
  "localKnowledgeSchemaVersion",
  "migrationRequired",
  "persistedStateRenamed",
] as const;

const READINESS: readonly KnowledgePodReadiness[] = [
  "draft",
  "indexing",
  "ready",
  "stale",
  "degraded",
  "unavailable",
  "error",
];
const KINDS: readonly KnowledgePodSummaryKind[] = ["pod", "pod-set"];
const BACKINGS: readonly KnowledgePodBackingKind[] = ["knowledge-capsule", "capsule-set"];
const LOCATION_KINDS: readonly KnowledgePodLocationKind[] = ["local", "remote", "federated"];
const SEALING_POSTURES: readonly KnowledgePodSealingPosture[] = [
  "local-store-policy",
  "sealed-pod-policy",
  "not-declared",
];
const POLICY_POSTURES: readonly KnowledgePodPolicyPosture[] = [
  "none",
  "policy-pack",
  "not-declared",
];
const SOURCE_KINDS: readonly KnowledgePodSourceKind[] = [
  "folder",
  "repository",
  "files",
  "remote",
  "policy",
  "unknown",
];

const ABSOLUTE_PATH_RE = /(?:^|[[\s("'`<{}])(?:~[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>)]*/u;
const SCHEME_ENDPOINT_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const SCHEME_RELATIVE_ENDPOINT_RE = /(?:^|[\s("'`<{}])\/\/[^\s"'`<>)]/u;
const HOST_ENDPOINT_RE =
  /(?:^|[\s("'`<{}])(?:localhost|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#]|$)/iu;
const USERINFO_ENDPOINT_RE = /[^\s"'`<>@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d{1,5})?(?:[/?#]|$)/iu;
const SECRET_RE =
  /(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|xox[baprs]-|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?KEY)/u;
const TOKEN_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "bearer_token",
  "client_secret",
  "credential",
  "credentials",
  "id_token",
  "password",
  "refresh_token",
  "secret",
  "session_token",
  "token",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  errors: string[],
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) {
      errors.push(`${field} must not include ${key}`);
      return;
    }
  }
}

function isUrlTerminator(char: string): boolean {
  return char.trim().length === 0 || "\"'`()<>".includes(char);
}

function findUrlEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && !isUrlTerminator(value.charAt(end))) {
    end += 1;
  }
  return end;
}

function containsTokenParameterKey(value: string): boolean {
  return containsTokenKeyAfter(value, "?") || containsTokenKeyAfter(value, "#");
}

function containsTokenKeyAfter(value: string, separator: "?" | "#"): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const start = value.indexOf(separator, searchFrom);
    if (start === -1) return false;
    const end = findUrlEnd(value, start + 1);
    const query = value.slice(start + 1, end);
    if (queryHasTokenKey(query)) return true;
    searchFrom = Math.max(end, start + 1);
  }
  return false;
}

function queryHasTokenKey(query: string): boolean {
  for (const part of query.split(/[&;]/u)) {
    const key = part.split("=", 1)[0]?.trim();
    if (key !== undefined && queryKeyContainsTokenName(key)) return true;
  }
  return false;
}

function queryKeyContainsTokenName(key: string): boolean {
  const decoded = safeDecodeUriComponent(key)
    .toLowerCase()
    .replace(/[-.\s]+/gu, "_");
  return decoded.split(/(?:\[|\])/u).some((part) => {
    if (TOKEN_QUERY_KEYS.has(part)) return true;
    return part.includes("token") || part.includes("secret") || part.includes("credential");
  });
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
}

function containsEndpointLikeText(value: string): boolean {
  return (
    SCHEME_ENDPOINT_RE.test(value) ||
    SCHEME_RELATIVE_ENDPOINT_RE.test(value) ||
    HOST_ENDPOINT_RE.test(value) ||
    USERINFO_ENDPOINT_RE.test(value)
  );
}

function isSafePodText(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.trim().length === 0) return false;
  return (
    isSafeDisplaySummary(value) &&
    !ABSOLUTE_PATH_RE.test(value) &&
    !SECRET_RE.test(value) &&
    !containsTokenParameterKey(value) &&
    !containsEndpointLikeText(value)
  );
}

export function isKnowledgePodEvidenceSafeText(value: unknown): value is string {
  return isSafePodText(value, false);
}

function validateSafeTextArray(
  value: unknown,
  field: string,
  errors: string[],
  allowEmpty: boolean,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (const entry of value) {
    if (!isSafePodText(entry, allowEmpty)) {
      errors.push(`${field} entries must be evidence-safe strings`);
      return;
    }
  }
}

function validateCounts(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("counts must be an object");
    return;
  }
  onlyKeys(value, COUNT_KEYS, "counts", errors);
  for (const key of COUNT_KEYS) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      errors.push(`counts.${key} must be a non-negative integer`);
      return;
    }
  }
}

function validateRetrieval(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("retrieval must be an object");
    return;
  }
  onlyKeys(value, RETRIEVAL_KEYS, "retrieval", errors);
  for (const key of ["lexicalIndex", "vectorIndex", "hybridGrounding"] as const) {
    if (typeof value[key] !== "boolean") errors.push(`retrieval.${key} must be a boolean`);
  }
  if (value.crossSpaceScoreMixing !== false) {
    errors.push("retrieval.crossSpaceScoreMixing must be false");
  }
  validateOptionalSafeText(value.embeddingProvider, "retrieval.embeddingProvider", errors);
  validateOptionalSafeText(value.embeddingModelId, "retrieval.embeddingModelId", errors);
  validateOptionalSafeText(
    value.embeddingSpaceFingerprint,
    "retrieval.embeddingSpaceFingerprint",
    errors,
  );
  validateVectorDimensions(value.vectorDimensions, errors);
  validateVectorMetric(value.vectorMetric, errors);
}

function validateVectorDimensions(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return;
  errors.push("retrieval.vectorDimensions must be a positive integer when set");
}

function validateVectorMetric(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (
    typeof value === "string" &&
    EMBEDDING_VECTOR_METRICS.includes(value as EmbeddingVectorMetric)
  ) {
    return;
  }
  errors.push("retrieval.vectorMetric is invalid when set");
}

function validateOptionalSafeText(value: unknown, field: string, errors: string[]): void {
  if (value !== undefined && !isSafePodText(value, false)) {
    errors.push(`${field} must be an evidence-safe string when set`);
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
    value.modelOpen !== true ||
    value.rawContentExposed !== false ||
    value.privatePathsExposed !== false ||
    value.evidenceMode !== "counts-hashes-and-status" ||
    value.storageLocation !== "local-runtime-state"
  ) {
    errors.push("privacy must preserve the Knowledge Pod redaction posture");
  }
}

function validateGovernance(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("governance must be an object");
    return;
  }
  onlyKeys(value, GOVERNANCE_KEYS, "governance", errors);
  if (!LOCATION_KINDS.includes(value.locationKind as KnowledgePodLocationKind)) {
    errors.push("governance.locationKind is invalid");
  }
  if (!SEALING_POSTURES.includes(value.sealingPosture as KnowledgePodSealingPosture)) {
    errors.push("governance.sealingPosture is invalid");
  }
  if (!POLICY_POSTURES.includes(value.policyPosture as KnowledgePodPolicyPosture)) {
    errors.push("governance.policyPosture is invalid");
  }
  if (typeof value.managedServiceDependency !== "boolean") {
    errors.push("governance.managedServiceDependency must be a boolean");
  }
}

function validateCompatibility(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("compatibility must be an object");
    return;
  }
  onlyKeys(value, COMPATIBILITY_KEYS, "compatibility", errors);
  if (!BACKINGS.includes(value.backingKind as KnowledgePodBackingKind)) {
    errors.push("compatibility.backingKind is invalid");
  }
  validateSafeTextArray(value.capsuleIds, "compatibility.capsuleIds", errors, false);
  validateSafeTextArray(value.sourceIds, "compatibility.sourceIds", errors, false);
  if (
    value.localKnowledgeSchemaVersion !== LOCAL_KNOWLEDGE_SCHEMA_VERSION ||
    value.migrationRequired !== false ||
    value.persistedStateRenamed !== false
  ) {
    errors.push("compatibility must preserve Local Knowledge state compatibility");
  }
}

export function validateKnowledgePodSummary(
  input: unknown,
): LocalKnowledgeValidation<KnowledgePodSummary> {
  if (!isRecord(input)) return { ok: false, errors: ["summary must be an object"] };
  const errors: string[] = [];
  onlyKeys(input, SUMMARY_KEYS, "summary", errors);
  validateSummaryScalars(input, errors);
  validateCounts(input.counts, errors);
  validateSourceKinds(input.sourceKinds, errors);
  validateRetrieval(input.retrieval, errors);
  validatePrivacy(input.privacy, errors);
  validateGovernance(input.governance, errors);
  validateCompatibility(input.compatibility, errors);
  validateSafeTextArray(input.degradationReasons, "summary.degradationReasons", errors, true);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: input as unknown as KnowledgePodSummary };
}

function validateSummaryScalars(input: Record<string, unknown>, errors: string[]): void {
  if (input.schemaVersion !== KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION) {
    errors.push("summary.schemaVersion is invalid");
  }
  if (!isSafePodText(input.id, false)) errors.push("summary.id must be an evidence-safe string");
  if (!KINDS.includes(input.kind as KnowledgePodSummaryKind))
    errors.push("summary.kind is invalid");
  if (!isSafePodText(input.displayName, false)) {
    errors.push("summary.displayName must be an evidence-safe string");
  }
  validateOptionalSafeText(input.description, "summary.description", errors);
  validateSafeTextArray(input.tags, "summary.tags", errors, false);
  if (!READINESS.includes(input.readiness as KnowledgePodReadiness)) {
    errors.push("summary.readiness is invalid");
  }
  validateLifecycleState(input.lifecycleState, errors);
  validateUpdatedAt(input.updatedAt, errors);
}

function validateUpdatedAt(value: unknown, errors: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push("summary.updatedAt must be a finite non-negative number");
  }
}

function validateLifecycleState(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (
    typeof value === "string" &&
    CAPSULE_LIFECYCLE_STATES.includes(value as CapsuleLifecycleState)
  ) {
    return;
  }
  errors.push("summary.lifecycleState is invalid");
}

function validateSourceKinds(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("sourceKinds must be an array");
    return;
  }
  for (const kind of value) {
    if (!SOURCE_KINDS.includes(kind as KnowledgePodSourceKind)) {
      errors.push("sourceKinds entries must be known pod source kinds");
      return;
    }
  }
}
