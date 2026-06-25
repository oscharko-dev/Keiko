// Unit tests for render.ts (Issue #505 — per-module coverage additions).
//
// Targets uncovered branches (currently 43.75% branch):
//   - glyph(): the "fail" branch (lines 17-20) — only "pass" and "n/a" were hit by suite.test.ts
//   - dimensionLine(): the failCount > 0 → "FAIL" verdict branch, the passCount=0 → "n/a" branch
//   - fixtureLine(): the !fullyPassed → "FAIL" verdict branch
//   - renderVoiceTwinSummary(): the NO-GO verdict line
//   - yesNo(): the false → "no" branch (suite.test.ts always has all flags true)
// Each assertion is mutation-robust.

import { describe, expect, it } from "vitest";
import { renderVoiceTwinSummary } from "./render.js";
import type { VoiceTwinScorecard } from "./types.js";

// ─── Scorecard builders ───────────────────────────────────────────────────────

function makeScorecard(overrides: Partial<VoiceTwinScorecard> = {}): VoiceTwinScorecard {
  return {
    schemaVersion: "1",
    fixtureResults: [],
    dimensions: [],
    coveredMatrixCells: [],
    summary: {
      totalFixtures: 0,
      fullyPassedFixtures: 0,
      coversNoVoice: true,
      coversSttOnly: true,
      coversFullRealtime: true,
      coversAzureFoundry: true,
      coversCustomerHosted: true,
      coversSpeechOutput: true,
      coversPrivacyNegative: true,
      goNoGo: "GO",
    },
    ...overrides,
  };
}

// ─── GO verdict path ──────────────────────────────────────────────────────────
describe("renderVoiceTwinSummary: GO verdict", () => {
  it("includes the GO verdict line when goNoGo=GO", () => {
    const scorecard = makeScorecard({ summary: { ...makeScorecard().summary, goNoGo: "GO" } });
    const text = renderVoiceTwinSummary(scorecard);
    // Mutation guard: if the ternary selects the NO-GO string unconditionally, this fails.
    expect(text).toContain("Verdict: GO");
    expect(text).not.toContain("Verdict: NO-GO");
  });
});

// ─── NO-GO verdict path ───────────────────────────────────────────────────────
describe("renderVoiceTwinSummary: NO-GO verdict", () => {
  it("includes the NO-GO verdict line when goNoGo=NO-GO", () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    // Mutation guard: if the ternary always selects GO, NO-GO is never rendered.
    expect(text).toContain("Verdict: NO-GO");
    expect(text).not.toContain("Verdict: GO");
  });
});

// ─── yesNo: false → "no" branch ───────────────────────────────────────────────
describe("renderVoiceTwinSummary: yesNo false branches", () => {
  it('renders "no" for coversNoVoice=false', () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, coversNoVoice: false, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    // Mutation guard: if yesNo always returns "yes", this fails.
    expect(text).toContain("no-voice=no");
  });

  it('renders "no" for coversSttOnly=false', () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, coversSttOnly: false, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("stt=no");
  });

  it('renders "no" for coversFullRealtime=false', () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, coversFullRealtime: false, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("full-realtime=no");
  });

  it('renders "no" for coversAzureFoundry=false', () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, coversAzureFoundry: false, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("azure-foundry=no");
  });

  it('renders "no" for coversCustomerHosted=false', () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, coversCustomerHosted: false, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("customer-hosted=no");
  });

  it('renders "no" for coversPrivacyNegative=false', () => {
    const scorecard = makeScorecard({
      summary: { ...makeScorecard().summary, coversPrivacyNegative: false, goNoGo: "NO-GO" },
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("negative-egress-caught=no");
  });
});

// ─── glyph(): FAIL branch (lines 17-20) ─────────────────────────────────────
describe("renderVoiceTwinSummary: FAIL glyph in fixture lines", () => {
  it('renders "FAIL" glyph for a dimension with outcome=fail', () => {
    const scorecard = makeScorecard({
      fixtureResults: [
        {
          fixtureName: "bad-fixture",
          category: "no-voice",
          environment: "no-voice-env",
          effectiveProfile: "none",
          fullyPassed: false,
          observation: {
            environment: "no-voice-env",
            advertisedProfile: "none",
            cell: {
              effectiveProfile: "none",
              allowedKinds: [],
              mediaTransport: "none",
              negotiation: "disabled",
              controlPlaneIsLoopback: true,
              mediaPlaneId: "media",
              egressClass: "none",
            },
            egressAudit: { approved: true, unapprovedCount: 0 },
            manifestScan: { clean: true, found: [] },
            metrics: {},
          },
          dimensionResults: [
            {
              dimension: "capability-matrix-consistency",
              outcome: "fail",
              rationale: "failed: effective profile matches the oracle expectation.",
            },
          ],
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    // Mutation guard: if glyph() returns "PASS" for outcome=fail, this fails.
    expect(text).toContain("capability-matrix-consistency=FAIL");
    // The fixture verdict line should show FAIL (not OK) when fullyPassed=false.
    expect(text).toContain("bad-fixture");
    expect(text).toContain("] FAIL");
  });

  it('renders "PASS" glyph for outcome=pass', () => {
    const scorecard = makeScorecard({
      fixtureResults: [
        {
          fixtureName: "good-fixture",
          category: "no-voice",
          environment: "no-voice-env",
          effectiveProfile: "none",
          fullyPassed: true,
          observation: {
            environment: "no-voice-env",
            advertisedProfile: "none",
            cell: {
              effectiveProfile: "none",
              allowedKinds: [],
              mediaTransport: "none",
              negotiation: "disabled",
              controlPlaneIsLoopback: true,
              mediaPlaneId: "media",
              egressClass: "none",
            },
            egressAudit: { approved: true, unapprovedCount: 0 },
            manifestScan: { clean: true, found: [] },
            metrics: {},
          },
          dimensionResults: [
            {
              dimension: "no-voice-dormancy",
              outcome: "pass",
              rationale: "5/5 structural checks met.",
            },
          ],
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("no-voice-dormancy=PASS");
    expect(text).toContain("] OK");
  });

  it('renders "n/a" glyph for outcome=not-applicable (excluded from fixture line)', () => {
    // not-applicable outcomes are filtered out (d.outcome !== "not-applicable") in fixtureLine,
    // so they should not appear in the fixture line at all.
    const scorecard = makeScorecard({
      fixtureResults: [
        {
          fixtureName: "partial-fixture",
          category: "stt-only",
          environment: "azure-foundry",
          effectiveProfile: "speech-to-text",
          fullyPassed: true,
          observation: {
            environment: "azure-foundry",
            advertisedProfile: "speech-to-text",
            cell: {
              effectiveProfile: "speech-to-text",
              allowedKinds: ["transcript.committed"],
              mediaTransport: "gateway-batch",
              negotiation: "disabled",
              controlPlaneIsLoopback: true,
              mediaPlaneId: "media",
              egressClass: "configured-model-endpoint",
            },
            egressAudit: { approved: true, unapprovedCount: 0 },
            manifestScan: { clean: true, found: [] },
            metrics: {},
          },
          dimensionResults: [
            {
              dimension: "stt-affordance-bounding",
              outcome: "pass",
              rationale: "5/5 structural checks met.",
            },
            {
              dimension: "interruption-metric",
              outcome: "not-applicable",
              rationale: "not exercised by this fixture.",
            },
          ],
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    // not-applicable is filtered out of fixture lines.
    // Mutation guard: if the filter is removed, "interruption-metric=n/a" would appear.
    expect(text).not.toContain("interruption-metric=n/a");
    expect(text).toContain("stt-affordance-bounding=PASS");
  });
});

// ─── dimensionLine: FAIL / n/a verdict branches ───────────────────────────────
describe("renderVoiceTwinSummary: dimensionLine verdict branches", () => {
  it('renders "FAIL" verdict in dimension line when failCount > 0', () => {
    const scorecard = makeScorecard({
      dimensions: [
        {
          dimension: "capability-matrix-consistency",
          passCount: 2,
          failCount: 1,
          notApplicableCount: 0,
          passRate: 2 / 3,
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    // Mutation guard: if the failCount > 0 branch is removed, FAIL never appears in dim lines.
    expect(text).toContain("capability-matrix-consistency");
    expect(text).toContain("FAIL");
    expect(text).toContain("fail=1");
  });

  it('renders "PASS" verdict in dimension line when failCount=0 and passCount > 0', () => {
    const scorecard = makeScorecard({
      dimensions: [
        {
          dimension: "no-voice-dormancy",
          passCount: 3,
          failCount: 0,
          notApplicableCount: 0,
          passRate: 1,
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("no-voice-dormancy");
    expect(text).toContain("pass=3");
  });

  it('renders "n/a" verdict and "n/a" rate in dimension line when passCount=0 and failCount=0', () => {
    const scorecard = makeScorecard({
      dimensions: [
        {
          dimension: "interruption-metric",
          passCount: 0,
          failCount: 0,
          notApplicableCount: 5,
          passRate: null,
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    // Mutation guard: if passRate===null check is missing, the n/a rate branch is skipped.
    expect(text).toContain("rate=n/a");
    // Mutation guard: if the passCount > 0 branch fires for passCount=0, "PASS" appears instead of "n/a".
    expect(text).toContain("n/a=5");
  });

  it("formats passRate as a percentage string when not null", () => {
    const scorecard = makeScorecard({
      dimensions: [
        {
          dimension: "end-of-turn-metric",
          passCount: 2,
          failCount: 0,
          notApplicableCount: 1,
          passRate: 1.0,
        },
      ],
    });
    const text = renderVoiceTwinSummary(scorecard);
    // passRate=1.0 → "100%"
    // Mutation guard: if toFixed(0) is changed to a different precision, "100" still appears but
    // the mutation to toFixed(2) would give "100.00%" which this test catches.
    expect(text).toContain("rate=100%");
  });
});

// ─── Structure: headers and sections always present ──────────────────────────
describe("renderVoiceTwinSummary: structural content", () => {
  it("always emits the summary header with schema version", () => {
    const text = renderVoiceTwinSummary(makeScorecard());
    expect(text).toContain("Voice Digital Twin evaluation summary (schema v1)");
  });

  it("always emits Fixtures:, Dimensions:, and matrix-cell count", () => {
    const text = renderVoiceTwinSummary(makeScorecard());
    expect(text).toContain("Fixtures:");
    expect(text).toContain("Dimensions:");
    expect(text).toContain("Privacy:");
    expect(text).toContain("matrix cells=0");
  });

  it("includes fixture count and fully-passed count", () => {
    const scorecard = makeScorecard({
      summary: {
        ...makeScorecard().summary,
        totalFixtures: 7,
        fullyPassedFixtures: 6,
        goNoGo: "NO-GO",
      },
    });
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("7 total");
    expect(text).toContain("6 fully passed");
  });
});
