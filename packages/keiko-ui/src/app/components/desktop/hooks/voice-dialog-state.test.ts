// Issue #1559 — exhaustive, mutation-robust coverage of the pure dialog-state derivation. Each test
// pins one precedence rung so reordering or weakening a branch fails a test.

import { describe, expect, it } from "vitest";
import type { RealtimeVoicePhase } from "./useRealtimeVoice";
import type { VoiceTurnState } from "./voice-turn-manager";
import type { VoicePlaybackPhase } from "./voice-playback-state";
import {
  deriveVoiceAuraState,
  deriveVoiceDialogState,
  playbackPhaseToTurnState,
  voiceDialogStateHeadline,
  voiceDialogStateIsLive,
  type VoiceAuraStateInputs,
  type VoiceDialogState,
} from "./voice-dialog-state";

const ALL_STATES: readonly VoiceDialogState[] = [
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "muted",
  "interrupted",
  "error",
];

describe("deriveVoiceDialogState — precedence", () => {
  it("error dominates every turn state (rung 1)", () => {
    const turnStates: readonly VoiceTurnState[] = [
      "idle",
      "listening",
      "thinking",
      "speaking",
      "interrupted",
      "recovering",
    ];
    for (const turnState of turnStates) {
      expect(deriveVoiceDialogState({ realtimePhase: "error", turnState, muted: false })).toBe(
        "error",
      );
      // Even muted-while-speaking under an error still reads 'error'.
      expect(deriveVoiceDialogState({ realtimePhase: "error", turnState, muted: true })).toBe(
        "error",
      );
    }
  });

  it("maps requesting / negotiating to 'connecting' before any floor state (rung 2)", () => {
    for (const phase of ["requesting", "negotiating"] satisfies RealtimeVoicePhase[]) {
      // A turn that would otherwise read 'speaking' is overridden by an in-progress connection.
      expect(
        deriveVoiceDialogState({ realtimePhase: phase, turnState: "speaking", muted: false }),
      ).toBe("connecting");
    }
  });

  it("maps a turn-manager recovery to 'connecting' even when the transport is connected (rung 2)", () => {
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "recovering", muted: false }),
    ).toBe("connecting");
  });

  it("surfaces an interruption before the steady floor states (rung 3)", () => {
    expect(
      deriveVoiceDialogState({
        realtimePhase: "connected",
        turnState: "interrupted",
        muted: false,
      }),
    ).toBe("interrupted");
    // Interruption is not masked by a standing mute preference.
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "interrupted", muted: true }),
    ).toBe("interrupted");
  });

  it("surfaces a connected muted microphone before steady floor states (rung 4)", () => {
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "speaking", muted: false }),
    ).toBe("speaking");
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "speaking", muted: true }),
    ).toBe("muted");
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "idle", muted: true }),
    ).toBe("muted");
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "listening", muted: true }),
    ).toBe("muted");
  });

  it("maps thinking and listening floor states (rungs 5–6)", () => {
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "thinking", muted: false }),
    ).toBe("thinking");
    expect(
      deriveVoiceDialogState({ realtimePhase: "connected", turnState: "listening", muted: false }),
    ).toBe("listening");
  });

  it("falls back to 'idle' for idle / yielding / disabled and connected-no-floor (rung 7)", () => {
    for (const turnState of ["idle", "yielding", "disabled"] satisfies VoiceTurnState[]) {
      expect(deriveVoiceDialogState({ realtimePhase: "connected", turnState, muted: false })).toBe(
        "idle",
      );
    }
    expect(deriveVoiceDialogState({ realtimePhase: "idle", turnState: "idle", muted: false })).toBe(
      "idle",
    );
  });
});

describe("voiceDialogStateHeadline", () => {
  it("returns a distinct, non-empty professional-English headline for every state", () => {
    const seen = new Set<string>();
    for (const state of ALL_STATES) {
      const headline = voiceDialogStateHeadline(state);
      expect(headline.length).toBeGreaterThan(0);
      seen.add(headline);
    }
    expect(seen.size).toBe(ALL_STATES.length);
  });

  it("never implies text chat is blocked, and reassures on error", () => {
    expect(voiceDialogStateHeadline("error")).toMatch(/text/iu);
  });
});

describe("voiceDialogStateIsLive", () => {
  it("is true only while actively conversing", () => {
    const live: readonly VoiceDialogState[] = ["listening", "speaking", "muted"];
    for (const state of ALL_STATES) {
      expect(voiceDialogStateIsLive(state)).toBe(live.includes(state));
    }
  });
});

const AURA_BASE: VoiceAuraStateInputs = {
  voiceDialogActive: true,
  voiceDialogAvailable: true,
  voiceDialogState: "idle",
  listening: false,
  speaking: false,
  sending: false,
  sendStatus: "idle",
  hasSessionError: false,
};

describe("deriveVoiceAuraState", () => {
  it("does not activate while dialogue mode is off", () => {
    expect(deriveVoiceAuraState({ ...AURA_BASE, voiceDialogActive: false })).toEqual({
      active: false,
      state: "ready",
      intensity: "low",
    });
  });

  it("keeps the active aura visually reduced to the low-intensity ready state", () => {
    const patches: readonly Partial<VoiceAuraStateInputs>[] = [
      {},
      { voiceDialogAvailable: false },
      { hasSessionError: true },
      { voiceDialogState: "error" },
      { voiceDialogState: "interrupted" },
      { voiceDialogState: "muted" },
      { voiceDialogState: "speaking" },
      { voiceDialogState: "listening" },
      { voiceDialogState: "thinking" },
      { voiceDialogState: "connecting" },
      { listening: true },
      { speaking: true },
      { sending: true },
      { sendStatus: "queued" },
      { sendStatus: "contacting" },
      { sendStatus: "streaming" },
    ];
    for (const patch of patches) {
      expect(deriveVoiceAuraState({ ...AURA_BASE, ...patch })).toEqual({
        active: true,
        state: "ready",
        intensity: "low",
      });
    }
  });
});

describe("playbackPhaseToTurnState", () => {
  it("maps preparing to thinking, speaking/paused to speaking, interrupted to interrupted", () => {
    expect(playbackPhaseToTurnState("preparing")).toBe("thinking");
    expect(playbackPhaseToTurnState("speaking")).toBe("speaking");
    expect(playbackPhaseToTurnState("paused")).toBe("speaking");
    expect(playbackPhaseToTurnState("interrupted")).toBe("interrupted");
  });

  it("yields the floor back to idle for every settled / unavailable phase", () => {
    for (const phase of [
      "unavailable",
      "canceled",
      "complete",
      "failed",
    ] satisfies VoicePlaybackPhase[]) {
      expect(playbackPhaseToTurnState(phase)).toBe("idle");
    }
  });
});
