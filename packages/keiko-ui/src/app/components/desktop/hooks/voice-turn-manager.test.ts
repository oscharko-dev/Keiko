// Issue #499 (ADR-0062) — the Voice turn manager. Drives the manager with a deterministic SCRIPTED
// clock (an injected `{ now }` advanced by hand — no fake timers, no performance.now) and the semantic
// signal union, exercising the full matrix: capability gating (none / speech-to-text / speech-output /
// full-realtime), the eight-state floor-control machine, barge-in overlap synthesis, the commit-vs-
// detect distinction in STT dictation, provider-failure isolation and recovery, the content-free
// observer (AC4), the media-floor-only effect invariant (AC5), reachability of every state, and reset.

import { describe, expect, it, vi } from "vitest";
import type { VoiceProfile } from "@/lib/types";
import {
  createVoiceTurnManager,
  createBrowserVoiceClock,
  resolutionToVoiceProfile,
  type VoiceClock,
  type VoiceTurnManagerEngine,
  type VoiceTurnManagerObserver,
  type VoiceTurnEffect,
  type VoiceTurnSignal,
  type VoiceTurnState,
} from "./voice-turn-manager";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

// A scripted clock: `now()` returns the next value in the script, then holds the last value once the
// script is exhausted. This makes latencyMs an exact function of the test and proves the manager reads
// no real clock.
function scriptedClock(values: readonly number[]): VoiceClock {
  let index = 0;
  return {
    now(): number {
      const value = values[Math.min(index, values.length - 1)] ?? 0;
      index += 1;
      return value;
    },
  };
}

// A clock that throws if read. A dormant `none`-profile manager must never read it (AC1).
function throwingClock(): VoiceClock {
  return {
    now(): number {
      throw new Error("clock must not be read by a dormant manager");
    },
  };
}

function makeManager(
  profile: VoiceProfile,
  clock?: VoiceClock,
  observer?: VoiceTurnManagerObserver,
): VoiceTurnManagerEngine {
  return createVoiceTurnManager({ profile, ...(clock ? { clock } : {}), observer });
}

// Every effect the manager may emit. AC5: no signal sequence may ever produce an effect outside this
// media-floor set; there is no execute / workflow / command-authority effect.
const MEDIA_FLOOR_EFFECTS: readonly VoiceTurnEffect[] = [
  "stop-playback",
  "cancel-speech-generation",
  "preserve-user-turn",
  "emit-backchannel",
  "begin-recovery",
];

// ─── AC1: none profile is dormant ───────────────────────────────────────────────
describe("voice-turn-manager — dormant profile (AC1)", () => {
  it("constructs disabled with active=false and floor none", () => {
    const snapshot = makeManager("none").snapshot();
    expect(snapshot.state).toBe("disabled");
    expect(snapshot.active).toBe(false);
    expect(snapshot.floorHolder).toBe("none");
    expect(snapshot.turnIndex).toBe(0);
  });

  it("rejects every signal, never reads the clock, never calls the observer", () => {
    const observer: VoiceTurnManagerObserver = {
      onTransition: vi.fn(),
      onInterrupt: vi.fn(),
      onBackchannel: vi.fn(),
      onEffect: vi.fn(),
    };
    const manager = makeManager("none", throwingClock(), observer);

    const everySignal: readonly VoiceTurnSignal[] = [
      { kind: "user-speech-start" },
      { kind: "user-end-of-turn" },
      { kind: "dictation-commit" },
      { kind: "dictation-discard" },
      { kind: "assistant-speech-start" },
      { kind: "assistant-speech-end", how: "completed" },
      { kind: "user-interrupt", atMs: 5 },
      { kind: "backchannel" },
      { kind: "provider-failure", recoverable: true },
      { kind: "permission-denied" },
      { kind: "recovered" },
      { kind: "session-closed" },
    ];

    for (const signal of everySignal) {
      const result = manager.apply(signal);
      expect(result.outcome).toBe("not-allowed-for-profile");
      expect(result.effects).toEqual([]);
      expect(result.snapshot.active).toBe(false);
    }
    expect(observer.onTransition).not.toHaveBeenCalled();
    expect(observer.onInterrupt).not.toHaveBeenCalled();
    expect(observer.onBackchannel).not.toHaveBeenCalled();
    expect(observer.onEffect).not.toHaveBeenCalled();
  });
});

// ─── Fixture 1: overlap (barge-in synthesis fires onTransition twice in one apply) ──
describe("voice-turn-manager — overlap barge-in synthesis (AC3)", () => {
  it("user-speech-start while speaking synthesizes interrupt then listening in one apply", () => {
    const observer: VoiceTurnManagerObserver = { onTransition: vi.fn(), onInterrupt: vi.fn() };
    const manager = makeManager("full-realtime", scriptedClock([10, 20, 30]), observer);

    manager.apply({ kind: "assistant-speech-start" }); // idle -> speaking
    const onTransition = observer.onTransition as ReturnType<typeof vi.fn>;
    onTransition.mockClear();

    const result = manager.apply({ kind: "user-speech-start" });

    expect(result.outcome).toBe("transitioned");
    // The interrupt step emits the full set including the AC3 preserve-user-turn reinforcement.
    expect(result.effects).toEqual([
      "stop-playback",
      "cancel-speech-generation",
      "preserve-user-turn",
    ]);
    expect(result.snapshot.state).toBe("listening");
    expect(result.snapshot.floorHolder).toBe("user");
    expect(result.snapshot.interruptions).toBe(1);
    // onTransition fires twice within one apply: speaking->interrupted, then interrupted->listening.
    expect(onTransition).toHaveBeenCalledTimes(2);
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({ from: "speaking", to: "interrupted" });
    expect(onTransition.mock.calls[1]?.[0]).toMatchObject({ from: "interrupted", to: "listening" });
  });
});

// ─── Fixture 2: silence — full two round-trips ──────────────────────────────────
describe("voice-turn-manager — silence round-trip (AC3)", () => {
  it("idle -> listening -> thinking -> speaking -> yielding -> listening twice", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    expect(manager.apply({ kind: "user-speech-start" }).snapshot.state).toBe("listening");
    expect(manager.apply({ kind: "user-end-of-turn" }).snapshot.state).toBe("thinking");
    expect(manager.apply({ kind: "assistant-speech-start" }).snapshot.state).toBe("speaking");
    const yielded = manager.apply({ kind: "assistant-speech-end", how: "completed" });
    expect(yielded.snapshot.state).toBe("yielding");
    expect(yielded.snapshot.floorHolder).toBe("none");

    // Second round-trip: user takes the floor during the handoff window.
    expect(manager.apply({ kind: "user-speech-start" }).snapshot.state).toBe("listening");
    const secondEnd = manager.apply({ kind: "user-end-of-turn" });
    expect(secondEnd.snapshot.state).toBe("thinking");
    expect(secondEnd.snapshot.turnIndex).toBe(2);
  });
});

// ─── Fixture 3: fast interrupt within the same clock tick ────────────────────────
describe("voice-turn-manager — fast interrupt same tick (AC3)", () => {
  it("user-interrupt during speaking emits both stop effects; then user-speech-start -> listening", () => {
    // Held clock value: every read returns 50, so the interrupt and the next start share one tick.
    const manager = makeManager("full-realtime", scriptedClock([50]));

    manager.apply({ kind: "assistant-speech-start" });
    const interrupted = manager.apply({ kind: "user-interrupt", atMs: 12 });

    expect(interrupted.snapshot.state).toBe("interrupted");
    expect(interrupted.effects).toEqual([
      "stop-playback",
      "cancel-speech-generation",
      "preserve-user-turn",
    ]);
    expect(interrupted.snapshot.interruptions).toBe(1);
    expect(interrupted.snapshot.lastInterruptAtMs).toBe(50);

    const listening = manager.apply({ kind: "user-speech-start" });
    expect(listening.snapshot.state).toBe("listening");
  });
});

// ─── Fixture 4: delayed transcript — turnIndex dedup anchor ──────────────────────
describe("voice-turn-manager — delayed transcript dedup (AC4)", () => {
  it("turnIndex advances on each end-of-turn and is reported on the snapshot and onTransition", () => {
    const observer: VoiceTurnManagerObserver = { onTransition: vi.fn() };
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3, 4, 5, 6]), observer);

    manager.apply({ kind: "user-speech-start" });
    const first = manager.apply({ kind: "user-end-of-turn" });
    expect(first.snapshot.turnIndex).toBe(1);

    manager.apply({ kind: "assistant-speech-start" });
    manager.apply({ kind: "assistant-speech-end", how: "completed" });
    manager.apply({ kind: "user-speech-start" });
    const second = manager.apply({ kind: "user-end-of-turn" });
    expect(second.snapshot.turnIndex).toBe(2);

    const onTransition = observer.onTransition as ReturnType<typeof vi.fn>;
    const endOfTurnEvents = onTransition.mock.calls
      .map((call) => call[0])
      .filter((event) => event.trigger === "user-end-of-turn");
    expect(endOfTurnEvents.map((event) => event.turnIndex)).toEqual([1, 2]);
  });
});

// ─── Fixture 5: provider-cancellation-failure path ──────────────────────────────
describe("voice-turn-manager — provider cancellation failure & recovery (AC5)", () => {
  it("interrupt emits cancel-speech-generation; recoverable failure -> recovering -> idle, interruptions kept", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3, 4]));

    manager.apply({ kind: "assistant-speech-start" });
    const interrupted = manager.apply({ kind: "user-interrupt" });
    expect(interrupted.effects).toContain("cancel-speech-generation");
    expect(interrupted.snapshot.state).toBe("interrupted");
    expect(interrupted.snapshot.interruptions).toBe(1);

    // Failure arrives before any assistant-speech-end; state goes interrupted -> recovering.
    const recovering = manager.apply({ kind: "provider-failure", recoverable: true });
    expect(recovering.snapshot.state).toBe("recovering");
    expect(recovering.snapshot.recovering).toBe(true);
    expect(recovering.effects).toEqual(["begin-recovery"]);

    const recovered = manager.apply({ kind: "recovered" });
    expect(recovered.snapshot.state).toBe("idle");
    // interruptions is preserved across recovery (D7).
    expect(recovered.snapshot.interruptions).toBe(1);
  });

  it("non-recoverable failure is terminal (disabled)", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2]));
    manager.apply({ kind: "assistant-speech-start" });
    const dead = manager.apply({ kind: "provider-failure", recoverable: false });
    expect(dead.snapshot.state).toBe("disabled");
    expect(dead.snapshot.active).toBe(false);
  });
});

// ─── Fixture 6: STT commit-vs-detect (the gating refinement, AC2) ───────────────
describe("voice-turn-manager — speech-to-text commit vs detect (AC2)", () => {
  it("user-speech-start admitted via transcript capture; end-of-turn sets pendingCommit without turnIndex++", () => {
    const manager = makeManager("speech-to-text", scriptedClock([1, 2, 3]));

    const listening = manager.apply({ kind: "user-speech-start" });
    expect(listening.outcome).toBe("transitioned");
    expect(listening.snapshot.state).toBe("listening");

    const detected = manager.apply({ kind: "user-end-of-turn" });
    expect(detected.snapshot.state).toBe("idle");
    expect(detected.snapshot.pendingCommit).toBe(true);
    expect(detected.snapshot.turnIndex).toBe(0);
  });

  it("dictation-commit sends the turn: pendingCommit=false, turnIndex=1", () => {
    const manager = makeManager("speech-to-text", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });

    const committed = manager.apply({ kind: "dictation-commit" });
    expect(committed.snapshot.pendingCommit).toBe(false);
    expect(committed.snapshot.turnIndex).toBe(1);
    expect(committed.snapshot.state).toBe("idle");
  });

  it("dictation-discard drops the turn: pendingCommit=false, turnIndex unchanged", () => {
    const manager = makeManager("speech-to-text", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });

    const discarded = manager.apply({ kind: "dictation-discard" });
    expect(discarded.snapshot.pendingCommit).toBe(false);
    expect(discarded.snapshot.turnIndex).toBe(0);
    expect(discarded.snapshot.state).toBe("idle");
  });

  it("rejects assistant-speech, interrupt, and backchannel; never leaves idle/listening", () => {
    const manager = makeManager("speech-to-text", scriptedClock([1, 2, 3, 4]));

    expect(manager.apply({ kind: "assistant-speech-start" }).outcome).toBe(
      "not-allowed-for-profile",
    );
    expect(manager.apply({ kind: "user-interrupt" }).outcome).toBe("not-allowed-for-profile");
    expect(manager.apply({ kind: "backchannel" }).outcome).toBe("not-allowed-for-profile");

    const snapshot = manager.snapshot();
    expect(snapshot.state).toBe("idle");
    expect(snapshot.turnIndex).toBe(0);

    manager.apply({ kind: "user-speech-start" });
    expect(manager.snapshot().state).toBe("listening");
  });

  it("dictation-commit with nothing pending is a no-op", () => {
    const manager = makeManager("speech-to-text", scriptedClock([1]));
    const result = manager.apply({ kind: "dictation-commit" });
    expect(result.outcome).toBe("no-op");
    expect(result.snapshot.turnIndex).toBe(0);
  });

  // The symmetric guard for dictation-discard: with nothing pending it must NOT fire a transition. The
  // outcome / effects / turnIndex are identical whether or not the `pendingCommit` guard is present
  // (idle -> idle changes nothing), so only an observer assertion proves the guard short-circuits — this
  // kills the mutation that drops the `pendingCommit` check and would otherwise emit a spurious
  // idle -> idle transition.
  it("dictation-discard with nothing pending is a no-op and fires no transition", () => {
    const observer: VoiceTurnManagerObserver = { onTransition: vi.fn() };
    const manager = makeManager("speech-to-text", scriptedClock([1]), observer);
    const result = manager.apply({ kind: "dictation-discard" });
    expect(result.outcome).toBe("no-op");
    expect(result.effects).toEqual([]);
    expect(result.snapshot.state).toBe("idle");
    expect(result.snapshot.pendingCommit).toBe(false);
    expect(result.snapshot.turnIndex).toBe(0);
    const onTransition = observer.onTransition as ReturnType<typeof vi.fn>;
    expect(onTransition).not.toHaveBeenCalled();
  });
});

// ─── Fixture 7: none-profile dormant (covered above) — reachability for completeness ──
describe("voice-turn-manager — none dormant reset (AC1)", () => {
  it("reset on a none manager stays disabled", () => {
    const manager = makeManager("none");
    manager.reset();
    expect(manager.snapshot().state).toBe("disabled");
    expect(manager.snapshot().active).toBe(false);
  });
});

// ─── Fixture 8: backchannel never changes floor or state ─────────────────────────
describe("voice-turn-manager — backchannel no floor change (AC3)", () => {
  it("backchannel during speaking keeps state speaking, floor assistant, increments counter", () => {
    const observer: VoiceTurnManagerObserver = { onBackchannel: vi.fn() };
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]), observer);

    manager.apply({ kind: "assistant-speech-start" });
    const result = manager.apply({ kind: "backchannel" });

    expect(result.snapshot.state).toBe("speaking");
    expect(result.snapshot.floorHolder).toBe("assistant");
    expect(result.snapshot.backchannels).toBe(1);
    expect(result.effects).toEqual(["emit-backchannel"]);
    const onBackchannel = observer.onBackchannel as ReturnType<typeof vi.fn>;
    expect(onBackchannel).toHaveBeenCalledTimes(1);
    expect(onBackchannel.mock.calls[0]?.[0]).toMatchObject({ state: "speaking", backchannels: 1 });
  });

  // ADR-0062 D6 specifies backchannel from *(any active state)* with no state change. Asserting it in a
  // non-speaking active state (idle, the fresh full-realtime state) proves the handler is state-blind and
  // kills a mutation that would gate the acknowledgement to `speaking` only.
  it("backchannel in a non-speaking active state (idle) still acknowledges without a floor change", () => {
    const manager = makeManager("full-realtime", scriptedClock([1]));
    const result = manager.apply({ kind: "backchannel" });
    expect(result.outcome).toBe("transitioned");
    expect(result.snapshot.state).toBe("idle");
    expect(result.snapshot.floorHolder).toBe("none");
    expect(result.snapshot.backchannels).toBe(1);
    expect(result.effects).toEqual(["emit-backchannel"]);
  });
});

// ─── full-realtime: dictation rejected; pendingCommit stays false ────────────────
describe("voice-turn-manager — full-realtime rejects manual commit (AC3)", () => {
  it("dictation-commit / dictation-discard are not allowed; pendingCommit false through a round-trip", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3, 4, 5]));

    expect(manager.apply({ kind: "dictation-commit" }).outcome).toBe("not-allowed-for-profile");
    expect(manager.apply({ kind: "dictation-discard" }).outcome).toBe("not-allowed-for-profile");

    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });
    manager.apply({ kind: "assistant-speech-start" });
    const ended = manager.apply({ kind: "assistant-speech-end", how: "completed" });
    expect(ended.snapshot.pendingCommit).toBe(false);
  });
});

// ─── speech-output: asymmetric floor ─────────────────────────────────────────────
describe("voice-turn-manager — speech-output asymmetric floor (D5)", () => {
  it("rejects user-speech-start / user-end-of-turn; admits assistant-speech and interrupt", () => {
    const manager = makeManager("speech-output", scriptedClock([1, 2, 3, 4]));

    expect(manager.apply({ kind: "user-speech-start" }).outcome).toBe("not-allowed-for-profile");
    expect(manager.apply({ kind: "user-end-of-turn" }).outcome).toBe("not-allowed-for-profile");
    // backchannel needs floorControl (media) AND playback; speech-output lacks media -> rejected.
    expect(manager.apply({ kind: "backchannel" }).outcome).toBe("not-allowed-for-profile");

    const speaking = manager.apply({ kind: "assistant-speech-start" });
    expect(speaking.snapshot.state).toBe("speaking");

    const interrupted = manager.apply({ kind: "user-interrupt", atMs: 7 });
    expect(interrupted.snapshot.state).toBe("interrupted");
    expect(interrupted.effects).toContain("stop-playback");
  });
});

// ─── D6 remaining transition rows ────────────────────────────────────────────────
describe("voice-turn-manager — transition table rows (D6)", () => {
  it("assistant-speech-end(stopped) from speaking -> interrupted", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2]));
    manager.apply({ kind: "assistant-speech-start" });
    const stopped = manager.apply({ kind: "assistant-speech-end", how: "stopped" });
    expect(stopped.snapshot.state).toBe("interrupted");
  });

  it("assistant-speech-end(completed) from thinking -> idle (cancelled before speech)", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });
    const cancelled = manager.apply({ kind: "assistant-speech-end", how: "completed" });
    expect(cancelled.snapshot.state).toBe("idle");
  });

  it("assistant-speech-end(completed) outside speaking/thinking is a no-op", () => {
    const manager = makeManager("full-realtime", scriptedClock([1]));
    const noop = manager.apply({ kind: "assistant-speech-end", how: "completed" });
    expect(noop.outcome).toBe("no-op");
    expect(noop.snapshot.state).toBe("idle");
  });

  it("assistant-speech-end(stopped) from thinking -> idle", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });
    const cancelled = manager.apply({ kind: "assistant-speech-end", how: "stopped" });
    expect(cancelled.snapshot.state).toBe("idle");
  });

  it("assistant-speech-end(stopped) from interrupted is a no-op", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "assistant-speech-start" });
    manager.apply({ kind: "user-interrupt" });
    const noop = manager.apply({ kind: "assistant-speech-end", how: "stopped" });
    expect(noop.outcome).toBe("no-op");
    expect(noop.snapshot.state).toBe("interrupted");
  });

  it("user-interrupt from thinking emits only cancel-speech-generation", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });
    const interrupted = manager.apply({ kind: "user-interrupt" });
    expect(interrupted.snapshot.state).toBe("interrupted");
    expect(interrupted.effects).toEqual(["cancel-speech-generation"]);
  });

  it("user-interrupt from yielding collapses to idle, counts the interruption", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "assistant-speech-start" });
    manager.apply({ kind: "assistant-speech-end", how: "completed" });
    const collapsed = manager.apply({ kind: "user-interrupt" });
    expect(collapsed.snapshot.state).toBe("idle");
    expect(collapsed.snapshot.interruptions).toBe(1);
    expect(collapsed.effects).toEqual([]);
  });

  it("user-interrupt from idle and from listening are no-ops", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    const idleInterrupt = manager.apply({ kind: "user-interrupt" });
    expect(idleInterrupt.outcome).toBe("no-op");
    expect(idleInterrupt.snapshot.state).toBe("idle");

    manager.apply({ kind: "user-speech-start" });
    const listeningInterrupt = manager.apply({ kind: "user-interrupt" });
    expect(listeningInterrupt.outcome).toBe("no-op");
    expect(listeningInterrupt.snapshot.state).toBe("listening");
  });

  it("user-interrupt from recovering is a no-op (floor unoccupied during reconnect)", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2]));
    manager.apply({ kind: "provider-failure", recoverable: true });
    const noop = manager.apply({ kind: "user-interrupt" });
    expect(noop.outcome).toBe("no-op");
    expect(noop.snapshot.state).toBe("recovering");
    expect(noop.snapshot.interruptions).toBe(0);
  });

  it("re-interrupt from interrupted emits stop-playback and counts again", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "assistant-speech-start" });
    manager.apply({ kind: "user-interrupt" });
    const reInterrupt = manager.apply({ kind: "user-interrupt" });
    expect(reInterrupt.snapshot.state).toBe("interrupted");
    expect(reInterrupt.effects).toEqual(["stop-playback"]);
    expect(reInterrupt.snapshot.interruptions).toBe(2);
  });

  it("user-speech-start from yielding, interrupted, and recovering -> listening", () => {
    const fromYielding = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    fromYielding.apply({ kind: "assistant-speech-start" });
    fromYielding.apply({ kind: "assistant-speech-end", how: "completed" });
    expect(fromYielding.apply({ kind: "user-speech-start" }).snapshot.state).toBe("listening");

    const fromInterrupted = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    fromInterrupted.apply({ kind: "assistant-speech-start" });
    fromInterrupted.apply({ kind: "assistant-speech-end", how: "stopped" });
    expect(fromInterrupted.apply({ kind: "user-speech-start" }).snapshot.state).toBe("listening");

    const fromRecovering = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    fromRecovering.apply({ kind: "provider-failure", recoverable: true });
    expect(fromRecovering.apply({ kind: "user-speech-start" }).snapshot.state).toBe("listening");
  });

  it("user-speech-start from thinking preserves the user turn", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });
    const overlap = manager.apply({ kind: "user-speech-start" });
    expect(overlap.snapshot.state).toBe("listening");
    expect(overlap.effects).toEqual(["preserve-user-turn"]);
  });

  it("duplicate user-speech-start while listening is a no-op", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2]));
    manager.apply({ kind: "user-speech-start" });
    const dup = manager.apply({ kind: "user-speech-start" });
    expect(dup.outcome).toBe("no-op");
    expect(dup.snapshot.state).toBe("listening");
  });

  it("assistant-speech-start from idle and resumed-from-interrupted -> speaking", () => {
    const fromIdle = makeManager("full-realtime", scriptedClock([1]));
    expect(fromIdle.apply({ kind: "assistant-speech-start" }).snapshot.state).toBe("speaking");

    const resumed = makeManager("full-realtime", scriptedClock([1, 2, 3]));
    resumed.apply({ kind: "assistant-speech-start" });
    resumed.apply({ kind: "user-interrupt" });
    expect(resumed.apply({ kind: "assistant-speech-start" }).snapshot.state).toBe("speaking");
  });

  it("duplicate assistant-speech-start while speaking is a no-op", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2]));
    manager.apply({ kind: "assistant-speech-start" });
    const dup = manager.apply({ kind: "assistant-speech-start" });
    expect(dup.outcome).toBe("no-op");
    expect(dup.snapshot.state).toBe("speaking");
  });

  it("user-end-of-turn outside listening is a no-op", () => {
    const manager = makeManager("full-realtime", scriptedClock([1]));
    const noop = manager.apply({ kind: "user-end-of-turn" });
    expect(noop.outcome).toBe("no-op");
    expect(noop.snapshot.state).toBe("idle");
  });

  it("permission-denied and session-closed are terminal from an active state", () => {
    const denied = makeManager("full-realtime", scriptedClock([1, 2]));
    denied.apply({ kind: "user-speech-start" });
    expect(denied.apply({ kind: "permission-denied" }).snapshot.state).toBe("disabled");

    const closed = makeManager("full-realtime", scriptedClock([1, 2]));
    closed.apply({ kind: "assistant-speech-start" });
    expect(closed.apply({ kind: "session-closed" }).snapshot.state).toBe("disabled");
  });

  it("recovered outside recovering is a no-op", () => {
    const manager = makeManager("full-realtime", scriptedClock([1]));
    const noop = manager.apply({ kind: "recovered" });
    expect(noop.outcome).toBe("no-op");
    expect(noop.snapshot.state).toBe("idle");
  });

  it("any signal after disabled is rejected without reading the clock", () => {
    const manager = makeManager("full-realtime", scriptedClock([1]));
    manager.apply({ kind: "session-closed" });
    const afterClose = manager.apply({ kind: "user-speech-start" });
    expect(afterClose.outcome).toBe("not-allowed-for-profile");
    expect(afterClose.snapshot.state).toBe("disabled");
  });
});

// ─── Every state reachable ───────────────────────────────────────────────────────
describe("voice-turn-manager — every state reachable", () => {
  it("reaches all eight states across the profiles", () => {
    const seen = new Set<VoiceTurnState>();
    seen.add(makeManager("none").snapshot().state); // disabled
    const m = makeManager("full-realtime", scriptedClock([1, 2, 3, 4, 5, 6, 7, 8]));
    seen.add(m.snapshot().state); // idle
    seen.add(m.apply({ kind: "user-speech-start" }).snapshot.state); // listening
    seen.add(m.apply({ kind: "user-end-of-turn" }).snapshot.state); // thinking
    seen.add(m.apply({ kind: "assistant-speech-start" }).snapshot.state); // speaking
    seen.add(m.apply({ kind: "assistant-speech-end", how: "completed" }).snapshot.state); // yielding
    const m2 = makeManager("full-realtime", scriptedClock([1, 2]));
    m2.apply({ kind: "assistant-speech-start" });
    seen.add(m2.apply({ kind: "user-interrupt" }).snapshot.state); // interrupted
    const m3 = makeManager("full-realtime", scriptedClock([1]));
    seen.add(m3.apply({ kind: "provider-failure", recoverable: true }).snapshot.state); // recovering

    expect([...seen].sort()).toEqual(
      [
        "disabled",
        "idle",
        "interrupted",
        "listening",
        "recovering",
        "speaking",
        "thinking",
        "yielding",
      ].sort(),
    );
  });
});

// ─── AC5: media-floor effect invariant ───────────────────────────────────────────
describe("voice-turn-manager — media-floor effect invariant (AC5)", () => {
  it("no signal sequence ever emits an effect outside the media-floor union", () => {
    const collected: VoiceTurnEffect[] = [];
    const profiles: readonly VoiceProfile[] = ["speech-to-text", "speech-output", "full-realtime"];
    const signals: readonly VoiceTurnSignal[] = [
      { kind: "user-speech-start" },
      { kind: "user-end-of-turn" },
      { kind: "dictation-commit" },
      { kind: "dictation-discard" },
      { kind: "assistant-speech-start" },
      { kind: "assistant-speech-end", how: "completed" },
      { kind: "assistant-speech-end", how: "stopped" },
      { kind: "user-interrupt", atMs: 1 },
      { kind: "backchannel" },
      { kind: "provider-failure", recoverable: true },
      { kind: "recovered" },
      { kind: "user-speech-start" },
      { kind: "assistant-speech-start" },
      { kind: "user-interrupt" },
    ];

    for (const profile of profiles) {
      const manager = makeManager(profile, scriptedClock([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
      for (const signal of signals) {
        collected.push(...manager.apply(signal).effects);
      }
    }

    for (const effect of collected) {
      expect(MEDIA_FLOOR_EFFECTS).toContain(effect);
    }
    // The sequence actually exercised effects, so the invariant is non-vacuous.
    expect(collected.length).toBeGreaterThan(0);
  });
});

// ─── AC4: content-free observer ──────────────────────────────────────────────────
describe("voice-turn-manager — content-free observer (AC4)", () => {
  it("observer events carry only enum / integer / ms fields, never content", () => {
    const transitions: unknown[] = [];
    const interrupts: unknown[] = [];
    const backchannels: unknown[] = [];
    const effects: unknown[] = [];
    const observer: VoiceTurnManagerObserver = {
      onTransition: (event) => transitions.push(event),
      onInterrupt: (event) => interrupts.push(event),
      onBackchannel: (event) => backchannels.push(event),
      onEffect: (event) => effects.push(event),
    };
    const manager = makeManager("full-realtime", scriptedClock([10, 40, 90]), observer);

    manager.apply({ kind: "assistant-speech-start" });
    manager.apply({ kind: "backchannel" });
    manager.apply({ kind: "user-speech-start" }); // synthesized barge-in

    const allArgs = [...transitions, ...interrupts, ...backchannels, ...effects];
    const serialized = JSON.stringify(allArgs);
    // No transcript / audio / SDP key could be present; assert the field whitelist instead.
    const allowedKeys = new Set([
      "from",
      "to",
      "trigger",
      "floorHolder",
      "turnIndex",
      "latencyMs",
      "state",
      "atMs",
      "interruptions",
      "backchannels",
      "effect",
    ]);
    for (const arg of allArgs) {
      for (const key of Object.keys(arg as Record<string, unknown>)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
    expect(serialized).not.toContain("text");
    expect(serialized).not.toContain("sdp");
    expect(serialized).not.toContain("audio");
  });

  it("latencyMs is the clock delta since the previous transition; 0 for the first", () => {
    const transitions: { latencyMs: number }[] = [];
    const observer: VoiceTurnManagerObserver = {
      onTransition: (event) => transitions.push({ latencyMs: event.latencyMs }),
    };
    // Clock readings 10, 40, 90 -> transition deltas 0, 30, 50.
    const manager = makeManager("full-realtime", scriptedClock([10, 40, 90]), observer);

    manager.apply({ kind: "user-speech-start" });
    manager.apply({ kind: "user-end-of-turn" });
    manager.apply({ kind: "assistant-speech-start" });

    expect(transitions.map((event) => event.latencyMs)).toEqual([0, 30, 50]);
  });
});

// ─── Reset & adapters ────────────────────────────────────────────────────────────
describe("voice-turn-manager — reset & determinism", () => {
  it("reset restores the fresh state and clears counters", () => {
    const manager = makeManager("full-realtime", scriptedClock([1, 2, 3, 4]));
    manager.apply({ kind: "assistant-speech-start" });
    manager.apply({ kind: "user-interrupt" });
    expect(manager.snapshot().interruptions).toBe(1);

    manager.reset();

    const snapshot = manager.snapshot();
    expect(snapshot.state).toBe("idle");
    expect(snapshot.interruptions).toBe(0);
    expect(snapshot.turnIndex).toBe(0);
    expect(snapshot.backchannels).toBe(0);
    expect(snapshot.pendingCommit).toBe(false);
  });

  it("re-exports resolutionToVoiceProfile and a browser clock", () => {
    expect(resolutionToVoiceProfile(undefined)).toBe("none");
    const clock = createBrowserVoiceClock();
    const first = clock.now();
    const second = clock.now();
    expect(typeof first).toBe("number");
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
