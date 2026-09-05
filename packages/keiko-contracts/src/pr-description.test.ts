import { describe, expect, it } from "vitest";
import {
  validatePrDescriptionCandidate,
  prDescriptionArtifactDigestFields,
  freezePrDescriptionArtifact,
  prDescriptionArtifactEvidence,
  prDescriptionBinding,
  type PrDescriptionArtifact,
} from "./pr-description.js";
import {
  GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
  GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS,
  summarizeGitChangeSnapshotCompleteness,
  type GitChangeSnapshot,
} from "./git-change-snapshot.js";
import { framePrDescriptionRegion, PR_DESCRIPTION_REGION_START } from "./pr-description-region.js";

const ID = "a".repeat(64);
const statement = { text: "Handle an empty collection.", evidenceIds: [ID] };
const candidate = { summary: [statement], keyChanges: [statement], risks: [], reviewerFocus: [] };

function artifact(): PrDescriptionArtifact {
  const snapshot: GitChangeSnapshot = {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: "fixture-repository",
    baseRef: "main",
    headRef: "private-feature",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBaseSha: "a".repeat(40),
    snapshotDigest: ID,
    capturedAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-09-04T00:01:00.000Z",
    outcome: "complete",
    limits: GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS,
    entries: [],
    completeness: summarizeGitChangeSnapshotCompleteness({ entries: [], totalFiles: 0, bytes: 0 }),
    localDivergence: { stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0 },
  };
  return {
    schemaVersion: "1",
    renderingVersion: "1",
    binding: prDescriptionBinding(snapshot),
    language: "en",
    outcome: "fallback",
    reason: "model-unavailable",
    artifactDigest: "b".repeat(64),
    markdown: "private narrative",
    candidate: { summary: [], keyChanges: [], risks: [], reviewerFocus: [] },
    coverage: {
      snapshot: snapshot.completeness,
      suppliedEvidenceCount: 0,
      processedEvidenceCount: 0,
      omittedEvidenceCount: 0,
    },
  };
}

describe("PR description candidate boundary", () => {
  it("accepts only known evidence and the closed narrative shape", () => {
    expect(validatePrDescriptionCandidate(candidate, [ID]).ok).toBe(true);
    expect(validatePrDescriptionCandidate(candidate, []).ok).toBe(false);
    expect(validatePrDescriptionCandidate({ ...candidate, body: "override" }, [ID]).ok).toBe(false);
  });

  it.each([
    "<!-- keiko:pr-description:v1:start -->",
    "Tests passed.",
    "by Keiko",
    "https://example.test",
    "safe\u202etext",
  ])("rejects model-owned framing, claims and unsafe text: %s", (text) => {
    expect(
      validatePrDescriptionCandidate({ ...candidate, summary: [{ ...statement, text }] }, [ID]).ok,
    ).toBe(false);
  });

  it.each([
    "pass",
    "passed",
    "passing",
    "succeeded",
    "verified",
    "proven",
    "guaranteed",
    "risk-free",
    "risk free",
    "secure",
    "safe",
    "successful",
    "bestanden",
    "verifiziert",
    "garantiert",
    "sicher",
    "erfolgreich",
  ])("withholds every unsupported English/German assurance: %s", (assurance) => {
    const text = `Result: ${assurance.toUpperCase()}.`;
    expect(
      validatePrDescriptionCandidate({ ...candidate, summary: [{ ...statement, text }] }, [ID]),
    ).toEqual({ ok: false, reason: "unsafe-model-output" });
  });

  it.each([
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ])("rejects both local and cross-repository closing directives: %s", (verb) => {
    for (const reference of ["#123", "owner.example/repo-name#123"]) {
      const text = `${verb.toUpperCase()} ${reference}`;
      expect(
        validatePrDescriptionCandidate({ ...candidate, summary: [{ ...statement, text }] }, [ID]),
      ).toEqual({ ok: false, reason: "unsafe-model-output" });
    }
  });

  it("rejects unbounded and untraceable statements", () => {
    expect(
      validatePrDescriptionCandidate(
        { ...candidate, summary: [{ ...statement, evidenceIds: [] }] },
        [ID],
      ).ok,
    ).toBe(false);
    expect(
      validatePrDescriptionCandidate(
        { ...candidate, summary: [{ ...statement, text: "x".repeat(601) }] },
        [ID],
      ).ok,
    ).toBe(false);
  });

  it("frames a trusted region without accepting nested markers", () => {
    expect(framePrDescriptionRegion("by Keiko")).toContain(PR_DESCRIPTION_REGION_START);
    expect(() => framePrDescriptionRegion(PR_DESCRIPTION_REGION_START)).toThrow(TypeError);
  });

  it.each([
    null,
    [],
    { ...candidate, summary: [] },
    { ...candidate, risks: Array.from({ length: 7 }, () => statement) },
    { ...candidate, summary: ["not a statement"] },
    { ...candidate, summary: [{ text: 42, evidenceIds: [ID] }] },
    { ...candidate, summary: [{ ...statement, evidenceIds: new Array<string>(1) }] },
  ])("rejects malformed, sparse and excessive candidates", (value) => {
    expect(validatePrDescriptionCandidate(value, [ID]).ok).toBe(false);
  });

  it("owns the artifact digest projection and freezes the body without exposing it in evidence", () => {
    const value = freezePrDescriptionArtifact(artifact());
    expect(Object.isFrozen(value.candidate.summary)).toBe(true);
    const fields = prDescriptionArtifactDigestFields(value);
    expect(fields.domain).toBe("keiko-pr-description-v1");
    expect(fields).not.toHaveProperty("artifactDigest");
    expect(fields.markdown).toBe(value.markdown);
    const evidence = prDescriptionArtifactEvidence(value);
    expect(evidence.artifactDigest).toBe(value.artifactDigest);
    expect(JSON.stringify(evidence)).not.toContain("private");
    expect(evidence).not.toHaveProperty("candidate");
  });
});
