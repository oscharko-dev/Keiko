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
  type DictationSession,
} from "./dictation-recorder";
import type { VoiceActivityDetector, VoiceActivityEvent } from "./voice-activity-detector";
import { ApiError } from "@/lib/api";
import type { VoiceTranscriptionResult } from "@/lib/api";

interface FakeRecorder {
  readonly recorder: DictationRecorder;
  readonly session: { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  readonly start: ReturnType<typeof vi.fn>;
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
  const session: DictationSession = { stop, cancel };
  const start = vi.fn(async (): Promise<DictationSession> => {
    if (opts.startError !== undefined) throw opts.startError;
    return session;
  });
  return { recorder: { start }, session: { stop, cancel }, start };
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
    cancel: vi.fn(),
  };
  return { recorder: { start: vi.fn(async () => session) }, stop };
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

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("preview"));
    expect(result.current.transcript).toBe("hello world");

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
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder }),
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
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder.recorder }),
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
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder.recorder, transcribe }),
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
      useDictation({ onInsert, createRecorder: () => recorder.recorder, transcribe }),
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
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder }),
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
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder }),
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
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder.recorder }),
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
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(fake.started()).toBe(true);

    // A trailing silence ends the turn automatically — same path as a manual stop.
    act(() => fake.fire("end-of-turn"));
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fake.stopped()).toBe(true); // the analyser is released when the turn ends
  });

  it("ignores speech-onset (only a trailing silence ends the turn)", async () => {
    const { recorder, stop } = makeStreamingRecorder();
    const fake = makeFakeVad();
    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder, vad: fake.vad }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => fake.fire("speech-onset"));
    expect(result.current.phase).toBe("recording"); // still capturing
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not attach a VAD when none is provided (composer dictation stays manual)", async () => {
    const { recorder } = makeStreamingRecorder();
    const fake = makeFakeVad();
    const { result } = renderHook(() =>
      useDictation({ onInsert: vi.fn(), createRecorder: () => recorder }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(fake.started()).toBe(false);
  });
});
