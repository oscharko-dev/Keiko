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
// After re-enabling a disabled microphone track, browsers may need a short re-arm window before
// capture/VAD is reliably live again. Keep the UI from presenting a stale listening state during it.
const INPUT_UNMUTE_REARM_MS = 300;
const SESSION_READY_WARMUP_MS = 300;
const GROUNDING_TOOL_NAME = "search_keiko_grounding";
const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = "whisper-1";
const DEFAULT_REALTIME_VAD_PREFIX_PADDING_MS = 300;
const DEFAULT_REALTIME_VAD_SILENCE_DURATION_MS = 500;
const DEFAULT_REALTIME_VAD_THRESHOLD = 0.5;
const MAX_REALTIME_MEMORY_CONTEXT_CHARS = 6_000;

function realtimeGroundingToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    name: GROUNDING_TOOL_NAME,
    description:
      "Search Keiko's connected repository, file, document, and knowledge sources for the current chat and return a citation-backed answer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "The user's grounded question, rewritten only enough to preserve the intended meaning.",
        },
      },
      required: ["query"],
    },
  };
}

function buildRealtimeSessionUpdate(groundingActive: boolean): Record<string, unknown> {
  const session: Record<string, unknown> = {
    output_modalities: ["audio"],
    audio: {
      input: {
        turn_detection: {
          type: "server_vad",
          threshold: DEFAULT_REALTIME_VAD_THRESHOLD,
          prefix_padding_ms: DEFAULT_REALTIME_VAD_PREFIX_PADDING_MS,
          silence_duration_ms: DEFAULT_REALTIME_VAD_SILENCE_DURATION_MS,
          interrupt_response: true,
        },
        transcription: { model: DEFAULT_REALTIME_TRANSCRIPTION_MODEL },
      },
    },
  };
  if (groundingActive) {
    session.tools = [realtimeGroundingToolDefinition()];
    session.tool_choice = { type: "function", function: { name: GROUNDING_TOOL_NAME } };
  }
  return { type: "session.update", session };
}

function buildRealtimeMemoryContextItem(text: string): Record<string, unknown> | undefined {
  const safe = text.replace(/\s+\n/gu, "\n").trim();
  if (safe.length === 0) {
    return undefined;
  }
  const bounded =
    safe.length <= MAX_REALTIME_MEMORY_CONTEXT_CHARS
      ? safe
      : safe.slice(-MAX_REALTIME_MEMORY_CONTEXT_CHARS);
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      status: "completed",
      content: [
        {
          type: "input_text",
          text: `Updated MemoriaViva context for the next voice turn:\n${bounded}`,
        },
      ],
    },
  };
}

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
  _state: RealtimeVoiceState,
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
  readonly memoryContextText?: string | undefined;
  // Test seams: inject fake factories. Production uses the browser transport and the BFF client.
  readonly createTransport?: (() => VoiceRtcTransport) | undefined;
  readonly createControl?: (() => VoiceControlClient) | undefined;
  readonly createAudioSink?: (() => RealtimeAudioSink) | undefined;
  readonly onVoiceTurnCommitted?:
    ((messages: readonly RealtimeVoiceTurnMessage[]) => void | Promise<void>) | undefined;
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

export interface RealtimeVoiceTurnMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface VoiceTurnDraft {
  seq: number;
  groundingActive: boolean;
  userText: string | undefined;
  userItemId: string | undefined;
  assistantText: string | undefined;
  assistantResponseId: string | undefined;
  assistantItemId: string | undefined;
  userPersisted: boolean;
  assistantPersisted: boolean;
  groundedToolPersisted: boolean;
}

interface FunctionCallBuffer {
  readonly name?: string | undefined;
  readonly responseId?: string | undefined;
  readonly itemId?: string | undefined;
  argumentsText: string;
}

interface SessionReadiness {
  rtcConnected: boolean;
  dataChannelOpen: boolean;
  sessionUpdated: boolean;
  warmupComplete: boolean;
  requiresDataChannelAck: boolean;
}

function freshSessionReadiness(): SessionReadiness {
  return {
    rtcConnected: false,
    dataChannelOpen: false,
    sessionUpdated: false,
    warmupComplete: false,
    requiresDataChannelAck: true,
  };
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

function normalizedTranscriptText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
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

function groundedToolOutputPersisted(output: RealtimeGroundedVoiceToolOutput): boolean {
  if (!isRecord(output) || !isRecord(output.persisted)) {
    return false;
  }
  return (
    typeof output.persisted.userMessageId === "string" &&
    output.persisted.userMessageId.length > 0 &&
    typeof output.persisted.assistantMessageId === "string" &&
    output.persisted.assistantMessageId.length > 0
  );
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
  const [inputRearming, setInputRearming] = useState(false);

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
  const onVoiceTurnCommittedRef = useRef(options.onVoiceTurnCommitted);
  const onUserTranscriptCommittedRef = useRef(options.onUserTranscriptCommitted);
  const onAssistantTranscriptCommittedRef = useRef(options.onAssistantTranscriptCommitted);
  const onGroundedToolCallRef = useRef(options.onGroundedToolCall);
  const groundingActiveRef = useRef(options.groundingActive === true);
  const memoryContextTextRef = useRef(options.memoryContextText);
  onVoiceTurnCommittedRef.current = options.onVoiceTurnCommitted;
  onUserTranscriptCommittedRef.current = options.onUserTranscriptCommitted;
  onAssistantTranscriptCommittedRef.current = options.onAssistantTranscriptCommitted;
  onGroundedToolCallRef.current = options.onGroundedToolCall;
  groundingActiveRef.current = options.groundingActive === true;
  memoryContextTextRef.current = options.memoryContextText;

  const sessionRef = useRef<VoiceRtcSession | undefined>(undefined);
  const controlRef = useRef<VoiceControlClient | undefined>(undefined);
  const audioSinkRef = useRef<RealtimeAudioSink | undefined>(undefined);
  const startupAbortRef = useRef<AbortController | undefined>(undefined);
  const sessionReadyWarmupTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionReadinessRef = useRef<SessionReadiness>(freshSessionReadiness());
  const sessionUpdateSentRef = useRef(false);
  const lastMemoryContextSentRef = useRef<string | undefined>(undefined);
  const readyDispatchedRef = useRef(false);
  const userTranscriptItemsRef = useRef<Set<string>>(new Set());
  const userTranscriptDeltaItemsRef = useRef<Map<string, string>>(new Map());
  const latestUserTranscriptDeltaKeyRef = useRef<string | undefined>(undefined);
  const assistantTranscriptItemsRef = useRef<Set<string>>(new Set());
  const assistantTranscriptTextItemsRef = useRef<Set<string>>(new Set());
  const assistantResponseTextItemsRef = useRef<Set<string>>(new Set());
  const assistantTranscriptBufferRef = useRef("");
  const assistantTranscriptResponseRef = useRef<string | undefined>(undefined);
  const assistantTranscriptItemRef = useRef<string | undefined>(undefined);
  const currentVoiceTurnRef = useRef<VoiceTurnDraft | undefined>(undefined);
  const voiceTurnSeqRef = useRef(0);
  const functionCallBuffersRef = useRef<Map<string, FunctionCallBuffer>>(new Map());
  const executedFunctionCallsRef = useRef<Set<string>>(new Set());
  const groundedToolAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Pending teardown timer for a transient `disconnected` state (see ICE_DISCONNECT_GRACE_MS).
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unmuteRearmTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  const sendMemoryContextUpdate = useCallback((text: string | undefined): void => {
    const normalized = text?.trim();
    if (
      normalized === undefined ||
      normalized.length === 0 ||
      normalized === lastMemoryContextSentRef.current
    ) {
      return;
    }
    const event = buildRealtimeMemoryContextItem(normalized);
    if (event === undefined) {
      return;
    }
    const accepted = sessionRef.current?.sendDataChannelEvent?.(event);
    if (accepted !== false) {
      lastMemoryContextSentRef.current = normalized;
    }
  }, []);

  const maybeDispatchConnected = useCallback((): void => {
    const readiness = sessionReadinessRef.current;
    if (
      readyDispatchedRef.current ||
      !mountedRef.current ||
      !readiness.rtcConnected ||
      !readiness.dataChannelOpen ||
      !readiness.warmupComplete ||
      (readiness.requiresDataChannelAck && !readiness.sessionUpdated)
    ) {
      return;
    }
    readyDispatchedRef.current = true;
    applyTurnSignal({ kind: "recovered" });
    dispatch({ type: "connected" });
    sendMemoryContextUpdate(memoryContextTextRef.current);
  }, [applyTurnSignal, sendMemoryContextUpdate]);

  const sendSessionUpdate = useCallback((): void => {
    if (sessionUpdateSentRef.current) {
      return;
    }
    sessionUpdateSentRef.current = true;
    const accepted = sessionRef.current?.sendDataChannelEvent?.(
      buildRealtimeSessionUpdate(groundingActiveRef.current),
    );
    if (accepted === false) {
      sessionReadinessRef.current = {
        ...sessionReadinessRef.current,
        sessionUpdated: false,
      };
    }
  }, []);

  const resetTurnState = useCallback((): void => {
    turnManagerRef.current.reset();
    setTurnSnapshot(turnManagerRef.current.snapshot());
    userTranscriptItemsRef.current.clear();
    userTranscriptDeltaItemsRef.current.clear();
    latestUserTranscriptDeltaKeyRef.current = undefined;
    assistantTranscriptItemsRef.current.clear();
    assistantTranscriptTextItemsRef.current.clear();
    assistantResponseTextItemsRef.current.clear();
    assistantTranscriptBufferRef.current = "";
    assistantTranscriptResponseRef.current = undefined;
    assistantTranscriptItemRef.current = undefined;
    currentVoiceTurnRef.current = undefined;
    functionCallBuffersRef.current.clear();
    executedFunctionCallsRef.current.clear();
    for (const controller of groundedToolAbortControllersRef.current.values()) {
      controller.abort();
    }
    groundedToolAbortControllersRef.current.clear();
  }, []);

  const resetSessionReadiness = useCallback((): void => {
    if (sessionReadyWarmupTimerRef.current !== undefined) {
      clearTimeout(sessionReadyWarmupTimerRef.current);
      sessionReadyWarmupTimerRef.current = undefined;
    }
    sessionReadinessRef.current = freshSessionReadiness();
    sessionUpdateSentRef.current = false;
    lastMemoryContextSentRef.current = undefined;
    readyDispatchedRef.current = false;
  }, []);

  const armSessionReadyWarmup = useCallback((): void => {
    if (sessionReadyWarmupTimerRef.current !== undefined) {
      clearTimeout(sessionReadyWarmupTimerRef.current);
    }
    sessionReadinessRef.current = {
      ...sessionReadinessRef.current,
      warmupComplete: false,
    };
    sessionReadyWarmupTimerRef.current = setTimeout(() => {
      sessionReadyWarmupTimerRef.current = undefined;
      if (!mountedRef.current) return;
      sessionReadinessRef.current = {
        ...sessionReadinessRef.current,
        warmupComplete: true,
      };
      maybeDispatchConnected();
    }, SESSION_READY_WARMUP_MS);
  }, [maybeDispatchConnected]);

  const commitVoiceMessages = useCallback((messages: readonly RealtimeVoiceTurnMessage[]): void => {
    const safe = messages
      .map((message) => ({ ...message, content: message.content.trim() }))
      .filter((message) => message.content.length > 0);
    if (safe.length === 0) {
      return;
    }
    const paired = onVoiceTurnCommittedRef.current;
    if (paired !== undefined) {
      void paired(safe);
      return;
    }
    for (const message of safe) {
      if (message.role === "user") {
        void onUserTranscriptCommittedRef.current?.(message.content);
      } else {
        void onAssistantTranscriptCommittedRef.current?.(message.content);
      }
    }
  }, []);

  const flushVoiceTurn = useCallback(
    (options: { readonly allowAssistantFallback: boolean }): void => {
      const turn = currentVoiceTurnRef.current;
      if (turn === undefined || turn.groundedToolPersisted) {
        currentVoiceTurnRef.current = undefined;
        return;
      }
      const messages: RealtimeVoiceTurnMessage[] = [];
      if (!turn.userPersisted && turn.userText !== undefined && turn.userText.trim().length > 0) {
        messages.push({ role: "user", content: turn.userText });
      }
      if (
        options.allowAssistantFallback &&
        !turn.assistantPersisted &&
        turn.assistantText !== undefined &&
        turn.assistantText.trim().length > 0
      ) {
        messages.push({ role: "assistant", content: turn.assistantText });
      }
      if (messages.length > 0) {
        commitVoiceMessages(messages);
        if (messages.some((message) => message.role === "user")) {
          turn.userPersisted = true;
        }
        if (messages.some((message) => message.role === "assistant")) {
          turn.assistantPersisted = true;
        }
      }
      if (
        (turn.userText === undefined || turn.userPersisted) &&
        (turn.assistantText === undefined || turn.assistantPersisted)
      ) {
        currentVoiceTurnRef.current = undefined;
      }
    },
    [commitVoiceMessages],
  );

  const beginVoiceTurn = useCallback((): VoiceTurnDraft => {
    flushVoiceTurn({ allowAssistantFallback: true });
    voiceTurnSeqRef.current += 1;
    const turn: VoiceTurnDraft = {
      seq: voiceTurnSeqRef.current,
      groundingActive: groundingActiveRef.current,
      userText: undefined,
      userItemId: undefined,
      assistantText: undefined,
      assistantResponseId: undefined,
      assistantItemId: undefined,
      userPersisted: false,
      assistantPersisted: false,
      groundedToolPersisted: false,
    };
    currentVoiceTurnRef.current = turn;
    assistantTranscriptTextItemsRef.current.clear();
    return turn;
  }, [flushVoiceTurn]);

  const ensureVoiceTurn = useCallback((): VoiceTurnDraft => {
    return currentVoiceTurnRef.current ?? beginVoiceTurn();
  }, [beginVoiceTurn]);

  const commitUserTranscript = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "user-transcript-committed" }>): void => {
      const id = eventIdentity(event);
      if (id !== undefined) {
        if (userTranscriptItemsRef.current.has(id)) {
          return;
        }
        userTranscriptItemsRef.current.add(id);
        userTranscriptDeltaItemsRef.current.delete(id);
        if (latestUserTranscriptDeltaKeyRef.current === id) {
          latestUserTranscriptDeltaKeyRef.current = undefined;
        }
      }
      const turn = ensureVoiceTurn();
      turn.userText = event.text;
      turn.userItemId = event.itemId;
      assistantTranscriptTextItemsRef.current.clear();
    },
    [ensureVoiceTurn],
  );

  const appendUserTranscriptDelta = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "user-transcript-delta" }>): void => {
      const key = event.itemId ?? "__current";
      latestUserTranscriptDeltaKeyRef.current = key;
      userTranscriptDeltaItemsRef.current.set(
        key,
        `${userTranscriptDeltaItemsRef.current.get(key) ?? ""}${event.delta}`,
      );
      const text = normalizedTranscriptText(userTranscriptDeltaItemsRef.current.get(key) ?? "");
      if (text.length > 0) {
        ensureVoiceTurn().userText = text;
      }
    },
    [ensureVoiceTurn],
  );

  const promoteUserTranscriptFallback = useCallback(
    (itemId?: string | undefined): void => {
      const key = itemId ?? latestUserTranscriptDeltaKeyRef.current;
      if (key === undefined) {
        return;
      }
      const text = normalizedTranscriptText(userTranscriptDeltaItemsRef.current.get(key) ?? "");
      if (text.length === 0) {
        return;
      }
      const turn = ensureVoiceTurn();
      if (turn.userText === undefined || turn.userText.trim().length === 0) {
        turn.userText = text;
        turn.userItemId = key === "__current" ? undefined : key;
      }
      userTranscriptDeltaItemsRef.current.delete(key);
      if (latestUserTranscriptDeltaKeyRef.current === key) {
        latestUserTranscriptDeltaKeyRef.current = undefined;
      }
    },
    [ensureVoiceTurn],
  );

  const appendFunctionCallArguments = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "function-call-arguments-delta" }>): void => {
      const existing = functionCallBuffersRef.current.get(event.callId);
      functionCallBuffersRef.current.set(event.callId, {
        argumentsText: `${existing?.argumentsText ?? ""}${event.delta}`,
        ...((event.name ?? existing?.name) ? { name: event.name ?? existing?.name } : {}),
        ...((event.responseId ?? existing?.responseId)
          ? { responseId: event.responseId ?? existing?.responseId }
          : {}),
        ...((event.itemId ?? existing?.itemId) ? { itemId: event.itemId ?? existing?.itemId } : {}),
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
        event.argumentsText.trim().length > 0
          ? event.argumentsText
          : (buffered?.argumentsText ?? ""),
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
      promoteUserTranscriptFallback();
      applyTurnSignal({ kind: "user-end-of-turn" });
      const tool = onGroundedToolCallRef.current;
      const turn = ensureVoiceTurn();
      if (!turn.groundingActive || tool === undefined) {
        flushVoiceTurn({ allowAssistantFallback: true });
        sendFunctionCallOutput(event.callId, {
          status: "error",
          message: "Grounded retrieval is not available for this chat.",
        });
        return;
      }
      const controller = new AbortController();
      groundedToolAbortControllersRef.current.set(executionKey, controller);
      void tool(
        {
          callId: event.callId,
          query,
          ...(turn.userText === undefined ? {} : { userTranscript: turn.userText }),
          ...((event.responseId ?? buffered?.responseId)
            ? { responseId: event.responseId ?? buffered?.responseId }
            : {}),
          ...((event.itemId ?? buffered?.itemId)
            ? { itemId: event.itemId ?? buffered?.itemId }
            : {}),
        },
        controller.signal,
      )
        .then((output) => {
          if (controller.signal.aborted) return;
          if (groundedToolOutputPersisted(output)) {
            turn.groundedToolPersisted = true;
            turn.userPersisted = true;
            turn.assistantPersisted = true;
          }
          sendFunctionCallOutput(event.callId, output);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          flushVoiceTurn({ allowAssistantFallback: true });
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
    [
      applyTurnSignal,
      ensureVoiceTurn,
      flushVoiceTurn,
      promoteUserTranscriptFallback,
      sendFunctionCallOutput,
    ],
  );

  const commitAssistantTranscript = useCallback(
    (
      event: Extract<ParsedRealtimeVoiceEvent, { kind: "assistant-transcript-committed" }>,
    ): void => {
      const normalizedText = normalizedTranscriptText(event.text);
      if (normalizedText.length === 0) {
        return;
      }
      if (event.itemId !== undefined) {
        if (assistantTranscriptItemsRef.current.has(event.itemId)) {
          return;
        }
        assistantTranscriptItemsRef.current.add(event.itemId);
      } else if (event.responseId !== undefined) {
        const responseTextKey = `${event.responseId}:${normalizedText}`;
        if (assistantResponseTextItemsRef.current.has(responseTextKey)) {
          return;
        }
        assistantResponseTextItemsRef.current.add(responseTextKey);
      } else {
        const turn = ensureVoiceTurn();
        const textKey = `${String(turn.seq)}:${normalizedText}`;
        if (assistantTranscriptTextItemsRef.current.has(textKey)) {
          return;
        }
        assistantTranscriptTextItemsRef.current.add(textKey);
      }
      if (event.responseId !== undefined) {
        assistantResponseTextItemsRef.current.add(`${event.responseId}:${normalizedText}`);
      }
      const turn = ensureVoiceTurn();
      turn.assistantText = normalizedText;
      turn.assistantResponseId = event.responseId;
      turn.assistantItemId = event.itemId;
      assistantTranscriptBufferRef.current = "";
      assistantTranscriptResponseRef.current = undefined;
      assistantTranscriptItemRef.current = undefined;
      // Transcript completion is a persistence signal. The audible assistant floor is owned only by
      // provider audio-output lifecycle events, so text can never announce "speaking" ahead of sound.
      if (
        !turn.groundingActive &&
        !turn.groundedToolPersisted &&
        (turn.userText !== undefined || onVoiceTurnCommittedRef.current === undefined)
      ) {
        flushVoiceTurn({ allowAssistantFallback: true });
      }
      applyTurnSignal({ kind: "assistant-speech-end", how: "completed" });
    },
    [applyTurnSignal, ensureVoiceTurn, flushVoiceTurn],
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
        itemId: assistantTranscriptItemRef.current,
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
        case "session-created":
          return;
        case "session-updated":
          sessionReadinessRef.current = {
            ...sessionReadinessRef.current,
            sessionUpdated: true,
          };
          maybeDispatchConnected();
          return;
        case "user-speech-start":
          commitBufferedAssistantTranscript(undefined);
          flushVoiceTurn({ allowAssistantFallback: true });
          beginVoiceTurn();
          applyTurnSignal({ kind: "user-speech-start" });
          return;
        case "user-speech-stop":
          applyTurnSignal({ kind: "user-end-of-turn" });
          return;
        case "user-transcript-committed":
          commitUserTranscript(event);
          return;
        case "user-transcript-delta":
          appendUserTranscriptDelta(event);
          return;
        case "user-transcript-failed":
          promoteUserTranscriptFallback(event.itemId);
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
          assistantTranscriptItemRef.current = event.itemId;
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
          promoteUserTranscriptFallback();
          if (event.status === "cancelled") {
            commitBufferedAssistantTranscript(event.responseId);
            flushVoiceTurn({ allowAssistantFallback: true });
            applyTurnSignal({ kind: "assistant-speech-end", how: "stopped" });
            return;
          }
          if (event.status === "failed" || event.status === "incomplete") {
            commitBufferedAssistantTranscript(event.responseId);
            flushVoiceTurn({ allowAssistantFallback: true });
            applyTurnSignal({ kind: "provider-failure", recoverable: true });
            return;
          }
          commitBufferedAssistantTranscript(event.responseId);
          flushVoiceTurn({ allowAssistantFallback: true });
          applyTurnSignal({ kind: "assistant-speech-end", how: "completed" });
          return;
        case "response-cancelled":
          promoteUserTranscriptFallback();
          commitBufferedAssistantTranscript(event.responseId);
          flushVoiceTurn({ allowAssistantFallback: true });
          applyTurnSignal({ kind: "assistant-speech-end", how: "stopped" });
          return;
        case "error":
          promoteUserTranscriptFallback();
          flushVoiceTurn({ allowAssistantFallback: true });
          applyTurnSignal({ kind: "provider-failure", recoverable: true });
          dispatch({ type: "error", reason: "connection-failed", message: event.message });
          return;
      }
    },
    [
      appendFunctionCallArguments,
      appendUserTranscriptDelta,
      applyTurnSignal,
      beginVoiceTurn,
      commitAssistantTranscript,
      commitBufferedAssistantTranscript,
      commitUserTranscript,
      executeGroundedFunctionCall,
      flushVoiceTurn,
      maybeDispatchConnected,
      promoteUserTranscriptFallback,
    ],
  );

  const clearInputRearmTimer = useCallback((): void => {
    if (unmuteRearmTimerRef.current !== undefined) {
      clearTimeout(unmuteRearmTimerRef.current);
      unmuteRearmTimerRef.current = undefined;
    }
  }, []);

  const armInputRearmGuard = useCallback((): void => {
    clearInputRearmTimer();
    setInputRearming(true);
    unmuteRearmTimerRef.current = setTimeout(() => {
      unmuteRearmTimerRef.current = undefined;
      if (!mountedRef.current) return;
      setInputRearming(false);
    }, INPUT_UNMUTE_REARM_MS);
  }, [clearInputRearmTimer]);

  const cleanupRefs = useCallback(
    (options: { readonly discardControl?: boolean } = {}): void => {
      const discardControl = options.discardControl ?? true;
      startupAbortRef.current?.abort();
      startupAbortRef.current = undefined;
      if (graceTimerRef.current !== undefined) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = undefined;
      }
      promoteUserTranscriptFallback();
      flushVoiceTurn({ allowAssistantFallback: true });
      clearInputRearmTimer();
      setInputRearming(false);
      audioSinkRef.current?.release();
      audioSinkRef.current = undefined;
      sessionRef.current?.close();
      sessionRef.current = undefined;
      controlRef.current?.close();
      if (discardControl) {
        controlRef.current = undefined;
      }
      resetTurnState();
      resetSessionReadiness();
    },
    [
      clearInputRearmTimer,
      flushVoiceTurn,
      promoteUserTranscriptFallback,
      resetSessionReadiness,
      resetTurnState,
    ],
  );

  useEffect(() => {
    sessionRef.current?.setInputMuted?.(muted);
  }, [muted]);

  useEffect(() => {
    if (!readyDispatchedRef.current) {
      return;
    }
    sendMemoryContextUpdate(options.memoryContextText);
  }, [options.memoryContextText, sendMemoryContextUpdate]);

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
    resetSessionReadiness();
    const startup = new AbortController();
    startupAbortRef.current = startup;
    const transport = transportFactory();
    const control = controlRef.current ?? controlFactory();
    controlRef.current = control;

    void transport
      .connect({ signal: startup.signal })
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
        session.onLocalVoiceActivity?.((activity) => {
          if (!mountedRef.current) return;
          if (activity === "speech-onset") {
            commitBufferedAssistantTranscript(undefined);
            flushVoiceTurn({ allowAssistantFallback: true });
            beginVoiceTurn();
            applyTurnSignal({ kind: "user-speech-start" });
            return;
          }
          applyTurnSignal({ kind: "user-end-of-turn" });
        });
        session.onDataChannelEvent?.((event) => {
          if (!mountedRef.current) return;
          handleRealtimeEvent(event);
        });
        if (session.onDataChannelStateChange !== undefined) {
          sessionReadinessRef.current = {
            ...sessionReadinessRef.current,
            requiresDataChannelAck: true,
          };
          session.onDataChannelStateChange((dataChannelState) => {
            if (!mountedRef.current) return;
            if (dataChannelState === "open") {
              sessionReadinessRef.current = {
                ...sessionReadinessRef.current,
                dataChannelOpen: true,
              };
              sendSessionUpdate();
              maybeDispatchConnected();
              return;
            }
            if (dataChannelState === "closed") {
              applyTurnSignal({ kind: "provider-failure", recoverable: true });
            }
          });
        } else {
          // Test/legacy seam: older injected sessions cannot surface DataChannel state or provider
          // `session.updated`. Keep them usable without weakening the production readiness gate.
          sessionReadinessRef.current = {
            ...sessionReadinessRef.current,
            dataChannelOpen: true,
            sessionUpdated: true,
            requiresDataChannelAck: false,
          };
        }
        armSessionReadyWarmup();

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
            sessionReadinessRef.current = {
              ...sessionReadinessRef.current,
              rtcConnected: true,
            };
            applyTurnSignal({ kind: "recovered" });
            maybeDispatchConnected();
          } else if (rtcState === "failed" || rtcState === "closed") {
            cleanupRefs({ discardControl: false });
            dispatch({ type: "reset" });
          } else if (rtcState === "disconnected") {
            applyTurnSignal({ kind: "provider-failure", recoverable: true });
            if (graceTimerRef.current === undefined) {
              graceTimerRef.current = setTimeout(() => {
                graceTimerRef.current = undefined;
                if (!mountedRef.current) return;
                cleanupRefs({ discardControl: false });
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
        cleanupRefs({ discardControl: false });
        const { reason, message } = classifyError(error);
        dispatch({ type: "error", reason, message });
      });
  }, [
    transportFactory,
    controlFactory,
    audioSinkFactory,
    muted,
    handleRealtimeEvent,
    cleanupRefs,
    resetSessionReadiness,
    armSessionReadyWarmup,
    sendSessionUpdate,
    maybeDispatchConnected,
    applyTurnSignal,
    beginVoiceTurn,
    commitBufferedAssistantTranscript,
    flushVoiceTurn,
  ]);

  const retry = useCallback((): void => {
    cleanupRefs({ discardControl: false });
    dispatch({ type: "reset" });
    start();
  }, [cleanupRefs, start]);

  const interrupt = useCallback((): void => {
    commitBufferedAssistantTranscript(undefined);
    flushVoiceTurn({ allowAssistantFallback: true });
    sessionRef.current?.sendDataChannelEvent?.({ type: "response.cancel" });
    for (const controller of groundedToolAbortControllersRef.current.values()) {
      controller.abort();
    }
    groundedToolAbortControllersRef.current.clear();
    applyTurnSignal({ kind: "user-interrupt" });
  }, [applyTurnSignal, commitBufferedAssistantTranscript, flushVoiceTurn]);

  const toggleMute = useCallback((): void => {
    const next = !muted;
    if (next) {
      clearInputRearmTimer();
      setInputRearming(false);
    } else {
      armInputRearmGuard();
    }
    setMuted(next);
  }, [armInputRearmGuard, clearInputRearmTimer, muted]);

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
    listening:
      state.phase === "connected" && !muted && !inputRearming && turnSnapshot.state === "listening",
    speaking: state.phase === "connected" && turnSnapshot.state === "speaking",
    canInterrupt: state.phase === "connected" && turnSnapshot.floorHolder === "assistant",
    muted,
    start,
    stop,
    retry,
    interrupt,
    toggleMute,
  };
}
