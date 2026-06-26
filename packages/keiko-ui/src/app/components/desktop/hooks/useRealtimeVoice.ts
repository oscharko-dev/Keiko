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

import { useCallback, useEffect, useReducer, useRef } from "react";
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
  // Test seams: inject fake factories. Production uses the browser transport and the BFF client.
  readonly createTransport?: (() => VoiceRtcTransport) | undefined;
  readonly createControl?: (() => VoiceControlClient) | undefined;
}

export interface RealtimeVoiceController {
  readonly phase: RealtimeVoicePhase;
  // True while a connection attempt is in progress (requesting | negotiating | connected).
  readonly busy: boolean;
  readonly error: { readonly reason: RealtimeVoiceErrorReason; readonly message: string } | undefined;
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
  const controlFactory = options.createControl ?? createBrowserVoiceControlClient;

  const sessionRef = useRef<VoiceRtcSession | undefined>(undefined);
  const controlRef = useRef<VoiceControlClient | undefined>(undefined);
  // Guards every state update that runs after an `await`, so a composer that unmounts mid-flow
  // (e.g. while permission is pending or negotiation is in flight) never dispatches onto an
  // unmounted component and never leaves the microphone open.
  const mountedRef = useRef(true);

  const cleanupRefs = useCallback((): void => {
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

        // Wire connection-state changes before applying the answer so early "failed" events are
        // caught.
        session.onConnectionStateChange((rtcState) => {
          if (!mountedRef.current) return;
          if (rtcState === "connected") {
            dispatch({ type: "connected" });
          } else if (
            rtcState === "failed" ||
            rtcState === "disconnected" ||
            rtcState === "closed"
          ) {
            cleanupRefs();
            dispatch({ type: "reset" });
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
  }, [transportFactory, controlFactory, cleanupRefs]);

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
      state.phase === "requesting" ||
      state.phase === "negotiating" ||
      state.phase === "connected",
    error:
      state.errorReason !== undefined && state.errorMessage !== undefined
        ? { reason: state.errorReason, message: state.errorMessage }
        : undefined,
    start,
    stop,
    retry,
  };
}
