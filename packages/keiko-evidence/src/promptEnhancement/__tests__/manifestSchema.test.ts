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

  it("exposes the current schema version literal", () => {
    expect(PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION).toBe(3);
  });
});
