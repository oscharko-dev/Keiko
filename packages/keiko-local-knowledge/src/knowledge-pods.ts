// Knowledge Pods compatibility projection for Epic #1815.
//
// This file deliberately maps current Local Knowledge capsules and capsule sets into the
// user-facing Knowledge Pod summary contract. It does not add storage, ranking, or retrieval
// behavior; it reuses the existing capsule/source/set lifecycle APIs and returns body-free,
// path-free summaries for UI and evidence-facing surfaces.

import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  compareEmbeddingProfiles,
  embeddingProfileFromModelIdentity,
  embeddingProfileKey,
  type EmbeddingProfileCompatibilityDecision,
  type EmbeddingProfileIdentity,
  type CapsuleLifecycleState,
  type CapsuleSet,
  type KnowledgeCapsule,
  type KnowledgeCapsuleId,
  type KnowledgePodCounts,
  type KnowledgePodModelUsePolicySummary,
  type KnowledgePodReadiness,
  type KnowledgePodRetrievalCapabilities,
  type KnowledgePodSetReadinessReasonCode,
  type KnowledgePodSetReadinessSummary,
  type KnowledgePodSourceKind,
  type KnowledgePodSummary,
  type KnowledgePodSummaryKind,
  type KnowledgeSource,
  isKnowledgePodEvidenceSafeText,
  resolveKnowledgePodModelUsePolicy,
  validateKnowledgePodSummary,
} from "@oscharko-dev/keiko-contracts";

import { getCapsule, listCapsules } from "./capsule-lifecycle.js";
import { listCapsuleSets } from "./capsule-set-lifecycle.js";
import { KnowledgeStoreError } from "./errors.js";
import { resolveScopeModelUsePolicy } from "./model-use-policy.js";
import { listCapsuleSources } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

interface CountRow {
  readonly n: number;
}

interface CapsuleProjectionInput {
  readonly capsule: KnowledgeCapsule;
  readonly sources: readonly KnowledgeSource[];
  readonly counts: KnowledgePodCounts;
  readonly degradationReasons: readonly string[];
  readonly embeddingProfile: EmbeddingProfileIdentity;
  readonly embeddingDecision: EmbeddingProfileCompatibilityDecision;
}

interface CapsuleCounts {
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly vectorCount: number;
}

interface SetReadinessCounts {
  readyCount: number;
  draftCount: number;
  degradedCount: number;
  unavailableCount: number;
  deniedCount: number;
  indexingCount: number;
  staleCount: number;
  errorCount: number;
  missingCount: number;
}

type MemberReadinessCountKey = Exclude<keyof SetReadinessCounts, "deniedCount" | "missingCount">;

const BASE_PRIVACY = {
  localFirst: true,
  modelOpen: true,
  rawContentExposed: false,
  privatePathsExposed: false,
  evidenceMode: "counts-hashes-and-status",
  storageLocation: "local-runtime-state",
} as const;

const POD_FALLBACK_DISPLAY_NAME = "Knowledge Pod";
const POD_SET_FALLBACK_DISPLAY_NAME = "Knowledge Pod Set";
const MEMBER_READINESS_BUCKETS: Record<
  KnowledgePodReadiness,
  {
    readonly countKey: MemberReadinessCountKey;
    readonly reason?: KnowledgePodSetReadinessReasonCode;
  }
> = {
  ready: { countKey: "readyCount" },
  draft: { countKey: "draftCount", reason: "member-draft" },
  degraded: { countKey: "degradedCount", reason: "member-degraded" },
  unavailable: { countKey: "unavailableCount", reason: "member-unavailable" },
  indexing: { countKey: "indexingCount", reason: "member-indexing" },
  stale: { countKey: "staleCount", reason: "member-stale" },
  error: { countKey: "errorCount", reason: "member-error" },
};

export function listKnowledgePodSummaries(
  store: KnowledgeStore,
  kind?: KnowledgePodSummaryKind,
): readonly KnowledgePodSummary[] {
  // Scope the projection to the requested kind before building. Building a summary can fail
  // closed on corrupt state, so materializing an unrelated collection here would let one
  // corrupt standalone capsule 503 the pod-set listing (and vice versa).
  const pods =
    kind === "pod-set"
      ? []
      : listCapsules(store).map((capsule) => buildKnowledgePodSummary(store, capsule));
  const sets =
    kind === "pod"
      ? []
      : listCapsuleSets(store).map((set) => buildKnowledgePodSetSummary(store, set));
  return [...pods, ...sets];
}

export function buildKnowledgePodSummary(
  store: KnowledgeStore,
  capsule: KnowledgeCapsule,
): KnowledgePodSummary {
  const sources = listCapsuleSources(store, capsule.id);
  const counts = capsuleCounts(store, capsule.id);
  const embeddingProfile = capsuleEmbeddingProfile(capsule);
  const embeddingDecision = compareEmbeddingProfiles(embeddingProfile, embeddingProfile);
  return assertValidSummary(
    capsuleProjection({
      capsule,
      sources,
      counts: {
        capsuleCount: 1,
        sourceCount: sources.length,
        ...counts,
      },
      embeddingProfile,
      embeddingDecision,
      degradationReasons: capsuleDegradationReasons(capsule, sources, counts, embeddingDecision),
    }),
  );
}

export function buildKnowledgePodSetSummary(
  store: KnowledgeStore,
  set: CapsuleSet,
): KnowledgePodSummary {
  const memberProjections = set.capsuleIds
    .map((id) => memberProjection(store, id))
    .filter((projection): projection is CapsuleProjectionInput => projection !== undefined);
  const counts = sumCounts(memberProjections, set.capsuleIds.length);
  const sourceKinds = uniqueSourceKinds(
    memberProjections.flatMap((projection) => projection.sources),
  );
  const embeddingDecision = setEmbeddingDecision(memberProjections);
  const modelUsePolicy = setModelUsePolicySummary(memberProjections);
  const degradationReasons = uniqueStrings([
    ...missingMemberReasons(set, memberProjections),
    ...memberProjections.flatMap((projection) => projection.degradationReasons),
    ...(counts.vectorCount > 0 ? embeddingDegradationReasons(embeddingDecision) : []),
  ]);
  return assertValidSummary({
    schemaVersion: KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
    id: set.id,
    kind: "pod-set",
    displayName: safeDisplayName(set.displayName, POD_SET_FALLBACK_DISPLAY_NAME),
    ...safeDescription(set.description),
    tags: safeTags(set.tags),
    readiness: setReadiness(memberProjections, degradationReasons),
    counts,
    setReadiness: setReadinessSummary(set, memberProjections, embeddingDecision),
    sourceKinds,
    retrieval: setRetrieval(memberProjections, embeddingDecision),
    privacy: BASE_PRIVACY,
    governance: governanceForPolicy(modelUsePolicy),
    modelUsePolicy,
    compatibility: {
      backingKind: "capsule-set",
      capsuleIds: set.capsuleIds,
      sourceIds: uniqueSourceIds(memberProjections),
      localKnowledgeSchemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: set.composedAt,
    degradationReasons,
  });
}

function assertValidSummary(summary: KnowledgePodSummary): KnowledgePodSummary {
  const validation = validateKnowledgePodSummary(summary);
  if (!validation.ok) {
    throw new KnowledgeStoreError("Knowledge Pod summary validation failed.");
  }
  return validation.value;
}

function capsuleProjection(input: CapsuleProjectionInput): KnowledgePodSummary {
  const modelUsePolicy = capsuleModelUsePolicySummary(input.capsule);
  return {
    schemaVersion: KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
    id: input.capsule.id,
    kind: "pod",
    displayName: safeDisplayName(input.capsule.displayName, POD_FALLBACK_DISPLAY_NAME),
    ...safeDescription(input.capsule.description),
    tags: safeTags(input.capsule.tags),
    readiness: capsuleReadiness(input.capsule.lifecycleState, input.degradationReasons),
    lifecycleState: input.capsule.lifecycleState,
    counts: input.counts,
    sourceKinds: uniqueSourceKinds(input.sources),
    retrieval: capsuleRetrieval(
      input.capsule,
      input.counts,
      input.embeddingProfile,
      input.embeddingDecision,
    ),
    privacy: BASE_PRIVACY,
    governance: governanceForPolicy(modelUsePolicy),
    modelUsePolicy,
    compatibility: {
      backingKind: "knowledge-capsule",
      capsuleIds: [input.capsule.id],
      sourceIds: input.sources.map((source) => source.id),
      localKnowledgeSchemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: input.capsule.updatedAt,
    degradationReasons: input.degradationReasons,
  };
}

function capsuleModelUsePolicySummary(
  capsule: KnowledgeCapsule,
): KnowledgePodModelUsePolicySummary {
  return resolveKnowledgePodModelUsePolicy(capsule.modelUsePolicy);
}

function setModelUsePolicySummary(
  members: readonly CapsuleProjectionInput[],
): KnowledgePodModelUsePolicySummary {
  // Reuse the single canonical scope-aggregation path (model-use-policy.ts) that already governs
  // retrieval gating, so a pod-set's displayed policy never diverges from its enforced policy.
  return resolveScopeModelUsePolicy(members.map((member) => member.capsule));
}

function governanceForPolicy(
  policy: KnowledgePodModelUsePolicySummary,
): KnowledgePodSummary["governance"] {
  return {
    locationKind: "local",
    sealingPosture: hasSealedOperation(policy) ? "sealed-pod-policy" : "local-store-policy",
    policyPosture: policy.source === "explicit" ? "policy-pack" : "not-declared",
    managedServiceDependency: false,
  };
}

function hasSealedOperation(policy: KnowledgePodModelUsePolicySummary): boolean {
  return (
    policy.mode === "sealed-local" ||
    policy.operations.externalEmbeddings === "deny" ||
    policy.operations.externalReranking === "deny" ||
    policy.operations.answerSynthesis === "deny" ||
    policy.operations.rawContentRelease === "deny"
  );
}

function memberProjection(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): CapsuleProjectionInput | undefined {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) return undefined;
  const sources = listCapsuleSources(store, capsule.id);
  const counts = capsuleCounts(store, capsule.id);
  const embeddingProfile = capsuleEmbeddingProfile(capsule);
  const embeddingDecision = compareEmbeddingProfiles(embeddingProfile, embeddingProfile);
  const projection = {
    capsule,
    sources,
    counts: {
      capsuleCount: 1,
      sourceCount: sources.length,
      ...counts,
    },
    embeddingProfile,
    embeddingDecision,
    degradationReasons: capsuleDegradationReasons(capsule, sources, counts, embeddingDecision),
  };
  assertValidSummary(capsuleProjection(projection));
  return projection;
}

function capsuleCounts(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): CapsuleCounts {
  return {
    documentCount: countRows(store, "documents", capsuleId),
    chunkCount: countRows(store, "chunks", capsuleId),
    vectorCount: countRows(store, "vectors", capsuleId),
  };
}

function countRows(
  store: KnowledgeStore,
  table: "documents" | "chunks" | "vectors",
  capsuleId: KnowledgeCapsuleId,
): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :capsuleId`)
    .get({ capsuleId: String(capsuleId) }) as CountRow | undefined;
  return row?.n ?? 0;
}

function capsuleDegradationReasons(
  capsule: KnowledgeCapsule,
  sources: readonly KnowledgeSource[],
  counts: CapsuleCounts,
  embeddingDecision: EmbeddingProfileCompatibilityDecision,
): readonly string[] {
  const reasons: string[] = [];
  if (sources.length === 0) reasons.push("No sources are attached.");
  if (capsule.lifecycleState === "draft") reasons.push("The pod has not been indexed yet.");
  if (capsule.lifecycleState === "indexing") reasons.push("Indexing is still in progress.");
  if (capsule.lifecycleState === "stale") reasons.push("The pod should be refreshed.");
  if (capsule.lifecycleState === "error") reasons.push("The last indexing run ended with errors.");
  if (sources.length > 0 && counts.vectorCount === 0 && capsule.lifecycleState !== "draft") {
    reasons.push("No retrieval vectors are available yet.");
  }
  if (counts.vectorCount > 0) reasons.push(...embeddingDegradationReasons(embeddingDecision));
  return reasons;
}

function capsuleReadiness(
  lifecycleState: CapsuleLifecycleState,
  degradationReasons: readonly string[],
): KnowledgePodReadiness {
  if (lifecycleState === "ready") {
    return degradationReasons.length === 0 ? "ready" : "degraded";
  }
  if (lifecycleState === "deleting") return "unavailable";
  return lifecycleState;
}

function setReadiness(
  members: readonly CapsuleProjectionInput[],
  degradationReasons: readonly string[],
): KnowledgePodReadiness {
  if (members.length === 0) return "unavailable";
  if (members.some((member) => member.capsule.lifecycleState === "indexing")) return "indexing";
  if (members.every((member) => member.capsule.lifecycleState === "ready")) {
    return degradationReasons.length === 0 ? "ready" : "degraded";
  }
  if (members.some((member) => member.capsule.lifecycleState === "error")) return "error";
  if (members.some((member) => member.capsule.lifecycleState === "stale")) return "stale";
  return "draft";
}

function setReadinessSummary(
  set: CapsuleSet,
  members: readonly CapsuleProjectionInput[],
  embeddingDecision: EmbeddingProfileCompatibilityDecision | undefined,
): KnowledgePodSetReadinessSummary {
  const reasonCodes = new Set<KnowledgePodSetReadinessReasonCode>();
  const counts: SetReadinessCounts = {
    readyCount: 0,
    draftCount: 0,
    degradedCount: 0,
    unavailableCount: 0,
    deniedCount: 0,
    indexingCount: 0,
    staleCount: 0,
    errorCount: 0,
    missingCount: Math.max(set.capsuleIds.length - members.length, 0),
  };
  if (counts.missingCount > 0) reasonCodes.add("missing-member");
  for (const member of members) {
    addMemberReadiness(counts, reasonCodes, member);
  }
  addEmbeddingReadinessReason(reasonCodes, embeddingDecision);
  return { ...counts, reasonCodes: [...reasonCodes] };
}

function addMemberReadiness(
  counts: SetReadinessCounts,
  reasonCodes: Set<KnowledgePodSetReadinessReasonCode>,
  member: CapsuleProjectionInput,
): void {
  const readiness = capsuleReadiness(member.capsule.lifecycleState, member.degradationReasons);
  addPolicyReadinessReason(counts, reasonCodes, member.capsule);
  addContentReadinessReasons(reasonCodes, member);
  const bucket = MEMBER_READINESS_BUCKETS[readiness];
  counts[bucket.countKey] += 1;
  if (bucket.reason !== undefined) reasonCodes.add(bucket.reason);
}

function addPolicyReadinessReason(
  counts: SetReadinessCounts,
  reasonCodes: Set<KnowledgePodSetReadinessReasonCode>,
  capsule: KnowledgeCapsule,
): void {
  const policy = capsuleModelUsePolicySummary(capsule);
  if (
    policy.operations.answerSynthesis !== "deny" &&
    policy.operations.rawContentRelease !== "deny"
  ) {
    return;
  }
  counts.deniedCount += 1;
  reasonCodes.add("policy-denied");
}

function addContentReadinessReasons(
  reasonCodes: Set<KnowledgePodSetReadinessReasonCode>,
  member: CapsuleProjectionInput,
): void {
  if (member.sources.length === 0) reasonCodes.add("no-sources");
  else if (member.counts.vectorCount === 0) reasonCodes.add("no-vectors");
}

function addEmbeddingReadinessReason(
  reasonCodes: Set<KnowledgePodSetReadinessReasonCode>,
  decision: EmbeddingProfileCompatibilityDecision | undefined,
): void {
  if (decision === undefined || decision.status === "same") return;
  if (decision.status === "unknown") reasonCodes.add("embedding-unknown");
  if (decision.status === "incompatible") reasonCodes.add("embedding-incompatible");
  if (decision.status === "unavailable") reasonCodes.add("embedding-unavailable");
  if (decision.status === "opaque") reasonCodes.add("embedding-opaque");
}

function capsuleRetrieval(
  capsule: KnowledgeCapsule,
  counts: KnowledgePodCounts,
  embeddingProfile: EmbeddingProfileIdentity,
  embeddingDecision: EmbeddingProfileCompatibilityDecision,
): KnowledgePodRetrievalCapabilities {
  return {
    lexicalIndex: counts.chunkCount > 0,
    vectorIndex: counts.vectorCount > 0,
    hybridGrounding: true,
    crossSpaceScoreMixing: false,
    ...safeRetrievalText("embeddingProvider", capsule.embeddingModelIdentity.provider),
    ...safeRetrievalText("embeddingModelId", capsule.embeddingModelIdentity.modelId),
    ...(capsule.embeddingModelIdentity.embeddingSpaceFingerprint !== undefined
      ? safeRetrievalText(
          "embeddingSpaceFingerprint",
          capsule.embeddingModelIdentity.embeddingSpaceFingerprint,
        )
      : {}),
    vectorDimensions: capsule.embeddingModelIdentity.vectorDimensions,
    vectorMetric: capsule.embeddingModelIdentity.vectorMetric,
    ...safeRetrievalText("embeddingProfileKey", embeddingProfileKey(embeddingProfile)),
    embeddingCompatibilityStatus: embeddingDecision.status,
    embeddingCompatibilityReason: embeddingDecision.reason,
    reindexRecommended: embeddingDecision.reindexRecommended,
    queryEmbeddingAllowed: embeddingDecision.queryEmbeddingAllowed,
  };
}

function setRetrieval(
  members: readonly CapsuleProjectionInput[],
  embeddingDecision: EmbeddingProfileCompatibilityDecision | undefined,
): KnowledgePodRetrievalCapabilities {
  return {
    lexicalIndex: members.some((member) => member.counts.chunkCount > 0),
    vectorIndex: members.some((member) => member.counts.vectorCount > 0),
    hybridGrounding: true,
    crossSpaceScoreMixing: false,
    ...(embeddingDecision === undefined
      ? {}
      : {
          embeddingCompatibilityStatus: embeddingDecision.status,
          embeddingCompatibilityReason: embeddingDecision.reason,
          reindexRecommended: embeddingDecision.reindexRecommended,
          queryEmbeddingAllowed: embeddingDecision.queryEmbeddingAllowed,
        }),
  };
}

function capsuleEmbeddingProfile(capsule: KnowledgeCapsule): EmbeddingProfileIdentity {
  const modelUsePolicy = capsuleModelUsePolicySummary(capsule);
  return embeddingProfileFromModelIdentity(capsule.embeddingModelIdentity, {
    locality: "provider",
    policyCapabilities:
      modelUsePolicy.operations.externalEmbeddings === "allow"
        ? ["query-embedding"]
        : ["external-denied"],
  });
}

function setEmbeddingDecision(
  members: readonly CapsuleProjectionInput[],
): EmbeddingProfileCompatibilityDecision | undefined {
  const first = members[0];
  if (first === undefined) return undefined;
  const firstNonSame = members.find((member) => member.embeddingDecision.status !== "same");
  if (firstNonSame !== undefined) return firstNonSame.embeddingDecision;
  for (const member of members.slice(1)) {
    const decision = compareEmbeddingProfiles(first.embeddingProfile, member.embeddingProfile);
    if (decision.status !== "same") return decision;
  }
  return first.embeddingDecision;
}

function embeddingDegradationReasons(
  decision: EmbeddingProfileCompatibilityDecision | undefined,
): readonly string[] {
  if (decision === undefined || decision.status === "same") return [];
  if (decision.status === "unknown") {
    return ["Embedding profile compatibility is unverified; full re-embed is recommended."];
  }
  if (decision.status === "unavailable") {
    return ["Embedding profile cannot run semantic retrieval under the current policy."];
  }
  if (decision.status === "opaque") {
    return ["Embedding profile is opaque; semantic compatibility cannot be established."];
  }
  return ["Embedding profile is incompatible with the current semantic retrieval space."];
}

function uniqueSourceKinds(sources: readonly KnowledgeSource[]): readonly KnowledgePodSourceKind[] {
  return uniqueStrings(
    sources.map((source) => source.scope.kind),
  ) as readonly KnowledgePodSourceKind[];
}

function uniqueSourceIds(
  members: readonly CapsuleProjectionInput[],
): readonly KnowledgeSource["id"][] {
  return uniqueStrings(
    members.flatMap((member) => member.sources.map((source) => source.id)),
  ) as readonly KnowledgeSource["id"][];
}

function missingMemberReasons(
  set: CapsuleSet,
  members: readonly CapsuleProjectionInput[],
): readonly string[] {
  const loaded = new Set(members.map((member) => String(member.capsule.id)));
  const missing = set.capsuleIds.filter((id) => !loaded.has(String(id))).length;
  return missing > 0 ? [`${missing.toString()} member pod could not be loaded.`] : [];
}

function sumCounts(
  members: readonly CapsuleProjectionInput[],
  declaredCapsuleCount: number,
): KnowledgePodCounts {
  return {
    capsuleCount: declaredCapsuleCount,
    sourceCount: uniqueSourceIds(members).length,
    documentCount: members.reduce((sum, member) => sum + member.counts.documentCount, 0),
    chunkCount: members.reduce((sum, member) => sum + member.counts.chunkCount, 0),
    vectorCount: members.reduce((sum, member) => sum + member.counts.vectorCount, 0),
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function safeDisplayName(value: string, fallback: string): string {
  return isKnowledgePodEvidenceSafeText(value) ? value : fallback;
}

function safeDescription(value: string | undefined): { readonly description?: string } {
  return value !== undefined && isKnowledgePodEvidenceSafeText(value) ? { description: value } : {};
}

function safeTags(values: readonly string[]): readonly string[] {
  return values.filter(isKnowledgePodEvidenceSafeText);
}

function safeRetrievalText(
  key:
    "embeddingProvider" | "embeddingModelId" | "embeddingSpaceFingerprint" | "embeddingProfileKey",
  value: string,
): Partial<
  Pick<
    KnowledgePodRetrievalCapabilities,
    "embeddingProvider" | "embeddingModelId" | "embeddingSpaceFingerprint" | "embeddingProfileKey"
  >
> {
  if (!isKnowledgePodEvidenceSafeText(value)) return {};
  switch (key) {
    case "embeddingProvider":
      return { embeddingProvider: value };
    case "embeddingModelId":
      return { embeddingModelId: value };
    case "embeddingSpaceFingerprint":
      return { embeddingSpaceFingerprint: value };
    case "embeddingProfileKey":
      return { embeddingProfileKey: value };
  }
}
