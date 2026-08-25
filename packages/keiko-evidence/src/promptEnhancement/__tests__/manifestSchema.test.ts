// Tests for the Prompt Enhancement strict-schema gate (Issue #1313).

import { describe, expect, it } from "vitest";
import { PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT } from "@oscharko-dev/keiko-contracts";
import {
  PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION,
  validatePromptEnhancementEvidenceManifest,
} from "../manifestSchema.js";
import { buildPromptEnhancementEvidenceManifest } from "../store.js";

function validManifest(): Record<string, unknown> {
  const { manifest } = buildPromptEnhancementEvidenceManifest({
    runId: "pe-run-schema",
    recordedAt: "2026-06-20T00:00:00.000Z",
    requestId: "req-1",
    status: "validated",
    originalInput: "hello",
    enhancedPromptId: "ep-1",
    enhancedPromptText: "## Role\nbe careful",
    appliedSafetyRules: ["grants no authority"],
    appliedGroundingDirectives: ["disclose-uncertainty"],
    assumptions: [],
    candidateScores: [],
    candidateRejections: [],
    safety: {
      decision: "accepted",
      verificationStatus: "passed",
      requiresHumanReview: false,
      findingCodes: [],
      leastPrivilege: ["no-tool-execution"],
    },
    modelMetadata: { deterministic: true },
  });
  return manifest as unknown as Record<string, unknown>;
}

describe("validatePromptEnhancementEvidenceManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validatePromptEnhancementEvidenceManifest(validManifest()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validatePromptEnhancementEvidenceManifest(null).ok).toBe(false);
    expect(validatePromptEnhancementEvidenceManifest(42).reason).toBe("manifest is not an object");
  });

  it("rejects an unexpected schema version", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      peEvidenceSchemaVersion: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("peEvidenceSchemaVersion");
  });

  it("rejects an unknown top-level key", () => {
    const result = validatePromptEnhancementEvidenceManifest({ ...validManifest(), extra: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unknown manifest key");
  });

  it("rejects an invalid status", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      status: "in-progress",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid status");
  });

  it("rejects inconsistent status and safety records", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      status: "requires-human-review",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("review");
  });

  it("rejects malformed integrity hashes", () => {
    const manifest = validManifest();
    const result = validatePromptEnhancementEvidenceManifest({
      ...manifest,
      integrityHashes: { ...(manifest.integrityHashes as object), record: "not-a-hash" },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("integrityHashes.record");
  });

  it("accepts bounded, content-free candidate rejection records", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      candidateRejections: [
        {
          candidateId: "candidate-fast",
          profile: "fast",
          aggregateScore: 0.61,
          reason: "lower-aggregate-score",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects prompt content and unknown fields in candidate rejection records", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      candidateRejections: [
        {
          candidateId: "candidate-fast",
          profile: "fast",
          aggregateScore: 0.61,
          reason: "lower-aggregate-score",
          promptText: "private prompt body",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("candidateRejections[0]");
    expect(result.reason).toContain("unknown");
  });

  it("rejects candidate rejection collections beyond the governed candidate bound", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      candidateRejections: Array.from(
        { length: PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT + 1 },
        (_, index) => ({
          candidateId: `candidate-${String(index)}`,
          profile: "fast",
          aggregateScore: null,
          reason: "exceeded-token-budget",
        }),
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("at most");
  });

  // KEIKO-0306: validateCandidateRejections enforces `new Set(ids).size === ids.length` — a
  // manifest carrying two rejection rows for the same candidateId must fail. The other branches
  // (unknown-key, length bound) had coverage; this one did not. Regression pin against a future
  // edit that returns `undefined` from the uniqueness check.
  it("rejects candidate rejection collections with duplicate candidateIds (KEIKO-0306)", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      candidateRejections: [
        {
          candidateId: "candidate-dup",
          profile: "fast",
          aggregateScore: 0.42,
          reason: "lower-aggregate-score",
        },
        {
          // Same candidateId with different profile + reason so unknown-key / length branches
          // cannot fire first — the uniqueness check is the only reason for the failure.
          candidateId: "candidate-dup",
          profile: "precise",
          aggregateScore: null,
          reason: "exceeded-token-budget",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unique");
  });

  it("exposes the current schema version literal", () => {
    expect(PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION).toBe(3);
  });

  // KEIKO-0238: candidateRejections carries an unknown-key check and a length cap against
  // PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT. candidateScores had neither — so a manifest could
  // carry a `secret: "…"` field on every score row or an unbounded collection. Mirror the sibling
  // discipline: reject unknown keys per-row and reject collections larger than the governed bound.
  it("rejects prompt content and unknown fields in candidate score rows (KEIKO-0238)", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      candidateScores: [
        {
          candidateId: "candidate-fast",
          profile: "fast",
          aggregateScore: 0.82,
          estimatedTokens: 140,
          selected: true,
          promptText: "private prompt body",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("candidateScores[0]");
    expect(result.reason).toContain("unknown");
  });

  it("rejects candidate score collections beyond the governed candidate bound (KEIKO-0238)", () => {
    const result = validatePromptEnhancementEvidenceManifest({
      ...validManifest(),
      candidateScores: Array.from(
        { length: PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT + 1 },
        (_, index) => ({
          candidateId: `candidate-${String(index)}`,
          profile: "fast",
          aggregateScore: 0.5,
          estimatedTokens: 10,
          selected: false,
        }),
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("at most");
  });

  // KEIKO-0656: validateCandidateScoreRow enforces five independent field-level invariants, but
  // none had a negative-path test -- a future refactor that dropped one of these checks (e.g. the
  // [0, 1] aggregateScore range) would go unnoticed by this suite. One case per invariant.
  const validScoreRow = (): Record<string, unknown> => ({
    candidateId: "candidate-fast",
    profile: "fast",
    aggregateScore: 0.9,
    estimatedTokens: 120,
    selected: true,
  });

  it.each([
    ["candidateId", { candidateId: "" }],
    ["profile", { profile: "" }],
    ["aggregateScore", { aggregateScore: 1.5 }],
    ["estimatedTokens", { estimatedTokens: 0.5 }],
    ["selected", { selected: "yes" }],
  ] as const)(
    "rejects a candidateScores row with an invalid %s (KEIKO-0656)",
    (field, override) => {
      const result = validatePromptEnhancementEvidenceManifest({
        ...validManifest(),
        candidateScores: [{ ...validScoreRow(), ...override }],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(field);
    },
  );
});
