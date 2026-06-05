// Lifecycle predicate tests for the QI review governance layer (Issue #282).

import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { canPairForFourEyes, isTerminalReviewState } from "../lifecyclePolicy.js";

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-lifecycle-0001");
const RECORD_ID = QualityIntelligence.asQualityIntelligenceReviewRecordId(
  "qi-review-lifecycle-0001",
);
const OTHER_ID = QualityIntelligence.asQualityIntelligenceReviewRecordId(
  "qi-review-lifecycle-0002",
);

const baseRecord = (
  overrides: Partial<QualityIntelligence.QualityIntelligenceReviewRecord> = {},
): QualityIntelligence.QualityIntelligenceReviewRecord => ({
  id: RECORD_ID,
  runId: RUN_ID,
  reviewerKind: "human-reviewer",
  reviewerLabel: "alice",
  state: "open",
  createdAt: "2026-06-05T12:00:00.000Z",
  lastUpdatedAt: "2026-06-05T12:00:00.000Z",
  ...overrides,
});

describe("isTerminalReviewState", () => {
  it("returns true for approved, rejected, withdrawn", () => {
    expect(isTerminalReviewState("approved")).toBe(true);
    expect(isTerminalReviewState("rejected")).toBe(true);
    expect(isTerminalReviewState("withdrawn")).toBe(true);
  });

  it("returns false for open and changes-requested", () => {
    expect(isTerminalReviewState("open")).toBe(false);
    expect(isTerminalReviewState("changes-requested")).toBe(false);
  });
});

describe("canPairForFourEyes", () => {
  it("returns true for an open record with no pairing", () => {
    expect(canPairForFourEyes(baseRecord({ state: "open" }))).toBe(true);
  });

  it("returns true for a changes-requested record with no pairing", () => {
    expect(canPairForFourEyes(baseRecord({ state: "changes-requested" }))).toBe(true);
  });

  it("returns false for every terminal state", () => {
    expect(canPairForFourEyes(baseRecord({ state: "approved" }))).toBe(false);
    expect(canPairForFourEyes(baseRecord({ state: "rejected" }))).toBe(false);
    expect(canPairForFourEyes(baseRecord({ state: "withdrawn" }))).toBe(false);
  });

  it("returns false when fourEyesPairedRecordId is already set", () => {
    expect(
      canPairForFourEyes(baseRecord({ state: "open", fourEyesPairedRecordId: OTHER_ID })),
    ).toBe(false);
  });
});
