// OpenAI / Azure-Foundry-compatible text-to-speech (speech synthesis) adapter. Builds on
// globalThis.fetch only (no SDK dependency), mirroring speech-to-text-adapter.ts. The assistant
// answer text is POSTed once as JSON to `${endpoint}/audio/speech` through the single `gatewayFetch`
// egress seam (ADR-0038), so synthesis traffic inherits the same corporate-proxy, custom-CA, timeout,
// and byte-cap behavior as every other productive model call (ADR-0058 D4). The synthesized audio is
// the mirror image of the dictation flow: dictation sends audio and receives text, synthesis sends
// text and receives audio.
//
// This module is provider-neutral: the JSON `/audio/speech` contract is the OpenAI-compatible surface
// the gateway already speaks for chat, embeddings, and transcription, and Azure Foundry's
// `keiko-tts` / `keiko-audio-output` deployment class is one valid provider locality among three
// (ADR-0058 D7, ADR-0095). Only the synthesized audio bytes and their content-type escape this
// module — the answer text leaves only as the synthesis request, and the raw provider body beyond the
// audio, the provider URL, and the credential never escape. Every failure is a coded, content-free
// `kind` so the BFF can map it to a deterministic, secret-free HTTP response.

import { apiKeyHeaderValue } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readBytesCapped,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import type { OutboundHttpEgressConfig } from "./types.js";
import type { ProviderEndpointStyle } from "./types.js";

// Closed set of response formats the OpenAI-compatible `/audio/speech` contract accepts, mapped to
// the audio container MIME type the provider returns. The adapter requests one of these and labels
// the result from this map when the provider omits a usable `content-type` header.
const RESPONSE_FORMAT_MIME = Object.freeze({
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
} as const);

export type SpeechResponseFormat = keyof typeof RESPONSE_FORMAT_MIME;

// The default cap on a single synthesized clip. A long assistant answer still fits comfortably (this
// is several minutes of compressed speech), and a provider that streams more than this is aborted so
// the browser-bound base64 envelope can never grow unbounded.
export const MAX_SPEECH_AUDIO_BYTES = 6_000_000;

export interface TextToSpeechRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly endpointStyle?: ProviderEndpointStyle;
  readonly apiVersion?: string;
  readonly modelId: string;
  // The assistant answer text to synthesize. Validated/bounded by the caller; never persisted here.
  readonly input: string;
  // The provider voice id (operator/provider config). Defaults to "alloy" — the OpenAI-compatible
  // default voice — when the caller does not pin one.
  readonly voice?: string;
  // Requested audio container. Defaults to mp3 (audio/mpeg) for the broadest browser playback.
  readonly responseFormat?: SpeechResponseFormat;
  // Optional playback speed multiplier the OpenAI contract accepts in [0.25, 4.0].
  readonly speed?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  // Ceiling on the synthesized audio size. Defaults to MAX_SPEECH_AUDIO_BYTES.
  readonly maxAudioBytes?: number;
}

export interface TextToSpeechSuccess {
  // The synthesized audio bytes. ArrayBuffer-backed so the BFF can base64-encode them directly.
  readonly audio: Uint8Array<ArrayBuffer>;
  // The audio container MIME type, taken from the provider `content-type` when present and otherwise
  // derived from the requested response format.
  readonly mimeType: string;
}

export type TextToSpeechOutcome =
  | { readonly ok: true; readonly value: TextToSpeechSuccess }
  | { readonly ok: false; readonly kind: TextToSpeechErrorKind };

export type TextToSpeechErrorKind =
  | "wrong-header"
  | "rate-limited"
  | "unsupported-model"
  | "payload-too-large"
  | "timeout"
  | "cancelled"
  | "transport"
  | "proxy-unreachable"
  | "proxy-auth-required"
  | "proxy-egress-failed"
  | "proxy-blocked-by-policy"
  | "tls-ca-failure"
  | "invalid-response"
  // A 2xx response that carried no audio bytes — treated as a provider error, never played as silence.
  | "empty-audio";

const OUTBOUND_TTS_KINDS: Record<OutboundHttpEgressErrorCode, TextToSpeechErrorKind> = {
  PROXY_UNREACHABLE: "proxy-unreachable",
  PROXY_AUTH_REQUIRED: "proxy-auth-required",
  PROXY_EGRESS_FAILED: "proxy-egress-failed",
  PROXY_BLOCKED_BY_POLICY: "proxy-blocked-by-policy",
  TLS_CA_FAILURE: "tls-ca-failure",
};

function joinOpenAiCompatibleUrl(endpoint: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/audio/speech`;
}

function joinAzureDeploymentUrl(endpoint: string, modelId: string, apiVersion: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/openai/deployments/${encodeURIComponent(
    modelId,
  )}/audio/speech?api-version=${encodeURIComponent(apiVersion)}`;
}

function joinUrl(request: TextToSpeechRequest): string {
  if (request.endpointStyle === "azure-openai-deployment") {
    return joinAzureDeploymentUrl(request.endpoint, request.modelId, request.apiVersion ?? "");
  }
  return joinOpenAiCompatibleUrl(request.endpoint);
}

function headerName(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) {
    return "authorization";
  }
  return name.toLowerCase();
}

function classifyStatus(status: number): TextToSpeechErrorKind | null {
  if (status === 401 || status === 403) return "wrong-header";
  if (status === 429) return "rate-limited";
  if (status === 404) return "unsupported-model";
  if (status === 413) return "payload-too-large";
  if (status >= 400) return "transport";
  return null;
}

// Distinguishes our internal-timeout abort from a caller-driven cancellation, mirroring the
// transcription adapter so callers can tell a user Stop apart from a hung provider.
function classifyDispatchError(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): TextToSpeechErrorKind {
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof OutboundHttpEgressError) return OUTBOUND_TTS_KINDS[error.code];
  if (timeoutSignal.aborted) return "timeout";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport";
}

interface BuiltRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
  readonly responseFormat: SpeechResponseFormat;
  readonly maxAudioBytes: number;
}

function buildRequest(request: TextToSpeechRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const responseFormat = request.responseFormat ?? "mp3";
  const payload: Record<string, unknown> = {
    model: request.modelId,
    input: request.input,
    voice: request.voice ?? "alloy",
    response_format: responseFormat,
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "audio/*",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 30_000);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  return {
    url: joinUrl(request),
    headers,
    body,
    signal,
    timeoutSignal,
    callerSignal: request.signal,
    responseFormat,
    maxAudioBytes: request.maxAudioBytes ?? MAX_SPEECH_AUDIO_BYTES,
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await readJsonCapped(response);
  } catch {
    // ignore — body discarded intentionally so a non-2xx provider body never escapes this module
  }
}

async function dispatch(
  built: BuiltRequest,
  fetchImpl: typeof fetch | undefined,
  egress: OutboundHttpEgressConfig | undefined,
): Promise<Response | TextToSpeechErrorKind> {
  try {
    return await gatewayFetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: built.body,
      signal: built.signal,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      ...(egress !== undefined ? { egress } : {}),
    });
  } catch (error) {
    return classifyDispatchError(error, built.timeoutSignal, built.callerSignal);
  }
}

// Normalizes the provider `content-type` to a bare audio MIME type, dropping any parameters (e.g.
// `; charset`). A provider that omits the header or returns a non-audio type falls back to the MIME
// derived from the requested response format, so the browser always receives a playable label.
function resolveMimeType(response: Response, responseFormat: SpeechResponseFormat): string {
  const raw = response.headers.get("content-type");
  if (raw !== null) {
    const base = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (base.startsWith("audio/")) {
      return base;
    }
  }
  return RESPONSE_FORMAT_MIME[responseFormat];
}

async function decodeSuccess(
  response: Response,
  built: BuiltRequest,
): Promise<TextToSpeechOutcome> {
  let audio: Uint8Array<ArrayBuffer>;
  try {
    audio = await readBytesCapped(response, built.maxAudioBytes);
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
  if (audio.byteLength === 0) {
    return { ok: false, kind: "empty-audio" };
  }
  return {
    ok: true,
    value: { audio, mimeType: resolveMimeType(response, built.responseFormat) },
  };
}

// Single round-trip speech synthesis. Provider-neutral, no retry (a spoken response is interactive;
// the caller decides whether to retry), and every failure is a coded, content-free `kind` so the BFF
// can map it to a deterministic, secret-free HTTP response (ADR-0095, AC4). On success the audio
// bytes are returned in memory for the BFF to base64-encode into its JSON envelope; this module never
// writes them to disk, a log, or any store ("no raw generated audio persistence").
export async function requestTextToSpeech(
  request: TextToSpeechRequest,
): Promise<TextToSpeechOutcome> {
  const built = buildRequest(request);
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    const kind = classifyStatus(dispatched.status) ?? "transport";
    await discardBody(dispatched);
    return { ok: false, kind };
  }
  return decodeSuccess(dispatched, built);
}
