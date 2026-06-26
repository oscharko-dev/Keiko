// Unit tests for scorer.ts (Issue #505 — per-module coverage additions).
//
// Targets uncovered branches:
//   - scoreVoiceTwinQuality: not-applicable path (dimension not in fixture.dimensions)
//   - missingMetric path (dimension declared but metric record missing from observation)
//   - Every FAIL branch: feed an observation whose cell / metric violates each check and assert
//     outcome="fail" with rationale starting "failed:"
//   - aggregateVoiceTwinQuality: passRate=null path (no pass and no fail results)
//   - aggregateVoiceTwinQuality: mixed pass/fail passRate calculation
// Each assertion is mutation-robust.

import { describe, expect, it } from "vitest";
import { aggregateVoiceTwinQuality, scoreVoiceTwinQuality } from "./scorer.js";
import type {
  VoiceTwinDimension,
  VoiceTwinFixture,
  VoiceTwinMetricBundle,
  VoiceTwinObservation,
} from "./types.js";

// ─── Fixture / observation builders ──────────────────────────────────────────

function makeOracle(
  overrides: Partial<VoiceTwinFixture["oracle"]> = {},
): VoiceTwinFixture["oracle"] {
  return {
    expectedEffectiveProfile: "full-realtime",
    expectedEgressApproved: true,
    expectedManifestsClean: true,
    ...overrides,
  };
}

function makeFixture(
  dimensions: VoiceTwinDimension[],
  oracleOverrides: Partial<VoiceTwinFixture["oracle"]> = {},
): VoiceTwinFixture {
  return {
    name: "test-fixture",
    category: "full-realtime",
    description: "synthetic fixture for scorer unit tests",
    environment: "azure-foundry",
    advertisedProfile: "full-realtime",
    egressLedger: [{ class: "configured-model-endpoint" }],
    manifests: [{ packageName: "keiko-server", dependencyNames: ["ws"] }],
    dimensions: new Set(dimensions),
    oracle: makeOracle(oracleOverrides),
  };
}

function makeCell(
  overrides: Partial<VoiceTwinObservation["cell"]> = {},
): VoiceTwinObservation["cell"] {
  return {
    effectiveProfile: "full-realtime",
    allowedKinds: [
      "signal.sdp.offer",
      "signal.sdp.answer",
      "media.track.state",
      "transcript.committed",
    ],
    mediaTransport: "webrtc",
    negotiation: "proxied-sdp",
    controlPlaneIsLoopback: true,
    mediaPlaneId: "media",
    egressClass: "configured-model-endpoint",
    ...overrides,
  };
}

function makeObs(
  cellOverrides: Partial<VoiceTwinObservation["cell"]> = {},
  metrics: VoiceTwinMetricBundle = {},
  auditOverrides: Partial<VoiceTwinObservation["egressAudit"]> = {},
  manifestOverrides: Partial<VoiceTwinObservation["manifestScan"]> = {},
): VoiceTwinObservation {
  return {
    environment: "azure-foundry",
    advertisedProfile: "full-realtime",
    cell: makeCell(cellOverrides),
    egressAudit: { approved: true, unapprovedCount: 0, ...auditOverrides },
    manifestScan: { clean: true, found: [], ...manifestOverrides },
    metrics,
  };
}

// ─── not-applicable path ──────────────────────────────────────────────────────
describe("scoreVoiceTwinQuality: not-applicable", () => {
  it("marks a dimension not-applicable when absent from fixture.dimensions", () => {
    // fixture declares only capability-matrix-consistency; all other dimensions → not-applicable.
    const fixture = makeFixture(["capability-matrix-consistency"]);
    const obs = makeObs();
    const results = scoreVoiceTwinQuality(fixture, obs);

    const naResults = results.filter((r) => r.outcome === "not-applicable");
    // 11 total dimensions - 1 declared = 10 not-applicable
    expect(naResults).toHaveLength(10);
    for (const r of naResults) {
      // Mutation guard: if the rationale text changes, this fails.
      expect(r.rationale).toBe("not exercised by this fixture.");
    }
  });

  it("not-applicable result has the correct dimension label", () => {
    const fixture = makeFixture(["capability-matrix-consistency"]);
    const obs = makeObs();
    const results = scoreVoiceTwinQuality(fixture, obs);

    const naForBuffer = results.find((r) => r.dimension === "buffer-boundedness-metric");
    expect(naForBuffer?.outcome).toBe("not-applicable");
    // Mutation guard: if not-applicable rationale is changed to "passed", this fails.
    expect(naForBuffer?.rationale).toBe("not exercised by this fixture.");
  });
});

// ─── missingMetric path ────────────────────────────────────────────────────────
describe("scoreVoiceTwinQuality: missingMetric (dimension declared but metric absent)", () => {
  it("interruption-metric declared but metrics.interruption missing → fail", () => {
    const fixture = makeFixture(["interruption-metric"]);
    // metrics bundle is empty — no interruption record
    const obs = makeObs({}, {});
    const results = scoreVoiceTwinQuality(fixture, obs);
    const result = results.find((r) => r.dimension === "interruption-metric");

    // Mutation guard: if missingMetric returns "pass", this fails.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toMatch(/^failed:/);
    expect(result?.rationale).toContain("interruption-metric");
  });

  it("end-of-turn-metric declared but metrics.endOfTurn missing → fail", () => {
    const fixture = makeFixture(["end-of-turn-metric"]);
    const obs = makeObs({}, {});
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "end-of-turn-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toMatch(/^failed:/);
  });

  it("transcript-correction-metric declared but metrics.transcriptCorrection missing → fail", () => {
    const fixture = makeFixture(["transcript-correction-metric"]);
    const obs = makeObs({}, {});
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "transcript-correction-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toMatch(/^failed:/);
  });

  it("provider-failure-recovery-metric declared but metric missing → fail", () => {
    const fixture = makeFixture(["provider-failure-recovery-metric"]);
    const obs = makeObs({}, {});
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "provider-failure-recovery-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toMatch(/^failed:/);
  });

  it("buffer-boundedness-metric declared but metric missing → fail", () => {
    const fixture = makeFixture(["buffer-boundedness-metric"]);
    const obs = makeObs({}, {});
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "buffer-boundedness-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toMatch(/^failed:/);
  });
});

// ─── FAIL branches: capability-matrix-consistency ────────────────────────────
describe("scoreVoiceTwinQuality: capability-matrix-consistency FAIL branches", () => {
  it("fails when effectiveProfile does not match oracle", () => {
    const fixture = makeFixture(
      ["capability-matrix-consistency"],
      { expectedEffectiveProfile: "speech-to-text" }, // oracle expects STT
    );
    // cell has full-realtime — mismatch
    const obs = makeObs({
      effectiveProfile: "full-realtime",
      egressClass: "configured-model-endpoint",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "capability-matrix-consistency",
    );
    // Mutation guard: if the effective-profile check is removed, this would pass.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toMatch(/^failed:/);
    expect(result?.rationale).toContain("effective profile matches the oracle expectation");
  });

  it("fails when egressClass does not match effective profile (none cell with configured egress)", () => {
    const fixture = makeFixture(["capability-matrix-consistency"], {
      expectedEffectiveProfile: "none",
    });
    // effective profile is none but egressClass is configured-model-endpoint → mismatch
    const obs = makeObs({ effectiveProfile: "none", egressClass: "configured-model-endpoint" });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "capability-matrix-consistency",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("egress class matches the effective profile");
  });

  it("fails when controlPlaneIsLoopback is false", () => {
    const fixture = makeFixture(["capability-matrix-consistency"]);
    const obs = makeObs({ controlPlaneIsLoopback: false });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "capability-matrix-consistency",
    );
    // Mutation guard: if controlPlaneIsLoopback check is removed, false is not caught.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("control plane is loopback");
  });
});

// ─── FAIL branches: no-voice-dormancy ────────────────────────────────────────
describe("scoreVoiceTwinQuality: no-voice-dormancy FAIL branches", () => {
  it("fails when effective profile is not none", () => {
    const fixture = makeFixture(["no-voice-dormancy"], { expectedEffectiveProfile: "none" });
    const obs = makeObs({
      effectiveProfile: "speech-to-text",
      egressClass: "configured-model-endpoint",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "no-voice-dormancy",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("effective profile is none");
  });

  it("fails when allowedKinds is non-empty", () => {
    const fixture = makeFixture(["no-voice-dormancy"], { expectedEffectiveProfile: "none" });
    const obs = makeObs({
      effectiveProfile: "none",
      allowedKinds: ["session.created"],
      mediaTransport: "none",
      negotiation: "disabled",
      egressClass: "none",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "no-voice-dormancy",
    );
    // Mutation guard: if the allowedKinds.length === 0 check is removed, non-empty passes.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("no allowed control message kinds");
  });

  it("fails when mediaTransport is not none", () => {
    const fixture = makeFixture(["no-voice-dormancy"], { expectedEffectiveProfile: "none" });
    const obs = makeObs({
      effectiveProfile: "none",
      allowedKinds: [],
      mediaTransport: "gateway-batch",
      negotiation: "disabled",
      egressClass: "none",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "no-voice-dormancy",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("media transport is none");
  });
});

// ─── FAIL branches: stt-affordance-bounding ───────────────────────────────────
describe("scoreVoiceTwinQuality: stt-affordance-bounding FAIL branches", () => {
  it("fails when effective profile is not speech-to-text", () => {
    const fixture = makeFixture(["stt-affordance-bounding"], {
      expectedEffectiveProfile: "speech-to-text",
    });
    const obs = makeObs({
      effectiveProfile: "full-realtime",
      allowedKinds: ["transcript.committed"],
      mediaTransport: "gateway-batch",
      negotiation: "disabled",
      egressClass: "configured-model-endpoint",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "stt-affordance-bounding",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("effective profile is speech-to-text");
  });

  it("fails when transcript.committed is absent from allowed kinds", () => {
    const fixture = makeFixture(["stt-affordance-bounding"], {
      expectedEffectiveProfile: "speech-to-text",
    });
    const obs = makeObs({
      effectiveProfile: "speech-to-text",
      allowedKinds: [], // missing transcript.committed
      mediaTransport: "gateway-batch",
      negotiation: "disabled",
      egressClass: "configured-model-endpoint",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "stt-affordance-bounding",
    );
    // Mutation guard: if `allowed.includes("transcript.committed")` check is removed, empty passes.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("transcript dictation kinds permitted");
  });

  it("fails when a forbidden kind (signal.sdp.offer) is in allowed kinds", () => {
    const fixture = makeFixture(["stt-affordance-bounding"], {
      expectedEffectiveProfile: "speech-to-text",
    });
    const obs = makeObs({
      effectiveProfile: "speech-to-text",
      allowedKinds: ["transcript.committed", "signal.sdp.offer"], // forbidden kind included
      mediaTransport: "gateway-batch",
      negotiation: "disabled",
      egressClass: "configured-model-endpoint",
    });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "stt-affordance-bounding",
    );
    // Mutation guard: if the STT_FORBIDDEN_KINDS exclusion check is removed, this passes.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("WebRTC / media / playback / interrupt kinds excluded");
  });
});

// ─── FAIL branches: transport-plane-separation ────────────────────────────────
describe("scoreVoiceTwinQuality: transport-plane-separation FAIL branches", () => {
  it("fails when mediaTransport is not webrtc", () => {
    const fixture = makeFixture(["transport-plane-separation"]);
    const obs = makeObs({ mediaTransport: "gateway-batch" });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "transport-plane-separation",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("media transport is webrtc");
  });

  it("fails when negotiation is not proxied-sdp", () => {
    const fixture = makeFixture(["transport-plane-separation"]);
    const obs = makeObs({ negotiation: "disabled" });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "transport-plane-separation",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("negotiation is proxied-sdp");
  });

  it("fails when required realtime kinds are absent", () => {
    const fixture = makeFixture(["transport-plane-separation"]);
    // Missing signal.sdp.offer
    const obs = makeObs({ allowedKinds: ["signal.sdp.answer", "media.track.state"] });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "transport-plane-separation",
    );
    // Mutation guard: if REALTIME_REQUIRED_KINDS.every check is removed, partial list passes.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("SDP / media-track signalling kinds present");
  });
});

// ─── FAIL branches: external-destination-privacy ─────────────────────────────
describe("scoreVoiceTwinQuality: external-destination-privacy FAIL branches", () => {
  it("fails when egressAudit.approved does not match oracle (approved=true but oracle=false)", () => {
    const fixture = makeFixture(["external-destination-privacy"], {
      expectedEgressApproved: false,
      expectedManifestsClean: true,
    });
    // Audit says approved=true but oracle expects false → mismatch
    const obs = makeObs({}, {}, { approved: true, unapprovedCount: 0 });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "external-destination-privacy",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("egress audit verdict matches oracle expectation");
  });

  it("fails when manifestScan.clean does not match oracle", () => {
    const fixture = makeFixture(["external-destination-privacy"], {
      expectedEgressApproved: true,
      expectedManifestsClean: false,
    });
    // Scan says clean=true but oracle expects false
    const obs = makeObs({}, {}, { approved: true, unapprovedCount: 0 }, { clean: true, found: [] });
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "external-destination-privacy",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("manifest scan verdict matches oracle expectation");
  });

  it("fails when oracle expects approved but unapprovedCount is zero (contradiction)", () => {
    // oracle.expectedEgressApproved=false means unapprovedCount must be > 0.
    // Here unapprovedCount=0 but approved=false: count check fails.
    const fixture = makeFixture(["external-destination-privacy"], {
      expectedEgressApproved: false,
      expectedManifestsClean: false,
    });
    const obs = makeObs(
      {},
      {},
      { approved: false, unapprovedCount: 0 }, // approved=false matches oracle, but count=0 → fail
      { clean: false, found: [{ packageName: "p", deniedPackage: "d" }] },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "external-destination-privacy",
    );
    // Mutation guard: if unapproved-count check is removed, this passes when it should fail.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("unapproved-destination count agrees with the verdict");
  });
});

// ─── FAIL branches: AC6 metric dimensions ────────────────────────────────────
describe("scoreVoiceTwinQuality: interruption-metric FAIL branch", () => {
  it("fails when interruptAllowed is false", () => {
    const fixture = makeFixture(["interruption-metric"]);
    const obs = makeObs(
      {},
      { interruption: { interruptAllowed: false, interruptedPhaseReachable: true } },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "interruption-metric",
    );
    // Mutation guard: if the interruptAllowed check is negated, false passes.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("interrupt allowed for the capable profile");
  });

  it("fails when interruptedPhaseReachable is false", () => {
    const fixture = makeFixture(["interruption-metric"]);
    const obs = makeObs(
      {},
      { interruption: { interruptAllowed: true, interruptedPhaseReachable: false } },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "interruption-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("speaking -> interrupted is reachable");
  });
});

describe("scoreVoiceTwinQuality: end-of-turn-metric FAIL branches", () => {
  it("fails when committedKindAllowed is false", () => {
    const fixture = makeFixture(["end-of-turn-metric"]);
    const obs = makeObs(
      {},
      {
        endOfTurn: {
          committedKindAllowed: false,
          captureAllowed: true,
          committedSegmentCount: 3,
          excludesUncommitted: true,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "end-of-turn-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("transcript.committed permitted for the profile");
  });

  it("fails when committedSegmentCount is 0", () => {
    const fixture = makeFixture(["end-of-turn-metric"]);
    const obs = makeObs(
      {},
      {
        endOfTurn: {
          committedKindAllowed: true,
          captureAllowed: true,
          committedSegmentCount: 0, // empty projection
          excludesUncommitted: true,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "end-of-turn-metric",
    );
    // Mutation guard: if `> 0` is changed to `>= 0`, count=0 passes.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("committed projection is non-empty");
  });

  it("fails when excludesUncommitted is false", () => {
    const fixture = makeFixture(["end-of-turn-metric"]);
    const obs = makeObs(
      {},
      {
        endOfTurn: {
          committedKindAllowed: true,
          captureAllowed: true,
          committedSegmentCount: 2,
          excludesUncommitted: false,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "end-of-turn-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("committed projection excludes partial / stable");
  });
});

describe("scoreVoiceTwinQuality: transcript-correction-metric FAIL branches", () => {
  it("fails when supersededTextDropped is false", () => {
    const fixture = makeFixture(["transcript-correction-metric"]);
    const obs = makeObs(
      {},
      {
        transcriptCorrection: {
          stableToCorrectedAllowed: true,
          committedToCorrectedAllowed: true,
          correctedIsConsumable: true,
          supersededTextDropped: false,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "transcript-correction-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("superseded committed text dropped from projection");
  });
});

describe("scoreVoiceTwinQuality: buffer-boundedness-metric FAIL branches", () => {
  it("fails when maxObservedLength exceeds capacity", () => {
    const fixture = makeFixture(["buffer-boundedness-metric"]);
    const obs = makeObs(
      {},
      {
        bufferBoundedness: {
          capacity: 5,
          maxObservedLength: 6, // exceeds capacity
          admittedCount: 6,
          ephemeralBuffered: false,
          evictedOldestOnOverflow: false,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "buffer-boundedness-metric",
    );
    // Mutation guard: with no overflow flagged, a length exceeding capacity must still fail the
    // exact-fill / ≤capacity check.
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("ring fills exactly to capacity under overflow");
  });

  it("fails when overflow is flagged but the ring did not fill to capacity", () => {
    // The new teeth: a trivial-capacity model that evicts but never actually fills to capacity must FAIL,
    // closing the self-referential ≤capacity loophole.
    const fixture = makeFixture(["buffer-boundedness-metric"]);
    const obs = makeObs(
      {},
      {
        bufferBoundedness: {
          capacity: 200,
          maxObservedLength: 8, // overflow flagged but length never reached capacity
          admittedCount: 8,
          ephemeralBuffered: false,
          evictedOldestOnOverflow: true,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "buffer-boundedness-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("ring fills exactly to capacity under overflow");
  });

  it("fails when capacity is not the documented ring size", () => {
    const fixture = makeFixture(["buffer-boundedness-metric"]);
    const obs = makeObs(
      {},
      {
        bufferBoundedness: {
          capacity: 8, // not VOICE_TWIN_REPLAY_CAPACITY (200)
          maxObservedLength: 8,
          admittedCount: 8,
          ephemeralBuffered: false,
          evictedOldestOnOverflow: true,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "buffer-boundedness-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("capacity equals the documented ring size");
  });

  it("fails when admittedCount is 0", () => {
    const fixture = makeFixture(["buffer-boundedness-metric"]);
    const obs = makeObs(
      {},
      {
        bufferBoundedness: {
          capacity: 8,
          maxObservedLength: 0,
          admittedCount: 0,
          ephemeralBuffered: false,
          evictedOldestOnOverflow: true,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "buffer-boundedness-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("at least one replay-eligible kind admitted");
  });

  it("fails when ephemeralBuffered is true", () => {
    const fixture = makeFixture(["buffer-boundedness-metric"]);
    const obs = makeObs(
      {},
      {
        bufferBoundedness: {
          capacity: 8,
          maxObservedLength: 3,
          admittedCount: 3,
          ephemeralBuffered: true, // invariant broken
          evictedOldestOnOverflow: false,
        },
      },
    );
    const result = scoreVoiceTwinQuality(fixture, obs).find(
      (r) => r.dimension === "buffer-boundedness-metric",
    );
    expect(result?.outcome).toBe("fail");
    expect(result?.rationale).toContain("no ephemeral kind ever buffered");
  });
});

// ─── aggregateVoiceTwinQuality ────────────────────────────────────────────────
describe("aggregateVoiceTwinQuality", () => {
  it("returns passRate=null when all results for a dimension are not-applicable", () => {
    // All fixtures declare only capability-matrix-consistency → every other dimension is n/a.
    const noApplicable = [
      [
        {
          dimension: "buffer-boundedness-metric" as const,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
      ],
    ];
    const entries = aggregateVoiceTwinQuality(noApplicable);
    const buffer = entries.find((e) => e.dimension === "buffer-boundedness-metric");
    // Mutation guard: if passRate=0 is returned instead of null for zero scored, comparison is wrong.
    expect(buffer?.passRate).toBeNull();
    expect(buffer?.passCount).toBe(0);
    expect(buffer?.failCount).toBe(0);
    expect(buffer?.notApplicableCount).toBe(1);
  });

  it("computes passRate correctly for mixed pass/fail results", () => {
    const mixed = [
      [
        {
          dimension: "interruption-metric" as const,
          outcome: "pass" as const,
          rationale: "2/2 structural checks met.",
        },
      ],
      [
        {
          dimension: "interruption-metric" as const,
          outcome: "pass" as const,
          rationale: "2/2 structural checks met.",
        },
      ],
      [
        {
          dimension: "interruption-metric" as const,
          outcome: "fail" as const,
          rationale: "failed: interrupt allowed for the capable profile.",
        },
      ],
    ];
    const entries = aggregateVoiceTwinQuality(mixed);
    const interruption = entries.find((e) => e.dimension === "interruption-metric");
    expect(interruption?.passCount).toBe(2);
    expect(interruption?.failCount).toBe(1);
    // passRate = 2/(2+1) ≈ 0.666...
    // Mutation guard: if passCount / scored uses failCount instead of scored, rate = 2/1 = 2.
    expect(interruption?.passRate).toBeCloseTo(2 / 3);
  });

  it("accumulates notApplicableCount separately from pass and fail", () => {
    const results = [
      [
        {
          dimension: "end-of-turn-metric" as const,
          outcome: "pass" as const,
          rationale: "4/4 structural checks met.",
        },
      ],
      [
        {
          dimension: "end-of-turn-metric" as const,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
      ],
      [
        {
          dimension: "end-of-turn-metric" as const,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
      ],
    ];
    const entries = aggregateVoiceTwinQuality(results);
    const eot = entries.find((e) => e.dimension === "end-of-turn-metric");
    expect(eot?.passCount).toBe(1);
    expect(eot?.failCount).toBe(0);
    // Mutation guard: if notApplicableCount includes pass results, count would be 3.
    expect(eot?.notApplicableCount).toBe(2);
    expect(eot?.passRate).toBe(1);
  });

  it("aggregates all eleven dimensions even when input has only one dimension result per fixture", () => {
    const results = [
      [
        {
          dimension: "capability-matrix-consistency" as const,
          outcome: "pass" as const,
          rationale: "3/3 structural checks met.",
        },
      ],
    ];
    const entries = aggregateVoiceTwinQuality(results);
    // Should have 11 entries (one per VOICE_TWIN_DIMENSIONS member).
    expect(entries).toHaveLength(11);
    // Capability dimension: 0 pass, 0 fail, 1 n/a (the result above IS for cap-matrix but with outcome pass)
    const capEntry = entries.find((e) => e.dimension === "capability-matrix-consistency");
    expect(capEntry?.passCount).toBe(1);
  });
});
