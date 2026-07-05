// Issue #495 — the dictation state machine. Drives the real hook with an injected fake recorder and a
// mocked transcribe client (the recorder seam means no real getUserMedia / MediaRecorder is touched),
// covering the five required states: enabled (record → transcribe → preview → insert), denied,
// provider-error, unavailable, and unsupported — plus discard, re-record, cancel, and the
// max-duration auto-stop.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDictation } from "./useDictation";
import {
  DictationRecorderError,
  type DictationCapture,
  type DictationRecorder,
  type DictationRecorderStartOptions,
  type DictationSession,
} from "./dictation-recorder";
import type { VoiceActivityDetector, VoiceActivityEvent } from "./voice-activity-detector";
import { ApiError } from "@/lib/api";
import type { VoiceTranscriptionResult } from "@/lib/api";
import { VoiceLiveDictationControlError } from "./voice-live-dictation-client";
import type { VoiceLiveDictationControlClient } from "./voice-live-dictation-client";
import type { VoiceRtcSession, VoiceRtcTransport } from "./voice-rtc-transport";

interface FakeRecorder {
  readonly recorder: DictationRecorder;
  readonly session: {
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    requestData: ReturnType<typeof vi.fn>;
  };
  readonly start: ReturnType<typeof vi.fn>;
  readonly startOptions: () => DictationRecorderStartOptions | undefined;
}

function makeRecorder(opts: {
  startError?: unknown;
  stopError?: unknown;
  capture?: DictationCapture;
}): FakeRecorder {
  const capture: DictationCapture = opts.capture ?? {
    audioBase64: "QUJDRA==",
    mimeType: "audio/webm",
    durationMs: 1500,
  };
  const stop = vi.fn(async (): Promise<DictationCapture> => {
    if (opts.stopError !== undefined) throw opts.stopError;
    return capture;
  });
  const cancel = vi.fn();
  const requestData = vi.fn();
  const session: DictationSession = { stop, cancel, requestData };
  let capturedStartOptions: DictationRecorderStartOptions | undefined;
  const start = vi.fn(
    async (options?: DictationRecorderStartOptions): Promise<DictationSession> => {
      capturedStartOptions = options;
      if (opts.startError !== undefined) throw opts.startError;
      return session;
    },
  );
  return {
    recorder: { start },
    session: { stop, cancel, requestData },
    start,
    startOptions: () => capturedStartOptions,
  };
}

// A fake VAD: captures the onEvent callback so the test can fire scripted activity, and records that
// the monitor was started/stopped. No WebAudio.
function makeFakeVad(): {
  vad: VoiceActivityDetector;
  fire: (event: VoiceActivityEvent) => void;
  started: () => boolean;
  stopped: () => boolean;
} {
  let onEvent: ((event: VoiceActivityEvent) => void) | undefined;
  let didStart = false;
  let didStop = false;
  const vad: VoiceActivityDetector = {
    start(_stream, cb) {
      didStart = true;
      onEvent = cb;
      return {
        stop() {
          didStop = true;
        },
      };
    },
  };
  return {
    vad,
    fire: (event) => onEvent?.(event),
    started: () => didStart,
    stopped: () => didStop,
  };
}

// A recorder whose session exposes a (fake) stream, so the VAD can attach.
function makeStreamingRecorder(): { recorder: DictationRecorder; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async (): Promise<DictationCapture> => ({
    audioBase64: "QQ==",
    mimeType: "audio/webm",
    durationMs: 800,
  }));
  const session: DictationSession = {
    stream: { getTracks: () => [] } as unknown as MediaStream,
    stop,
    requestData: vi.fn(),
    cancel: vi.fn(),
  };
  return { recorder: { start: vi.fn(async () => session) }, stop };
}

function makeRealtimeDictationFakes(
  opts: {
    negotiateError?: unknown;
    applyAnswerError?: unknown;
  } = {},
): {
  transport: VoiceRtcTransport;
  control: VoiceLiveDictationControlClient;
  session: VoiceRtcSession;
  connect: ReturnType<typeof vi.fn>;
  negotiate: ReturnType<typeof vi.fn>;
  applyAnswer: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  closeControl: ReturnType<typeof vi.fn>;
  sendDataChannelEvent: ReturnType<typeof vi.fn>;
  emitDataChannelEvent: (event: unknown) => void;
} {
  let onDataChannelEvent: ((event: unknown) => void) | undefined;
  const applyAnswer = vi.fn(async (): Promise<void> => {
    if (opts.applyAnswerError !== undefined) throw opts.applyAnswerError;
  });
  const closeSession = vi.fn();
  const sendDataChannelEvent = vi.fn(() => true);
  const session: VoiceRtcSession = {
    offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    applyAnswer,
    onRemoteTrack: vi.fn(),
    onConnectionStateChange: vi.fn(),
    onLocalVoiceActivity: vi.fn(),
    onDataChannelStateChange: vi.fn(),
    onDataChannelEvent(cb) {
      onDataChannelEvent = cb;
    },
    sendDataChannelEvent,
    close: closeSession,
  };
  const connect = vi.fn(async (): Promise<VoiceRtcSession> => session);
  const negotiate = vi.fn(async (): Promise<string> => {
    if (opts.negotiateError !== undefined) throw opts.negotiateError;
    return "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  });
  const closeControl = vi.fn();
  return {
    transport: { connect },
    control: { negotiate, close: closeControl },
    session,
    connect,
    negotiate,
    applyAnswer,
    closeSession,
    closeControl,
    sendDataChannelEvent,
    emitDataChannelEvent: (event) => onDataChannelEvent?.(event),
  };
}

function setup(opts: {
  recorder: FakeRecorder;
  transcribe?: (req: unknown) => Promise<VoiceTranscriptionResult>;
  onInsert?: (text: string) => void;
  language?: string;
}): {
  result: { current: ReturnType<typeof useDictation> };
  onInsert: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
} {
  const onInsert = opts.onInsert ? vi.fn(opts.onInsert) : vi.fn();
  const transcribe = vi.fn(
    opts.transcribe ??
      (async (): Promise<VoiceTranscriptionResult> => ({ transcript: "hello world" })),
  );
  const { result } = renderHook(() =>
    useDictation({
      onInsert,
      createRecorder: () => opts.recorder.recorder,
      transcribe,
      postRollMs: 0,
      ...(opts.language !== undefined ? { language: opts.language } : {}),
    }),
  );
  return { result, onInsert, transcribe };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useDictation — enabled happy path (AC2)", () => {
  it("records, transcribes, previews, edits, and inserts the transcript", async () => {
    const recorder = makeRecorder({});
    const { result, onInsert, transcribe } = setup({ recorder, language: "en" });

    expect(result.current.phase).toBe("idle");

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(result.current.busy).toBe(true);
    expect(recorder.startOptions()?.timesliceMs).toBe(250);
    expect(typeof recorder.startOptions()?.onAudioLevel).toBe("function");

    act(() => result.current.stop());
    expect(result.current.phase).toBe("finalizing");
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    expect(result.current.transcript).toBe("hello world");
    expect(recorder.session.requestData).toHaveBeenCalledTimes(1);

    // The audio + content-free metadata are forwarded to the BFF client.
    expect(transcribe).toHaveBeenCalledWith({
      audio: "QUJDRA==",
      mimeType: "audio/webm",
      durationMs: 1500,
      language: "en",
    });

    // Edit then insert: the edited text is what reaches the composer; the flow resets to idle.
    act(() => result.current.setTranscript("hello world, edited"));
    expect(result.current.transcript).toBe("hello world, edited");

    act(() => result.current.insert());
    expect(onInsert).toHaveBeenCalledWith("hello world, edited");
    expect(result.current.phase).toBe("idle");
  });

  it("omits durationMs when it exceeds the dictation limit", async () => {
    const recorder = makeRecorder({
      capture: { audioBase64: "QUJDRA==", mimeType: "audio/webm", durationMs: 999_999 },
    });
    const { result, transcribe } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    expect(transcribe).toHaveBeenCalledWith({ audio: "QUJDRA==", mimeType: "audio/webm" });
  });

  it("updates content-free microphone level feedback while recording", async () => {
    const recorder = makeRecorder({});
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => recorder.startOptions()?.onAudioLevel?.(0.5));

    expect(result.current.audioLevel).toBe(0.5);
    expect(result.current.heardSpeech).toBe(true);
  });

  it("stays not-ready until the recorder signals the first live sample (onReady)", async () => {
    const recorder = makeRecorder({});
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    // Recording, but capture not yet verified live — the UI shows "Preparing mic".
    expect(result.current.micReady).toBe(false);

    act(() => recorder.startOptions()?.onReady?.());
    expect(result.current.micReady).toBe(true);
  });

  it("emits content-free latency marks and derived legs across the capture round trip", async () => {
    const onMark = vi.fn();
    const onLeg = vi.fn();
    const recorder = makeRecorder({});
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        createRecorder: () => recorder.recorder,
        transcribe: async (): Promise<VoiceTranscriptionResult> => ({ transcript: "hello world" }),
        postRollMs: 0,
        latencySink: { onMark, onLeg },
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => recorder.startOptions()?.onReady?.());
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));

    const markNames = onMark.mock.calls.map((call) => call[0].mark);
    expect(markNames).toEqual(
      expect.arrayContaining([
        "mic_click",
        "media_recorder_start",
        "first_audio_level",
        "stop_pressed",
        "postroll_done",
        "upload_start",
        "upload_end",
        "stt_final",
      ]),
    );

    // Every mark sample carries ONLY the enum literal and an integer timestamp — the privacy contract.
    for (const call of onMark.mock.calls) {
      expect(Object.keys(call[0]).sort()).toEqual(["atMs", "mark"]);
      expect(typeof call[0].atMs).toBe("number");
    }

    // The capture-readiness leg (swallowed-first-words window) is derived and content-free.
    const readinessLeg = onLeg.mock.calls
      .map((call) => call[0])
      .find((leg) => leg.to === "first_audio_level");
    expect(readinessLeg).toMatchObject({ from: "mic_click", to: "first_audio_level" });
    expect(typeof readinessLeg.ms).toBe("number");
  });

  it("stays in requesting until the recorder start promise resolves", async () => {
    let resolveStart: (session: DictationSession) => void = () => {};
    const session: DictationSession = {
      stop: vi.fn(async () => ({
        audioBase64: "QUJDRA==",
        mimeType: "audio/webm",
        durationMs: 500,
      })),
      cancel: vi.fn(),
    };
    const recorder: DictationRecorder = {
      start: vi.fn(
        () =>
          new Promise<DictationSession>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    };

    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder, postRollMs: 0 }),
    );

    act(() => result.current.start());
    expect(result.current.phase).toBe("requesting");

    await act(async () => {
      resolveStart(session);
      await Promise.resolve();
    });

    expect(result.current.phase).toBe("recording");
  });
});

describe("useDictation — review actions", () => {
  it("discard clears the transcript without inserting", async () => {
    const recorder = makeRecorder({});
    const { result, onInsert } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));

    act(() => result.current.discard());
    expect(result.current.phase).toBe("idle");
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("does not insert a whitespace-only transcript", async () => {
    const recorder = makeRecorder({});
    const { result, onInsert } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    act(() => result.current.setTranscript("   "));
    act(() => result.current.insert());
    expect(onInsert).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("re-record cancels the current session and starts a fresh one", async () => {
    const recorder = makeRecorder({});
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(recorder.start).toHaveBeenCalledTimes(2);
  });

  it("cancel stops the live session and returns to idle (AC3 — stops visibly)", async () => {
    const recorder = makeRecorder({});
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.cancel());
    expect(recorder.session.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
  });
});

describe("useDictation — error states (AC4 / AC6)", () => {
  it("maps a denied permission to a non-blocking error", async () => {
    const recorder = makeRecorder({
      startError: new DictationRecorderError("permission-denied", "denied"),
    });
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("permission-denied");
  });

  it("maps an unsupported browser to an error", async () => {
    const recorder = makeRecorder({
      startError: new DictationRecorderError("unsupported", "no MediaRecorder"),
    });
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("unsupported");
  });

  it("maps VOICE_UNAVAILABLE to the unavailable reason", async () => {
    const recorder = makeRecorder({});
    const transcribe = async (): Promise<VoiceTranscriptionResult> => {
      throw new ApiError("VOICE_UNAVAILABLE", "Speech-to-text is not available.", 503);
    };
    const { result } = setup({ recorder, transcribe });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("unavailable");
  });

  it("maps a provider failure to transcribe-failed with the redacted message", async () => {
    const recorder = makeRecorder({});
    const transcribe = async (): Promise<VoiceTranscriptionResult> => {
      throw new ApiError("VOICE_PROVIDER_ERROR", "Could not transcribe the audio.", 502);
    };
    const { result } = setup({ recorder, transcribe });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("transcribe-failed");
    expect(result.current.error?.message).toBe("Could not transcribe the audio.");
  });

  it("retry from an error re-records", async () => {
    const recorder = makeRecorder({
      startError: new DictationRecorderError("capture-failed", "boom"),
    });
    const { result } = setup({ recorder });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    // Now allow start to succeed on retry.
    recorder.start.mockImplementation(async () => recorder.session as unknown as DictationSession);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
  });
});

describe("useDictation — unmount safety (no dispatch / no mic left open)", () => {
  it("cancels a late-resolving start and touches no state after unmount", async () => {
    let resolveStart: (session: DictationSession) => void = () => {};
    const cancel = vi.fn();
    const session: DictationSession = { stop: vi.fn(), cancel };
    const recorder: DictationRecorder = {
      start: vi.fn(
        () =>
          new Promise<DictationSession>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    };
    const { result, unmount } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder, postRollMs: 0 }),
    );
    act(() => result.current.start());
    unmount();
    // Permission resolves only after the composer unmounted: the mic must be released, no dispatch.
    await act(async () => {
      resolveStart(session);
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the live session when unmounted while recording", async () => {
    const recorder = makeRecorder({});
    const { result, unmount } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder.recorder, postRollMs: 0 }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    unmount();
    expect(recorder.session.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not throw when a transcription resolves after unmount", async () => {
    const recorder = makeRecorder({});
    let resolveTranscribe: (value: VoiceTranscriptionResult) => void = () => {};
    const transcribe = vi.fn(
      () =>
        new Promise<VoiceTranscriptionResult>((resolve) => {
          resolveTranscribe = resolve;
        }),
    );
    const { result, unmount } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        createRecorder: () => recorder.recorder,
        transcribe,
        postRollMs: 0,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolveTranscribe({ transcript: "late transcript" });
      await Promise.resolve();
    });
    // No "state update on unmounted component" — the guard short-circuits the dispatch.
    expect(true).toBe(true);
  });
});

describe("useDictation — capture bounds", () => {
  it("auto-stops recording at the dictation limit", async () => {
    vi.useFakeTimers();
    const recorder = makeRecorder({});
    const onInsert = vi.fn();
    const transcribe = vi.fn(async (): Promise<VoiceTranscriptionResult> => ({ transcript: "x" }));
    const { result } = renderHook(() =>
      useDictation({
        onInsert,
        createRecorder: () => recorder.recorder,
        transcribe,
        postRollMs: 0,
      }),
    );
    act(() => result.current.start());
    // Flush the microtasks that resolve recorder.start().
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("recording");
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(recorder.session.stop).toHaveBeenCalledTimes(1);
  });
});

// ─── Issue #1562 — microphone permission-window safety ──────────────────────────────────────────
//
// Regression suite for the `startingRef` + `cancelledRef` guards added to `useDictation` as part of
// Issue #1562 (security/privacy hardening). These tests are structured so they would FAIL if either
// guard were removed:
//
//   - `startingRef` prevents a second `getUserMedia` from opening during the permission window (AC2).
//   - `cancelledRef` ensures a mic grant that arrives after `cancel()` is released instead of
//     establishing a session (AC3 — deterministic release even mid-permission).
//
// The browser-layer invariants (getUserMedia → track.stop on cancel) are proven at the
// `createBrowserDictationRecorder` level in `dictation-recorder.test.ts`; this suite covers the
// dictation-state-machine layer above it.
describe("useDictation — microphone permission-window safety (Issue #1562)", () => {
  it("double-start race: a second start() during the permission window opens only one recorder session", async () => {
    // Arrange: a recorder whose start() returns a manually-controlled deferred promise so we can
    // call start() a second time before the first permission grant resolves.
    let resolveFirst: (session: DictationSession) => void = () => {};
    const cancel = vi.fn();
    const session: DictationSession = {
      stop: vi.fn(async () => ({
        audioBase64: "QUJDRA==",
        mimeType: "audio/webm",
        durationMs: 500,
      })),
      cancel,
    };
    const startSpy = vi.fn(
      () =>
        new Promise<DictationSession>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const recorder: DictationRecorder = { start: startSpy };

    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder, postRollMs: 0 }),
    );

    // Act: two synchronous start() calls before the permission window resolves.
    act(() => {
      result.current.start();
      result.current.start(); // must be a no-op: startingRef is already true
    });

    // Resolve the pending permission grant.
    await act(async () => {
      resolveFirst(session);
      await Promise.resolve();
    });

    // Assert: recorder.start() was invoked exactly once — the second start() hit the guard and
    // returned immediately. Without startingRef this would be called twice, opening two mic streams.
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("recording");
  });

  it("cancel during permission window releases the granted mic and never reaches recording", async () => {
    // Arrange: a recorder whose start() is deferred so cancel() can be called while the permission
    // request is still pending (the user leaves dialog mode mid-permission).
    let resolveStart: (session: DictationSession) => void = () => {};
    const cancel = vi.fn();
    const session: DictationSession = { stop: vi.fn(), cancel };
    const recorder: DictationRecorder = {
      start: vi.fn(
        () =>
          new Promise<DictationSession>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    };

    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder, postRollMs: 0 }),
    );

    // Act: start() enters the permission window (requesting phase), then cancel() fires.
    act(() => result.current.start());
    expect(result.current.phase).toBe("requesting");

    act(() => result.current.cancel()); // sets cancelledRef = true; resets to idle
    expect(result.current.phase).toBe("idle");

    // Now the permission grant arrives — the resolve branch checks cancelledRef and must call
    // session.cancel() (releasing the mic) instead of establishing a session.
    await act(async () => {
      resolveStart(session);
      await Promise.resolve();
    });

    // Assert: the session was immediately cancelled (mic released), and the phase never became
    // "recording". Without cancelledRef the resolve branch would call dispatch({ type: "recording" })
    // and sessionRef.current would become set, leaking the mic track.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
  });

  it("cancel() while recording calls session.cancel() (mic released) and resets to idle", async () => {
    // Arrange: a standard fake recorder that resolves immediately.
    const recorder = makeRecorder({});
    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder.recorder, postRollMs: 0 }),
    );

    // Act: start → wait for recording phase → cancel.
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => result.current.cancel());

    // Assert: the live session was cancelled (OS-level "recording" indicator clears, AC3) and the
    // state machine returned to idle. Without the cancel() implementation touching sessionRef this
    // would leave the mic open and the phase non-idle.
    expect(recorder.session.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
    expect(result.current.busy).toBe(false);
  });
});

describe("useDictation — voice-activity end-of-turn (dialogue mode)", () => {
  it("attaches the VAD to the recording stream and auto-stops on end-of-turn (no second tap)", async () => {
    const { recorder, stop } = makeStreamingRecorder();
    const fake = makeFakeVad();
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        createRecorder: () => recorder,
        transcribe: vi.fn(async (): Promise<VoiceTranscriptionResult> => ({ transcript: "done" })),
        vad: fake.vad,
        postRollMs: 0,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(fake.started()).toBe(true);

    // A trailing silence ends the turn automatically — same path as a manual stop.
    act(() => fake.fire("end-of-turn"));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    expect(fake.stopped()).toBe(true); // the analyser is released when the turn ends
  });

  it("ignores speech-onset (only a trailing silence ends the turn)", async () => {
    const { recorder, stop } = makeStreamingRecorder();
    const fake = makeFakeVad();
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        createRecorder: () => recorder,
        vad: fake.vad,
        postRollMs: 0,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => fake.fire("speech-onset"));
    expect(result.current.phase).toBe("recording"); // still capturing
    expect(result.current.heardSpeech).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not attach a VAD when none is provided (composer dictation stays manual)", async () => {
    const { recorder } = makeStreamingRecorder();
    const fake = makeFakeVad();
    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder, postRollMs: 0 }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(fake.started()).toBe(false);
  });
});

describe("useDictation — realtime live dictation (P3)", () => {
  it("renders live partials, commits the input buffer, and previews the final transcript", async () => {
    const fakes = makeRealtimeDictationFakes();
    const onMark = vi.fn();
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        realtime: {
          enabled: true,
          createTransport: () => fakes.transport,
          createControlClient: () => fakes.control,
        },
        latencySink: { onMark },
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    expect(result.current.mode).toBe("realtime");
    expect(fakes.connect).toHaveBeenCalledTimes(1);
    expect(fakes.negotiate).toHaveBeenCalledWith(fakes.session.offerSdp);
    expect(fakes.applyAnswer).toHaveBeenCalledTimes(1);

    act(() =>
      fakes.emitDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hello ",
      }),
    );
    expect(result.current.liveTranscript).toBe("hello ");

    act(() => result.current.stop());
    expect(result.current.phase).toBe("finalizing");
    expect(fakes.sendDataChannelEvent).toHaveBeenCalledWith({
      type: "input_audio_buffer.commit",
    });

    act(() =>
      fakes.emitDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello world",
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    expect(result.current.transcript).toBe("hello world");
    expect(result.current.finalizationNote).toBeUndefined();
    expect(fakes.closeSession).toHaveBeenCalledTimes(1);
    expect(fakes.closeControl).toHaveBeenCalledTimes(1);
    expect(onMark.mock.calls.map((call) => call[0].mark)).toEqual(
      expect.arrayContaining(["live_transcription_delta", "live_transcription_final"]),
    );
  });

  it("previews the accumulated partial with a note when no final event arrives", async () => {
    vi.useFakeTimers();
    const fakes = makeRealtimeDictationFakes();
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        realtime: {
          enabled: true,
          createTransport: () => fakes.transport,
          createControlClient: () => fakes.control,
        },
      }),
    );

    act(() => result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.phase).toBe("recording");

    act(() =>
      fakes.emitDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "partial text",
      }),
    );
    act(() => result.current.stop());
    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });

    expect(result.current.phase).toBe("preview");
    expect(result.current.transcript).toBe("partial text");
    expect(result.current.finalizationNote).toBe(
      "No final transcript arrived; review the live text before inserting.",
    );
  });

  it("cancel closes the realtime control client, peer connection, data channel, and mic tracks", async () => {
    const fakes = makeRealtimeDictationFakes();
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        realtime: {
          enabled: true,
          createTransport: () => fakes.transport,
          createControlClient: () => fakes.control,
        },
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.cancel());

    expect(fakes.closeSession).toHaveBeenCalledTimes(1);
    expect(fakes.closeControl).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");
  });

  it("clears a realtime session that resolves after cancel so dictation can start again", async () => {
    let resolveConnect: (session: VoiceRtcSession) => void = () => {};
    const pendingConnect = new Promise<VoiceRtcSession>((resolve) => {
      resolveConnect = resolve;
    });
    const fakes = makeRealtimeDictationFakes();
    const connect = vi.fn();
    connect.mockReturnValueOnce(pendingConnect);
    connect.mockResolvedValueOnce(fakes.session);
    const transport: VoiceRtcTransport = {
      connect: connect as VoiceRtcTransport["connect"],
    };
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        realtime: {
          enabled: true,
          createTransport: () => transport,
          createControlClient: () => fakes.control,
        },
      }),
    );

    act(() => result.current.start());
    expect(result.current.phase).toBe("requesting");
    act(() => result.current.cancel());

    await act(async () => {
      resolveConnect(fakes.session);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fakes.closeSession).toHaveBeenCalledTimes(1);
    expect(fakes.closeControl).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("idle");

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(fakes.negotiate).toHaveBeenCalledTimes(1);
  });

  it("retry falls back to the batch STT path after live negotiation fails", async () => {
    const fakes = makeRealtimeDictationFakes({
      negotiateError: new VoiceLiveDictationControlError("negotiation-failed", "failed"),
    });
    const recorder = makeRecorder({});
    const transcribe = vi.fn(async (): Promise<VoiceTranscriptionResult> => ({
      transcript: "batch transcript",
    }));
    const { result } = renderHook(() =>
      useDictation({
        onInsert: vi.fn(),
        createRecorder: () => recorder.recorder,
        transcribe,
        postRollMs: 0,
        realtime: {
          enabled: true,
          createTransport: () => fakes.transport,
          createControlClient: () => fakes.control,
        },
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error?.reason).toBe("transcribe-failed");
    expect(fakes.closeSession).toHaveBeenCalledTimes(1);
    expect(fakes.closeControl).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(result.current.mode).toBe("batch");
    expect(recorder.start).toHaveBeenCalledTimes(1);

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.current.transcript).toBe("batch transcript");
  });
});
