// OpenAI / Azure-Foundry-compatible realtime-voice SDP-negotiation adapter (Epic #491, Issue #497,
// ADR-0058 D3/D6). Implements the preferred proxied-SDP negotiation mode of the #496 protocol
// (`VOICE_PROFILE_NEGOTIATION_MODE["full-realtime"] = "proxied-sdp"`): the Keiko host performs the
// browser↔provider SDP exchange so the long-lived provider credential never reaches the browser
// (AC2). The browser's opaque SDP offer is POSTed once to `${endpoint}/realtime/calls` as
// `application/sdp` through the single `gatewayFetch` egress seam (ADR-0038), so realtime voice
// traffic inherits the same corporate-proxy, custom-CA, timeout, and byte-cap behavior as every
// other productive model call (ADR-0058 D4); the provider's SDP answer is returned to the caller.
//
// The endpoint contract is the OpenAI Realtime WebRTC SDP-exchange surface
// (`POST /v1/realtime/calls`, `Content-Type: application/sdp`, `Authorization: Bearer <key>`), which
// explicitly supports a server-side (proxied) request with the standard provider key. It is
// provider-neutral exactly as the speech-to-text adapter's `/audio/transcriptions` surface is:
// Azure Foundry and customer-hosted controlled-network deployments reach their own realtime endpoint
// through the configured provider base URL (ADR-0058 D7), never a hardcoded host. Only the opaque SDP
// answer escapes this module — the SDP offer, the raw provider body, the provider URL, and the
// credential never do. SDP payloads are opaque, `secret-bearing` strings to this module
// (voice-protocol.ts redaction class): they are never logged or persisted here.

import { apiKeyHeaderValue } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import type { OutboundHttpEgressConfig } from "./types.js";
import type { RealtimeAuthMode } from "./types.js";

// SDP offers/answers are small (a single audio m-line plus ICE/DTLS metadata is typically a few KB);
// cap the negotiated answer well below the 10 MB gateway default so a hostile or misconfigured
// endpoint cannot stream an unbounded body into the loopback control plane.
export const MAX_SDP_BYTES = 256_000;

// The voice ids the OpenAI/Azure-Foundry realtime models accept. This set is NARROWER than the
// text-to-speech voice set (TTS also offers e.g. 'nova'/'onyx'); a persona→voice mapping authored for
// TTS can therefore carry a voice the realtime model rejects — verified against the live endpoint,
// where realtime `voice: "nova"` returns HTTP 400 and would break session creation. `resolveRealtimeVoice`
// guards against that by falling back to a safe default for any non-realtime voice id.
export const REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;
export type RealtimeVoice = (typeof REALTIME_VOICES)[number];
export const DEFAULT_REALTIME_VOICE: RealtimeVoice = "alloy";

export function isRealtimeVoice(voiceId: string | undefined): voiceId is RealtimeVoice {
  return voiceId !== undefined && (REALTIME_VOICES as readonly string[]).includes(voiceId);
}

// Returns the requested voice when it is realtime-valid, otherwise the safe default — so an operator
// mapping that reuses a TTS-only voice id for the realtime model never breaks the session.
export function resolveRealtimeVoice(voiceId: string | undefined): RealtimeVoice {
  return isRealtimeVoice(voiceId) ? voiceId : DEFAULT_REALTIME_VOICE;
}

export interface RealtimeNegotiationRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly realtimeAuthMode?: RealtimeAuthMode;
  readonly modelId: string;
  // Grounded session configuration applied server-side at ephemeral-session mint time so the realtime
  // assistant speaks as Keiko (not the provider's default demo persona) and emits user-utterance
  // transcripts. These never reach the browser as anything other than the session's own behavior.
  //   - instructions: the Keiko system persona (same source the text chat uses), so spoken and written
  //     Keiko cannot diverge.
  //   - voiceId: a provider realtime-VALID voice id resolved from the configured persona mapping.
  //   - transcriptionModel: enables input-audio transcription so the chat transcript can capture what
  //     the user said by voice.
  // Applied only in ephemeral-session mode (the path that mints the session config). Omitted fields
  // fall back to provider defaults.
  readonly instructions?: string;
  readonly voiceId?: string;
  readonly transcriptionModel?: string;
  readonly tools?: readonly RealtimeSessionTool[] | undefined;
  readonly toolChoice?: RealtimeSessionToolChoice | undefined;
  // The browser's opaque SDP offer (already validated for length by the caller). Never persisted or
  // logged by this module; forwarded verbatim to the provider's realtime SDP-exchange endpoint.
  readonly offerSdp: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
}

export interface RealtimeFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters: Record<string, unknown>;
}

export type RealtimeSessionTool = RealtimeFunctionTool;

export type RealtimeSessionToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly name: string };

export interface RealtimeNegotiationSuccess {
  // The provider's opaque SDP answer. `secret-bearing` per the protocol (may carry private ICE
  // candidates / DTLS fingerprints) — returned to the live negotiation but never logged or persisted.
  readonly answerSdp: string;
}

export type RealtimeNegotiationOutcome =
  | { readonly ok: true; readonly value: RealtimeNegotiationSuccess }
  | { readonly ok: false; readonly kind: RealtimeNegotiationErrorKind };

export type RealtimeNegotiationErrorKind =
  | "wrong-header"
  | "rate-limited"
  | "unsupported-model"
  | "payload-too-large"
  | "negotiation-failed"
  | "timeout"
  | "cancelled"
  | "transport"
  | "proxy-unreachable"
  | "proxy-auth-required"
  | "proxy-egress-failed"
  | "proxy-blocked-by-policy"
  | "tls-ca-failure"
  | "invalid-response";

const OUTBOUND_NEGOTIATION_KINDS: Record<
  OutboundHttpEgressErrorCode,
  RealtimeNegotiationErrorKind
> = {
  PROXY_UNREACHABLE: "proxy-unreachable",
  PROXY_AUTH_REQUIRED: "proxy-auth-required",
  PROXY_EGRESS_FAILED: "proxy-egress-failed",
  PROXY_BLOCKED_BY_POLICY: "proxy-blocked-by-policy",
  TLS_CA_FAILURE: "tls-ca-failure",
};

function headerName(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) {
    return "authorization";
  }
  return name.toLowerCase();
}

function joinUrl(endpoint: string, modelId: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/realtime/calls?model=${encodeURIComponent(modelId)}`;
}

function joinClientSecretsUrl(endpoint: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/realtime/client_secrets`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyStatus(status: number): RealtimeNegotiationErrorKind | null {
  if (status === 401 || status === 403) return "wrong-header";
  if (status === 429) return "rate-limited";
  if (status === 404) return "unsupported-model";
  if (status === 413) return "payload-too-large";
  // A 400/422 from the SDP-exchange endpoint is a negotiation failure (malformed/incompatible offer),
  // distinct from a generic transport error so the BFF can map it to the protocol `negotiation-failed`.
  if (status === 400 || status === 422) return "negotiation-failed";
  if (status >= 400) return "transport";
  return null;
}

// Distinguishes our internal-timeout abort from a caller-driven cancellation, mirroring the
// speech-to-text adapter so the BFF can tell a user-cancelled session apart from a hung provider.
function classifyDispatchError(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): RealtimeNegotiationErrorKind {
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof OutboundHttpEgressError) return OUTBOUND_NEGOTIATION_KINDS[error.code];
  if (timeoutSignal.aborted) return "timeout";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport";
}

interface BuiltRequest {
  readonly url: string;
  readonly clientSecretsUrl: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
}

function buildRequest(request: RealtimeNegotiationRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const headers: Record<string, string> = {
    "content-type": "application/sdp",
    // Set explicitly so the proxy/CA-fallback egress path sends a fixed-length body. The Fetch spec
    // treats content-length as a forbidden header on the direct path, where undici computes it.
    "content-length": String(Buffer.byteLength(request.offerSdp, "utf8")),
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 30_000);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  return {
    url: joinUrl(request.endpoint, request.modelId),
    clientSecretsUrl: joinClientSecretsUrl(request.endpoint),
    headers,
    body: request.offerSdp,
    signal,
    timeoutSignal,
    callerSignal: request.signal,
  };
}

// Reads the SDP-answer body capped at MAX_SDP_BYTES. The provider returns `application/sdp` text, not
// JSON, so this mirrors `readJsonCapped` minus the parse — bounding the body so a hostile endpoint
// cannot stream an unbounded answer into the loopback control plane.
async function readSdpCapped(response: Response): Promise<string | null> {
  if (response.body === null) {
    const text = await response.text();
    return text.length === 0 ? null : text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SDP_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  const text = parts.join("");
  return text.length === 0 ? null : text;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore — body discarded intentionally so a non-2xx provider body never escapes this module
  }
}

async function dispatch(
  built: BuiltRequest,
  fetchImpl: typeof fetch | undefined,
  egress: OutboundHttpEgressConfig | undefined,
): Promise<Response | RealtimeNegotiationErrorKind> {
  try {
    return await gatewayFetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: built.body,
      signal: built.signal,
      maxResponseBytes: MAX_SDP_BYTES,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      ...(egress !== undefined ? { egress } : {}),
    });
  } catch (error) {
    return classifyDispatchError(error, built.timeoutSignal, built.callerSignal);
  }
}

// Builds the ephemeral client-secret request body. The session-config schema is the GA nested
// `audio.{input,output}` shape (verified against the live Azure Foundry realtime endpoint: the older
// top-level `voice`/`input_audio_transcription` shape is rejected with HTTP 500). `instructions`,
// `audio.output.voice`, and `audio.input.transcription` are only included when supplied, so an
// unconfigured deployment still mints a valid (provider-default) session.
function buildClientSecretBody(request: RealtimeNegotiationRequest): string {
  const session: Record<string, unknown> = {
    type: "realtime",
    model: request.modelId,
    output_modalities: ["audio"],
  };
  if (request.instructions !== undefined && request.instructions.length > 0) {
    session.instructions = request.instructions;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    session.tools = request.tools;
    session.tool_choice = request.toolChoice ?? "auto";
  }
  const audioInput: Record<string, unknown> = {
    // server_vad gives provider-side end-of-turn detection and barge-in (interrupt_response) for the
    // realtime media plane without any client polling.
    turn_detection: { type: "server_vad" },
  };
  if (request.transcriptionModel !== undefined && request.transcriptionModel.length > 0) {
    audioInput.transcription = { model: request.transcriptionModel };
  }
  const audio: Record<string, unknown> = { input: audioInput };
  if (request.voiceId !== undefined && request.voiceId.length > 0) {
    audio.output = { voice: request.voiceId };
  }
  session.audio = audio;
  return JSON.stringify({ session });
}

function extractEphemeralToken(parsed: unknown): string | undefined {
  if (isRecord(parsed) && typeof parsed.value === "string" && parsed.value.length > 0) {
    return parsed.value;
  }
  if (
    isRecord(parsed) &&
    isRecord(parsed.client_secret) &&
    typeof parsed.client_secret.value === "string" &&
    parsed.client_secret.value.length > 0
  ) {
    return parsed.client_secret.value;
  }
  return undefined;
}

async function requestEphemeralToken(
  built: BuiltRequest,
  request: RealtimeNegotiationRequest,
): Promise<
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly kind: RealtimeNegotiationErrorKind }
> {
  const name = headerName(request.apiKeyHeaderName);
  try {
    const response = await gatewayFetch(built.clientSecretsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [name]: apiKeyHeaderValue(name, request.apiKey),
      },
      body: buildClientSecretBody(request),
      signal: built.signal,
      maxResponseBytes: MAX_SDP_BYTES,
      ...(request.fetchImpl !== undefined ? { fetchImpl: request.fetchImpl } : {}),
      ...(request.egress !== undefined ? { egress: request.egress } : {}),
    });
    if (!response.ok) {
      const kind = classifyStatus(response.status) ?? "transport";
      await discardBody(response);
      return { ok: false, kind };
    }
    const token = extractEphemeralToken(await readJsonCapped(response, MAX_SDP_BYTES));
    return token === undefined ? { ok: false, kind: "invalid-response" } : { ok: true, token };
  } catch (error) {
    return {
      ok: false,
      kind: classifyDispatchError(error, built.timeoutSignal, built.callerSignal),
    };
  }
}

async function dispatchWithEphemeralToken(
  built: BuiltRequest,
  request: RealtimeNegotiationRequest,
): Promise<Response | RealtimeNegotiationErrorKind> {
  const tokenResult = await requestEphemeralToken(built, request);
  if (!tokenResult.ok) {
    return tokenResult.kind;
  }
  try {
    return await gatewayFetch(built.url, {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        "content-length": String(Buffer.byteLength(built.body, "utf8")),
        authorization: `Bearer ${tokenResult.token}`,
      },
      body: built.body,
      signal: built.signal,
      maxResponseBytes: MAX_SDP_BYTES,
      ...(request.fetchImpl !== undefined ? { fetchImpl: request.fetchImpl } : {}),
      ...(request.egress !== undefined ? { egress: request.egress } : {}),
    });
  } catch (error) {
    return classifyDispatchError(error, built.timeoutSignal, built.callerSignal);
  }
}

async function decodeSuccess(response: Response): Promise<RealtimeNegotiationOutcome> {
  let answerSdp: string | null;
  try {
    answerSdp = await readSdpCapped(response);
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
  // A well-formed SDP answer begins with the version line "v=0"; reject anything else so a provider
  // error page or empty body never reaches the browser as a fake answer.
  if (answerSdp?.startsWith("v=") !== true) {
    return { ok: false, kind: "invalid-response" };
  }
  return { ok: true, value: { answerSdp } };
}

// Single round-trip proxied SDP negotiation. Provider-neutral, no retry (a realtime session is
// interactive; the caller decides whether to retry), and every failure is a coded, content-free
// `kind` so the BFF can map it to a deterministic, secret-free protocol error (ADR-0058 D6, AC2/AC6).
export async function requestRealtimeNegotiation(
  request: RealtimeNegotiationRequest,
): Promise<RealtimeNegotiationOutcome> {
  const built = buildRequest(request);
  const dispatched =
    request.realtimeAuthMode === "ephemeral-session"
      ? await dispatchWithEphemeralToken(built, request)
      : await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    const kind = classifyStatus(dispatched.status) ?? "transport";
    await discardBody(dispatched);
    return { ok: false, kind };
  }
  return decodeSuccess(dispatched);
}
