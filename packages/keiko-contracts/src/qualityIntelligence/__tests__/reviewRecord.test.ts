import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_REVIEW_ACTIONS,
  QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES,
  isQualityIntelligenceReviewAction,
  isTerminalReviewState,
  reviewActionResultState,
  type QualityIntelligenceReviewAction,
} from "../reviewRecord.js";

describe("Quality Intelligence review action contract", () => {
  it("pins withdraw as a first-class shared review action", () => {
    expect(QUALITY_INTELLIGENCE_REVIEW_ACTIONS).toEqual<readonly QualityIntelligenceReviewAction[]>(
      ["approve", "reject", "request-changes", "reopen", "withdraw"],
    );
    expect(isQualityIntelligenceReviewAction("withdraw")).toBe(true);
    expect(isQualityIntelligenceReviewAction("archive")).toBe(false);
  });
});

describe("Quality Intelligence terminal review states (GEN-DUP-SEMANTIC-008)", () => {
  it("pins the terminal state set", () => {
    expect(QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES).toEqual([
      "approved",
      "rejected",
      "withdrawn",
    ]);
  });

  it("classifies terminal states as terminal and non-terminal states as not", () => {
    for (const state of ["approved", "rejected", "withdrawn"]) {
      expect(isTerminalReviewState(state)).toBe(true);
    }
    for (const state of ["open", "changes-requested"]) {
      expect(isTerminalReviewState(state)).toBe(false);
    }
  });
});

describe("Quality Intelligence review action projection (GEN-DUP-SEMANTIC-009)", () => {
  it("maps each of the five actions to its resulting state", () => {
    expect(reviewActionResultState("approve")).toBe("approved");
    expect(reviewActionResultState("reject")).toBe("rejected");
    expect(reviewActionResultState("request-changes")).toBe("changes-requested");
    expect(reviewActionResultState("reopen")).toBe("open");
    expect(reviewActionResultState("withdraw")).toBe("withdrawn");
  });
});
