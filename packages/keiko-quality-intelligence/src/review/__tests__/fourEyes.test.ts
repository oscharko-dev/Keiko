// Four-eyes pairing guard tests (Issue #282).

import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { assertFourEyesPair, QualityIntelligenceFourEyesViolationError } from "../fourEyes.js";

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-four-eyes-0001");
const ID_A = QualityIntelligence.asQualityIntelligenceReviewRecordId("qi-review-four-eyes-A");
const ID_B = QualityIntelligence.asQualityIntelligenceReviewRecordId("qi-review-four-eyes-B");
const ID_C = QualityIntelligence.asQualityIntelligenceReviewRecordId("qi-review-four-eyes-C");

const baseRecord = (
  overrides: Partial<QualityIntelligence.QualityIntelligenceReviewRecord> = {},
): QualityIntelligence.QualityIntelligenceReviewRecord => ({
  id: ID_A,
  runId: RUN_ID,
  reviewerKind: "human-reviewer",
  reviewerLabel: "alice",
  state: "open",
  createdAt: "2026-06-05T12:00:00.000Z",
  lastUpdatedAt: "2026-06-05T12:00:00.000Z",
  ...overrides,
});

describe("assertFourEyesPair", () => {
  it("accepts distinct-reviewer pairing (human-author × human-reviewer)", () => {
    const record = baseRecord({ id: ID_A, reviewerKind: "human-author", reviewerLabel: "alice" });
    const candidate = baseRecord({
      id: ID_B,
      reviewerKind: "human-reviewer",
      reviewerLabel: "bob",
    });
    expect(() => { assertFourEyesPair(record, candidate); }).not.toThrow();
  });

  it("accepts distinct-reviewer pairing (human-reviewer × judge)", () => {
    const record = baseRecord({ id: ID_A, reviewerKind: "human-reviewer", reviewerLabel: "alice" });
    const candidate = baseRecord({ id: ID_B, reviewerKind: "judge", reviewerLabel: "judge-1" });
    expect(() => { assertFourEyesPair(record, candidate); }).not.toThrow();
  });

  it("rejects two human-author reviewers with SELF_REVIEW_FORBIDDEN", () => {
    const record = baseRecord({ id: ID_A, reviewerKind: "human-author", reviewerLabel: "alice" });
    const candidate = baseRecord({
      id: ID_B,
      reviewerKind: "human-author",
      reviewerLabel: "bob",
    });
    try {
      assertFourEyesPair(record, candidate);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QualityIntelligenceFourEyesViolationError);
      expect((error as QualityIntelligenceFourEyesViolationError).code).toBe(
        "SELF_REVIEW_FORBIDDEN",
      );
    }
  });

  it("rejects same reviewerLabel (case-insensitive) with SAME_REVIEWER_LABEL", () => {
    const record = baseRecord({
      id: ID_A,
      reviewerKind: "human-author",
      reviewerLabel: "Alice",
    });
    const candidate = baseRecord({
      id: ID_B,
      reviewerKind: "human-reviewer",
      reviewerLabel: " alice ",
    });
    try {
      assertFourEyesPair(record, candidate);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QualityIntelligenceFourEyesViolationError);
      expect((error as QualityIntelligenceFourEyesViolationError).code).toBe("SAME_REVIEWER_LABEL");
    }
  });

  it("rejects when one record is already paired with ALREADY_PAIRED", () => {
    const record = baseRecord({
      id: ID_A,
      reviewerKind: "human-author",
      reviewerLabel: "alice",
      fourEyesPairedRecordId: ID_C,
    });
    const candidate = baseRecord({
      id: ID_B,
      reviewerKind: "human-reviewer",
      reviewerLabel: "bob",
    });
    try {
      assertFourEyesPair(record, candidate);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QualityIntelligenceFourEyesViolationError);
      expect((error as QualityIntelligenceFourEyesViolationError).code).toBe("ALREADY_PAIRED");
    }
  });
});
