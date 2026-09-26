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

  // KEIKO-0418: a model revision IS a different embedding space — re-embedding the same text under a
  // new revision of the same modelId produces vectors that are not comparable with the old ones.
  // With modelRevision outside both the comparison and the profile key, two revisions of one model
  // compared as identical, so no reindex was recommended and stale vectors were searched against
  // fresh queries.
  it("treats two revisions of the same model as different embedding spaces", () => {
    const left = hardenedProfile({ modelRevision: "2024-05" });
    const right = hardenedProfile({ modelRevision: "2025-01" });

    expect(compareEmbeddingProfiles(left, right).reason).toBe("model-revision-mismatch");
    expect(compareEmbeddingProfiles(left, right).compatible).toBe(false);
    expect(embeddingProfileKey(left)).not.toBe(embeddingProfileKey(right));
  });

  it("distinguishes a revisioned profile from an unversioned one", () => {
    const versioned = hardenedProfile({ modelRevision: "2025-01" });
    const unversioned = hardenedProfile();

    expect(compareEmbeddingProfiles(versioned, unversioned).reason).toBe("model-revision-mismatch");
    expect(embeddingProfileKey(versioned)).not.toBe(embeddingProfileKey(unversioned));
  });

  // embeddingProfileKey used `field ?? "sentinel"` for every optional component, so an absent
  // field and a provider legitimately reporting the sentinel word itself (e.g. modelRevision:
  // "unversioned") produced the IDENTICAL key — two genuinely different embedding spaces would
  // then share a key even though compareEmbeddingProfiles (direct `===` on the raw field)
  // correctly still calls them incompatible, making the key actively misleading.
  it("distinguishes an absent modelRevision from a provider literally reporting 'unversioned'", () => {
    const absent = hardenedProfile();
    const literal = hardenedProfile({ modelRevision: "unversioned" });

    expect(compareEmbeddingProfiles(absent, literal).compatible).toBe(false);
    expect(embeddingProfileKey(absent)).not.toBe(embeddingProfileKey(literal));
  });

  it("distinguishes absence from a provider literal equal to each optional field's sentinel", () => {
    // A minimal identity (only the required fields) so instructionVersion/embeddingSpaceFingerprint/
    // tokenizer/dimensionsParam are genuinely absent, not merely overridden to undefined.
    const minimal: EmbeddingModelIdentity = {
      provider: "openai-compatible",
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    };
    const absent = embeddingProfileFromModelIdentity(minimal);
    const literalSentinels = embeddingProfileFromModelIdentity({
      ...minimal,
      instructionVersion: "legacy",
      embeddingSpaceFingerprint: "unverified",
    });

    expect(embeddingProfileKey(absent)).not.toBe(embeddingProfileKey(literalSentinels));
  });

  it("distinguishes an absent tokenizer from a provider literally named 'unknown-tokenizer'", () => {
    const withoutTokenizer = hardenedProfile();
    const literalTokenizerName = embeddingProfileFromModelIdentity(HARDENED_IDENTITY, {
      tokenizer: "unknown-tokenizer",
    });

    expect(embeddingProfileKey(withoutTokenizer)).not.toBe(
      embeddingProfileKey(literalTokenizerName),
    );
  });

  // embeddingProfileKey joins components with "|" without framing each one, so a provider-
  // supplied field containing a literal "|" shifts the join's own field boundary: modelRevision
  // "r|fam" + modelFamily "x" and modelRevision "r" + modelFamily "fam|x" both produce the
  // substring "r|fam|x" once joined, even though they are two DIFFERENT, INCOMPATIBLE profiles.
  it("distinguishes profiles whose fields collide across the '|' join boundary", () => {
    const revisionCarriesPipe = embeddingProfileFromModelIdentity(
      { ...HARDENED_IDENTITY, modelRevision: "r|fam" },
      { modelFamily: "x" },
    );
    const familyCarriesPipe = embeddingProfileFromModelIdentity(
      { ...HARDENED_IDENTITY, modelRevision: "r" },
      { modelFamily: "fam|x" },
    );

    expect(revisionCarriesPipe.modelRevision).toBe("r|fam");
    expect(revisionCarriesPipe.modelFamily).toBe("x");
    expect(familyCarriesPipe.modelRevision).toBe("r");
    expect(familyCarriesPipe.modelFamily).toBe("fam|x");
    expect(embeddingProfileKey(revisionCarriesPipe)).not.toBe(
      embeddingProfileKey(familyCarriesPipe),
    );
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
