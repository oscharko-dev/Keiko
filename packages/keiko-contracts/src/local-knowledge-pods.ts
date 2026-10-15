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
  validateOnlyKeys as onlyKeys,
  type LocalKnowledgeValidation,
} from "./local-knowledge-validation.js";
import type { HtmlManualSourceKind } from "./html-manual-source.js";
import {
  validateManualRefreshChangeSummary,
  type ManualRefreshChangeSummary,
} from "./html-manual-refresh.js";
import type { AtlassianConnectorPodSource } from "./atlassian-connectors.js";
import { validateAtlassianConnectorPodSource } from "./atlassian-connectors-validation.js";

export const KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION = "1" as const;

export type KnowledgePodSummaryKind = "pod" | "pod-set";
export type KnowledgePodBackingKind = "knowledge-capsule" | "capsule-set";
export type KnowledgePodReadiness =
  "draft" | "indexing" | "ready" | "stale" | "degraded" | "unavailable" | "error";
export type KnowledgePodSourceKind =
  | KnowledgeSourceScopeKind
  | HtmlManualSourceKind
  | "remote"
  | "federated"
  | "ephemeral"
  | "policy"
  | "unknown";
export type KnowledgePodEvidenceMode = "counts-hashes-and-status";
export type KnowledgePodLocationKind = "local" | "remote" | "federated" | "ephemeral";
export type KnowledgePodSealingPosture = "local-store-policy" | "sealed-pod-policy";
export type KnowledgePodPolicyPosture = "policy-pack" | "not-declared";
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
  // Optional, content-free fingerprint of the manual source root this pod was indexed from (Epic
  // #1852). Present only for pods created from an approved HTML manual proposal; it lets the governed
  // documentation browser detect an already-indexed manual without exposing any raw path/URL. It is a
  // hash, never a path. Absent for every pod not backed by an HTML manual source.
  readonly manualSourceFingerprint?: string;
  // Optional redacted summary of the most recent explicit refresh of this HTML manual pod (Epic
  // #1856). Counts + reason codes + an opaque crawl-run fingerprint only — never a raw path or body.
  // Absent until the pod has been refreshed at least once, and for every non-manual pod.
  readonly manualRefresh?: ManualRefreshChangeSummary;
  // Optional redacted source metadata for a pod synced from an Atlassian connector (Issue #2240,
  // Epic #2238, ADR-0128). Provider, connector id, scope labels (space/project keys — identifiers,
  // never paths or bodies), last sync time, and the last run's body-free change summary. Absent for
  // every pod not backed by a connector source.
  readonly connectorSource?: AtlassianConnectorPodSource;
}

// Older catalog responses omitted only model-use policy. All other summary fields remain required.
export interface LegacyKnowledgePodCatalogSummary extends Omit<
  KnowledgePodSummary,
  "modelUsePolicy"
> {
  readonly modelUsePolicy?: undefined;
}

export type KnowledgePodCatalogSummary = KnowledgePodSummary | LegacyKnowledgePodCatalogSummary;

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

export interface LocalKnowledgeCapsulesCatalogResponse extends Omit<
  LocalKnowledgeCapsulesResponse,
  "knowledgePods"
> {
  readonly knowledgePods?: readonly KnowledgePodCatalogSummary[];
}

export interface LocalKnowledgeCapsuleSetsCatalogResponse extends Omit<
  LocalKnowledgeCapsuleSetsResponse,
  "knowledgePods"
> {
  readonly knowledgePods?: readonly KnowledgePodCatalogSummary[];
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
  "manualSourceFingerprint",
  "manualRefresh",
  "connectorSource",
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
// Mirrors ManualRefreshChangeSummary (packages/keiko-contracts/src/html-manual-refresh.ts). That
// leaf validator checks required-field presence/type/enum membership but — unlike every other
// nested object on KnowledgePodSummary — does not reject unknown/extra keys. Enforce the same
// onlyKeys defense-in-depth here, at the summary layer, so a corrupted or accidentally-widened
// persisted record cannot ride an unexpected field through to the UI/evidence surface.
const MANUAL_REFRESH_KEYS = [
  "schemaVersion",
  "outcome",
  "sourceKind",
  "counts",
  "removalDetection",
  "crawlRunFingerprint",
  "reasonCodes",
  "refreshedAt",
] as const;
const MANUAL_REFRESH_COUNT_KEYS = [
  "addedPages",
  "changedPages",
  "removedPages",
  "movedPages",
  "unchangedPages",
  "failedPages",
  "deniedLinks",
] as const;

const READINESS: ReadonlySet<KnowledgePodReadiness> = new Set([
  "draft",
  "indexing",
  "ready",
  "stale",
  "degraded",
  "unavailable",
  "error",
]);
const KINDS: ReadonlySet<KnowledgePodSummaryKind> = new Set(["pod", "pod-set"]);
const BACKINGS: ReadonlySet<KnowledgePodBackingKind> = new Set([
  "knowledge-capsule",
  "capsule-set",
]);
const LOCATION_KINDS: ReadonlySet<KnowledgePodLocationKind> = new Set([
  "local",
  "remote",
  "federated",
  "ephemeral",
]);
const SEALING_POSTURES: ReadonlySet<KnowledgePodSealingPosture> = new Set([
  "local-store-policy",
  "sealed-pod-policy",
]);
const POLICY_POSTURES: ReadonlySet<KnowledgePodPolicyPosture> = new Set([
  "policy-pack",
  "not-declared",
]);
const MODEL_USE_POLICY_SOURCES: ReadonlySet<KnowledgePodModelUsePolicySource> = new Set([
  "explicit",
  "legacy-default",
]);
const SOURCE_KINDS: ReadonlySet<KnowledgePodSourceKind> = new Set([
  "folder",
  "repository",
  "files",
  "html-manual-local",
  "html-manual-http",
  "remote",
  "federated",
  "ephemeral",
  "policy",
  "unknown",
]);

type FuturePodPlaceholderKind = "remote" | "federated" | "ephemeral";

const FUTURE_POD_PLACEHOLDER_KINDS: ReadonlySet<FuturePodPlaceholderKind> = new Set([
  "remote",
  "federated",
  "ephemeral",
]);

const FUTURE_POD_REASON_BY_KIND: Record<
  FuturePodPlaceholderKind,
  KnowledgePodSetReadinessReasonCode
> = {
  remote: "future-remote-member",
  federated: "future-federated-member",
  ephemeral: "future-ephemeral-member",
};

// Redact filesystem paths wherever they appear, not only at a string boundary — an earlier
// anchored form let `report=/Users/alice/secret.pdf`, `a/Users/…`, and non-ASCII-prefixed paths
// leak, and a later fixed-boundary-character-set form still missed separators outside that set
// (`path=/etc`, `key:/etc`, `a,/etc,b`, `flag-/etc`, `)/etc`). Matches Windows drive paths, UNC
// shares, single-backslash paths, home (`~/`), parent traversal (`../`), any multi-segment POSIX
// path (`/seg/…`), and any single-segment absolute path (`/etc`, `/private`) not immediately
// preceded by a word character. The negative lookbehind — rather than an enumerated boundary-char
// set — is what keeps a lone slash in benign prose (`UI/UX`, `TCP/IP`, `Q3 / Finance`) from being
// treated as a path while still catching single-segment paths after ANY punctuation or start of
// string, so this class of gap (three enumerations of "boundary characters" so far) cannot recur
// by omitting one more separator.
const FILESYSTEM_PATH_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:[\\/]/u,
  /\\\\/u,
  /\\[^\\\s]+/u,
  /~[\\/]/u,
  /\.\.[\\/]/u,
  /\/[^/\s]+\//u,
  /(?<!\w)\/[^/\s]+/u,
];
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[\w-]{12,}/u,
  /ghp_\w{12,}/u,
  /github_pat_\w{20,}/u,
  /xox[baprs]-/u,
  /AKIA[0-9A-Z]{12,}/u,
  /[Bb]earer\s+[\w.~+/=-]{12,}/u,
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/u,
  /BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?KEY/u,
];
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

// Cookie headers and chat/prompt template scaffolding never belong in body-free evidence, yet
// neither was caught by the path/secret/token/endpoint gates above (Epic #1858, Issue #1904). A
// `Set-Cookie: sessionId=…` header slips the token-key check because `sessionId` is not a known
// token key, and a ChatML/harness `[[topic:…]]` marker matches no other pattern. Both are matched
// by shape here. The cookie form requires the header colon and a negative lookbehind so benign
// prose ("cookie consent banner", "third-party cookies accepted") is not over-redacted; the prompt
// form matches only unambiguous template delimiters that cannot occur in a real manual summary.
const COOKIE_HEADER_RE = /(?<!\w)(?:set-)?cookie\s*:/iu;
const PROMPT_SCAFFOLD_RE =
  /<\|(?:im_(?:start|end)|system|user|assistant|endoftext)\|>|\[\[topic:|\[\/?INST\]|<<\/?SYS>>/iu;

type PodSummaryStructure = Omit<KnowledgePodSummary, "id" | "compatibility"> & {
  readonly id: string;
  readonly compatibility: Omit<KnowledgePodCompatibilitySummary, "capsuleIds" | "sourceIds"> & {
    readonly capsuleIds: readonly string[];
    readonly sourceIds: readonly string[];
  };
};

function isCapturedExtent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateStableExtent(
  members: readonly unknown[],
  extent: number,
  field: string,
  errors: string[],
): boolean {
  if (members.length !== extent)
    return reject(errors, `${field} must not change length during validation`);
  return true;
}

function combineAdmissions(previous: boolean, current: boolean): boolean {
  return previous && current;
}

// A refusal records the original diagnostic and actual failed field evidence.
function reject(errors: string[], ...reasons: string[]): false {
  errors.push(...reasons);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return (
    containsTokenKeyAfter(value, "?") ||
    containsTokenKeyAfter(value, "#") ||
    containsBareTokenAssignment(value)
  );
}

// A sensitive key can appear as a bare `key=value` assignment outside any URL query string — for
// example a config-dump or error-message fragment like `password=hunter2` or
// `aws_secret_access_key=AKIA...` — which containsTokenKeyAfter never sees because it only scans
// text following a literal `?` or `#`. This scans the whole value for identifier-like keys
// immediately preceding `=` and reuses the same key-name check as the query-string path. Uses a
// bounded backward character scan rather than a regex quantifier, so it stays linear instead of
// polynomial on adversarial input (a long run of key-body characters with no `=`).
function isKeyAssignmentBodyChar(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === "_" || char === "-";
}

function containsBareTokenAssignment(value: string): boolean {
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const equals = value.indexOf("=", searchFrom);
    if (equals === -1) return false;
    let start = equals;
    while (start > 0 && isKeyAssignmentBodyChar(value.charAt(start - 1))) start -= 1;
    if (
      start < equals &&
      isAsciiLetter(value.charAt(start)) &&
      queryKeyContainsTokenName(value.slice(start, equals))
    ) {
      return true;
    }
    searchFrom = equals + 1;
  }
  return false;
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
  return decoded.split(/[[\]]/u).some((part) => {
    if (TOKEN_QUERY_KEYS.has(part)) return true;
    return part.includes("token") || part.includes("secret") || part.includes("credential");
  });
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
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
  const code = char.codePointAt(0) ?? 0;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function isSafePodText(value: unknown, allowEmpty: boolean): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.trim().length === 0) return false;
  return (
    isSafeDisplaySummary(value) &&
    !matchesAnyPattern(value, FILESYSTEM_PATH_PATTERNS) &&
    !matchesAnyPattern(value, SECRET_PATTERNS) &&
    !containsTokenParameterKey(value) &&
    !containsEndpointLikeText(value) &&
    !COOKIE_HEADER_RE.test(value) &&
    !PROMPT_SCAFFOLD_RE.test(value)
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
): boolean {
  let valid = true;
  if (!Array.isArray(value)) {
    valid = reject(errors, `${field} must be an array`);
    return valid;
  }
  const members = value;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, `${field} must have a valid array length`);
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const entry: unknown = members[index];

    if (!isSafePodText(entry, allowEmpty)) {
      valid = reject(errors, `${field} entries must be evidence-safe strings`);
      return valid;
    }
  }
  valid = combineAdmissions(valid, validateStableExtent(members, extent, field, errors));
  return valid;
}

function validateCounts(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "counts must be an object");
    return valid;
  }
  onlyKeys(value, COUNT_KEYS, "counts", errors);
  for (const key of COUNT_KEYS) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      valid = reject(errors, `counts.${key} must be a non-negative integer`);
      return valid;
    }
  }
  return valid;
}

function validateSetReadiness(
  value: unknown,
  kind: unknown,
  counts: unknown,
  errors: string[],
): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (kind !== "pod-set") {
    valid = reject(errors, "setReadiness is only valid for pod-set summaries");
    return valid;
  }
  if (!isRecord(value)) {
    valid = reject(errors, "setReadiness must be an object");
    return valid;
  }
  onlyKeys(value, SET_READINESS_KEYS, "setReadiness", errors);
  for (const key of SET_READINESS_KEYS) {
    if (key === "reasonCodes") continue;
    const count = value[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      valid = reject(errors, `setReadiness.${key} must be a non-negative integer`);
      return valid;
    }
  }
  valid = combineAdmissions(valid, validateSetReadinessReasonCodes(value.reasonCodes, errors));
  valid = combineAdmissions(valid, validateSetReadinessMemberTotal(value, counts, errors));
  return valid;
}

function validateSetReadinessReasonCodes(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(value)) {
    valid = reject(errors, "setReadiness.reasonCodes must be an array");
    return valid;
  }
  const members = value;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "setReadiness.reasonCodes must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const code: unknown = members[index];

    if (
      typeof code !== "string" ||
      !KNOWLEDGE_POD_SET_READINESS_REASON_CODES_ADMISSION.includes(code)
    ) {
      valid = reject(errors, "setReadiness.reasonCodes entries must be known reason codes");
      return valid;
    }
  }
  valid = combineAdmissions(
    valid,
    validateStableExtent(members, extent, "setReadiness.reasonCodes", errors),
  );
  return valid;
}

function validateSetReadinessMemberTotal(
  value: Record<string, unknown>,
  counts: unknown,
  errors: string[],
): boolean {
  let valid = true;
  if (!isRecord(counts) || typeof counts.capsuleCount !== "number") return valid;
  const total =
    Number(value.readyCount) +
    Number(value.draftCount) +
    Number(value.degradedCount) +
    Number(value.unavailableCount) +
    Number(value.deniedCount) +
    Number(value.indexingCount) +
    Number(value.staleCount) +
    Number(value.errorCount) +
    Number(value.missingCount);
  if (total !== counts.capsuleCount) {
    valid = reject(errors, "setReadiness member counts must match counts.capsuleCount");
  }
  return valid;
}

function validateRetrieval(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "retrieval must be an object");
    return valid;
  }
  onlyKeys(value, RETRIEVAL_KEYS, "retrieval", errors);
  for (const key of ["lexicalIndex", "vectorIndex", "hybridGrounding"] as const) {
    if (typeof value[key] !== "boolean")
      valid = reject(errors, `retrieval.${key} must be a boolean`);
  }
  if (value.crossSpaceScoreMixing !== false) {
    valid = reject(errors, "retrieval.crossSpaceScoreMixing must be false");
  }
  return combineAdmissions(valid, validateRetrievalIdentity(value, errors));
}

function validateRetrievalIdentity(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = combineAdmissions(
    valid,
    validateOptionalSafeText(value.embeddingProvider, "retrieval.embeddingProvider", errors),
  );
  valid = combineAdmissions(
    valid,
    validateOptionalSafeText(value.embeddingModelId, "retrieval.embeddingModelId", errors),
  );
  valid = combineAdmissions(
    valid,
    validateOptionalSafeText(
      value.embeddingSpaceFingerprint,
      "retrieval.embeddingSpaceFingerprint",
      errors,
    ),
  );
  valid = combineAdmissions(
    valid,
    validateOptionalSafeText(value.embeddingProfileKey, "retrieval.embeddingProfileKey", errors),
  );
  valid = combineAdmissions(
    valid,
    validateEmbeddingCompatibilityStatus(value.embeddingCompatibilityStatus, errors),
  );
  valid = combineAdmissions(
    valid,
    validateEmbeddingCompatibilityReason(value.embeddingCompatibilityReason, errors),
  );
  valid = combineAdmissions(
    valid,
    validateOptionalBoolean(value.reindexRecommended, "retrieval.reindexRecommended", errors),
  );
  valid = combineAdmissions(
    valid,
    validateOptionalBoolean(value.queryEmbeddingAllowed, "retrieval.queryEmbeddingAllowed", errors),
  );
  valid = combineAdmissions(valid, validateVectorDimensions(value.vectorDimensions, errors));
  valid = combineAdmissions(valid, validateVectorMetric(value.vectorMetric, errors));
  return valid;
}

function validateOptionalBoolean(value: unknown, field: string, errors: string[]): boolean {
  let valid = true;
  if (value !== undefined && typeof value !== "boolean") {
    valid = reject(errors, `${field} must be a boolean when set`);
  }
  return valid;
}

function validateEmbeddingCompatibilityStatus(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (
    typeof value === "string" &&
    EMBEDDING_PROFILE_COMPATIBILITY_STATUSES_ADMISSION.includes(value)
  ) {
    return valid;
  }
  valid = reject(errors, "retrieval.embeddingCompatibilityStatus is invalid when set");
  return valid;
}

function validateEmbeddingCompatibilityReason(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (
    typeof value === "string" &&
    EMBEDDING_PROFILE_COMPATIBILITY_REASONS_ADMISSION.includes(value)
  ) {
    return valid;
  }
  valid = reject(errors, "retrieval.embeddingCompatibilityReason is invalid when set");
  return valid;
}

function validateVectorDimensions(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return valid;
  valid = reject(errors, "retrieval.vectorDimensions must be a positive integer when set");
  return valid;
}

function validateVectorMetric(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (typeof value === "string" && EMBEDDING_VECTOR_METRICS_ADMISSION.includes(value)) {
    return valid;
  }
  valid = reject(errors, "retrieval.vectorMetric is invalid when set");
  return valid;
}

function validateOptionalSafeText(value: unknown, field: string, errors: string[]): boolean {
  let valid = true;
  if (value !== undefined && !isSafePodText(value, false)) {
    valid = reject(errors, `${field} must be an evidence-safe string when set`);
  }
  return valid;
}

function validatePrivacy(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "privacy must be an object");
    return valid;
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
    valid = reject(errors, "privacy must preserve the Knowledge Pod redaction posture");
  }
  return valid;
}

function validateGovernance(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "governance must be an object");
    return valid;
  }
  onlyKeys(value, GOVERNANCE_KEYS, "governance", errors);
  if (!LOCATION_KINDS_ADMISSION.has(value.locationKind)) {
    valid = reject(errors, "governance.locationKind is invalid");
  }
  if (!SEALING_POSTURES_ADMISSION.has(value.sealingPosture)) {
    valid = reject(errors, "governance.sealingPosture is invalid");
  }
  if (!POLICY_POSTURES_ADMISSION.has(value.policyPosture)) {
    valid = reject(errors, "governance.policyPosture is invalid");
  }
  if (typeof value.managedServiceDependency !== "boolean") {
    valid = reject(errors, "governance.managedServiceDependency must be a boolean");
  }
  return valid;
}

function validateModelUsePolicy(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "modelUsePolicy must be an object");
    return valid;
  }
  onlyKeys(value, MODEL_USE_POLICY_KEYS, "modelUsePolicy", errors);
  if (!MODEL_USE_POLICY_SOURCES_ADMISSION.has(value.source)) {
    valid = reject(errors, "modelUsePolicy.source is invalid");
  }
  if (!KNOWLEDGE_POD_MODEL_USE_POLICY_MODES_ADMISSION.includes(value.mode)) {
    valid = reject(errors, "modelUsePolicy.mode is invalid");
  }
  if (!isRecord(value.operations)) {
    valid = reject(errors, "modelUsePolicy.operations must be an object");
    return valid;
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
      valid = reject(errors, `modelUsePolicy.operations.${operation} is invalid`);
      return valid;
    }
  }
  return valid;
}

function validateCompatibility(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = reject(errors, "compatibility must be an object");
    return valid;
  }
  onlyKeys(value, COMPATIBILITY_KEYS, "compatibility", errors);
  if (!BACKINGS_ADMISSION.has(value.backingKind)) {
    valid = reject(errors, "compatibility.backingKind is invalid");
  }
  valid = combineAdmissions(
    valid,
    validateSafeTextArray(value.capsuleIds, "compatibility.capsuleIds", errors, false),
  );
  valid = combineAdmissions(
    valid,
    validateSafeTextArray(value.sourceIds, "compatibility.sourceIds", errors, false),
  );
  if (
    value.localKnowledgeSchemaVersion !== LOCAL_KNOWLEDGE_SCHEMA_VERSION ||
    value.migrationRequired !== false ||
    value.persistedStateRenamed !== false
  ) {
    valid = reject(errors, "compatibility must preserve Local Knowledge state compatibility");
  }
  return valid;
}

function validateSummaryBeforePolicy(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  onlyKeys(input, SUMMARY_KEYS, "summary", errors);
  valid = combineAdmissions(valid, validateSummaryScalars(input, errors));
  valid = combineAdmissions(valid, validateCounts(input.counts, errors));
  valid = combineAdmissions(
    valid,
    validateSetReadiness(input.setReadiness, input.kind, input.counts, errors),
  );
  valid = combineAdmissions(valid, validateSourceKinds(input.sourceKinds, errors));
  valid = combineAdmissions(valid, validateRetrieval(input.retrieval, errors));
  valid = combineAdmissions(valid, validatePrivacy(input.privacy, errors));
  valid = combineAdmissions(valid, validateGovernance(input.governance, errors));
  return valid;
}

function validateSummaryAfterPolicy(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  valid = combineAdmissions(valid, validateCompatibility(input.compatibility, errors));
  valid = combineAdmissions(valid, validateFuturePlaceholderPosture(input, errors));
  valid = combineAdmissions(
    valid,
    validateSafeTextArray(input.degradationReasons, "summary.degradationReasons", errors, true),
  );

  return valid;
}

function admitsKnowledgePodSummary(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & PodSummaryStructure {
  let valid = validateSummaryBeforePolicy(input, errors);
  valid = combineAdmissions(valid, validateModelUsePolicy(input.modelUsePolicy, errors));
  return combineAdmissions(valid, validateSummaryAfterPolicy(input, errors));
}

export function validateKnowledgePodSummary(
  input: unknown,
): LocalKnowledgeValidation<KnowledgePodSummary> {
  if (!isRecord(input)) return { ok: false, errors: ["summary must be an object"] };
  const errors: string[] = [];
  if (!admitsKnowledgePodSummary(input, errors) || errors.length > 0) return { ok: false, errors };
  // All non-brand fields are admitted above; this attaches only erased ID brands.
  const admitted: PodSummaryStructure = input;
  // SAFETY: The checked structure retains every concrete field; only ID brands differ.
  return { ok: true, value: admitted as KnowledgePodSummary };
}

function validateFuturePlaceholderPosture(
  input: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  const placeholderKinds = futurePlaceholderKinds(input);
  if (placeholderKinds.length === 0) return valid;
  if (input.readiness !== "degraded" && input.readiness !== "unavailable") {
    valid = reject(errors, "future pod placeholders must be degraded or unavailable");
  }
  if (!retrievalDisabled(input.retrieval)) {
    valid = reject(errors, "future pod placeholders must not advertise retrieval capabilities");
  }
  if (input.kind === "pod-set") {
    valid = combineAdmissions(
      valid,
      validateFutureSetReadinessReasons(input.setReadiness, placeholderKinds, errors),
    );
  }
  return valid;
}

function futurePlaceholderKinds(
  input: Record<string, unknown>,
): readonly FuturePodPlaceholderKind[] {
  const kinds = new Set<FuturePodPlaceholderKind>();
  if (isRecord(input.governance) && isFuturePodPlaceholderKind(input.governance.locationKind)) {
    kinds.add(input.governance.locationKind);
  }
  if (Array.isArray(input.sourceKinds)) {
    const members = input.sourceKinds;
    const extent = members.length;
    for (let index = 0; index < extent; index += 1) {
      const sourceKind: unknown = members[index];

      if (isFuturePodPlaceholderKind(sourceKind)) kinds.add(sourceKind);
    }
  }
  return Array.from(kinds);
}

function isFuturePodPlaceholderKind(value: unknown): value is FuturePodPlaceholderKind {
  return typeof value === "string" && FUTURE_POD_PLACEHOLDER_KINDS_ADMISSION.has(value);
}

function retrievalDisabled(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.lexicalIndex === false &&
    value.vectorIndex === false &&
    value.hybridGrounding === false
  );
}

function containsPhysicalReason(members: unknown, reason: string): boolean {
  if (!Array.isArray(members)) return false;
  const extent = members.length;
  if (!isCapturedExtent(extent)) return false;
  for (let index = 0; index < extent; index += 1) {
    if (members[index] === reason) return true;
  }
  return false;
}

function validateFutureSetReadinessReasons(
  setReadiness: unknown,
  placeholderKinds: readonly FuturePodPlaceholderKind[],
  errors: string[],
): boolean {
  let valid = true;
  if (!isRecord(setReadiness) || !Array.isArray(setReadiness.reasonCodes)) return valid;
  for (const placeholderKind of placeholderKinds) {
    const reason = FUTURE_POD_REASON_BY_KIND[placeholderKind];
    if (!containsPhysicalReason(setReadiness.reasonCodes, reason)) {
      valid = reject(
        errors,
        `setReadiness.reasonCodes must include ${reason} for future placeholders`,
      );
      return valid;
    }
  }
  return valid;
}

function validateSummaryScalars(input: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (input.schemaVersion !== KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION) {
    valid = reject(errors, "summary.schemaVersion is invalid");
  }
  if (!isSafePodText(input.id, false))
    valid = reject(errors, "summary.id must be an evidence-safe string");
  if (!KINDS_ADMISSION.has(input.kind)) valid = reject(errors, "summary.kind is invalid");
  if (!isSafePodText(input.displayName, false)) {
    valid = reject(errors, "summary.displayName must be an evidence-safe string");
  }
  valid = combineAdmissions(
    valid,
    validateOptionalSafeText(input.description, "summary.description", errors),
  );
  valid = combineAdmissions(
    valid,
    validateSafeTextArray(input.tags, "summary.tags", errors, false),
  );
  if (!READINESS_ADMISSION.has(input.readiness)) {
    valid = reject(errors, "summary.readiness is invalid");
  }
  valid = combineAdmissions(valid, validateLifecycleState(input.lifecycleState, errors));
  valid = combineAdmissions(valid, validateUpdatedAt(input.updatedAt, errors));
  valid = combineAdmissions(
    valid,
    validateOptionalSafeText(
      input.manualSourceFingerprint,
      "summary.manualSourceFingerprint",
      errors,
    ),
  );
  valid = combineAdmissions(valid, validateOptionalManualRefresh(input.manualRefresh, errors));
  valid = combineAdmissions(valid, validateOptionalConnectorSource(input.connectorSource, errors));
  return valid;
}

// Mirrors validateOptionalManualRefresh for connector-backed pods. Unlike the manual-refresh leaf
// validator, validateAtlassianConnectorPodSource already rejects unknown/extra keys itself, so no
// second onlyKeys pass is needed at this layer.
function validateOptionalConnectorSource(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  const result = validateAtlassianConnectorPodSource(value);
  if (!result.ok) {
    valid = reject(errors, ...result.errors.map((error) => `summary.${error}`));
  }
  return valid;
}

function validateOptionalManualRefresh(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (!isRecord(value)) {
    valid = reject(errors, "summary.manualRefresh must be an object");
    return valid;
  }
  onlyKeys(value, MANUAL_REFRESH_KEYS, "summary.manualRefresh", errors);
  if (isRecord(value.counts)) {
    onlyKeys(value.counts, MANUAL_REFRESH_COUNT_KEYS, "summary.manualRefresh.counts", errors);
  }
  const result = validateManualRefreshChangeSummary(value);
  if (!result.ok) {
    valid = reject(errors, ...result.errors.map((error) => `summary.manualRefresh: ${error}`));
  }
  return valid;
}

function validateUpdatedAt(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    valid = reject(errors, "summary.updatedAt must be a finite non-negative number");
  }
  return valid;
}

function validateLifecycleState(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (value === undefined) return valid;
  if (typeof value === "string" && CAPSULE_LIFECYCLE_STATES_ADMISSION.has(value)) {
    return valid;
  }
  valid = reject(errors, "summary.lifecycleState is invalid");
  return valid;
}

function validateSourceKinds(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!Array.isArray(value)) {
    valid = reject(errors, "sourceKinds must be an array");
    return valid;
  }
  const members = value;
  const extent = members.length;
  if (!isCapturedExtent(extent)) {
    reject(errors, "sourceKinds must have a valid array length");
    return false;
  }
  for (let index = 0; index < extent; index += 1) {
    const kind: unknown = members[index];

    if (!SOURCE_KINDS_ADMISSION.has(kind)) {
      valid = reject(errors, "sourceKinds entries must be known pod source kinds");
      return valid;
    }
  }
  valid = combineAdmissions(valid, validateStableExtent(members, extent, "sourceKinds", errors));
  return valid;
}

const KNOWLEDGE_POD_SET_READINESS_REASON_CODES_ADMISSION: readonly unknown[] =
  KNOWLEDGE_POD_SET_READINESS_REASON_CODES;
const EMBEDDING_PROFILE_COMPATIBILITY_STATUSES_ADMISSION: readonly unknown[] =
  EMBEDDING_PROFILE_COMPATIBILITY_STATUSES;
const EMBEDDING_PROFILE_COMPATIBILITY_REASONS_ADMISSION: readonly unknown[] =
  EMBEDDING_PROFILE_COMPATIBILITY_REASONS;
const EMBEDDING_VECTOR_METRICS_ADMISSION: readonly unknown[] = EMBEDDING_VECTOR_METRICS;
const LOCATION_KINDS_ADMISSION: ReadonlySet<unknown> = LOCATION_KINDS;
const SEALING_POSTURES_ADMISSION: ReadonlySet<unknown> = SEALING_POSTURES;
const POLICY_POSTURES_ADMISSION: ReadonlySet<unknown> = POLICY_POSTURES;
const MODEL_USE_POLICY_SOURCES_ADMISSION: ReadonlySet<unknown> = MODEL_USE_POLICY_SOURCES;
const KNOWLEDGE_POD_MODEL_USE_POLICY_MODES_ADMISSION: readonly unknown[] =
  KNOWLEDGE_POD_MODEL_USE_POLICY_MODES;
const BACKINGS_ADMISSION: ReadonlySet<unknown> = BACKINGS;
const FUTURE_POD_PLACEHOLDER_KINDS_ADMISSION: ReadonlySet<unknown> = FUTURE_POD_PLACEHOLDER_KINDS;
const KINDS_ADMISSION: ReadonlySet<unknown> = KINDS;
const READINESS_ADMISSION: ReadonlySet<unknown> = READINESS;
const CAPSULE_LIFECYCLE_STATES_ADMISSION: ReadonlySet<unknown> = new Set(CAPSULE_LIFECYCLE_STATES);
const SOURCE_KINDS_ADMISSION: ReadonlySet<unknown> = SOURCE_KINDS;

// This wire admission retains original references and admits only the erased ID brands after
// checking their concrete string representation. Legacy policy omission grants no model authority.
function admitsCatalogSummary(
  input: unknown,
  errors: string[],
): input is KnowledgePodCatalogSummary {
  if (!isRecord(input)) return reject(errors, "catalog summary must be an object");
  let valid = validateSummaryBeforePolicy(input, errors);
  if (input.modelUsePolicy !== undefined) {
    valid = combineAdmissions(valid, validateModelUsePolicy(input.modelUsePolicy, errors));
  }
  valid = combineAdmissions(valid, validateSummaryAfterPolicy(input, errors));
  return valid && errors.length === 0;
}

function isCatalogString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0 && isSafeDisplaySummary(input);
}

function isCatalogCount(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function isCatalogTimestamp(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input) && input >= 0;
}

function admitsCapsuleEntry(
  input: unknown,
  errors: string[],
): input is LocalKnowledgeCapsuleListEntry {
  if (!isRecord(input)) return reject(errors, "capsule entry must be an object");
  onlyKeys(
    input,
    ["id", "displayName", "lifecycleState", "sourceCount", "updatedAt"],
    "capsule",
    errors,
  );
  const fields = [
    isCatalogString(input.id),
    isCatalogString(input.displayName),
    typeof input.lifecycleState === "string" &&
      CAPSULE_LIFECYCLE_STATES_ADMISSION.has(input.lifecycleState),
    isCatalogCount(input.sourceCount),
    isCatalogTimestamp(input.updatedAt),
  ];
  const valid = fields.every(Boolean);
  return valid || reject(errors, "capsule entry fields are invalid");
}

function admitsCapsuleSetEntry(
  input: unknown,
  errors: string[],
): input is LocalKnowledgeCapsuleSetListEntry {
  if (!isRecord(input)) return reject(errors, "capsule set entry must be an object");
  onlyKeys(input, ["id", "displayName", "capsuleCount", "composedAt"], "capsuleSet", errors);
  const fields = [
    isCatalogString(input.id),
    isCatalogString(input.displayName),
    isCatalogCount(input.capsuleCount),
    isCatalogTimestamp(input.composedAt),
  ];
  const valid = fields.every(Boolean);
  return valid || reject(errors, "capsule set entry fields are invalid");
}

function admitsCatalogArray<T>(
  input: unknown,
  errors: string[],
  admit: (value: unknown, errors: string[]) => value is T,
): input is readonly T[] {
  if (!Array.isArray(input)) return reject(errors, "catalog member must be an array");
  const extent = input.length;
  if (!isCapturedExtent(extent)) return reject(errors, "catalog extent is invalid");
  let valid = true;
  for (let index = 0; index < extent; index += 1) {
    const member: unknown = input[index];
    valid = combineAdmissions(valid, admit(member, errors));
  }
  return combineAdmissions(valid, validateStableExtent(input, extent, "catalog", errors));
}

function admitsCatalogSummaries(
  input: unknown,
  errors: string[],
): input is readonly KnowledgePodCatalogSummary[] | undefined {
  return input === undefined || admitsCatalogArray(input, errors, admitsCatalogSummary);
}

function admitsCapsulesCatalog(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & LocalKnowledgeCapsulesCatalogResponse {
  onlyKeys(input, ["capsules", "knowledgePods"], "catalog", errors);
  let valid = admitsCatalogArray(input.capsules, errors, admitsCapsuleEntry);
  valid = combineAdmissions(valid, admitsCatalogSummaries(input.knowledgePods, errors));
  return valid && errors.length === 0;
}

function admitsCapsuleSetsCatalog(
  input: Record<string, unknown>,
  errors: string[],
): input is Record<string, unknown> & LocalKnowledgeCapsuleSetsCatalogResponse {
  onlyKeys(input, ["capsuleSets", "knowledgePods"], "catalog", errors);
  let valid = admitsCatalogArray(input.capsuleSets, errors, admitsCapsuleSetEntry);
  valid = combineAdmissions(valid, admitsCatalogSummaries(input.knowledgePods, errors));
  return valid && errors.length === 0;
}

export function parseLocalKnowledgeCapsulesResponse(
  input: unknown,
): LocalKnowledgeValidation<LocalKnowledgeCapsulesCatalogResponse> {
  if (!isRecord(input)) return { ok: false, errors: ["catalog must be an object"] };
  const errors: string[] = [];
  return admitsCapsulesCatalog(input, errors) ? { ok: true, value: input } : { ok: false, errors };
}

export function parseLocalKnowledgeCapsuleSetsResponse(
  input: unknown,
): LocalKnowledgeValidation<LocalKnowledgeCapsuleSetsCatalogResponse> {
  if (!isRecord(input)) return { ok: false, errors: ["catalog must be an object"] };
  const errors: string[] = [];
  return admitsCapsuleSetsCatalog(input, errors)
    ? { ok: true, value: input }
    : { ok: false, errors };
}
