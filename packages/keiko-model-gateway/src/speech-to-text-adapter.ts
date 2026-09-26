// OpenAI / Azure-Foundry-compatible speech-to-text (transcription) adapter. Builds on
// globalThis.fetch only (no SDK dependency), mirroring openai-embedding-adapter.ts. The audio
// buffer is POSTed once as multipart/form-data to `${endpoint}/audio/transcriptions` through the
// single `gatewayFetch` egress seam (ADR-0038), so voice traffic inherits the same corporate-proxy,
// custom-CA, timeout, and byte-cap behavior as every other productive model call (ADR-0100 D4).
//
// This module is provider-neutral: the multipart `/audio/transcriptions` contract is the
// OpenAI-compatible surface the gateway already speaks for chat and embeddings, and Azure Foundry's
// `keiko-stt` deployment class is one valid provider locality among three (ADR-0100 D7). Only the
// transcript text and optional content-free metadata escape this module — the audio buffer, the raw
// provider body, the provider URL, and the credential never do.

import { randomUUID } from "node:crypto";
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
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import {
  logCorrelationId,
  logEndpointHost,
  logModelId,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogSink,
} from "./observability.js";
import { providerSpeechLanguage } from "./provider-language.js";
import { GATEWAY_VOICE_TIMEOUT_FLOOR_MS } from "./resilience.js";
import type { OutboundHttpEgressConfig, ProviderEndpointStyle } from "./types.js";

const SPEECH_STT_LANGUAGE_NORMALIZED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.stt.language.normalized",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "speech-to-text-adapter.logLanguageNormalization",
  fields: {
    declaredSubtagCount: { type: "integer", dataClass: "count", required: true },
    resolvedSubtagCount: { type: "integer", dataClass: "count", required: true },
    primaryLanguagePreserved: {
      type: "boolean",
      dataClass: "closed-enum",
      required: true,
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["speech-language-normalization"],
  proofIds: ["speech.stt.language.normalized.emitted-line"],
  releaseImpact: "patch",
});

// THE ATTEMPT LINE for a transcription call (review finding on PR #3602: the per-call deadline
// this module floors to `GATEWAY_VOICE_TIMEOUT_FLOOR_MS` had no activity-log line recording the
// bound actually applied). Body-free: no audio, no transcript, no credential — an endpoint digest,
// the model id, and the deadline this call ran under.
const SPEECH_STT_REQUEST_DISPATCH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.stt.request.dispatch",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "speech-to-text-adapter.logDispatch",
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
  failureClasses: ["speech-stt-request"],
  proofIds: ["speech.stt.request.dispatch.emitted-line"],
  releaseImpact: "patch",
});

function logDispatch(request: SpeechToTextRequest, timeoutMs: number): void {
  const log = withCorrelationId(resolveLogSink(request.log), request.correlationId);
  const correlationId = logCorrelationId(log);
  log.write(
    activityLogEvent(
      SPEECH_STT_REQUEST_DISPATCH_OPERATION,
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
// from a still-running call — `requestSpeechToText` returning `{ok:false, kind:"timeout"}` never
// reached the log). Emitted exactly once, from `requestSpeechToText`'s single return path, so
// every exit of the dispatched call — success and every failure kind — is covered without a
// call site able to forget it. Body-free like the dispatch line: no transcript, no audio, no
// credential — the same endpoint digest, model id, and applied deadline.
const SPEECH_STT_REQUEST_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "speech.stt.request.completed",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "speech-to-text-adapter.logCompleted",
  fields: {
    endpointDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    modelId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 256 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "failed"],
    },
    // Present on failure only — mirrors `SpeechToTextErrorKind` exactly, so this stays the one
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
      ],
    },
    // The floored deadline (#3591) this call ran under — the same applied bound the dispatch
    // line above carries, so a timeout outcome reads without joining back to the earlier line.
    timeoutMs: { type: "number", dataClass: "duration", required: false },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["speech-stt-request"],
  proofIds: ["speech.stt.request.completed.emitted-line"],
  releaseImpact: "patch",
});

// Closed map from this adapter's own failure vocabulary to the shared envelope `errorKind`
// taxonomy (mirrors `embeddingErrorKind` in openai-embedding-adapter.ts). The raw error object
// that produced a `kind` is gone by completion time — `classifyDispatchError` classifies and
// discards it — so the mapping runs on the closed `kind` string rather than re-deriving from an
// error. A `Record` keeps this exhaustive: a future `SpeechToTextErrorKind` member that is not
// listed here fails to typecheck instead of silently falling through to a default.
const SPEECH_STT_FAILURE_ERROR_KIND: Readonly<Record<SpeechToTextErrorKind, ActivityLogErrorKind>> =
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
  };

function logCompleted(
  request: SpeechToTextRequest,
  timeoutMs: number,
  outcome: SpeechToTextOutcome,
): void {
  const log = withCorrelationId(resolveLogSink(request.log), request.correlationId);
  const correlationId = logCorrelationId(log);
  const failureKind = outcome.ok ? undefined : outcome.kind;
  log.write(
    activityLogEvent(
      SPEECH_STT_REQUEST_COMPLETED_OPERATION,
      {
        level: outcome.ok ? "info" : "warn",
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(failureKind === undefined
          ? {}
          : { errorKind: SPEECH_STT_FAILURE_ERROR_KIND[failureKind] }),
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

export interface SpeechToTextRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly endpointStyle?: ProviderEndpointStyle;
  readonly apiVersion?: string;
  readonly modelId: string;
  // Raw audio bytes (already decoded from the loopback request). Never persisted by this module.
  readonly audio: Uint8Array;
  // The audio container MIME type (validated by the caller against a closed allowlist).
  readonly mimeType: string;
  // Optional BCP-47-ish language hint (validated by the caller); omitted lets the provider detect.
  readonly language?: string;
  // Optional short domain-keyword prompt (validated + length-bounded by the caller). Biases the model
  // toward correct spelling of in-domain terms (product names, technical identifiers). Never persisted.
  readonly prompt?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  readonly log?: ModelGatewayLogSink | undefined;
  readonly correlationId?: string | undefined;
}

export interface SpeechToTextSuccess {
  // The transcribed text. An empty string is a valid result (e.g. silence) and is preserved.
  readonly transcript: string;
  // Provider-reported confidence in [0,1] when available; never synthesized.
  readonly confidence?: number;
  // Provider-detected language when available.
  readonly language?: string;
  // Provider-reported audio duration in milliseconds when available.
  readonly durationMs?: number;
}

export type SpeechToTextOutcome =
  | { readonly ok: true; readonly value: SpeechToTextSuccess }
  | { readonly ok: false; readonly kind: SpeechToTextErrorKind };

export type SpeechToTextErrorKind =
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
  | "invalid-response";

const OUTBOUND_STT_KINDS: Record<OutboundHttpEgressErrorCode, SpeechToTextErrorKind> = {
  PROXY_UNREACHABLE: "proxy-unreachable",
  PROXY_AUTH_REQUIRED: "proxy-auth-required",
  PROXY_EGRESS_FAILED: "proxy-egress-failed",
  PROXY_BLOCKED_BY_POLICY: "proxy-blocked-by-policy",
  TLS_CA_FAILURE: "tls-ca-failure",
};

// Closed map of recognized audio container MIME types to a filename extension for the multipart
// `file` part. Any other MIME type is rejected by the caller before reaching this adapter, so the
// `bin` fallback is defensive only.
const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinOpenAiCompatibleUrl(endpoint: string): string {
  const trimmed = trimTrailingSlash(endpoint);
  return `${trimmed}/audio/transcriptions`;
}

function joinAzureDeploymentUrl(endpoint: string, modelId: string, apiVersion: string): string {
  const trimmed = trimTrailingSlash(endpoint);
  return `${trimmed}/openai/deployments/${encodeURIComponent(
    modelId,
  )}/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`;
}

function joinUrl(request: SpeechToTextRequest): string {
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

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
}

// The loopback contract accepts a BCP-47 language hint because browsers and callers naturally
// expose values such as `de-DE`. OpenAI-compatible transcription endpoints accept the ISO-639-1
// primary language subtag instead, so keep the public contract useful while sending `de` upstream.
function logLanguageNormalization(request: SpeechToTextRequest): void {
  if (request.language === undefined) return;
  const normalized = providerSpeechLanguage(request.language);
  if (normalized === request.language) return;
  const log = withCorrelationId(resolveLogSink(request.log), request.correlationId);
  const correlationId = logCorrelationId(log);
  log.write(
    activityLogEvent(
      SPEECH_STT_LANGUAGE_NORMALIZED_OPERATION,
      { level: "info", ...(correlationId === undefined ? {} : { correlationId }) },
      {
        declaredSubtagCount: request.language.split("-").length,
        resolvedSubtagCount: normalized.split("-").length,
        primaryLanguagePreserved: true,
      },
    ),
  );
}

// Strip the quote that delimits a field name plus CR/LF and every other C0/C1 control, bidirectional,
// and zero-width code point, so a value can never break out of (or visually disguise) its multipart
// field header. The BFF caller already constrains MIME type and language to closed/anchored
// allowlists and modelId is operator config, so this is a defense-in-depth guard that holds even if a
// future caller relaxes field validation (mirrors the editor evidence scrubber's character class).
function sanitizeFieldValue(value: string): string {
  /* eslint-disable no-control-regex */
  return value.replace(
    /["\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g,
    "",
  );
  /* eslint-enable no-control-regex */
}

function classifyStatus(status: number): SpeechToTextErrorKind | null {
  if (status === 401 || status === 403) return "wrong-header";
  if (status === 429) return "rate-limited";
  if (status === 404) return "unsupported-model";
  if (status === 413) return "payload-too-large";
  if (status >= 400) return "transport";
  return null;
}

// Distinguishes our internal-timeout abort from a caller-driven cancellation, mirroring the
// embedding adapter so callers can tell a user Cancel apart from a hung provider. Exported for
// tests (#3591): the real internal timeout is now floored to GATEWAY_VOICE_TIMEOUT_FLOOR_MS, too
// long to fire for real inside a unit test, so the `timeoutSignal.aborted` branch is proven
// directly against a manually-aborted signal instead.
export function classifyDispatchError(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): SpeechToTextErrorKind {
  if (callerSignal?.aborted === true) return "cancelled";
  if (error instanceof OutboundHttpEgressError) return OUTBOUND_STT_KINDS[error.code];
  if (timeoutSignal.aborted) return "timeout";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "transport";
}

// Builds the multipart/form-data body for the OpenAI-compatible `/audio/transcriptions` contract:
// the binary `file` part, the `model` field, an optional `language` field, and a fixed `json`
// `response_format`. The audio bytes are embedded verbatim; every textual field is sanitized.
function audioBlobPart(audio: Uint8Array): BlobPart {
  if (audio.buffer instanceof ArrayBuffer) {
    return audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength
      ? audio.buffer
      : audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
  }
  const copy = new Uint8Array(audio.byteLength);
  copy.set(audio);
  return copy.buffer;
}

function buildMultipartBody(request: SpeechToTextRequest, boundary: string): Blob {
  const enc = new TextEncoder();
  const filename = `audio.${extensionForMime(request.mimeType)}`;
  const mimeType = sanitizeFieldValue(request.mimeType);
  const parts: BlobPart[] = [
    enc.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    audioBlobPart(request.audio),
    enc.encode(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n${sanitizeFieldValue(request.modelId)}\r\n`,
    ),
  ];
  if (request.language !== undefined && request.language.length > 0) {
    parts.push(
      enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="language"\r\n\r\n${sanitizeFieldValue(providerSpeechLanguage(request.language))}\r\n`,
      ),
    );
  }
  if (request.prompt !== undefined && request.prompt.length > 0) {
    parts.push(
      enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n${sanitizeFieldValue(request.prompt)}\r\n`,
      ),
    );
  }
  parts.push(
    enc.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
        `--${boundary}--\r\n`,
    ),
  );
  return new Blob(parts);
}

interface BuiltRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Blob;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
  // The floored deadline (#3591) this call actually runs under — carried alongside the abort
  // signals so the completion line can report the exact same applied bound as the dispatch line,
  // rather than recomputing the floor a second time.
  readonly timeoutMs: number;
}

function buildRequest(request: SpeechToTextRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const boundary = `keiko-stt-${randomUUID()}`;
  const body = buildMultipartBody(request, boundary);
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    // Set explicitly so the proxy/CA-fallback egress path sends a fixed-length body. The Fetch spec
    // treats content-length as a forbidden header on the direct path, where undici computes it.
    "content-length": String(body.size),
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
    timeoutMs: appliedTimeoutMs,
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
): Promise<Response | SpeechToTextErrorKind> {
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Confidence is documented as a [0,1] score; drop an out-of-range provider value rather than echo a
// misleading number back to the UI (never synthesize one when absent).
function unitInterval(value: number | undefined): number | undefined {
  return value !== undefined && value >= 0 && value <= 1 ? value : undefined;
}

function parseTranscription(payload: unknown): SpeechToTextSuccess | null {
  // OpenAI- and Azure-compatible transcription responses carry the transcript under `text`. An
  // empty string is a valid transcript (silence) and is preserved rather than treated as a failure.
  if (!isRecord(payload) || typeof payload.text !== "string") {
    return null;
  }
  const confidence = unitInterval(finiteNumber(payload.confidence));
  const language = typeof payload.language === "string" ? payload.language : undefined;
  // OpenAI verbose responses report `duration` in seconds; normalize to milliseconds.
  const durationSeconds = finiteNumber(payload.duration);
  const durationMs = durationSeconds !== undefined ? Math.round(durationSeconds * 1000) : undefined;
  return {
    transcript: payload.text,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

async function decodeSuccess(response: Response): Promise<SpeechToTextOutcome> {
  let payload: unknown;
  try {
    payload = await readJsonCapped(response);
  } catch {
    return { ok: false, kind: "invalid-response" };
  }
  const value = parseTranscription(payload);
  if (value === null) {
    return { ok: false, kind: "invalid-response" };
  }
  return { ok: true, value };
}

// Dispatches the built request and decodes its outcome, without touching the activity log — the
// single caller below is the one place that pairs this result with THE COMPLETION LINE, so no
// exit of the dispatched call can be added here without also being logged.
async function dispatchAndDecode(
  built: BuiltRequest,
  request: SpeechToTextRequest,
): Promise<SpeechToTextOutcome> {
  const dispatched = await dispatch(built, request.fetchImpl, request.egress);
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

// Single round-trip speech-to-text transcription. Provider-neutral, no retry (a dictation request
// is interactive; the caller decides whether to retry), and every failure is a coded, content-free
// `kind` so the BFF can map it to a deterministic, secret-free HTTP response (ADR-0100 D6, AC5).
export async function requestSpeechToText(
  request: SpeechToTextRequest,
): Promise<SpeechToTextOutcome> {
  // THE ATTEMPT LINE first (buildRequest's logDispatch), so it is always the first line of the
  // call — the narrower, conditional language-normalization line (when one fires) follows it.
  const built = buildRequest(request);
  logLanguageNormalization(request);
  const outcome = await dispatchAndDecode(built, request);
  logCompleted(request, built.timeoutMs, outcome);
  return outcome;
}
