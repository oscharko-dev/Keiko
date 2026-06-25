// Issue #501 — React binding for the playback controller. Verifies the binding mirrors the controller
// snapshot, exposes the user controls, forwards turn-notifications to an injected turn manager (AC2),
// and stays dormant for a non-playback profile (AC1).

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createVoiceTurnManager } from "./voice-turn-manager";
import { useVoicePlayback } from "./useVoicePlayback";

describe("useVoicePlayback", () => {
  it("stays dormant for a non-playback profile (AC1)", () => {
    const { result } = renderHook(() => useVoicePlayback({ profile: "speech-to-text" }));
    expect(result.current.snapshot.available).toBe(false);
    act(() => result.current.toggleMute());
    // The dormant controller rejects the command, so the mirrored snapshot never changes.
    expect(result.current.snapshot.muted).toBe(false);
    expect(result.current.snapshot.phase).toBe("unavailable");
  });

  it("toggles mute and reflects it in the snapshot", () => {
    const { result } = renderHook(() => useVoicePlayback({ profile: "speech-output" }));
    expect(result.current.snapshot.available).toBe(true);
    act(() => result.current.toggleMute());
    expect(result.current.snapshot.muted).toBe(true);
    act(() => result.current.toggleMute());
    expect(result.current.snapshot.muted).toBe(false);
  });

  it("drives the lifecycle and mirrors the phase", () => {
    const { result } = renderHook(() => useVoicePlayback({ profile: "speech-output" }));
    act(() => result.current.prepare());
    expect(result.current.snapshot.phase).toBe("preparing");
    act(() => result.current.playStarted());
    expect(result.current.snapshot.phase).toBe("speaking");
    act(() => result.current.pause());
    expect(result.current.snapshot.phase).toBe("paused");
    act(() => result.current.resume());
    expect(result.current.snapshot.phase).toBe("speaking");
    act(() => result.current.complete());
    expect(result.current.snapshot.phase).toBe("complete");
  });

  it("forwards assistant-speech and interruption to an injected turn manager (AC2)", () => {
    const turnManager = createVoiceTurnManager({ profile: "speech-output" });
    const { result } = renderHook(() =>
      useVoicePlayback({ profile: "speech-output", turnManager }),
    );
    act(() => result.current.prepare());
    act(() => result.current.playStarted());
    expect(turnManager.snapshot().state).toBe("speaking");
    act(() => result.current.interrupt(900));
    expect(turnManager.snapshot().state).toBe("interrupted");
    expect(turnManager.snapshot().interruptions).toBe(1);
    expect(result.current.snapshot.phase).toBe("interrupted");
  });

  it("honors the replay-permitted option and counts replays", () => {
    const { result } = renderHook(() =>
      useVoicePlayback({ profile: "speech-output", replayAllowed: true }),
    );
    act(() => result.current.prepare());
    act(() => result.current.playStarted());
    act(() => result.current.complete());
    act(() => result.current.replay());
    expect(result.current.snapshot.phase).toBe("preparing");
    expect(result.current.snapshot.replays).toBe(1);
  });

  it("exposes setMuted, stop, and fail", () => {
    const { result } = renderHook(() => useVoicePlayback({ profile: "speech-output" }));
    act(() => result.current.setMuted(true));
    expect(result.current.snapshot.muted).toBe(true);
    act(() => result.current.setMuted(false));
    expect(result.current.snapshot.muted).toBe(false);

    act(() => result.current.prepare());
    act(() => result.current.playStarted());
    act(() => result.current.stop());
    expect(result.current.snapshot.phase).toBe("canceled");

    act(() => result.current.prepare());
    act(() => result.current.fail("timeout"));
    expect(result.current.snapshot.phase).toBe("failed");
    expect(result.current.snapshot.failureKind).toBe("timeout");
  });

  it("resets to the dormant phase", () => {
    const { result } = renderHook(() => useVoicePlayback({ profile: "speech-output" }));
    act(() => result.current.prepare());
    act(() => result.current.playStarted());
    act(() => result.current.reset());
    expect(result.current.snapshot.phase).toBe("unavailable");
    expect(result.current.snapshot.spoke).toBe(false);
  });
});
