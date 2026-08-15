// Embedding profile identity and compatibility contract for Knowledge Pod retrieval (Epic #1818,
// Issue #1843). A profile is the narrow, redaction-safe identity of the embedding space a pod's
// vectors live in. `compareEmbeddingProfiles` decides whether two spaces are the *same* space and
// may therefore share a query embedding; it fails closed to `unknown`/`incompatible`/`unavailable`/
// `opaque` for anything short of an exact hardened match. Raw vector scores are only comparable
// inside one space — cross-space evidence is fused by rank, never by raw score (see
// docs/adr/ADR-0036-hybrid-grounding-reciprocal-rank-fusion.md).

import type {
  EmbeddingModelIdentity,
  EmbeddingVectorMetric,
  EmbeddingVectorNormalization,
} from "./local-knowledge.js";

export const EMBEDDING_PROFILE_SCHEMA_VERSION = "1" as const;

// "local"/"remote" and "local-only"/"text-rerank" are reserved for future remote/federated pod
// (Epic #1820+) and reranking-capability follow-up work; the only current production producer
// (capsuleEmbeddingProfile) always sets locality: "provider" and policyCapabilities from
// {"query-embedding", "external-denied"}. Not dead code -- forward-compatibility placeholders.
export type EmbeddingProfileLocality = "local" | "provider" | "remote" | "opaque";

export type EmbeddingProfilePolicyCapability =
  "query-embedding" | "local-only" | "external-denied" | "text-rerank";

export const EMBEDDING_PROFILE_POLICY_CAPABILITIES: readonly EmbeddingProfilePolicyCapability[] = [
  "query-embedding",
  "local-only",
  "external-denied",
  "text-rerank",
] as const;

export type EmbeddingProfileCompatibilityStatus =
  "same" | "unknown" | "incompatible" | "unavailable" | "opaque";

export type EmbeddingProfileCompatibilityReason =
  | "same-profile"
  | "legacy-unverified-profile"
  | "missing-left-profile"
  | "missing-right-profile"
  | "provider-mismatch"
  | "model-mismatch"
  | "model-revision-mismatch"
  | "model-family-mismatch"
  | "dimension-mismatch"
  | "metric-mismatch"
  | "normalization-mismatch"
  | "instruction-version-mismatch"
  | "fingerprint-mismatch"
  | "dimensions-param-mismatch"
  | "tokenizer-mismatch"
  | "profile-unavailable"
  | "opaque-profile"
  | "policy-denied";

export const EMBEDDING_PROFILE_COMPATIBILITY_STATUSES: readonly EmbeddingProfileCompatibilityStatus[] =
  ["same", "unknown", "incompatible", "unavailable", "opaque"] as const;

export const EMBEDDING_PROFILE_COMPATIBILITY_REASONS: readonly EmbeddingProfileCompatibilityReason[] =
  [
    "same-profile",
    "legacy-unverified-profile",
    "missing-left-profile",
    "missing-right-profile",
    "provider-mismatch",
    "model-mismatch",
    "model-revision-mismatch",
    "model-family-mismatch",
    "dimension-mismatch",
    "metric-mismatch",
    "normalization-mismatch",
    "instruction-version-mismatch",
    "fingerprint-mismatch",
    "dimensions-param-mismatch",
    "tokenizer-mismatch",
    "profile-unavailable",
    "opaque-profile",
    "policy-denied",
  ] as const;

export interface EmbeddingProfileIdentity {
  readonly schemaVersion: typeof EMBEDDING_PROFILE_SCHEMA_VERSION;
  readonly provider: string;
  readonly modelId: string;
  readonly modelFamily: string;
  readonly vectorDimensions: number;
  readonly vectorMetric: EmbeddingVectorMetric;
  readonly locality: EmbeddingProfileLocality;
  readonly policyCapabilities: readonly EmbeddingProfilePolicyCapability[];
  readonly tokenizer?: string;
  readonly modelRevision?: string;
  readonly normalization?: EmbeddingVectorNormalization;
  readonly instructionVersion?: string;
  readonly embeddingSpaceFingerprint?: string;
  readonly dimensionsParam?: number;
}

export interface EmbeddingProfileCompatibilityDecision {
  readonly status: EmbeddingProfileCompatibilityStatus;
  readonly reason: EmbeddingProfileCompatibilityReason;
  readonly compatible: boolean;
  readonly queryEmbeddingAllowed: boolean;
  readonly reindexRecommended: boolean;
}

export interface EmbeddingProfileFromModelOptions {
  readonly modelFamily?: string;
  readonly tokenizer?: string;
  readonly locality?: EmbeddingProfileLocality;
  readonly policyCapabilities?: readonly EmbeddingProfilePolicyCapability[];
}

const MODEL_FAMILY_DELIMITER = /[:@/._-]/u;

interface ProfileComparison {
  readonly reason: EmbeddingProfileCompatibilityReason;
  readonly matches: (left: EmbeddingProfileIdentity, right: EmbeddingProfileIdentity) => boolean;
}

const PROFILE_COMPARISONS: readonly ProfileComparison[] = [
  { reason: "provider-mismatch", matches: (left, right) => left.provider === right.provider },
  { reason: "model-mismatch", matches: (left, right) => left.modelId === right.modelId },
  // A model revision is a different embedding space: re-embedding the same text under a new revision
  // of the same modelId yields vectors that are not comparable with the old ones. Leaving it out of
  // both the comparison and the key made two revisions of one model compare as the SAME space, so a
  // reindex was never recommended and stale vectors were silently searched against fresh queries.
  {
    reason: "model-revision-mismatch",
    matches: (left, right) => left.modelRevision === right.modelRevision,
  },
  {
    reason: "model-family-mismatch",
    matches: (left, right) => left.modelFamily === right.modelFamily,
  },
  {
    reason: "dimension-mismatch",
    matches: (left, right) => left.vectorDimensions === right.vectorDimensions,
  },
  {
    reason: "metric-mismatch",
    matches: (left, right) => left.vectorMetric === right.vectorMetric,
  },
  {
    reason: "normalization-mismatch",
    matches: (left, right) => left.normalization === right.normalization,
  },
  {
    reason: "instruction-version-mismatch",
    matches: (left, right) => left.instructionVersion === right.instructionVersion,
  },
  {
    reason: "fingerprint-mismatch",
    matches: (left, right) => left.embeddingSpaceFingerprint === right.embeddingSpaceFingerprint,
  },
  {
    reason: "dimensions-param-mismatch",
    matches: (left, right) => left.dimensionsParam === right.dimensionsParam,
  },
  { reason: "tokenizer-mismatch", matches: (left, right) => left.tokenizer === right.tokenizer },
] as const;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function inferEmbeddingModelFamily(modelId: string): string {
  const trimmed = modelId.trim();
  const first = trimmed.split(MODEL_FAMILY_DELIMITER, 1)[0];
  return first !== undefined && first.length > 0 ? first : trimmed;
}

export function embeddingProfileFromModelIdentity(
  identity: EmbeddingModelIdentity,
  options: EmbeddingProfileFromModelOptions = {},
): EmbeddingProfileIdentity {
  const modelFamily = nonEmpty(options.modelFamily) ?? inferEmbeddingModelFamily(identity.modelId);
  const policyCapabilities = options.policyCapabilities ?? ["query-embedding"];
  return {
    schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
    provider: identity.provider,
    modelId: identity.modelId,
    modelFamily,
    vectorDimensions: identity.vectorDimensions,
    vectorMetric: identity.vectorMetric,
    locality: options.locality ?? "provider",
    policyCapabilities,
    ...optionalProfileFields(identity, options),
  };
}

function optionalProfileFields(
  identity: EmbeddingModelIdentity,
  options: EmbeddingProfileFromModelOptions,
): Partial<EmbeddingProfileIdentity> {
  return {
    ...(options.tokenizer !== undefined ? { tokenizer: options.tokenizer } : {}),
    ...(identity.modelRevision !== undefined ? { modelRevision: identity.modelRevision } : {}),
    ...(identity.normalization !== undefined ? { normalization: identity.normalization } : {}),
    ...(identity.instructionVersion !== undefined
      ? { instructionVersion: identity.instructionVersion }
      : {}),
    ...(identity.embeddingSpaceFingerprint !== undefined
      ? { embeddingSpaceFingerprint: identity.embeddingSpaceFingerprint }
      : {}),
    ...(identity.dimensionsParam !== undefined
      ? { dimensionsParam: identity.dimensionsParam }
      : {}),
  };
}

// Length-prefixes a component so no character inside it — including the "|" this function's
// caller uses as a (now purely decorative) reader-friendly separator — can shift where one
// component ends and the next begins. For a FIXED number of components in a FIXED order, framing
// every one this way makes the concatenation injective: reading a decimal length then consuming
// exactly that many characters admits only one parse, so `frame(a) + frame(b)` can equal
// `frame(a') + frame(b')` only when `a === a'` and `b === b'`, regardless of what "|" or ":"
// characters `a`/`b` themselves contain. Without this, a provider-supplied modelRevision "r|fam"
// paired with modelFamily "x" produced the identical joined key as modelRevision "r" paired with
// modelFamily "fam|x" — two different, incompatible profiles sharing one key. Same technique as
// keiko-server's framedDigest (workspace-manifest-identity.ts), minus the SHA-256 step this leaf
// package cannot take (leaf-package rule: no crypto) — collision-freedom needs only the framing,
// not a hash.
function frame(value: string): string {
  return `${String(value.length)}:${value}`;
}

// Frames an optional component so genuine ABSENCE and a provider literally reporting the word
// this function used to fall back to (e.g. modelRevision: "unversioned") can never collide into
// the same key: "-" (a fixed, single-character marker) can never equal "=" + anything, regardless
// of what a legitimate value contains, because the two cases always differ in their first
// character. Two distinct present values still compare correctly, since equality of "=" + a
// reduces to equality of a. The result is then length-prefixed by `frame`, same as every other
// component. Applied uniformly to every optional field for consistency, even where today's
// narrower value types make the specific collision unreachable (e.g. `normalization` is a closed
// enum that can never literally equal "legacy").
function keyComponent(value: string | undefined): string {
  return frame(value === undefined ? "-" : `=${value}`);
}

export function embeddingProfileKey(profile: EmbeddingProfileIdentity): string {
  return [
    frame(profile.provider),
    frame(profile.modelId),
    keyComponent(profile.modelRevision),
    frame(profile.modelFamily),
    frame(String(profile.vectorDimensions)),
    frame(profile.vectorMetric),
    keyComponent(profile.normalization),
    keyComponent(profile.instructionVersion),
    keyComponent(profile.embeddingSpaceFingerprint),
    keyComponent(
      profile.dimensionsParam === undefined ? undefined : String(profile.dimensionsParam),
    ),
    keyComponent(profile.tokenizer),
    frame(profile.locality),
  ].join("|");
}

function profileHasQueryEmbedding(profile: EmbeddingProfileIdentity): boolean {
  return (
    profile.policyCapabilities.includes("query-embedding") &&
    !profile.policyCapabilities.includes("external-denied")
  );
}

function legacyOrUnverified(profile: EmbeddingProfileIdentity): boolean {
  return (
    profile.normalization === undefined ||
    profile.instructionVersion === undefined ||
    profile.embeddingSpaceFingerprint === undefined
  );
}

function incompatible(
  reason: EmbeddingProfileCompatibilityReason,
): EmbeddingProfileCompatibilityDecision {
  return {
    status: "incompatible",
    reason,
    compatible: false,
    queryEmbeddingAllowed: false,
    reindexRecommended: true,
  };
}

function same(profile: EmbeddingProfileIdentity): EmbeddingProfileCompatibilityDecision {
  return {
    status: "same",
    reason: "same-profile",
    compatible: true,
    queryEmbeddingAllowed: profileHasQueryEmbedding(profile),
    reindexRecommended: false,
  };
}

function unknown(
  reason: EmbeddingProfileCompatibilityReason,
): EmbeddingProfileCompatibilityDecision {
  return {
    status: "unknown",
    reason,
    compatible: false,
    queryEmbeddingAllowed: false,
    reindexRecommended: true,
  };
}

function opaqueDecision(): EmbeddingProfileCompatibilityDecision {
  return {
    status: "opaque",
    reason: "opaque-profile",
    compatible: false,
    queryEmbeddingAllowed: false,
    reindexRecommended: false,
  };
}

function unavailableDecision(): EmbeddingProfileCompatibilityDecision {
  return {
    status: "unavailable",
    reason: "policy-denied",
    compatible: false,
    queryEmbeddingAllowed: false,
    reindexRecommended: false,
  };
}

function profileMismatchReason(
  left: EmbeddingProfileIdentity,
  right: EmbeddingProfileIdentity,
): EmbeddingProfileCompatibilityReason | undefined {
  return PROFILE_COMPARISONS.find((comparison) => !comparison.matches(left, right))?.reason;
}

function profileMismatchDecision(
  reason: EmbeddingProfileCompatibilityReason | undefined,
): EmbeddingProfileCompatibilityDecision | undefined {
  if (reason === undefined) return undefined;
  return reason === "fingerprint-mismatch" ? unknown(reason) : incompatible(reason);
}

export function compareEmbeddingProfiles(
  left: EmbeddingProfileIdentity | undefined,
  right: EmbeddingProfileIdentity | undefined,
): EmbeddingProfileCompatibilityDecision {
  if (left === undefined) return unknown("missing-left-profile");
  if (right === undefined) return unknown("missing-right-profile");
  if (left.locality === "opaque" || right.locality === "opaque") return opaqueDecision();
  if (!profileHasQueryEmbedding(left) || !profileHasQueryEmbedding(right))
    return unavailableDecision();
  const mismatch = profileMismatchDecision(profileMismatchReason(left, right));
  if (mismatch !== undefined) return mismatch;
  if (legacyOrUnverified(left) || legacyOrUnverified(right)) {
    return unknown("legacy-unverified-profile");
  }
  return same(left);
}
