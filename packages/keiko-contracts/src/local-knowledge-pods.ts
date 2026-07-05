// User-facing Knowledge Pods projection contracts for Epic #1815.
//
// This module is a compatibility layer over the existing Local Knowledge contracts. It does not
// rename persisted state, add a retrieval store, or change ranking behavior. The summary shape is
// intentionally redacted: product labels plus counts, lifecycle/readiness, retrieval capabilities,
// privacy posture, and compatibility lineage. It carries no document bodies, source paths, prompts,
// endpoints, credentials, vectors, or raw evidence.

import type {
  EmbeddingProfileCompatibilityReason,
  EmbeddingProfileCompatibilityStatus,
} from "./local-knowledge-embedding-profiles.js";
import {
  EMBEDDING_PROFILE_COMPATIBILITY_REASONS,
  EMBEDDING_PROFILE_COMPATIBILITY_STATUSES,
} from "./local-knowledge-embedding-profiles.js";
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
import type {
  KnowledgePodModelUsePolicyMode,
  KnowledgePodModelUsePolicySource,
  KnowledgePodResolvedModelUsePolicyOperations,
} from "./local-knowledge-model-use-policy.js";
import {
  KNOWLEDGE_POD_MODEL_USE_OPERATIONS,
  KNOWLEDGE_POD_MODEL_USE_POLICY_MODES,
} from "./local-knowledge-model-use-policy.js";
import {
  isSafeDisplaySummary,
  type LocalKnowledgeValidation,
} from "./local-knowledge-validation.js";

export const KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION = "1" as const;

export type KnowledgePodSummaryKind = "pod" | "pod-set";
export type KnowledgePodBackingKind = "knowledge-capsule" | "capsule-set";
export type KnowledgePodReadiness =
  "draft" | "indexing" | "ready" | "stale" | "degraded" | "unavailable" | "error";
export type KnowledgePodSourceKind =
  KnowledgeSourceScopeKind | "remote" | "federated" | "ephemeral" | "policy" | "unknown";
export type KnowledgePodEvidenceMode = "counts-hashes-and-status";
export type KnowledgePodLocationKind = "local" | "remote" | "federated" | "ephemeral";
export type KnowledgePodSealingPosture =
  "local-store-policy" | "sealed-pod-policy" | "not-declared";
export type KnowledgePodPolicyPosture = "none" | "policy-pack" | "not-declared";
export type KnowledgePodSetReadinessReasonCode =
  | "member-draft"
  | "member-indexing"
  | "member-stale"
  | "member-error"
  | "member-unavailable"
  | "member-degraded"
  | "missing-member"
  | "policy-denied"
  | "embedding-unknown"
  | "embedding-incompatible"
  | "embedding-unavailable"
  | "embedding-opaque"
  | "no-sources"
  | "no-vectors"
  | "future-remote-member"
  | "future-federated-member"
  | "future-ephemeral-member";

export const KNOWLEDGE_POD_SET_READINESS_REASON_CODES: readonly KnowledgePodSetReadinessReasonCode[] =
  [
    "member-draft",
    "member-indexing",
    "member-stale",
    "member-error",
    "member-unavailable",
    "member-degraded",
    "missing-member",
    "policy-denied",
    "embedding-unknown",
    "embedding-incompatible",
    "embedding-unavailable",
    "embedding-opaque",
    "no-sources",
    "no-vectors",
    "future-remote-member",
    "future-federated-member",
    "future-ephemeral-member",
  ];

export interface KnowledgePodCounts {
  readonly capsuleCount: number;
  readonly sourceCount: number;
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly vectorCount: number;
}

export interface KnowledgePodSetReadinessSummary {
  readonly readyCount: number;
  readonly draftCount: number;
  readonly degradedCount: number;
  readonly unavailableCount: number;
  readonly deniedCount: number;
  readonly indexingCount: number;
  readonly staleCount: number;
  readonly errorCount: number;
  readonly missingCount: number;
  readonly reasonCodes: readonly KnowledgePodSetReadinessReasonCode[];
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
  readonly embeddingProfileKey?: string;
  readonly embeddingCompatibilityStatus?: EmbeddingProfileCompatibilityStatus;
  readonly embeddingCompatibilityReason?: EmbeddingProfileCompatibilityReason;
  readonly reindexRecommended?: boolean;
  readonly queryEmbeddingAllowed?: boolean;
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

export interface KnowledgePodModelUsePolicySummary {
  readonly source: KnowledgePodModelUsePolicySource;
  readonly mode: KnowledgePodModelUsePolicyMode;
  readonly operations: KnowledgePodResolvedModelUsePolicyOperations;
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
  readonly setReadiness?: KnowledgePodSetReadinessSummary;
  readonly sourceKinds: readonly KnowledgePodSourceKind[];
  readonly retrieval: KnowledgePodRetrievalCapabilities;
  readonly privacy: KnowledgePodPrivacySummary;
  readonly governance: KnowledgePodGovernanceSummary;
  readonly modelUsePolicy: KnowledgePodModelUsePolicySummary;
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
  "setReadiness",
  "sourceKinds",
  "retrieval",
  "privacy",
  "governance",
  "modelUsePolicy",
  "compatibility",
  "updatedAt",
  "degradationReasons",
] as const;

const COUNT_KEYS = ["capsuleCount", "sourceCount", "documentCount", "chunkCount", "vectorCount"];
const SET_READINESS_KEYS = [
  "readyCount",
  "draftCount",
  "degradedCount",
  "unavailableCount",
  "deniedCount",
  "indexingCount",
  "staleCount",
  "errorCount",
  "missingCount",
  "reasonCodes",
] as const;
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
  "embeddingProfileKey",
  "embeddingCompatibilityStatus",
  "embeddingCompatibilityReason",
  "reindexRecommended",
  "queryEmbeddingAllowed",
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
const MODEL_USE_POLICY_KEYS = ["source", "mode", "operations"] as const;
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
const LOCATION_KINDS: readonly KnowledgePodLocationKind[] = [
  "local",
  "remote",
  "federated",
  "ephemeral",
];
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
const MODEL_USE_POLICY_SOURCES: readonly KnowledgePodModelUsePolicySource[] = [
  "explicit",
  "sealed-default",
  "legacy-default",
];
const SOURCE_KINDS: readonly KnowledgePodSourceKind[] = [
  "folder",
  "repository",
  "files",
  "remote",
  "federated",
  "ephemeral",
  "policy",
  "unknown",
];

type FuturePodPlaceholderKind = "remote" | "federated" | "ephemeral";

const FUTURE_POD_PLACEHOLDER_KINDS: readonly FuturePodPlaceholderKind[] = [
  "remote",
  "federated",
  "ephemeral",
];

const FUTURE_POD_REASON_BY_KIND: Record<
  FuturePodPlaceholderKind,
  KnowledgePodSetReadinessReasonCode
> = {
  remote: "future-remote-member",
  federated: "future-federated-member",
  ephemeral: "future-ephemeral-member",
};

const ABSOLUTE_PATH_RE = /(?:^|[[\s("'`<{}])(?:~[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>)]*/u;
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

function isEndpointBoundary(char: string): boolean {
  return char.trim().length === 0 || "\"'`(<{}".includes(char);
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
    containsSchemeEndpoint(value) ||
    containsSchemeRelativeEndpoint(value) ||
    containsHostEndpoint(value) ||
    containsUserInfoEndpoint(value)
  );
}

function containsSchemeEndpoint(value: string): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const delimiter = value.indexOf("://", searchFrom);
    if (delimiter === -1) return false;
    const start = findSchemeStart(value, delimiter);
    if (start !== -1 && isScheme(value.slice(start, delimiter))) return true;
    searchFrom = delimiter + 3;
  }
  return false;
}

function findSchemeStart(value: string, delimiter: number): number {
  let start = delimiter - 1;
  while (start >= 0 && isSchemeTailChar(value.charAt(start))) {
    start -= 1;
  }
  return start + 1;
}

function isScheme(value: string): boolean {
  if (value.length === 0 || !isAsciiLetter(value.charAt(0))) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (!isSchemeTailChar(value.charAt(index))) return false;
  }
  return true;
}

function isSchemeTailChar(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === "+" || char === "." || char === "-";
}

function containsSchemeRelativeEndpoint(value: string): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const delimiter = value.indexOf("//", searchFrom);
    if (delimiter === -1) return false;
    const previous = delimiter === 0 ? "" : value.charAt(delimiter - 1);
    const next = value.charAt(delimiter + 2);
    if (
      (delimiter === 0 || isEndpointBoundary(previous)) &&
      next !== "" &&
      !isUrlTerminator(next)
    ) {
      return true;
    }
    searchFrom = delimiter + 2;
  }
  return false;
}

function containsHostEndpoint(value: string): boolean {
  for (const token of endpointTokens(value)) {
    if (tokenStartsWithHostEndpoint(token)) return true;
  }
  return false;
}

function containsUserInfoEndpoint(value: string): boolean {
  for (const token of endpointTokens(value)) {
    const at = token.indexOf("@");
    if (at > 0 && tokenStartsWithHostEndpoint(token.slice(at + 1))) return true;
  }
  return false;
}

function endpointTokens(value: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  while (start < value.length) {
    while (start < value.length && isEndpointBoundary(value.charAt(start))) start += 1;
    const end = findUrlEnd(value, start);
    if (end > start) tokens.push(value.slice(start, end));
    start = Math.max(end + 1, start + 1);
  }
  return tokens;
}

function tokenStartsWithHostEndpoint(token: string): boolean {
  const hostEnd = findHostEnd(token);
  if (hostEnd === 0) return false;
  const host = stripPort(token.slice(0, hostEnd));
  return (
    isRecognizedHost(host) && (hostEnd === token.length || "/?#".includes(token.charAt(hostEnd)))
  );
}

function findHostEnd(token: string): number {
  let end = token.length;
  for (const separator of ["/", "?", "#"] as const) {
    const index = token.indexOf(separator);
    if (index !== -1 && index < end) end = index;
  }
  return end;
}

function stripPort(hostWithPort: string): string {
  if (hostWithPort.startsWith("[")) {
    const bracketEnd = hostWithPort.indexOf("]");
    if (bracketEnd > 0) return hostWithPort.slice(0, bracketEnd + 1);
  }
  const colon = hostWithPort.lastIndexOf(":");
  if (colon === -1) return hostWithPort;
  const port = hostWithPort.slice(colon + 1);
  return isPort(port) ? hostWithPort.slice(0, colon) : hostWithPort;
}

function isPort(value: string): boolean {
  return value.length >= 1 && value.length <= 5 && everyChar(value, isAsciiDigit);
}

function isRecognizedHost(host: string): boolean {
  return (
    host.toLowerCase() === "localhost" ||
    isIpv4Host(host) ||
    isDomainHost(host) ||
    isBracketedIpv6Host(host)
  );
}

function isBracketedIpv6Host(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const address = host.slice(1, -1);
  return address.includes(":") && everyChar(address, isIpv6AddressChar);
}

function isIpv6AddressChar(char: string): boolean {
  return isAsciiDigit(char) || "abcdefABCDEF:.".includes(char);
}

function isIpv4Host(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 && parts.every((part) => part.length > 0 && everyChar(part, isAsciiDigit))
  );
}

function isDomainHost(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 2 || !everyChar(labels.at(-1) ?? "", isAsciiLetter)) return false;
  return labels.every(isDomainLabel);
}

function isDomainLabel(label: string): boolean {
  if (label.length === 0) return false;
  return everyChar(label, (char) => isAsciiLetter(char) || isAsciiDigit(char) || char === "-");
}

function everyChar(value: string, predicate: (char: string) => boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!predicate(value.charAt(index))) return false;
  }
  return true;
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
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

function validateSetReadiness(
  value: unknown,
  kind: unknown,
  counts: unknown,
  errors: string[],
): void {
  if (value === undefined) return;
  if (kind !== "pod-set") {
    errors.push("setReadiness is only valid for pod-set summaries");
    return;
  }
  if (!isRecord(value)) {
    errors.push("setReadiness must be an object");
    return;
  }
  onlyKeys(value, SET_READINESS_KEYS, "setReadiness", errors);
  for (const key of SET_READINESS_KEYS) {
    if (key === "reasonCodes") continue;
    const count = value[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      errors.push(`setReadiness.${key} must be a non-negative integer`);
      return;
    }
  }
  validateSetReadinessReasonCodes(value.reasonCodes, errors);
  validateSetReadinessMemberTotal(value, counts, errors);
}

function validateSetReadinessReasonCodes(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("setReadiness.reasonCodes must be an array");
    return;
  }
  for (const code of value) {
    if (
      typeof code !== "string" ||
      !KNOWLEDGE_POD_SET_READINESS_REASON_CODES.includes(code as KnowledgePodSetReadinessReasonCode)
    ) {
      errors.push("setReadiness.reasonCodes entries must be known reason codes");
      return;
    }
  }
}

function validateSetReadinessMemberTotal(
  value: Record<string, unknown>,
  counts: unknown,
  errors: string[],
): void {
  if (!isRecord(counts) || typeof counts.capsuleCount !== "number") return;
  const total =
    Number(value.readyCount) +
    Number(value.draftCount) +
    Number(value.degradedCount) +
    Number(value.unavailableCount) +
    Number(value.indexingCount) +
    Number(value.staleCount) +
    Number(value.errorCount) +
    Number(value.missingCount);
  if (total !== counts.capsuleCount) {
    errors.push("setReadiness member counts must match counts.capsuleCount");
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
  validateOptionalSafeText(value.embeddingProfileKey, "retrieval.embeddingProfileKey", errors);
  validateEmbeddingCompatibilityStatus(value.embeddingCompatibilityStatus, errors);
  validateEmbeddingCompatibilityReason(value.embeddingCompatibilityReason, errors);
  validateOptionalBoolean(value.reindexRecommended, "retrieval.reindexRecommended", errors);
  validateOptionalBoolean(value.queryEmbeddingAllowed, "retrieval.queryEmbeddingAllowed", errors);
  validateVectorDimensions(value.vectorDimensions, errors);
  validateVectorMetric(value.vectorMetric, errors);
}

function validateOptionalBoolean(value: unknown, field: string, errors: string[]): void {
  if (value !== undefined && typeof value !== "boolean") {
    errors.push(`${field} must be a boolean when set`);
  }
}

function validateEmbeddingCompatibilityStatus(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (
    typeof value === "string" &&
    EMBEDDING_PROFILE_COMPATIBILITY_STATUSES.includes(value as EmbeddingProfileCompatibilityStatus)
  ) {
    return;
  }
  errors.push("retrieval.embeddingCompatibilityStatus is invalid when set");
}

function validateEmbeddingCompatibilityReason(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (
    typeof value === "string" &&
    EMBEDDING_PROFILE_COMPATIBILITY_REASONS.includes(value as EmbeddingProfileCompatibilityReason)
  ) {
    return;
  }
  errors.push("retrieval.embeddingCompatibilityReason is invalid when set");
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

function validateModelUsePolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("modelUsePolicy must be an object");
    return;
  }
  onlyKeys(value, MODEL_USE_POLICY_KEYS, "modelUsePolicy", errors);
  if (!MODEL_USE_POLICY_SOURCES.includes(value.source as KnowledgePodModelUsePolicySource)) {
    errors.push("modelUsePolicy.source is invalid");
  }
  if (!KNOWLEDGE_POD_MODEL_USE_POLICY_MODES.includes(value.mode as never)) {
    errors.push("modelUsePolicy.mode is invalid");
  }
  if (!isRecord(value.operations)) {
    errors.push("modelUsePolicy.operations must be an object");
    return;
  }
  onlyKeys(
    value.operations,
    KNOWLEDGE_POD_MODEL_USE_OPERATIONS,
    "modelUsePolicy.operations",
    errors,
  );
  for (const operation of KNOWLEDGE_POD_MODEL_USE_OPERATIONS) {
    const decision = value.operations[operation];
    if (decision !== "allow" && decision !== "deny") {
      errors.push(`modelUsePolicy.operations.${operation} is invalid`);
      return;
    }
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
  validateSetReadiness(input.setReadiness, input.kind, input.counts, errors);
  validateSourceKinds(input.sourceKinds, errors);
  validateRetrieval(input.retrieval, errors);
  validatePrivacy(input.privacy, errors);
  validateGovernance(input.governance, errors);
  validateModelUsePolicy(input.modelUsePolicy, errors);
  validateCompatibility(input.compatibility, errors);
  validateFuturePlaceholderPosture(input, errors);
  validateSafeTextArray(input.degradationReasons, "summary.degradationReasons", errors, true);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: input as unknown as KnowledgePodSummary };
}

function validateFuturePlaceholderPosture(input: Record<string, unknown>, errors: string[]): void {
  const placeholderKinds = futurePlaceholderKinds(input);
  if (placeholderKinds.length === 0) return;
  if (input.readiness !== "degraded" && input.readiness !== "unavailable") {
    errors.push("future pod placeholders must be degraded or unavailable");
  }
  if (!retrievalDisabled(input.retrieval)) {
    errors.push("future pod placeholders must not advertise retrieval capabilities");
  }
  if (input.kind === "pod-set") {
    validateFutureSetReadinessReasons(input.setReadiness, placeholderKinds, errors);
  }
}

function futurePlaceholderKinds(
  input: Record<string, unknown>,
): readonly FuturePodPlaceholderKind[] {
  const kinds = new Set<FuturePodPlaceholderKind>();
  if (isRecord(input.governance) && isFuturePodPlaceholderKind(input.governance.locationKind)) {
    kinds.add(input.governance.locationKind);
  }
  if (Array.isArray(input.sourceKinds)) {
    for (const sourceKind of input.sourceKinds) {
      if (isFuturePodPlaceholderKind(sourceKind)) kinds.add(sourceKind);
    }
  }
  return Array.from(kinds);
}

function isFuturePodPlaceholderKind(value: unknown): value is FuturePodPlaceholderKind {
  return (
    typeof value === "string" &&
    FUTURE_POD_PLACEHOLDER_KINDS.includes(value as FuturePodPlaceholderKind)
  );
}

function retrievalDisabled(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.lexicalIndex === false &&
    value.vectorIndex === false &&
    value.hybridGrounding === false
  );
}

function validateFutureSetReadinessReasons(
  setReadiness: unknown,
  placeholderKinds: readonly FuturePodPlaceholderKind[],
  errors: string[],
): void {
  if (!isRecord(setReadiness) || !Array.isArray(setReadiness.reasonCodes)) return;
  for (const placeholderKind of placeholderKinds) {
    const reason = FUTURE_POD_REASON_BY_KIND[placeholderKind];
    if (!setReadiness.reasonCodes.includes(reason)) {
      errors.push(`setReadiness.reasonCodes must include ${reason} for future placeholders`);
      return;
    }
  }
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
