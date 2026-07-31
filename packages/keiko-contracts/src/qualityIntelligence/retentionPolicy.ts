// Browser-safe Quality Intelligence retention selection contract (Issue #2861).
//
// The evidence package owns profile limits and deletion decisions. Contracts owns only the stable
// identifiers shared by the UI, BFF, workflows, and evidence. Keeping the fallback here prevents a
// malformed persisted setting from creating an unknown profile on a newly recorded run.

export const QUALITY_INTELLIGENCE_RETENTION_POLICY_IDS = [
  "qi:short-30d",
  "qi:standard-90d",
  "qi:long-365d",
] as const;

export type QualityIntelligenceRetentionPolicyId =
  (typeof QUALITY_INTELLIGENCE_RETENTION_POLICY_IDS)[number];

export const QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID =
  "qi:short-30d" as const satisfies QualityIntelligenceRetentionPolicyId;

const QUALITY_INTELLIGENCE_RETENTION_POLICY_ID_SET: ReadonlySet<string> = new Set(
  QUALITY_INTELLIGENCE_RETENTION_POLICY_IDS,
);

export function isQualityIntelligenceRetentionPolicyId(
  value: unknown,
): value is QualityIntelligenceRetentionPolicyId {
  return typeof value === "string" && QUALITY_INTELLIGENCE_RETENTION_POLICY_ID_SET.has(value);
}

export function resolveQualityIntelligenceRetentionPolicyId(
  value: unknown,
): QualityIntelligenceRetentionPolicyId {
  return isQualityIntelligenceRetentionPolicyId(value)
    ? value
    : QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID;
}
