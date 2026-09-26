// Public type contracts for the optional Voice Digital Twin control / media protocol (Epic #491,
// Issue #496, ADR-0101). This module DEFINES the wire protocol; it implements no transport. It is
// pure data + pure validators only — nothing performs IO, crypto, clock reads, randomness, or audio
// processing, and no provider base URL, credential, or raw audio buffer is ever a field on these
// types. The `VOICE_PROTOCOL_VERSION` discriminant follows the same evolution rule as
// `WORKFLOW_HANDOFF_SCHEMA_VERSION` / `CONNECTED_CONTEXT_SCHEMA_VERSION`: a breaking change introduces
// a NEW literal member rather than mutating "1". It is INDEPENDENT of
// `CONVERSATION_CAPABILITY_CONTRACT_VERSION` (the capability registry contract, gateway.ts) and never
// bumps it. Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports may appear
// here; sibling types are reached by relative path.
//
// The protocol separates two planes (AC1): the WebSocket control / signaling plane (every message
// kind in this module) and the WebRTC media plane (raw audio frames). Raw audio is never a control
// message and is never replayed or persisted by default (AC5). The control-plane role is realized on
// the single capability-gated loopback WebSocket path selected by Issue #497 and narrowed to
// media-input/transcription authority by ADR-0154.

import { VOICE_PROVIDER_LOCALITIES } from "./gateway.js";
import type {
  VoicePersona,
  VoiceProfile,
  VoiceProviderLocality,
  VoiceUnavailableReason,
} from "./gateway.js";

// ─── Protocol version ─────────────────────────────────────────────────────────
export const VOICE_PROTOCOL_VERSION = "1" as const;

// Compatibility / negotiation rule: a peer accepts a message only when its declared protocol version
// is one this build understands. v1 understands exactly "1"; a future v2 build widens this set.
export function isVoiceProtocolVersionSupported(version: unknown): boolean {
  return version === VOICE_PROTOCOL_VERSION;
}

// ─── Planes (AC1) ───────────────────────────────────────────────────────────────
// The control plane carries every kind in this module (session, capability, SDP/ICE signaling,
// cancellation, interruption, transcript lifecycle, playback state, policy). The media plane carries
// only real-time audio over native browser WebRTC (DTLS-SRTP). No control message kind carries raw
// audio — that separation is the load-bearing AC1 invariant.
export type VoicePlane = "control" | "media";

export const VOICE_PLANES: readonly VoicePlane[] = ["control", "media"] as const;

// How the authoritative control / signaling plane is realized on the transport. The current Voice
// implementation re-opens exactly one capability-gated loopback WebSocket path; HTTP/SSE remains in
// the union only for compatibility with older protocol records.
export type VoiceControlTransport = "loopback-http-sse" | "loopback-websocket";

export const VOICE_CONTROL_TRANSPORTS: readonly VoiceControlTransport[] = [
  "loopback-http-sse",
  "loopback-websocket",
] as const;

// Published v1 transport literal. It describes the original HTTP/SSE realization and is immutable:
// changing a versioned public constant in place breaks persisted records and downstream consumers.
export const VOICE_CONTROL_TRANSPORT_V1: VoiceControlTransport = "loopback-http-sse";

// Productive Twin Voice control transport. Named separately from the immutable v1 compatibility
// constant so the capability-gated WebSocket implementation can evolve additively (ADR-0154).
export const VOICE_REALTIME_CONTROL_TRANSPORT: VoiceControlTransport = "loopback-websocket";

// Media-plane transport per the graceful-degradation ladder. `gateway-batch` is the dictation /
// speech-output realization (audio rides the existing JSON request envelope and is forwarded once
// through the Model Gateway egress seam); `webrtc` is Realtime microphone input/transcription only.
export type VoiceMediaTransport = "none" | "gateway-batch" | "webrtc";

export const VOICE_MEDIA_TRANSPORTS: readonly VoiceMediaTransport[] = [
  "none",
  "gateway-batch",
  "webrtc",
] as const;

// Browser ↔ provider negotiation options for the real-time media plane. `proxied-sdp` is preferred:
// the Keiko host performs SDP negotiation so the browser never holds even the ephemeral token.
// `direct-ephemeral` is an opt-in alternative where the browser uses a short-lived ephemeral
// credential. `disabled` means no browser-direct media negotiation occurs at all.
export type VoiceNegotiationMode = "proxied-sdp" | "direct-ephemeral" | "disabled";

export const VOICE_NEGOTIATION_MODES: readonly VoiceNegotiationMode[] = [
  "proxied-sdp",
  "direct-ephemeral",
  "disabled",
] as const;
const VOICE_NEGOTIATION_MODE_SET: ReadonlySet<string> = new Set(VOICE_NEGOTIATION_MODES);

export const PREFERRED_VOICE_NEGOTIATION_MODE: VoiceNegotiationMode = "proxied-sdp";

// ─── Replay / redaction classification (AC5; replay, reconnect, redaction semantics) ───
// `replayable`     — durable control / committed-transcript events; the local system of record that a
//                    reconnect re-delivers up to the last acknowledged sequence number.
// `ephemeral`      — short-lived signaling (SDP, ICE candidates, ephemeral credentials, partial
//                    transcripts): valid only for the live negotiation, never replayed or persisted.
// `never-persisted`— raw media frames: excluded from replay and from persistence by default (AC5).
export type VoiceReplayClass = "replayable" | "ephemeral" | "never-persisted";

export const VOICE_REPLAY_CLASSES: readonly VoiceReplayClass[] = [
  "replayable",
  "ephemeral",
  "never-persisted",
] as const;

// Redaction class governing how a message is treated by the existing redaction / hashing seams before
// it may enter any log or evidence manifest (privacy-contract §2/§3).
// `content-free`   — enum literals / booleans / integers, plus client-chosen opaque identifiers
//                    (`sessionId`, `idempotencyKey`); the transport (#497) bounds id length and
//                    charset before logging so a hostile id cannot inject into log/audit lines.
// `reviewable-text`— user-reviewable transcript text; the transport runs `stripUnsafeFormatChars`
//                    (text-safety.ts: strips bidi / zero-width / C0-C1 / DEL, preserves TAB/LF/CR)
//                    then redacts-by-construction, deep-redacts, and identifier-hashes at persist.
// `secret-bearing` — SDP / ICE / ephemeral-credential material that may carry private IPs or tokens;
//                    never logged or persisted raw.
// `raw-media`      — raw audio frames; never persisted and never a control message (media plane only).
export type VoiceRedactionClass =
  "content-free" | "reviewable-text" | "secret-bearing" | "raw-media";

export const VOICE_REDACTION_CLASSES: readonly VoiceRedactionClass[] = [
  "content-free",
  "reviewable-text",
  "secret-bearing",
  "raw-media",
] as const;

// ─── Message direction ────────────────────────────────────────────────────────
export type VoiceMessageDirection = "client-to-host" | "host-to-client";

export const VOICE_MESSAGE_DIRECTIONS: readonly VoiceMessageDirection[] = [
  "client-to-host",
  "host-to-client",
] as const;

// ─── Media plane descriptor ─────────────────────────────────────────────────────
export type VoiceMediaTrackKind = "audio-in" | "audio-out";

// Immutable v1 catalog. `audio-out` remains decodable for compatibility, but productive Realtime
// negotiation uses VOICE_REALTIME_INPUT_MEDIA_PLANE and never grants provider output authority.
export const VOICE_MEDIA_TRACK_KINDS: readonly VoiceMediaTrackKind[] = [
  "audio-in",
  "audio-out",
] as const;

// Immutable v1 descriptor for the WebRTC media plane. It is intentionally NOT a control message: it
// records that raw audio is media-plane, never-persisted, raw-media-classified, and carried over
// native browser WebRTC only. Productive input-only authority is narrowed by the additive descriptor
// below without mutating this published value.
export interface VoiceMediaPlaneDescriptor {
  readonly plane: "media";
  readonly transport: "webrtc";
  readonly trackKinds: readonly VoiceMediaTrackKind[];
  readonly replay: "never-persisted";
  readonly redaction: "raw-media";
}

export const VOICE_MEDIA_PLANE: VoiceMediaPlaneDescriptor = {
  plane: "media",
  transport: "webrtc",
  trackKinds: VOICE_MEDIA_TRACK_KINDS,
  replay: "never-persisted",
  redaction: "raw-media",
} as const;

export const VOICE_REALTIME_INPUT_MEDIA_PLANE: VoiceMediaPlaneDescriptor = {
  plane: "media",
  transport: "webrtc",
  trackKinds: ["audio-in"],
  replay: "never-persisted",
  redaction: "raw-media",
} as const;

// ─── Control message kinds (Deliverable: WebSocket control & signaling event schemas) ───
export type VoiceControlMessageKind =
  | "session.create"
  | "session.created"
  | "session.close"
  | "session.closed"
  | "capability.offer"
  | "capability.select"
  | "signal.sdp.offer"
  | "signal.sdp.answer"
  | "signal.ice.candidate"
  | "media.track.state"
  | "control.cancel"
  | "control.interrupt"
  | "transcript.partial"
  | "transcript.committed"
  | "transcript.discarded"
  | "playback.state"
  | "policy.decision"
  | "error";

export const VOICE_CONTROL_MESSAGE_KINDS: readonly VoiceControlMessageKind[] = [
  "session.create",
  "session.created",
  "session.close",
  "session.closed",
  "capability.offer",
  "capability.select",
  "signal.sdp.offer",
  "signal.sdp.answer",
  "signal.ice.candidate",
  "media.track.state",
  "control.cancel",
  "control.interrupt",
  "transcript.partial",
  "transcript.committed",
  "transcript.discarded",
  "playback.state",
  "policy.decision",
  "error",
] as const;

// Immutable v1 low-latency RTCDataChannel event subset. The provider-output literals remain
// decodable for compatibility but do not grant productive direction/allowlist authority.
export type VoiceDataChannelEventKind =
  "control.interrupt" | "transcript.partial" | "playback.state";

export const VOICE_DATA_CHANNEL_EVENT_KINDS: readonly VoiceDataChannelEventKind[] = [
  "control.interrupt",
  "transcript.partial",
  "playback.state",
] as const;

// Productive Realtime data events are input transcription only. This separate additive surface is
// what current consumers use; it cannot reactivate a provider-native assistant response path.
export type VoiceRealtimeInputDataChannelEventKind = "transcript.partial" | "transcript.committed";

export const VOICE_REALTIME_INPUT_DATA_CHANNEL_EVENT_KINDS: readonly VoiceRealtimeInputDataChannelEventKind[] =
  ["transcript.partial", "transcript.committed"] as const;

// ─── Supporting enums ─────────────────────────────────────────────────────────
export type VoiceSessionCloseReason =
  | "client-request"
  | "host-request"
  | "policy-disabled"
  | "provider-unreachable"
  | "timeout"
  | "protocol-error";

export const VOICE_SESSION_CLOSE_REASONS: readonly VoiceSessionCloseReason[] = [
  "client-request",
  "host-request",
  "policy-disabled",
  "provider-unreachable",
  "timeout",
  "protocol-error",
] as const;

export type VoiceMediaTrackState = "negotiating" | "live" | "muted" | "ended";

export const VOICE_MEDIA_TRACK_STATES: readonly VoiceMediaTrackState[] = [
  "negotiating",
  "live",
  "muted",
  "ended",
] as const;

export type VoicePlaybackState = "idle" | "playing" | "paused" | "stopped" | "interrupted";

export const VOICE_PLAYBACK_STATES: readonly VoicePlaybackState[] = [
  "idle",
  "playing",
  "paused",
  "stopped",
  "interrupted",
] as const;

export type VoicePolicyDecision = "allow" | "deny" | "degrade";

export const VOICE_POLICY_DECISIONS: readonly VoicePolicyDecision[] = [
  "allow",
  "deny",
  "degrade",
] as const;

export type VoiceProtocolErrorCode =
  | "unsupported-version"
  | "invalid-message"
  | "capability-unavailable"
  | "not-allowed-for-profile"
  | "negotiation-failed"
  | "rate-limited"
  | "internal";

export const VOICE_PROTOCOL_ERROR_CODES: readonly VoiceProtocolErrorCode[] = [
  "unsupported-version",
  "invalid-message",
  "capability-unavailable",
  "not-allowed-for-profile",
  "negotiation-failed",
  "rate-limited",
  "internal",
] as const;
const VOICE_PROTOCOL_ERROR_CODE_SET: ReadonlySet<string> = new Set(VOICE_PROTOCOL_ERROR_CODES);

// ─── Control message envelope + discriminated union ─────────────────────────────
// Every control message shares the envelope: the protocol version, the session it belongs to, a
// per-direction monotonically increasing sequence number (the reconnect / idempotency anchor), and
// its direction. The `kind` discriminates the payload.
interface VoiceControlEnvelope<K extends VoiceControlMessageKind> {
  readonly protocolVersion: typeof VOICE_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly seq: number;
  readonly direction: VoiceMessageDirection;
  readonly kind: K;
}

// Legacy v1 session context remains in the decoder/type surface only. Productive transports own a
// narrower authority check and reject or ignore these fields before provider negotiation.
export interface VoiceSessionMemoryContext {
  readonly enabled: boolean;
  readonly budgetTokens?: number | undefined;
}

export type VoiceSessionGroundingKind = "files" | "knowledge" | "hybrid" | "multi";

export interface VoiceSessionGroundingContext {
  readonly enabled: boolean;
  readonly sourceCount: number;
  readonly kind: VoiceSessionGroundingKind;
}

export interface VoiceSessionChatContext {
  readonly chatId: string;
  readonly memory?: VoiceSessionMemoryContext | undefined;
  readonly grounding?: VoiceSessionGroundingContext | undefined;
}

export interface VoiceSessionCreateMessage extends VoiceControlEnvelope<"session.create"> {
  // Idempotency key so a re-sent create after a reconnect resolves to the same session, never a second.
  readonly idempotencyKey: string;
  readonly requestedProfile: VoiceProfile;
  readonly negotiationMode: VoiceNegotiationMode;
  // The shared control envelope also serves Composer live dictation, whose explicit input-language
  // hint is accepted only on that separate path. Twin Voice rejects it and uses deployment-owned
  // transcription configuration.
  readonly transcriptionLanguage?: string | undefined;
  // Legacy v1 product persona. Compatibility-only: current Twin Voice does not forward it to the
  // provider and resolves spoken output separately through canonical TTS.
  readonly persona?: VoicePersona | undefined;
  // Active chat identity plus legacy compatibility metadata. Current productive Twin Voice accepts
  // only chatId at its transport authority boundary.
  readonly chatContext?: VoiceSessionChatContext | undefined;
}

export interface VoiceSessionCreatedMessage extends VoiceControlEnvelope<"session.created"> {
  readonly profile: VoiceProfile;
  readonly controlTransport: VoiceControlTransport;
  readonly mediaTransport: VoiceMediaTransport;
  readonly negotiationMode: VoiceNegotiationMode;
  readonly providerLocality?: VoiceProviderLocality | undefined;
}

export interface VoiceSessionCloseMessage extends VoiceControlEnvelope<"session.close"> {
  readonly reason: VoiceSessionCloseReason;
}

export interface VoiceSessionClosedMessage extends VoiceControlEnvelope<"session.closed"> {
  readonly reason: VoiceSessionCloseReason;
}

export interface VoiceCapabilityOfferMessage extends VoiceControlEnvelope<"capability.offer"> {
  readonly profile: VoiceProfile;
  readonly capabilities: {
    readonly speechToText: boolean;
    readonly speechOutput: boolean;
    readonly realtimeVoice: boolean;
    readonly realtimeToolCalling?: boolean | undefined;
  };
}

export interface VoiceCapabilitySelectMessage extends VoiceControlEnvelope<"capability.select"> {
  readonly profile: VoiceProfile;
}

// SDP / ICE payloads are opaque strings to this contract: the protocol never parses or stores them,
// and they are `secret-bearing` / `ephemeral` (privacy-contract §2/§4, ADR-0100 D6).
export interface VoiceSdpOfferMessage extends VoiceControlEnvelope<"signal.sdp.offer"> {
  readonly sdp: string;
}

export interface VoiceSdpAnswerMessage extends VoiceControlEnvelope<"signal.sdp.answer"> {
  readonly sdp: string;
}

export interface VoiceIceCandidateMessage extends VoiceControlEnvelope<"signal.ice.candidate"> {
  readonly candidate: string;
  readonly sdpMid?: string | null | undefined;
  readonly sdpMLineIndex?: number | null | undefined;
}

export interface VoiceMediaTrackStateMessage extends VoiceControlEnvelope<"media.track.state"> {
  readonly track: VoiceMediaTrackKind;
  readonly state: VoiceMediaTrackState;
}

export type VoiceControlCancelMessage = VoiceControlEnvelope<"control.cancel">;

export interface VoiceControlInterruptMessage extends VoiceControlEnvelope<"control.interrupt"> {
  // Optional client-perceived media offset (ms) at which the interruption (barge-in) occurred.
  readonly atMs?: number | undefined;
}

export interface VoiceTranscriptPartialMessage extends VoiceControlEnvelope<"transcript.partial"> {
  readonly text: string;
}

export interface VoiceTranscriptCommittedMessage extends VoiceControlEnvelope<"transcript.committed"> {
  readonly text: string;
}

export type VoiceTranscriptDiscardedMessage = VoiceControlEnvelope<"transcript.discarded">;

export interface VoicePlaybackStateMessage extends VoiceControlEnvelope<"playback.state"> {
  readonly state: VoicePlaybackState;
}

export interface VoicePolicyDecisionMessage extends VoiceControlEnvelope<"policy.decision"> {
  readonly decision: VoicePolicyDecision;
  readonly reason?: VoiceUnavailableReason | undefined;
}

export interface VoiceErrorMessage extends VoiceControlEnvelope<"error"> {
  readonly code: VoiceProtocolErrorCode;
  /**
   * Optional content-free support token. Server-side operator diagnostics use the same value so an
   * opaque UI failure can be correlated without exposing provider, SDP, audio, or transcript data.
   */
  readonly correlationId?: string | undefined;
}

export type VoiceControlMessage =
  | VoiceSessionCreateMessage
  | VoiceSessionCreatedMessage
  | VoiceSessionCloseMessage
  | VoiceSessionClosedMessage
  | VoiceCapabilityOfferMessage
  | VoiceCapabilitySelectMessage
  | VoiceSdpOfferMessage
  | VoiceSdpAnswerMessage
  | VoiceIceCandidateMessage
  | VoiceMediaTrackStateMessage
  | VoiceControlCancelMessage
  | VoiceControlInterruptMessage
  | VoiceTranscriptPartialMessage
  | VoiceTranscriptCommittedMessage
  | VoiceTranscriptDiscardedMessage
  | VoicePlaybackStateMessage
  | VoicePolicyDecisionMessage
  | VoiceErrorMessage;

// ─── Per-kind classification tables ─────────────────────────────────────────────
// Keyed by `VoiceControlMessageKind` so adding a kind without classifying it is a compile error
// (totality). No control kind is ever `raw-media` — that classification is media-plane only (AC1).
// The bounded replay-diagnostic ring size that host→client `replayable` events are held in for a
// reconnecting client (AC5/AC6). The keiko-ui timebase engine, the keiko-server realtime session, and
// the keiko-evaluations voice-twin buffer model all mirror this exact capacity — publishing it here
// makes drift across those three consumers a compile-time property rather than a documentation
// convention (KEIKO-0380). The value is a wire/contract concern because a reconnecting client's
// replay envelope size depends on it.
export const VOICE_REPLAY_CAPACITY = 200 as const;

export const VOICE_CONTROL_MESSAGE_REPLAY: Record<VoiceControlMessageKind, VoiceReplayClass> = {
  "session.create": "replayable",
  "session.created": "replayable",
  "session.close": "replayable",
  "session.closed": "replayable",
  "capability.offer": "replayable",
  "capability.select": "replayable",
  "signal.sdp.offer": "ephemeral",
  "signal.sdp.answer": "ephemeral",
  "signal.ice.candidate": "ephemeral",
  "media.track.state": "replayable",
  "control.cancel": "replayable",
  "control.interrupt": "replayable",
  "transcript.partial": "ephemeral",
  "transcript.committed": "replayable",
  "transcript.discarded": "replayable",
  "playback.state": "replayable",
  "policy.decision": "replayable",
  error: "replayable",
} as const;

export const VOICE_CONTROL_MESSAGE_REDACTION: Record<VoiceControlMessageKind, VoiceRedactionClass> =
  {
    "session.create": "content-free",
    "session.created": "content-free",
    "session.close": "content-free",
    "session.closed": "content-free",
    "capability.offer": "content-free",
    "capability.select": "content-free",
    "signal.sdp.offer": "secret-bearing",
    "signal.sdp.answer": "secret-bearing",
    "signal.ice.candidate": "secret-bearing",
    "media.track.state": "content-free",
    "control.cancel": "content-free",
    "control.interrupt": "content-free",
    "transcript.partial": "reviewable-text",
    "transcript.committed": "reviewable-text",
    "transcript.discarded": "content-free",
    "playback.state": "content-free",
    "policy.decision": "content-free",
    error: "content-free",
  } as const;

// ─── Capability-gating & fallback state table (Deliverable; AC2, AC3) ───────────
// The control-message kinds permitted for each effective voice profile. `none` permits NOTHING — the
// deterministic disabled behavior of AC2. `speech-to-text` permits the controlled-dictation control
// subset WITHOUT any WebRTC signaling, media-track, interruption, or playback message — STT-only
// dictation never requires the full-realtime media path (AC3). `full-realtime` permits every kind.
export const VOICE_PROFILE_ALLOWED_MESSAGE_KINDS: Record<
  VoiceProfile,
  readonly VoiceControlMessageKind[]
> = {
  none: [],
  "speech-to-text": [
    "session.create",
    "session.created",
    "session.close",
    "session.closed",
    "capability.offer",
    "capability.select",
    "control.cancel",
    "transcript.partial",
    "transcript.committed",
    "transcript.discarded",
    "policy.decision",
    "error",
  ],
  "speech-output": [
    "session.create",
    "session.created",
    "session.close",
    "session.closed",
    "capability.offer",
    "capability.select",
    "control.cancel",
    "control.interrupt",
    "playback.state",
    "policy.decision",
    "error",
  ],
  "full-realtime": [...VOICE_CONTROL_MESSAGE_KINDS],
} as const;

// The media-plane transport and browser↔provider negotiation mode that each profile resolves to.
export const VOICE_PROFILE_MEDIA_TRANSPORT: Record<VoiceProfile, VoiceMediaTransport> = {
  none: "none",
  "speech-to-text": "gateway-batch",
  "speech-output": "gateway-batch",
  "full-realtime": "webrtc",
} as const;

export const VOICE_PROFILE_NEGOTIATION_MODE: Record<VoiceProfile, VoiceNegotiationMode> = {
  none: "disabled",
  "speech-to-text": "disabled",
  "speech-output": "disabled",
  "full-realtime": "proxied-sdp",
} as const;

// ─── Timeout / reconnect / idempotency rules ────────────────────────────────────
export interface VoiceProtocolTimeouts {
  readonly sessionCreateMs: number;
  readonly signalingMs: number;
  readonly heartbeatIntervalMs: number;
  readonly reconnectBackoffInitialMs: number;
  readonly reconnectBackoffMaxMs: number;
  readonly maxReconnectAttempts: number;
}

// Defaults are conservative, controlled-network-friendly bounds. The implementing transport issue
// (#497) polices them against its own clock; the contracts package is a leaf and reads no clock.
export const DEFAULT_VOICE_PROTOCOL_TIMEOUTS: VoiceProtocolTimeouts = {
  sessionCreateMs: 10_000,
  signalingMs: 15_000,
  heartbeatIntervalMs: 15_000,
  reconnectBackoffInitialMs: 500,
  reconnectBackoffMaxMs: 10_000,
  maxReconnectAttempts: 5,
} as const;

// ─── Validation result ──────────────────────────────────────────────────────────
export type VoiceProtocolValidation =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

// Note (ADR-0154 D2 attribution): the shared validator below allowlists and type-checks
// `persona`, `transcriptionLanguage`, and `chatContext.{chatId, memory, grounding}` — it does
// NOT reject their presence. Endpoint-specific rejection on the Twin endpoint (e.g. closing
// with "not-allowed-for-profile" when persona or transcriptionLanguage is present) is the
// Twin transport's job, performed by `resolveSessionChatContext` in
// `packages/keiko-server/src/voice-realtime.ts`. A new consumer of this shared validator
// alone does not inherit that rejection semantics for free.
const VOICE_SESSION_CREATE_FIELDS: ReadonlySet<string> = new Set([
  "protocolVersion",
  "sessionId",
  "seq",
  "direction",
  "kind",
  "idempotencyKey",
  "requestedProfile",
  "negotiationMode",
  "transcriptionLanguage",
  "persona",
  "chatContext",
]);
const VOICE_SESSION_CHAT_CONTEXT_FIELDS: ReadonlySet<string> = new Set([
  "chatId",
  "memory",
  "grounding",
]);
const VOICE_SESSION_MEMORY_FIELDS: ReadonlySet<string> = new Set(["enabled", "budgetTokens"]);
const VOICE_SESSION_GROUNDING_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "sourceCount",
  "kind",
]);
const VOICE_ERROR_CORRELATION_ID_MAX_LENGTH = 128;
const VOICE_ERROR_CORRELATION_ID_INVALID_CHARACTER = /[^A-Za-z0-9._-]/u;
const VOICE_PROVIDER_LOCALITY_SET: ReadonlySet<string> = new Set(VOICE_PROVIDER_LOCALITIES);

// ─── Type guards & lookups ───────────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isVoiceProfile(value: unknown): value is VoiceProfile {
  return (
    value === "none" ||
    value === "speech-to-text" ||
    value === "speech-output" ||
    value === "full-realtime"
  );
}

function isOptionalVoiceProviderLocality(
  value: unknown,
): value is VoiceProviderLocality | undefined {
  return (
    value === undefined || (typeof value === "string" && VOICE_PROVIDER_LOCALITY_SET.has(value))
  );
}

function profileNegotiationMatches(profile: unknown, negotiationMode: unknown): boolean {
  if (!isVoiceProfile(profile)) return true;
  if (!isVoiceNegotiationMode(negotiationMode)) return true;
  return VOICE_PROFILE_NEGOTIATION_MODE[profile] === negotiationMode;
}

function isOptionalTranscriptionLanguage(value: unknown): boolean {
  return value === undefined || isNonEmptyTrimmed(value);
}

function isErrorCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= VOICE_ERROR_CORRELATION_ID_MAX_LENGTH &&
    !VOICE_ERROR_CORRELATION_ID_INVALID_CHARACTER.test(value)
  );
}

function isOptionalErrorCorrelationId(value: unknown): boolean {
  return value === undefined || isErrorCorrelationId(value);
}

function isVoiceProtocolErrorCode(value: unknown): value is VoiceProtocolErrorCode {
  return typeof value === "string" && VOICE_PROTOCOL_ERROR_CODE_SET.has(value);
}

function isOptionalVoicePersona(value: unknown): value is VoicePersona | undefined {
  return value === undefined || value === "male" || value === "female" || value === "neutral";
}

function isOptionalSessionMemoryContext(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasOnlyFields(value, VOICE_SESSION_MEMORY_FIELDS) &&
    typeof value.enabled === "boolean" &&
    (value.budgetTokens === undefined || isFiniteNonNegativeInteger(value.budgetTokens))
  );
}

function isVoiceSessionGroundingKind(value: unknown): value is VoiceSessionGroundingKind {
  return value === "files" || value === "knowledge" || value === "hybrid" || value === "multi";
}

function isOptionalSessionGroundingContext(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasOnlyFields(value, VOICE_SESSION_GROUNDING_FIELDS) &&
    typeof value.enabled === "boolean" &&
    isFiniteNonNegativeInteger(value.sourceCount) &&
    isVoiceSessionGroundingKind(value.kind)
  );
}

function isOptionalSessionChatContext(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasOnlyFields(value, VOICE_SESSION_CHAT_CONTEXT_FIELDS) &&
    isNonEmptyTrimmed(value.chatId) &&
    isOptionalSessionMemoryContext(value.memory) &&
    isOptionalSessionGroundingContext(value.grounding)
  );
}

function validateSessionCreateOptions(value: Record<string, unknown>, reasons: string[]): void {
  if (!isOptionalTranscriptionLanguage(value.transcriptionLanguage)) {
    reasons.push("session.create transcriptionLanguage invalid");
  }
  if (!isOptionalVoicePersona(value.persona)) {
    reasons.push("session.create persona invalid");
  }
  if (!isOptionalSessionChatContext(value.chatContext)) {
    reasons.push("session.create chatContext invalid");
  }
}

function validateSessionCreatePayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_SESSION_CREATE_FIELDS)) {
    reasons.push("session.create fields invalid");
  }
  if (value.seq !== 0 || value.direction !== "client-to-host") {
    reasons.push("session.create envelope invalid");
  }
  if (!isNonEmptyTrimmed(value.idempotencyKey)) {
    reasons.push("session.create idempotencyKey invalid");
  }
  const profile = value.requestedProfile;
  if (!isVoiceProfile(profile)) {
    reasons.push("session.create requestedProfile invalid");
  }
  if (!isVoiceNegotiationMode(value.negotiationMode)) {
    reasons.push("session.create negotiationMode invalid");
  }
  if (!profileNegotiationMatches(profile, value.negotiationMode)) {
    reasons.push("session.create profile negotiation mismatch");
  }
  validateSessionCreateOptions(value, reasons);
}

function validateErrorPayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_ERROR_FIELDS)) {
    reasons.push("error fields invalid");
  }
  if (!isVoiceProtocolErrorCode(value.code)) {
    reasons.push("error code invalid");
  }
  if (!isOptionalErrorCorrelationId(value.correlationId)) {
    reasons.push("error correlationId invalid");
  }
}

// ─── Per-kind payload validation (KEIKO-0392; every VoiceControlMessageKind member) ─────────────
// Every message kind gets a structural payload check, driven by its declared interface shape above,
// so a wrong-typed or missing field is rejected the same way session.create's already is. Each kind
// also gets a closed "no fields beyond the envelope and this kind's own payload" check via
// hasOnlyFields, the same treatment session.create's VOICE_SESSION_CREATE_FIELDS already applied —
// KfQ thread 3788570882 found this narrower for the other 17 kinds (16 plus the pre-existing `error`
// validator) and every one of their shapes is already precisely typed above, so deriving an exact
// per-kind allowlist from it carries none of the "getting it wrong" risk a hand-guessed list would.
// Free-text fields (sdp, candidate, text) are additionally length-bounded — this is a wire boundary
// carrying WebRTC signaling and transcripts, hostile input is assumed. None of the interfaces
// declares an array-typed field, so there is no array to bound.
//
// Layering note: keiko-server independently re-validates `sdp` more strictly (voice-realtime.ts'
// isApprovedDirectionalSdp, voice-live-dictation.ts's handleOffer — SDP prefix + exact audio
// direction) after calling validateVoiceControlMessage, and both routes resolve any rejection here or
// there to the same "invalid-message" outcome. The VOICE_SDP_MAX_LENGTH bound below is expressed in
// `.length` (UTF-16 code units), which is always <= `Buffer.byteLength(value, "utf8")` for any
// string, so it can never reject an SDP that route's own byte-length bound (256_000 bytes) currently
// accepts — this contract-level check narrows nothing a route already owns.
const VOICE_ENVELOPE_FIELD_NAMES = [
  "protocolVersion",
  "sessionId",
  "seq",
  "direction",
  "kind",
] as const;
const VOICE_SESSION_CREATED_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "profile",
  "controlTransport",
  "mediaTransport",
  "negotiationMode",
  "providerLocality",
]);
const VOICE_SESSION_CLOSE_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "reason",
]);
const VOICE_CAPABILITY_OFFER_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "profile",
  "capabilities",
]);
const VOICE_CAPABILITY_SELECT_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "profile",
]);
const VOICE_SDP_FIELDS: ReadonlySet<string> = new Set([...VOICE_ENVELOPE_FIELD_NAMES, "sdp"]);
const VOICE_ICE_CANDIDATE_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "candidate",
  "sdpMid",
  "sdpMLineIndex",
]);
const VOICE_MEDIA_TRACK_STATE_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "track",
  "state",
]);
const VOICE_ENVELOPE_ONLY_FIELDS: ReadonlySet<string> = new Set(VOICE_ENVELOPE_FIELD_NAMES);
const VOICE_CONTROL_INTERRUPT_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "atMs",
]);
const VOICE_TRANSCRIPT_TEXT_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "text",
]);
const VOICE_PLAYBACK_STATE_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "state",
]);
const VOICE_POLICY_DECISION_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "decision",
  "reason",
]);
const VOICE_ERROR_FIELDS: ReadonlySet<string> = new Set([
  ...VOICE_ENVELOPE_FIELD_NAMES,
  "code",
  "correlationId",
]);
const VOICE_CONTROL_TRANSPORT_SET: ReadonlySet<string> = new Set(VOICE_CONTROL_TRANSPORTS);
const VOICE_MEDIA_TRANSPORT_SET: ReadonlySet<string> = new Set(VOICE_MEDIA_TRANSPORTS);
const VOICE_SESSION_CLOSE_REASON_SET: ReadonlySet<string> = new Set(VOICE_SESSION_CLOSE_REASONS);
const VOICE_MEDIA_TRACK_KIND_SET: ReadonlySet<string> = new Set(VOICE_MEDIA_TRACK_KINDS);
const VOICE_MEDIA_TRACK_STATE_SET: ReadonlySet<string> = new Set(VOICE_MEDIA_TRACK_STATES);
const VOICE_PLAYBACK_STATE_SET: ReadonlySet<string> = new Set(VOICE_PLAYBACK_STATES);
const VOICE_POLICY_DECISION_SET: ReadonlySet<string> = new Set(VOICE_POLICY_DECISIONS);

const VOICE_SDP_MAX_LENGTH = 256_000;
// A real ICE candidate line (RFC 5245-style, including TURN relay extensions) is well under 1 KiB;
// this bound is generous headroom against a hostile string, not a realistic candidate size.
const VOICE_ICE_CANDIDATE_MAX_LENGTH = 4096;
const VOICE_SDP_MID_MAX_LENGTH = 128;
// Matches the scale of run-request.ts's MAX_VOICE_COMMITTED_TEXT_CHARS for a downstream aggregated
// committed voice transcript; an individual protocol-level transcript segment is bounded no looser.
const VOICE_TRANSCRIPT_TEXT_MAX_LENGTH = 8192;

function isVoiceControlTransport(value: unknown): value is VoiceControlTransport {
  return typeof value === "string" && VOICE_CONTROL_TRANSPORT_SET.has(value);
}

function isVoiceMediaTransport(value: unknown): value is VoiceMediaTransport {
  return typeof value === "string" && VOICE_MEDIA_TRANSPORT_SET.has(value);
}

function isVoiceSessionCloseReason(value: unknown): value is VoiceSessionCloseReason {
  return typeof value === "string" && VOICE_SESSION_CLOSE_REASON_SET.has(value);
}

function isVoiceMediaTrackKind(value: unknown): value is VoiceMediaTrackKind {
  return typeof value === "string" && VOICE_MEDIA_TRACK_KIND_SET.has(value);
}

function isVoiceMediaTrackState(value: unknown): value is VoiceMediaTrackState {
  return typeof value === "string" && VOICE_MEDIA_TRACK_STATE_SET.has(value);
}

function isVoicePlaybackState(value: unknown): value is VoicePlaybackState {
  return typeof value === "string" && VOICE_PLAYBACK_STATE_SET.has(value);
}

function isVoicePolicyDecision(value: unknown): value is VoicePolicyDecision {
  return typeof value === "string" && VOICE_POLICY_DECISION_SET.has(value);
}

function isOptionalVoiceUnavailableReason(
  value: unknown,
): value is VoiceUnavailableReason | undefined {
  return (
    value === undefined ||
    value === "no-voice-provider" ||
    value === "policy-disabled" ||
    value === "provider-unreachable"
  );
}

function isBoundedSdp(value: unknown): value is string {
  return isNonEmptyTrimmed(value) && value.length <= VOICE_SDP_MAX_LENGTH;
}

function isBoundedIceCandidate(value: unknown): value is string {
  // An empty string is the WebRTC trickle-ICE "end-of-candidates" sentinel and is valid; only type
  // and an upper length bound are enforced (this protocol's single-shot proxied-SDP flow embeds ICE
  // in the offer/answer and does not exercise trickle, but the contract still decodes the kind).
  return typeof value === "string" && value.length <= VOICE_ICE_CANDIDATE_MAX_LENGTH;
}

function isOptionalNullableSdpMid(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= VOICE_SDP_MID_MAX_LENGTH)
  );
}

function isOptionalNullableSdpMLineIndex(value: unknown): boolean {
  return value === undefined || value === null || isFiniteNonNegativeInteger(value);
}

function isBoundedTranscriptText(value: unknown): value is string {
  // Interim (partial) transcript text may legitimately be empty (no words recognised yet); only type
  // and an upper length bound are enforced, matching the ICE candidate rationale above.
  return typeof value === "string" && value.length <= VOICE_TRANSCRIPT_TEXT_MAX_LENGTH;
}

function isOptionalFiniteNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

const VOICE_CAPABILITY_OFFER_CAPABILITIES_FIELDS: ReadonlySet<string> = new Set([
  "speechToText",
  "speechOutput",
  "realtimeVoice",
  "realtimeToolCalling",
]);

function isVoiceCapabilityOfferCapabilities(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, VOICE_CAPABILITY_OFFER_CAPABILITIES_FIELDS) &&
    typeof value.speechToText === "boolean" &&
    typeof value.speechOutput === "boolean" &&
    typeof value.realtimeVoice === "boolean" &&
    (value.realtimeToolCalling === undefined || typeof value.realtimeToolCalling === "boolean")
  );
}

function validateSessionCreatedPayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_SESSION_CREATED_FIELDS)) {
    reasons.push("session.created fields invalid");
  }
  if (!isVoiceProfile(value.profile)) {
    reasons.push("session.created profile invalid");
  }
  if (!isVoiceControlTransport(value.controlTransport)) {
    reasons.push("session.created controlTransport invalid");
  }
  if (!isVoiceMediaTransport(value.mediaTransport)) {
    reasons.push("session.created mediaTransport invalid");
  }
  if (!isVoiceNegotiationMode(value.negotiationMode)) {
    reasons.push("session.created negotiationMode invalid");
  }
  if (!isOptionalVoiceProviderLocality(value.providerLocality)) {
    reasons.push("session.created providerLocality invalid");
  }
}

function validateSessionClosePayload(
  value: Record<string, unknown>,
  reasons: string[],
  kind: "session.close" | "session.closed",
): void {
  if (!hasOnlyFields(value, VOICE_SESSION_CLOSE_FIELDS)) {
    reasons.push(`${kind} fields invalid`);
  }
  if (!isVoiceSessionCloseReason(value.reason)) {
    reasons.push(`${kind} reason invalid`);
  }
}

function validateCapabilityOfferPayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_CAPABILITY_OFFER_FIELDS)) {
    reasons.push("capability.offer fields invalid");
  }
  if (!isVoiceProfile(value.profile)) {
    reasons.push("capability.offer profile invalid");
  }
  if (!isVoiceCapabilityOfferCapabilities(value.capabilities)) {
    reasons.push("capability.offer capabilities invalid");
  }
}

function validateCapabilitySelectPayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_CAPABILITY_SELECT_FIELDS)) {
    reasons.push("capability.select fields invalid");
  }
  if (!isVoiceProfile(value.profile)) {
    reasons.push("capability.select profile invalid");
  }
}

function validateSdpPayload(
  value: Record<string, unknown>,
  reasons: string[],
  kind: "signal.sdp.offer" | "signal.sdp.answer",
): void {
  if (!hasOnlyFields(value, VOICE_SDP_FIELDS)) {
    reasons.push(`${kind} fields invalid`);
  }
  if (!isBoundedSdp(value.sdp)) {
    reasons.push(`${kind} sdp invalid`);
  }
}

function validateIceCandidatePayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_ICE_CANDIDATE_FIELDS)) {
    reasons.push("signal.ice.candidate fields invalid");
  }
  if (!isBoundedIceCandidate(value.candidate)) {
    reasons.push("signal.ice.candidate candidate invalid");
  }
  if (!isOptionalNullableSdpMid(value.sdpMid)) {
    reasons.push("signal.ice.candidate sdpMid invalid");
  }
  if (!isOptionalNullableSdpMLineIndex(value.sdpMLineIndex)) {
    reasons.push("signal.ice.candidate sdpMLineIndex invalid");
  }
}

function validateMediaTrackStatePayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_MEDIA_TRACK_STATE_FIELDS)) {
    reasons.push("media.track.state fields invalid");
  }
  if (!isVoiceMediaTrackKind(value.track)) {
    reasons.push("media.track.state track invalid");
  }
  if (!isVoiceMediaTrackState(value.state)) {
    reasons.push("media.track.state state invalid");
  }
}

function validateEnvelopeOnlyPayload(
  value: Record<string, unknown>,
  reasons: string[],
  kind: "control.cancel" | "transcript.discarded",
): void {
  // control.cancel / transcript.discarded carry no fields beyond the shared envelope, which
  // validateEnvelope (called by every caller of this function) already checks the shape of.
  if (!hasOnlyFields(value, VOICE_ENVELOPE_ONLY_FIELDS)) {
    reasons.push(`${kind} fields invalid`);
  }
}

function validateControlInterruptPayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_CONTROL_INTERRUPT_FIELDS)) {
    reasons.push("control.interrupt fields invalid");
  }
  if (!isOptionalFiniteNonNegativeNumber(value.atMs)) {
    reasons.push("control.interrupt atMs invalid");
  }
}

function validateTranscriptTextPayload(
  value: Record<string, unknown>,
  reasons: string[],
  kind: "transcript.partial" | "transcript.committed",
): void {
  if (!hasOnlyFields(value, VOICE_TRANSCRIPT_TEXT_FIELDS)) {
    reasons.push(`${kind} fields invalid`);
  }
  if (!isBoundedTranscriptText(value.text)) {
    reasons.push(`${kind} text invalid`);
  }
}

function validatePlaybackStatePayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_PLAYBACK_STATE_FIELDS)) {
    reasons.push("playback.state fields invalid");
  }
  if (!isVoicePlaybackState(value.state)) {
    reasons.push("playback.state state invalid");
  }
}

function validatePolicyDecisionPayload(value: Record<string, unknown>, reasons: string[]): void {
  if (!hasOnlyFields(value, VOICE_POLICY_DECISION_FIELDS)) {
    reasons.push("policy.decision fields invalid");
  }
  if (!isVoicePolicyDecision(value.decision)) {
    reasons.push("policy.decision decision invalid");
  }
  if (!isOptionalVoiceUnavailableReason(value.reason)) {
    reasons.push("policy.decision reason invalid");
  }
}

type VoicePayloadValidator = (value: Record<string, unknown>, reasons: string[]) => void;

// Exhaustive per-kind dispatch: Record totality over VoiceControlMessageKind means a new kind added
// to the union without an entry here fails to compile, mirroring VOICE_CONTROL_MESSAGE_REPLAY /
// VOICE_CONTROL_MESSAGE_REDACTION above.
const VOICE_CONTROL_MESSAGE_PAYLOAD_VALIDATORS: Record<
  VoiceControlMessageKind,
  VoicePayloadValidator
> = {
  "session.create": validateSessionCreatePayload,
  "session.created": validateSessionCreatedPayload,
  "session.close": (value, reasons): void => {
    validateSessionClosePayload(value, reasons, "session.close");
  },
  "session.closed": (value, reasons): void => {
    validateSessionClosePayload(value, reasons, "session.closed");
  },
  "capability.offer": validateCapabilityOfferPayload,
  "capability.select": validateCapabilitySelectPayload,
  "signal.sdp.offer": (value, reasons): void => {
    validateSdpPayload(value, reasons, "signal.sdp.offer");
  },
  "signal.sdp.answer": (value, reasons): void => {
    validateSdpPayload(value, reasons, "signal.sdp.answer");
  },
  "signal.ice.candidate": validateIceCandidatePayload,
  "media.track.state": validateMediaTrackStatePayload,
  "control.cancel": (value, reasons): void => {
    validateEnvelopeOnlyPayload(value, reasons, "control.cancel");
  },
  "control.interrupt": validateControlInterruptPayload,
  "transcript.partial": (value, reasons): void => {
    validateTranscriptTextPayload(value, reasons, "transcript.partial");
  },
  "transcript.committed": (value, reasons): void => {
    validateTranscriptTextPayload(value, reasons, "transcript.committed");
  },
  "transcript.discarded": (value, reasons): void => {
    validateEnvelopeOnlyPayload(value, reasons, "transcript.discarded");
  },
  "playback.state": validatePlaybackStatePayload,
  "policy.decision": validatePolicyDecisionPayload,
  error: validateErrorPayload,
};

export function isVoiceControlMessageKind(value: unknown): value is VoiceControlMessageKind {
  return (
    typeof value === "string" && (VOICE_CONTROL_MESSAGE_KINDS as readonly string[]).includes(value)
  );
}

export function isVoiceMessageDirection(value: unknown): value is VoiceMessageDirection {
  return (
    typeof value === "string" && (VOICE_MESSAGE_DIRECTIONS as readonly string[]).includes(value)
  );
}

export function isVoiceNegotiationMode(value: unknown): value is VoiceNegotiationMode {
  return typeof value === "string" && VOICE_NEGOTIATION_MODE_SET.has(value);
}

// The replay class for a control-message kind. `replayable` events are the ones a reconnect
// re-delivers (AC5); `ephemeral` and the media plane's `never-persisted` are excluded.
export function voiceControlMessageReplayClass(kind: VoiceControlMessageKind): VoiceReplayClass {
  return VOICE_CONTROL_MESSAGE_REPLAY[kind];
}

export function voiceControlMessageRedactionClass(
  kind: VoiceControlMessageKind,
): VoiceRedactionClass {
  return VOICE_CONTROL_MESSAGE_REDACTION[kind];
}

// AC5: a control-message kind is replay-eligible only when classified `replayable`. Raw audio is
// media-plane (`never-persisted`) and has no control kind, so it can never be replay-eligible.
export function isVoiceReplayEligible(kind: VoiceControlMessageKind): boolean {
  return VOICE_CONTROL_MESSAGE_REPLAY[kind] === "replayable";
}

// AC2 / AC3: whether a kind is permitted for an effective profile. `none` permits nothing.
export function voiceMessageAllowedForProfile(
  kind: VoiceControlMessageKind,
  profile: VoiceProfile,
): boolean {
  return VOICE_PROFILE_ALLOWED_MESSAGE_KINDS[profile].includes(kind);
}

// Exhaustiveness guard: a `default`/fall-through that reaches this fails to type-check if a new
// `VoiceControlMessageKind` is added without handling, mirroring `assertNeverMemoryType`.
export function assertNeverVoiceControlMessageKind(kind: never): never {
  throw new Error(`unhandled voice control message kind: ${JSON.stringify(kind)}`);
}

// ─── Envelope validation ─────────────────────────────────────────────────────────
function validateEnvelope(value: Record<string, unknown>, reasons: string[]): void {
  if (!isVoiceProtocolVersionSupported(value.protocolVersion)) {
    reasons.push("protocolVersion unsupported");
  }
  if (!isNonEmptyTrimmed(value.sessionId)) {
    reasons.push("sessionId must be a non-empty string");
  }
  if (!isFiniteNonNegativeInteger(value.seq)) {
    reasons.push("seq must be a non-negative integer");
  }
  if (!isVoiceMessageDirection(value.direction)) {
    reasons.push("direction invalid");
  }
  if (!isVoiceControlMessageKind(value.kind)) {
    reasons.push("kind invalid");
  }
}

// Structural guard for the shared envelope and every kind-specific payload (dispatched through
// VOICE_CONTROL_MESSAGE_PAYLOAD_VALIDATORS, one validator per VoiceControlMessageKind — session.
// create's v1-compatible shape and error's bounded content-free correlation identifier included).
// Productive transports still apply their own narrower direction/authority allowlists after this
// decoder.
export function isVoiceControlMessage(value: unknown): value is VoiceControlMessage {
  return validateVoiceControlMessage(value).ok;
}

// Deep validation of the shared envelope and the kind-specific payload shape for every
// VoiceControlMessageKind, returning every reason it is malformed. Record totality in
// VOICE_CONTROL_MESSAGE_PAYLOAD_VALIDATORS makes a new kind added to the union without a validator a
// compile error (exhaustiveness), rather than a silent structural-validation gap. Grants no
// productive authority by itself.
export function validateVoiceControlMessage(value: unknown): VoiceProtocolValidation {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["message must be an object"] };
  }
  const reasons: string[] = [];
  validateEnvelope(value, reasons);
  const { kind } = value;
  if (isVoiceControlMessageKind(kind)) {
    VOICE_CONTROL_MESSAGE_PAYLOAD_VALIDATORS[kind](value, reasons);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isDecodedSessionCreatedMessage(
  value: VoiceControlMessage,
): value is VoiceSessionCreatedMessage {
  return (
    value.kind === "session.created" &&
    value.profile === "full-realtime" &&
    value.controlTransport === VOICE_REALTIME_CONTROL_TRANSPORT &&
    value.mediaTransport === VOICE_PROFILE_MEDIA_TRANSPORT["full-realtime"] &&
    value.negotiationMode === VOICE_PROFILE_NEGOTIATION_MODE["full-realtime"] &&
    isOptionalVoiceProviderLocality(value.providerLocality)
  );
}

function isDecodedSdpAnswerMessage(value: VoiceControlMessage): value is VoiceSdpAnswerMessage {
  return value.kind === "signal.sdp.answer" && isNonEmptyTrimmed(value.sdp);
}

function isBrowserNegotiationMessage(
  value: VoiceControlMessage,
): value is VoiceSessionCreatedMessage | VoiceSdpAnswerMessage | VoiceErrorMessage {
  if (value.direction !== "host-to-client") return false;
  return (
    value.kind === "error" ||
    isDecodedSessionCreatedMessage(value) ||
    isDecodedSdpAnswerMessage(value)
  );
}

/**
 * Decode the host-to-browser control messages used by the proxied-SDP negotiation handshake.
 *
 * Invalid optional error correlation metadata is omitted from a copy so it cannot hide an otherwise
 * valid control-plane failure. Only `session.created`, `signal.sdp.answer`, and `error` are returned;
 * their required payload fields are checked after envelope validation. Other message kinds and
 * malformed negotiation payloads return `undefined`.
 */
export function decodeVoiceControlMessage(
  value: unknown,
): VoiceSessionCreatedMessage | VoiceSdpAnswerMessage | VoiceErrorMessage | undefined {
  let candidate = value;
  if (
    isRecord(value) &&
    value.kind === "error" &&
    !isOptionalErrorCorrelationId(value.correlationId)
  ) {
    const withoutCorrelationId = { ...value };
    delete withoutCorrelationId.correlationId;
    candidate = withoutCorrelationId;
  }
  return isVoiceControlMessage(candidate) && isBrowserNegotiationMessage(candidate)
    ? candidate
    : undefined;
}
