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
  requestTextToSpeech,
  requestTextToSpeechStream,
  resolveVoiceCapability,
  selectSpeechOutputModel,
  selectSpeechToTextModel,
  selectVoicePersonaVoice,
  VOICE_PERSONAS,
  type GatewayConfig,
  type ModelProviderConfig,
  type SpeechToTextErrorKind,
  type SpeechToTextRequest,
  type SpeechToTextSuccess,
  type TextToSpeechErrorKind,
  type TextToSpeechRequest,
  type TextToSpeechStreamOutcome,
  type TextToSpeechSuccess,
  type VoicePersona,
} from "@oscharko-dev/keiko-model-gateway";
import type { HandlerOutcome, RouteContext, RouteResult } from "./routes.js";
import { errorBody, STREAMING } from "./routes.js";
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
    ...(provider.endpointStyle !== undefined ? { endpointStyle: provider.endpointStyle } : {}),
    ...(provider.apiVersion !== undefined ? { apiVersion: provider.apiVersion } : {}),
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

// ---------------------------------------------------------------------------
// BFF assistant speech-output (synthesis) route (Issue #1558, Epic #1556, ADR-0095).
// `POST /api/voice/speak` synthesizes the visible assistant answer text into audible output through
// the Model Gateway text-to-speech adapter and returns the audio as base64 inside the standard JSON
// envelope. It is capability-gated: it synthesizes only when the resolved voice capability advertises
// speech output (AC1), and otherwise answers a deterministic, secret-free `VOICE_UNAVAILABLE` so the
// conversation degrades to text without breaking (AC4). The answer text rides inside the existing
// JSON + CSRF request envelope, so the server's state-changing-request invariant is preserved
// unchanged. The synthesized audio is held only in memory for the duration of the request and is
// never written to the evidence store, a side file, a log, or any on-disk location ("no raw generated
// audio persistence"). Provider base URLs, credentials, and the credential-tier persona → voice-id
// mapping never appear in any response (the voice id stays server-side), and every failure is a
// static, redacted envelope carrying no provider body, URL, path, or network detail.
// ---------------------------------------------------------------------------

// The upper bound on the answer text submitted for synthesis. It matches the OpenAI-compatible
// `/audio/speech` input ceiling: rather than truncate a longer answer (which would make the spoken
// output diverge from the visible text, breaking AC2), an over-long answer is rejected and the spoken
// layer degrades to text (AC4). The visible assistant text is always present in the transcript.
const MAX_SPEECH_INPUT_CHARS = 4096;

// Server-side allowlist of audio container MIME types the synthesis route will label a response with.
// The adapter resolves the type from the provider response, but the value handed to the browser is
// canonicalized against this closed set so no provider-controlled string crosses the BFF boundary; an
// unrecognized type falls back to the broadest-playback default.
const ALLOWED_SPEECH_MIME: ReadonlySet<string> = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/wav",
  "audio/pcm",
]);
const DEFAULT_SPEECH_MIME = "audio/mpeg";

// Deterministic, secret-free disabled response for the synthesis route (AC1/AC4). Returned both when
// no speech-output capability is configured/enabled and when a configured provider cannot be resolved.
function speechUnavailable(deps: UiHandlerDeps): RouteResult {
  return {
    status: 503,
    body: deps.redactor(
      errorBody("VOICE_UNAVAILABLE", "Assistant speech output is not available."),
    ),
  };
}

// Static, secret-free mapping from a coded synthesis failure to an HTTP response. No provider body,
// URL, path, IP, or credential is ever interpolated — only fixed operator-safe text (AC4).
function speechProviderErrorResult(deps: UiHandlerDeps, kind: TextToSpeechErrorKind): RouteResult {
  if (kind === "rate-limited") {
    return {
      status: 429,
      body: deps.redactor(
        errorBody(
          "VOICE_RATE_LIMITED",
          "The speech-output provider is rate-limited. Retry shortly.",
        ),
      ),
    };
  }
  if (kind === "timeout") {
    return {
      status: 504,
      body: deps.redactor(errorBody("VOICE_TIMEOUT", "The speech-output request timed out.")),
    };
  }
  if (kind === "payload-too-large") {
    return {
      status: 413,
      body: deps.redactor(
        errorBody("PAYLOAD_TOO_LARGE", "The assistant response is too long for speech synthesis."),
      ),
    };
  }
  if (kind === "unsupported-model") {
    // The configured model is not available at the provider — effectively unavailable for synthesis.
    return speechUnavailable(deps);
  }
  return {
    status: 502,
    body: deps.redactor(
      errorBody(
        "VOICE_PROVIDER_ERROR",
        "The speech-output provider could not synthesize the audio.",
      ),
    ),
  };
}

// Capability gate (AC1): confirms speech output is configured, enabled, and reachable before any text
// is read, so a disabled deployment does zero synthesis work. Returns the active gateway config or a
// clean VOICE_UNAVAILABLE RouteResult.
function gateSpeechOutput(deps: UiHandlerDeps): GatewayConfig | RouteResult {
  const config = currentGatewayConfig(deps);
  const policyDisabled = isVoiceDisabledByPolicy(deps.env);
  const voice = resolveVoiceCapability(config ?? { providers: [] }, { policyDisabled });
  if (config === undefined || !voice.available || !voice.capabilities.speechOutput) {
    return speechUnavailable(deps);
  }
  return config;
}

interface ValidatedSpeech {
  readonly text: string;
  readonly persona?: VoicePersona;
}

function isVoicePersona(value: unknown): value is VoicePersona {
  return typeof value === "string" && (VOICE_PERSONAS as readonly string[]).includes(value);
}

// Validates the synthesis request: a non-empty bounded answer text and an optional persona drawn from
// the closed VOICE_PERSONAS set. Order: text presence → text length → persona.
function validateSpeakRequest(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): ValidatedSpeech | RouteResult {
  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return badRequest(deps, "INVALID_TEXT", "The text field must be a non-empty string.");
  }
  if (text.length > MAX_SPEECH_INPUT_CHARS) {
    return {
      status: 413,
      body: deps.redactor(
        errorBody("PAYLOAD_TOO_LARGE", "The assistant response is too long for speech synthesis."),
      ),
    };
  }
  if (body.persona !== undefined && !isVoicePersona(body.persona)) {
    return badRequest(deps, "INVALID_PERSONA", "The persona is not a supported voice persona.");
  }
  return {
    text,
    ...(isVoicePersona(body.persona) ? { persona: body.persona } : {}),
  };
}

interface SpeechTarget {
  readonly modelId: string;
  readonly voiceId?: string;
}

// Resolves the model + provider voice id to synthesize with (Issue #1557 seam, ADR-0094 D6). A
// requested persona is honored when mapped; otherwise the first persona-mapped provider in canonical
// order is used; otherwise the cheapest speech-output model with the adapter's default voice. The
// resolved voice id stays server-side and never reaches a response.
function resolveSpeechTarget(
  config: GatewayConfig,
  persona: VoicePersona | undefined,
): SpeechTarget | undefined {
  if (persona !== undefined) {
    const mapped = selectVoicePersonaVoice(config, persona);
    if (mapped !== undefined) {
      return mapped;
    }
  }
  for (const candidate of VOICE_PERSONAS) {
    const mapped = selectVoicePersonaVoice(config, candidate);
    if (mapped !== undefined) {
      return mapped;
    }
  }
  const modelId = selectSpeechOutputModel(config);
  return modelId === undefined ? undefined : { modelId };
}

// The audio container requested for interactive assistant speech. Opus (audio/ogg) is browser-playable
// and measured ~25-35% faster end-to-end than the previous mp3 default while transferring ~4x fewer
// bytes (e.g. for a short reply: opus ~1.1s / ~18KB vs mp3 ~1.4s / ~72KB against the live endpoint),
// which lowers both the synth-to-first-audio wait and the base64 inflation of the JSON envelope. The
// MIME stays inside the server ALLOWED_SPEECH_MIME allowlist (audio/ogg).
const INTERACTIVE_SPEECH_FORMAT = "opus" as const;

function buildTtsRequest(
  provider: ModelProviderConfig,
  target: SpeechTarget,
  validated: ValidatedSpeech,
  deps: UiHandlerDeps,
): TextToSpeechRequest {
  const egress = provider.egress ?? currentGatewayEgressConfig(deps);
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    ...(provider.endpointStyle !== undefined ? { endpointStyle: provider.endpointStyle } : {}),
    ...(provider.apiVersion !== undefined ? { apiVersion: provider.apiVersion } : {}),
    modelId: provider.modelId,
    input: validated.text,
    responseFormat: INTERACTIVE_SPEECH_FORMAT,
    ...(target.voiceId !== undefined ? { voice: target.voiceId } : {}),
    ...(egress !== undefined ? { egress } : {}),
    timeoutMs: provider.timeoutMs,
  };
}

// Success body: the synthesized audio as base64 plus a canonicalized audio MIME type. The audio is
// content-free synthesized speech of the already-visible assistant text and carries no credential or
// URL, so it is NOT passed through the secret redactor — redacting a multi-megabyte base64 blob would
// risk corrupting the audio with no security benefit. The MIME type is canonicalized against a closed
// server allowlist so no provider-controlled string crosses the boundary. The audio buffer goes out
// of scope after this response and is never persisted ("no raw generated audio persistence").
function speechResult(value: TextToSpeechSuccess): RouteResult {
  const mimeType = ALLOWED_SPEECH_MIME.has(value.mimeType) ? value.mimeType : DEFAULT_SPEECH_MIME;
  return {
    status: 200,
    body: { audio: Buffer.from(value.audio).toString("base64"), mimeType },
  };
}

interface ResolvedSpeak {
  readonly validated: ValidatedSpeech;
  readonly provider: ModelProviderConfig;
  readonly target: SpeechTarget;
}

// Shared front-matter for both speak routes: gate the capability, parse + validate the request, and
// resolve the provider + voice target. Returns the resolved request, or a RouteResult to return as-is.
async function resolveSpeakRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<ResolvedSpeak | RouteResult> {
  const gated = gateSpeechOutput(deps);
  if (isRouteResult(gated)) {
    return gated;
  }
  const parsed = await readJsonObject(ctx.req);
  if (isRouteResult(parsed)) {
    return parsed;
  }
  const validated = validateSpeakRequest(parsed, deps);
  if (isRouteResult(validated)) {
    return validated;
  }
  const target = resolveSpeechTarget(gated, validated.persona);
  if (target === undefined) {
    return speechUnavailable(deps);
  }
  const provider = gated.providers.find((candidate) => candidate.modelId === target.modelId);
  if (provider === undefined) {
    return speechUnavailable(deps);
  }
  return { validated, provider, target };
}

export async function handleVoiceSpeak(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const resolved = await resolveSpeakRequest(ctx, deps);
  if (isRouteResult(resolved)) {
    return resolved;
  }
  const synthesize = deps.voiceSpeechRequest ?? requestTextToSpeech;
  const outcome = await synthesize(
    buildTtsRequest(resolved.provider, resolved.target, resolved.validated, deps),
  );
  return outcome.ok ? speechResult(outcome.value) : speechProviderErrorResult(deps, outcome.kind);
}

// The streaming speak path requests raw PCM (the fastest provider format to first audio) and forwards
// the bytes to the browser un-buffered (no base64 JSON envelope) for AudioWorklet start-on-first-chunk
// playback. The buffered /api/voice/speak route stays as the universal fallback.
const STREAM_SPEECH_FORMAT = "pcm" as const;

function buildStreamTtsRequest(
  resolved: ResolvedSpeak,
  deps: UiHandlerDeps,
  signal: AbortSignal,
): TextToSpeechRequest {
  return {
    ...buildTtsRequest(resolved.provider, resolved.target, resolved.validated, deps),
    responseFormat: STREAM_SPEECH_FORMAT,
    signal,
  };
}

// Aborts the synthesis when the client disconnects (res "close" is the canonical signal), so a barge-in
// or navigation stops the provider stream rather than producing audio no one will hear.
function abortOnResClose(ctx: RouteContext): AbortController {
  const controller = new AbortController();
  ctx.res.on("close", () => {
    controller.abort();
  });
  return controller;
}

// Pipes the provider audio stream to the response honoring backpressure (res.write → false aborts) and
// client disconnect. Once 200 + audio headers are sent no JSON error is possible, so a mid-stream
// failure just ends the partial stream — the client falls back to the buffered route on the next turn.
async function pipeAudioStream(
  ctx: RouteContext,
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || controller.signal.aborted) {
        break;
      }
      if (!ctx.res.write(value)) {
        controller.abort();
        ctx.res.destroy();
        break;
      }
    }
  } catch {
    // partial stream — ended in finally
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already released
    }
    ctx.res.end();
  }
}

export async function handleVoiceSpeakStream(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const resolved = await resolveSpeakRequest(ctx, deps);
  if (isRouteResult(resolved)) {
    return resolved;
  }
  const controller = abortOnResClose(ctx);
  const synthesizeStream: (request: TextToSpeechRequest) => Promise<TextToSpeechStreamOutcome> =
    deps.voiceSpeechStreamRequest ?? requestTextToSpeechStream;
  const outcome = await synthesizeStream(buildStreamTtsRequest(resolved, deps, controller.signal));
  if (!outcome.ok) {
    return speechProviderErrorResult(deps, outcome.kind);
  }
  const mimeType = ALLOWED_SPEECH_MIME.has(outcome.value.mimeType)
    ? outcome.value.mimeType
    : DEFAULT_SPEECH_MIME;
  ctx.res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "no-store" });
  await pipeAudioStream(ctx, outcome.value.body, controller);
  return STREAMING;
}
