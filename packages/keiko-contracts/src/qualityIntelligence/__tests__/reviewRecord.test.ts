import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_REVIEW_ACTIONS,
  QUALITY_INTELLIGENCE_REVIEW_STATES,
  QUALITY_INTELLIGENCE_REVIEWER_KINDS,
  QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES,
  isQualityIntelligenceReviewAction,
  isTerminalReviewState,
  reviewActionResultState,
  type QualityIntelligenceReviewAction,
  type QualityIntelligenceReviewState,
  type QualityIntelligenceReviewerKind,
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

describe("Quality Intelligence review state / reviewer kind pins (KEIKO-0698)", () => {
  // Matches the pin style used above for QUALITY_INTELLIGENCE_REVIEW_ACTIONS and below for
  // QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES. A member added, removed, or reordered without
  // updating this file fails the pin; every peer QI union already has the same protection.
  it("pins the five review states in declaration order", () => {
    expect(QUALITY_INTELLIGENCE_REVIEW_STATES).toEqual<readonly QualityIntelligenceReviewState[]>([
      "open",
      "approved",
      "changes-requested",
      "rejected",
      "withdrawn",
    ]);
  });

  it("pins the three reviewer kinds in declaration order", () => {
    expect(QUALITY_INTELLIGENCE_REVIEWER_KINDS).toEqual<readonly QualityIntelligenceReviewerKind[]>(
      ["human-author", "human-reviewer", "judge"],
    );
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
    const terminalStates: readonly QualityIntelligenceReviewState[] = [
      "approved",
      "rejected",
      "withdrawn",
    ];
    for (const state of terminalStates) {
      expect(isTerminalReviewState(state)).toBe(true);
    }
    const nonTerminalStates: readonly QualityIntelligenceReviewState[] = [
      "open",
      "changes-requested",
    ];
    for (const state of nonTerminalStates) {
      expect(isTerminalReviewState(state)).toBe(false);
    }
  });

  // KEIKO-0522: isTerminalReviewState's parameter used to be a bare `string`, so any string
  // (including a typo or a value from an un-migrated caller) compiled without a diagnostic.
  // Narrowing the parameter to QualityIntelligenceReviewState turns that class of mistake into a
  // compile error. Proven with a `@ts-expect-error` compile-time pin: this test fails to compile
  // (and the directive itself is flagged "unused") if the narrowing regresses.
  it("rejects a non-QualityIntelligenceReviewState argument at compile time", () => {
    // @ts-expect-error — "not-a-state" is not a QualityIntelligenceReviewState member; this
    // compiled fine before the string-to-union narrowing. Once bypassed like this, the witness
    // lookup falls through to plain-object `undefined` (falsy) rather than a typed `false` — the
    // guarantee of an exact `boolean` return is for well-typed callers, which is what the
    // narrowing itself now enforces at every real call site.
    expect(isTerminalReviewState("not-a-state")).toBeFalsy();
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
