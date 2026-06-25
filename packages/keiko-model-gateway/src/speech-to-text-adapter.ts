// OpenAI / Azure-Foundry-compatible speech-to-text (transcription) adapter. Builds on
// globalThis.fetch only (no SDK dependency), mirroring openai-embedding-adapter.ts. The audio
// buffer is POSTed once as multipart/form-data to `${endpoint}/audio/transcriptions` through the
// single `gatewayFetch` egress seam (ADR-0038), so voice traffic inherits the same corporate-proxy,
// custom-CA, timeout, and byte-cap behavior as every other productive model call (ADR-0058 D4).
//
// This module is provider-neutral: the multipart `/audio/transcriptions` contract is the
// OpenAI-compatible surface the gateway already speaks for chat and embeddings, and Azure Foundry's
// `keiko-stt` deployment class is one valid provider locality among three (ADR-0058 D7). Only the
// transcript text and optional content-free metadata escape this module — the audio buffer, the raw
// provider body, the provider URL, and the credential never do.

import { randomUUID } from "node:crypto";
import { apiKeyHeaderValue } from "./config.js";
import {
  gatewayFetch,
  OutboundHttpEgressError,
  readJsonCapped,
  type OutboundHttpEgressErrorCode,
} from "./http.js";
import type { OutboundHttpEgressConfig } from "./types.js";

export interface SpeechToTextRequest {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly modelId: string;
  // Raw audio bytes (already decoded from the loopback request). Never persisted by this module.
  readonly audio: Uint8Array;
  // The audio container MIME type (validated by the caller against a closed allowlist).
  readonly mimeType: string;
  // Optional BCP-47-ish language hint (validated by the caller); omitted lets the provider detect.
  readonly language?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly egress?: OutboundHttpEgressConfig | undefined;
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

function joinUrl(endpoint: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${trimmed}/audio/transcriptions`;
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
// embedding adapter so callers can tell a user Cancel apart from a hung provider.
function classifyDispatchError(
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

// Returns an `ArrayBuffer`-backed Uint8Array (the `new Uint8Array(number)` overload) so the result
// is a valid `BufferSource`/`BodyInit` for `gatewayFetch` without a type assertion.
function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// Builds the multipart/form-data body for the OpenAI-compatible `/audio/transcriptions` contract:
// the binary `file` part, the `model` field, an optional `language` field, and a fixed `json`
// `response_format`. The audio bytes are embedded verbatim; every textual field is sanitized.
function buildMultipartBody(
  request: SpeechToTextRequest,
  boundary: string,
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const filename = `audio.${extensionForMime(request.mimeType)}`;
  const mimeType = sanitizeFieldValue(request.mimeType);
  const parts: Uint8Array[] = [
    enc.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    request.audio,
    enc.encode(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n${sanitizeFieldValue(request.modelId)}\r\n`,
    ),
  ];
  if (request.language !== undefined && request.language.length > 0) {
    parts.push(
      enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="language"\r\n\r\n${sanitizeFieldValue(request.language)}\r\n`,
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
  return concatBytes(parts);
}

interface BuiltRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
}

function buildRequest(request: SpeechToTextRequest): BuiltRequest {
  const name = headerName(request.apiKeyHeaderName);
  const boundary = `keiko-stt-${randomUUID()}`;
  const body = buildMultipartBody(request, boundary);
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    // Set explicitly so the proxy/CA-fallback egress path sends a fixed-length body. The Fetch spec
    // treats content-length as a forbidden header on the direct path, where undici computes it.
    "content-length": String(body.byteLength),
    [name]: apiKeyHeaderValue(name, request.apiKey),
  };
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? 30_000);
  const signal =
    request.signal !== undefined ? AbortSignal.any([timeoutSignal, request.signal]) : timeoutSignal;
  return {
    url: joinUrl(request.endpoint),
    headers,
    body,
    signal,
    timeoutSignal,
    callerSignal: request.signal,
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

// Single round-trip speech-to-text transcription. Provider-neutral, no retry (a dictation request
// is interactive; the caller decides whether to retry), and every failure is a coded, content-free
// `kind` so the BFF can map it to a deterministic, secret-free HTTP response (ADR-0058 D6, AC5).
export async function requestSpeechToText(
  request: SpeechToTextRequest,
): Promise<SpeechToTextOutcome> {
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
  return decodeSuccess(dispatched);
}
