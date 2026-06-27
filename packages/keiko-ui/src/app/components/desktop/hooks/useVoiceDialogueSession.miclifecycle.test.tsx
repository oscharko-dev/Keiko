// Issue #1562, Epic #1556 — microphone capture / playback lifecycle for the voice dialogue session.
//
// Proves AC2 (microphone is requested ONLY after an explicit onListen(), never on entering dialogue
// mode) and AC3 (stopping or leaving the session releases the mic and playback resources
// deterministically). This file tests the DIALOGUE-CONTROLLER layer: the decisions made in
// useVoiceDialogueSession and its composed useDictation instance. The browser-hardware layer
// (getUserMedia → track.stop on cancel) is already proven at the recorder level in
// dictation-recorder.test.ts, so this file does not duplicate that.
//
// All media surfaces (DictationRecorder, transcribe, synthesize, HTMLAudioElement, object-URL store)
// are injected through the production seam contract, keeping the suite deterministic with no real
// hardware or timers.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCapabilityResolution } from "@/lib/types";
import type { DictationRecorder, DictationSession } from "./dictation-recorder";
import type { AssistantSpeechAudioElement } from "./useAssistantSpeech";
import {
  useVoiceDialogueSession,
  type DialogueChatSession,
  type UseVoiceDialogueSessionOptions,
} from "./useVoiceDialogueSession";

// ─── Capability fixture ───────────────────────────────────────────────────────────────────────────
// The only resolution for which dialogue is offered: STT + speech output + personas, no WebRTC
// (the STT+TTS fallback path; realtimePhase is hardcoded "idle" in this dialogue controller).
const PERSONAS = ["male", "female", "neutral"] as const;

const FULL_REALTIME_NO_WEBRTC: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

const STT_ONLY: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

// ─── Fake audio element ───────────────────────────────────────────────────────────────────────────
class FakeAudio implements AssistantSpeechAudioElement {
  src = "";
  muted = false;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  firePlaying(): void {
    this.onplaying?.();
  }
  fireEnded(): void {
    this.onended?.();
  }
}

// ─── Recorder harness ─────────────────────────────────────────────────────────────────────────────
// Two recorder variants are used:
//   - makeImmediateRecorder(): start() resolves synchronously (after one microtask), suitable for
//     testing the post-grant path.
//   - makeDeferredRecorder(): start() returns a promise whose resolve is externally controlled, so
//     tests can call cancel() or onStop() while the permission window is still open.

interface RecorderHarness {
  readonly recorder: DictationRecorder;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly session: DictationSession;
}

function makeImmediateRecorder(): RecorderHarness {
  const stop = vi.fn(async () => ({
    audioBase64: "AAAA",
    mimeType: "audio/webm",
    durationMs: 500,
  }));
  const cancel = vi.fn();
  const session: DictationSession = { stop, cancel };
  const start = vi.fn(async () => session);
  return { recorder: { start }, start, stop, cancel, session };
}

interface DeferredRecorder extends RecorderHarness {
  resolveStart: (session: DictationSession) => void;
}

function makeDeferredRecorder(): DeferredRecorder {
  let resolveStart: (session: DictationSession) => void = () => {};
  const stop = vi.fn(async () => ({
    audioBase64: "AAAA",
    mimeType: "audio/webm",
    durationMs: 500,
  }));
  const cancel = vi.fn();
  const session: DictationSession = { stop, cancel };
  const start = vi.fn(
    () =>
      new Promise<DictationSession>((resolve) => {
        resolveStart = resolve;
      }),
  );
  // Indirect through the live `resolveStart` closure variable: `start()` reassigns it after this
  // object is built, so capturing the value directly would freeze the initial no-op resolver.
  return {
    recorder: { start },
    start,
    stop,
    cancel,
    session,
    resolveStart: (grantedSession: DictationSession) => resolveStart(grantedSession),
  };
}

// ─── Chat session stub ────────────────────────────────────────────────────────────────────────────
function makeChatSession(overrides: Partial<DialogueChatSession> = {}): DialogueChatSession {
  return {
    sendStatus: "idle",
    sending: false,
    sendMessage: vi.fn(async () => {}),
    cancelSend: vi.fn(),
    ...overrides,
  };
}

// ─── Test harness factory ─────────────────────────────────────────────────────────────────────────
interface Harness {
  readonly options: UseVoiceDialogueSessionOptions;
  readonly recorder: RecorderHarness;
  readonly onLeave: ReturnType<typeof vi.fn>;
  readonly revokeObjectUrl: ReturnType<typeof vi.fn>;
  readonly audios: FakeAudio[];
}

function buildHarness(
  recorder: RecorderHarness,
  overrides: Partial<UseVoiceDialogueSessionOptions> = {},
): Harness {
  const onLeave = vi.fn();
  const revokeObjectUrl = vi.fn();
  const audios: FakeAudio[] = [];
  const options: UseVoiceDialogueSessionOptions = {
    capability: FULL_REALTIME_NO_WEBRTC,
    active: true,
    persona: "neutral",
    session: makeChatSession(),
    answerText: undefined,
    answerId: undefined,
    onLeave,
    createRecorder: () => recorder.recorder,
    transcribe: vi.fn(async () => ({ transcript: "run the pipeline" })),
    synthesize: vi.fn(async () => ({ audio: btoa("AUDIO"), mimeType: "audio/mpeg" })),
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    createObjectUrl: vi.fn(() => "blob:test-url"),
    revokeObjectUrl,
    ...overrides,
  };
  return { options, recorder, onLeave, revokeObjectUrl, audios };
}

// ─── Global stubs ─────────────────────────────────────────────────────────────────────────────────
// `dictationCaptureSupported()` checks for `navigator.mediaDevices` and `MediaRecorder`; jsdom
// provides neither, so stub them. The recorder is injected separately via the test seam and never
// calls the real APIs. This mirrors the pattern used in useVoiceDialogueSession.test.ts.
beforeEach(() => {
  vi.stubGlobal(
    "Blob",
    class {
      constructor(
        public readonly parts: unknown[],
        public readonly options?: { type?: string },
      ) {}
    },
  );
  vi.stubGlobal("MediaRecorder", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── AC2: Microphone activation timing ───────────────────────────────────────────────────────────
// Microphone access is requested ONLY when the user enters a voice mode requiring capture (AC2).
// Entering dialogue mode (rendering with active=true) must NOT open the mic on its own.
describe("useVoiceDialogueSession.miclifecycle — AC2: mic activation timing", () => {
  it("rendering with active=true and dialogue capability does NOT open the mic on its own", () => {
    // Arrange: an immediate recorder whose start() we can observe.
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);

    // Act: mount the hook without calling onListen().
    renderHook(() => useVoiceDialogueSession(h.options));

    // Assert: recorder.start() must not have been invoked — no mic access without an explicit
    // user gesture. Without the guard in onListen(), any autostart effect would call start() here.
    expect(recorder.start).not.toHaveBeenCalled();
  });

  it("recorder.start() is called only AFTER onListen() is invoked", async () => {
    // Arrange.
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));

    // Assert pre-condition: no capture before the gesture.
    expect(recorder.start).not.toHaveBeenCalled();

    // Act: simulate the user tapping the mic button.
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });

    // Assert: now the recorder was started exactly once.
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(true);
  });

  it("a second onListen() while capture is in the requesting phase does NOT open a second mic stream (AC2)", async () => {
    // Arrange: a deferred recorder keeps the permission window open so we can call onListen() twice.
    const deferred = makeDeferredRecorder();
    const h = buildHarness(deferred);
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));

    // Act: first onListen() — enters the requesting phase.
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    // The phase guard in onListen() (phase === "requesting" → return) AND useDictation's startingRef
    // both prevent a second start(). Call onListen() again before the grant resolves.
    act(() => result.current.onListen());

    // Resolve the first grant.
    await act(async () => {
      deferred.resolveStart(deferred.session);
      await Promise.resolve();
    });

    // Assert: recorder.start() was invoked exactly once — no second getUserMedia stream.
    // Without the guards, this would be 2, leaking the first mic track.
    expect(deferred.start).toHaveBeenCalledTimes(1);
  });
});

// ─── AC3: Deterministic resource release ─────────────────────────────────────────────────────────
// Stopping or leaving dialog mode releases microphone and playback resources deterministically (AC3).
describe("useVoiceDialogueSession.miclifecycle — AC3: deterministic resource release", () => {
  it("onStop() releases the capture session and calls onLeave()", async () => {
    // Arrange: start a capture turn.
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));

    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    expect(recorder.start).toHaveBeenCalledTimes(1);

    // Act: the user taps Stop.
    act(() => result.current.onStop());

    // Assert: the capture session was cancelled (mic track released) and the host was notified.
    expect(recorder.cancel).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(false);
  });

  it("onStop() revokes any playback object URL that was created (no synthesized audio persisted)", async () => {
    // Arrange: render with a settled answer so synthesis runs and an object URL is created.
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder, {
      answerText: "The deployment succeeded.",
      answerId: "msg-1",
    });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));

    // Let synthesis settle and the audio element connect.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fire the playing event to confirm the audio pipeline started.
    await act(async () => {
      h.audios[0]?.firePlaying();
      await Promise.resolve();
    });

    const createObjectUrl = h.options.createObjectUrl as ReturnType<typeof vi.fn>;
    const urlsCreated = createObjectUrl.mock.calls.length;

    // Act: stop the session.
    act(() => result.current.onStop());

    // Assert: every object URL created during the session has been revoked — synthesized audio is
    // not held in memory after the session ends (AC1/AC3 "synthesized audio must not persist").
    // revokeObjectUrl is called once per URL created.
    expect(h.revokeObjectUrl.mock.calls.length).toBeGreaterThanOrEqual(urlsCreated);
  });

  it("unmounting the hook while capture is active releases the mic (AC3)", async () => {
    // Arrange: start a capture turn.
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);
    const { result, unmount } = renderHook(() => useVoiceDialogueSession(h.options));

    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    expect(recorder.start).toHaveBeenCalledTimes(1);

    // Act: unmount (e.g. navigation away from the chat view while the mic is live).
    unmount();

    // Assert: the teardown effect cancels dictation, releasing the mic track (AC3 "unmount safety").
    // Without the useEffect(()=>teardown, [teardown]) call in the hook, cancel would not be invoked.
    expect(recorder.cancel).toHaveBeenCalled();
  });

  it("unmounting while a capture start is in the permission window still releases the mic", async () => {
    // Arrange: a deferred recorder holds the permission window open.
    const deferred = makeDeferredRecorder();
    const h = buildHarness(deferred);
    const { result, unmount } = renderHook(() => useVoiceDialogueSession(h.options));

    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });

    // Act: unmount before the permission grant resolves.
    unmount();

    // The grant resolves after unmount — the resolve branch must release the session.
    await act(async () => {
      deferred.resolveStart(deferred.session);
      await Promise.resolve();
    });

    // Assert: the session that was granted mid-unmount was cancelled (mic released).
    // This exercises the mountedRef check in useDictation's resolve branch (AC3).
    expect(deferred.cancel).toHaveBeenCalled();
  });

  it("capability loss while active tears down the session and calls onLeave() (AC3)", async () => {
    // Arrange: start an active session.
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);
    const { result, rerender } = renderHook(
      (props: UseVoiceDialogueSessionOptions) => useVoiceDialogueSession(props),
      { initialProps: h.options },
    );

    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    expect(result.current.listening).toBe(true);

    // Act: the deployment flips to a non-dialogue capability mid-session (e.g. provider removed).
    rerender({ ...h.options, capability: STT_ONLY });

    // Assert: the capability-loss effect in the hook runs teardown + onLeave().
    // Without the `if (active && !dialogueAvailable) { teardown(); onLeave(); }` effect, the session
    // would strand active with a mic open and onLeave never called.
    expect(recorder.cancel).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalledTimes(1);
    expect(result.current.dialogueAvailable).toBe(false);
  });

  it("capability becoming undefined while active tears down the session and calls onLeave()", async () => {
    // Arrange: same as above but the capability is removed entirely (undefined).
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);
    const { result, rerender } = renderHook(
      (props: UseVoiceDialogueSessionOptions) => useVoiceDialogueSession(props),
      { initialProps: h.options },
    );

    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });

    // Act: capability dropped to undefined (gateway unreachable mid-session).
    rerender({ ...h.options, capability: undefined });

    // Assert: teardown and leave were still called.
    expect(recorder.cancel).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalled();
  });

  it("onStop() while in the permission window marks the capture as cancelled (deferred release)", async () => {
    // Arrange: deferred recorder so onStop() fires before the mic grant resolves.
    const deferred = makeDeferredRecorder();
    const h = buildHarness(deferred);
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));

    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    // The hook is in the requesting phase (permission window open).

    // Act: the user taps Stop before the browser resolves the permission dialog.
    act(() => result.current.onStop());
    expect(h.onLeave).toHaveBeenCalledTimes(1);

    // Now the browser grants mic access after the session is already stopped.
    await act(async () => {
      deferred.resolveStart(deferred.session);
      await Promise.resolve();
    });

    // Assert: the granted session was immediately cancelled (cancelledRef was set by teardown →
    // dictation.cancel(), which flows through useDictation.cancel() setting cancelledRef=true).
    // The mic must not have been kept open for a session that was already stopped.
    expect(deferred.cancel).toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
  });
});

// ─── Waitfor helper for the two-tap send path ────────────────────────────────────────────────────
// Exercises the full turn loop: onListen (start) → onListen (stop → transcribe → preview → send).
// Included here to prove the mic is released after the send path too (no leak on normal completion).
describe("useVoiceDialogueSession.miclifecycle — mic released after normal turn completion", () => {
  it("completing a full spoken turn leaves the dictation in idle (mic not held open)", async () => {
    const recorder = makeImmediateRecorder();
    const h = buildHarness(recorder);
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));

    // Start a turn.
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    expect(result.current.listening).toBe(true);

    // End the turn (second tap → stop → transcribe → preview → user-end-of-turn → send).
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.listening).toBe(false));
    // Assert: the session's stop() was invoked (clip produced) and cancel() was NOT called on the
    // session (stop and cancel are mutually exclusive — a completed turn calls stop, not cancel).
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.cancel).not.toHaveBeenCalled();
  });
});
