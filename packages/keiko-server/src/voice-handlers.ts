// BFF voice dictation route (Issue #494, Epic #491, ADR-0058 D1/D2/D4/D6). `POST /api/voice/transcribe`
// accepts one short controlled composer-dictation clip and returns its transcript. The route is
// capability-gated: it transcribes only when the resolved voice capability advertises speech-to-text
// (AC1), and otherwise answers a deterministic, secret-free `VOICE_UNAVAILABLE` so Keiko stays fully
// usable in no-voice / policy-disabled / unreachable deployments (AC2, ADR-0058 D1).
//
// The audio rides inside the existing JSON + CSRF request envelope (base64 `audio` field) so the
// server's "state-changing requests must be JSON and carry the CSRF guard" invariant is preserved
// unchanged — no relaxation of the BFF media-type or CSRF gate. The decoded audio is forwarded once
// to the configured STT provider through the Model Gateway egress seam (`gatewayFetch`, ADR-0038)
// and is held only in memory for the duration of the request: it is never written to the evidence
// store, a side file, a log, or any other on-disk location (AC3, "no raw audio persistence").
// Provider base URLs and credentials never appear in any response (AC4), and every failure is a
// static, redacted envelope carrying no provider body, URL, path, or network detail (AC5).

import type { IncomingMessage } from "node:http";
import {
  requestSpeechToText,
  resolveVoiceCapability,
  selectSpeechToTextModel,
  type GatewayConfig,
  type ModelProviderConfig,
  type SpeechToTextErrorKind,
  type SpeechToTextRequest,
  type SpeechToTextSuccess,
} from "@oscharko-dev/keiko-model-gateway";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig, currentGatewayEgressConfig } from "./deps.js";
import { isVoiceDisabledByPolicy } from "./read-handlers.js";

// The decoded-audio ceiling for one dictation clip. This is the authoritative bound on the
// transcribable duration: regardless of codec, a clip cannot exceed this many bytes, so the maximum
// possible duration is bounded even though precise server-side duration measurement would require
// decoding the container (out of scope — no audio-processing dependency, ADR-0058 supply-chain D8).
const MAX_AUDIO_BYTES = 4_000_000;
// The JSON envelope ceiling. base64 inflates by ~4/3, so this comfortably holds MAX_AUDIO_BYTES of
// base64 plus the small JSON field overhead while still rejecting an oversized body early (413).
const MAX_BODY_BYTES = 6_000_000;
// Upper bound on a declared dictation length. "Short controlled dictation" is bounded to two minutes;
// a clip declaring a longer duration is rejected before any provider call.
const MAX_DICTATION_MS = 120_000;

// Closed allowlist of accepted audio container MIME types (base type, parameters such as
// `;codecs=opus` are stripped before the check). Matches what a browser MediaRecorder commonly emits.
const ALLOWED_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
]);

// A pure base64 payload (no data: URI prefix, no whitespace), length a multiple of four. Anchored so
// a malformed or injection-shaped value is rejected deterministically before decoding.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
// BCP-47-ish language tag, bounded length, anchored so it can never break the multipart field header.
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_LANGUAGE_LENGTH = 16;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolveBody(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

async function readJsonObject(
  req: IncomingMessage,
): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
}

// Deterministic, secret-free disabled response (AC1/AC2, ADR-0058 D1). Returned both when no STT
// capability is configured/enabled and when a configured provider is selected but missing — the
// browser sees a stable shape and Keiko remains fully usable.
function unavailable(deps: UiHandlerDeps): RouteResult {
  return {
    status: 503,
    body: deps.redactor(
      errorBody("VOICE_UNAVAILABLE", "Speech-to-text dictation is not available."),
    ),
  };
}

function badRequest(deps: UiHandlerDeps, code: string, message: string): RouteResult {
  return { status: 400, body: deps.redactor(errorBody(code, message)) };
}

// Static, secret-free mapping from a coded adapter failure to an HTTP response (AC5). No provider
// body, URL, path, IP, or credential is ever interpolated — only fixed operator-safe text.
function providerErrorResult(deps: UiHandlerDeps, kind: SpeechToTextErrorKind): RouteResult {
  if (kind === "rate-limited") {
    return {
      status: 429,
      body: deps.redactor(
        errorBody(
          "VOICE_RATE_LIMITED",
          "The speech-to-text provider is rate-limited. Retry shortly.",
        ),
      ),
    };
  }
  if (kind === "timeout") {
    return {
      status: 504,
      body: deps.redactor(errorBody("VOICE_TIMEOUT", "The speech-to-text request timed out.")),
    };
  }
  if (kind === "payload-too-large") {
    return {
      status: 413,
      body: deps.redactor(
        errorBody(
          "PAYLOAD_TOO_LARGE",
          "The audio clip is too large for the speech-to-text provider.",
        ),
      ),
    };
  }
  if (kind === "unsupported-model") {
    // The configured model is not available at the provider — effectively unavailable for dictation.
    return unavailable(deps);
  }
  return {
    status: 502,
    body: deps.redactor(
      errorBody(
        "VOICE_PROVIDER_ERROR",
        "The speech-to-text provider could not transcribe the audio.",
      ),
    ),
  };
}

interface ValidatedAudio {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language?: string;
}

function normalizeMimeType(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const base = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_AUDIO_MIME.has(base) ? base : undefined;
}

function decodeAudio(raw: unknown): Uint8Array | "invalid" | "empty" {
  if (typeof raw !== "string" || raw.length === 0 || !BASE64_PATTERN.test(raw)) {
    return "invalid";
  }
  if (raw.length % 4 !== 0) {
    return "invalid";
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.byteLength === 0) {
    return "empty";
  }
  return decoded;
}

function validateDurationMs(raw: unknown): "ok" | "invalid" {
  if (raw === undefined) {
    return "ok";
  }
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    raw > MAX_DICTATION_MS
  ) {
    return "invalid";
  }
  return "ok";
}

type LanguageResult =
  | { readonly ok: true; readonly language: string | undefined }
  | { readonly ok: false };

function validateLanguage(raw: unknown): LanguageResult {
  if (raw === undefined) {
    return { ok: true, language: undefined };
  }
  if (typeof raw !== "string" || raw.length > MAX_LANGUAGE_LENGTH || !LANGUAGE_PATTERN.test(raw)) {
    return { ok: false };
  }
  return { ok: true, language: raw };
}

// Validates and normalizes the request fields, returning either the audio payload to transcribe or a
// deterministic 4xx RouteResult. Order: size → MIME → audio → duration → language.
function validateRequest(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): ValidatedAudio | RouteResult {
  const mimeType = normalizeMimeType(body.mimeType);
  if (mimeType === undefined) {
    return badRequest(
      deps,
      "UNSUPPORTED_AUDIO_FORMAT",
      "The audio mimeType is missing or not a supported dictation format.",
    );
  }
  const decoded = decodeAudio(body.audio);
  if (decoded === "invalid") {
    return badRequest(deps, "INVALID_AUDIO", "The audio field must be non-empty base64 data.");
  }
  if (decoded === "empty") {
    return badRequest(deps, "INVALID_AUDIO", "The decoded audio is empty.");
  }
  if (decoded.byteLength > MAX_AUDIO_BYTES) {
    return {
      status: 413,
      body: deps.redactor(errorBody("PAYLOAD_TOO_LARGE", "The audio clip exceeds the size limit.")),
    };
  }
  if (validateDurationMs(body.durationMs) === "invalid") {
    return badRequest(
      deps,
      "INVALID_DURATION",
      "The declared durationMs must be a positive integer within the dictation limit.",
    );
  }
  const language = validateLanguage(body.language);
  if (!language.ok) {
    return badRequest(deps, "INVALID_LANGUAGE", "The language tag is not a valid BCP-47 language.");
  }
  return {
    audio: decoded,
    mimeType,
    ...(language.language !== undefined ? { language: language.language } : {}),
  };
}

// Resolves the configured STT provider to transcribe with, or undefined when none is configured /
// usable. Mirrors the capability gate: a selected model always has a matching provider record.
function resolveSttProvider(config: GatewayConfig): ModelProviderConfig | undefined {
  const modelId = selectSpeechToTextModel(config);
  if (modelId === undefined) {
    return undefined;
  }
  return config.providers.find((provider) => provider.modelId === modelId);
}

// Capability gate (AC1, ADR-0058 D1): resolves the STT provider to dictate against, or a clean
// VOICE_UNAVAILABLE RouteResult when no speech-to-text capability is configured, enabled, reachable,
// or backed by a provider record. Runs before any audio is read so a disabled deployment does zero
// audio work.
function selectDictationProvider(deps: UiHandlerDeps): ModelProviderConfig | RouteResult {
  const config = currentGatewayConfig(deps);
  const policyDisabled = isVoiceDisabledByPolicy(deps.env);
  const voice = resolveVoiceCapability(config ?? { providers: [] }, { policyDisabled });
  if (config === undefined || !voice.available || !voice.capabilities.speechToText) {
    return unavailable(deps);
  }
  return resolveSttProvider(config) ?? unavailable(deps);
}

function buildSttRequest(
  provider: ModelProviderConfig,
  validated: ValidatedAudio,
  deps: UiHandlerDeps,
): SpeechToTextRequest {
  const egress = provider.egress ?? currentGatewayEgressConfig(deps);
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    modelId: provider.modelId,
    audio: validated.audio,
    mimeType: validated.mimeType,
    ...(validated.language !== undefined ? { language: validated.language } : {}),
    ...(egress !== undefined ? { egress } : {}),
    timeoutMs: provider.timeoutMs,
  };
}

// Success body: only the transcript and content-free provider metadata, redacted defensively. The
// audio buffer is not persisted and goes out of scope (AC3); no credential or base URL is present
// in this payload (AC4).
function transcriptResult(deps: UiHandlerDeps, value: SpeechToTextSuccess): RouteResult {
  return {
    status: 200,
    body: deps.redactor({
      transcript: value.transcript,
      ...(value.confidence !== undefined ? { confidence: value.confidence } : {}),
      ...(value.language !== undefined ? { language: value.language } : {}),
      ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
    }),
  };
}

export async function handleVoiceTranscribe(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const provider = selectDictationProvider(deps);
  if (isRouteResult(provider)) {
    return provider;
  }
  const parsed = await readJsonObject(ctx.req);
  if (isRouteResult(parsed)) {
    return parsed;
  }
  const validated = validateRequest(parsed, deps);
  if (isRouteResult(validated)) {
    return validated;
  }
  const transcribe = deps.voiceTranscriptionRequest ?? requestSpeechToText;
  const outcome = await transcribe(buildSttRequest(provider, validated, deps));
  return outcome.ok
    ? transcriptResult(deps, outcome.value)
    : providerErrorResult(deps, outcome.kind);
}
