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
const VOICE_CONTROL_TRANSPORT_SET: ReadonlySet<string> = new Set(VOICE_CONTROL_TRANSPORTS);

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
const VOICE_MEDIA_TRANSPORT_SET: ReadonlySet<string> = new Set(VOICE_MEDIA_TRANSPORTS);

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

function isVoiceControlTransport(value: unknown): value is VoiceControlTransport {
  return typeof value === "string" && VOICE_CONTROL_TRANSPORT_SET.has(value);
}

function isVoiceMediaTransport(value: unknown): value is VoiceMediaTransport {
  return typeof value === "string" && VOICE_MEDIA_TRANSPORT_SET.has(value);
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
  if (!isVoiceProtocolErrorCode(value.code)) {
    reasons.push("error code invalid");
  }
  if (!isOptionalErrorCorrelationId(value.correlationId)) {
    reasons.push("error correlationId invalid");
  }
}

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

// Structural guard for the shared envelope, the v1-compatible session.create payload, and bounded
// content-free error correlation identifiers. Productive transports apply their own narrower
// direction/authority allowlists after this decoder.
export function isVoiceControlMessage(value: unknown): value is VoiceControlMessage {
  return validateVoiceControlMessage(value).ok;
}

// Deep validation of the shared envelope, the published v1-compatible session.create shape, and the
// content-free portion of error payloads, returning every reason it is malformed. It grants no
// productive authority by itself.
export function validateVoiceControlMessage(value: unknown): VoiceProtocolValidation {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["message must be an object"] };
  }
  const reasons: string[] = [];
  validateEnvelope(value, reasons);
  if (value.kind === "session.create") {
    validateSessionCreatePayload(value, reasons);
  } else if (value.kind === "error") {
    validateErrorPayload(value, reasons);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isDecodedSessionCreatedMessage(
  value: VoiceControlMessage,
): value is VoiceSessionCreatedMessage {
  return (
    value.kind === "session.created" &&
    isVoiceProfile(value.profile) &&
    isVoiceControlTransport(value.controlTransport) &&
    isVoiceMediaTransport(value.mediaTransport) &&
    isVoiceNegotiationMode(value.negotiationMode) &&
    isOptionalVoiceProviderLocality(value.providerLocality)
  );
}

function isDecodedSdpAnswerMessage(value: VoiceControlMessage): value is VoiceSdpAnswerMessage {
  return value.kind === "signal.sdp.answer" && typeof value.sdp === "string";
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
