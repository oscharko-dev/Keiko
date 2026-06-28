// Mutation-robust unit tests for the Voice Action Governance scorer + renderer (Issue #503). These drive
// the FAIL and not-applicable branches the GO suite never hits, so a regression that weakens a structural
// gate is caught: each test mutates one observation field away from the secure shape and asserts the
// corresponding dimension flips to FAIL.

import { describe, expect, it } from "vitest";
import type {
  SpokenActionAuditRecord,
  SpokenActionEffectClass,
  SpokenActionState,
} from "@oscharko-dev/keiko-contracts";
import { renderVoiceActionSummary } from "./render.js";
import { aggregateVoiceActionQuality, scoreVoiceActionQuality } from "./scorer.js";
import {
  VOICE_ACTION_EVAL_SCHEMA_VERSION,
  type VoiceActionDimension,
  type VoiceActionEvalFixture,
  type VoiceActionObservation,
  type VoiceActionProposalSummary,
  type VoiceActionScorecard,
} from "./types.js";

function audit(overrides: Partial<SpokenActionAuditRecord> = {}): SpokenActionAuditRecord {
  return {
    schemaVersion: "1",
    effectClass: "mutating",
    state: "awaiting-confirmation",
    confirmationRequired: true,
    confirmed: false,
    outcome: "routed",
    source: "dictation",
    turnIndex: 0,
    committedSegmentCount: 1,
    committedChars: 10,
    bindingDigest: "",
    ...overrides,
  };
}

function proposal(overrides: Partial<VoiceActionProposalSummary> = {}): VoiceActionProposalSummary {
  return {
    effectClass: "mutating",
    requiresConfirmation: true,
    state: "awaiting-confirmation",
    turnIndex: 0,
    committedSegmentCount: 1,
    committedChars: 10,
    ...overrides,
  };
}

function observation(overrides: Partial<VoiceActionObservation> = {}): VoiceActionObservation {
  return {
    gatingAllowed: true,
    committedSegmentCount: 1,
    committedChars: 10,
    proposal: proposal(),
    audit: audit(),
    ...overrides,
  };
}

function fixture(
  dimensions: readonly VoiceActionDimension[],
  oracle: VoiceActionEvalFixture["oracle"],
): VoiceActionEvalFixture {
  return {
    name: "unit",
    category: "voice",
    description: "unit",
    profile: "speech-to-text",
    source: "dictation",
    turnIndex: 0,
    segments: [],
    dimensions: new Set(dimensions),
    oracle,
  };
}

function outcomeFor(
  dimension: VoiceActionDimension,
  fx: VoiceActionEvalFixture,
  obs: VoiceActionObservation,
): string {
  const results = scoreVoiceActionQuality(fx, obs);
  const found = results.find((r) => r.dimension === dimension);
  if (found === undefined) {
    throw new Error(`no result for ${dimension}`);
  }
  return found.outcome;
}

describe("capability-gating scorer", () => {
  const oracle = { expectedGatingAllowed: true, expectsProposal: true };
  it("passes when the gating verdict matches", () => {
    expect(
      outcomeFor("capability-gating", fixture(["capability-gating"], oracle), observation()),
    ).toBe("pass");
  });
  it("fails when the gating verdict diverges from the oracle", () => {
    const obs = observation({ gatingAllowed: false });
    expect(outcomeFor("capability-gating", fixture(["capability-gating"], oracle), obs)).toBe(
      "fail",
    );
  });
  it("fails when a denied profile still produced a proposal (dormancy breach)", () => {
    const deniedOracle = { expectedGatingAllowed: false, expectsProposal: false };
    const obs = observation({ gatingAllowed: false, proposal: proposal() });
    expect(outcomeFor("capability-gating", fixture(["capability-gating"], deniedOracle), obs)).toBe(
      "fail",
    );
  });
});

describe("committed-only scorer", () => {
  it("fails when a proposal forms without committed chars", () => {
    const oracle = { expectedGatingAllowed: true, expectsProposal: true };
    const obs = observation({ committedChars: 0, committedSegmentCount: 0 });
    expect(outcomeFor("committed-only", fixture(["committed-only"], oracle), obs)).toBe("fail");
  });
  it("fails when a capable profile yields no proposal but committed text remains", () => {
    const oracle = { expectedGatingAllowed: true, expectsProposal: false };
    const obs = observation({ proposal: undefined, committedChars: 5, committedSegmentCount: 1 });
    expect(outcomeFor("committed-only", fixture(["committed-only"], oracle), obs)).toBe("fail");
  });
  it("passes the dormant case: denied profile, committed text, no proposal", () => {
    const oracle = { expectedGatingAllowed: false, expectsProposal: false };
    const obs = observation({
      gatingAllowed: false,
      proposal: undefined,
      committedChars: 5,
      committedSegmentCount: 1,
    });
    expect(outcomeFor("committed-only", fixture(["committed-only"], oracle), obs)).toBe("pass");
  });
});

describe("confirmation-discipline scorer", () => {
  const oracle = {
    expectedGatingAllowed: true,
    expectsProposal: true,
    expectedEffectClass: "mutating" as SpokenActionEffectClass,
    expectedRequiresConfirmation: true,
  };
  it("fails when a confirmation-requiring proposal is not awaiting confirmation", () => {
    const obs = observation({ proposal: proposal({ state: "proposed" as SpokenActionState }) });
    expect(
      outcomeFor("confirmation-discipline", fixture(["confirmation-discipline"], oracle), obs),
    ).toBe("fail");
  });
  it("fails when requiresConfirmation contradicts the taxonomy", () => {
    const obs = observation({ proposal: proposal({ requiresConfirmation: false }) });
    expect(
      outcomeFor("confirmation-discipline", fixture(["confirmation-discipline"], oracle), obs),
    ).toBe("fail");
  });
  it("fails when the dimension is declared but no proposal was derived", () => {
    const obs = observation({ proposal: undefined });
    expect(
      outcomeFor("confirmation-discipline", fixture(["confirmation-discipline"], oracle), obs),
    ).toBe("fail");
  });
  it("falls back to the taxonomy when the oracle omits expectedRequiresConfirmation", () => {
    const looseOracle = {
      expectedGatingAllowed: true,
      expectsProposal: true,
      expectedEffectClass: "mutating" as SpokenActionEffectClass,
    };
    expect(
      outcomeFor(
        "confirmation-discipline",
        fixture(["confirmation-discipline"], looseOracle),
        observation(),
      ),
    ).toBe("pass");
  });

  it("passes a read-only proposal that needs no confirmation", () => {
    const roOracle = {
      expectedGatingAllowed: true,
      expectsProposal: true,
      expectedEffectClass: "read-only" as SpokenActionEffectClass,
      expectedRequiresConfirmation: false,
    };
    const obs = observation({
      proposal: proposal({
        effectClass: "read-only",
        requiresConfirmation: false,
        state: "proposed",
      }),
    });
    expect(
      outcomeFor("confirmation-discipline", fixture(["confirmation-discipline"], roOracle), obs),
    ).toBe("pass");
  });
});

describe("stale-intent-prevention scorer", () => {
  const oracle = { expectedGatingAllowed: true, expectsProposal: true };
  it("fails when no staleness trajectory was derived", () => {
    expect(
      outcomeFor(
        "stale-intent-prevention",
        fixture(["stale-intent-prevention"], oracle),
        observation(),
      ),
    ).toBe("fail");
  });
  it("fails when the seed did not change", () => {
    const obs = observation({
      staleness: { seedChanged: false, bothSeedsPresent: true, trigger: "correction" },
    });
    expect(
      outcomeFor("stale-intent-prevention", fixture(["stale-intent-prevention"], oracle), obs),
    ).toBe("fail");
  });
  it("passes when the seed changed and both sides produced a seed", () => {
    const obs = observation({
      staleness: { seedChanged: true, bothSeedsPresent: true, trigger: "turn-advance" },
    });
    expect(
      outcomeFor("stale-intent-prevention", fixture(["stale-intent-prevention"], oracle), obs),
    ).toBe("pass");
  });
});

describe("injection-resistance scorer", () => {
  const oracle = { expectedGatingAllowed: true, expectsProposal: true, forbidsReadOnly: true };
  it("fails when injected text read-only-classifies", () => {
    const obs = observation({
      proposal: proposal({
        effectClass: "read-only",
        requiresConfirmation: false,
        state: "proposed",
      }),
    });
    expect(outcomeFor("injection-resistance", fixture(["injection-resistance"], oracle), obs)).toBe(
      "fail",
    );
  });
  it("fails when the dimension is declared but no proposal was derived", () => {
    const obs = observation({ proposal: undefined });
    expect(outcomeFor("injection-resistance", fixture(["injection-resistance"], oracle), obs)).toBe(
      "fail",
    );
  });
});

describe("evidence-safety scorer", () => {
  const oracle = { expectedGatingAllowed: true, expectsProposal: true };
  it("fails when the audit committedChars disagrees with the observation count", () => {
    const obs = observation({ audit: audit({ committedChars: 999 }) });
    expect(outcomeFor("evidence-safety", fixture(["evidence-safety"], oracle), obs)).toBe("fail");
  });
  it("fails when the binding digest is neither empty nor a sha256 hex", () => {
    const obs = observation({ audit: audit({ bindingDigest: "not-a-digest" }) });
    expect(outcomeFor("evidence-safety", fixture(["evidence-safety"], oracle), obs)).toBe("fail");
  });
  it("passes a 64-char sha256 hex binding digest", () => {
    const obs = observation({ audit: audit({ bindingDigest: "a".repeat(64) }) });
    expect(outcomeFor("evidence-safety", fixture(["evidence-safety"], oracle), obs)).toBe("pass");
  });
});

describe("not-applicable dimensions", () => {
  it("marks an undeclared dimension not-applicable", () => {
    const oracle = { expectedGatingAllowed: true, expectsProposal: true };
    const results = scoreVoiceActionQuality(fixture(["capability-gating"], oracle), observation());
    const ev = results.find((r) => r.dimension === "evidence-safety");
    expect(ev?.outcome).toBe("not-applicable");
  });
});

describe("aggregateVoiceActionQuality", () => {
  it("computes pass/fail/n-a counts and a pass rate, null when never scored", () => {
    const passing = scoreVoiceActionQuality(
      fixture(["capability-gating"], { expectedGatingAllowed: true, expectsProposal: true }),
      observation(),
    );
    const failing = scoreVoiceActionQuality(
      fixture(["capability-gating"], { expectedGatingAllowed: false, expectsProposal: true }),
      observation(),
    );
    const entries = aggregateVoiceActionQuality([passing, failing]);
    const gating = entries.find((e) => e.dimension === "capability-gating");
    expect(gating?.passCount).toBe(1);
    expect(gating?.failCount).toBe(1);
    expect(gating?.passRate).toBe(0.5);
    const unused = entries.find((e) => e.dimension === "injection-resistance");
    expect(unused?.passRate).toBeNull();
    expect(unused?.notApplicableCount).toBe(2);
  });
});

describe("renderVoiceActionSummary", () => {
  function scorecard(goNoGo: "GO" | "NO-GO", fullyPassed: boolean): VoiceActionScorecard {
    const dimResults = scoreVoiceActionQuality(
      fixture(["capability-gating", "stale-intent-prevention"], {
        expectedGatingAllowed: fullyPassed,
        expectsProposal: true,
      }),
      observation(),
    );
    return {
      schemaVersion: VOICE_ACTION_EVAL_SCHEMA_VERSION,
      fixtureResults: [
        {
          fixtureName: "fx",
          category: "voice",
          observation: observation(),
          dimensionResults: dimResults,
          fullyPassed,
        },
      ],
      dimensions: aggregateVoiceActionQuality([dimResults]),
      summary: {
        totalFixtures: 1,
        fullyPassedFixtures: fullyPassed ? 1 : 0,
        coversNoVoiceProfile: true,
        coversVoiceProfile: true,
        goNoGo,
      },
      coveredEffectClasses: ["mutating"],
    };
  }

  it("renders the FAIL fixture verdict, the FAIL/n-a glyphs, and a NO-GO verdict", () => {
    const text = renderVoiceActionSummary(scorecard("NO-GO", false));
    expect(text).toContain("Verdict: NO-GO");
    expect(text).toContain("[voice] FAIL");
    expect(text).toContain("=FAIL");
    expect(text).toContain("n/a");
  });

  it("renders a GO verdict when every dimension passes", () => {
    const text = renderVoiceActionSummary(scorecard("GO", true));
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("=PASS");
  });
});
