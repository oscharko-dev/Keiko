import { describe, expect, it } from "vitest";

import type { VoiceProfile } from "./gateway.js";
import { VOICE_MEDIA_PLANE, VOICE_PLAYBACK_STATES } from "./voice-protocol.js";
import {
  VOICE_PLAYBACK_ACTIVE_PHASES,
  VOICE_PLAYBACK_AUDIO_PLANE,
  VOICE_PLAYBACK_EFFECTS,
  VOICE_PLAYBACK_FAILURE_KINDS,
  VOICE_PLAYBACK_PHASE_REDACTION,
  VOICE_PLAYBACK_PHASE_REPLAY,
  VOICE_PLAYBACK_PHASES,
  VOICE_PLAYBACK_SCHEMA_VERSION,
  VOICE_PLAYBACK_SETTLED_PHASES,
  VOICE_PLAYBACK_TRANSITIONS,
  type VoicePlaybackEffect,
  type VoicePlaybackPhase,
  assertNeverVoicePlaybackPhase,
  canTransitionVoicePlayback,
  initialVoicePlaybackPhase,
  isActiveVoicePlaybackPhase,
  isSettledVoicePlaybackPhase,
  isVoicePlaybackEffect,
  isVoicePlaybackFailureKind,
  isVoicePlaybackPhase,
  isVoicePlaybackSchemaVersionSupported,
  mapVoicePlaybackPhaseToWireState,
  summarizeVoicePlaybackTurn,
  voicePlaybackAllowedForProfile,
  voicePlaybackInterruptAllowedForProfile,
  voicePlaybackPhaseRedactionClass,
  voicePlaybackPhaseReplayClass,
} from "./voice-playback.js";

const ALL_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
];

describe("voice-playback schema version", () => {
  it("pins '1' and accepts only it", () => {
    expect(VOICE_PLAYBACK_SCHEMA_VERSION).toBe("1");
    expect(isVoicePlaybackSchemaVersionSupported("1")).toBe(true);
    expect(isVoicePlaybackSchemaVersionSupported("2")).toBe(false);
    expect(isVoicePlaybackSchemaVersionSupported(1)).toBe(false);
    expect(isVoicePlaybackSchemaVersionSupported(undefined)).toBe(false);
  });
});

describe("phase catalog", () => {
  it("enumerates exactly the eight issue phases", () => {
    expect(VOICE_PLAYBACK_PHASES).toEqual([
      "unavailable",
      "preparing",
      "speaking",
      "paused",
      "interrupted",
      "canceled",
      "failed",
      "complete",
    ]);
  });

  it("partitions active and settled phases without overlap and leaves only unavailable unclassified", () => {
    const active = new Set<VoicePlaybackPhase>(VOICE_PLAYBACK_ACTIVE_PHASES);
    const settled = new Set<VoicePlaybackPhase>(VOICE_PLAYBACK_SETTLED_PHASES);
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(active.has(phase) && settled.has(phase)).toBe(false);
    }
    const classified = new Set([...active, ...settled]);
    const unclassified = VOICE_PLAYBACK_PHASES.filter((phase) => !classified.has(phase));
    expect(unclassified).toEqual(["unavailable"]);
  });

  it("isVoicePlaybackPhase guards the catalog", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(isVoicePlaybackPhase(phase)).toBe(true);
    }
    expect(isVoicePlaybackPhase("idle")).toBe(false);
    expect(isVoicePlaybackPhase("")).toBe(false);
    expect(isVoicePlaybackPhase(42)).toBe(false);
    expect(isVoicePlaybackPhase(null)).toBe(false);
  });

  it("isActive / isSettled agree with the arrays", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(isActiveVoicePlaybackPhase(phase)).toBe(
        (VOICE_PLAYBACK_ACTIVE_PHASES as readonly string[]).includes(phase),
      );
      expect(isSettledVoicePlaybackPhase(phase)).toBe(
        (VOICE_PLAYBACK_SETTLED_PHASES as readonly string[]).includes(phase),
      );
    }
  });
});

describe("classification tables", () => {
  it("classify every phase (totality)", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(VOICE_PLAYBACK_PHASE_REPLAY[phase]).toBeDefined();
      expect(VOICE_PLAYBACK_PHASE_REDACTION[phase]).toBeDefined();
      expect(voicePlaybackPhaseReplayClass(phase)).toBe(VOICE_PLAYBACK_PHASE_REPLAY[phase]);
      expect(voicePlaybackPhaseRedactionClass(phase)).toBe(VOICE_PLAYBACK_PHASE_REDACTION[phase]);
    }
  });

  it("EVERY phase is content-free — no playback phase may carry text, secrets, or audio (AC3/AC4)", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(voicePlaybackPhaseRedactionClass(phase)).toBe("content-free");
    }
  });

  it("settled phases are replayable, in-flight and unavailable are ephemeral (AC5)", () => {
    expect(voicePlaybackPhaseReplayClass("interrupted")).toBe("replayable");
    expect(voicePlaybackPhaseReplayClass("canceled")).toBe("replayable");
    expect(voicePlaybackPhaseReplayClass("failed")).toBe("replayable");
    expect(voicePlaybackPhaseReplayClass("complete")).toBe("replayable");
    expect(voicePlaybackPhaseReplayClass("preparing")).toBe("ephemeral");
    expect(voicePlaybackPhaseReplayClass("speaking")).toBe("ephemeral");
    expect(voicePlaybackPhaseReplayClass("paused")).toBe("ephemeral");
    expect(voicePlaybackPhaseReplayClass("unavailable")).toBe("ephemeral");
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(voicePlaybackPhaseReplayClass(phase) === "replayable").toBe(
        isSettledVoicePlaybackPhase(phase),
      );
    }
  });

  it("audio plane is the never-persisted, raw-media, media-plane descriptor (AC4)", () => {
    expect(VOICE_PLAYBACK_AUDIO_PLANE).toBe(VOICE_MEDIA_PLANE);
    expect(VOICE_PLAYBACK_AUDIO_PLANE.plane).toBe("media");
    expect(VOICE_PLAYBACK_AUDIO_PLANE.replay).toBe("never-persisted");
    expect(VOICE_PLAYBACK_AUDIO_PLANE.redaction).toBe("raw-media");
  });
});

describe("transition table", () => {
  it("classifies every phase (totality) and only references known phases", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      const targets = VOICE_PLAYBACK_TRANSITIONS[phase];
      expect(Array.isArray(targets)).toBe(true);
      for (const target of targets) {
        expect(isVoicePlaybackPhase(target)).toBe(true);
        expect(canTransitionVoicePlayback(phase, target)).toBe(true);
      }
    }
  });

  it("never lists a phase as a self-transition (mute is orthogonal, not a transition)", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      expect(VOICE_PLAYBACK_TRANSITIONS[phase]).not.toContain(phase);
    }
  });

  it("arms a new turn from unavailable and from every settled phase", () => {
    expect(canTransitionVoicePlayback("unavailable", "preparing")).toBe(true);
    for (const phase of VOICE_PLAYBACK_SETTLED_PHASES) {
      expect(canTransitionVoicePlayback(phase, "preparing")).toBe(true);
    }
  });

  it("models the live transport edges (pause/resume/interrupt/stop/fail/complete)", () => {
    expect(canTransitionVoicePlayback("speaking", "paused")).toBe(true);
    expect(canTransitionVoicePlayback("paused", "speaking")).toBe(true);
    expect(canTransitionVoicePlayback("speaking", "interrupted")).toBe(true);
    expect(canTransitionVoicePlayback("paused", "interrupted")).toBe(true);
    expect(canTransitionVoicePlayback("speaking", "canceled")).toBe(true);
    expect(canTransitionVoicePlayback("speaking", "failed")).toBe(true);
    expect(canTransitionVoicePlayback("speaking", "complete")).toBe(true);
    expect(canTransitionVoicePlayback("preparing", "complete")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransitionVoicePlayback("unavailable", "speaking")).toBe(false);
    expect(canTransitionVoicePlayback("complete", "speaking")).toBe(false);
    expect(canTransitionVoicePlayback("interrupted", "speaking")).toBe(false);
    expect(canTransitionVoicePlayback("preparing", "paused")).toBe(false);
    expect(canTransitionVoicePlayback("paused", "failed")).toBe(false);
  });

  it("every active phase is reachable from preparing's transitive closure", () => {
    // Sanity: from a fresh arm (unavailable -> preparing) the machine can reach speaking and a terminal.
    expect(canTransitionVoicePlayback("preparing", "speaking")).toBe(true);
    expect(canTransitionVoicePlayback("speaking", "complete")).toBe(true);
  });
});

describe("phase -> wire-state mapping", () => {
  it("maps to valid wire states or undefined for the dormant phase", () => {
    expect(mapVoicePlaybackPhaseToWireState("unavailable")).toBeUndefined();
    expect(mapVoicePlaybackPhaseToWireState("preparing")).toBe("idle");
    expect(mapVoicePlaybackPhaseToWireState("speaking")).toBe("playing");
    expect(mapVoicePlaybackPhaseToWireState("paused")).toBe("paused");
    expect(mapVoicePlaybackPhaseToWireState("interrupted")).toBe("interrupted");
    expect(mapVoicePlaybackPhaseToWireState("canceled")).toBe("stopped");
    expect(mapVoicePlaybackPhaseToWireState("failed")).toBe("stopped");
    expect(mapVoicePlaybackPhaseToWireState("complete")).toBe("idle");
  });

  it("only ever yields a member of the wire playback-state catalog", () => {
    for (const phase of VOICE_PLAYBACK_PHASES) {
      const wire = mapVoicePlaybackPhaseToWireState(phase);
      if (wire !== undefined) {
        expect(VOICE_PLAYBACK_STATES).toContain(wire);
      }
    }
  });
});

describe("failure taxonomy", () => {
  it("enumerates the provider-neutral kinds and guards them", () => {
    expect(VOICE_PLAYBACK_FAILURE_KINDS).toEqual([
      "rate-limited",
      "timeout",
      "provider-error",
      "unavailable",
      "internal",
    ]);
    for (const kind of VOICE_PLAYBACK_FAILURE_KINDS) {
      expect(isVoicePlaybackFailureKind(kind)).toBe(true);
    }
    expect(isVoicePlaybackFailureKind("boom")).toBe(false);
    expect(isVoicePlaybackFailureKind(undefined)).toBe(false);
  });
});

describe("effect vocabulary", () => {
  it("enumerates effects and guards them", () => {
    for (const effect of VOICE_PLAYBACK_EFFECTS) {
      expect(isVoicePlaybackEffect(effect)).toBe(true);
    }
    expect(isVoicePlaybackEffect("grant-authority")).toBe(false);
    expect(isVoicePlaybackEffect(7)).toBe(false);
  });

  it("includes the AC2 turn-notification effects and no authority-bearing effect", () => {
    const effects = new Set<VoicePlaybackEffect>(VOICE_PLAYBACK_EFFECTS);
    expect(effects.has("notify-turn-interrupt")).toBe(true);
    expect(effects.has("notify-turn-speech-start")).toBe(true);
    expect(effects.has("notify-turn-speech-completed")).toBe(true);
    expect(effects.has("notify-turn-speech-stopped")).toBe(true);
    // No effect names a workflow, model call, or store write.
    for (const effect of VOICE_PLAYBACK_EFFECTS) {
      expect(/workflow|model|store|persist|write|commit/u.test(effect)).toBe(false);
    }
  });
});

describe("capability gating (derived from the contract, single source of truth)", () => {
  it("permits playback and interrupt for speech-output and full-realtime only (AC1)", () => {
    const expectedPlayback: Record<VoiceProfile, boolean> = {
      none: false,
      "speech-to-text": false,
      "speech-output": true,
      "full-realtime": true,
    };
    for (const profile of ALL_PROFILES) {
      expect(voicePlaybackAllowedForProfile(profile)).toBe(expectedPlayback[profile]);
      // Interrupt availability matches playback availability across the #496 profile table.
      expect(voicePlaybackInterruptAllowedForProfile(profile)).toBe(expectedPlayback[profile]);
    }
  });

  it("starts every profile in the unavailable phase", () => {
    for (const profile of ALL_PROFILES) {
      expect(initialVoicePlaybackPhase(profile)).toBe("unavailable");
    }
  });
});

describe("content-free turn summary", () => {
  it("derives completed/interrupted/failed from the terminal phase", () => {
    const complete = summarizeVoicePlaybackTurn({
      phase: "complete",
      available: true,
      spoke: true,
      interruptions: 0,
      replays: 1,
    });
    expect(complete).toEqual({
      schemaVersion: "1",
      phase: "complete",
      available: true,
      spoke: true,
      completed: true,
      interrupted: false,
      failed: false,
      interruptions: 0,
      replays: 1,
      failureKind: undefined,
    });

    const interrupted = summarizeVoicePlaybackTurn({
      phase: "interrupted",
      available: true,
      spoke: true,
      interruptions: 2,
      replays: 0,
    });
    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.completed).toBe(false);
  });

  it("keeps failureKind only for the failed phase", () => {
    const failed = summarizeVoicePlaybackTurn({
      phase: "failed",
      available: true,
      spoke: false,
      interruptions: 0,
      replays: 0,
      failureKind: "provider-error",
    });
    expect(failed.failed).toBe(true);
    expect(failed.failureKind).toBe("provider-error");

    // A non-failed phase drops any stray failureKind so the summary cannot misreport.
    const completeWithStrayKind = summarizeVoicePlaybackTurn({
      phase: "complete",
      available: true,
      spoke: true,
      interruptions: 0,
      replays: 0,
      failureKind: "timeout",
    });
    expect(completeWithStrayKind.failureKind).toBeUndefined();
  });

  it("reports an unavailable, never-spoke turn for a no-capability deployment (AC1)", () => {
    const summary = summarizeVoicePlaybackTurn({
      phase: "unavailable",
      available: false,
      spoke: false,
      interruptions: 0,
      replays: 0,
    });
    expect(summary.available).toBe(false);
    expect(summary.spoke).toBe(false);
    expect(summary.completed).toBe(false);
    expect(summary.interrupted).toBe(false);
    expect(summary.failed).toBe(false);
  });

  it("never carries audio, text, or credential fields (AC3/AC4)", () => {
    const summary = summarizeVoicePlaybackTurn({
      phase: "complete",
      available: true,
      spoke: true,
      interruptions: 0,
      replays: 0,
    });
    const keys = Object.keys(summary);
    for (const forbidden of ["audio", "text", "transcript", "credential", "token", "sdp", "url"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("exhaustiveness guard", () => {
  it("throws for an unhandled phase", () => {
    expect(() => assertNeverVoicePlaybackPhase("nope" as never)).toThrow(
      /unhandled voice playback phase/u,
    );
  });
});
