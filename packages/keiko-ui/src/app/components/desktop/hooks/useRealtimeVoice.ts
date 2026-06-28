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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { VoicePersona, VoiceSessionChatContext } from "@oscharko-dev/keiko-contracts";
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
import { parseRealtimeVoiceEvent, type ParsedRealtimeVoiceEvent } from "./voice-realtime-events";
import {
  createVoiceTurnManager,
  type VoiceTurnManagerEngine,
  type VoiceTurnSnapshot,
} from "./voice-turn-manager";

// A transient WebRTC `disconnected` state is recoverable (a brief network blip, an ICE restart): the
// connection often returns to `connected` on its own. Tearing the session down the instant it appears
// drops a live conversation over a momentary hiccup. We keep the session alive for this grace window
// and only treat the connection as lost if it has not recovered by the time it elapses.
const ICE_DISCONNECT_GRACE_MS = 5_000;
const GROUNDING_TOOL_NAME = "search_keiko_grounding";

// The audio sink for the assistant's remote media stream. Without it the negotiated remote track is
// never attached to any output and the realtime assistant is completely silent — the single most
// severe realtime defect. Production attaches the stream to a hidden, autoplaying HTMLAudioElement;
// tests inject a fake to assert the wiring without touching real media APIs.
export interface RealtimeAudioSink {
  attach(stream: MediaStream): void;
  setMuted?(muted: boolean): void;
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
    setMuted(muted: boolean): void {
      if (audio === undefined) return;
      audio.muted = muted;
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
  // The active chat context for server-side realtime instructions and MemoriaViva retrieval. The
  // browser sends only the chat id plus memory flags; the host resolves project ownership and prompt
  // context server-side.
  readonly chatContext?: VoiceSessionChatContext | undefined;
  // True when the active chat has repository / knowledge grounding. In that mode committed user
  // transcripts are buffered until Realtime calls Keiko's grounding tool; the canonical BFF grounded
  // answer is persisted, and the spoken provider transcript is not appended as a duplicate answer.
  readonly groundingActive?: boolean | undefined;
  // Test seams: inject fake factories. Production uses the browser transport and the BFF client.
  readonly createTransport?: (() => VoiceRtcTransport) | undefined;
  readonly createControl?: (() => VoiceControlClient) | undefined;
  readonly createAudioSink?: (() => RealtimeAudioSink) | undefined;
  readonly onUserTranscriptCommitted?: ((text: string) => void | Promise<void>) | undefined;
  readonly onAssistantTranscriptCommitted?: ((text: string) => void | Promise<void>) | undefined;
  readonly onGroundedToolCall?:
    | ((
        call: RealtimeGroundedVoiceToolCall,
        signal: AbortSignal,
      ) => Promise<RealtimeGroundedVoiceToolOutput>)
    | undefined;
}

export interface RealtimeGroundedVoiceToolCall {
  readonly callId: string;
  readonly query: string;
  readonly userTranscript?: string | undefined;
  readonly responseId?: string | undefined;
  readonly itemId?: string | undefined;
}

export type RealtimeGroundedVoiceToolOutput = unknown;

interface PendingGroundedTranscript {
  readonly text: string;
  readonly itemId?: string | undefined;
}

interface FunctionCallBuffer {
  readonly name?: string | undefined;
  readonly responseId?: string | undefined;
  readonly itemId?: string | undefined;
  argumentsText: string;
}

export interface RealtimeVoiceController {
  readonly phase: RealtimeVoicePhase;
  // True while a connection attempt is in progress (requesting | negotiating | connected).
  readonly busy: boolean;
  readonly turnSnapshot: VoiceTurnSnapshot;
  readonly listening: boolean;
  readonly speaking: boolean;
  readonly canInterrupt: boolean;
  readonly muted: boolean;
  readonly error:
    { readonly reason: RealtimeVoiceErrorReason; readonly message: string } | undefined;
  readonly start: () => void;
  readonly stop: () => void;
  readonly retry: () => void;
  readonly interrupt: () => void;
  readonly toggleMute: () => void;
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

function eventIdentity(event: {
  readonly responseId?: string | undefined;
  readonly itemId?: string | undefined;
}): string | undefined {
  return event.itemId ?? event.responseId;
}

function transcriptTextIdentity(event: {
  readonly text: string;
  readonly responseId?: string | undefined;
}): string {
  return `${event.responseId ?? "unknown-response"}:${event.text.replace(/\s+/gu, " ").trim()}`;
}

function normalizeToolQuery(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryFromFunctionArguments(argumentsText: string): string | undefined {
  const trimmed = argumentsText.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && typeof parsed.query === "string") {
      const query = parsed.query.trim();
      return query.length > 0 ? query : undefined;
    }
  } catch {
    // Some compatible providers may hand through a plain query string in tests or mocks.
  }
  return trimmed;
}

function safeToolOutputJson(output: RealtimeGroundedVoiceToolOutput): string {
  try {
    return JSON.stringify(output);
  } catch {
    return JSON.stringify({
      status: "error",
      message: "Grounded retrieval output could not be serialized.",
    });
  }
}

export function useRealtimeVoice(options: UseRealtimeVoiceOptions): RealtimeVoiceController {
  const [state, dispatch] = useReducer(realtimeVoiceReducer, INITIAL_STATE);
  const turnManagerRef = useRef<VoiceTurnManagerEngine>(
    createVoiceTurnManager({ profile: "full-realtime" }),
  );
  const [turnSnapshot, setTurnSnapshot] = useState<VoiceTurnSnapshot>(() =>
    turnManagerRef.current.snapshot(),
  );
  const [muted, setMuted] = useState(false);

  const transportFactory = options.createTransport ?? createBrowserVoiceRtcTransport;
  // Read the latest persona at start() time without churning the control factory identity (which is a
  // dependency of the memoized start callback).
  const personaRef = useRef(options.persona);
  personaRef.current = options.persona;
  const chatContextRef = useRef(options.chatContext);
  chatContextRef.current = options.chatContext;
  const controlFactory = useMemo(
    () =>
      options.createControl ??
      ((): VoiceControlClient =>
        createBrowserVoiceControlClient(undefined, personaRef.current, chatContextRef.current)),
    [options.createControl],
  );
  const audioSinkFactory = options.createAudioSink ?? createBrowserRealtimeAudioSink;
  const onUserTranscriptCommittedRef = useRef(options.onUserTranscriptCommitted);
  const onAssistantTranscriptCommittedRef = useRef(options.onAssistantTranscriptCommitted);
  const onGroundedToolCallRef = useRef(options.onGroundedToolCall);
  const groundingActiveRef = useRef(options.groundingActive === true);
  onUserTranscriptCommittedRef.current = options.onUserTranscriptCommitted;
  onAssistantTranscriptCommittedRef.current = options.onAssistantTranscriptCommitted;
  onGroundedToolCallRef.current = options.onGroundedToolCall;
  groundingActiveRef.current = options.groundingActive === true;

  const sessionRef = useRef<VoiceRtcSession | undefined>(undefined);
  const controlRef = useRef<VoiceControlClient | undefined>(undefined);
  const audioSinkRef = useRef<RealtimeAudioSink | undefined>(undefined);
  const userTranscriptItemsRef = useRef<Set<string>>(new Set());
  const assistantTranscriptItemsRef = useRef<Set<string>>(new Set());
  const assistantTranscriptTextItemsRef = useRef<Set<string>>(new Set());
  const assistantTranscriptBufferRef = useRef("");
  const assistantTranscriptResponseRef = useRef<string | undefined>(undefined);
  const pendingGroundedTranscriptRef = useRef<PendingGroundedTranscript | undefined>(undefined);
  const functionCallBuffersRef = useRef<Map<string, FunctionCallBuffer>>(new Map());
  const executedFunctionCallsRef = useRef<Set<string>>(new Set());
  const groundedToolAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Pending teardown timer for a transient `disconnected` state (see ICE_DISCONNECT_GRACE_MS).
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Guards every state update that runs after an `await`, so a composer that unmounts mid-flow
  // (e.g. while permission is pending or negotiation is in flight) never dispatches onto an
  // unmounted component and never leaves the microphone open.
  const mountedRef = useRef(true);

  const applyTurnSignal = useCallback(
    (signal: Parameters<VoiceTurnManagerEngine["apply"]>[0]): void => {
      const result = turnManagerRef.current.apply(signal);
      setTurnSnapshot(result.snapshot);
      if (
        result.effects.includes("stop-playback") ||
        result.effects.includes("cancel-speech-generation")
      ) {
        sessionRef.current?.sendDataChannelEvent?.({ type: "response.cancel" });
      }
    },
    [],
  );

  const resetTurnState = useCallback((): void => {
    turnManagerRef.current.reset();
    setTurnSnapshot(turnManagerRef.current.snapshot());
    userTranscriptItemsRef.current.clear();
    assistantTranscriptItemsRef.current.clear();
    assistantTranscriptTextItemsRef.current.clear();
    assistantTranscriptBufferRef.current = "";
    assistantTranscriptResponseRef.current = undefined;
    pendingGroundedTranscriptRef.current = undefined;
    functionCallBuffersRef.current.clear();
    executedFunctionCallsRef.current.clear();
    for (const controller of groundedToolAbortControllersRef.current.values()) {
      controller.abort();
    }
    groundedToolAbortControllersRef.current.clear();
  }, []);

  const commitUserTranscript = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "user-transcript-committed" }>): void => {
      const id = eventIdentity(event);
      if (id !== undefined) {
        if (userTranscriptItemsRef.current.has(id)) {
          return;
        }
        userTranscriptItemsRef.current.add(id);
      }
      assistantTranscriptTextItemsRef.current.clear();
      if (groundingActiveRef.current) {
        pendingGroundedTranscriptRef.current =
          id === undefined ? { text: event.text } : { text: event.text, itemId: id };
        return;
      }
      void onUserTranscriptCommittedRef.current?.(event.text);
    },
    [],
  );

  const flushPendingGroundedUserTranscript = useCallback((): void => {
    const pending = pendingGroundedTranscriptRef.current;
    if (pending === undefined) return;
    pendingGroundedTranscriptRef.current = undefined;
    void onUserTranscriptCommittedRef.current?.(pending.text);
  }, []);

  const appendFunctionCallArguments = useCallback(
    (
      event: Extract<ParsedRealtimeVoiceEvent, { kind: "function-call-arguments-delta" }>,
    ): void => {
      const existing = functionCallBuffersRef.current.get(event.callId);
      functionCallBuffersRef.current.set(event.callId, {
        argumentsText: `${existing?.argumentsText ?? ""}${event.delta}`,
        ...(event.name ?? existing?.name
          ? { name: event.name ?? existing?.name }
          : {}),
        ...(event.responseId ?? existing?.responseId
          ? { responseId: event.responseId ?? existing?.responseId }
          : {}),
        ...(event.itemId ?? existing?.itemId
          ? { itemId: event.itemId ?? existing?.itemId }
          : {}),
      });
    },
    [],
  );

  const sendFunctionCallOutput = useCallback(
    (callId: string, output: RealtimeGroundedVoiceToolOutput): void => {
      sessionRef.current?.sendDataChannelEvent?.({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: safeToolOutputJson(output),
        },
      });
      sessionRef.current?.sendDataChannelEvent?.({ type: "response.create" });
    },
    [],
  );

  const executeGroundedFunctionCall = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "function-call-committed" }>): void => {
      const buffered = functionCallBuffersRef.current.get(event.callId);
      const name = event.name || buffered?.name;
      if (name !== GROUNDING_TOOL_NAME) {
        return;
      }
      const query = queryFromFunctionArguments(
        event.argumentsText.trim().length > 0 ? event.argumentsText : (buffered?.argumentsText ?? ""),
      );
      if (query === undefined) {
        return;
      }
      const executionKey = `${event.callId}:${normalizeToolQuery(query)}`;
      if (executedFunctionCallsRef.current.has(executionKey)) {
        return;
      }
      executedFunctionCallsRef.current.add(executionKey);
      functionCallBuffersRef.current.delete(event.callId);
      applyTurnSignal({ kind: "user-end-of-turn" });
      const tool = onGroundedToolCallRef.current;
      if (!groundingActiveRef.current || tool === undefined) {
        sendFunctionCallOutput(event.callId, {
          status: "error",
          message: "Grounded retrieval is not available for this chat.",
        });
        return;
      }
      const pending = pendingGroundedTranscriptRef.current;
      const controller = new AbortController();
      groundedToolAbortControllersRef.current.set(executionKey, controller);
      void tool(
        {
          callId: event.callId,
          query,
          ...(pending?.text === undefined ? {} : { userTranscript: pending.text }),
          ...(event.responseId ?? buffered?.responseId
            ? { responseId: event.responseId ?? buffered?.responseId }
            : {}),
          ...(event.itemId ?? buffered?.itemId ? { itemId: event.itemId ?? buffered?.itemId } : {}),
        },
        controller.signal,
      )
        .then((output) => {
          if (controller.signal.aborted) return;
          pendingGroundedTranscriptRef.current = undefined;
          sendFunctionCallOutput(event.callId, output);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          flushPendingGroundedUserTranscript();
          applyTurnSignal({ kind: "provider-failure", recoverable: true });
          sendFunctionCallOutput(event.callId, {
            status: "error",
            message:
              caught instanceof Error
                ? caught.message
                : "Grounded retrieval failed before an answer could be prepared.",
          });
        })
        .finally(() => {
          groundedToolAbortControllersRef.current.delete(executionKey);
        });
    },
    [applyTurnSignal, flushPendingGroundedUserTranscript, sendFunctionCallOutput],
  );

  const commitAssistantTranscript = useCallback(
    (
      event: Extract<ParsedRealtimeVoiceEvent, { kind: "assistant-transcript-committed" }>,
    ): void => {
      if (groundingActiveRef.current) {
        assistantTranscriptBufferRef.current = "";
        assistantTranscriptResponseRef.current = undefined;
        applyTurnSignal({ kind: "assistant-speech-end", how: "completed" });
        return;
      }
      const id = eventIdentity(event);
      if (id !== undefined) {
        if (assistantTranscriptItemsRef.current.has(id)) {
          return;
        }
        assistantTranscriptItemsRef.current.add(id);
      }
      const textKey = transcriptTextIdentity(event);
      if (assistantTranscriptTextItemsRef.current.has(textKey)) {
        return;
      }
      assistantTranscriptTextItemsRef.current.add(textKey);
      assistantTranscriptBufferRef.current = "";
      assistantTranscriptResponseRef.current = undefined;
      applyTurnSignal({ kind: "assistant-speech-start" });
      void onAssistantTranscriptCommittedRef.current?.(event.text);
      applyTurnSignal({ kind: "assistant-speech-end", how: "completed" });
    },
    [applyTurnSignal],
  );

  const commitBufferedAssistantTranscript = useCallback(
    (responseId: string | undefined): void => {
      const text = assistantTranscriptBufferRef.current.trim();
      if (text.length === 0) {
        return;
      }
      commitAssistantTranscript({
        kind: "assistant-transcript-committed",
        text,
        responseId: responseId ?? assistantTranscriptResponseRef.current,
      });
    },
    [commitAssistantTranscript],
  );

  const handleRealtimeEvent = useCallback(
    (raw: unknown): void => {
      const event = parseRealtimeVoiceEvent(raw);
      if (event === undefined) {
        return;
      }
      switch (event.kind) {
        case "user-speech-start":
          applyTurnSignal({ kind: "user-speech-start" });
          return;
        case "user-speech-stop":
          applyTurnSignal({ kind: "user-end-of-turn" });
          return;
        case "user-transcript-committed":
          commitUserTranscript(event);
          return;
        case "assistant-output-start":
          applyTurnSignal({ kind: "assistant-speech-start" });
          return;
        case "assistant-output-stop":
          applyTurnSignal({ kind: "assistant-speech-end", how: "completed" });
          return;
        case "assistant-transcript-delta":
          assistantTranscriptBufferRef.current += event.delta;
          assistantTranscriptResponseRef.current = event.responseId;
          applyTurnSignal({ kind: "assistant-speech-start" });
          return;
        case "assistant-transcript-committed":
          commitAssistantTranscript(event);
          return;
        case "function-call-arguments-delta":
          appendFunctionCallArguments(event);
          return;
        case "function-call-committed":
          executeGroundedFunctionCall(event);
          return;
        case "response-done":
          if (event.status === "cancelled") {
            applyTurnSignal({ kind: "assistant-speech-end", how: "stopped" });
            return;
          }
          if (event.status === "failed" || event.status === "incomplete") {
            applyTurnSignal({ kind: "provider-failure", recoverable: true });
            return;
          }
          if (groundingActiveRef.current) {
            flushPendingGroundedUserTranscript();
          }
          commitBufferedAssistantTranscript(event.responseId);
          applyTurnSignal({ kind: "assistant-speech-end", how: "completed" });
          return;
        case "response-cancelled":
          applyTurnSignal({ kind: "assistant-speech-end", how: "stopped" });
          return;
        case "error":
          applyTurnSignal({ kind: "provider-failure", recoverable: true });
          dispatch({ type: "error", reason: "connection-failed", message: event.message });
          return;
      }
    },
    [
      appendFunctionCallArguments,
      applyTurnSignal,
      commitAssistantTranscript,
      commitBufferedAssistantTranscript,
      commitUserTranscript,
      executeGroundedFunctionCall,
      flushPendingGroundedUserTranscript,
    ],
  );

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
    resetTurnState();
  }, [resetTurnState]);

  useEffect(() => {
    sessionRef.current?.setInputMuted?.(muted);
  }, [muted]);

  const stop = useCallback((): void => {
    sessionRef.current?.sendDataChannelEvent?.({ type: "response.cancel" });
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
        session.setInputMuted?.(muted);
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
        session.onDataChannelEvent?.((event) => {
          if (!mountedRef.current) return;
          handleRealtimeEvent(event);
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
  }, [transportFactory, controlFactory, audioSinkFactory, muted, handleRealtimeEvent, cleanupRefs]);

  const retry = useCallback((): void => {
    cleanupRefs();
    dispatch({ type: "reset" });
    start();
  }, [cleanupRefs, start]);

  const interrupt = useCallback((): void => {
    sessionRef.current?.sendDataChannelEvent?.({ type: "response.cancel" });
    for (const controller of groundedToolAbortControllersRef.current.values()) {
      controller.abort();
    }
    groundedToolAbortControllersRef.current.clear();
    applyTurnSignal({ kind: "user-interrupt" });
  }, [applyTurnSignal]);

  const toggleMute = useCallback((): void => {
    setMuted((current) => !current);
  }, []);

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
    turnSnapshot,
    listening: turnSnapshot.state === "listening",
    speaking: turnSnapshot.state === "speaking",
    canInterrupt: turnSnapshot.floorHolder === "assistant",
    muted,
    start,
    stop,
    retry,
    interrupt,
    toggleMute,
  };
}
