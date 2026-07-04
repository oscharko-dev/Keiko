// BFF live dictation control plane (Keiko Voice P3). This is intentionally narrower than the
// dialogue control plane in voice-realtime.ts: it exists only to negotiate a transcription-only
// WebRTC session for browser microphone capture. It accepts no chat context, persona, tools,
// assistant-output configuration, binary media, provider credentials, provider URLs, raw events, or
// persisted transcripts.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import {
  DEFAULT_REALTIME_STREAMING_TRANSCRIPTION_MODEL,
  DEFAULT_REALTIME_TRANSCRIPTION_DELAY,
  requestRealtimeNegotiation,
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  type GatewayConfig,
  type ModelProviderConfig,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationRequest,
  type RealtimeTranscriptionDelay,
  type VoiceCapabilityResolution,
} from "@oscharko-dev/keiko-model-gateway";
import {
  VOICE_PROFILE_NEGOTIATION_MODE,
  VOICE_PROTOCOL_VERSION,
  validateVoiceControlMessage,
  type VoiceControlMessage,
  type VoiceProtocolErrorCode,
  type VoiceSessionCreateMessage,
} from "@oscharko-dev/keiko-contracts";
import { isAllowedHost } from "./host-check.js";
import { currentGatewayConfig, currentGatewayEgressConfig, type UiHandlerDeps } from "./deps.js";
import { isVoiceDisabledByPolicy, isVoiceRealtimeCapable } from "./read-handlers.js";
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

type LiveSessionCreateMessage = VoiceSessionCreateMessage & {
  readonly transcriptionLanguage?: unknown;
};

interface LiveDictationSessionState {
  readonly sessionId: string;
  readonly providerLocality: VoiceCapabilityResolution["providerLocality"];
  readonly realtimeToolCalling: boolean | undefined;
  readonly transcriptionLanguage: string | undefined;
  hostSeq: number;
  lastClientSeq: number;
}

type LiveDictationNegotiateFn = (
  offerSdp: string,
  signal: AbortSignal,
) => Promise<RealtimeNegotiationOutcome>;

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

function resolveRealtimeProvider(config: GatewayConfig): ModelProviderConfig | undefined {
  const modelId = selectRealtimeVoiceModel(config);
  if (modelId === undefined) {
    return undefined;
  }
  return config.providers.find((provider) => provider.modelId === modelId);
}

function buildLiveDictationNegotiationRequest(
  provider: ModelProviderConfig,
  offerSdp: string,
  deps: UiHandlerDeps,
  signal: AbortSignal,
  transcriptionLanguage: string | undefined,
  transcriptionDelay: RealtimeTranscriptionDelay = DEFAULT_REALTIME_TRANSCRIPTION_DELAY,
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
    transcriptionModel: DEFAULT_REALTIME_STREAMING_TRANSCRIPTION_MODEL,
    transcriptionDelay,
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
        ...(this.session.realtimeToolCalling === true ? { realtimeToolCalling: true } : {}),
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
    try {
      outcome = await this.negotiate(offerSdp, controller.signal);
    } catch {
      outcome = { ok: false, kind: "transport" };
    }
    if (this.negotiation !== controller || this.closed) {
      return;
    }
    this.negotiation = undefined;
    if (!outcome.ok) {
      emit(this.ws, this.session, this.redact, { kind: "error", code: "negotiation-failed" });
      emit(this.ws, this.session, this.redact, {
        kind: "media.track.state",
        track: "audio-in",
        state: "ended",
      });
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
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      this.onConnection(ws, deps);
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
      const provider = resolveRealtimeProvider(config);
      if (provider === undefined) {
        return { ok: false, kind: "unsupported-model" };
      }
      const negotiate = deps.voiceRealtimeNegotiationRequest ?? requestRealtimeNegotiation;
      return negotiate(
        buildLiveDictationNegotiationRequest(provider, offerSdp, deps, signal, language),
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
    const language =
      parsed.transcriptionLanguage === undefined
        ? undefined
        : isTranscriptionLanguage(parsed.transcriptionLanguage)
          ? parsed.transcriptionLanguage
          : null;
    if (language === null) {
      emitStandaloneError(ws, sessionId, "invalid-message", deps.redactor);
      ws.close(1008, "invalid transcription language");
      return undefined;
    }
    return {
      sessionId,
      providerLocality: voice.providerLocality,
      realtimeToolCalling: voice.capabilities.realtimeToolCalling,
      transcriptionLanguage: language,
      hostSeq: 0,
      lastClientSeq: 0,
    };
  }

  private onConnection(ws: WsSocket, deps: UiHandlerDeps): void {
    this.attachHeartbeat(ws);
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
