import { describe, expect, it } from "vitest";
import type { EmbeddingModelIdentity } from "./local-knowledge.js";
import {
  compareEmbeddingProfiles,
  embeddingProfileFromModelIdentity,
  embeddingProfileKey,
  inferEmbeddingModelFamily,
  type EmbeddingProfileIdentity,
} from "./local-knowledge-embedding-profiles.js";

const HARDENED_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai-compatible",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:aaaaaaaaaaaaaaaaaaaaaaaa",
};

function hardenedProfile(
  overrides: Partial<EmbeddingModelIdentity> = {},
): EmbeddingProfileIdentity {
  return embeddingProfileFromModelIdentity({ ...HARDENED_IDENTITY, ...overrides });
}

describe("embedding profile compatibility", () => {
  it("derives a stable model family and profile key from a hardened identity", () => {
    const profile = hardenedProfile();

    expect(inferEmbeddingModelFamily("text-embedding-3-small")).toBe("text");
    expect(profile.modelFamily).toBe("text");
    expect(embeddingProfileKey(profile)).toContain("text-embedding-3-small");
  });

  it("treats identical hardened profiles as same and query-embedding eligible", () => {
    const profile = hardenedProfile();
    const decision = compareEmbeddingProfiles(profile, { ...profile });

    expect(decision).toEqual({
      status: "same",
      reason: "same-profile",
      compatible: true,
      queryEmbeddingAllowed: true,
      reindexRecommended: false,
    });
  });

  it("treats legacy unverified profiles as unknown rather than compatible", () => {
    const left = embeddingProfileFromModelIdentity({
      provider: "openai-compatible",
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    });

    const decision = compareEmbeddingProfiles(left, { ...left });

    expect(decision).toMatchObject({
      status: "unknown",
      reason: "legacy-unverified-profile",
      compatible: false,
      queryEmbeddingAllowed: false,
      reindexRecommended: true,
    });
  });

  it("marks model and dimension mismatches incompatible", () => {
    expect(
      compareEmbeddingProfiles(hardenedProfile(), hardenedProfile({ modelId: "other" })).reason,
    ).toBe("model-mismatch");
    expect(
      compareEmbeddingProfiles(hardenedProfile(), hardenedProfile({ vectorDimensions: 768 }))
        .reason,
    ).toBe("dimension-mismatch");
  });

  it("treats fingerprint mismatch as unknown rather than structurally incompatible", () => {
    expect(
      compareEmbeddingProfiles(
        hardenedProfile(),
        hardenedProfile({
          embeddingSpaceFingerprint:
            "keiko-embedding-space-fingerprint-v1:bbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "fingerprint-mismatch",
      compatible: false,
      queryEmbeddingAllowed: false,
      reindexRecommended: true,
    });
  });

  it("pins each single-field mismatch to its own incompatibility reason", () => {
    // Guards the ordered PROFILE_COMPARISONS table against a mutation that deletes or reorders an
    // entry: each override differs from the hardened baseline in exactly one comparison field, so
    // the reported reason must be that field's reason. (model and dimension mismatch are pinned
    // separately above; fingerprint mismatch is unknown rather than incompatible.)
    const cases: readonly [EmbeddingProfileIdentity, string][] = [
      [hardenedProfile({ provider: "azure-openai" }), "provider-mismatch"],
      [hardenedProfile({ vectorMetric: "dot" }), "metric-mismatch"],
      [
        embeddingProfileFromModelIdentity(HARDENED_IDENTITY, { modelFamily: "other-family" }),
        "model-family-mismatch",
      ],
      [hardenedProfile({ normalization: "none" }), "normalization-mismatch"],
      [
        hardenedProfile({ instructionVersion: "keiko-embedding-input-v2" }),
        "instruction-version-mismatch",
      ],
      [hardenedProfile({ dimensionsParam: 512 }), "dimensions-param-mismatch"],
      [
        embeddingProfileFromModelIdentity(HARDENED_IDENTITY, { tokenizer: "cl100k_base" }),
        "tokenizer-mismatch",
      ],
    ];

    for (const [right, reason] of cases) {
      const decision = compareEmbeddingProfiles(hardenedProfile(), right);
      expect(decision).toMatchObject({
        status: "incompatible",
        reason,
        compatible: false,
        queryEmbeddingAllowed: false,
        reindexRecommended: true,
      });
    }
  });

  it("degrades to unknown when either side has no profile identity", () => {
    const profile = hardenedProfile();

    expect(compareEmbeddingProfiles(undefined, profile)).toMatchObject({
      status: "unknown",
      reason: "missing-left-profile",
      compatible: false,
      queryEmbeddingAllowed: false,
      reindexRecommended: true,
    });
    expect(compareEmbeddingProfiles(profile, undefined)).toMatchObject({
      status: "unknown",
      reason: "missing-right-profile",
      compatible: false,
      queryEmbeddingAllowed: false,
      reindexRecommended: true,
    });
  });

  it("models opaque and policy-denied spaces without recommending automatic reindex", () => {
    const profile = hardenedProfile();
    const opaque = embeddingProfileFromModelIdentity(HARDENED_IDENTITY, { locality: "opaque" });
    const denied = embeddingProfileFromModelIdentity(HARDENED_IDENTITY, {
      policyCapabilities: ["external-denied"],
    });

    expect(compareEmbeddingProfiles(profile, opaque)).toMatchObject({
      status: "opaque",
      reason: "opaque-profile",
      reindexRecommended: false,
    });
    expect(compareEmbeddingProfiles(profile, denied)).toMatchObject({
      status: "unavailable",
      reason: "policy-denied",
      reindexRecommended: false,
    });
  });
});
