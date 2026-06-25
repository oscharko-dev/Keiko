import { describe, expect, it, vi } from "vitest";

import type { VoiceProfile } from "@/lib/types";
import type { VoiceClock } from "./voice-timebase";
import { createVoiceTurnManager } from "./voice-turn-manager";
import {
  type VoicePlaybackController,
  type VoicePlaybackObserver,
  createVoicePlaybackController,
  forwardVoicePlaybackToTurnManager,
  voicePlaybackEffectToTurnSignal,
} from "./voice-playback-state";

// A deterministic, manually advanced clock so latency deltas are asserted exactly (no real time).
function controllableClock(start = 0): VoiceClock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function speechOutputController(
  overrides: Partial<Parameters<typeof createVoicePlaybackController>[0]> = {},
): VoicePlaybackController {
  return createVoicePlaybackController({ profile: "speech-output", ...overrides });
}

// Drive a capable controller all the way to `speaking` for tests that start from live audio.
function toSpeaking(controller: VoicePlaybackController): void {
  controller.dispatch({ kind: "prepare" });
  controller.dispatch({ kind: "play-started" });
}

describe("dormancy — no playback capability (AC1)", () => {
  const dormantProfiles: readonly VoiceProfile[] = ["none", "speech-to-text"];

  for (const profile of dormantProfiles) {
    it(`${profile}: rejects every command and stays unavailable`, () => {
      const observer: VoicePlaybackObserver = {
        onTransition: vi.fn(),
        onInterrupt: vi.fn(),
        onEffect: vi.fn(),
      };
      const controller = createVoicePlaybackController({ profile, observer });
      expect(controller.snapshot().available).toBe(false);

      for (const command of [
        { kind: "prepare" } as const,
        { kind: "play-started" } as const,
        { kind: "interrupt", atMs: 10 } as const,
        { kind: "stop" } as const,
        { kind: "set-muted", muted: true } as const,
        { kind: "replay" } as const,
      ]) {
        const result = controller.dispatch(command);
        expect(result.outcome).toBe("not-allowed-for-profile");
        expect(result.effects).toEqual([]);
      }
      expect(controller.snapshot().phase).toBe("unavailable");
      // A dormant controller is content-free and silent: no clock read, no observer callback ever fired.
      expect(observer.onTransition).not.toHaveBeenCalled();
      expect(observer.onInterrupt).not.toHaveBeenCalled();
      expect(observer.onEffect).not.toHaveBeenCalled();
    });
  }
});

describe("capable lifecycle (speech-output / full-realtime)", () => {
  it("arms, speaks, and completes a turn", () => {
    const clock = controllableClock();
    const controller = speechOutputController({ clock });
    expect(controller.snapshot().phase).toBe("unavailable");

    const prepared = controller.dispatch({ kind: "prepare" });
    expect(prepared.outcome).toBe("transitioned");
    expect(prepared.snapshot.phase).toBe("preparing");
    expect(prepared.effects).toEqual(["request-synthesis"]);
    expect(prepared.snapshot.wireState).toBe("idle");

    clock.advance(40);
    const speaking = controller.dispatch({ kind: "play-started" });
    expect(speaking.snapshot.phase).toBe("speaking");
    expect(speaking.snapshot.speaking).toBe(true);
    expect(speaking.snapshot.spoke).toBe(true);
    expect(speaking.snapshot.wireState).toBe("playing");
    expect(speaking.effects).toEqual(["start-output", "notify-turn-speech-start"]);

    const completed = controller.dispatch({ kind: "complete" });
    expect(completed.snapshot.phase).toBe("complete");
    expect(completed.snapshot.settled).toBe(true);
    expect(completed.effects).toEqual(["notify-turn-speech-completed"]);
    expect(completed.snapshot.wireState).toBe("idle");
  });

  it("pauses and resumes", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    const paused = controller.dispatch({ kind: "pause" });
    expect(paused.snapshot.phase).toBe("paused");
    expect(paused.snapshot.paused).toBe(true);
    expect(paused.effects).toEqual(["pause-output"]);
    expect(paused.snapshot.wireState).toBe("paused");

    const resumed = controller.dispatch({ kind: "resume" });
    expect(resumed.snapshot.phase).toBe("speaking");
    expect(resumed.effects).toEqual(["resume-output"]);
  });

  it("full-realtime profile also arms playback", () => {
    const controller = createVoicePlaybackController({ profile: "full-realtime" });
    expect(controller.snapshot().available).toBe(true);
    expect(controller.dispatch({ kind: "prepare" }).snapshot.phase).toBe("preparing");
  });

  it("treats out-of-phase commands as no-ops without transitioning", () => {
    const controller = speechOutputController();
    // play-started before prepare is a no-op.
    const early = controller.dispatch({ kind: "play-started" });
    expect(early.outcome).toBe("no-op");
    expect(early.snapshot.phase).toBe("unavailable");
    // prepare while already preparing/speaking is a no-op.
    controller.dispatch({ kind: "prepare" });
    const again = controller.dispatch({ kind: "prepare" });
    expect(again.outcome).toBe("no-op");
    expect(again.effects).toEqual([]);
  });
});

describe("interruption (AC2)", () => {
  it("interrupts live audio, counts the barge-in, and emits the turn-notify effect", () => {
    const onInterrupt = vi.fn();
    const controller = speechOutputController({ observer: { onInterrupt } });
    toSpeaking(controller);

    const interrupted = controller.dispatch({ kind: "interrupt", atMs: 1200 });
    expect(interrupted.outcome).toBe("transitioned");
    expect(interrupted.snapshot.phase).toBe("interrupted");
    expect(interrupted.snapshot.interruptions).toBe(1);
    expect(interrupted.snapshot.lastInterruptAtMs).toBe(1200);
    expect(interrupted.snapshot.wireState).toBe("interrupted");
    expect(interrupted.effects).toEqual(["stop-output", "notify-turn-interrupt"]);
    expect(onInterrupt).toHaveBeenCalledWith({
      phase: "interrupted",
      atMs: 1200,
      interruptions: 1,
    });
  });

  it("can interrupt a paused turn", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    controller.dispatch({ kind: "pause" });
    const interrupted = controller.dispatch({ kind: "interrupt" });
    expect(interrupted.snapshot.phase).toBe("interrupted");
    expect(interrupted.snapshot.lastInterruptAtMs).toBeUndefined();
  });

  it("interrupting when nothing is playing is a no-op", () => {
    const controller = speechOutputController();
    const result = controller.dispatch({ kind: "interrupt", atMs: 5 });
    expect(result.outcome).toBe("no-op");
    expect(result.snapshot.phase).toBe("unavailable");
    expect(result.snapshot.interruptions).toBe(0);
  });

  it("forwards the interruption to the #499 turn manager so it receives the state change (AC2)", () => {
    const playback = speechOutputController();
    const turn = createVoiceTurnManager({ profile: "speech-output" });
    expect(turn.snapshot().state).toBe("idle");

    // Assistant starts speaking → the turn manager hears it and takes the floor.
    playback.dispatch({ kind: "prepare" });
    forwardVoicePlaybackToTurnManager(playback.dispatch({ kind: "play-started" }), turn);
    expect(turn.snapshot().state).toBe("speaking");
    expect(turn.snapshot().floorHolder).toBe("assistant");

    // User barge-in → the turn manager transitions to interrupted and counts it (AC2).
    forwardVoicePlaybackToTurnManager(playback.dispatch({ kind: "interrupt", atMs: 800 }), turn);
    expect(turn.snapshot().state).toBe("interrupted");
    expect(turn.snapshot().interruptions).toBe(1);
  });

  it("forwards a natural completion to the turn manager as a cooperative end", () => {
    const playback = speechOutputController();
    const turn = createVoiceTurnManager({ profile: "speech-output" });
    playback.dispatch({ kind: "prepare" });
    forwardVoicePlaybackToTurnManager(playback.dispatch({ kind: "play-started" }), turn);
    forwardVoicePlaybackToTurnManager(playback.dispatch({ kind: "complete" }), turn);
    expect(turn.snapshot().state).toBe("yielding");
  });
});

describe("voicePlaybackEffectToTurnSignal", () => {
  it("maps the notify-turn effects and ignores media effects", () => {
    expect(voicePlaybackEffectToTurnSignal("notify-turn-speech-start")).toEqual({
      kind: "assistant-speech-start",
    });
    expect(voicePlaybackEffectToTurnSignal("notify-turn-speech-completed")).toEqual({
      kind: "assistant-speech-end",
      how: "completed",
    });
    expect(voicePlaybackEffectToTurnSignal("notify-turn-speech-stopped")).toEqual({
      kind: "assistant-speech-end",
      how: "stopped",
    });
    expect(voicePlaybackEffectToTurnSignal("notify-turn-interrupt", 42)).toEqual({
      kind: "user-interrupt",
      atMs: 42,
    });
    for (const media of [
      "request-synthesis",
      "start-output",
      "pause-output",
      "resume-output",
      "stop-output",
      "mute-output",
      "unmute-output",
    ] as const) {
      expect(voicePlaybackEffectToTurnSignal(media)).toBeUndefined();
    }
  });
});

describe("stop and provider failure (provider-failure case)", () => {
  it("stops an active turn into canceled", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    const stopped = controller.dispatch({ kind: "stop" });
    expect(stopped.snapshot.phase).toBe("canceled");
    expect(stopped.effects).toEqual(["stop-output", "notify-turn-speech-stopped"]);
    expect(stopped.snapshot.wireState).toBe("stopped");
  });

  it("fails a preparing turn and records the failure kind", () => {
    const controller = speechOutputController();
    controller.dispatch({ kind: "prepare" });
    const failed = controller.dispatch({ kind: "fail", failure: "provider-error" });
    expect(failed.snapshot.phase).toBe("failed");
    expect(failed.snapshot.failureKind).toBe("provider-error");
    expect(failed.effects).toEqual(["stop-output", "notify-turn-speech-stopped"]);
    // Keiko stays usable: a failed playback is a settled phase, not a crash.
    expect(failed.snapshot.settled).toBe(true);
  });

  it("fails a speaking turn", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    const failed = controller.dispatch({ kind: "fail", failure: "timeout" });
    expect(failed.snapshot.phase).toBe("failed");
    expect(failed.snapshot.failureKind).toBe("timeout");
  });

  it("ignores fail / stop when no turn is active", () => {
    const controller = speechOutputController();
    expect(controller.dispatch({ kind: "fail", failure: "internal" }).outcome).toBe("no-op");
    expect(controller.dispatch({ kind: "stop" }).outcome).toBe("no-op");
  });
});

describe("replay (replay if permitted)", () => {
  it("is rejected when replay is not permitted, even for a capable profile", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    controller.dispatch({ kind: "complete" });
    const replay = controller.dispatch({ kind: "replay" });
    expect(replay.outcome).toBe("not-allowed-for-profile");
    expect(controller.snapshot().phase).toBe("complete");
  });

  it("re-arms a settled turn and counts the replay when permitted", () => {
    const controller = speechOutputController({ replayAllowed: true });
    toSpeaking(controller);
    controller.dispatch({ kind: "complete" });
    const replay = controller.dispatch({ kind: "replay" });
    expect(replay.outcome).toBe("transitioned");
    expect(replay.snapshot.phase).toBe("preparing");
    expect(replay.snapshot.replays).toBe(1);
    expect(replay.snapshot.spoke).toBe(false);
    expect(replay.effects).toEqual(["request-synthesis"]);
  });

  it("replay is a no-op while a turn is still active", () => {
    const controller = speechOutputController({ replayAllowed: true });
    toSpeaking(controller);
    expect(controller.dispatch({ kind: "replay" }).outcome).toBe("no-op");
  });
});

describe("mute is orthogonal to the phase", () => {
  it("toggles mute without changing the phase and only emits on change", () => {
    const controller = speechOutputController();
    toSpeaking(controller);

    const muted = controller.dispatch({ kind: "set-muted", muted: true });
    expect(muted.snapshot.muted).toBe(true);
    expect(muted.snapshot.phase).toBe("speaking");
    expect(muted.effects).toEqual(["mute-output"]);

    // Redundant set is a no-op.
    const again = controller.dispatch({ kind: "set-muted", muted: true });
    expect(again.outcome).toBe("no-op");
    expect(again.effects).toEqual([]);

    const unmuted = controller.dispatch({ kind: "set-muted", muted: false });
    expect(unmuted.snapshot.muted).toBe(false);
    expect(unmuted.effects).toEqual(["unmute-output"]);
  });
});

describe("observer is content-free", () => {
  it("emits only enum literals, integers, and ms deltas", () => {
    const events: unknown[] = [];
    const observer: VoicePlaybackObserver = {
      onTransition: (e) => events.push(e),
      onInterrupt: (e) => events.push(e),
      onEffect: (e) => events.push(e),
    };
    const clock = controllableClock();
    const controller = speechOutputController({ observer, clock });
    controller.dispatch({ kind: "prepare" });
    clock.advance(33);
    controller.dispatch({ kind: "play-started" });
    controller.dispatch({ kind: "interrupt", atMs: 700 });

    const serialized = JSON.stringify(events);
    // No event ever carries audio, text, credential, SDP, or URL material.
    for (const forbidden of ["audio", "sdp", "credential", "token", "http", "url", "text"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    // A transition event carries the wire-state projection and a non-negative latency.
    const transitions = events.filter(
      (e): e is { latencyMs: number } => typeof e === "object" && e !== null && "latencyMs" in e,
    );
    expect(transitions.every((e) => e.latencyMs >= 0)).toBe(true);
  });
});

describe("boundary transitions (review-hardening)", () => {
  it("ignores fail while paused — the table has no paused→failed edge (no-op, stays paused)", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    controller.dispatch({ kind: "pause" });
    const result = controller.dispatch({ kind: "fail", failure: "timeout" });
    expect(result.outcome).toBe("no-op");
    expect(result.snapshot.phase).toBe("paused");
    expect(result.snapshot.failureKind).toBeUndefined();
  });

  it("completes naturally from paused (a paused utterance can finish)", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    controller.dispatch({ kind: "pause" });
    const result = controller.dispatch({ kind: "complete" });
    expect(result.outcome).toBe("transitioned");
    expect(result.snapshot.phase).toBe("complete");
    expect(result.effects).toEqual(["notify-turn-speech-completed"]);
  });

  it("stops from preparing — a stop during synthesis cancels before audio starts", () => {
    const controller = speechOutputController();
    controller.dispatch({ kind: "prepare" });
    const result = controller.dispatch({ kind: "stop" });
    expect(result.outcome).toBe("transitioned");
    expect(result.snapshot.phase).toBe("canceled");
    expect(result.snapshot.spoke).toBe(false);
    expect(result.effects).toEqual(["stop-output", "notify-turn-speech-stopped"]);
  });

  it("re-arms a new turn directly from interrupted (distinct from policy-gated replay)", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    controller.dispatch({ kind: "interrupt", atMs: 10 });
    expect(controller.snapshot().phase).toBe("interrupted");
    // `prepare` (not `replay`) re-arms a settled turn and resets the per-turn counters.
    const rearmed = controller.dispatch({ kind: "prepare" });
    expect(rearmed.outcome).toBe("transitioned");
    expect(rearmed.snapshot.phase).toBe("preparing");
    expect(rearmed.snapshot.spoke).toBe(false);
    // Re-arming is not a replay; the replay counter is untouched.
    expect(rearmed.snapshot.replays).toBe(0);
  });

  it("normalises a non-finite interrupt offset to undefined (defense in depth)", () => {
    const onInterrupt = vi.fn();
    const controller = speechOutputController({ observer: { onInterrupt } });
    toSpeaking(controller);
    const result = controller.dispatch({ kind: "interrupt", atMs: Number.NaN });
    expect(result.snapshot.phase).toBe("interrupted");
    expect(result.snapshot.lastInterruptAtMs).toBeUndefined();
    expect(onInterrupt).toHaveBeenCalledWith({
      phase: "interrupted",
      atMs: undefined,
      interruptions: 1,
    });
  });
});

describe("reset", () => {
  it("returns the controller to its fresh dormant-for-profile state", () => {
    const controller = speechOutputController();
    toSpeaking(controller);
    controller.dispatch({ kind: "interrupt" });
    controller.reset();
    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("unavailable");
    expect(snapshot.interruptions).toBe(0);
    expect(snapshot.spoke).toBe(false);
    expect(snapshot.muted).toBe(false);
  });
});
