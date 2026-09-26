// OpenAI / Azure-Foundry-compatible text-to-speech (speech synthesis) adapter. Builds on
// globalThis.fetch only (no SDK dependency), mirroring speech-to-text-adapter.ts. The assistant
// answer text is POSTed once as JSON to `${endpoint}/audio/speech` through the single `gatewayFetch`
// egress seam (ADR-0038), so synthesis traffic inherits the same corporate-proxy, custom-CA, timeout,
// and byte-cap behavior as every other productive model call (ADR-0100 D4). The synthesized audio is
// the mirror image of the dictation flow: dictation sends audio and receives text, synthesis sends
// text and receives audio.
//
// This module is provider-neutral: the JSON `/audio/speech` contract is the OpenAI-compatible surface
// the gateway already speaks for chat, embeddings, and transcription, and Azure Foundry's
// `keiko-tts` / `keiko-audio-output` deployment class is one valid provider locality among three
// (ADR-0100 D7, ADR-0095). Only the synthesized audio bytes and their content-type escape this
// module — the answer text leaves only as the synthesis request, and the raw provider body beyond the
// audio, the provider URL, and the credential never escape. Every failure is a coded, content-free
// `kind` so the BFF can map it to a deterministic, secret-free HTTP response.

import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { apiKeyHeaderValue, trimTrailingSlash } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readBytesCapped,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import {
  activityLogErrorKind,
  logCorrelationId,
  logEndpointHost,
  logModelId,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogSink,
} from "./observability.js";
import { GATEWAY_VOICE_TIMEOUT_FLOOR_MS } from "./resilience.js";
import type { OutboundHttpEgressConfig, ProviderEndpointStyle } from "./types.js";

const SPEECH_TTS_MIME_CORRECTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.tts.mime.corrected",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "text-to-speech-adapter.resolveBufferedMimeType",
  fields: {
    declaredMimeClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["mp3", "opus", "aac", "flac", "wav", "pcm", "other-audio"],
    },
    resolvedMimeClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["opus", "wav", "flac", "mp3"],
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["speech-mime-correction"],
  proofIds: ["speech.tts.mime.corrected.emitted-line"],
  releaseImpact: "patch",
});

const SPEECH_TTS_STREAM_PEEK_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.tts.stream.peek.failed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "text-to-speech-adapter.requestTextToSpeechStream",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["response-prefix"],
    },
    outcomeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "wrong-header",
        "rate-limited",
        "unsupported-model",
        "payload-too-large",
        "timeout",
        "cancelled",
        "transport",
        "proxy-unreachable",
        "proxy-auth-required",
        "proxy-egress-failed",
        "proxy-blocked-by-policy",
        "tls-ca-failure",
        "invalid-response",
        "empty-audio",
      ],
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["speech-stream-response"],
  proofIds: ["speech.tts.stream.peek.failed.emitted-line"],
  releaseImpact: "patch",
});

// THE ATTEMPT LINE for a synthesis call (review finding on PR #3602: the per-call deadline this
// module floors to `GATEWAY_VOICE_TIMEOUT_FLOOR_MS` had no activity-log line recording the bound
// actually applied). Body-free: no answer text, no audio, no credential — an endpoint digest, the
// model id, and the deadline this call ran under. Shared by the buffered and streaming entry
// points, both of which build their request through the same `buildRequest`.
const SPEECH_TTS_REQUEST_DISPATCH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.tts.request.dispatch",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "text-to-speech-adapter.logDispatch",
  fields: {
    endpointDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    // The floored deadline (#3591) this call actually runs under, so an operator can read the
    // applied bound instead of inferring it from the caller's configured value.
    timeoutMs: { type: "number", dataClass: "duration", required: false },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["speech-tts-request"],
  proofIds: ["speech.tts.request.dispatch.emitted-line"],
  releaseImpact: "patch",
});

function logDispatch(request: TextToSpeechRequest, timeoutMs: number): void {
  const log = withCorrelationId(resolveLogSink(request.log), request.correlationId);
  const correlationId = logCorrelationId(log);
  log.write(
    activityLogEvent(
      SPEECH_TTS_REQUEST_DISPATCH_OPERATION,
      { level: "info", ...(correlationId === undefined ? {} : { correlationId }) },
      {
        endpointDigest: sha256Hex(logEndpointHost(request.endpoint) ?? "invalid-endpoint"),
        modelId: logModelId(request.modelId),
        timeoutMs,
      },
    ),
  );
}

// THE COMPLETION LINE, paired with the attempt line above (review finding on PR #3602: the
// dispatch line alone left a timeout, a rate limit, and an invalid response indistinguishable
// from a still-running call). Emitted exactly once, from `requestTextToSpeech`'s single return
// path, so every exit of the dispatched buffered call — success and every failure kind — is
// covered without a call site able to forget it. Body-free like the dispatch line: no answer
// text, no audio, no credential — the same endpoint digest, model id, and applied deadline.
const SPEECH_TTS_REQUEST_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.tts.request.completed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "text-to-speech-adapter.logCompleted",
  fields: {
    endpointDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "failed"],
    },
    // Present on failure only — mirrors `TextToSpeechErrorKind` exactly, so this stays the one
    // place that vocabulary is registered.
    failureKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "wrong-header",
        "rate-limited",
        "unsupported-model",
        "payload-too-large",
        "timeout",
        "cancelled",
        "transport",
        "proxy-unreachable",
        "proxy-auth-required",
        "proxy-egress-failed",
        "proxy-blocked-by-policy",
        "tls-ca-failure",
        "invalid-response",
        "empty-audio",
      ],
    },
    // The floored deadline (#3591) this call ran under — the same applied bound the dispatch
    // line above carries, so a timeout outcome reads without joining back to the earlier line.
    timeoutMs: { type: "number", dataClass: "duration", required: false },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["speech-tts-request"],
  proofIds: ["speech.tts.request.completed.emitted-line"],
  releaseImpact: "patch",
});

// Closed map from this adapter's own failure vocabulary to the shared envelope `errorKind`
// taxonomy (mirrors `embeddingErrorKind` in openai-embedding-adapter.ts and the STT adapter's own
// `SPEECH_STT_FAILURE_ERROR_KIND`). The raw error object that produced a `kind` is gone by
// completion time — `classifyDispatchError` classifies and discards it — so the mapping runs on
// the closed `kind` string rather than re-deriving from an error. A `Record` keeps this
// exhaustive: a future `TextToSpeechErrorKind` member that is not listed here fails to typecheck
// instead of silently falling through to a default.
const SPEECH_TTS_FAILURE_ERROR_KIND: Readonly<Record<TextToSpeechErrorKind, ActivityLogErrorKind>> =
  {
    "wrong-header": "permission-denied",
    "rate-limited": "rate-limited",
    "unsupported-model": "invalid-request",
    "payload-too-large": "invalid-request",
    timeout: "timeout",
    cancelled: "cancelled",
    transport: "unavailable",
    "proxy-unreachable": "unavailable",
    "proxy-auth-required": "permission-denied",
    "proxy-egress-failed": "unavailable",
    "proxy-blocked-by-policy": "permission-denied",
    "tls-ca-failure": "unavailable",
    "invalid-response": "validation-failed",
    "empty-audio": "validation-failed",
  };

// THE COMPLETION LINE pairs with every dispatch line, whichever delivery shape the call took: the
// buffered clip and the opened stream both report the same outcome vocabulary (PR #3602 review — the
// streamed path once wrote a dispatch line and then nothing, so a timed-out or rate-limited stream
// read like a call still in flight).
function logCompleted(
  request: TextToSpeechRequest,
  timeoutMs: number,
  outcome: TextToSpeechOutcome | TextToSpeechStreamOutcome,
): void {
  const log = withCorrelationId(resolveLogSink(request.log), request.correlationId);
  const correlationId = logCorrelationId(log);
  const failureKind = outcome.ok ? undefined : outcome.kind;
  log.write(
    activityLogEvent(
      SPEECH_TTS_REQUEST_COMPLETED_OPERATION,
      {
        level: outcome.ok ? "info" : "warn",
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(failureKind === undefined
          ? {}
          : { errorKind: SPEECH_TTS_FAILURE_ERROR_KIND[failureKind] }),
      },
      {
        endpointDigest: sha256Hex(logEndpointHost(request.endpoint) ?? "invalid-endpoint"),
        modelId: logModelId(request.modelId),
        outcome: outcome.ok ? "succeeded" : "failed",
        ...(failureKind === undefined ? {} : { failureKind }),
        timeoutMs,
      },
    ),
  );
}

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
  // Optional for source compatibility with the published request surface. Productive calls still
  // require an explicit provider voice id: absent/blank fails closed before egress, because provider
  // names are not portable and the gateway never invents a universal default (ADR-0154).
  readonly voice?: string;
  // Requested audio container. Defaults to mp3 (audio/mpeg) for the broadest browser playback.
  readonly responseFormat?: SpeechResponseFormat;
  // Optional playback speed multiplier the OpenAI contract accepts in [0.25, 4.0].
  readonly speed?: number;
  // Optional provider-supported delivery guidance. Capability-gated by the caller because older
  // OpenAI-compatible synthesis models reject this field.
  readonly instructions?: string | undefined;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  // Ceiling on the synthesized audio size. Defaults to MAX_SPEECH_AUDIO_BYTES.
  readonly maxAudioBytes?: number;
  readonly log?: ModelGatewayLogSink | undefined;
  readonly correlationId?: string | undefined;
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
  const trimmed = trimTrailingSlash(endpoint);
  return `${trimmed}/audio/speech`;
}

function joinAzureDeploymentUrl(endpoint: string, modelId: string, apiVersion: string): string {
  const trimmed = trimTrailingSlash(endpoint);
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
  readonly log: ModelGatewayLogSink;
  // The floored deadline (#3591) this call actually runs under — carried alongside the abort
  // signals so the completion line can report the exact same applied bound as the dispatch line,
  // rather than recomputing the floor a second time.
  readonly timeoutMs: number;
}

type TextToSpeechRequestWithVoice = TextToSpeechRequest & { readonly voice: string };

function buildRequest(request: TextToSpeechRequestWithVoice): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const responseFormat = request.responseFormat ?? "mp3";
  const payload: Record<string, unknown> = {
    model: request.modelId,
    input: request.input,
    voice: request.voice,
    response_format: responseFormat,
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "audio/*",
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  // #3591: per-call floor — a slow gateway's voice call is not a broken one.
  const appliedTimeoutMs = Math.max(request.timeoutMs ?? 30_000, GATEWAY_VOICE_TIMEOUT_FLOOR_MS);
  const timeoutSignal = AbortSignal.timeout(appliedTimeoutMs);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  logDispatch(request, appliedTimeoutMs);
  return {
    url: joinUrl(request),
    headers,
    body,
    signal,
    timeoutSignal,
    callerSignal: request.signal,
    responseFormat,
    maxAudioBytes: request.maxAudioBytes ?? MAX_SPEECH_AUDIO_BYTES,
    log: withCorrelationId(resolveLogSink(request.log), request.correlationId),
    timeoutMs: appliedTimeoutMs,
  };
}

function hasExplicitVoice(request: TextToSpeechRequest): request is TextToSpeechRequestWithVoice {
  return typeof request.voice === "string" && request.voice.trim().length > 0;
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
const AUDIO_HEADER_PROBE_BYTES = 12;

function hasOggContainerSignature(audio: Uint8Array | undefined): boolean {
  return (
    audio !== undefined &&
    audio.byteLength >= 6 &&
    audio[0] === 0x4f &&
    audio[1] === 0x67 &&
    audio[2] === 0x67 &&
    audio[3] === 0x53 &&
    audio[4] === 0x00 &&
    ((audio[5] ?? 0xff) & 0xf8) === 0
  );
}

function hasWaveContainerSignature(audio: Uint8Array): boolean {
  return (
    audio.byteLength >= AUDIO_HEADER_PROBE_BYTES &&
    audio[0] === 0x52 &&
    audio[1] === 0x49 &&
    audio[2] === 0x46 &&
    audio[3] === 0x46 &&
    audio[8] === 0x57 &&
    audio[9] === 0x41 &&
    audio[10] === 0x56 &&
    audio[11] === 0x45
  );
}

function hasFlacContainerSignature(audio: Uint8Array): boolean {
  return (
    audio.byteLength >= 4 &&
    audio[0] === 0x66 &&
    audio[1] === 0x4c &&
    audio[2] === 0x61 &&
    audio[3] === 0x43
  );
}

function hasMp3Id3Signature(audio: Uint8Array): boolean {
  return audio.byteLength >= 3 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
}

function hasMp3FrameSignature(audio: Uint8Array): boolean {
  if (audio.byteLength < 4 || audio[0] !== 0xff) return false;
  const versionAndLayer = audio[1] ?? 0;
  const rateAndFrequency = audio[2] ?? 0;
  return (
    (versionAndLayer & 0xe0) === 0xe0 &&
    (versionAndLayer & 0x18) !== 0x08 &&
    (versionAndLayer & 0x06) !== 0 &&
    (rateAndFrequency & 0xf0) !== 0xf0 &&
    (rateAndFrequency & 0x0c) !== 0x0c
  );
}

type RecognizedAudioMime = "audio/ogg" | "audio/wav" | "audio/flac" | "audio/mpeg";

function signatureMimeType(audio: Uint8Array): RecognizedAudioMime | undefined {
  if (hasOggContainerSignature(audio)) return "audio/ogg";
  if (hasWaveContainerSignature(audio)) return "audio/wav";
  if (hasFlacContainerSignature(audio)) return "audio/flac";
  if (hasMp3Id3Signature(audio) || hasMp3FrameSignature(audio)) return "audio/mpeg";
  return undefined;
}

function recognizedMimeClass(mimeType: RecognizedAudioMime): "opus" | "wav" | "flac" | "mp3" {
  switch (mimeType) {
    case "audio/ogg":
      return "opus";
    case "audio/wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/mpeg":
      return "mp3";
  }
}

function declaredMimeType(response: Response, responseFormat: SpeechResponseFormat): string {
  const raw = response.headers.get("content-type");
  if (raw !== null) {
    const base = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (base.startsWith("audio/")) return base;
  }
  return RESPONSE_FORMAT_MIME[responseFormat];
}

function speechMimeClass(mimeType: string): SpeechResponseFormat | "other-audio" {
  for (const [format, candidate] of Object.entries(RESPONSE_FORMAT_MIME)) {
    if (candidate === mimeType) return format as SpeechResponseFormat;
  }
  return "other-audio";
}

function resolveBufferedMimeType(
  response: Response,
  responseFormat: SpeechResponseFormat,
  audio: Uint8Array,
  log: ModelGatewayLogSink,
): string {
  const declared = declaredMimeType(response, responseFormat);
  // Gateway implementations can ignore response_format or mislabel the returned container. A
  // recognized file signature takes precedence over a contradictory or inferred MIME; raw PCM has
  // no signature, so an unknown prefix keeps the declared type.
  const detected = signatureMimeType(audio);
  if (detected !== undefined && declared !== detected) {
    const correlationId = logCorrelationId(log);
    log.write(
      activityLogEvent(
        SPEECH_TTS_MIME_CORRECTED_OPERATION,
        { level: "info", ...(correlationId === undefined ? {} : { correlationId }) },
        {
          declaredMimeClass: speechMimeClass(declared),
          resolvedMimeClass: recognizedMimeClass(detected),
        },
      ),
    );
    return detected;
  }
  return declared;
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
    value: {
      audio,
      mimeType: resolveBufferedMimeType(response, built.responseFormat, audio, built.log),
    },
  };
}

// Dispatches the built request and decodes its outcome, without touching the activity log — the
// single caller below is the one place that pairs this result with THE COMPLETION LINE, so no
// exit of the dispatched call can be added here without also being logged.
async function dispatchAndDecode(
  built: BuiltRequest,
  request: TextToSpeechRequestWithVoice,
): Promise<TextToSpeechOutcome> {
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

// Single round-trip speech synthesis. Provider-neutral, no retry (a spoken response is interactive;
// the caller decides whether to retry), and every failure is a coded, content-free `kind` so the BFF
// can map it to a deterministic, secret-free HTTP response (ADR-0095, AC4). On success the audio
// bytes are returned in memory for the BFF to base64-encode into its JSON envelope; this module never
// writes them to disk, a log, or any store ("no raw generated audio persistence").
//
// A missing/blank voice fails closed before `buildRequest` ever runs (ADR-0154) — no dispatch line
// is written for it either, so THE COMPLETION LINE is deliberately not emitted here: it pairs with
// an attempt that was actually made, never with a call that never left this process.
export async function requestTextToSpeech(
  request: TextToSpeechRequest,
): Promise<TextToSpeechOutcome> {
  if (!hasExplicitVoice(request)) {
    return { ok: false, kind: "unsupported-model" };
  }
  const built = buildRequest(request);
  const outcome = await dispatchAndDecode(built, request);
  logCompleted(request, built.timeoutMs, outcome);
  return outcome;
}

export interface TextToSpeechStreamSuccess {
  // The synthesized audio bytes as they arrive from the provider, capped incrementally so a hostile or
  // misconfigured endpoint cannot stream an unbounded body. The BFF pipes these straight to the browser
  // (no whole-clip buffering, no base64 envelope) for start-on-first-chunk playback.
  readonly body: ReadableStream<Uint8Array>;
  readonly mimeType: string;
}

export type TextToSpeechStreamOutcome =
  | { readonly ok: true; readonly value: TextToSpeechStreamSuccess }
  | { readonly ok: false; readonly kind: TextToSpeechErrorKind };

// Wraps the provider body in a passthrough that aborts once `maxBytes` is exceeded, so the streamed
// response inherits the same size ceiling as the buffered path without ever holding the whole clip.
function boundBodyStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          controller.error(new Error("synthesized audio exceeded the size limit"));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason): void {
      void reader.cancel(reason);
    },
  });
}

function replayPeekedStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: readonly Uint8Array[],
  sourceDone: boolean,
): ReadableStream<Uint8Array> {
  let bufferedIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const chunk = buffered[bufferedIndex];
      if (chunk !== undefined) {
        bufferedIndex += 1;
        controller.enqueue(chunk);
        return;
      }
      if (sourceDone) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason): void {
      void reader.cancel(reason);
    },
  });
}

function copyPrefix(chunks: readonly Uint8Array[], byteLimit: number): Uint8Array {
  const prefix = new Uint8Array(byteLimit);
  let copied = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.byteLength, byteLimit - copied);
    prefix.set(chunk.subarray(0, count), copied);
    copied += count;
    if (copied === byteLimit) break;
  }
  return prefix.subarray(0, copied);
}

async function peekBodyStream(
  source: ReadableStream<Uint8Array>,
  byteLimit: number,
): Promise<{
  readonly prefix: Uint8Array;
  readonly body: ReadableStream<Uint8Array>;
  readonly exhausted: boolean;
  readonly peekedBytes: number;
}> {
  const reader = source.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let sourceDone = false;
  while (bufferedBytes < byteLimit) {
    const { done, value } = await reader.read();
    if (done) {
      sourceDone = true;
      break;
    }
    buffered.push(value);
    bufferedBytes += value.byteLength;
  }
  return {
    prefix: copyPrefix(buffered, Math.min(bufferedBytes, byteLimit)),
    body: replayPeekedStream(reader, buffered, sourceDone),
    exhausted: sourceDone,
    peekedBytes: bufferedBytes,
  };
}

// Streaming variant of requestTextToSpeech: returns the provider audio as a bounded byte stream instead
// of a fully-buffered clip, so the BFF can forward it chunk-by-chunk and the browser can start playback
// on the first chunk. Same provider contract, auth, egress seam, error coding, and size cap; only the
// delivery shape differs. Raw audio is never persisted here.
export async function requestTextToSpeechStream(
  request: TextToSpeechRequest,
): Promise<TextToSpeechStreamOutcome> {
  if (!hasExplicitVoice(request)) {
    return { ok: false, kind: "unsupported-model" };
  }
  const built = buildRequest(request);
  const outcome = await dispatchAndOpenStream(built, request);
  logCompleted(request, built.timeoutMs, outcome);
  return outcome;
}

// Dispatches the built request and opens the bounded audio stream, without touching the activity
// log — mirrors `dispatchAndDecode` for the buffered clip: the single caller above pairs this result
// with THE COMPLETION LINE, so no exit can be added here without also being logged. "succeeded"
// means the provider answered and the stream opened with audio in it; what happens to the bytes
// after that is the consumer's own evidence.
async function dispatchAndOpenStream(
  built: BuiltRequest,
  request: TextToSpeechRequestWithVoice,
): Promise<TextToSpeechStreamOutcome> {
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
  if (typeof dispatched === "string") {
    return { ok: false, kind: dispatched };
  }
  if (!dispatched.ok) {
    const kind = classifyStatus(dispatched.status) ?? "transport";
    await discardBody(dispatched);
    return { ok: false, kind };
  }
  if (dispatched.body === null) {
    return { ok: false, kind: "empty-audio" };
  }
  let peeked: Awaited<ReturnType<typeof peekBodyStream>>;
  try {
    peeked = await peekBodyStream(dispatched.body, AUDIO_HEADER_PROBE_BYTES);
  } catch (error) {
    const kind = classifyDispatchError(error, built.timeoutSignal, built.callerSignal);
    const correlationId = logCorrelationId(built.log);
    built.log.write(
      activityLogEvent(
        SPEECH_TTS_STREAM_PEEK_FAILED_OPERATION,
        {
          level: "error",
          errorKind: activityLogErrorKind(error),
          ...(correlationId === undefined ? {} : { correlationId }),
        },
        { phase: "response-prefix", outcomeKind: kind },
      ),
    );
    return { ok: false, kind };
  }
  if (peeked.exhausted && peeked.peekedBytes === 0) return { ok: false, kind: "empty-audio" };
  return {
    ok: true,
    value: {
      body: boundBodyStream(peeked.body, built.maxAudioBytes),
      mimeType: resolveBufferedMimeType(dispatched, built.responseFormat, peeked.prefix, built.log),
    },
  };
}
