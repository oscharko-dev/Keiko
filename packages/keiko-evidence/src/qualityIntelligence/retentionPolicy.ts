// QI retention profiles (Issue #274, ADR-0023 D8).
//
// Frozen, typed constants describing how long a QI run's evidence record persists locally before
// it becomes a candidate for `applyQualityIntelligenceRetention`. The profile is a pure
// description; the decision function is in `./retention.ts`.

export interface QualityIntelligenceRetentionProfile {
  readonly id: string;
  readonly description: string;
  readonly retainedDays: number;
  readonly maxRunArtifacts: number;
}

// Three pre-shipped profiles. New profiles are added by extending this map; the IDs are
// referenced by string on the manifest, so renaming a profile is a manifest-schema breaking
// change (bump `QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION`).
const QI_RETENTION_PROFILES_MUTABLE: Record<string, QualityIntelligenceRetentionProfile> = {
  "qi:short-30d": Object.freeze({
    id: "qi:short-30d",
    description: "Short retention: 30 days, up to 100 runs.",
    retainedDays: 30,
    maxRunArtifacts: 100,
  }),
  "qi:standard-90d": Object.freeze({
    id: "qi:standard-90d",
    description: "Standard retention: 90 days, up to 500 runs.",
    retainedDays: 90,
    maxRunArtifacts: 500,
  }),
  "qi:long-365d": Object.freeze({
    id: "qi:long-365d",
    description: "Long retention: 365 days, up to 2000 runs.",
    retainedDays: 365,
    maxRunArtifacts: 2000,
  }),
};

// The exposed table is a frozen view; mutating it (or any contained profile) throws in strict
// mode and is a no-op otherwise. Tests assert frozenness as a regression guard.
export const QUALITY_INTELLIGENCE_RETENTION_PROFILES: Readonly<
  Record<string, QualityIntelligenceRetentionProfile>
> = Object.freeze(QI_RETENTION_PROFILES_MUTABLE);

export const QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID = "qi:short-30d" as const;

// Looks up a profile by id, returning undefined for unknown ids. Callers MUST not throw on
// unknown — a future schema migration may introduce a profile a current binary does not know,
// and the local-state contract requires graceful read-back.
export function getQualityIntelligenceRetentionProfile(
  profileId: string,
): QualityIntelligenceRetentionProfile | undefined {
  return QUALITY_INTELLIGENCE_RETENTION_PROFILES[profileId];
}
