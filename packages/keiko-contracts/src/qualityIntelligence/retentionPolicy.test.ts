import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID,
  QUALITY_INTELLIGENCE_RETENTION_POLICY_IDS,
  resolveQualityIntelligenceRetentionPolicyId,
} from "./retentionPolicy.js";

describe("Quality Intelligence retention policy selection", () => {
  it("accepts every shipped retention profile", () => {
    expect(QUALITY_INTELLIGENCE_RETENTION_POLICY_IDS).toEqual([
      "qi:short-30d",
      "qi:standard-90d",
      "qi:long-365d",
    ]);
    for (const policyId of QUALITY_INTELLIGENCE_RETENTION_POLICY_IDS) {
      expect(resolveQualityIntelligenceRetentionPolicyId(policyId)).toBe(policyId);
    }
  });

  it.each([undefined, null, "", "qi:unknown", 90, {}])(
    "falls back to the 30-day profile for malformed selection %j",
    (value) => {
      expect(resolveQualityIntelligenceRetentionPolicyId(value)).toBe(
        QUALITY_INTELLIGENCE_DEFAULT_RETENTION_POLICY_ID,
      );
    },
  );
});
