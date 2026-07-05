import type {
  EmbeddingModelIdentity,
  EmbeddingVectorMetric,
  EmbeddingVectorNormalization,
} from "./local-knowledge.js";

export const EMBEDDING_PROFILE_SCHEMA_VERSION = "1" as const;

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

export function embeddingProfileKey(profile: EmbeddingProfileIdentity): string {
  return [
    profile.provider,
    profile.modelId,
    profile.modelFamily,
    String(profile.vectorDimensions),
    profile.vectorMetric,
    profile.normalization ?? "legacy",
    profile.instructionVersion ?? "legacy",
    profile.embeddingSpaceFingerprint ?? "unverified",
    String(profile.dimensionsParam ?? ""),
    profile.tokenizer ?? "unknown-tokenizer",
    profile.locality,
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

export function compareEmbeddingProfiles(
  left: EmbeddingProfileIdentity | undefined,
  right: EmbeddingProfileIdentity | undefined,
): EmbeddingProfileCompatibilityDecision {
  if (left === undefined) return unknown("missing-left-profile");
  if (right === undefined) return unknown("missing-right-profile");
  if (left.locality === "opaque" || right.locality === "opaque") return opaqueDecision();
  if (!profileHasQueryEmbedding(left) || !profileHasQueryEmbedding(right))
    return unavailableDecision();
  const mismatch = profileMismatchReason(left, right);
  if (mismatch !== undefined) return incompatible(mismatch);
  if (legacyOrUnverified(left) || legacyOrUnverified(right)) {
    return unknown("legacy-unverified-profile");
  }
  return same(left);
}
