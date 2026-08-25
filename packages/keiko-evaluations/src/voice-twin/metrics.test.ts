// Unit tests for metrics.ts (Issue #505 — per-module coverage additions).
//
// Targets uncovered branches:
//   - deriveBufferBoundednessMetric with capacity=1 (eviction on first overflow)
//   - deriveBufferBoundednessMetric with only ephemeral kinds (admittedCount=0,
//     evictedOldestOnOverflow=false)
//   - deriveInterruptionMetric for a non-interrupt-capable profile (interruptAllowed=false)
//   - deriveEndOfTurnMetric for a profile that disallows capture (committedKindAllowed=false)
//   - deriveTranscriptCorrectionMetric structural properties (mutation-robust checks)
//   - deriveProviderFailureRecoveryMetric structural properties
// Each assertion is mutation-robust.

import {
  VOICE_REPLAY_CAPACITY,
  VOICE_TRANSCRIPT_CONSUMABLE_STATES,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import {
  VOICE_TWIN_REPLAY_CAPACITY,
  deriveBufferBoundednessMetric,
  deriveEndOfTurnMetric,
  deriveInterruptionMetric,
  deriveProviderFailureRecoveryMetric,
  deriveTranscriptCorrectionMetric,
} from "./metrics.js";

// ─── VOICE_TWIN_REPLAY_CAPACITY ────────────────────────────────────────────────
describe("VOICE_TWIN_REPLAY_CAPACITY", () => {
  it("is 200 (mirroring the keiko-server and keiko-ui ring size)", () => {
    // Mutation guard: if the constant is changed, the buffer model no longer mirrors the runtime.
    expect(VOICE_TWIN_REPLAY_CAPACITY).toBe(200);
  });

  // KEIKO-0380 drift pin: the local constant must be the contract-owned value, not a restated literal.
  // If the local definition is switched back to `= 200`, this test still passes today — but if the
  // contract owner (keiko-contracts) ever changes `VOICE_REPLAY_CAPACITY`, the local restated literal
  // would diverge and this identity assertion would go RED, which is the drift signal the fix exists
  // to raise (previously the three consumers each restated `= 200` with no cross-consumer coupling).
  it("is the same object identity as the contract-owned VOICE_REPLAY_CAPACITY (no local restatement)", () => {
    expect(VOICE_TWIN_REPLAY_CAPACITY).toBe(VOICE_REPLAY_CAPACITY);
  });
});

// ─── deriveBufferBoundednessMetric ─────────────────────────────────────────────
describe("deriveBufferBoundednessMetric", () => {
  it("returns all-zero metrics for an empty kind list", () => {
    const metric = deriveBufferBoundednessMetric([]);
    expect(metric.admittedCount).toBe(0);
    expect(metric.maxObservedLength).toBe(0);
    expect(metric.ephemeralBuffered).toBe(false);
    // Mutation guard: if evictedOldestOnOverflow starts as true, this fails.
    expect(metric.evictedOldestOnOverflow).toBe(false);
    expect(metric.capacity).toBe(VOICE_TWIN_REPLAY_CAPACITY);
  });

  it("admits replay-eligible kinds up to capacity without eviction", () => {
    // transcript.committed is replay-eligible; push 3 with capacity=5 → no eviction.
    const kinds = Array.from({ length: 3 }, () => "transcript.committed" as const);
    const metric = deriveBufferBoundednessMetric(kinds, 5);
    expect(metric.admittedCount).toBe(3);
    expect(metric.maxObservedLength).toBe(3);
    // Mutation guard: if evictedOldestOnOverflow is set to true unconditionally, this fails.
    expect(metric.evictedOldestOnOverflow).toBe(false);
    expect(metric.ephemeralBuffered).toBe(false);
    expect(metric.capacity).toBe(5);
  });

  // ─── capacity=1: eviction on second admitted kind ───────────────────────────
  it("evicts immediately with capacity=1 when two replay-eligible kinds are pushed", () => {
    // Push 2 replay-eligible kinds into a ring of size 1 → eviction on second push.
    const kinds = ["transcript.committed", "session.created"] as const;
    const metric = deriveBufferBoundednessMetric(kinds, 1);
    // Mutation guard: if the `ring.length >= capacity` branch body is dropped, no eviction occurs
    // and maxObservedLength would exceed capacity.
    expect(metric.evictedOldestOnOverflow).toBe(true);
    expect(metric.maxObservedLength).toBe(1);
    expect(metric.maxObservedLength).toBeLessThanOrEqual(metric.capacity);
    expect(metric.admittedCount).toBe(2);
    expect(metric.ephemeralBuffered).toBe(false);
  });

  it("ring length never exceeds capacity even far past overflow", () => {
    // 10 replay-eligible kinds into capacity=3 → length stays ≤ 3.
    const kinds = Array.from({ length: 10 }, () => "session.created" as const);
    const metric = deriveBufferBoundednessMetric(kinds, 3);
    expect(metric.maxObservedLength).toBeLessThanOrEqual(3);
    expect(metric.evictedOldestOnOverflow).toBe(true);
    expect(metric.admittedCount).toBe(10);
  });

  // ─── Only ephemeral kinds: admittedCount=0, evictedOldestOnOverflow=false ─────
  it("never admits or evicts when all kinds are ephemeral (transcript.partial)", () => {
    // transcript.partial is ephemeral (not replay-eligible). With 50 pushes and capacity=8,
    // the ring stays empty: no eviction, admittedCount=0, ephemeralBuffered=false.
    const kinds = Array.from({ length: 50 }, () => "transcript.partial" as const);
    const metric = deriveBufferBoundednessMetric(kinds, 8);
    // Mutation guard: if !isVoiceReplayEligible is changed to isVoiceReplayEligible, ephemeral kinds
    // would be admitted instead of skipped, making admittedCount=50.
    expect(metric.admittedCount).toBe(0);
    expect(metric.maxObservedLength).toBe(0);
    // Mutation guard: if evictedOldestOnOverflow starts true, this fails.
    expect(metric.evictedOldestOnOverflow).toBe(false);
    // Mutation guard: if the ring.includes(kind) check fires on an empty ring, ephemeralBuffered
    // could incorrectly become true (it cannot — includes on [] is always false).
    expect(metric.ephemeralBuffered).toBe(false);
  });

  it("uses default capacity of VOICE_TWIN_REPLAY_CAPACITY when none given", () => {
    const metric = deriveBufferBoundednessMetric(["transcript.committed"]);
    // Mutation guard: if default changes from VOICE_TWIN_REPLAY_CAPACITY, this fails.
    expect(metric.capacity).toBe(VOICE_TWIN_REPLAY_CAPACITY);
  });

  it("mixes ephemeral and replay-eligible: only replay-eligible counted", () => {
    // 5 partial (ephemeral) + 3 committed (replay-eligible), capacity=10.
    const kinds = [
      "transcript.partial",
      "transcript.committed",
      "transcript.partial",
      "transcript.committed",
      "transcript.partial",
      "transcript.committed",
      "transcript.partial",
      "transcript.partial",
    ] as const;
    const metric = deriveBufferBoundednessMetric(kinds, 10);
    // Mutation guard: if ephemeral kinds are counted in admittedCount, this fails.
    expect(metric.admittedCount).toBe(3);
    expect(metric.ephemeralBuffered).toBe(false);
    expect(metric.maxObservedLength).toBe(3);
  });

  // ─── KEIKO-0170 — the ephemeralBuffered invariant is independently observable ───
  // Under the default admission (the contract classifier), no ephemeral kind can enter the ring, so
  // ephemeralBuffered is structurally false — that is the invariant the pure model enforces. To PROVE
  // the check has real discriminating power over the ring's contents (and is not just a dead read of
  // the same eligibility function that admitted the entry), a permissive admission override lets
  // ephemeral kinds into the ring; the invariant check then MUST flip TRUE because it reads the ring
  // against the fixed contract classifier, not against the injected admission predicate. If a future
  // regression collapsed the two sources back onto one (e.g., re-reading the admission predicate for
  // the invariant), this test would go GREEN even under a lax admission — the exact structural gap
  // the previous derive suffered from. (Reproduces the mustFailBeforeFix guarantee for KEIKO-0170.)
  it("flips ephemeralBuffered=true when an ephemeral kind is admitted by a lax override", () => {
    const kinds: readonly ["transcript.partial", "transcript.committed"] = [
      "transcript.partial",
      "transcript.committed",
    ];
    // A permissive admission override that admits every kind, simulating a broken admission gate.
    const metric = deriveBufferBoundednessMetric(kinds, 5, () => true);
    // Both kinds enter the ring; the invariant check reads it against isVoiceReplayEligible and finds
    // an ephemeral entry, flipping ephemeralBuffered true.
    expect(metric.admittedCount).toBe(2);
    expect(metric.ephemeralBuffered).toBe(true);
  });

  it("default admission (no override) never buffers an ephemeral kind, even under a large input", () => {
    // Baseline: without the override the ephemeral guard fires as before.
    const kinds = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? ("transcript.partial" as const) : ("transcript.committed" as const),
    );
    const metric = deriveBufferBoundednessMetric(kinds, 12);
    expect(metric.ephemeralBuffered).toBe(false);
    expect(metric.admittedCount).toBe(6);
  });
});

// ─── deriveInterruptionMetric ─────────────────────────────────────────────────
describe("deriveInterruptionMetric", () => {
  // The true/false rows jointly kill a constant return from voicePlaybackInterruptAllowedForProfile.
  it.each([
    {
      title: "returns interruptAllowed=true for full-realtime (interrupt-capable profile)",
      profile: "full-realtime",
      expected: true,
    },
    {
      title: "returns interruptAllowed=true for speech-output (playback-capable profile)",
      profile: "speech-output",
      expected: true,
    },
    {
      title: "returns interruptAllowed=false for none (dormant — no interrupt allowed)",
      profile: "none",
      expected: false,
    },
  ] as const)("$title", ({ profile, expected }) => {
    const metric = deriveInterruptionMetric(profile);
    expect(metric.interruptAllowed).toBe(expected);
    // The transition table is profile-independent; speaking→interrupted still exists structurally.
    expect(metric.interruptedPhaseReachable).toBe(true);
  });

  it("returns interruptAllowed=false for speech-to-text (no playback kinds)", () => {
    const metric = deriveInterruptionMetric("speech-to-text");
    expect(metric.interruptAllowed).toBe(false);
  });
});

// ─── deriveEndOfTurnMetric ────────────────────────────────────────────────────
describe("deriveEndOfTurnMetric", () => {
  it("returns full set of flags for speech-to-text (transcript capture allowed)", () => {
    const metric = deriveEndOfTurnMetric("speech-to-text");
    expect(metric.committedKindAllowed).toBe(true);
    // Mutation guard: if voiceTranscriptCaptureAllowed ignores the profile, none profile would be true.
    expect(metric.captureAllowed).toBe(true);
    expect(metric.committedSegmentCount).toBeGreaterThan(0);
    // Mutation guard: if the partial/stable exclusion check is dropped, excludesUncommitted=false.
    expect(metric.excludesUncommitted).toBe(true);
  });

  it("committedKindAllowed=false and captureAllowed=false for none profile", () => {
    const metric = deriveEndOfTurnMetric("none");
    // Mutation guard: if voiceMessageAllowedForProfile always returns true, this fails.
    expect(metric.committedKindAllowed).toBe(false);
    expect(metric.captureAllowed).toBe(false);
    // Committed projection over an all-uncommitted segment list: partial/stable never enter the
    // committed set, so uncommitted IS excluded (the check fires on the partial/stable ids).
    expect(metric.excludesUncommitted).toBe(true);
  });

  it("committedSegmentCount equals the number of consumable states", () => {
    // The segment builder creates one segment per consumable state, plus one partial + one stable.
    // The committed projection includes only the consumable ones.
    const metric = deriveEndOfTurnMetric("speech-to-text");
    // Mutation guard: if VOICE_TRANSCRIPT_CONSUMABLE_STATES grows/shrinks, this detects drift.
    expect(metric.committedSegmentCount).toBe(VOICE_TRANSCRIPT_CONSUMABLE_STATES.length);
  });
});

// ─── deriveTranscriptCorrectionMetric ─────────────────────────────────────────
describe("deriveTranscriptCorrectionMetric", () => {
  it("stable→corrected transition is allowed by the contract", () => {
    const metric = deriveTranscriptCorrectionMetric();
    // Concrete expectation, NOT a re-read of the contract: the contract MUST allow stable→corrected, so a
    // contract mutation removing that edge flips this RED.
    expect(metric.stableToCorrectedAllowed).toBe(true);
  });

  it("committed→corrected transition is allowed by the contract", () => {
    const metric = deriveTranscriptCorrectionMetric();
    // Concrete expectation: the contract MUST allow committed→corrected (a committed segment can be
    // corrected by a later provider revision).
    expect(metric.committedToCorrectedAllowed).toBe(true);
  });

  it("corrected is in the consumable states", () => {
    const metric = deriveTranscriptCorrectionMetric();
    // Concrete expectation: `corrected` MUST be a consumable transcript state.
    expect(metric.correctedIsConsumable).toBe(true);
  });

  it("superseded committed text is dropped from the committed projection", () => {
    const metric = deriveTranscriptCorrectionMetric();
    // Mutation guard: if selectCommittedVoiceTranscript does not honor supersedesId, the
    // superseded segment remains in the projection → supersededTextDropped=false.
    expect(metric.supersededTextDropped).toBe(true);
  });

  it("is pure and deterministic (two calls return identical results)", () => {
    const a = deriveTranscriptCorrectionMetric();
    const b = deriveTranscriptCorrectionMetric();
    expect(a).toEqual(b);
  });
});

// ─── deriveProviderFailureRecoveryMetric ──────────────────────────────────────
describe("deriveProviderFailureRecoveryMetric", () => {
  it("provider-error is a recognized transcript segment state", () => {
    const metric = deriveProviderFailureRecoveryMetric();
    // Mutation guard: if providerErrorIsState is hardcoded to false, this fails.
    expect(metric.providerErrorIsState).toBe(true);
  });

  it("provider-error is NOT in the consumable states", () => {
    const metric = deriveProviderFailureRecoveryMetric();
    // Concrete expectation: `provider-error` MUST be excluded from the consumable set (a failed segment is
    // reviewable but never reaches a downstream integration). A contract mutation adding it flips this RED.
    expect(metric.providerErrorNotConsumable).toBe(true);
  });

  it("playback failed is a settled phase", () => {
    const metric = deriveProviderFailureRecoveryMetric();
    // Concrete expectation: the playback `failed` phase MUST be settled.
    expect(metric.playbackFailedIsSettled).toBe(true);
  });

  it("a recovery transition from failed exists in the contract (failed→preparing)", () => {
    const metric = deriveProviderFailureRecoveryMetric();
    // Concrete expectation: the contract MUST offer a recovery edge failed→preparing; a mutation removing
    // it flips this RED.
    expect(metric.recoveryTransitionExists).toBe(true);
  });

  it("is pure and deterministic (two calls return identical results)", () => {
    const a = deriveProviderFailureRecoveryMetric();
    const b = deriveProviderFailureRecoveryMetric();
    expect(a).toEqual(b);
  });
});
