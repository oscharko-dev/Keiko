// BFF realtime voice control plane (Issue #497, Epic #491, ADR-0058 D3/D6, ADR-0059). Re-opens the
// BFF WebSocket upgrade — deliberately hard-rejected for every other path (server.ts) — for the single
// loopback control path `/api/voice/control`, and ONLY when the resolved voice capability is the
// full-realtime profile and policy permits it (AC1). The WebSocket carries the #496 control/signaling
// protocol; raw audio never rides it — real-time media flows browser↔provider over native WebRTC
// (DTLS-SRTP), negotiated by the preferred proxied-SDP mode so the long-lived provider credential
// never reaches the browser (AC2).
//
// Security posture (ADR-0058 D6): the upgrade reuses the same loopback `isAllowedHost` Host/Origin
// check as the HTTP path (host-check.ts) — a WebSocket handshake cannot carry the JSON+CSRF guard, so
// the loopback-origin check (which rejects opaque `Origin: null` and any non-loopback origin) plus the
// capability gate are the load-bearing cross-origin defenses. SDP/ICE payloads are opaque,
// `secret-bearing` strings: they are forwarded verbatim through the Model Gateway egress seam and are
// never logged or persisted (privacy-contract §2/§4). Transcript text is `reviewable-text`: it is run
// through `stripUnsafeFormatChars` and the BFF redactor before it may enter the bounded replay buffer.
// Raw audio is never a control message (a binary frame is rejected) and is never persisted (AC1/AC6).

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import {
  requestRealtimeNegotiation,
  resolveRealtimeVoice,
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  type GatewayConfig,
  type ModelProviderConfig,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationRequest,
  type VoiceCapabilityResolution,
} from "@oscharko-dev/keiko-model-gateway";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import {
  isVoiceReplayEligible,
  stripUnsafeFormatChars,
  validateVoiceControlMessage,
  VOICE_PROFILE_NEGOTIATION_MODE,
  VOICE_PROTOCOL_VERSION,
  voiceMessageAllowedForProfile,
  type VoiceControlMessage,
  type VoiceProfile,
  type VoiceProtocolErrorCode,
  type VoiceProviderLocality,
} from "@oscharko-dev/keiko-contracts";
import { isAllowedHost } from "./host-check.js";
import { currentGatewayConfig, currentGatewayEgressConfig, type UiHandlerDeps } from "./deps.js";
import { isVoiceDisabledByPolicy, isVoiceRealtimeCapable } from "./read-handlers.js";

// The single loopback path the BFF WebSocket upgrade is re-opened for. Every other upgrade keeps the
// hard 404 + socket.destroy() default (server.ts).
export const VOICE_CONTROL_PATH = "/api/voice/control";

// An SDP offer is small (a single audio m-line plus ICE/DTLS metadata); reject a larger one before
// any provider call so a hostile client cannot push an unbounded body through the egress seam.
const MAX_OFFER_SDP_BYTES = 256_000;
// Reviewable transcript text is bounded before strip/redact so a hostile client cannot grow the
// replay buffer without limit.
const MAX_TRANSCRIPT_CHARS = 8_000;
// The bounded per-session replay-diagnostic record (AC6): the host re-delivers these `replayable`
// host→client events to a reconnecting client. Oldest entries are evicted past the cap.
const MAX_REPLAY_EVENTS = 200;
// A disconnected session is resumable (by idempotency key) for this long, then swept.
const SESSION_RESUME_TTL_MS = 60_000;
// Bound the number of tracked sessions on the loopback control plane (single local user).
const MAX_ACTIVE_SESSIONS = 64;
// Bound the identifier length/charset before a client-chosen id may be tracked or logged, so a
// hostile id cannot inject into a log/audit line (content-free redaction class, protocol §8).
const MAX_ID_LENGTH = 200;
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

// The persistent per-session record. It outlives a single WebSocket so a reconnect (a new socket
// presenting the same idempotency key) resumes the same session and replays the buffered events,
// rather than creating a duplicate (protocol §7 idempotency + reconnect).
interface SessionState {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly profile: VoiceProfile;
  readonly providerLocality: VoiceProviderLocality | undefined;
  hostSeq: number;
  lastClientSeq: number;
  readonly replay: VoiceControlMessage[];
  detachedAt: number | undefined;
}

type NegotiateFn = (offerSdp: string, signal: AbortSignal) => Promise<RealtimeNegotiationOutcome>;

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

// The spoken-dialogue persona for the realtime session. It is the SAME Keiko system persona the text
// chat uses (CONVERSATION_SYSTEM_PROMPT) plus a short voice-delivery addendum, so spoken and written
// Keiko cannot diverge. Setting it explicitly replaces the provider's default demo persona ("a helpful,
// witty, and friendly AI … Talk quickly … knowledge cutoff 2023-10"), which would otherwise make the
// realtime voice a separate, ungrounded assistant — a direct violation of the dialogue-mode invariant.
const REALTIME_SPOKEN_ADDENDUM =
  " You are speaking with the user by voice. Keep replies short, natural, and conversational. " +
  "Do not read code, file paths, or long identifiers aloud verbatim; summarize them in words.";

// Whisper transcription enables input-audio transcripts so the chat transcript can capture what the
// user said by voice (the dialogue-mode grounding/evidence path).
const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = "whisper-1";

// Realtime SDP negotiation is interactive: a user is waiting with the microphone open. The generic
// provider request timeout (commonly 30s) is far too long here — a hung provider would freeze the
// session on "negotiating" for half a minute before surfacing an error. Clamp to a short interactive
// bound so a stalled handshake fails fast and the composer can degrade to text.
const REALTIME_NEGOTIATION_TIMEOUT_MS = 8_000;

function realtimeInstructions(): string {
  return `${CONVERSATION_SYSTEM_PROMPT}${REALTIME_SPOKEN_ADDENDUM}`;
}

// Resolves the realtime session voice from the provider's persona→voice mapping, guarded to a
// realtime-valid id. Without an explicit voice the session would use the provider default; with a
// TTS-only id (e.g. the operator-config `nova`) the realtime model rejects the session. The neutral
// persona is the session default until per-user persona selection is plumbed through the control protocol.
function resolveRealtimeVoiceId(provider: ModelProviderConfig): string {
  const profiles = provider.voiceProfiles ?? [];
  const neutral = profiles.find((profile) => profile.persona === "neutral")?.voiceId;
  return resolveRealtimeVoice(neutral ?? profiles[0]?.voiceId);
}

function buildNegotiationRequest(
  provider: ModelProviderConfig,
  offerSdp: string,
  deps: UiHandlerDeps,
  signal: AbortSignal,
): RealtimeNegotiationRequest {
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
    instructions: realtimeInstructions(),
    voiceId: resolveRealtimeVoiceId(provider),
    transcriptionModel: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
    offerSdp,
    signal,
    timeoutMs: Math.min(
      provider.timeoutMs ?? REALTIME_NEGOTIATION_TIMEOUT_MS,
      REALTIME_NEGOTIATION_TIMEOUT_MS,
    ),
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
  private negotiation: AbortController | undefined;
  private closed = false;

  constructor(options: VoiceControlConnectionOptions) {
    this.socket = options.socket;
    this.session = options.session;
    this.negotiate = options.negotiate;
    this.redact = options.redact;
  }

  // Re-delivers the buffered replayable events to a (re)attached client, then announces the resolved
  // session — the reconnect catch-up of protocol §7. The control transport is `loopback-websocket`,
  // recorded per session so the contract's `VOICE_CONTROL_TRANSPORT_V1` baseline is never mutated.
  start(resume: boolean): void {
    if (resume) {
      for (const buffered of this.session.replay) {
        this.dispatchOut(buffered);
      }
    }
    this.emit({
      kind: "session.created",
      profile: this.session.profile,
      controlTransport: "loopback-websocket",
      mediaTransport: "webrtc",
      negotiationMode: VOICE_PROFILE_NEGOTIATION_MODE[this.session.profile],
      ...(this.session.providerLocality !== undefined
        ? { providerLocality: this.session.providerLocality }
        : {}),
    });
    this.emit({
      kind: "capability.offer",
      profile: this.session.profile,
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
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
    // Idempotency on (sessionId, seq): an already-seen or stale client sequence is ignored, never
    // re-processed (protocol §7). session.create is the resume anchor and is always handled.
    if (message.kind !== "session.create" && message.seq <= this.session.lastClientSeq) {
      return;
    }
    if (!voiceMessageAllowedForProfile(message.kind, this.session.profile)) {
      this.emitError("not-allowed-for-profile");
      return;
    }
    this.session.lastClientSeq = Math.max(this.session.lastClientSeq, message.seq);
    await this.dispatchIn(message);
  }

  // Aborts any in-flight negotiation and marks the connection closed (socket lifecycle ended). The
  // session record is retained by the plane for the resume window; this only detaches the socket.
  dispose(): void {
    this.closed = true;
    this.negotiation?.abort();
    this.negotiation = undefined;
  }

  private async dispatchIn(message: VoiceControlMessage): Promise<void> {
    // Only the kinds that drive a host action are handled. Every other permitted kind is an
    // observable no-op: a repeated session.create (start() already announced the session), a late
    // signal.ice.candidate (proxied single-shot SDP carries ICE in the offer/answer — no provider
    // trickle channel), client-reported media.track.state / transcript.partial / playback.state, and
    // any host-originated kind a client should not send. A future contract kind is likewise ignored —
    // unknown control messages are never trusted.
    switch (message.kind) {
      case "signal.sdp.offer":
        await this.handleOffer(message.sdp);
        return;
      case "capability.select":
        // The only selectable profile is the resolved full-realtime profile; acknowledge by policy.
        this.emit({ kind: "policy.decision", decision: "allow" });
        return;
      case "control.interrupt":
        // Barge-in is observed on the control plane; the actual interruption happens on the media
        // plane. Acknowledge playback interruption so the state is observable (AC6).
        this.emit({ kind: "playback.state", state: "interrupted" });
        return;
      case "control.cancel":
        this.cancelNegotiation();
        return;
      case "transcript.committed":
        this.recordTranscript(message.text);
        return;
      case "transcript.discarded":
        // Replayable + content-free: record it into the reconnect buffer without echoing.
        this.record({ kind: "transcript.discarded" });
        return;
      case "session.close":
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

  private async handleOffer(offerSdp: string): Promise<void> {
    if (typeof offerSdp !== "string" || offerSdp.length === 0 || !offerSdp.startsWith("v=")) {
      this.emitError("invalid-message");
      return;
    }
    if (Buffer.byteLength(offerSdp, "utf8") > MAX_OFFER_SDP_BYTES) {
      this.emitError("invalid-message");
      return;
    }
    this.emit({ kind: "media.track.state", track: "audio-in", state: "negotiating" });
    const controller = new AbortController();
    this.negotiation = controller;
    let outcome: RealtimeNegotiationOutcome;
    try {
      outcome = await this.negotiate(offerSdp, controller.signal);
    } catch {
      outcome = { ok: false, kind: "transport" };
    }
    if (this.negotiation !== controller) {
      // A cancel/close superseded this negotiation; drop its result.
      return;
    }
    this.negotiation = undefined;
    if (this.closed) {
      return;
    }
    if (!outcome.ok) {
      this.emitError("negotiation-failed");
      this.emit({ kind: "media.track.state", track: "audio-in", state: "ended" });
      return;
    }
    // signal.sdp.answer is ephemeral + secret-bearing: it is sent to the live negotiation but never
    // buffered into the replay record (emit() only buffers replay-eligible kinds).
    this.emit({ kind: "signal.sdp.answer", sdp: outcome.value.answerSdp });
    this.emit({ kind: "media.track.state", track: "audio-in", state: "live" });
    this.emit({ kind: "media.track.state", track: "audio-out", state: "live" });
  }

  private recordTranscript(text: string): void {
    if (typeof text !== "string") {
      return;
    }
    // reviewable-text: neutralise Trojan-source / bidi rendering before the text may enter the replay
    // buffer, exactly as recap/session-state records are treated (protocol §8). Bounded length. A
    // committed transcript the client relayed from the provider is recorded into the reconnect buffer
    // (it is `replayable`) but not echoed back to the client that already holds it.
    const safe = stripUnsafeFormatChars(text).slice(0, MAX_TRANSCRIPT_CHARS);
    this.record({ kind: "transcript.committed", text: safe });
  }

  private emitError(code: VoiceProtocolErrorCode): void {
    this.emit({ kind: "error", code });
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
      this.session.replay.push(message);
      if (this.session.replay.length > MAX_REPLAY_EVENTS) {
        this.session.replay.shift();
      }
    }
    return message;
  }

  // Sequences, redacts, and sends a host→client message now (and buffers it when replay-eligible).
  private emit(payload: HostMessagePayload): void {
    this.dispatchOut(this.build(payload));
  }

  // Records a replay-eligible event into the reconnect buffer WITHOUT sending it — used for durable
  // events the client relayed (e.g. a committed transcript) which the connected client already holds,
  // but which a future reconnect must be able to replay.
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
    this.emitError(code);
    this.shutdown(1008, code);
  }

  private shutdown(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.negotiation?.abort();
    this.negotiation = undefined;
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
class VoiceControlPlaneImpl implements VoiceControlPlane {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly planeDeps: VoiceControlPlaneDeps) {}

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
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      this.onConnection(ws, deps);
    });
    return true;
  }

  closeAll(): void {
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
    return async (offerSdp: string, signal: AbortSignal): Promise<RealtimeNegotiationOutcome> => {
      const config = currentGatewayConfig(deps);
      if (config === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const provider = resolveRealtimeProvider(config);
      if (provider === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const negotiate = deps.voiceRealtimeNegotiationRequest ?? requestRealtimeNegotiation;
      return negotiate(buildNegotiationRequest(provider, offerSdp, deps, signal));
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
    const sessionId = parsed.sessionId;
    if (!isSafeIdentifier(sessionId) || !isSafeIdentifier(parsed.idempotencyKey)) {
      ws.close(1008, "invalid session identifiers");
      return undefined;
    }
    if (
      parsed.requestedProfile !== voice.profile ||
      parsed.negotiationMode !== VOICE_PROFILE_NEGOTIATION_MODE[voice.profile]
    ) {
      emitStandaloneError(ws, sessionId, "not-allowed-for-profile", deps.redactor);
      ws.close(1008, "profile/negotiation mismatch");
      return undefined;
    }
    return this.createOrResumeSession(ws, voice, sessionId, parsed.idempotencyKey, deps.redactor);
  }

  private createOrResumeSession(
    ws: WsSocket,
    voice: VoiceCapabilityResolution,
    sessionId: string,
    idempotencyKey: string,
    redact: (value: unknown) => unknown,
  ): { state: SessionState; resume: boolean } | undefined {
    this.sweepExpired(Date.now());
    const resumed = this.sessions.get(idempotencyKey);
    if (resumed?.sessionId === sessionId) {
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
      providerLocality: voice.providerLocality,
      hostSeq: 0,
      lastClientSeq: 0,
      replay: [],
      detachedAt: undefined,
    };
    this.sessions.set(idempotencyKey, state);
    return { state, resume: false };
  }

  private onConnection(ws: WsSocket, deps: UiHandlerDeps): void {
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
      const raw = rawDataToString(data, isBinary);
      if (raw === undefined) {
        // Raw audio / binary frames are never a control message (AC1): reject and close.
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
      });
      connection.start(resolved.resume);
    });

    ws.on("close", () => {
      connection?.dispose();
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
  code: "not-allowed-for-profile" | "rate-limited",
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
