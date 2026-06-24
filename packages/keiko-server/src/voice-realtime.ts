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
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  type GatewayConfig,
  type ModelProviderConfig,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  assertNeverVoiceControlMessageKind,
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
    modelId: provider.modelId,
    offerSdp,
    signal,
    timeoutMs: provider.timeoutMs,
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
    switch (message.kind) {
      case "session.create":
        // The session is resolved/created by the plane before the connection starts; a repeated
        // create (reconnect/idempotency) is a no-op here — start() already announced it.
        return;
      case "capability.select":
        // The only selectable profile is the resolved full-realtime profile; acknowledge by policy.
        this.emit({ kind: "policy.decision", decision: "allow" });
        return;
      case "signal.sdp.offer":
        await this.handleOffer(message.sdp);
        return;
      case "signal.ice.candidate":
        // Proxied single-shot SDP negotiation carries ICE inside the offer/answer, so there is no
        // provider trickle channel to relay a late client candidate to; accept it (it is permitted
        // for full-realtime) as an ephemeral no-op. A trickle-capable provider profile would relay.
        return;
      case "control.interrupt":
        // Barge-in is observed on the control plane; the actual interruption happens on the media
        // plane. Acknowledge playback interruption so the state is observable (AC6).
        this.emit({ kind: "playback.state", state: "interrupted" });
        return;
      case "control.cancel":
        this.negotiation?.abort();
        this.negotiation = undefined;
        return;
      case "media.track.state":
      case "transcript.partial":
      case "playback.state":
        // Client-reported transport state — observable on the control plane, no host action required.
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
      // host-originated kinds a well-behaved client never sends; ignore rather than trust.
      case "session.created":
      case "session.closed":
      case "capability.offer":
      case "signal.sdp.answer":
      case "policy.decision":
      case "error":
        return;
      default:
        // Exhaustiveness guard: every VoiceControlMessageKind is handled above, so `message` narrows
        // to `never` here. Adding a new contract kind without a case makes it non-never and fails to
        // type-check (TS 6 rejects `.kind` access on `never`, so the narrowed message is passed).
        return assertNeverVoiceControlMessageKind(message);
    }
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
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

export interface VoiceControlPlaneDeps {
  // The bound loopback port; the upgrade reuses the HTTP path's Host/Origin check on it.
  readonly port: number;
  // Resolves the current UI handler deps (config, redactor, negotiation seam) so the plane sees live
  // config/redactor at upgrade time, mirroring how server.ts holds handlerDeps.
  readonly handlerDeps: () => UiHandlerDeps;
}

// Builds the realtime voice control plane bound to one server. The returned `handleUpgrade` is the
// gated replacement for server.ts's hard-reject upgrade handler; it accepts ONLY the voice control
// path, ONLY on a loopback Host/Origin, and ONLY when the deployment is full-realtime capable.
export function createVoiceControlPlane(planeDeps: VoiceControlPlaneDeps): VoiceControlPlane {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, SessionState>();

  function sweepExpired(now: number): void {
    for (const [key, state] of sessions) {
      if (state.detachedAt !== undefined && now - state.detachedAt > SESSION_RESUME_TTL_MS) {
        sessions.delete(key);
      }
    }
  }

  function buildNegotiate(deps: UiHandlerDeps): NegotiateFn {
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

  function onConnection(ws: WsSocket, deps: UiHandlerDeps): void {
    const config = currentGatewayConfig(deps);
    const voice = resolveVoiceCapability(config ?? { providers: [] }, {
      policyDisabled: isVoiceDisabledByPolicy(deps.env),
    });
    const negotiate = buildNegotiate(deps);
    const redact = deps.redactor;
    const socket: VoiceControlSocket = {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
    let connection: VoiceControlConnection | undefined;
    let activeSession: SessionState | undefined;

    function beginSession(raw: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ws.close(1008, "invalid opening frame");
        return;
      }
      const validation = validateVoiceControlMessage(parsed);
      if (!validation.ok || !isRecord(parsed) || parsed.kind !== "session.create") {
        ws.close(1008, "expected session.create");
        return;
      }
      const sessionId = parsed.sessionId;
      const idempotencyKey = parsed.idempotencyKey;
      if (!isSafeIdentifier(sessionId) || !isSafeIdentifier(idempotencyKey)) {
        ws.close(1008, "invalid session identifiers");
        return;
      }
      // The negotiation mode must match the canonical mode for the effective profile; an inconsistent
      // mode (e.g. direct-ephemeral on a session that must be proxied) is rejected, never advisory.
      if (
        parsed.requestedProfile !== voice.profile ||
        parsed.negotiationMode !== VOICE_PROFILE_NEGOTIATION_MODE[voice.profile]
      ) {
        emitStandaloneError(ws, sessionId, "not-allowed-for-profile", redact);
        ws.close(1008, "profile/negotiation mismatch");
        return;
      }
      sweepExpired(Date.now());
      const resumed = sessions.get(idempotencyKey);
      let resume = false;
      if (resumed !== undefined && resumed.sessionId === sessionId) {
        resumed.detachedAt = undefined;
        activeSession = resumed;
        resume = true;
      } else {
        if (sessions.size >= MAX_ACTIVE_SESSIONS) {
          emitStandaloneError(ws, sessionId, "rate-limited", redact);
          ws.close(1013, "too many sessions");
          return;
        }
        activeSession = {
          sessionId,
          idempotencyKey,
          profile: voice.profile,
          providerLocality: voice.providerLocality,
          hostSeq: 0,
          lastClientSeq: 0,
          replay: [],
          detachedAt: undefined,
        };
        sessions.set(idempotencyKey, activeSession);
      }
      connection = new VoiceControlConnection({
        socket,
        session: activeSession,
        negotiate,
        redact,
      });
      connection.start(resume);
    }

    ws.on("message", (data: RawData, isBinary: boolean) => {
      const raw = rawDataToString(data, isBinary);
      if (raw === undefined) {
        // Raw audio / binary frames are never a control message (AC1): reject and close.
        ws.close(1003, "binary frames are not permitted on the control plane");
        return;
      }
      if (connection === undefined) {
        beginSession(raw);
        return;
      }
      void connection.receive(raw);
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

  return {
    handleUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): boolean {
      if (!isVoiceControlUpgrade(req)) {
        return false;
      }
      const deps = planeDeps.handlerDeps();
      // The two load-bearing gates: loopback Host/Origin (rejects cross-origin + opaque null), and
      // the full-realtime capability gate (a no-voice / STT-only / policy-disabled deployment keeps
      // the WebSocket hard-rejected, AC1/AC3).
      if (!isAllowedHost(req, planeDeps.port) || !isVoiceRealtimeCapable(deps)) {
        return false;
      }
      wss.handleUpgrade(req, sock, head, (ws) => {
        onConnection(ws, deps);
      });
      return true;
    },
    closeAll(): void {
      for (const client of wss.clients) {
        client.close(1001, "server shutting down");
      }
      wss.close();
      sessions.clear();
    },
  };
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
