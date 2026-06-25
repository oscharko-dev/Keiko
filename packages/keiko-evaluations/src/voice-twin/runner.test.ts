// Unit tests for runner.ts (Issue #505 — per-module coverage additions).
//
// Targets uncovered branches:
//   - runner.ts line 160: the NO-GO branch in summarize() when coverage flags are unmet or
//     a dimension has failures. Suite.test.ts only exercises the full fixture set (always GO).
//   - deriveVoiceTwinObservation: verify metric bundle is built selectively (only declared dims).
//   - collectMatrixCells: de-duplication and canonical ordering.
//   - runVoiceTwinEvaluation with a custom fixture list (not default ALL_VOICE_TWIN_FIXTURES).
//   - deriveMetrics omission paths: fixture without any metric dimension → empty bundle.
// Each assertion is mutation-robust.

import { describe, expect, it } from "vitest";
import { deriveVoiceTwinObservation, runVoiceTwinEvaluation } from "./runner.js";
import type { VoiceTwinDimension, VoiceTwinFixture } from "./types.js";

// ─── Minimal fixture factories ────────────────────────────────────────────────

function noVoiceFixture(name: string): VoiceTwinFixture {
  return {
    name,
    category: "no-voice",
    description: "synthetic no-voice fixture for runner tests",
    environment: "no-voice-env",
    advertisedProfile: "none",
    egressLedger: [],
    manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
    dimensions: new Set(["no-voice-dormancy", "capability-matrix-consistency"]),
    oracle: {
      expectedEffectiveProfile: "none",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

function sttFixture(name: string): VoiceTwinFixture {
  return {
    name,
    category: "stt-only",
    description: "synthetic STT fixture for runner tests",
    environment: "azure-foundry",
    advertisedProfile: "speech-to-text",
    egressLedger: [{ class: "configured-model-endpoint" }],
    manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
    dimensions: new Set([
      "stt-affordance-bounding",
      "capability-matrix-consistency",
      "external-destination-privacy",
      "end-of-turn-metric",
      "transcript-correction-metric",
    ]),
    oracle: {
      expectedEffectiveProfile: "speech-to-text",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

function fullRealtimeFixture(
  name: string,
  environment: "azure-foundry" | "customer-hosted",
): VoiceTwinFixture {
  return {
    name,
    category: "full-realtime",
    description: "synthetic full-realtime fixture for runner tests",
    environment,
    advertisedProfile: "full-realtime",
    egressLedger: [{ class: "configured-model-endpoint" }],
    manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
    dimensions: new Set([
      "transport-plane-separation",
      "interruption-metric",
      "buffer-boundedness-metric",
      "provider-failure-recovery-metric",
      "capability-matrix-consistency",
      "external-destination-privacy",
    ]),
    oracle: {
      expectedEffectiveProfile: "full-realtime",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

function privacyNegativeFixture(name: string): VoiceTwinFixture {
  return {
    name,
    category: "privacy",
    description: "synthetic privacy-negative fixture for runner tests",
    environment: "azure-foundry",
    advertisedProfile: "full-realtime",
    egressLedger: [{ class: "unapproved-external" }],
    manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
    dimensions: new Set(["external-destination-privacy"]),
    oracle: {
      expectedEffectiveProfile: "full-realtime",
      expectedEgressApproved: false,
      expectedManifestsClean: true,
    },
  };
}

function speechOutputFixture(name: string): VoiceTwinFixture {
  return {
    name,
    category: "speech-output",
    description: "synthetic speech-output fixture for runner tests",
    environment: "azure-foundry",
    advertisedProfile: "speech-output",
    egressLedger: [{ class: "configured-model-endpoint" }],
    manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
    dimensions: new Set(["interruption-metric", "capability-matrix-consistency"]),
    oracle: {
      expectedEffectiveProfile: "speech-output",
      expectedEgressApproved: true,
      expectedManifestsClean: true,
    },
  };
}

// A fixture set that satisfies all coverage flags for a GO verdict.
function minimalGoFixtureSet(): readonly VoiceTwinFixture[] {
  return [
    noVoiceFixture("runner-no-voice"),
    sttFixture("runner-stt"),
    speechOutputFixture("runner-speech-output"),
    fullRealtimeFixture("runner-full-realtime-azure", "azure-foundry"),
    fullRealtimeFixture("runner-full-realtime-customer", "customer-hosted"),
    privacyNegativeFixture("runner-privacy-negative"),
  ];
}

// ─── deriveVoiceTwinObservation ────────────────────────────────────────────────
describe("deriveVoiceTwinObservation", () => {
  it("derives the capability cell from the fixture environment × profile", () => {
    const fixture = sttFixture("obs-stt");
    const obs = deriveVoiceTwinObservation(fixture);

    expect(obs.environment).toBe("azure-foundry");
    expect(obs.advertisedProfile).toBe("speech-to-text");
    expect(obs.cell.effectiveProfile).toBe("speech-to-text");
    // Mutation guard: if the cell derivation returns the wrong transport, this fails.
    expect(obs.cell.mediaTransport).toBe("gateway-batch");
  });

  it("audits egress: approved for a configured-model-endpoint-only ledger", () => {
    const fixture = sttFixture("obs-stt-egress");
    const obs = deriveVoiceTwinObservation(fixture);
    // Mutation guard: if auditVoiceEgress is not called, approved stays undefined.
    expect(obs.egressAudit.approved).toBe(true);
    expect(obs.egressAudit.unapprovedCount).toBe(0);
  });

  it("scans manifests: clean for ws-only dependency list", () => {
    const fixture = sttFixture("obs-stt-manifest");
    const obs = deriveVoiceTwinObservation(fixture);
    expect(obs.manifestScan.clean).toBe(true);
    expect(obs.manifestScan.found).toHaveLength(0);
  });

  it("derives metrics only for declared dimensions (end-of-turn present, interruption absent)", () => {
    const fixture = sttFixture("obs-stt-metrics");
    const obs = deriveVoiceTwinObservation(fixture);
    // STT fixture declares end-of-turn-metric and transcript-correction-metric.
    expect(obs.metrics.endOfTurn).toBeDefined();
    expect(obs.metrics.transcriptCorrection).toBeDefined();
    // Mutation guard: if all metrics are derived regardless of declaration, interruption would exist.
    expect(obs.metrics.interruption).toBeUndefined();
    expect(obs.metrics.bufferBoundedness).toBeUndefined();
    expect(obs.metrics.providerFailureRecovery).toBeUndefined();
  });

  it("derives no metrics for a fixture with only non-metric dimensions", () => {
    // The no-voice fixture declares only no-voice-dormancy and capability-matrix-consistency.
    const fixture = noVoiceFixture("obs-no-voice-metrics");
    const obs = deriveVoiceTwinObservation(fixture);
    // Mutation guard: if any metric is always derived regardless of declared dimensions, this fails.
    expect(obs.metrics.interruption).toBeUndefined();
    expect(obs.metrics.endOfTurn).toBeUndefined();
    expect(obs.metrics.transcriptCorrection).toBeUndefined();
    expect(obs.metrics.providerFailureRecovery).toBeUndefined();
    expect(obs.metrics.bufferBoundedness).toBeUndefined();
  });

  it("derives all five metrics for a full-realtime fixture with all metric dimensions", () => {
    // Construct a fixture that declares every metric dimension.
    const fixture: VoiceTwinFixture = {
      ...fullRealtimeFixture("obs-all-metrics", "azure-foundry"),
      dimensions: new Set([
        "interruption-metric",
        "end-of-turn-metric",
        "transcript-correction-metric",
        "provider-failure-recovery-metric",
        "buffer-boundedness-metric",
      ]),
    };
    const obs = deriveVoiceTwinObservation(fixture);
    // Mutation guard: if any of the `if (fixture.dimensions.has(...))` guards are removed,
    // the corresponding metric would appear even on fixtures that don't declare it.
    expect(obs.metrics.interruption).toBeDefined();
    expect(obs.metrics.endOfTurn).toBeDefined();
    expect(obs.metrics.transcriptCorrection).toBeDefined();
    expect(obs.metrics.providerFailureRecovery).toBeDefined();
    expect(obs.metrics.bufferBoundedness).toBeDefined();
  });
});

// ─── runVoiceTwinEvaluation with custom fixture list ──────────────────────────
describe("runVoiceTwinEvaluation with custom fixture sets", () => {
  it("returns schema version 1", () => {
    const scorecard = runVoiceTwinEvaluation(minimalGoFixtureSet());
    expect(scorecard.schemaVersion).toBe("1");
  });

  it("returns GO with a minimal fixture set that satisfies all coverage flags", () => {
    const scorecard = runVoiceTwinEvaluation(minimalGoFixtureSet());
    // Mutation guard: if coversPrivacyNegative is removed from the GO condition, a set without
    // the privacy-negative fixture would still get GO.
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.coversNoVoice).toBe(true);
    expect(scorecard.summary.coversSttOnly).toBe(true);
    expect(scorecard.summary.coversFullRealtime).toBe(true);
    expect(scorecard.summary.coversAzureFoundry).toBe(true);
    expect(scorecard.summary.coversCustomerHosted).toBe(true);
    expect(scorecard.summary.coversPrivacyNegative).toBe(true);
  });

  // ─── NO-GO: missing coverage flags ──────────────────────────────────────────
  it("returns NO-GO when coversPrivacyNegative is false (no privacy-negative fixture)", () => {
    // Omit the privacy-negative fixture → coversPrivacyNegative=false → NO-GO.
    const fixtures = [
      noVoiceFixture("nogo-no-voice"),
      sttFixture("nogo-stt"),
      fullRealtimeFixture("nogo-full-rt-azure", "azure-foundry"),
      fullRealtimeFixture("nogo-full-rt-customer", "customer-hosted"),
      // No privacy-negative fixture.
    ];
    const scorecard = runVoiceTwinEvaluation(fixtures);
    // Mutation guard: if coverageMetCheck drops coversPrivacyNegative, this returns GO.
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
    expect(scorecard.summary.coversPrivacyNegative).toBe(false);
  });

  it("returns NO-GO when coversNoVoice is false", () => {
    // Only STT fixtures → no effective-none cells → coversNoVoice=false.
    const fixtures = [
      sttFixture("nogo-stt-only"),
      fullRealtimeFixture("nogo-full-rt", "azure-foundry"),
      privacyNegativeFixture("nogo-privacy-neg"),
    ];
    const scorecard = runVoiceTwinEvaluation(fixtures);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
    // Mutation guard: if coversNoVoice check is removed from GO condition, this would be GO.
    expect(scorecard.summary.coversNoVoice).toBe(false);
  });

  it("returns NO-GO when a fixture has a failing dimension", () => {
    // A fixture whose oracle expects none but will receive speech-to-text → capability mismatch.
    const failingFixture: VoiceTwinFixture = {
      ...sttFixture("nogo-failing"),
      oracle: {
        expectedEffectiveProfile: "none", // expects none but environment gives speech-to-text
        expectedEgressApproved: true,
        expectedManifestsClean: true,
      },
    };
    const scorecard = runVoiceTwinEvaluation([failingFixture]);
    // Mutation guard: if allClean is not required for GO, a failing dimension still gives GO.
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
    expect(scorecard.summary.fullyPassedFixtures).toBeLessThan(scorecard.summary.totalFixtures);
  });

  it("returns NO-GO when coversCustomerHosted is false", () => {
    // Only azure-foundry fixtures.
    const fixtures = [
      noVoiceFixture("nogo-no-voice-azure"),
      sttFixture("nogo-stt-azure"),
      fullRealtimeFixture("nogo-full-rt-azure", "azure-foundry"),
      privacyNegativeFixture("nogo-priv-neg"),
    ];
    const scorecard = runVoiceTwinEvaluation(fixtures);
    expect(scorecard.summary.coversCustomerHosted).toBe(false);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
  });

  it("returns NO-GO when coversFullRealtime is false", () => {
    // Only STT + no-voice fixtures: no full-realtime effective profile → coversFullRealtime=false.
    // The privacy-negative fixture has full-realtime profile so it must be excluded here.
    // Use a privacy fixture with no-voice-env so it degrades to effective=none.
    const privacyNoneFixture: VoiceTwinFixture = {
      name: "nogo-priv-none",
      category: "privacy",
      description: "privacy fixture with no effective realtime",
      environment: "no-voice-env",
      advertisedProfile: "full-realtime",
      egressLedger: [],
      manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
      dimensions: new Set<VoiceTwinDimension>(["external-destination-privacy"]),
      oracle: {
        expectedEffectiveProfile: "none",
        expectedEgressApproved: true,
        expectedManifestsClean: true,
      },
    };
    const fixtures = [
      noVoiceFixture("nogo-no-voice-v2"),
      sttFixture("nogo-stt-v2"),
      privacyNoneFixture,
    ];
    const scorecard = runVoiceTwinEvaluation(fixtures);
    // Mutation guard: if coversFullRealtime check is removed from GO condition, this returns GO.
    expect(scorecard.summary.coversFullRealtime).toBe(false);
    expect(scorecard.summary.goNoGo).toBe("NO-GO");
  });

  it("counts total and fully-passed fixtures accurately", () => {
    const scorecard = runVoiceTwinEvaluation(minimalGoFixtureSet());
    expect(scorecard.summary.totalFixtures).toBe(6);
    expect(scorecard.summary.fullyPassedFixtures).toBe(6);
  });

  // ─── collectMatrixCells canonical ordering ────────────────────────────────
  it("deduplicates matrix cells: two fixtures with same environment × profile produce one cell", () => {
    const fixtures = [
      noVoiceFixture("dedup-1"),
      noVoiceFixture("dedup-2"), // same env × profile
    ];
    const scorecard = runVoiceTwinEvaluation(fixtures);
    // Mutation guard: if seen.has() check is removed, we get 2 cells instead of 1.
    const noneNoVoice = scorecard.coveredMatrixCells.filter(
      (c) => c.environment === "no-voice-env" && c.effectiveProfile === "none",
    );
    expect(noneNoVoice).toHaveLength(1);
  });

  it("sorts matrix cells by environment then effectiveProfile", () => {
    const fixtures = [
      fullRealtimeFixture("sort-azure", "azure-foundry"),
      sttFixture("sort-stt"),
      noVoiceFixture("sort-no-voice"),
    ];
    const scorecard = runVoiceTwinEvaluation(fixtures);
    const cells = scorecard.coveredMatrixCells;
    // Mutation guard: if the sort is dropped, insertion order may differ.
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1];
      const curr = cells[i];
      if (prev !== undefined && curr !== undefined) {
        const cmp =
          prev.environment === curr.environment
            ? prev.effectiveProfile.localeCompare(curr.effectiveProfile)
            : prev.environment.localeCompare(curr.environment);
        expect(cmp).toBeLessThanOrEqual(0);
      }
    }
  });

  it("is deterministic: two runs with same fixture list produce identical scorecards", () => {
    const a = runVoiceTwinEvaluation(minimalGoFixtureSet());
    const b = runVoiceTwinEvaluation(minimalGoFixtureSet());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
