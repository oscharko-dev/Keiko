// BFF realtime voice control plane (Issue #497, Epic #491, ADR-0100 D3/D6, ADR-0101). Re-opens the
// BFF WebSocket upgrade — deliberately hard-rejected for every other path (server.ts) — for the single
// loopback control path `/api/voice/control`, and ONLY when the resolved voice capability is the
// full-realtime profile and policy permits it (AC1). The WebSocket carries the #496 control/signaling
// protocol; raw audio never rides it — real-time media flows browser↔provider over native WebRTC
// (DTLS-SRTP), negotiated by the preferred proxied-SDP mode so the long-lived provider credential
// never reaches the browser (AC2).
//
// Security posture (ADR-0100 D6): the upgrade reuses the same loopback `isAllowedHost` Host/Origin
// check as the HTTP path (host-check.ts) — a WebSocket handshake cannot carry the JSON+CSRF guard, so
// the loopback-origin check (which rejects opaque `Origin: null` and any non-loopback origin) plus the
// capability gate are the load-bearing cross-origin defenses. SDP/ICE payloads are opaque,
// `secret-bearing` strings: they are forwarded verbatim through the Model Gateway egress seam and are
// never logged or persisted (privacy-contract §2/§4). Provider transcript text travels only over the
// browser RTCDataChannel into canonical Chat; this control socket rejects client transcript frames,
// keeping its bounded replay buffer content-free.
// Raw audio is never a control message (a binary frame is rejected) and is never persisted (AC1/AC6).

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import {
  findConfiguredCapability,
  requestRealtimeNegotiation,
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  type GatewayConfig,
  type ModelProviderConfig,
  type RealtimeNegotiationErrorKind,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationRequest,
  type VoiceCapabilityResolution,
} from "@oscharko-dev/keiko-model-gateway";
import {
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  isVoiceReplayEligible,
  validateVoiceControlMessage,
  VOICE_REALTIME_CONTROL_TRANSPORT,
  VOICE_PROFILE_NEGOTIATION_MODE,
  VOICE_PROTOCOL_VERSION,
  VOICE_REPLAY_CAPACITY,
  voiceMessageAllowedForProfile,
  type VoiceControlMessage,
  type VoiceProfile,
  type VoiceProtocolErrorCode,
  type VoiceProviderLocality,
  type VoiceSessionChatContext,
  type VoiceSessionCreateMessage,
} from "@oscharko-dev/keiko-contracts";
import { isAllowedHost } from "./host-check.js";
import { resolveCorrelationId } from "./correlation.js";
import { currentGatewayConfig, currentGatewayEgressConfig, type UiHandlerDeps } from "./deps.js";
import { isVoiceDisabledByPolicy, isVoiceRealtimeCapable } from "./read-handlers.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { getServerLogger } from "./observability/index.js";

// The single loopback path the BFF WebSocket upgrade is re-opened for. Every other upgrade keeps the
// hard 404 + socket.destroy() default (server.ts).
export const VOICE_CONTROL_PATH = "/api/voice/control";

// Bound every client WebSocket control frame before UTF-8 conversion or JSON parsing. SDP and
// transcript fields have narrower semantic caps below; this is the transport-level abuse guard.
export const MAX_VOICE_CONTROL_FRAME_BYTES = 320_000;
// SDP is small (a single audio m-line plus ICE/DTLS metadata); reject oversized client offers before
// provider egress and oversized provider answers before client egress.
const MAX_SDP_BYTES = 256_000;
// The bounded per-session replay-diagnostic record (AC6): the host re-delivers these `replayable`
// host→client events to a reconnecting client. Oldest entries are evicted past the cap. The size is
// owned by @oscharko-dev/keiko-contracts (`VOICE_REPLAY_CAPACITY`) — the keiko-ui timebase engine and
// the keiko-evaluations voice-twin model bind to the same value, so drift is structurally impossible
// (KEIKO-0380).
const MAX_REPLAY_EVENTS: typeof VOICE_REPLAY_CAPACITY = VOICE_REPLAY_CAPACITY;
// A disconnected session is resumable (by idempotency key) for this long, then swept.
const SESSION_RESUME_TTL_MS = 60_000;
// Bound the number of tracked sessions on the loopback control plane (single local user).
const MAX_ACTIVE_SESSIONS = 64;
// Bound the identifier length/charset before a client-chosen id may be tracked or logged, so a
// hostile id cannot inject into a log/audit line (content-free redaction class, protocol §8).
const MAX_ID_LENGTH = 200;
const PRODUCTIVE_REALTIME_CLIENT_KINDS: ReadonlySet<VoiceControlMessage["kind"]> = new Set([
  "session.create",
  "session.close",
  "capability.select",
  "signal.sdp.offer",
  "signal.ice.candidate",
  "media.track.state",
  "control.cancel",
  "control.interrupt",
  "transcript.discarded",
  "playback.state",
]);

function productiveRealtimeClientMessageAllowed(
  message: VoiceControlMessage,
  profile: VoiceProfile,
): boolean {
  return (
    voiceMessageAllowedForProfile(message.kind, profile) &&
    PRODUCTIVE_REALTIME_CLIENT_KINDS.has(message.kind)
  );
}

type SdpAudioDirection = "sendonly" | "recvonly";

function hasExactAudioMediaDirection(sdp: string, expected: SdpAudioDirection): boolean {
  const audioSections = sdp.split(/(?=^m=)/gmu).filter((section) => section.startsWith("m=audio "));
  if (audioSections.length === 0) return false;
  return audioSections.every((section) => {
    const directions = section
      .split(/\r\n|\n|\r/u)
      .filter((line) => /^a=(?:sendrecv|sendonly|recvonly|inactive)$/u.test(line));
    return directions.length === 1 && directions[0] === `a=${expected}`;
  });
}

function isApprovedDirectionalSdp(value: unknown, expected: SdpAudioDirection): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.startsWith("v=") &&
    Buffer.byteLength(value, "utf8") <= MAX_SDP_BYTES &&
    hasExactAudioMediaDirection(value, expected)
  );
}
// Printable ASCII, no control characters, quotes, or whitespace.
const SAFE_IDENTIFIER = /^[\x21-\x7e]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_IDENTIFIER.test(value)
  );
}

function isVoiceSessionChatContext(value: unknown): value is VoiceSessionChatContext {
  return isRecord(value) && Object.keys(value).length === 1 && isSafeIdentifier(value.chatId);
}

// The persistent per-session record. It outlives a single WebSocket so a reconnect (a new socket
// presenting the same idempotency key) resumes the same session and replays the buffered events,
// rather than creating a duplicate (protocol §7 idempotency + reconnect).
interface SessionState {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly profile: VoiceProfile;
  readonly capabilities: VoiceCapabilityResolution["capabilities"];
  readonly providerLocality: VoiceProviderLocality | undefined;
  readonly chatContext: VoiceSessionChatContext | undefined;
  hostSeq: number;
  lastClientSeq: number;
  readonly replay: VoiceControlMessage[];
  replayStart: number;
  detachedAt: number | undefined;
  terminal: boolean;
}

function replayEvents(session: SessionState): readonly VoiceControlMessage[] {
  if (session.replayStart === 0 || session.replay.length < MAX_REPLAY_EVENTS) {
    return session.replay;
  }
  const ordered: VoiceControlMessage[] = [];
  for (let i = 0; i < session.replay.length; i += 1) {
    const message = session.replay[(session.replayStart + i) % session.replay.length];
    if (message !== undefined) ordered.push(message);
  }
  return ordered;
}

function appendReplayEvent(session: SessionState, message: VoiceControlMessage): void {
  if (session.replay.length < MAX_REPLAY_EVENTS) {
    session.replay.push(message);
    return;
  }
  session.replay[session.replayStart] = message;
  session.replayStart = (session.replayStart + 1) % MAX_REPLAY_EVENTS;
}

type NegotiateFn = (
  offerSdp: string,
  chatContext: VoiceSessionChatContext | undefined,
  signal: AbortSignal,
) => Promise<RealtimeNegotiationOutcome>;

// The per-kind payload an `emit` carries: the kind plus its fields, minus the shared envelope that
// `emit` fills in. A distributive Omit preserves the discriminated per-kind fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type HostMessagePayload = DistributiveOmit<
  VoiceControlMessage,
  "protocolVersion" | "sessionId" | "seq" | "direction"
>;

export interface VoiceControlPlane {
  // Handles a gated WebSocket upgrade for the voice control path. Returns true when it accepted (and
  // now owns) the socket, false when the request is not an allowed voice-control upgrade and the
  // caller must keep the default hard reject.
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  // Closes every open control socket and clears tracked sessions (server shutdown).
  closeAll(): void;
}

// Resolves the configured realtime-voice provider to negotiate against, or undefined when none is
// configured/usable. Mirrors voice-handlers.ts resolveSttProvider.
function resolveRealtimeProvider(config: GatewayConfig): ModelProviderConfig | undefined {
  const modelId = selectRealtimeVoiceModel(config);
  if (modelId === undefined) {
    return undefined;
  }
  return config.providers.find((provider) => provider.modelId === modelId);
}

// Realtime SDP negotiation is interactive: a user is waiting with the microphone open. The generic
// provider request timeout (commonly 30s) is far too long here, but the ephemeral-token + SDP flow is
// two provider round trips and can exceed the old 8s bound on proxied links. Clamp to a moderate
// interactive bound so a stalled handshake still fails fast and the composer can degrade to text.
const REALTIME_NEGOTIATION_TIMEOUT_MS = 12_000;

// Opt-in content-free abuse-monitoring identifier for the realtime session (OpenAI `safety_identifier`).
// Enabled per deployment via KEIKO_VOICE_SAFETY_IDENTIFIER=1 once the operator has confirmed their
// realtime provider accepts the field (some strict providers reject unknown session fields — hence
// opt-in). The value is a salted SHA-256 of the chat id, truncated: stable per chat so the provider can
// group a session's requests for rate limiting, but never the raw id and never PII. Returns undefined
// (field omitted) when disabled or when there is no chat id, so the default request shape is unchanged.
function realtimeSafetyIdentifier(chatId: string): string | undefined {
  if (process.env.KEIKO_VOICE_SAFETY_IDENTIFIER !== "1" || chatId.length === 0) {
    return undefined;
  }
  const digest = createHash("sha256").update(`keiko-voice:${chatId}`).digest("hex").slice(0, 32);
  return `keiko-voice-${digest}`;
}

function realtimeSessionTuning(
  config: GatewayConfig,
  provider: ModelProviderConfig,
): Pick<RealtimeNegotiationRequest, "transcriptionModel" | "turnDetection"> | undefined {
  const capability = findConfiguredCapability(config, provider.modelId);
  const transcriptionModel = capability?.realtimeTranscriptionModel?.trim();
  if (!transcriptionModel) return undefined;
  return {
    transcriptionModel,
    ...(capability?.supportsSemanticTurnDetection === true
      ? {
          turnDetection: {
            type: "semantic_vad",
            eagerness: "low",
            interrupt_response: false,
            create_response: false,
          },
        }
      : {}),
  };
}

function buildNegotiationRequest(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  offerSdp: string,
  deps: UiHandlerDeps,
  signal: AbortSignal,
  safetyIdentifier?: string,
): RealtimeNegotiationRequest | undefined {
  const tuning = realtimeSessionTuning(config, provider);
  if (tuning === undefined) return undefined;
  const egress = provider.egress ?? currentGatewayEgressConfig(deps);
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    ...(provider.realtimeAuthMode !== undefined
      ? { realtimeAuthMode: provider.realtimeAuthMode }
      : {}),
    modelId: provider.modelId,
    ...tuning,
    // The realtime deployment owns media transport, VAD, and transcription only. Every final spoken
    // turn is answered by the canonical chat pipeline so retrieval, MemoriaViva, governance, and the
    // visible transcript cannot diverge from a competing provider-native response.
    ...(safetyIdentifier !== undefined ? { safetyIdentifier } : {}),
    offerSdp,
    signal,
    timeoutMs: Math.min(provider.timeoutMs, REALTIME_NEGOTIATION_TIMEOUT_MS),
    ...(egress !== undefined ? { egress } : {}),
  };
}

// A minimal abstraction over the parts of the `ws` socket the protocol logic uses, so the state
// machine is unit-testable with a fake socket (no real WebSocket server required).
export interface VoiceControlSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface VoiceControlConnectionOptions {
  readonly socket: VoiceControlSocket;
  readonly session: SessionState;
  readonly negotiate: NegotiateFn;
  readonly redact: (value: unknown) => unknown;
  // Resolved ONCE per WebSocket connection at handleUpgrade (RB-6 / ADR-0173 D5), never re-minted
  // per failure — every diagnostic-bearing message this connection emits over its whole lifetime,
  // including across a session resumed by a later reconnect's OWN new connection, is joinable to
  // the id of the upgrade that produced it.
  readonly correlationId: string;
  // RB-6 (GEN-OBS-DIAGNOSTICS-901/602/603) — operator diagnostic sink for negotiation failures.
  // Optional: when undefined, emitServerDiagnostic falls back to the default stderr sink.
  readonly diagnostics: ServerDiagnosticSink | undefined;
}

// Mirrors voice-live-dictation.ts's LiveDictationNegotiationError: a content-free stand-in error
// used only when a negotiation outcome carries a failure kind but no underlying thrown value (a
// typed protocol-level rejection rather than a caught exception), so serverDiagnosticFromError
// always has an Error-shaped input to classify.
class RealtimeControlNegotiationError extends Error {
  constructor(readonly code: RealtimeNegotiationErrorKind) {
    super("realtime control negotiation failed");
  }
}

// The protocol state machine for one attached control socket. Pure of WebSocket/IO concerns beyond
// the injected `socket.send` — every inbound frame is validated against the #496 contract, gated by
// the session profile, and answered per the protocol; every outbound frame is sequenced, redacted,
// and (when replay-eligible) buffered. Negotiation is delegated to the injected `negotiate` seam.
export class VoiceControlConnection {
  private readonly socket: VoiceControlSocket;
  private readonly session: SessionState;
  private readonly negotiate: NegotiateFn;
  private readonly redact: (value: unknown) => unknown;
  private readonly correlationId: string;
  private readonly diagnostics: ServerDiagnosticSink | undefined;
  private negotiation: AbortController | undefined;
  private closed = false;

  constructor(options: VoiceControlConnectionOptions) {
    this.socket = options.socket;
    this.session = options.session;
    this.negotiate = options.negotiate;
    this.redact = options.redact;
    this.correlationId = options.correlationId;
    this.diagnostics = options.diagnostics;
  }

  // Re-delivers the buffered replayable events to a (re)attached client, then announces the resolved
  // session — the reconnect catch-up of protocol §7. The additive productive constant keeps the
  // WebSocket realization distinct from the immutable v1 HTTP/SSE compatibility value.
  start(resume: boolean): void {
    // Structured, correlation-keyed session-lifecycle line (w4b-voice-realtime, #2902): brackets
    // dispose()'s session-ended line so an operator/agent reconstructing a defect can see exactly
    // how long a control-plane session was attached. Content-free — profile and resume are both
    // closed-vocabulary/boolean values, never the session or idempotency id.
    getServerLogger().info({
      category: "http",
      op: "voice.realtime.session-started",
      correlationId: this.correlationId,
      extra: { profile: this.session.profile, resumed: resume },
    });
    if (resume) {
      for (const buffered of replayEvents(this.session)) {
        this.dispatchOut(buffered);
      }
    }
    this.emit({
      kind: "session.created",
      profile: this.session.profile,
      controlTransport: VOICE_REALTIME_CONTROL_TRANSPORT,
      mediaTransport: "webrtc",
      negotiationMode: VOICE_PROFILE_NEGOTIATION_MODE[this.session.profile],
      ...(this.session.providerLocality !== undefined
        ? { providerLocality: this.session.providerLocality }
        : {}),
    });
    this.emit({
      kind: "capability.offer",
      profile: this.session.profile,
      capabilities: this.session.capabilities,
    });
  }

  async receive(raw: string): Promise<void> {
    if (this.closed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.fail("invalid-message");
      return;
    }
    const validation = validateVoiceControlMessage(parsed);
    if (!validation.ok) {
      // The envelope (including the version-compatibility rule) is malformed. If the version is the
      // problem, answer the protocol's dedicated unsupported-version error before closing.
      const code =
        isRecord(parsed) && parsed.protocolVersion !== VOICE_PROTOCOL_VERSION
          ? "unsupported-version"
          : "invalid-message";
      this.fail(code);
      return;
    }
    const message = parsed as VoiceControlMessage;
    // A live connection is authority-bound to one session and one wire direction. A structurally
    // valid frame cannot address another session or impersonate a host event on the client socket.
    if (message.sessionId !== this.session.sessionId || message.direction !== "client-to-host") {
      this.fail("invalid-message");
      return;
    }
    // Idempotency on (sessionId, seq): an already-seen or stale client sequence is ignored, never
    // re-processed (protocol §7). The opening session.create used seq=0, so a repeated create is stale.
    if (message.seq <= this.session.lastClientSeq) {
      return;
    }
    if (!productiveRealtimeClientMessageAllowed(message, this.session.profile)) {
      this.emitError("not-allowed-for-profile");
      return;
    }
    this.session.lastClientSeq = Math.max(this.session.lastClientSeq, message.seq);
    await this.dispatchIn(message);
  }

  // Marks the connection closed exactly once and aborts any in-flight negotiation. Shared by
  // dispose() (the plane's ws "close" handler — an abrupt disconnect) and shutdown() (an explicit
  // protocol-driven close, e.g. session.close or fail()) so the session-ended line brackets
  // start()'s session-started line exactly once, whichever path reaches the connection's end
  // first (w4b-voice-realtime, #2902). Returns whether this call performed the transition, so a
  // caller that still owns follow-up work (shutdown()'s socket.close) can skip it when a prior
  // call already closed the connection.
  private endSession(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    getServerLogger().info({
      category: "http",
      op: "voice.realtime.session-ended",
      correlationId: this.correlationId,
    });
    this.negotiation?.abort();
    this.negotiation = undefined;
    return true;
  }

  // Aborts any in-flight negotiation and marks the connection closed (socket lifecycle ended). The
  // session record is retained by the plane for the resume window; this only detaches the socket.
  dispose(): void {
    this.endSession();
  }

  private async dispatchIn(message: VoiceControlMessage): Promise<void> {
    // Only the kinds that drive a host action are handled. Every other permitted kind is an
    // observable no-op: a repeated session.create (start() already announced the session), a late
    // signal.ice.candidate (proxied single-shot SDP carries ICE in the offer/answer — no provider
    // trickle channel), client-reported media.track.state / playback.state, and control.interrupt
    // (KEIKO-0661: added to the enumeration when the interrupt kind was introduced). The
    // productive direction allowlist above rejects transcript-bearing, host-originated, and
    // future kinds before this switch, so an ignored branch can never acquire authority by
    // generic contract expansion.
    switch (message.kind) {
      case "signal.sdp.offer":
        await this.handleOffer(message.sdp);
        return;
      case "capability.select":
        // KEIKO-0661: validate the selected profile matches the negotiated one before acknowledging.
        // Before this fix any capability.select was answered with unconditional "allow" -- a
        // future or hand-crafted client selecting a profile the session was never negotiated for
        // would get an "allow" back. The realtime transport only negotiates one profile per
        // session, so a mismatched select must be denied. VoicePolicyDecision permits "deny"
        // (voice-protocol.ts:266), so this uses the contract's own vocabulary rather than
        // inventing a value.
        if (message.profile !== this.session.profile) {
          // No reason field: VoiceUnavailableReason is a fixed vocabulary in gateway.ts (no
          // "profile-mismatch" member), and a policy.decision with just "deny" is valid.
          this.emit({ kind: "policy.decision", decision: "deny" });
          return;
        }
        this.emit({ kind: "policy.decision", decision: "allow" });
        return;
      case "control.cancel":
        this.cancelNegotiation();
        return;
      case "transcript.discarded":
        // Replayable + content-free: record it into the reconnect buffer without echoing.
        this.record({ kind: "transcript.discarded" });
        return;
      case "session.close":
        this.session.terminal = true;
        this.emit({ kind: "session.closed", reason: "client-request" });
        this.shutdown(1000, "session closed");
        return;
      default:
        return;
    }
  }

  private cancelNegotiation(): void {
    this.negotiation?.abort();
    this.negotiation = undefined;
  }

  // Mirrors voice-live-dictation.ts's reportNegotiationFailure (RB-6 / ADR-0173 D5, #2902
  // w4b-voice-realtime): emits a body-free structured diagnostic — carrying the connection-scoped
  // correlation id, never re-minted per failure — before answering the client's protocol error.
  private failNegotiation(kind: RealtimeNegotiationErrorKind, thrown: unknown): void {
    const diagnostic = serverDiagnosticFromError({
      correlationId: this.correlationId,
      operation: "voice.realtime.negotiate",
      source: "voice.realtime",
      error: thrown ?? new RealtimeControlNegotiationError(kind),
      redact: (message: string): string => String(this.redact(message)),
    });
    emitServerDiagnostic(this.diagnostics, { ...diagnostic, code: kind });
    this.emitError("negotiation-failed", this.correlationId);
    this.emit({ kind: "media.track.state", track: "audio-in", state: "ended" });
  }

  private async handleOffer(offerSdp: string): Promise<void> {
    if (!isApprovedDirectionalSdp(offerSdp, "sendonly")) {
      this.emitError("invalid-message");
      return;
    }
    const controller = new AbortController();
    const superseded = this.negotiation;
    this.negotiation = controller;
    superseded?.abort();
    this.emit({ kind: "media.track.state", track: "audio-in", state: "negotiating" });
    let outcome: RealtimeNegotiationOutcome;
    let thrown: unknown;
    try {
      outcome = await this.negotiate(offerSdp, this.session.chatContext, controller.signal);
    } catch (error) {
      // Provider transports may reject instead of returning a typed failure. Preserve the thrown
      // class for the redacted diagnostic while normalizing its stable machine code below.
      thrown = error;
      outcome = { ok: false, kind: "transport" };
    }
    if (this.negotiation !== controller) {
      // A newer valid offer, cancel, or close superseded this negotiation; drop its result.
      return;
    }
    this.negotiation = undefined;
    if (this.closed) {
      return;
    }
    if (!outcome.ok) {
      this.failNegotiation(outcome.kind, thrown);
      return;
    }
    if (!isApprovedDirectionalSdp(outcome.value.answerSdp, "recvonly")) {
      this.failNegotiation("invalid-response", undefined);
      return;
    }
    // signal.sdp.answer is ephemeral + secret-bearing: it is sent to the live negotiation but never
    // buffered into the replay record (emit() only buffers replay-eligible kinds).
    this.emit({ kind: "signal.sdp.answer", sdp: outcome.value.answerSdp });
    this.emit({ kind: "media.track.state", track: "audio-in", state: "live" });
  }

  private emitError(code: VoiceProtocolErrorCode, correlationId?: string): void {
    this.emit({ kind: "error", code, ...(correlationId !== undefined ? { correlationId } : {}) });
  }

  // Builds a sequenced host→client control message from a payload, appends it to the bounded replay
  // buffer when the kind is replay-eligible (protocol §7), and returns it for sending.
  private build(payload: HostMessagePayload): VoiceControlMessage {
    const message = {
      protocolVersion: VOICE_PROTOCOL_VERSION,
      sessionId: this.session.sessionId,
      seq: this.session.hostSeq,
      direction: "host-to-client" as const,
      ...payload,
    } as VoiceControlMessage;
    this.session.hostSeq += 1;
    if (isVoiceReplayEligible(message.kind)) {
      appendReplayEvent(this.session, message);
    }
    return message;
  }

  // Sequences, redacts, and sends a host→client message now (and buffers it when replay-eligible).
  private emit(payload: HostMessagePayload): void {
    this.dispatchOut(this.build(payload));
  }

  // Records a replay-eligible, content-free event into the reconnect buffer WITHOUT sending it.
  private record(payload: HostMessagePayload): void {
    this.build(payload);
  }

  private dispatchOut(message: VoiceControlMessage): void {
    if (this.closed) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(this.redact(message)));
    } catch {
      // a send failure means the socket is gone; the close handler will dispose the connection.
    }
  }

  private fail(code: "invalid-message" | "unsupported-version"): void {
    this.session.terminal = true;
    this.emitError(code);
    this.shutdown(1008, code);
  }

  private shutdown(code: number, reason: string): void {
    if (!this.endSession()) {
      return;
    }
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore — socket already gone
    }
  }
}

// Reads whether a raw upgrade request targets the single allowed voice control path.
function isVoiceControlUpgrade(req: IncomingMessage): boolean {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  return url.pathname === VOICE_CONTROL_PATH;
}

function rawDataToString(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) {
    return undefined;
  }
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function rawDataByteLength(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return Buffer.from(data).byteLength;
}

export interface VoiceControlPlaneDeps {
  // The bound loopback port; the upgrade reuses the HTTP path's Host/Origin check on it.
  readonly port: number;
  // Resolves the current UI handler deps (config, redactor, negotiation seam) so the plane sees live
  // config/redactor at upgrade time, mirroring how server.ts holds handlerDeps.
  readonly handlerDeps: () => UiHandlerDeps;
}

// The realtime voice control plane bound to one server. `handleUpgrade` is the gated replacement for
// server.ts's hard-reject upgrade handler; it accepts ONLY the voice control path, ONLY on a loopback
// Host/Origin, and ONLY when the deployment is full-realtime capable.
// The minimal liveness surface a control socket exposes for the heartbeat. `ws` sockets satisfy it
// structurally (ping/terminate are native; `isAlive` is the standard `ws` heartbeat flag carried on the
// socket). Modelled as an interface so the sweep is unit-testable with a fake socket.
export interface AliveControlSocket {
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
}

// One heartbeat sweep over the live control sockets: a socket that did not answer the previous ping
// (isAlive === false) is terminated so a half-open connection cannot linger and hold a session slot;
// every other socket is re-armed (isAlive = false) and pinged. Pure over the iterable — no clock, no
// timer — so it is directly unit-testable without a real WebSocket server.
export function sweepControlHeartbeat(sockets: Iterable<AliveControlSocket>): void {
  for (const socket of sockets) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}

function readSessionCreateFrame(ws: WsSocket, raw: string): VoiceSessionCreateMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ws.close(1008, "invalid opening frame");
    return undefined;
  }
  if (
    !validateVoiceControlMessage(parsed).ok ||
    !isRecord(parsed) ||
    parsed.kind !== "session.create"
  ) {
    ws.close(1008, "expected session.create");
    return undefined;
  }
  return parsed as unknown as VoiceSessionCreateMessage;
}

function sessionCreateMatchesVoiceProfile(
  parsed: VoiceSessionCreateMessage,
  voice: VoiceCapabilityResolution,
): boolean {
  return (
    parsed.requestedProfile === voice.profile &&
    parsed.negotiationMode === VOICE_PROFILE_NEGOTIATION_MODE[voice.profile]
  );
}

function resolveSessionChatContext(
  ws: WsSocket,
  deps: UiHandlerDeps,
  sessionId: string,
  parsed: VoiceSessionCreateMessage,
): VoiceSessionChatContext | undefined {
  if (
    parsed.transcriptionLanguage !== undefined ||
    parsed.persona !== undefined ||
    !isVoiceSessionChatContext(parsed.chatContext)
  ) {
    emitStandaloneError(ws, sessionId, "not-allowed-for-profile", deps.redactor);
    ws.close(1008, "missing chat context");
    return undefined;
  }
  const chatContext = parsed.chatContext;
  if (deps.store.findChatById(chatContext.chatId) === undefined) {
    emitStandaloneError(ws, sessionId, "not-allowed-for-profile", deps.redactor);
    ws.close(1008, "unknown chat context");
    return undefined;
  }
  return chatContext;
}

class VoiceControlPlaneImpl implements VoiceControlPlane {
  private readonly wss = new WebSocketServer({
    maxPayload: MAX_VOICE_CONTROL_FRAME_BYTES,
    noServer: true,
  });
  private readonly sessions = new Map<string, SessionState>();
  // Liveness sweep timer, started lazily on the first connection and cleared on closeAll (shutdown).
  // A socket that misses a ping/pong cycle is terminated by the next sweep.
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly planeDeps: VoiceControlPlaneDeps) {}

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      return;
    }
    const timer = setInterval(() => {
      this.sweepExpired(Date.now());
      sweepControlHeartbeat(this.wss.clients as Set<AliveControlSocket>);
    }, DEFAULT_VOICE_PROTOCOL_TIMEOUTS.heartbeatIntervalMs);
    // Do not keep the Node process alive solely for the heartbeat.
    timer.unref();
    this.heartbeat = timer;
  }

  handleUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): boolean {
    if (!isVoiceControlUpgrade(req)) {
      return false;
    }
    const deps = this.planeDeps.handlerDeps();
    // Three load-bearing gates: (1) a present, loopback Origin — a browser always sends Origin on a WS
    // handshake, so requiring it (in addition to `isAllowedHost` rejecting a non-loopback or opaque
    // `null` Origin) keeps the control plane reachable only from the loopback browser origin and never
    // from a non-browser local process; (2) loopback Host; (3) the full-realtime capability gate (a
    // no-voice / STT-only / policy-disabled deployment keeps the WebSocket hard-rejected, AC1/AC3).
    if (
      typeof req.headers.origin !== "string" ||
      !isAllowedHost(req, this.planeDeps.port) ||
      !isVoiceRealtimeCapable(deps)
    ) {
      return false;
    }
    // Resolved ONCE per upgrade (RB-6 / ADR-0173 D5): the id is scoped to this physical WebSocket
    // connection, not the resumable logical session, so a later reconnect gets its own fresh id.
    const correlationId = resolveCorrelationId(req);
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      this.onConnection(ws, deps, correlationId);
    });
    return true;
  }

  closeAll(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const client of this.wss.clients) {
      client.close(1001, "server shutting down");
    }
    this.wss.close();
    this.sessions.clear();
  }

  private sweepExpired(now: number): void {
    for (const [key, state] of this.sessions) {
      if (state.detachedAt !== undefined && now - state.detachedAt > SESSION_RESUME_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }

  private buildNegotiate(deps: UiHandlerDeps): NegotiateFn {
    return async (
      offerSdp: string,
      chatContext: VoiceSessionChatContext | undefined,
      signal: AbortSignal,
    ): Promise<RealtimeNegotiationOutcome> => {
      const config = currentGatewayConfig(deps);
      if (config === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const provider = resolveRealtimeProvider(config);
      if (provider === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const negotiate = deps.voiceRealtimeNegotiationRequest ?? requestRealtimeNegotiation;
      const safetyIdentifier =
        chatContext === undefined ? undefined : realtimeSafetyIdentifier(chatContext.chatId);
      const negotiationRequest = buildNegotiationRequest(
        config,
        provider,
        offerSdp,
        deps,
        signal,
        safetyIdentifier,
      );
      if (negotiationRequest === undefined) return { ok: false, kind: "unsupported-model" };
      return negotiate(negotiationRequest);
    };
  }

  // Resolves (creating or resuming) the session for a validated opening frame, or closes the socket
  // and returns undefined on a bad frame. The negotiation mode must match the canonical mode for the
  // effective profile (an inconsistent mode is rejected, never advisory).
  private resolveSession(
    ws: WsSocket,
    deps: UiHandlerDeps,
    voice: VoiceCapabilityResolution,
    raw: string,
  ): { state: SessionState; resume: boolean } | undefined {
    const parsed = readSessionCreateFrame(ws, raw);
    if (parsed === undefined) return undefined;
    const sessionId = parsed.sessionId;
    if (!isSafeIdentifier(sessionId) || !isSafeIdentifier(parsed.idempotencyKey)) {
      ws.close(1008, "invalid session identifiers");
      return undefined;
    }
    if (!sessionCreateMatchesVoiceProfile(parsed, voice)) {
      emitStandaloneError(ws, sessionId, "not-allowed-for-profile", deps.redactor);
      ws.close(1008, "profile/negotiation mismatch");
      return undefined;
    }
    const chatContext = resolveSessionChatContext(ws, deps, sessionId, parsed);
    if (chatContext === undefined) return undefined;
    return this.createOrResumeSession(
      ws,
      voice,
      sessionId,
      parsed.idempotencyKey,
      chatContext,
      deps.redactor,
    );
  }

  private createOrResumeSession(
    ws: WsSocket,
    voice: VoiceCapabilityResolution,
    sessionId: string,
    idempotencyKey: string,
    chatContext: VoiceSessionChatContext | undefined,
    redact: (value: unknown) => unknown,
  ): { state: SessionState; resume: boolean } | undefined {
    this.sweepExpired(Date.now());
    const resumed = this.sessions.get(idempotencyKey);
    if (resumed !== undefined) {
      const sameBinding =
        resumed.sessionId === sessionId &&
        resumed.profile === voice.profile &&
        resumed.chatContext?.chatId === chatContext?.chatId;
      if (!sameBinding) {
        emitStandaloneError(ws, sessionId, "invalid-message", redact);
        ws.close(1008, "idempotency binding mismatch");
        return undefined;
      }
      if (resumed.detachedAt === undefined) {
        emitStandaloneError(ws, sessionId, "rate-limited", redact);
        ws.close(1013, "session already attached");
        return undefined;
      }
      resumed.detachedAt = undefined;
      return { state: resumed, resume: true };
    }
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      emitStandaloneError(ws, sessionId, "rate-limited", redact);
      ws.close(1013, "too many sessions");
      return undefined;
    }
    const state: SessionState = {
      sessionId,
      idempotencyKey,
      profile: voice.profile,
      capabilities: { ...voice.capabilities },
      providerLocality: voice.providerLocality,
      chatContext,
      hostSeq: 0,
      lastClientSeq: 0,
      replay: [],
      replayStart: 0,
      detachedAt: undefined,
      terminal: false,
    };
    this.sessions.set(idempotencyKey, state);
    return { state, resume: false };
  }

  // Heartbeat liveness for one socket: mark it alive, refresh on each pong, and ensure the sweep timer
  // is running. A socket that stops answering pings is terminated by the next sweep (no half-open leaks).
  private attachHeartbeat(ws: WsSocket): void {
    const live = ws as AliveControlSocket;
    live.isAlive = true;
    ws.on("pong", () => {
      live.isAlive = true;
    });
    this.startHeartbeat();
  }

  // eslint-disable-next-line max-lines-per-function -- connection lifecycle keeps heartbeat, frame limits, session start, and detach handling together.
  private onConnection(ws: WsSocket, deps: UiHandlerDeps, correlationId: string): void {
    this.attachHeartbeat(ws);
    const voice = resolveVoiceCapability(currentGatewayConfig(deps) ?? { providers: [] }, {
      policyDisabled: isVoiceDisabledByPolicy(deps.env),
    });
    const negotiate = this.buildNegotiate(deps);
    const socket: VoiceControlSocket = {
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
    };
    let connection: VoiceControlConnection | undefined;
    let activeSession: SessionState | undefined;

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (rawDataByteLength(data) > MAX_VOICE_CONTROL_FRAME_BYTES) {
        if (activeSession !== undefined) activeSession.terminal = true;
        ws.close(1009, "control frame too large");
        return;
      }
      const raw = rawDataToString(data, isBinary);
      if (raw === undefined) {
        // Raw audio / binary frames are never a control message (AC1): reject and close.
        if (activeSession !== undefined) activeSession.terminal = true;
        ws.close(1003, "binary frames are not permitted on the control plane");
        return;
      }
      if (connection !== undefined) {
        void connection.receive(raw);
        return;
      }
      const resolved = this.resolveSession(ws, deps, voice, raw);
      if (resolved === undefined) {
        return;
      }
      activeSession = resolved.state;
      connection = new VoiceControlConnection({
        socket,
        session: resolved.state,
        negotiate,
        redact: deps.redactor,
        correlationId,
        diagnostics: deps.diagnostics,
      });
      connection.start(resolved.resume);
    });

    ws.on("close", () => {
      connection?.dispose();
      if (activeSession?.terminal === true) {
        if (this.sessions.get(activeSession.idempotencyKey) === activeSession) {
          this.sessions.delete(activeSession.idempotencyKey);
        }
        return;
      }
      // Mark the session resumable for the reconnect window rather than deleting it immediately.
      if (activeSession !== undefined && activeSession.detachedAt === undefined) {
        activeSession.detachedAt = Date.now();
      }
    });

    ws.on("error", () => {
      ws.close(1011, "control plane error");
    });
  }
}

// Builds the realtime voice control plane bound to one server.
export function createVoiceControlPlane(planeDeps: VoiceControlPlaneDeps): VoiceControlPlane {
  return new VoiceControlPlaneImpl(planeDeps);
}

// Emits a standalone protocol error on a socket that has no attached connection yet (e.g. a rejected
// opening frame), so the client receives a typed error before the close, redacted like every frame.
function emitStandaloneError(
  ws: WsSocket,
  sessionId: string,
  code: "invalid-message" | "not-allowed-for-profile" | "rate-limited",
  redact: (value: unknown) => unknown,
): void {
  const message: VoiceControlMessage = {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId,
    seq: 0,
    direction: "host-to-client",
    kind: "error",
    code,
  };
  try {
    ws.send(JSON.stringify(redact(message)));
  } catch {
    // ignore — socket already gone
  }
}
