// Tests for the Prompt Enhancement strict-schema gate (Issue #1313).

import { describe, expect, it } from "vitest";
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
      peEvidenceSchemaVersion: 2,
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

  it("exposes the current schema version literal", () => {
    expect(PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION).toBe(1);
  });
});
