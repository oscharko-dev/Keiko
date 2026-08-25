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
import {
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  type VoiceSessionChatContext,
} from "@oscharko-dev/keiko-contracts";
import {
  canonicalVoiceHasherIsReady,
  canonicalVoiceSha256Hex,
  prepareCanonicalVoiceHasher as prepareDefaultCanonicalVoiceHasher,
} from "./canonical-voice-hasher";
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
import {
  boundedRealtimeTranscriptText,
  MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES,
  parseRealtimeVoiceEvent,
  realtimeTranscriptByteLength,
  type ParsedRealtimeVoiceEvent,
} from "./voice-realtime-events";
import {
  createVoiceTurnManager,
  type VoiceTurnManagerEngine,
  type VoiceTurnEffect,
  type VoiceTurnSnapshot,
} from "./voice-turn-manager";
import {
  createVoiceLatencyObserver,
  type VoiceLatencyObserver,
  type VoiceLatencyObserverSink,
} from "./voice-latency-observer";

type CurrentRef<T> = { current: T };

// A transient WebRTC `disconnected` state is recoverable (a brief network blip, an ICE restart): the
// connection often returns to `connected` on its own. Tearing the session down the instant it appears
// drops a live conversation over a momentary hiccup. We keep the session alive for this grace window
// and only treat the connection as lost if it has not recovered by the time it elapses.
const ICE_DISCONNECT_GRACE_MS = 5_000;
// After re-enabling a disabled microphone track, browsers may need a short re-arm window before
// capture/VAD is reliably live again. Keep the UI from presenting a stale listening state during it.
const INPUT_UNMUTE_REARM_MS = 300;
// Minimal EC/NS/AGC settling floor before the session is presented as ready. It is armed at start()
// and runs IN PARALLEL with the SDP/ICE/data-channel negotiation, so on a warm path (negotiation
// takes longer than this floor, the common case) it adds zero latency to time-to-connected; it only
// caps how early a super-fast reconnect can flip to "connected". Kept small because verbatim start-of-
// utterance capture is already guaranteed server-side by the realtime turn_detection prefix_padding
// (300ms of pre-onset audio). The VoiceLatencyObserver marks (rtc_connected/session_updated/warmup)
// give the data to drive this to 0 if the floor proves unnecessary in the field.
const SESSION_READY_WARMUP_MS = 150;
// Realtime VAD can finalize a transcript at a short clause boundary even though the speaker is only
// pausing for breath. Hold canonical chat dispatch briefly and merge any next segment that starts in
// this window. This prevents Keiko from answering over a continuing utterance while keeping the
// provider's media/VAD responsiveness and explicit barge-in behavior intact.
const CANONICAL_TURN_CONTINUATION_GRACE_MS = 1_600;
const MAX_TRACKED_REALTIME_TRANSCRIPT_ITEMS = 32;
const CANONICAL_TURN_ADMISSION_ERROR_MESSAGE =
  "The spoken transcript could not be added to chat automatically. It remains visible for review.";
const CANONICAL_TURN_CAPACITY_REACHED_MESSAGE =
  "The spoken transcript is queued in chat. Voice capture paused until pending turns make room.";
const DEFAULT_REALTIME_VAD_PREFIX_PADDING_MS = 300;
const DEFAULT_REALTIME_VAD_SILENCE_DURATION_MS = 500;
const DEFAULT_REALTIME_VAD_THRESHOLD = 0.5;
const TRANSCRIPT_OVERLAP_EDGE_CHARACTER = /[\p{P}\p{S}]/u;
const TRANSCRIPT_NUMBER = /\p{N}/u;
const TRANSCRIPT_IDENTIFIER = /(?:[_:.#/\\-]|[\p{Ll}\p{M}]\p{Lu}|^\p{Lu}{2,}$)/u;
const TRANSCRIPT_PROPER_NAME = /^\p{Lu}[\p{L}\p{M}'\u2019.-]{2,}$/u;
const TRANSCRIPT_SENTENCE_BOUNDARY = /[.!?\u2026][\p{Pe}\p{Pf}"']*$/u;
const MAX_TRANSCRIPT_SEGMENT_OVERLAP_TOKENS = 8;

// Turn-detection profiles (P6). Endpointing must adapt to the acoustic path: a close-mic headset can
// end a turn far sooner than a laptop mic bleeding the assistant's own voice, and a noisy room needs a
// longer tail so between-word pauses don't cut the speaker off. `semantic` switches to the provider's
// semantic VAD, which decides end-of-turn from linguistic cues rather than raw silence and is markedly
// less likely to truncate an unfinished utterance ("ähm…") — the exact "the end wasn't understood"
// complaint — at the cost of requiring provider support. `balanced` reproduces the prior behavior
// byte-for-byte, so it stays the safe default and no session changes endpointing without an explicit opt-in.
type RealtimeTurnDetectionProfile = "balanced" | "headset" | "laptop" | "noisy" | "semantic";

// A total table: adding a profile without a builder is a compile error. Each builder returns a FRESH
// object so the caller can safely layer interrupt_response / create_response onto it.
const TURN_DETECTION_PROFILE_BUILDERS: Record<
  RealtimeTurnDetectionProfile,
  () => Record<string, unknown>
> = {
  balanced: () => ({
    type: "server_vad",
    threshold: DEFAULT_REALTIME_VAD_THRESHOLD,
    prefix_padding_ms: DEFAULT_REALTIME_VAD_PREFIX_PADDING_MS,
    silence_duration_ms: DEFAULT_REALTIME_VAD_SILENCE_DURATION_MS,
  }),
  headset: () => ({
    type: "server_vad",
    threshold: 0.4,
    prefix_padding_ms: 200,
    silence_duration_ms: 420,
  }),
  laptop: () => ({
    type: "server_vad",
    threshold: 0.55,
    prefix_padding_ms: 300,
    silence_duration_ms: 620,
  }),
  noisy: () => ({
    type: "server_vad",
    threshold: 0.66,
    prefix_padding_ms: 300,
    silence_duration_ms: 760,
  }),
  semantic: () => ({ type: "semantic_vad", eagerness: "low" }),
};

function buildRealtimeSessionUpdate(
  turnDetectionProfile: RealtimeTurnDetectionProfile | undefined,
): Record<string, unknown> {
  const session: Record<string, unknown> = { type: "realtime" };
  if (turnDetectionProfile === undefined) {
    return { type: "session.update", session };
  }
  const turnDetection: Record<string, unknown> = {
    ...TURN_DETECTION_PROFILE_BUILDERS[turnDetectionProfile ?? "balanced"](),
    interrupt_response: false,
    create_response: false,
  };
  session.audio = {
    input: {
      turn_detection: turnDetection,
    },
  };
  return { type: "session.update", session };
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
  // The active chat identity is used only for server-side authority and safety scoping. It is never
  // sent to the realtime provider as prompt context.
  readonly chatContext?: VoiceSessionChatContext | undefined;
  // Turn-detection endpointing profile applied via session.update (P6). Adapts end-of-turn detection to
  // the acoustic path (headset/laptop/noisy) or switches to provider semantic VAD. Undefined keeps the
  // server-owned endpointing default, so an unset caller never rewrites provider capability tuning.
  readonly turnDetectionProfile?: RealtimeTurnDetectionProfile | undefined;
  // Optional content-free latency sink (Plan §1). Receives only mark enum literals and millisecond
  // deltas across connect + turn-taking — never SDP, transcript, or audio.
  readonly latencySink?: VoiceLatencyObserverSink | undefined;
  // Test seams: inject fake factories. Production uses the browser transport and the BFF client.
  readonly createTransport?: (() => VoiceRtcTransport) | undefined;
  readonly createControl?: (() => VoiceControlClient) | undefined;
  readonly prepareCanonicalVoiceHasher?: (() => Promise<void>) | undefined;
  // Content-free admission guard owned by the canonical Chat outbox. Capture may start only while
  // that outbox still has regular capacity; its single reserve slot belongs to an already captured
  // provider final and must never be treated as permission to open another media session.
  readonly canStartCapture?: (() => boolean) | undefined;
  // Canonical Voice Digital Twin handoff. When present, a final spoken transcript becomes a normal
  // chat turn immediately; the realtime provider remains the media/VAD/transcription adapter and must
  // not generate or persist a competing assistant answer. The callback accepts ownership
  // synchronously; durable admission/reconciliation lives in the canonical Chat owner.
  readonly onCanonicalUserTurn?:
    ((turn: CanonicalVoiceUserTurn) => CanonicalVoiceTurnHandoffResult) | undefined;
  // Raised once at the beginning of each user utterance so the canonical chat generation and local
  // speech playback can be interrupted before the final transcript arrives (barge-in).
  readonly onUserSpeechStart?: (() => void) | undefined;
  // Local, content-free acknowledgement for a turn-manager backchannel effect. It cannot create a
  // model response, write a transcript, or cross the control-plane boundary.
  readonly onTurnBackchannel?: (() => void) | undefined;
  // Live signal for whether a grounded retrieval is currently in flight for the pending canonical
  // voice turn (ADR-0154 D1/D5 — retrieval runs in the canonical chat pipeline AFTER the final
  // transcript is handed off, never inside Realtime itself, so Realtime holds no retrieval state
  // of its own). The caller derives this from the canonical send state it already owns (e.g.
  // useChatSession's `sending` plus the active chat's grounding scope) and passes the current
  // value on every render; the hook only mirrors it onto the returned controller's `retrieving`.
  readonly retrieving?: boolean | undefined;
}

type CanonicalVoiceTurnHandoffResult = boolean | "accepted-stop" | void;
type FailedRealtimeTranscriptEvent = Extract<
  ParsedRealtimeVoiceEvent,
  { readonly kind: "user-transcript-failed" }
>;

interface CanonicalVoiceUserTurn {
  readonly turnId: string;
  readonly text: string;
}

type CanonicalVoiceTurnDelivery = NonNullable<UseRealtimeVoiceOptions["onCanonicalUserTurn"]>;

interface CanonicalVoiceTurnHandoff {
  readonly accepted: boolean;
  readonly stopCapture: boolean;
}

interface VoiceTurnDraft {
  fallbackTurnId: string;
}

function realtimeEventBelongsToSession(
  event: ParsedRealtimeVoiceEvent,
  sessionChatId: string | undefined,
  currentChatId: string | undefined,
): boolean {
  if (sessionChatId === currentChatId) return true;
  return sessionChatId !== undefined && event.kind === "user-transcript-committed";
}

interface PendingCanonicalUserTurn {
  readonly baseTurnId: string;
  readonly text: string;
  readonly deliver: CanonicalVoiceTurnDelivery;
}

function canonicalVoiceUserTurn(pending: PendingCanonicalUserTurn): CanonicalVoiceUserTurn {
  return { turnId: pending.baseTurnId, text: pending.text };
}

function providerCanonicalTurnId(namespace: string, providerItemId: string): string {
  const identity = JSON.stringify(["canonical-realtime-turn-v1", namespace, providerItemId]);
  const digest = canonicalVoiceSha256Hex(identity);
  return `client-turn-${namespace}-${digest}`;
}

function rememberBoundedIdentity(set: Set<string>, identity: string): void {
  if (set.has(identity)) return;
  if (set.size >= MAX_TRACKED_REALTIME_TRANSCRIPT_ITEMS) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(identity);
}

function trimTranscriptOverlapEdges(value: string): string {
  const characters = [...value];
  let start = 0;
  let end = characters.length;
  while (start < end && TRANSCRIPT_OVERLAP_EDGE_CHARACTER.test(characters[start] ?? "")) start += 1;
  while (end > start && TRANSCRIPT_OVERLAP_EDGE_CHARACTER.test(characters[end - 1] ?? "")) end -= 1;
  return characters.slice(start, end).join("");
}

function transcriptOverlapToken(value: string): string {
  return trimTranscriptOverlapEdges(value).normalize("NFC").toLowerCase();
}

function transcriptOverlapTokensMatch(first: string, second: string): boolean {
  const normalizedFirst = transcriptOverlapToken(first);
  return normalizedFirst.length > 0 && normalizedFirst === transcriptOverlapToken(second);
}

function isDistinctiveSingleTokenOverlap(first: string, second: string): boolean {
  if (!transcriptOverlapTokensMatch(first, second)) return false;
  const firstCore = trimTranscriptOverlapEdges(first);
  const secondCore = trimTranscriptOverlapEdges(second);
  const canonical = transcriptOverlapToken(first);
  return (
    TRANSCRIPT_NUMBER.test(canonical) ||
    TRANSCRIPT_IDENTIFIER.test(firstCore) ||
    TRANSCRIPT_IDENTIFIER.test(secondCore) ||
    (TRANSCRIPT_PROPER_NAME.test(firstCore) && TRANSCRIPT_PROPER_NAME.test(secondCore))
  );
}

function transcriptSegmentOverlap(first: readonly string[], second: readonly string[]): number {
  // A final sentence followed by the same words is a deliberate repetition, not a provider retry.
  // Only trim a bounded suffix/prefix overlap within an open continuation at the segment seam.
  if (TRANSCRIPT_SENTENCE_BOUNDARY.test(first.join(" "))) return 0;
  const limit = Math.min(first.length, second.length, MAX_TRANSCRIPT_SEGMENT_OVERLAP_TOKENS);
  for (let size = limit; size >= 2; size -= 1) {
    const firstOffset = first.length - size;
    const matches = second
      .slice(0, size)
      .every((token, index) =>
        transcriptOverlapTokensMatch(first[firstOffset + index] ?? "", token),
      );
    if (matches) return size;
  }
  const firstTail = first.at(-1);
  const secondHead = second[0];
  return firstTail !== undefined &&
    secondHead !== undefined &&
    isDistinctiveSingleTokenOverlap(firstTail, secondHead)
    ? 1
    : 0;
}

function joinTranscriptSegments(first: string | undefined, second: string): string {
  const normalizedFirst = normalizedTranscriptText(first ?? "");
  const normalizedSecond = normalizedTranscriptText(second);
  if (normalizedFirst.length === 0) return normalizedSecond;
  if (normalizedSecond.length === 0) return normalizedFirst;
  const firstTokens = normalizedFirst.split(" ");
  const secondTokens = normalizedSecond.split(" ");
  const overlap = transcriptSegmentOverlap(firstTokens, secondTokens);
  return `${normalizedFirst} ${secondTokens.slice(overlap).join(" ")}`.trimEnd();
}

interface SessionReadiness {
  answerApplied: boolean;
  rtcConnected: boolean;
  dataChannelOpen: boolean;
  sessionUpdated: boolean;
  warmupComplete: boolean;
  requiresDataChannelAck: boolean;
}

function freshSessionReadiness(): SessionReadiness {
  return {
    answerApplied: false,
    rtcConnected: false,
    dataChannelOpen: false,
    sessionUpdated: false,
    warmupComplete: false,
    requiresDataChannelAck: true,
  };
}

function createVoiceTurnNamespace(): string {
  const words = new Uint32Array(4);
  globalThis.crypto.getRandomValues(words);
  return [...words].map((word) => word.toString(16).padStart(8, "0")).join("");
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
  // Provider interim transcription for the current utterance. Ephemeral UI state only: the value is
  // cleared as soon as the final transcript becomes a canonical chat message and is never persisted.
  readonly partialUserTranscript: string | undefined;
  // True while a grounded retrieval is in flight for the current turn (drives the 'checking-sources' aura).
  readonly retrieving: boolean;
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

// Builds the retry callback for the delayed reconnect attempt scheduled by
// the transport-recovery path. Extracted to a named factory so the returned callback is defined at
// module scope instead of nested inline inside the recovery callback.
function createReconnectRetryHandler(
  mountedRef: CurrentRef<boolean>,
  reconnectTimerRef: CurrentRef<ReturnType<typeof setTimeout> | undefined>,
  startRef: CurrentRef<(() => void) | undefined>,
): () => void {
  return () => {
    reconnectTimerRef.current = undefined;
    if (!mountedRef.current) return;
    startRef.current?.();
  };
}

interface RealtimeVoiceCleanupOptions {
  readonly discardControl?: boolean;
  readonly preservePartialTranscript?: boolean;
  readonly teardown?: boolean;
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
  const [partialUserTranscript, setPartialUserTranscript] = useState<string | undefined>();

  const transportFactory = options.createTransport ?? createBrowserVoiceRtcTransport;
  const chatContextRef = useRef(options.chatContext);
  chatContextRef.current = options.chatContext;
  const currentChatIdRef = useRef(options.chatContext?.chatId);
  currentChatIdRef.current = options.chatContext?.chatId;
  const sessionChatIdRef = useRef<string | undefined>(undefined);
  const sessionCanonicalUserTurnRef = useRef<CanonicalVoiceTurnDelivery | undefined>(undefined);
  const previousChatIdRef = useRef(options.chatContext?.chatId);
  const controlFactory = useMemo(
    () =>
      options.createControl ??
      ((): VoiceControlClient =>
        createBrowserVoiceControlClient(undefined, chatContextRef.current)),
    [options.createControl],
  );
  const onCanonicalUserTurnRef = useRef(options.onCanonicalUserTurn);
  const onUserSpeechStartRef = useRef(options.onUserSpeechStart);
  const canStartCaptureRef = useRef(options.canStartCapture);
  // Latest requested profile, plus the value frozen for the current session at start() (so a mid-session
  // option change never rewrites the live session's endpointing behind the user's back).
  const turnDetectionProfileRef = useRef(options.turnDetectionProfile);
  const sessionTurnDetectionProfileRef = useRef(options.turnDetectionProfile);
  // Content-free latency instrumentation. Read via `latencyRef.current` at call sites so the many
  // memoized callbacks below need no extra dependency; the sink proxy forwards the latest option.
  const latencySinkRef = useRef(options.latencySink);
  latencySinkRef.current = options.latencySink;
  const latencyRef = useRef<VoiceLatencyObserver | undefined>(undefined);
  latencyRef.current ??= createVoiceLatencyObserver({
    sink: {
      onMark: (sample) => latencySinkRef.current?.onMark?.(sample),
      onLeg: (leg) => latencySinkRef.current?.onLeg?.(leg),
    },
  });
  onCanonicalUserTurnRef.current = options.onCanonicalUserTurn;
  onUserSpeechStartRef.current = options.onUserSpeechStart;
  canStartCaptureRef.current = options.canStartCapture;
  turnDetectionProfileRef.current = options.turnDetectionProfile;

  const sessionRef = useRef<VoiceRtcSession | undefined>(undefined);
  const controlRef = useRef<VoiceControlClient | undefined>(undefined);
  const startupAbortRef = useRef<AbortController | undefined>(undefined);
  const canonicalVoiceHasherPreparedRef = useRef(
    options.prepareCanonicalVoiceHasher === undefined && canonicalVoiceHasherIsReady(),
  );
  const prepareCanonicalVoiceHasherRef = useRef(
    options.prepareCanonicalVoiceHasher ?? prepareDefaultCanonicalVoiceHasher,
  );
  prepareCanonicalVoiceHasherRef.current =
    options.prepareCanonicalVoiceHasher ?? prepareDefaultCanonicalVoiceHasher;
  const startRef = useRef<(() => void) | undefined>(undefined);
  const sessionReadyWarmupTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionReadinessDeadlineTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const sessionReadinessRef = useRef<SessionReadiness>(freshSessionReadiness());
  const sessionUpdateSentRef = useRef(false);
  const readyDispatchedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const userTranscriptItemsRef = useRef<Set<string>>(new Set());
  const userTranscriptDeltaItemsRef = useRef<Map<string, string>>(new Map());
  const userTranscriptDeltaBytesRef = useRef<Map<string, number>>(new Map());
  const rejectedUserTranscriptItemsRef = useRef<Set<string>>(new Set());
  const latestUserTranscriptDeltaKeyRef = useRef<string | undefined>(undefined);
  const userSpeechActiveRef = useRef(false);
  const pendingCanonicalUserTurnRef = useRef<PendingCanonicalUserTurn | undefined>(undefined);
  const canonicalAdmissionBlockedRef = useRef(false);
  const canonicalTurnOverflowedRef = useRef(false);
  const canonicalTurnTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushPendingCanonicalUserTurnRef = useRef<() => void>(() => undefined);
  const preservePendingCanonicalUserTurnRef = useRef<() => void>(() => undefined);
  const beginRecoveryRef = useRef<() => void>(() => undefined);
  const executeTurnEffectsRef = useRef<(effects: readonly VoiceTurnEffect[]) => void>(() => undefined);
  const haltForCanonicalAdmissionFailureRef = useRef<() => void>(() => undefined);
  const currentVoiceTurnRef = useRef<VoiceTurnDraft | undefined>(undefined);
  const voiceTurnSeqRef = useRef(0);
  const voiceTurnNamespaceRef = useRef(createVoiceTurnNamespace());
  const lastAnonymousFinalTextRef = useRef<string | undefined>(undefined);
  // Pending teardown timer for a transient `disconnected` state (see ICE_DISCONNECT_GRACE_MS).
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unmuteRearmTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failProviderSessionRef = useRef<(message: string) => void>(() => undefined);
  // Guards every state update that runs after an `await`, so a composer that unmounts mid-flow
  // (e.g. while permission is pending or negotiation is in flight) never dispatches onto an
  // unmounted component and never leaves the microphone open.
  const mountedRef = useRef(true);

  const applyTurnSignal = useCallback(
    (signal: Parameters<VoiceTurnManagerEngine["apply"]>[0]): void => {
      const result = turnManagerRef.current.apply(signal);
      setTurnSnapshot(result.snapshot);
      executeTurnEffectsRef.current(result.effects);
    },
    [],
  );

  const maybeDispatchConnected = useCallback((): void => {
    const readiness = sessionReadinessRef.current;
    if (
      readyDispatchedRef.current ||
      !mountedRef.current ||
      !readiness.answerApplied ||
      !readiness.rtcConnected ||
      !readiness.dataChannelOpen ||
      !readiness.warmupComplete ||
      (readiness.requiresDataChannelAck && !readiness.sessionUpdated)
    ) {
      return;
    }
    readyDispatchedRef.current = true;
    if (sessionReadinessDeadlineTimerRef.current !== undefined) {
      clearTimeout(sessionReadinessDeadlineTimerRef.current);
      sessionReadinessDeadlineTimerRef.current = undefined;
    }
    reconnectAttemptsRef.current = 0;
    applyTurnSignal({ kind: "recovered" });
    dispatch({ type: "connected" });
    latencyRef.current?.mark("session_ready");
  }, [applyTurnSignal]);

  const sendSessionUpdate = useCallback((): void => {
    if (sessionUpdateSentRef.current) {
      return;
    }
    sessionUpdateSentRef.current = true;
    const accepted = sessionRef.current?.sendDataChannelEvent?.(
      buildRealtimeSessionUpdate(sessionTurnDetectionProfileRef.current),
    );
    if (accepted === false) {
      sessionReadinessRef.current = {
        ...sessionReadinessRef.current,
        sessionUpdated: false,
      };
    }
  }, []);

  const resetTurnState = useCallback(
    (
      options: {
        readonly preserveFinalTranscriptDedupe?: boolean;
        readonly preservePartialTranscript?: boolean;
        readonly suppressUiUpdates?: boolean;
      } = {},
    ): void => {
      turnManagerRef.current.reset();
      if (options.suppressUiUpdates !== true) {
        setTurnSnapshot(turnManagerRef.current.snapshot());
      }
      // A resumed control session can replay a provider final after the media plane reconnects. Keep
      // committed item identities across recoverable replacement so the same final cannot enter the
      // canonical chat twice; explicit stop/unmount still starts the next dialogue with a fresh set.
      if (options.preserveFinalTranscriptDedupe !== true) {
        userTranscriptItemsRef.current.clear();
        lastAnonymousFinalTextRef.current = undefined;
      }
      userTranscriptDeltaItemsRef.current.clear();
      userTranscriptDeltaBytesRef.current.clear();
      rejectedUserTranscriptItemsRef.current.clear();
      latestUserTranscriptDeltaKeyRef.current = undefined;
      userSpeechActiveRef.current = false;
      canonicalTurnOverflowedRef.current = false;
      if (options.suppressUiUpdates !== true && options.preservePartialTranscript !== true) {
        setPartialUserTranscript(undefined);
      }
      currentVoiceTurnRef.current = undefined;
    },
    [],
  );

  const resetSessionReadiness = useCallback((): void => {
    if (sessionReadyWarmupTimerRef.current !== undefined) {
      clearTimeout(sessionReadyWarmupTimerRef.current);
      sessionReadyWarmupTimerRef.current = undefined;
    }
    if (sessionReadinessDeadlineTimerRef.current !== undefined) {
      clearTimeout(sessionReadinessDeadlineTimerRef.current);
      sessionReadinessDeadlineTimerRef.current = undefined;
    }
    sessionReadinessRef.current = freshSessionReadiness();
    sessionUpdateSentRef.current = false;
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

  const beginVoiceTurn = useCallback((): VoiceTurnDraft => {
    voiceTurnSeqRef.current += 1;
    const turn: VoiceTurnDraft = {
      fallbackTurnId: `client-turn-${voiceTurnNamespaceRef.current}-${String(voiceTurnSeqRef.current)}`,
    };
    currentVoiceTurnRef.current = turn;
    return turn;
  }, []);

  const ensureVoiceTurn = useCallback((): VoiceTurnDraft => {
    return currentVoiceTurnRef.current ?? beginVoiceTurn();
  }, [beginVoiceTurn]);

  const surfaceCanonicalAdmissionFailure = useCallback((): void => {
    applyTurnSignal({ kind: "provider-failure", recoverable: true });
    dispatch({
      type: "error",
      reason: "connection-failed",
      message: CANONICAL_TURN_ADMISSION_ERROR_MESSAGE,
    });
  }, [applyTurnSignal]);

  const surfaceCanonicalCapacityReached = useCallback((): void => {
    applyTurnSignal({ kind: "provider-failure", recoverable: true });
    dispatch({
      type: "error",
      reason: "connection-failed",
      message: CANONICAL_TURN_CAPACITY_REACHED_MESSAGE,
    });
  }, [applyTurnSignal]);

  const handoffCanonicalUserTurn = useCallback(
    (pending: PendingCanonicalUserTurn, suppressUiUpdates = false): CanonicalVoiceTurnHandoff => {
      try {
        const result = pending.deliver(canonicalVoiceUserTurn(pending));
        return { accepted: result !== false, stopCapture: result === "accepted-stop" };
      } catch {
        if (!suppressUiUpdates) {
          setPartialUserTranscript(pending.text);
          surfaceCanonicalAdmissionFailure();
        }
        return { accepted: false, stopCapture: false };
      }
    },
    [surfaceCanonicalAdmissionFailure],
  );

  const flushPendingCanonicalUserTurn = useCallback((): void => {
    if (canonicalTurnTimerRef.current !== undefined) {
      clearTimeout(canonicalTurnTimerRef.current);
      canonicalTurnTimerRef.current = undefined;
    }
    const pending = pendingCanonicalUserTurnRef.current;
    if (pending === undefined || canonicalAdmissionBlockedRef.current) return;
    const handoff = handoffCanonicalUserTurn(pending, true);
    if (handoff.accepted) {
      pendingCanonicalUserTurnRef.current = undefined;
      canonicalTurnOverflowedRef.current = false;
      setPartialUserTranscript(undefined);
      if (handoff.stopCapture) {
        surfaceCanonicalCapacityReached();
        haltForCanonicalAdmissionFailureRef.current();
      }
      return;
    }
    // The canonical Chat outbox is the only long-lived FIFO. Its hard capacity rejection stops
    // capture and keeps exactly this one immutable final reviewable; Realtime never starts a second
    // queue or polls admission in the background. The explicit Retry control may re-attempt it.
    canonicalAdmissionBlockedRef.current = true;
    setPartialUserTranscript(pending.text);
    surfaceCanonicalAdmissionFailure();
    haltForCanonicalAdmissionFailureRef.current();
  }, [handoffCanonicalUserTurn, surfaceCanonicalAdmissionFailure, surfaceCanonicalCapacityReached]);
  flushPendingCanonicalUserTurnRef.current = flushPendingCanonicalUserTurn;

  const flushPendingCanonicalUserTurnOnTeardown = useCallback((): void => {
    if (!canonicalAdmissionBlockedRef.current) flushPendingCanonicalUserTurn();
  }, [flushPendingCanonicalUserTurn]);

  /*
   * A provider-final transcript is authoritative, but the linguistic continuation timer only owns
   * the still-mutable utterance. Once that timer settles a turn, Chat either owns it synchronously
   * or capture stops at the single outbox's hard capacity boundary.
   */
  const armPendingCanonicalUserTurn = useCallback((): void => {
    const pending = pendingCanonicalUserTurnRef.current;
    if (pending === undefined || sessionRef.current === undefined || userSpeechActiveRef.current)
      return;
    if (canonicalTurnTimerRef.current !== undefined) {
      clearTimeout(canonicalTurnTimerRef.current);
    }
    canonicalTurnTimerRef.current = setTimeout(
      () => flushPendingCanonicalUserTurnRef.current(),
      CANONICAL_TURN_CONTINUATION_GRACE_MS,
    );
  }, []);

  const holdPendingCanonicalUserTurn = useCallback((): void => {
    if (canonicalTurnTimerRef.current !== undefined) {
      clearTimeout(canonicalTurnTimerRef.current);
      canonicalTurnTimerRef.current = undefined;
    }
    setPartialUserTranscript(pendingCanonicalUserTurnRef.current?.text);
  }, []);
  preservePendingCanonicalUserTurnRef.current = holdPendingCanonicalUserTurn;

  const executeTurnEffects = useCallback((effects: readonly VoiceTurnEffect[]): void => {
    let interruptAssistant = false;
    for (const effect of effects) {
      switch (effect) {
        case "stop-playback":
        case "cancel-speech-generation":
          interruptAssistant = true;
          break;
        case "preserve-user-turn":
          preservePendingCanonicalUserTurnRef.current();
          break;
        case "emit-backchannel":
          options.onTurnBackchannel?.();
          break;
        case "begin-recovery":
          beginRecoveryRef.current();
          break;
      }
    }
    if (interruptAssistant) onUserSpeechStartRef.current?.();
  }, [options.onTurnBackchannel]);
  executeTurnEffectsRef.current = executeTurnEffects;

  const rejectOversizedCanonicalUserTurn = useCallback(
    (text: string): void => {
      if (canonicalTurnTimerRef.current !== undefined) {
        clearTimeout(canonicalTurnTimerRef.current);
        canonicalTurnTimerRef.current = undefined;
      }
      canonicalTurnOverflowedRef.current = true;
      currentVoiceTurnRef.current = undefined;
      pendingCanonicalUserTurnRef.current = undefined;
      setPartialUserTranscript(boundedRealtimeTranscriptText(text));
      surfaceCanonicalAdmissionFailure();
    },
    [surfaceCanonicalAdmissionFailure],
  );

  const stagePendingCanonicalUserTurn = useCallback(
    (turn: VoiceTurnDraft, text: string, deliver: CanonicalVoiceTurnDelivery): void => {
      currentVoiceTurnRef.current = undefined;
      pendingCanonicalUserTurnRef.current = {
        baseTurnId: turn.fallbackTurnId,
        text,
        deliver,
      };
      setPartialUserTranscript(text);
      armPendingCanonicalUserTurn();
    },
    [armPendingCanonicalUserTurn],
  );

  const scheduleCanonicalUserTurn = useCallback(
    (turn: VoiceTurnDraft, text: string): void => {
      if (canonicalTurnOverflowedRef.current) {
        surfaceCanonicalAdmissionFailure();
        return;
      }
      // Scope/model changes inside the same chat must be observed by the next final. Only the tiny
      // chat-switch render -> passive-cleanup window keeps the callback frozen at session start, so
      // a late A final can never be redirected through the freshly rendered chat B callback.
      const canonicalTurn =
        sessionChatIdRef.current === currentChatIdRef.current
          ? (onCanonicalUserTurnRef.current ?? sessionCanonicalUserTurnRef.current)
          : sessionCanonicalUserTurnRef.current;
      if (canonicalTurn === undefined) {
        currentVoiceTurnRef.current = undefined;
        surfaceCanonicalAdmissionFailure();
        return;
      }
      const pending = pendingCanonicalUserTurnRef.current;
      const joinedText = joinTranscriptSegments(pending?.text, text);
      if (realtimeTranscriptByteLength(joinedText) > MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES) {
        if (pending === undefined) {
          rejectOversizedCanonicalUserTurn(joinedText);
          return;
        }
        // The new fragment cannot retroactively invalidate a previously accepted provider final.
        // Freeze that valid predecessor as its own turn, then start a new bounded turn for this
        // individually valid fragment. An individually oversized fragment remains review-only.
        flushPendingCanonicalUserTurn();
        if (canonicalAdmissionBlockedRef.current) return;
        if (realtimeTranscriptByteLength(text) > MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES) {
          rejectOversizedCanonicalUserTurn(text);
        } else {
          stagePendingCanonicalUserTurn(turn, text, canonicalTurn);
        }
        return;
      }
      stagePendingCanonicalUserTurn(
        { fallbackTurnId: pending?.baseTurnId ?? turn.fallbackTurnId },
        joinedText,
        pending?.deliver ?? canonicalTurn,
      );
    },
    [
      rejectOversizedCanonicalUserTurn,
      flushPendingCanonicalUserTurn,
      stagePendingCanonicalUserTurn,
      surfaceCanonicalAdmissionFailure,
    ],
  );

  const commitUserTranscript = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "user-transcript-committed" }>): void => {
      const id = eventIdentity(event);
      if (id !== undefined) {
        if (userTranscriptItemsRef.current.has(id)) {
          return;
        }
        rememberBoundedIdentity(userTranscriptItemsRef.current, id);
        rejectedUserTranscriptItemsRef.current.delete(id);
        userTranscriptDeltaItemsRef.current.delete(id);
        userTranscriptDeltaBytesRef.current.delete(id);
        if (latestUserTranscriptDeltaKeyRef.current === id) {
          latestUserTranscriptDeltaKeyRef.current = undefined;
        }
      } else {
        const anonymousText = normalizedTranscriptText(event.text);
        if (lastAnonymousFinalTextRef.current === anonymousText) return;
        lastAnonymousFinalTextRef.current = anonymousText;
      }
      const turn = ensureVoiceTurn();
      if (id !== undefined) {
        turn.fallbackTurnId = providerCanonicalTurnId(voiceTurnNamespaceRef.current, id);
      }
      if (!canonicalTurnOverflowedRef.current) setPartialUserTranscript(undefined);
      scheduleCanonicalUserTurn(turn, event.text);
    },
    [ensureVoiceTurn, scheduleCanonicalUserTurn],
  );

  const appendUserTranscriptDelta = useCallback(
    (event: Extract<ParsedRealtimeVoiceEvent, { kind: "user-transcript-delta" }>): void => {
      const key = event.itemId ?? "__current";
      const existing = userTranscriptDeltaItemsRef.current.get(key) ?? "";
      if (
        !userTranscriptDeltaItemsRef.current.has(key) &&
        userTranscriptDeltaItemsRef.current.size >= MAX_TRACKED_REALTIME_TRANSCRIPT_ITEMS
      ) {
        surfaceCanonicalAdmissionFailure();
        return;
      }
      const combinedBytes =
        (userTranscriptDeltaBytesRef.current.get(key) ?? 0) +
        realtimeTranscriptByteLength(event.delta);
      if (combinedBytes > MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES) {
        const reviewText = boundedRealtimeTranscriptText(`${existing}${event.delta}`);
        userTranscriptDeltaItemsRef.current.set(key, reviewText);
        userTranscriptDeltaBytesRef.current.set(key, realtimeTranscriptByteLength(reviewText));
        latestUserTranscriptDeltaKeyRef.current = key;
        rejectOversizedCanonicalUserTurn(
          joinTranscriptSegments(pendingCanonicalUserTurnRef.current?.text, reviewText),
        );
        return;
      }
      latestUserTranscriptDeltaKeyRef.current = key;
      userTranscriptDeltaItemsRef.current.set(key, `${existing}${event.delta}`);
      userTranscriptDeltaBytesRef.current.set(key, combinedBytes);
      const text = normalizedTranscriptText(userTranscriptDeltaItemsRef.current.get(key) ?? "");
      if (text.length > 0) {
        setPartialUserTranscript(
          joinTranscriptSegments(pendingCanonicalUserTurnRef.current?.text, text),
        );
        ensureVoiceTurn();
      }
    },
    [ensureVoiceTurn, rejectOversizedCanonicalUserTurn, surfaceCanonicalAdmissionFailure],
  );

  const retainPartialUserTranscript = useCallback((itemId?: string | undefined): void => {
    const key = itemId ?? latestUserTranscriptDeltaKeyRef.current;
    if (key === undefined || rejectedUserTranscriptItemsRef.current.has(key)) return;
    const text = normalizedTranscriptText(userTranscriptDeltaItemsRef.current.get(key) ?? "");
    if (text.length > 0) {
      setPartialUserTranscript(
        joinTranscriptSegments(pendingCanonicalUserTurnRef.current?.text, text),
      );
    }
  }, []);

  const beginUserUtterance = useCallback((): void => {
    lastAnonymousFinalTextRef.current = undefined;
    canonicalTurnOverflowedRef.current = false;
    if (!userSpeechActiveRef.current) {
      userSpeechActiveRef.current = true;
    }
    beginVoiceTurn();
    applyTurnSignal({ kind: "user-speech-start" });
  }, [applyTurnSignal, beginVoiceTurn]);

  const endUserUtterance = useCallback((): void => {
    userSpeechActiveRef.current = false;
    armPendingCanonicalUserTurn();
    applyTurnSignal({ kind: "user-end-of-turn" });
  }, [applyTurnSignal, armPendingCanonicalUserTurn]);

  const handleFailedUserTranscript = useCallback(
    (event: FailedRealtimeTranscriptEvent): void => {
      if (event.reason !== "limit-exceeded") {
        retainPartialUserTranscript(event.itemId);
        applyTurnSignal({ kind: "provider-failure", recoverable: true });
        return;
      }
      const key = event.itemId ?? latestUserTranscriptDeltaKeyRef.current ?? "__current";
      const reviewText = joinTranscriptSegments(
        userTranscriptDeltaItemsRef.current.get(key),
        event.reviewText ?? "",
      );
      if (reviewText.length === 0) {
        canonicalTurnOverflowedRef.current = true;
        surfaceCanonicalAdmissionFailure();
        return;
      }
      userTranscriptDeltaItemsRef.current.set(key, boundedRealtimeTranscriptText(reviewText));
      latestUserTranscriptDeltaKeyRef.current = key;
      const pendingText = pendingCanonicalUserTurnRef.current?.text;
      if (pendingText !== undefined) flushPendingCanonicalUserTurn();
      if (!canonicalAdmissionBlockedRef.current) rejectOversizedCanonicalUserTurn(reviewText);
    },
    [
      applyTurnSignal,
      flushPendingCanonicalUserTurn,
      rejectOversizedCanonicalUserTurn,
      retainPartialUserTranscript,
      surfaceCanonicalAdmissionFailure,
    ],
  );

  const handleRealtimeEvent = useCallback(
    (raw: unknown): void => {
      if (canonicalAdmissionBlockedRef.current) return;
      const event = parseRealtimeVoiceEvent(raw);
      if (event === undefined) return;
      // A final belongs to the authority-bound session even if React has rendered the next chat but
      // its cleanup effect has not closed the old transport yet. All other stale events are ignored.
      if (!realtimeEventBelongsToSession(event, sessionChatIdRef.current, currentChatIdRef.current))
        return;
      switch (event.kind) {
        case "session-created":
          return;
        case "session-updated":
          sessionReadinessRef.current = {
            ...sessionReadinessRef.current,
            sessionUpdated: true,
          };
          latencyRef.current?.mark("session_updated");
          maybeDispatchConnected();
          return;
        case "user-speech-start":
          latencyRef.current?.mark("user_speech_start");
          beginUserUtterance();
          return;
        case "user-speech-stop":
          latencyRef.current?.mark("vad_stop");
          endUserUtterance();
          return;
        case "user-transcript-committed":
          commitUserTranscript(event);
          return;
        case "user-transcript-delta":
          appendUserTranscriptDelta(event);
          return;
        case "user-transcript-failed":
          handleFailedUserTranscript(event);
          return;
        case "error": {
          retainPartialUserTranscript();
          failProviderSessionRef.current(event.message);
          return;
        }
      }
    },
    [
      appendUserTranscriptDelta,
      beginUserUtterance,
      commitUserTranscript,
      endUserUtterance,
      handleFailedUserTranscript,
      maybeDispatchConnected,
      retainPartialUserTranscript,
    ],
  );

  const clearInputRearmTimer = useCallback((): void => {
    if (unmuteRearmTimerRef.current !== undefined) {
      clearTimeout(unmuteRearmTimerRef.current);
      unmuteRearmTimerRef.current = undefined;
    }
  }, []);

  const clearReconnectTimer = useCallback((): void => {
    if (reconnectTimerRef.current !== undefined) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
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
    (options: RealtimeVoiceCleanupOptions = {}): void => {
      const discardControl = options.discardControl ?? true;
      startupAbortRef.current?.abort();
      startupAbortRef.current = undefined;
      if (graceTimerRef.current !== undefined) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = undefined;
      }
      clearReconnectTimer();
      if (discardControl) {
        reconnectAttemptsRef.current = 0;
      }
      if (canonicalTurnTimerRef.current !== undefined) {
        clearTimeout(canonicalTurnTimerRef.current);
        canonicalTurnTimerRef.current = undefined;
      }
      if (!mountedRef.current || options.teardown === true) {
        pendingCanonicalUserTurnRef.current = undefined;
      }
      clearInputRearmTimer();
      if (options.teardown !== true) {
        setInputRearming(false);
      }
      // Detach before close(): RTCPeerConnection.close() may synchronously (or later) emit a terminal
      // connection-state callback. It belongs to the session being replaced and must not recursively
      // tear down cleanup state or a newly connected successor.
      const closingSession = sessionRef.current;
      sessionRef.current = undefined;
      sessionChatIdRef.current = undefined;
      sessionCanonicalUserTurnRef.current = undefined;
      closingSession?.close();
      controlRef.current?.close({ resumable: !discardControl });
      if (discardControl) {
        controlRef.current = undefined;
        voiceTurnNamespaceRef.current = createVoiceTurnNamespace();
        voiceTurnSeqRef.current = 0;
      }
      resetTurnState({
        preserveFinalTranscriptDedupe: !discardControl,
        preservePartialTranscript: options.preservePartialTranscript === true,
        suppressUiUpdates: options.teardown === true,
      });
      resetSessionReadiness();
    },
    [clearInputRearmTimer, clearReconnectTimer, resetSessionReadiness, resetTurnState],
  );
  haltForCanonicalAdmissionFailureRef.current = () => {
    cleanupRefs({ preservePartialTranscript: true });
  };

  const runTransportRecovery = useCallback((): void => {
    if (graceTimerRef.current !== undefined) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = undefined;
    }
    if (!mountedRef.current) return;
    flushPendingCanonicalUserTurn();
    if (canonicalAdmissionBlockedRef.current) return;
    const attempt = reconnectAttemptsRef.current;
    cleanupRefs({ discardControl: false });
    if (attempt >= DEFAULT_VOICE_PROTOCOL_TIMEOUTS.maxReconnectAttempts) {
      dispatch({
        type: "error",
        reason: "connection-failed",
        message: "Real-time voice connection was lost.",
      });
      return;
    }
    reconnectAttemptsRef.current = attempt + 1;
    const delayMs = Math.min(
      DEFAULT_VOICE_PROTOCOL_TIMEOUTS.reconnectBackoffInitialMs * 2 ** attempt,
      DEFAULT_VOICE_PROTOCOL_TIMEOUTS.reconnectBackoffMaxMs,
    );
    reconnectTimerRef.current = setTimeout(
      createReconnectRetryHandler(mountedRef, reconnectTimerRef, startRef),
      delayMs,
    );
  }, [cleanupRefs, flushPendingCanonicalUserTurn]);

  const beginTransportRecovery = useCallback((): void => {
    graceTimerRef.current ??= setTimeout(runTransportRecovery, ICE_DISCONNECT_GRACE_MS);
  }, [runTransportRecovery]);
  beginRecoveryRef.current = beginTransportRecovery;

  const armTransportRecovery = useCallback((): void => {
    applyTurnSignal({ kind: "provider-failure", recoverable: true });
  }, [applyTurnSignal]);

  const recoverTransportNow = useCallback((): void => {
    applyTurnSignal({ kind: "provider-failure", recoverable: true });
    if (graceTimerRef.current !== undefined) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = undefined;
    }
    runTransportRecovery();
  }, [applyTurnSignal, runTransportRecovery]);

  const failProviderSession = useCallback(
    (message: string): void => {
      flushPendingCanonicalUserTurn();
      if (canonicalAdmissionBlockedRef.current) return;
      cleanupRefs({ preservePartialTranscript: true });
      applyTurnSignal({ kind: "provider-failure", recoverable: false });
      dispatch({ type: "error", reason: "connection-failed", message });
    },
    [applyTurnSignal, cleanupRefs, flushPendingCanonicalUserTurn],
  );
  failProviderSessionRef.current = failProviderSession;

  const armSessionReadinessDeadline = useCallback((): void => {
    if (sessionReadinessDeadlineTimerRef.current !== undefined) {
      clearTimeout(sessionReadinessDeadlineTimerRef.current);
    }
    if (readyDispatchedRef.current) return;
    sessionReadinessDeadlineTimerRef.current = setTimeout(() => {
      sessionReadinessDeadlineTimerRef.current = undefined;
      if (!mountedRef.current || readyDispatchedRef.current) return;
      recoverTransportNow();
    }, DEFAULT_VOICE_PROTOCOL_TIMEOUTS.signalingMs);
  }, [recoverTransportNow]);

  useEffect(() => {
    sessionRef.current?.setInputMuted?.(muted);
  }, [muted]);

  const stop = useCallback((): void => {
    if (canonicalAdmissionBlockedRef.current) {
      cleanupRefs({ preservePartialTranscript: true });
      return;
    }
    flushPendingCanonicalUserTurn();
    if (canonicalAdmissionBlockedRef.current) return;
    cleanupRefs();
    dispatch({ type: "reset" });
  }, [cleanupRefs, flushPendingCanonicalUserTurn]);

  const start = useCallback((): void => {
    if (sessionRef.current !== undefined || startupAbortRef.current !== undefined) {
      return;
    }
    if (canStartCaptureRef.current?.() === false) {
      surfaceCanonicalCapacityReached();
      return;
    }
    if (canonicalAdmissionBlockedRef.current) {
      surfaceCanonicalAdmissionFailure();
      return;
    }
    if (!canonicalVoiceHasherPreparedRef.current) {
      dispatch({ type: "requesting" });
      const startup = new AbortController();
      startupAbortRef.current = startup;
      void prepareCanonicalVoiceHasherRef
        .current()
        .then(() => {
          if (
            !mountedRef.current ||
            startup.signal.aborted ||
            startupAbortRef.current !== startup
          ) {
            return;
          }
          canonicalVoiceHasherPreparedRef.current = true;
          startupAbortRef.current = undefined;
          startRef.current?.();
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            startup.signal.aborted ||
            startupAbortRef.current !== startup
          ) {
            return;
          }
          cleanupRefs({ discardControl: false });
          const { reason, message } = classifyError(error);
          dispatch({ type: "error", reason, message });
        });
      return;
    }
    latencyRef.current?.reset();
    latencyRef.current?.mark("mic_click");
    dispatch({ type: "requesting" });
    resetSessionReadiness();
    sessionTurnDetectionProfileRef.current = turnDetectionProfileRef.current;
    sessionChatIdRef.current = currentChatIdRef.current;
    sessionCanonicalUserTurnRef.current = onCanonicalUserTurnRef.current;
    const startup = new AbortController();
    startupAbortRef.current = startup;
    const transport = transportFactory();
    const control = controlRef.current ?? controlFactory();
    controlRef.current = control;

    void transport
      .connect({ signal: startup.signal })
      .then(async (session) => {
        if (!mountedRef.current || startup.signal.aborted || startupAbortRef.current !== startup) {
          session.close();
          if (controlRef.current !== control) {
            control.close();
          }
          return;
        }
        sessionRef.current = session;
        const pendingCanonicalTurn = pendingCanonicalUserTurnRef.current;
        if (pendingCanonicalTurn !== undefined) {
          setPartialUserTranscript(pendingCanonicalTurn.text);
          armPendingCanonicalUserTurn();
        }
        latencyRef.current?.mark("rtc_offer_created");
        session.setInputMuted?.(muted);

        session.onLocalVoiceActivity?.((activity) => {
          if (!mountedRef.current || sessionRef.current !== session || startup.signal.aborted)
            return;
          if (activity === "speech-onset") {
            beginUserUtterance();
            return;
          }
          endUserUtterance();
        });
        session.onDataChannelEvent?.((event) => {
          if (!mountedRef.current || sessionRef.current !== session || startup.signal.aborted)
            return;
          handleRealtimeEvent(event);
        });
        if (session.onDataChannelStateChange !== undefined) {
          sessionReadinessRef.current = {
            ...sessionReadinessRef.current,
            requiresDataChannelAck: true,
          };
          session.onDataChannelStateChange((dataChannelState) => {
            if (!mountedRef.current || sessionRef.current !== session || startup.signal.aborted) {
              return;
            }
            if (dataChannelState === "open") {
              sessionReadinessRef.current = {
                ...sessionReadinessRef.current,
                dataChannelOpen: true,
              };
              latencyRef.current?.mark("datachannel_open");
              sendSessionUpdate();
              maybeDispatchConnected();
              return;
            }
            if (dataChannelState === "closed") {
              armTransportRecovery();
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
          if (!mountedRef.current || sessionRef.current !== session || startup.signal.aborted)
            return;
          if (rtcState === "connected") {
            if (graceTimerRef.current !== undefined) {
              clearTimeout(graceTimerRef.current);
              graceTimerRef.current = undefined;
            }
            sessionReadinessRef.current = {
              ...sessionReadinessRef.current,
              rtcConnected: true,
            };
            latencyRef.current?.mark("rtc_connected");
            applyTurnSignal({ kind: "recovered" });
            maybeDispatchConnected();
          } else if (rtcState === "failed" || rtcState === "closed") {
            recoverTransportNow();
          } else if (rtcState === "disconnected") {
            armTransportRecovery();
          }
        });

        // Publish the externally observable phase only after every media callback is installed.
        // Otherwise a provider final arriving in the render between this dispatch and handler
        // registration is silently lost even though the UI already reports an active negotiation.
        dispatch({ type: "negotiating" });

        const answerSdp = await control.negotiate(session.offerSdp);
        if (!mountedRef.current || sessionRef.current !== session || startup.signal.aborted) {
          session.close();
          return;
        }
        await session.applyAnswer(answerSdp);
        if (!mountedRef.current || sessionRef.current !== session || startup.signal.aborted) {
          session.close();
          return;
        }
        sessionReadinessRef.current = {
          ...sessionReadinessRef.current,
          answerApplied: true,
        };
        latencyRef.current?.mark("sdp_answer");
        armSessionReadinessDeadline();
        maybeDispatchConnected();
        // "connected" dispatch arrives via onConnectionStateChange once WebRTC confirms the link.
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || startup.signal.aborted || startupAbortRef.current !== startup) {
          return;
        }
        flushPendingCanonicalUserTurn();
        cleanupRefs({ discardControl: false });
        const { reason, message } = classifyError(error);
        dispatch({ type: "error", reason, message });
      });
  }, [
    transportFactory,
    controlFactory,
    muted,
    handleRealtimeEvent,
    cleanupRefs,
    resetSessionReadiness,
    armSessionReadyWarmup,
    sendSessionUpdate,
    maybeDispatchConnected,
    applyTurnSignal,
    beginUserUtterance,
    endUserUtterance,
    armPendingCanonicalUserTurn,
    armSessionReadinessDeadline,
    armTransportRecovery,
    recoverTransportNow,
    flushPendingCanonicalUserTurn,
    surfaceCanonicalAdmissionFailure,
    surfaceCanonicalCapacityReached,
  ]);

  useEffect(() => {
    startRef.current = start;
    return () => {
      if (startRef.current === start) {
        startRef.current = undefined;
      }
    };
  }, [start]);

  const retry = useCallback((): void => {
    if (canStartCaptureRef.current?.() === false) {
      surfaceCanonicalCapacityReached();
      return;
    }
    reconnectAttemptsRef.current = 0;
    if (canonicalAdmissionBlockedRef.current) {
      canonicalAdmissionBlockedRef.current = false;
      flushPendingCanonicalUserTurn();
      if (canonicalAdmissionBlockedRef.current) return;
    }
    flushPendingCanonicalUserTurn();
    cleanupRefs({ discardControl: false });
    dispatch({ type: "reset" });
    start();
  }, [cleanupRefs, flushPendingCanonicalUserTurn, start, surfaceCanonicalCapacityReached]);

  const interrupt = useCallback((): void => {
    applyTurnSignal({ kind: "user-interrupt" });
  }, [applyTurnSignal]);

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

  useEffect(() => {
    const nextChatId = options.chatContext?.chatId;
    if (previousChatIdRef.current === nextChatId) return;
    previousChatIdRef.current = nextChatId;
    if (
      sessionRef.current !== undefined ||
      startupAbortRef.current !== undefined ||
      reconnectTimerRef.current !== undefined ||
      graceTimerRef.current !== undefined ||
      pendingCanonicalUserTurnRef.current !== undefined
    ) {
      stop();
    }
  }, [options.chatContext?.chatId, stop]);

  // Release the microphone and WS when the composer unmounts mid-flow. Clearing both refs ensures
  // a late-firing async operation finds no live session and dispatches nothing.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      flushPendingCanonicalUserTurnOnTeardown();
      mountedRef.current = false;
      cleanupRefs({ teardown: true });
    };
  }, [cleanupRefs, flushPendingCanonicalUserTurnOnTeardown]);

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
    speaking: false,
    canInterrupt: false,
    muted,
    partialUserTranscript,
    retrieving: options.retrieving ?? false,
    start,
    stop,
    retry,
    interrupt,
    toggleMute,
  };
}
