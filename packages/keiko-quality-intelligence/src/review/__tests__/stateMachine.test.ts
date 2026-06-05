// State-machine tests for the QI review governance layer (Issue #282).
// Exhausts every legal transition + a representative sample of illegal ones.

import { describe, expect, it } from "vitest";

import {
  applyReviewTransition,
  QualityIntelligenceReviewTransitionError,
  type QualityIntelligenceReviewTransitionEvent,
} from "../stateMachine.js";

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

const BY = "actor:test-runner";
const AT = "2026-06-05T12:00:00.000Z";

interface LegalCase {
  readonly from: QualityIntelligence.QualityIntelligenceReviewState;
  readonly event: QualityIntelligenceReviewTransitionEvent;
  readonly to: QualityIntelligence.QualityIntelligenceReviewState;
}

const LEGAL_CASES: readonly LegalCase[] = [
  { from: "open", event: "approve", to: "approved" },
  { from: "open", event: "request-changes", to: "changes-requested" },
  { from: "open", event: "reject", to: "rejected" },
  { from: "open", event: "withdraw", to: "withdrawn" },
  { from: "changes-requested", event: "revise", to: "open" },
  { from: "changes-requested", event: "withdraw", to: "withdrawn" },
] as const;

const ALL_STATES: readonly QualityIntelligence.QualityIntelligenceReviewState[] = [
  "open",
  "approved",
  "changes-requested",
  "rejected",
  "withdrawn",
] as const;

const ALL_EVENTS: readonly QualityIntelligenceReviewTransitionEvent[] = [
  "approve",
  "request-changes",
  "reject",
  "withdraw",
  "revise",
] as const;

describe("applyReviewTransition", () => {
  for (const legal of LEGAL_CASES) {
    it(`permits ${legal.from} --${legal.event}--> ${legal.to}`, () => {
      const next = applyReviewTransition(legal.from, legal.event, BY, AT);
      expect(next.state).toBe(legal.to);
      expect(next.event).toBe(legal.event);
      expect(next.from).toBe(legal.from);
      expect(next.by).toBe(BY);
      expect(next.at).toBe(AT);
    });
  }

  it("returns a frozen NextReviewState envelope", () => {
    const next = applyReviewTransition("open", "approve", BY, AT);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("throws on every illegal (from, event) pair", () => {
    const legalKeys = new Set(LEGAL_CASES.map((c) => `${c.from}|${c.event}`));
    let illegalChecked = 0;
    for (const from of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (legalKeys.has(`${from}|${event}`)) {
          continue;
        }
        expect(() => applyReviewTransition(from, event, BY, AT)).toThrow(
          QualityIntelligenceReviewTransitionError,
        );
        illegalChecked += 1;
      }
    }
    // Sanity: there are 5 states * 5 events = 25 pairs; 6 are legal → 19 illegal.
    expect(illegalChecked).toBe(19);
  });

  it("tags illegal-transition errors with code TRANSITION_NOT_ALLOWED", () => {
    try {
      applyReviewTransition("approved", "approve", BY, AT);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QualityIntelligenceReviewTransitionError);
      const typed = error as QualityIntelligenceReviewTransitionError;
      expect(typed.code).toBe("TRANSITION_NOT_ALLOWED");
      expect(typed.from).toBe("approved");
      expect(typed.event).toBe("approve");
    }
  });

  it("rejects an unknown from-state with code UNKNOWN_FROM_STATE", () => {
    try {
      applyReviewTransition(
        "totally-bogus" as QualityIntelligence.QualityIntelligenceReviewState,
        "approve",
        BY,
        AT,
      );
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QualityIntelligenceReviewTransitionError);
      expect((error as QualityIntelligenceReviewTransitionError).code).toBe("UNKNOWN_FROM_STATE");
    }
  });

  it("rejects an unknown event with code UNKNOWN_EVENT", () => {
    try {
      applyReviewTransition("open", "explode" as QualityIntelligenceReviewTransitionEvent, BY, AT);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QualityIntelligenceReviewTransitionError);
      expect((error as QualityIntelligenceReviewTransitionError).code).toBe("UNKNOWN_EVENT");
    }
  });
});
