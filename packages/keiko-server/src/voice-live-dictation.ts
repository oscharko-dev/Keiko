// BFF live dictation control plane (Keiko Voice P3). This is intentionally narrower than the
// dialogue control plane in voice-realtime.ts: it exists only to negotiate a transcription-only
// WebRTC session for browser microphone capture. It accepts no chat context, persona, tools,
// assistant-output configuration, binary media, provider credentials, provider URLs, raw events, or
// persisted transcripts.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import {
  findConfiguredCapability,
  requestRealtimeNegotiation,
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  type GatewayConfig,
  type ModelProviderConfig,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationErrorKind,
  type RealtimeNegotiationRequest,
  type VoiceCapabilityResolution,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  VoiceControlMessage,
  VoiceProtocolErrorCode,
  VoiceSessionCreateMessage,
} from "@oscharko-dev/keiko-contracts";
import {
  VOICE_PROFILE_NEGOTIATION_MODE,
  VOICE_PROTOCOL_VERSION,
  validateVoiceControlMessage,
} from "@oscharko-dev/keiko-contracts/runtime/voice-protocol";
import { isAllowedHost } from "./host-check.js";
import { resolveCorrelationId } from "./correlation.js";
import { currentGatewayConfig, currentGatewayEgressConfig, type UiHandlerDeps } from "./deps.js";
import { isVoiceDisabledByPolicy, isVoiceRealtimeCapable } from "./read-handlers.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import {
  MAX_VOICE_CONTROL_FRAME_BYTES,
  sweepControlHeartbeat,
  type AliveControlSocket,
  type VoiceControlPlane,
} from "./voice-realtime.js";

export const VOICE_LIVE_TRANSCRIBE_PATH = "/api/voice/transcribe/live";

const MAX_OFFER_SDP_BYTES = 256_000;
const MAX_ID_LENGTH = 200;
const SAFE_IDENTIFIER = /^[\x21-\x7e]+$/;
const LIVE_DICTATION_NEGOTIATION_TIMEOUT_MS = 12_000;
const LANGUAGE_HINT = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_LANGUAGE_HINT_CHARS = 35;
// KEIKO-0342: cap concurrent WebSocket dictation sessions the same way voice-realtime.ts
// caps its control-plane sessions (MAX_ACTIVE_SESSIONS = 64), so an unbounded burst of
// upgrades cannot exhaust the WebSocket server or the downstream transcription budget.
export const MAX_ACTIVE_LIVE_DICTATION_SESSIONS = 64;
// A rejected socket that ignores the close handshake would otherwise pin the server for
// ws's default 30 s close timeout. Terminate after 2 s if the client has not acknowledged.
const LIVE_DICTATION_REJECT_TERMINATE_TIMEOUT_MS = 2_000;

// Pure predicate exposed for regression coverage of KEIKO-0342. Callers pass the current
// wss.clients.size AFTER this connection has been admitted (the WebSocket server always
// adds the socket to the clients set before onConnection fires).
export function liveDictationSessionExceedsCap(activeClientCount: number): boolean {
  return activeClientCount > MAX_ACTIVE_LIVE_DICTATION_SESSIONS;
}

// ws 8.x emits 'error' on the WebSocket for a protocol error during close; an unhandled event
// terminates the Node process. Attach a NOOP listener BEFORE close(1013), then fall back to
// terminate() after a bounded grace so a stuck rejected socket cannot pin the server for ws's
// default 30 s close-timeout. Extracted so the onConnection method stays under its LOC ceiling.
function rejectOverCapSocket(ws: WsSocket): void {
  ws.on("error", () => {
    // NOOP — swallow protocol errors on a socket we are already rejecting.
  });
  ws.close(1013, "too many live-dictation sessions");
  const terminateTimer = setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // NOOP — terminate is best-effort; a socket already gone is fine.
    }
  }, LIVE_DICTATION_REJECT_TERMINATE_TIMEOUT_MS);
  ws.on("close", () => {
    clearTimeout(terminateTimer);
  });
}

type LiveSessionCreateMessage = VoiceSessionCreateMessage & {
  readonly transcriptionLanguage?: unknown;
};

interface LiveDictationSessionState {
  readonly sessionId: string;
  readonly providerLocality: VoiceCapabilityResolution["providerLocality"];
  readonly transcriptionLanguage: string | undefined;
  hostSeq: number;
  lastClientSeq: number;
}

type LiveDictationNegotiateFn = (
  offerSdp: string,
  signal: AbortSignal,
) => Promise<RealtimeNegotiationOutcome>;

class LiveDictationNegotiationError extends Error {
  constructor(readonly code: RealtimeNegotiationErrorKind) {
    super("live dictation negotiation failed");
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type HostMessagePayload = DistributiveOmit<
  VoiceControlMessage,
  "protocolVersion" | "sessionId" | "seq" | "direction"
>;

export interface VoiceLiveDictationPlaneDeps {
  readonly port: number;
  readonly handlerDeps: () => UiHandlerDeps;
}

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

function isTranscriptionLanguage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LANGUAGE_HINT_CHARS &&
    LANGUAGE_HINT.test(value)
  );
}

// Resolves the requested transcription language: `undefined` when none was requested, the
// validated hint when present and well-formed, or `null` when present but invalid.
export function resolveRequestedTranscriptionLanguage(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (isTranscriptionLanguage(value)) {
    return value;
  }
  return null;
}

function isLiveTranscribeUpgrade(req: IncomingMessage): boolean {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  return url.pathname === VOICE_LIVE_TRANSCRIBE_PATH;
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

interface LiveDictationProvider {
  readonly provider: ModelProviderConfig;
  readonly transcriptionModel: string;
}

function resolveRealtimeProvider(config: GatewayConfig): LiveDictationProvider | undefined {
  const modelId = selectRealtimeVoiceModel(config);
  if (modelId === undefined) return undefined;
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  const transcriptionModel = findConfiguredCapability(
    config,
    modelId,
  )?.realtimeTranscriptionModel?.trim();
  if (provider === undefined || !transcriptionModel) return undefined;
  return { provider, transcriptionModel };
}

function buildLiveDictationNegotiationRequest(
  provider: ModelProviderConfig,
  transcriptionModel: string,
  offerSdp: string,
  deps: UiHandlerDeps,
  signal: AbortSignal,
  transcriptionLanguage: string | undefined,
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
    sessionType: "transcription",
    transcriptionModel,
    ...(transcriptionLanguage !== undefined ? { transcriptionLanguage } : {}),
    offerSdp,
    signal,
    timeoutMs: Math.min(provider.timeoutMs, LIVE_DICTATION_NEGOTIATION_TIMEOUT_MS),
    ...(egress !== undefined ? { egress } : {}),
  };
}

function buildHostMessage(
  session: LiveDictationSessionState,
  payload: HostMessagePayload,
): VoiceControlMessage {
  const message = {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    seq: session.hostSeq,
    direction: "host-to-client" as const,
    ...payload,
  } as VoiceControlMessage;
  session.hostSeq += 1;
  return message;
}

function emit(
  ws: WsSocket,
  session: LiveDictationSessionState,
  redact: (value: unknown) => unknown,
  payload: HostMessagePayload,
): void {
  try {
    ws.send(JSON.stringify(redact(buildHostMessage(session, payload))));
  } catch {
    // The socket close/error handler owns lifecycle cleanup.
  }
}

function emitStandaloneError(
  ws: WsSocket,
  sessionId: string,
  code: VoiceProtocolErrorCode,
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

function readSessionCreateFrame(
  ws: WsSocket,
  raw: string,
  redact: (value: unknown) => unknown,
): LiveSessionCreateMessage | undefined {
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
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "unknown";
  if (parsed.chatContext !== undefined || parsed.persona !== undefined) {
    emitStandaloneError(ws, sessionId, "not-allowed-for-profile", redact);
    ws.close(1008, "dialogue fields are not accepted");
    return undefined;
  }
  return parsed as unknown as LiveSessionCreateMessage;
}

class VoiceLiveDictationConnection {
  private negotiation: AbortController | undefined;
  private closed = false;

  constructor(
    private readonly ws: WsSocket,
    private readonly session: LiveDictationSessionState,
    private readonly negotiate: LiveDictationNegotiateFn,
    private readonly redact: (value: unknown) => unknown,
    private readonly diagnostics: ServerDiagnosticSink | undefined,
    // Resolved ONCE at handleUpgrade (RB-6 / ADR-0173 D5): every diagnostic this connection emits
    // over its whole lifetime — however many negotiation attempts a client makes — is joinable to
    // the same id, instead of a fresh one per failure.
    private readonly correlationId: string,
  ) {}

  start(): void {
    emit(this.ws, this.session, this.redact, {
      kind: "session.created",
      profile: "full-realtime",
      controlTransport: "loopback-websocket",
      mediaTransport: "webrtc",
      negotiationMode: VOICE_PROFILE_NEGOTIATION_MODE["full-realtime"],
      ...(this.session.providerLocality !== undefined
        ? { providerLocality: this.session.providerLocality }
        : {}),
    });
    emit(this.ws, this.session, this.redact, {
      kind: "capability.offer",
      profile: "full-realtime",
      capabilities: {
        speechToText: true,
        speechOutput: false,
        realtimeVoice: true,
      },
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
      this.fail(
        isRecord(parsed) && parsed.protocolVersion !== VOICE_PROTOCOL_VERSION
          ? "unsupported-version"
          : "invalid-message",
      );
      return;
    }
    const message = parsed as VoiceControlMessage;
    if (message.seq <= this.session.lastClientSeq) {
      return;
    }
    this.session.lastClientSeq = Math.max(this.session.lastClientSeq, message.seq);
    switch (message.kind) {
      case "signal.sdp.offer":
        await this.handleOffer(message.sdp);
        return;
      case "control.cancel":
        this.cancelNegotiation();
        return;
      case "session.close":
        emit(this.ws, this.session, this.redact, {
          kind: "session.closed",
          reason: "client-request",
        });
        this.shutdown(1000, "session closed");
        return;
      default:
        emit(this.ws, this.session, this.redact, {
          kind: "error",
          code: "not-allowed-for-profile",
        });
        return;
    }
  }

  dispose(): void {
    this.closed = true;
    this.cancelNegotiation();
  }

  private cancelNegotiation(): void {
    this.negotiation?.abort();
    this.negotiation = undefined;
  }

  private async handleOffer(offerSdp: string): Promise<void> {
    if (typeof offerSdp !== "string" || offerSdp.length === 0 || !offerSdp.startsWith("v=")) {
      emit(this.ws, this.session, this.redact, { kind: "error", code: "invalid-message" });
      return;
    }
    if (Buffer.byteLength(offerSdp, "utf8") > MAX_OFFER_SDP_BYTES) {
      emit(this.ws, this.session, this.redact, { kind: "error", code: "invalid-message" });
      return;
    }
    emit(this.ws, this.session, this.redact, {
      kind: "media.track.state",
      track: "audio-in",
      state: "negotiating",
    });
    const controller = new AbortController();
    this.negotiation = controller;
    let outcome: RealtimeNegotiationOutcome;
    let thrown: unknown;
    try {
      outcome = await this.negotiate(offerSdp, controller.signal);
    } catch (error) {
      // Provider transports may reject instead of returning a typed failure. Preserve the thrown
      // class for the redacted diagnostic while normalizing its stable machine code below.
      thrown = error;
      outcome = { ok: false, kind: "transport" };
    }
    if (this.negotiation !== controller || this.closed) {
      return;
    }
    this.negotiation = undefined;
    if (!outcome.ok) {
      this.reportNegotiationFailure(outcome.kind, thrown);
      return;
    }
    emit(this.ws, this.session, this.redact, {
      kind: "signal.sdp.answer",
      sdp: outcome.value.answerSdp,
    });
    emit(this.ws, this.session, this.redact, {
      kind: "media.track.state",
      track: "audio-in",
      state: "live",
    });
  }

  private reportNegotiationFailure(kind: RealtimeNegotiationErrorKind, thrown: unknown): void {
    const correlationId = this.correlationId;
    const diagnostic = serverDiagnosticFromError({
      correlationId,
      operation: "voice.live-dictation.negotiate",
      source: "voice.live-dictation",
      error: thrown ?? new LiveDictationNegotiationError(kind),
      redact: (message: string): string => String(this.redact(message)),
    });
    emitServerDiagnostic(this.diagnostics, { ...diagnostic, code: kind });
    emit(this.ws, this.session, this.redact, {
      kind: "error",
      code: "negotiation-failed",
      correlationId,
    });
    emit(this.ws, this.session, this.redact, {
      kind: "media.track.state",
      track: "audio-in",
      state: "ended",
    });
  }

  private fail(code: "invalid-message" | "unsupported-version"): void {
    emit(this.ws, this.session, this.redact, { kind: "error", code });
    this.shutdown(1008, code);
  }

  private shutdown(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelNegotiation();
    try {
      this.ws.close(code, reason);
    } catch {
      // ignore — socket already gone
    }
  }
}

class VoiceLiveDictationPlaneImpl implements VoiceControlPlane {
  private readonly wss = new WebSocketServer({
    maxPayload: MAX_VOICE_CONTROL_FRAME_BYTES,
    noServer: true,
  });
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly planeDeps: VoiceLiveDictationPlaneDeps) {}

  handleUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): boolean {
    if (!isLiveTranscribeUpgrade(req)) {
      return false;
    }
    const deps = this.planeDeps.handlerDeps();
    if (
      typeof req.headers.origin !== "string" ||
      !isAllowedHost(req, this.planeDeps.port) ||
      !isVoiceRealtimeCapable(deps)
    ) {
      return false;
    }
    // Resolved ONCE per upgrade (RB-6 / ADR-0173 D5), not re-minted per diagnostic — every
    // negotiation failure this connection later reports carries the same id.
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
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      return;
    }
    const timer = setInterval(() => {
      sweepControlHeartbeat(this.wss.clients as Set<AliveControlSocket>);
    }, 15_000);
    timer.unref();
    this.heartbeat = timer;
  }

  private attachHeartbeat(ws: WsSocket): void {
    const live = ws as AliveControlSocket;
    live.isAlive = true;
    ws.on("pong", () => {
      live.isAlive = true;
    });
    this.startHeartbeat();
  }

  private buildNegotiate(
    deps: UiHandlerDeps,
    language: string | undefined,
  ): LiveDictationNegotiateFn {
    return async (offerSdp: string, signal: AbortSignal): Promise<RealtimeNegotiationOutcome> => {
      const config = currentGatewayConfig(deps);
      if (config === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const resolved = resolveRealtimeProvider(config);
      if (resolved === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const negotiate = deps.voiceRealtimeNegotiationRequest ?? requestRealtimeNegotiation;
      return negotiate(
        buildLiveDictationNegotiationRequest(
          resolved.provider,
          resolved.transcriptionModel,
          offerSdp,
          deps,
          signal,
          language,
        ),
      );
    };
  }

  private resolveSession(
    ws: WsSocket,
    deps: UiHandlerDeps,
    voice: VoiceCapabilityResolution,
    raw: string,
  ): LiveDictationSessionState | undefined {
    const parsed = readSessionCreateFrame(ws, raw, deps.redactor);
    if (parsed === undefined) return undefined;
    const sessionId = parsed.sessionId;
    if (!isSafeIdentifier(sessionId) || !isSafeIdentifier(parsed.idempotencyKey)) {
      ws.close(1008, "invalid session identifiers");
      return undefined;
    }
    if (
      parsed.requestedProfile !== "full-realtime" ||
      parsed.requestedProfile !== voice.profile ||
      parsed.negotiationMode !== VOICE_PROFILE_NEGOTIATION_MODE["full-realtime"]
    ) {
      emitStandaloneError(ws, sessionId, "not-allowed-for-profile", deps.redactor);
      ws.close(1008, "profile/negotiation mismatch");
      return undefined;
    }
    const language = resolveRequestedTranscriptionLanguage(parsed.transcriptionLanguage);
    if (language === null) {
      emitStandaloneError(ws, sessionId, "invalid-message", deps.redactor);
      ws.close(1008, "invalid transcription language");
      return undefined;
    }
    return {
      sessionId,
      providerLocality: voice.providerLocality,
      transcriptionLanguage: language,
      hostSeq: 0,
      lastClientSeq: 0,
    };
  }

  private onConnection(ws: WsSocket, deps: UiHandlerDeps, correlationId: string): void {
    this.attachHeartbeat(ws);
    // KEIKO-0342: enforce the concurrent-connection cap after handleUpgrade admitted the
    // socket. wss.clients already includes this new one by the time onConnection runs, so
    // liveDictationSessionExceedsCap rejects the excess. Match voice-realtime.ts's close(1013).
    if (liveDictationSessionExceedsCap(this.wss.clients.size)) {
      rejectOverCapSocket(ws);
      return;
    }
    const voice = resolveVoiceCapability(currentGatewayConfig(deps) ?? { providers: [] }, {
      policyDisabled: isVoiceDisabledByPolicy(deps.env),
    });
    let connection: VoiceLiveDictationConnection | undefined;

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (rawDataByteLength(data) > MAX_VOICE_CONTROL_FRAME_BYTES) {
        ws.close(1009, "control frame too large");
        return;
      }
      const raw = rawDataToString(data, isBinary);
      if (raw === undefined) {
        ws.close(1003, "binary frames are not permitted on the control plane");
        return;
      }
      if (connection !== undefined) {
        void connection.receive(raw);
        return;
      }
      const session = this.resolveSession(ws, deps, voice, raw);
      if (session === undefined) {
        return;
      }
      connection = new VoiceLiveDictationConnection(
        ws,
        session,
        this.buildNegotiate(deps, session.transcriptionLanguage),
        deps.redactor,
        deps.diagnostics,
        correlationId,
      );
      connection.start();
    });

    ws.on("close", () => {
      connection?.dispose();
    });

    ws.on("error", () => {
      ws.close(1011, "live dictation control plane error");
    });
  }
}

export function createVoiceLiveDictationPlane(
  planeDeps: VoiceLiveDictationPlaneDeps,
): VoiceControlPlane {
  return new VoiceLiveDictationPlaneImpl(planeDeps);
}
