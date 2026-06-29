// Issue #495, Epic #491 — the controlled composer dictation state machine.
//
// `useDictation` orchestrates one short dictation clip: request microphone access, record, transcribe
// through the local BFF speech-to-text route, then present an editable transcript the user reviews
// before inserting it into the composer draft. It owns no hardware itself — capture lives behind the
// injectable `DictationRecorder` seam (dictation-recorder.ts) and transcription behind the
// `transcribeDictation` client — so the hook and its tests never depend on real media APIs.
//
// Capture begins ONLY in response to an explicit `start()` call wired to a user gesture (AC3); there
// is no background capture. Every failure (permission denied, unsupported browser, provider error)
// resolves to a non-blocking `error` phase that leaves the composer fully usable (AC4). The audio and
// transcript live only in React state for the lifetime of the flow and are never logged.

import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError, transcribeDictation } from "@/lib/api";
import type { VoiceTranscriptionRequest, VoiceTranscriptionResult } from "@/lib/api";
import {
  createBrowserDictationRecorder,
  DictationRecorderError,
  type DictationRecorder,
  type DictationSession,
  type DictationStartFailure,
} from "./dictation-recorder";
import type { VoiceActivityDetector, VoiceActivityMonitor } from "./voice-activity-detector";

// Upper bound on a single dictation clip, matching the BFF's MAX_DICTATION_MS (voice-handlers.ts).
// Recording auto-stops at this point so a clip can never exceed the server's accepted duration.
const MAX_DICTATION_MS = 120_000;

// The lifecycle phase the composer renders from.
export type DictationPhase =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "preview"
  | "error";

// Why dictation could not complete. Recorder failures plus the two transcription outcomes.
export type DictationErrorReason =
  | DictationStartFailure // permission-denied | no-microphone | unsupported | capture-failed
  | "unavailable" // the BFF reports speech-to-text is not available (VOICE_UNAVAILABLE)
  | "transcribe-failed"; // the provider could not transcribe (rate-limited / timeout / provider error)

interface DictationState {
  readonly phase: DictationPhase;
  readonly transcript: string;
  readonly errorReason: DictationErrorReason | undefined;
  readonly errorMessage: string | undefined;
}

const INITIAL_STATE: DictationState = {
  phase: "idle",
  transcript: "",
  errorReason: undefined,
  errorMessage: undefined,
};

type DictationAction =
  | { readonly type: "requesting" }
  | { readonly type: "recording" }
  | { readonly type: "transcribing" }
  | { readonly type: "preview"; readonly transcript: string }
  | { readonly type: "editTranscript"; readonly value: string }
  | { readonly type: "error"; readonly reason: DictationErrorReason; readonly message: string }
  | { readonly type: "reset" };

// Pure transition function — no side effects, fully unit-testable. Each case is linear so the
// reducer stays well under the cyclomatic-complexity gate.
function dictationReducer(state: DictationState, action: DictationAction): DictationState {
  switch (action.type) {
    case "requesting":
      return { ...INITIAL_STATE, phase: "requesting" };
    case "recording":
      return { ...INITIAL_STATE, phase: "recording" };
    case "transcribing":
      return { ...INITIAL_STATE, phase: "transcribing" };
    case "preview":
      return { ...INITIAL_STATE, phase: "preview", transcript: action.transcript };
    case "editTranscript":
      return { ...state, transcript: action.value };
    case "error":
      return {
        ...INITIAL_STATE,
        phase: "error",
        errorReason: action.reason,
        errorMessage: action.message,
      };
    case "reset":
      return INITIAL_STATE;
  }
}

export interface UseDictationOptions {
  // Appends the reviewed transcript into the composer draft. The hook never sends — insertion is the
  // terminal action, after which the user sends through the normal composer flow.
  readonly onInsert: (text: string) => void;
  // Optional BCP-47 hint forwarded to the provider.
  readonly language?: string | undefined;
  // Optional voice-activity detector. When provided (dialogue mode), the recording stream is monitored
  // and a trailing silence after detected speech auto-stops the turn — the hands-free end-of-turn that
  // removes the manual second mic tap. Omitted (composer dictation) keeps capture fully manual.
  readonly vad?: VoiceActivityDetector | undefined;
  // Test seams: inject a fake recorder factory / transcribe client. Production uses the browser
  // recorder and the BFF client.
  readonly createRecorder?: (() => DictationRecorder) | undefined;
  readonly transcribe?:
    | ((input: VoiceTranscriptionRequest) => Promise<VoiceTranscriptionResult>)
    | undefined;
}

export interface DictationController {
  readonly phase: DictationPhase;
  readonly transcript: string;
  readonly error: { readonly reason: DictationErrorReason; readonly message: string } | undefined;
  // True while the microphone is live or a transcription is in flight (mic must show a stop affordance).
  readonly busy: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
  readonly retry: () => void;
  readonly discard: () => void;
  readonly insert: () => void;
  readonly setTranscript: (value: string) => void;
}

// Maps a thrown error from the capture or transcription step to a non-blocking error phase.
function classifyError(error: unknown): { reason: DictationErrorReason; message: string } {
  if (error instanceof DictationRecorderError) {
    return { reason: error.reason, message: error.message };
  }
  if (error instanceof ApiError) {
    // The BFF reports the disabled state as VOICE_UNAVAILABLE; every other coded failure is a
    // provider/transcription error. ApiError.message is already a static, secret-free string.
    const reason: DictationErrorReason =
      error.code === "VOICE_UNAVAILABLE" ? "unavailable" : "transcribe-failed";
    return { reason, message: error.message };
  }
  return { reason: "capture-failed", message: "Dictation could not be completed." };
}

function buildTranscribeRequest(
  capture: { audioBase64: string; mimeType: string; durationMs: number },
  language: string | undefined,
): VoiceTranscriptionRequest {
  const durationMs =
    Number.isInteger(capture.durationMs) &&
    capture.durationMs > 0 &&
    capture.durationMs <= MAX_DICTATION_MS
      ? capture.durationMs
      : undefined;
  return {
    audio: capture.audioBase64,
    mimeType: capture.mimeType,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(language !== undefined ? { language } : {}),
  };
}

export function useDictation(options: UseDictationOptions): DictationController {
  const { onInsert, language } = options;
  const [state, dispatch] = useReducer(dictationReducer, INITIAL_STATE);

  // Stable refs for the injectable seams and the live session/timer so the action callbacks stay
  // referentially stable and the reducer stays pure.
  const recorderFactory = options.createRecorder ?? createBrowserDictationRecorder;
  const transcribe = options.transcribe ?? transcribeDictation;
  const vad = options.vad;
  const recorderRef = useRef<DictationRecorder | undefined>(undefined);
  const sessionRef = useRef<DictationSession | undefined>(undefined);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The live voice-activity monitor for the current recording (dialogue mode only). Released whenever
  // the recording ends so the WebAudio analyser never outlives the stream.
  const vadMonitorRef = useRef<VoiceActivityMonitor | undefined>(undefined);
  // Guards every state update that runs after an `await`, so a composer that unmounts mid-flow (e.g.
  // while permission is pending or a transcription is in flight) never dispatches onto an unmounted
  // component, never leaks the auto-stop timer, and never leaves the microphone open.
  const mountedRef = useRef(true);
  // True while a `start()` is awaiting its `getUserMedia` grant (the permission window) but before a
  // session exists. `sessionRef` only becomes set once the grant resolves, so this in-flight flag is
  // the synchronous guard that stops a second `start()` from opening a second microphone stream and
  // leaking the first track (AC2/AC3 — "no second getUserMedia open before the first is released").
  const startingRef = useRef(false);
  // Set when a `cancel()` (leave / stop dialog mode, retry) happens while a `start()` is still in the
  // permission window. A microphone grant that resolves after a cancel is then released instead of
  // establishing a session, so leaving voice mode mid-permission still releases the mic deterministically
  // (AC3 — "stopping or leaving dialog mode releases microphone resources deterministically").
  const cancelledRef = useRef(false);

  const clearAutoStop = useCallback((): void => {
    if (autoStopRef.current !== undefined) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = undefined;
    }
  }, []);

  const detachVad = useCallback((): void => {
    if (vadMonitorRef.current !== undefined) {
      vadMonitorRef.current.stop();
      vadMonitorRef.current = undefined;
    }
  }, []);

  const stop = useCallback((): void => {
    const session = sessionRef.current;
    if (session === undefined) {
      return;
    }
    sessionRef.current = undefined;
    clearAutoStop();
    detachVad();
    dispatch({ type: "transcribing" });
    void session
      .stop()
      .then((capture) => transcribe(buildTranscribeRequest(capture, language)))
      .then((result) => {
        if (!mountedRef.current) return;
        dispatch({ type: "preview", transcript: result.transcript });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const { reason, message } = classifyError(error);
        dispatch({ type: "error", reason, message });
      });
  }, [clearAutoStop, detachVad, language, transcribe]);

  const start = useCallback((): void => {
    // Never open a second microphone stream: bail if a session is already live OR a start() is still
    // in flight. Because `sessionRef` is only set after getUserMedia resolves, the in-flight guard is
    // what closes the same-tick double-start race (a second start() during the permission window).
    if (sessionRef.current !== undefined || startingRef.current) {
      return;
    }
    startingRef.current = true;
    cancelledRef.current = false;
    dispatch({ type: "requesting" });
    const recorder = (recorderRef.current ??= recorderFactory());
    void recorder.start().then(
      (session) => {
        startingRef.current = false;
        // If the composer unmounted OR the flow was cancelled (left/stopped dialog mode) while
        // permission was pending, release the just-granted microphone immediately and touch no state —
        // leaving voice mode mid-permission must still release the mic deterministically (AC3).
        if (!mountedRef.current || cancelledRef.current) {
          session.cancel();
          return;
        }
        sessionRef.current = session;
        dispatch({ type: "recording" });
        autoStopRef.current = setTimeout(() => stop(), MAX_DICTATION_MS);
        // Dialogue mode: monitor the live capture stream so a trailing silence after speech ends the
        // turn automatically (hands-free). end-of-turn drives the same stop() as a manual mic tap.
        if (vad !== undefined && session.stream !== undefined) {
          vadMonitorRef.current = vad.start(session.stream, (event) => {
            if (event === "end-of-turn") {
              stop();
            }
          });
        }
      },
      (error: unknown) => {
        startingRef.current = false;
        if (!mountedRef.current) return;
        const { reason, message } = classifyError(error);
        dispatch({ type: "error", reason, message });
      },
    );
  }, [recorderFactory, stop, vad]);

  const cancel = useCallback((): void => {
    // Mark any in-flight start() as cancelled so a microphone grant that resolves after this call is
    // released by its own resolve branch instead of establishing a session (AC3 — deterministic release
    // even when the user leaves dialog mode mid-permission).
    cancelledRef.current = true;
    clearAutoStop();
    detachVad();
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
    dispatch({ type: "reset" });
  }, [clearAutoStop, detachVad]);

  const discard = useCallback((): void => {
    cancel();
  }, [cancel]);

  const retry = useCallback((): void => {
    cancel();
    start();
  }, [cancel, start]);

  const insert = useCallback((): void => {
    const text = state.transcript.trim();
    if (text.length > 0) {
      onInsert(text);
    }
    dispatch({ type: "reset" });
  }, [onInsert, state.transcript]);

  const setTranscript = useCallback((value: string): void => {
    dispatch({ type: "editTranscript", value });
  }, []);

  // Release the microphone and timer if the composer unmounts mid-flow. Clearing both refs ensures a
  // late-firing auto-stop or a settling start/stop promise finds no live session and dispatches
  // nothing. `mountedRef` is re-armed on mount so a StrictMode remount stays functional.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (autoStopRef.current !== undefined) {
        clearTimeout(autoStopRef.current);
        autoStopRef.current = undefined;
      }
      if (vadMonitorRef.current !== undefined) {
        vadMonitorRef.current.stop();
        vadMonitorRef.current = undefined;
      }
      sessionRef.current?.cancel();
      sessionRef.current = undefined;
    };
  }, []);

  return {
    phase: state.phase,
    transcript: state.transcript,
    error:
      state.errorReason !== undefined && state.errorMessage !== undefined
        ? { reason: state.errorReason, message: state.errorMessage }
        : undefined,
    busy: state.phase === "recording" || state.phase === "transcribing",
    start,
    stop,
    cancel,
    retry,
    discard,
    insert,
    setTranscript,
  };
}
