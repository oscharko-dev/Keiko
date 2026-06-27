// Issue #497, Epic #491 — the realtime Voice Digital Twin state machine.
//
// `useRealtimeVoice` orchestrates the real-time WebRTC voice session: request microphone access,
// run the proxied-SDP WebSocket handshake with the BFF, apply the answer, then surface the live
// connection state to the composer. It owns no hardware itself — the WebRTC seam lives behind the
// injectable `VoiceRtcTransport` and the WS control behind `VoiceControlClient` — so the hook and
// its tests never depend on real media APIs or a live server.
//
// Phases: idle → requesting (getUserMedia) → negotiating (WS handshake) → connected.
// Every failure resolves to a non-blocking `error` phase that leaves the composer fully usable (AC4).

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import {
  createBrowserVoiceRtcTransport,
  VoiceRtcError,
  type VoiceRtcSession,
  type VoiceRtcTransport,
} from "./voice-rtc-transport";
import {
  createBrowserVoiceControlClient,
  VoiceControlError,
  type VoiceControlClient,
} from "./voice-realtime-client";

// A transient WebRTC `disconnected` state is recoverable (a brief network blip, an ICE restart): the
// connection often returns to `connected` on its own. Tearing the session down the instant it appears
// drops a live conversation over a momentary hiccup. We keep the session alive for this grace window
// and only treat the connection as lost if it has not recovered by the time it elapses.
const ICE_DISCONNECT_GRACE_MS = 5_000;

// The audio sink for the assistant's remote media stream. Without it the negotiated remote track is
// never attached to any output and the realtime assistant is completely silent — the single most
// severe realtime defect. Production attaches the stream to a hidden, autoplaying HTMLAudioElement;
// tests inject a fake to assert the wiring without touching real media APIs.
export interface RealtimeAudioSink {
  attach(stream: MediaStream): void;
  release(): void;
}

function createBrowserRealtimeAudioSink(): RealtimeAudioSink {
  const audio = typeof Audio !== "undefined" ? new Audio() : undefined;
  if (audio !== undefined) {
    audio.autoplay = true;
  }
  return {
    attach(stream: MediaStream): void {
      if (audio === undefined) return;
      audio.srcObject = stream;
      // play() may reject if autoplay policy blocks it; the realtime session is always started by a
      // user gesture (the composer button), so it resolves in practice. Swallow a late rejection so it
      // never surfaces as an unhandled promise rejection.
      void audio.play?.().catch(() => {});
    },
    release(): void {
      if (audio === undefined) return;
      try {
        audio.pause?.();
      } catch {
        // ignore — element already torn down
      }
      audio.srcObject = null;
    },
  };
}

export type RealtimeVoicePhase = "idle" | "requesting" | "negotiating" | "connected" | "error";

// Why the realtime connection could not start or was lost. Combines transport and control errors.
export type RealtimeVoiceErrorReason =
  | "permission-denied"
  | "no-microphone"
  | "unsupported"
  | "negotiation-failed"
  | "unavailable"
  | "connection-failed";

interface RealtimeVoiceState {
  readonly phase: RealtimeVoicePhase;
  readonly errorReason: RealtimeVoiceErrorReason | undefined;
  readonly errorMessage: string | undefined;
}

const INITIAL_STATE: RealtimeVoiceState = {
  phase: "idle",
  errorReason: undefined,
  errorMessage: undefined,
};

type RealtimeVoiceAction =
  | { readonly type: "requesting" }
  | { readonly type: "negotiating" }
  | { readonly type: "connected" }
  | { readonly type: "error"; readonly reason: RealtimeVoiceErrorReason; readonly message: string }
  | { readonly type: "reset" };

function realtimeVoiceReducer(
  state: RealtimeVoiceState,
  action: RealtimeVoiceAction,
): RealtimeVoiceState {
  switch (action.type) {
    case "requesting":
      return { ...INITIAL_STATE, phase: "requesting" };
    case "negotiating":
      return { ...INITIAL_STATE, phase: "negotiating" };
    case "connected":
      return { ...INITIAL_STATE, phase: "connected" };
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

export interface UseRealtimeVoiceOptions {
  // The selected product voice persona ("male" | "female" | "neutral"). Forwarded content-free in the
  // session.create control message so the host resolves the realtime voice to the user's choice; the
  // browser never learns the provider voice id. Undefined keeps the host's configured default voice.
  readonly persona?: VoicePersona | undefined;
  // Test seams: inject fake factories. Production uses the browser transport and the BFF client.
  readonly createTransport?: (() => VoiceRtcTransport) | undefined;
  readonly createControl?: (() => VoiceControlClient) | undefined;
  readonly createAudioSink?: (() => RealtimeAudioSink) | undefined;
}

export interface RealtimeVoiceController {
  readonly phase: RealtimeVoicePhase;
  // True while a connection attempt is in progress (requesting | negotiating | connected).
  readonly busy: boolean;
  readonly error:
    | { readonly reason: RealtimeVoiceErrorReason; readonly message: string }
    | undefined;
  readonly start: () => void;
  readonly stop: () => void;
  readonly retry: () => void;
}

// Maps a thrown error from the transport or control step to a non-blocking error phase.
function classifyError(error: unknown): {
  reason: RealtimeVoiceErrorReason;
  message: string;
} {
  if (error instanceof VoiceRtcError) {
    return { reason: error.reason, message: error.message };
  }
  if (error instanceof VoiceControlError) {
    return { reason: error.reason, message: error.message };
  }
  return { reason: "connection-failed", message: "Real-time voice could not be started." };
}

export function useRealtimeVoice(options: UseRealtimeVoiceOptions): RealtimeVoiceController {
  const [state, dispatch] = useReducer(realtimeVoiceReducer, INITIAL_STATE);

  const transportFactory = options.createTransport ?? createBrowserVoiceRtcTransport;
  // Read the latest persona at start() time without churning the control factory identity (which is a
  // dependency of the memoized start callback).
  const personaRef = useRef(options.persona);
  personaRef.current = options.persona;
  const controlFactory = useMemo(
    () =>
      options.createControl ??
      ((): VoiceControlClient => createBrowserVoiceControlClient(undefined, personaRef.current)),
    [options.createControl],
  );
  const audioSinkFactory = options.createAudioSink ?? createBrowserRealtimeAudioSink;

  const sessionRef = useRef<VoiceRtcSession | undefined>(undefined);
  const controlRef = useRef<VoiceControlClient | undefined>(undefined);
  const audioSinkRef = useRef<RealtimeAudioSink | undefined>(undefined);
  // Pending teardown timer for a transient `disconnected` state (see ICE_DISCONNECT_GRACE_MS).
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Guards every state update that runs after an `await`, so a composer that unmounts mid-flow
  // (e.g. while permission is pending or negotiation is in flight) never dispatches onto an
  // unmounted component and never leaves the microphone open.
  const mountedRef = useRef(true);

  const cleanupRefs = useCallback((): void => {
    if (graceTimerRef.current !== undefined) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = undefined;
    }
    audioSinkRef.current?.release();
    audioSinkRef.current = undefined;
    sessionRef.current?.close();
    sessionRef.current = undefined;
    controlRef.current?.close();
    controlRef.current = undefined;
  }, []);

  const stop = useCallback((): void => {
    cleanupRefs();
    dispatch({ type: "reset" });
  }, [cleanupRefs]);

  const start = useCallback((): void => {
    if (sessionRef.current !== undefined) {
      return;
    }
    dispatch({ type: "requesting" });
    const transport = transportFactory();
    const control = controlFactory();
    controlRef.current = control;

    void transport
      .connect()
      .then(async (session) => {
        if (!mountedRef.current) {
          session.close();
          control.close();
          return;
        }
        sessionRef.current = session;
        dispatch({ type: "negotiating" });

        // Attach the assistant's remote audio to an output sink BEFORE applying the answer, so the
        // remote-track event (which can fire as soon as setRemoteDescription runs) is never missed.
        // Without this the negotiated audio track plays nowhere and the assistant is silent.
        const audioSink = audioSinkFactory();
        audioSinkRef.current = audioSink;
        session.onRemoteTrack((stream) => {
          if (!mountedRef.current) return;
          audioSink.attach(stream);
        });

        // Wire connection-state changes before applying the answer so early "failed" events are
        // caught. A transient `disconnected` is given a bounded grace window to recover instead of
        // tearing the live session down on a momentary blip.
        session.onConnectionStateChange((rtcState) => {
          if (!mountedRef.current) return;
          if (rtcState === "connected") {
            if (graceTimerRef.current !== undefined) {
              clearTimeout(graceTimerRef.current);
              graceTimerRef.current = undefined;
            }
            dispatch({ type: "connected" });
          } else if (rtcState === "failed" || rtcState === "closed") {
            cleanupRefs();
            dispatch({ type: "reset" });
          } else if (rtcState === "disconnected") {
            if (graceTimerRef.current === undefined) {
              graceTimerRef.current = setTimeout(() => {
                graceTimerRef.current = undefined;
                if (!mountedRef.current) return;
                cleanupRefs();
                dispatch({ type: "reset" });
              }, ICE_DISCONNECT_GRACE_MS);
            }
          }
        });

        const answerSdp = await control.negotiate(session.offerSdp);
        if (!mountedRef.current) {
          session.close();
          return;
        }
        await session.applyAnswer(answerSdp);
        if (!mountedRef.current) {
          session.close();
          return;
        }
        // "connected" dispatch arrives via onConnectionStateChange once WebRTC confirms the link.
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        cleanupRefs();
        const { reason, message } = classifyError(error);
        dispatch({ type: "error", reason, message });
      });
  }, [transportFactory, controlFactory, audioSinkFactory, cleanupRefs]);

  const retry = useCallback((): void => {
    cleanupRefs();
    dispatch({ type: "reset" });
    start();
  }, [cleanupRefs, start]);

  // Release the microphone and WS when the composer unmounts mid-flow. Clearing both refs ensures
  // a late-firing async operation finds no live session and dispatches nothing.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupRefs();
    };
  }, [cleanupRefs]);

  return {
    phase: state.phase,
    busy:
      state.phase === "requesting" || state.phase === "negotiating" || state.phase === "connected",
    error:
      state.errorReason !== undefined && state.errorMessage !== undefined
        ? { reason: state.errorReason, message: state.errorMessage }
        : undefined,
    start,
    stop,
    retry,
  };
}
