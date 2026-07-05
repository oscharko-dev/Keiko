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

  it("marks model, dimension, and fingerprint mismatches incompatible", () => {
    expect(
      compareEmbeddingProfiles(hardenedProfile(), hardenedProfile({ modelId: "other" })).reason,
    ).toBe("model-mismatch");
    expect(
      compareEmbeddingProfiles(hardenedProfile(), hardenedProfile({ vectorDimensions: 768 }))
        .reason,
    ).toBe("dimension-mismatch");
    expect(
      compareEmbeddingProfiles(
        hardenedProfile(),
        hardenedProfile({
          embeddingSpaceFingerprint:
            "keiko-embedding-space-fingerprint-v1:bbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      ).reason,
    ).toBe("fingerprint-mismatch");
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
