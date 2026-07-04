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

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
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
import {
  createBrowserVoiceLiveDictationControlClient,
  VoiceLiveDictationControlError,
  type VoiceLiveDictationControlClient,
} from "./voice-live-dictation-client";
import {
  createVoiceLatencyObserver,
  type VoiceLatencyObserver,
  type VoiceLatencyObserverSink,
} from "./voice-latency-observer";
import { parseRealtimeVoiceEvent } from "./voice-realtime-events";
import {
  createBrowserVoiceRtcTransport,
  VoiceRtcError,
  type VoiceRtcSession,
  type VoiceRtcTransport,
} from "./voice-rtc-transport";

// Upper bound on a single dictation clip, matching the BFF's MAX_DICTATION_MS (voice-handlers.ts).
// Recording auto-stops at this point so a clip can never exceed the server's accepted duration.
const MAX_DICTATION_MS = 120_000;
const DICTATION_POST_ROLL_MS = 350;
const DICTATION_CAPTURE_TIMESLICE_MS = 250;
const DICTATION_AUTO_STOP_MS = MAX_DICTATION_MS - DICTATION_POST_ROLL_MS;
const LIVE_TRANSCRIPTION_FINAL_TIMEOUT_MS = 4_000;
const HEARD_SPEECH_LEVEL = 0.12;

// The lifecycle phase the composer renders from.
export type DictationPhase =
  "idle" | "requesting" | "recording" | "finalizing" | "transcribing" | "preview" | "error";
export type DictationMode = "batch" | "realtime";

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
  readonly audioLevel: number;
  readonly heardSpeech: boolean;
  // True once the capture pipeline is verified live (MediaRecorder started AND the analyser produced a
  // first sample). While recording but not yet ready, the UI shows "Preparing mic" and does not invite
  // the user to speak — so the first words are not lost into a not-yet-capturing microphone.
  readonly micReady: boolean;
  readonly mode: DictationMode;
  readonly liveTranscript: string;
  readonly finalizationNote: string | undefined;
}

const INITIAL_STATE: DictationState = {
  phase: "idle",
  transcript: "",
  errorReason: undefined,
  errorMessage: undefined,
  audioLevel: 0,
  heardSpeech: false,
  micReady: false,
  mode: "batch",
  liveTranscript: "",
  finalizationNote: undefined,
};

type DictationAction =
  | { readonly type: "requesting"; readonly mode: DictationMode }
  | { readonly type: "recording" }
  | { readonly type: "finalizing" }
  | { readonly type: "transcribing" }
  | { readonly type: "audioLevel"; readonly level: number }
  | { readonly type: "micReady" }
  | { readonly type: "speechDetected" }
  | { readonly type: "liveTranscript"; readonly transcript: string }
  | {
      readonly type: "preview";
      readonly transcript: string;
      readonly note?: string | undefined;
    }
  | { readonly type: "editTranscript"; readonly value: string }
  | { readonly type: "error"; readonly reason: DictationErrorReason; readonly message: string }
  | { readonly type: "reset" };

// Pure transition function — no side effects, fully unit-testable. Each case is linear so the
// reducer stays well under the cyclomatic-complexity gate.
function dictationReducer(state: DictationState, action: DictationAction): DictationState {
  switch (action.type) {
    case "requesting":
      return { ...INITIAL_STATE, phase: "requesting", mode: action.mode };
    case "recording":
      return { ...INITIAL_STATE, phase: "recording", mode: state.mode };
    case "finalizing":
      return { ...state, phase: "finalizing", audioLevel: 0 };
    case "transcribing":
      return {
        ...INITIAL_STATE,
        phase: "transcribing",
        heardSpeech: state.heardSpeech,
        mode: state.mode,
        liveTranscript: state.liveTranscript,
      };
    case "audioLevel":
      return { ...state, audioLevel: action.level };
    case "micReady":
      return { ...state, micReady: true };
    case "speechDetected":
      return { ...state, heardSpeech: true };
    case "liveTranscript":
      return { ...state, liveTranscript: action.transcript };
    case "preview":
      return {
        ...INITIAL_STATE,
        phase: "preview",
        transcript: action.transcript,
        mode: state.mode,
        liveTranscript: state.liveTranscript,
        finalizationNote: action.note,
      };
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
    ((input: VoiceTranscriptionRequest) => Promise<VoiceTranscriptionResult>) | undefined;
  readonly realtime?:
    | {
        readonly enabled: boolean;
        readonly createTransport?: (() => VoiceRtcTransport) | undefined;
        readonly createControlClient?: (() => VoiceLiveDictationControlClient) | undefined;
      }
    | undefined;
  readonly postRollMs?: number | undefined;
  // Optional content-free latency sink (Plan §1). Receives only mark enum literals and millisecond
  // deltas across the capture round trip — never audio or transcript text.
  readonly latencySink?: VoiceLatencyObserverSink | undefined;
}

export interface DictationController {
  readonly phase: DictationPhase;
  readonly mode: DictationMode;
  readonly transcript: string;
  readonly liveTranscript: string;
  readonly finalizationNote: string | undefined;
  readonly error: { readonly reason: DictationErrorReason; readonly message: string } | undefined;
  readonly audioLevel: number;
  readonly heardSpeech: boolean;
  // True once capture is verified live; drives the "Preparing mic" → "Listening" handoff.
  readonly micReady: boolean;
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

function classifyRealtimeError(error: unknown): { reason: DictationErrorReason; message: string } {
  if (error instanceof VoiceRtcError) {
    const reason: DictationErrorReason =
      error.reason === "permission-denied" ||
      error.reason === "no-microphone" ||
      error.reason === "unsupported"
        ? error.reason
        : "transcribe-failed";
    return { reason, message: error.message };
  }
  if (error instanceof VoiceLiveDictationControlError) {
    const reason: DictationErrorReason =
      error.reason === "unavailable" ? "unavailable" : "transcribe-failed";
    return { reason, message: error.message };
  }
  return { reason: "transcribe-failed", message: "Live dictation could not be completed." };
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
  const realtimeEnabled = options.realtime?.enabled === true;
  const realtimeTransportFactory = useMemo(
    () => options.realtime?.createTransport ?? createBrowserVoiceRtcTransport,
    [options.realtime?.createTransport],
  );
  const liveControlClientFactory = useMemo(
    () =>
      options.realtime?.createControlClient ??
      (() => createBrowserVoiceLiveDictationControlClient(undefined, language)),
    [language, options.realtime?.createControlClient],
  );
  const vad = options.vad;
  const postRollMs = options.postRollMs ?? DICTATION_POST_ROLL_MS;
  // Content-free latency instrumentation. Created once; the sink proxy reads the latest option so the
  // observer identity stays stable across renders. Every mark below is a lifecycle event, never content.
  const latencySinkRef = useRef(options.latencySink);
  latencySinkRef.current = options.latencySink;
  const latencyRef = useRef<VoiceLatencyObserver | undefined>(undefined);
  const latency = (latencyRef.current ??= createVoiceLatencyObserver({
    sink: {
      onMark: (sample) => latencySinkRef.current?.onMark?.(sample),
      onLeg: (leg) => latencySinkRef.current?.onLeg?.(leg),
    },
  }));
  const recorderRef = useRef<DictationRecorder | undefined>(undefined);
  const sessionRef = useRef<DictationSession | undefined>(undefined);
  const realtimeSessionRef = useRef<VoiceRtcSession | undefined>(undefined);
  const realtimeControlRef = useRef<VoiceLiveDictationControlClient | undefined>(undefined);
  const realtimeStartAbortRef = useRef<AbortController | undefined>(undefined);
  const realtimeLiveTranscriptRef = useRef("");
  const realtimeFinalTranscriptRef = useRef<string | undefined>(undefined);
  const realtimeDeltaSeenRef = useRef(false);
  const realtimeFallbackToBatchRef = useRef(false);
  const realtimeFinalWaiterRef = useRef<
    | {
        readonly resolve: (result: { readonly text: string; readonly note?: string }) => void;
        readonly reject: (error: unknown) => void;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stoppingRef = useRef(false);
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

  const settleRealtimeFinal = useCallback(
    (result: { readonly text: string; readonly note?: string }): void => {
      const waiter = realtimeFinalWaiterRef.current;
      if (waiter === undefined) {
        return;
      }
      clearTimeout(waiter.timer);
      realtimeFinalWaiterRef.current = undefined;
      waiter.resolve(result);
    },
    [],
  );

  const rejectRealtimeFinal = useCallback((error: unknown): void => {
    const waiter = realtimeFinalWaiterRef.current;
    if (waiter === undefined) {
      return;
    }
    clearTimeout(waiter.timer);
    realtimeFinalWaiterRef.current = undefined;
    waiter.reject(error);
  }, []);

  const cleanupRealtime = useCallback((): void => {
    realtimeStartAbortRef.current?.abort();
    realtimeStartAbortRef.current = undefined;
    const waiter = realtimeFinalWaiterRef.current;
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      realtimeFinalWaiterRef.current = undefined;
    }
    realtimeControlRef.current?.close();
    realtimeControlRef.current = undefined;
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = undefined;
    realtimeLiveTranscriptRef.current = "";
    realtimeFinalTranscriptRef.current = undefined;
    realtimeDeltaSeenRef.current = false;
  }, []);

  const waitForRealtimeFinal = useCallback((): Promise<{
    readonly text: string;
    readonly note?: string;
  }> => {
    const finalText = realtimeFinalTranscriptRef.current?.trim();
    if (finalText !== undefined && finalText.length > 0) {
      return Promise.resolve({ text: finalText });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        realtimeFinalWaiterRef.current = undefined;
        const partial = realtimeLiveTranscriptRef.current.trim();
        if (partial.length > 0) {
          resolve({
            text: partial,
            note: "No final transcript arrived; review the live text before inserting.",
          });
          return;
        }
        reject(new Error("Live dictation did not produce a transcript."));
      }, LIVE_TRANSCRIPTION_FINAL_TIMEOUT_MS);
      realtimeFinalWaiterRef.current = { resolve, reject, timer };
    });
  }, []);

  const handleRealtimeDataChannelEvent = useCallback(
    (event: unknown): void => {
      const parsed = parseRealtimeVoiceEvent(event);
      if (parsed === undefined || !mountedRef.current || cancelledRef.current) {
        return;
      }
      if (parsed.kind === "user-transcript-delta") {
        realtimeLiveTranscriptRef.current += parsed.delta;
        if (!realtimeDeltaSeenRef.current) {
          realtimeDeltaSeenRef.current = true;
          latency.mark("live_transcription_delta");
          latency.mark("stt_first_delta");
        }
        dispatch({
          type: "liveTranscript",
          transcript: realtimeLiveTranscriptRef.current,
        });
        return;
      }
      if (parsed.kind === "user-transcript-committed") {
        const text = parsed.text.trim();
        if (text.length === 0) {
          return;
        }
        realtimeFinalTranscriptRef.current = text;
        realtimeLiveTranscriptRef.current = text;
        latency.mark("live_transcription_final");
        latency.mark("stt_final");
        dispatch({ type: "liveTranscript", transcript: text });
        settleRealtimeFinal({ text });
        return;
      }
      if (parsed.kind === "user-transcript-failed") {
        rejectRealtimeFinal(new Error(parsed.message));
      }
    },
    [latency, rejectRealtimeFinal, settleRealtimeFinal],
  );

  const stopBatch = useCallback((): void => {
    const session = sessionRef.current;
    if (session === undefined || stoppingRef.current) {
      return;
    }
    stoppingRef.current = true;
    latency.mark("stop_pressed");
    clearAutoStop();
    detachVad();
    session.requestData?.();
    dispatch({ type: "finalizing" });
    void new Promise<void>((resolve) => {
      setTimeout(resolve, postRollMs);
    })
      .then(() => {
        if (!mountedRef.current || sessionRef.current !== session) {
          return undefined;
        }
        latency.mark("postroll_done");
        sessionRef.current = undefined;
        dispatch({ type: "transcribing" });
        return session.stop();
      })
      .then((capture) => {
        if (capture === undefined) {
          return undefined;
        }
        latency.mark("upload_start");
        return transcribe(buildTranscribeRequest(capture, language));
      })
      .then((result) => {
        if (result === undefined) return;
        if (!mountedRef.current) return;
        // Batch STT: the response IS the final transcript, so upload_end and stt_final coincide.
        latency.mark("upload_end");
        latency.mark("stt_final");
        dispatch({ type: "preview", transcript: result.transcript });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const { reason, message } = classifyError(error);
        dispatch({ type: "error", reason, message });
      })
      .finally(() => {
        stoppingRef.current = false;
      });
  }, [clearAutoStop, detachVad, language, latency, postRollMs, transcribe]);

  const stopRealtime = useCallback((): void => {
    const session = realtimeSessionRef.current;
    if (session === undefined || stoppingRef.current) {
      return;
    }
    stoppingRef.current = true;
    latency.mark("stop_pressed");
    clearAutoStop();
    detachVad();
    dispatch({ type: "finalizing" });
    const committed =
      session.sendDataChannelEvent?.({
        type: "input_audio_buffer.commit",
      }) === true;
    if (!committed) {
      cleanupRealtime();
      stoppingRef.current = false;
      dispatch({
        type: "error",
        reason: "transcribe-failed",
        message: "Live dictation could not be finalized.",
      });
      return;
    }
    void waitForRealtimeFinal()
      .then((result) => {
        if (!mountedRef.current) return;
        dispatch({
          type: "preview",
          transcript: result.text,
          ...(result.note !== undefined ? { note: result.note } : {}),
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        const { reason, message } = classifyRealtimeError(error);
        dispatch({ type: "error", reason, message });
      })
      .finally(() => {
        cleanupRealtime();
        stoppingRef.current = false;
      });
  }, [cleanupRealtime, clearAutoStop, detachVad, latency, waitForRealtimeFinal]);

  const stop = useCallback((): void => {
    if (realtimeSessionRef.current !== undefined) {
      stopRealtime();
      return;
    }
    stopBatch();
  }, [stopBatch, stopRealtime]);

  const startBatch = useCallback((): void => {
    // Never open a second microphone stream: bail if a session is already live OR a start() is still
    // in flight. Because `sessionRef` is only set after getUserMedia resolves, the in-flight guard is
    // what closes the same-tick double-start race (a second start() during the permission window).
    if (
      sessionRef.current !== undefined ||
      realtimeSessionRef.current !== undefined ||
      startingRef.current
    ) {
      return;
    }
    startingRef.current = true;
    stoppingRef.current = false;
    cancelledRef.current = false;
    latency.reset();
    latency.mark("mic_click");
    dispatch({ type: "requesting", mode: "batch" });
    const recorder = (recorderRef.current ??= recorderFactory());
    void recorder
      .start({
        timesliceMs: DICTATION_CAPTURE_TIMESLICE_MS,
        onReady: () => {
          if (!mountedRef.current || cancelledRef.current) {
            return;
          }
          latency.mark("first_audio_level");
          dispatch({ type: "micReady" });
        },
        onAudioLevel: (level) => {
          if (!mountedRef.current || cancelledRef.current) {
            return;
          }
          dispatch({ type: "audioLevel", level });
          if (level >= HEARD_SPEECH_LEVEL) {
            dispatch({ type: "speechDetected" });
          }
        },
      })
      .then(
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
          latency.mark("media_recorder_start");
          dispatch({ type: "recording" });
          autoStopRef.current = setTimeout(() => stopBatch(), DICTATION_AUTO_STOP_MS);
          // Dialogue mode: monitor the live capture stream so a trailing silence after speech ends the
          // turn automatically (hands-free). end-of-turn drives the same stop() as a manual mic tap.
          if (vad !== undefined && session.stream !== undefined) {
            vadMonitorRef.current = vad.start(session.stream, (event) => {
              if (event === "speech-onset") {
                dispatch({ type: "speechDetected" });
                return;
              }
              if (event === "end-of-turn") {
                stopBatch();
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
  }, [latency, recorderFactory, stopBatch, vad]);

  const startRealtime = useCallback((): void => {
    if (
      sessionRef.current !== undefined ||
      realtimeSessionRef.current !== undefined ||
      startingRef.current
    ) {
      return;
    }
    startingRef.current = true;
    stoppingRef.current = false;
    cancelledRef.current = false;
    realtimeLiveTranscriptRef.current = "";
    realtimeFinalTranscriptRef.current = undefined;
    realtimeDeltaSeenRef.current = false;
    latency.reset();
    latency.mark("mic_click");
    dispatch({ type: "requesting", mode: "realtime" });
    const abort = new AbortController();
    realtimeStartAbortRef.current = abort;
    const transport = realtimeTransportFactory();
    const control = liveControlClientFactory();
    realtimeControlRef.current = control;

    void (async () => {
      const session = await transport.connect({ signal: abort.signal });
      realtimeSessionRef.current = session;
      latency.mark("permission_granted");
      latency.mark("rtc_offer_created");
      if (!mountedRef.current || cancelledRef.current) {
        startingRef.current = false;
        cleanupRealtime();
        return;
      }
      session.onDataChannelEvent?.(handleRealtimeDataChannelEvent);
      session.onDataChannelStateChange?.((state) => {
        if (state === "open") {
          latency.mark("datachannel_open");
        }
      });
      session.onConnectionStateChange?.((state) => {
        if (state === "connected") {
          latency.mark("rtc_connected");
        }
        if (state === "failed" || state === "closed" || state === "disconnected") {
          if (mountedRef.current && !cancelledRef.current && !stoppingRef.current) {
            dispatch({
              type: "error",
              reason: "transcribe-failed",
              message: "Live dictation connection was lost.",
            });
          }
        }
      });
      session.onLocalVoiceActivity?.((event) => {
        if (!mountedRef.current || cancelledRef.current) {
          return;
        }
        if (event === "speech-onset") {
          latency.mark("user_speech_start");
          dispatch({ type: "speechDetected" });
        }
      });
      const answerSdp = await control.negotiate(session.offerSdp);
      if (!mountedRef.current || cancelledRef.current) {
        startingRef.current = false;
        cleanupRealtime();
        return;
      }
      await session.applyAnswer(answerSdp);
      if (!mountedRef.current || cancelledRef.current) {
        startingRef.current = false;
        cleanupRealtime();
        return;
      }
      latency.mark("sdp_answer");
      latency.mark("first_audio_level");
      latency.mark("session_ready");
      startingRef.current = false;
      dispatch({ type: "recording" });
      dispatch({ type: "micReady" });
      autoStopRef.current = setTimeout(() => stopRealtime(), DICTATION_AUTO_STOP_MS);
    })().catch((error: unknown) => {
      startingRef.current = false;
      const shouldFallbackToBatch =
        error instanceof VoiceLiveDictationControlError ||
        (error instanceof VoiceRtcError &&
          (error.reason === "negotiation-failed" || error.reason === "connection-failed"));
      if (shouldFallbackToBatch) {
        realtimeFallbackToBatchRef.current = true;
      }
      cleanupRealtime();
      if (!mountedRef.current || cancelledRef.current) return;
      if (shouldFallbackToBatch) {
        dispatch({
          type: "error",
          reason: "transcribe-failed",
          message: "Live dictation could not start. Try again to use standard dictation.",
        });
        return;
      }
      const { reason, message } = classifyRealtimeError(error);
      dispatch({ type: "error", reason, message });
    });
  }, [
    cleanupRealtime,
    handleRealtimeDataChannelEvent,
    latency,
    liveControlClientFactory,
    realtimeTransportFactory,
    stopRealtime,
  ]);

  const start = useCallback((): void => {
    if (realtimeEnabled && !realtimeFallbackToBatchRef.current) {
      startRealtime();
      return;
    }
    startBatch();
  }, [realtimeEnabled, startBatch, startRealtime]);

  const cancel = useCallback((): void => {
    // Mark any in-flight start() as cancelled so a microphone grant that resolves after this call is
    // released by its own resolve branch instead of establishing a session (AC3 — deterministic release
    // even when the user leaves dialog mode mid-permission).
    cancelledRef.current = true;
    stoppingRef.current = false;
    clearAutoStop();
    detachVad();
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
    cleanupRealtime();
    startingRef.current = false;
    dispatch({ type: "reset" });
  }, [cleanupRealtime, clearAutoStop, detachVad]);

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
      cleanupRealtime();
    };
  }, [cleanupRealtime]);

  return {
    phase: state.phase,
    mode: state.mode,
    transcript: state.transcript,
    liveTranscript: state.liveTranscript,
    finalizationNote: state.finalizationNote,
    error:
      state.errorReason !== undefined && state.errorMessage !== undefined
        ? { reason: state.errorReason, message: state.errorMessage }
        : undefined,
    audioLevel: state.audioLevel,
    heardSpeech: state.heardSpeech,
    micReady: state.micReady,
    busy:
      state.phase === "requesting" ||
      state.phase === "recording" ||
      state.phase === "finalizing" ||
      state.phase === "transcribing",
    start,
    stop,
    cancel,
    retry,
    discard,
    insert,
    setTranscript,
  };
}
