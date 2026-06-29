// Issue #1562 — security/privacy/permissions hardening capstone (Epic #1556).
//
// These tests prove the NON-PERSISTENCE guarantee of the colleague-like voice dialogue path
// (AC1 D2). The dialogue path is: mic (MediaRecorder) → /api/voice/transcribe → chat send →
// assistant answer → /api/voice/speak → HTMLAudioElement playback. Both BFF routes are
// stateless with respect to the evidence store: they hold audio and text in memory for the
// duration of the request only and release all buffers on response. No part of the dialogue
// cycle — raw input audio, decoded audio bytes, transcript text, assistant input text, or
// generated audio — must ever be written to the evidence store.
//
// Scope: what is NOT covered by the existing speak/transcribe tests (which prove response-body
// redaction) and is instead unique to this file:
//   - evidenceStore.put is never called across the happy path (transcribe + speak).
//   - evidenceStore.put is never called under every provider failure kind.
//   - The generated audio base64 returned to the browser is provably absent from all put args.
//   - The assistant input text is provably absent from all put args.
//   - The raw audio base64 submitted to the transcribe route is provably absent from all put args.
//
// Strategy: wrap evidenceStore.put in a vi.fn() spy and drive handleVoiceTranscribe /
// handleVoiceSpeak with in-memory stubs so no real provider or network is touched.

import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { handleVoiceTranscribe, handleVoiceSpeak } from "./voice-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext } from "./routes.js";
import type {
  GatewayConfig,
  SpeechToTextOutcome,
  SpeechToTextRequest,
  TextToSpeechOutcome,
  TextToSpeechRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";

// ─── Sentinel constants ────────────────────────────────────────────────────────────────────────
// These values appear in the happy-path request bodies and provider responses. None must appear
// in any argument passed to evidenceStore.put.

const PROVIDER_SECRET = "dialogue-safety-secret-token-xyzzy";
const PROVIDER_BASE_URL = "https://keiko-dialogue-safety.example.com";

// A distinctive audio payload that will be detectable as a substring if it leaks into put args.
const RAW_AUDIO_TEXT = "KEIKO-RAW-MIC-AUDIO-BYTES-1562";
const GENERATED_AUDIO_TEXT = "KEIKO-GENERATED-SPEECH-BYTES-1562";
// The assistant answer text forwarded to the speak route.
const ASSISTANT_TEXT = "This is the assistant reply that must never reach the evidence store.";

// ─── Gateway configs ───────────────────────────────────────────────────────────────────────────

// Full dialogue config: both STT (dictation) and TTS (speech output) are enabled.
const DIALOGUE_STT_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "keiko-stt",
      baseUrl: PROVIDER_BASE_URL,
      apiKey: PROVIDER_SECRET,
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "keiko-stt",
      kind: "voice",
      contextWindow: 0,
      maxOutputTokens: 0,
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsSpeechInput: true,
      voiceProviderLocality: "azure-foundry",
      workflowEligible: false,
      costClass: "low",
      latencyClass: "fast",
      throughputHint: "azure foundry stt",
      preferredUseCases: ["Dictation"],
      knownLimitations: [],
    },
  ],
};

const DIALOGUE_TTS_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "keiko-tts",
      baseUrl: PROVIDER_BASE_URL,
      apiKey: PROVIDER_SECRET,
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
      voiceProfiles: [{ persona: "female", voiceId: "internal-voice-id-dialogue-1562" }],
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "keiko-tts",
      kind: "voice",
      contextWindow: 0,
      maxOutputTokens: 0,
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsSpeechOutput: true,
      supportedVoicePersonas: ["female"],
      voiceProviderLocality: "azure-foundry",
      workflowEligible: false,
      costClass: "low",
      latencyClass: "fast",
      throughputHint: "azure foundry tts",
      preferredUseCases: ["Playback"],
      knownLimitations: [],
    },
  ],
};

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

// Valid base64 audio payload for dictation. Its b64 representation contains the RAW_AUDIO_TEXT
// marker so any accidental persistence of the raw audio will be detectable in put spy args.
const VALID_AUDIO_B64 = b64(RAW_AUDIO_TEXT);

function ctx(url: string, body: unknown): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL(url),
  };
}

function transcribeCtx(
  body: unknown = { audio: VALID_AUDIO_B64, mimeType: "audio/webm" },
): RouteContext {
  return ctx("http://127.0.0.1/api/voice/transcribe", body);
}

function speakCtx(body: unknown = { text: ASSISTANT_TEXT }): RouteContext {
  return ctx("http://127.0.0.1/api/voice/speak", body);
}

// A spying evidence store: captures every argument passed to put so tests can assert no sensitive
// content ever reached it. The no-op list/get/delete are irrelevant to these tests.
function spyingStore(): { store: EvidenceStore; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn(() => "spy-evidence-id");
  return {
    store: {
      put,
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    put,
  };
}

function depsWith(overrides: Partial<UiHandlerDeps>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

// STT stub: records the forwarded request and resolves to the given outcome.
function stubTranscribe(outcome: SpeechToTextOutcome): {
  fn: (request: SpeechToTextRequest) => Promise<SpeechToTextOutcome>;
} {
  return {
    fn: (request: SpeechToTextRequest): Promise<SpeechToTextOutcome> => {
      void request; // consumed but not stored
      return Promise.resolve(outcome);
    },
  };
}

// TTS stub: resolves to the given outcome without any network I/O.
function stubSpeak(outcome: TextToSpeechOutcome): {
  fn: (request: TextToSpeechRequest) => Promise<TextToSpeechOutcome>;
} {
  return {
    fn: (request: TextToSpeechRequest): Promise<TextToSpeechOutcome> => {
      void request;
      return Promise.resolve(outcome);
    },
  };
}

// A successful STT outcome. The transcript is content-free by design (no sensitive marker).
function sttOk(): SpeechToTextOutcome {
  return { ok: true, value: { transcript: "keiko dictation transcript" } };
}

// A successful TTS outcome. The audio bytes encode the GENERATED_AUDIO_TEXT marker so any
// accidental persistence of the generated audio buffer will be detectable in put spy args.
function ttsOk(): TextToSpeechOutcome {
  return {
    ok: true,
    value: {
      audio: new TextEncoder().encode(GENERATED_AUDIO_TEXT),
      mimeType: "audio/mpeg",
    },
  };
}

function sttDeps(
  spy: ReturnType<typeof spyingStore>,
  outcome: SpeechToTextOutcome = sttOk(),
): UiHandlerDeps {
  return depsWith({
    config: DIALOGUE_STT_CONFIG,
    configPresent: true,
    evidenceStore: spy.store,
    voiceTranscriptionRequest: stubTranscribe(outcome).fn,
  });
}

function ttsDeps(
  spy: ReturnType<typeof spyingStore>,
  outcome: TextToSpeechOutcome = ttsOk(),
): UiHandlerDeps {
  return depsWith({
    config: DIALOGUE_TTS_CONFIG,
    configPresent: true,
    evidenceStore: spy.store,
    voiceSpeechRequest: stubSpeak(outcome).fn,
  });
}

// Collects every string value recursively present across all put call arguments. Used to assert
// that no sensitive substring appears in any argument of any put invocation.
function allPutStrings(put: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(put.mock.calls);
}

// ─── Test suite ───────────────────────────────────────────────────────────────────────────────

describe("voice dialogue path — no raw/generated audio or transcript persistence (Issue #1562)", () => {
  // ── Transcribe: happy path ──────────────────────────────────────────────────────────────────

  describe("POST /api/voice/transcribe — non-persistence (AC1 D2)", () => {
    it("does not call evidenceStore.put on a successful dictation (raw audio is never persisted)", async () => {
      // Arrange
      const spy = spyingStore();
      const deps = sttDeps(spy);

      // Act
      const result = await handleVoiceTranscribe(
        transcribeCtx({
          audio: VALID_AUDIO_B64,
          mimeType: "audio/webm",
          durationMs: 3000,
          language: "en",
        }),
        deps,
      );

      // Assert: the route succeeds and put is never called
      expect(result.status).toBe(200);
      expect(spy.put).not.toHaveBeenCalled();
    });

    it("does not persist the raw audio base64 to the evidence store (no accidental serialization)", async () => {
      // Arrange: the raw audio b64 encodes RAW_AUDIO_TEXT — if it leaks into put, JSON.stringify
      // of the spy args will contain the marker substring.
      const spy = spyingStore();
      const deps = sttDeps(spy);

      // Act
      await handleVoiceTranscribe(
        transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
        deps,
      );

      // Assert: the raw audio marker never appears in any put argument
      expect(allPutStrings(spy.put)).not.toContain(RAW_AUDIO_TEXT);
    });

    it("does not persist the transcript text returned from the STT provider", async () => {
      // Arrange: provider returns a recognizable transcript
      const distinctTranscript = "KEIKO-TRANSCRIPT-THAT-MUST-NOT-BE-PERSISTED-1562";
      const spy = spyingStore();
      const deps = sttDeps(spy, { ok: true, value: { transcript: distinctTranscript } });

      // Act
      const result = await handleVoiceTranscribe(
        transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
        deps,
      );

      // Assert: the transcript reaches the response body but not the evidence store
      expect((result.body as { transcript: string }).transcript).toBe(distinctTranscript);
      expect(spy.put).not.toHaveBeenCalled();
      expect(allPutStrings(spy.put)).not.toContain(distinctTranscript);
    });
  });

  // ── Transcribe: failure paths ───────────────────────────────────────────────────────────────

  describe("POST /api/voice/transcribe — non-persistence under provider failure (AC1 D2)", () => {
    it.each([
      ["rate-limited", 429],
      ["timeout", 504],
      ["payload-too-large", 413],
      ["unsupported-model", 503],
      ["transport", 502],
      ["tls-ca-failure", 502],
      ["invalid-response", 502],
      ["cancelled", 502],
    ] as const)(
      "does not call evidenceStore.put when provider fails with %s",
      async (kind, expectedStatus) => {
        // Arrange
        const spy = spyingStore();
        const deps = sttDeps(spy, { ok: false, kind });

        // Act
        const result = await handleVoiceTranscribe(
          transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
          deps,
        );

        // Assert: the failure envelope is returned but nothing reaches the evidence store
        expect(result.status).toBe(expectedStatus);
        expect(spy.put).not.toHaveBeenCalled();
      },
    );

    it("failure body does not contain the provider secret or base URL (non-persistence companion)", async () => {
      // This assertion is the non-persistence companion: the failure envelope is the unique
      // contribution here (confirming that the route remains side-effect-free under failure).
      const spy = spyingStore();
      const deps = sttDeps(spy, { ok: false, kind: "transport" });

      const result = await handleVoiceTranscribe(
        transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
        deps,
      );

      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain(PROVIDER_SECRET);
      expect(serialized).not.toContain(PROVIDER_BASE_URL);
      // And just as importantly, put itself was never invoked
      expect(spy.put).not.toHaveBeenCalled();
    });
  });

  // ── Speak: happy path ───────────────────────────────────────────────────────────────────────

  describe("POST /api/voice/speak — non-persistence (AC1 D2)", () => {
    it("does not call evidenceStore.put on a successful synthesis (generated audio is never persisted)", async () => {
      // Arrange
      const spy = spyingStore();
      const deps = ttsDeps(spy);

      // Act
      const result = await handleVoiceSpeak(speakCtx(), deps);

      // Assert: the route succeeds and put is never called
      expect(result.status).toBe(200);
      expect(spy.put).not.toHaveBeenCalled();
    });

    it("returns the generated audio as base64 in the response body (audio is delivered, not dropped)", async () => {
      // Arrange: confirm the route actually returns the audio so we know the non-persistence
      // guarantee is meaningful — the audio reaches the browser but not the evidence store.
      const spy = spyingStore();
      const deps = ttsDeps(spy);

      // Act
      const result = await handleVoiceSpeak(speakCtx({ text: ASSISTANT_TEXT }), deps);

      // Assert: the response body contains the expected base64 audio
      expect(result.status).toBe(200);
      const body = result.body as { audio: string; mimeType: string };
      expect(Buffer.from(body.audio, "base64").toString("utf8")).toBe(GENERATED_AUDIO_TEXT);
    });

    it("does not persist the generated audio base64 to the evidence store", async () => {
      // Arrange: generated audio encodes GENERATED_AUDIO_TEXT — if put were called with the
      // audio buffer or its base64 representation, the marker would appear in spy args.
      const spy = spyingStore();
      const deps = ttsDeps(spy);

      // Act
      const result = await handleVoiceSpeak(speakCtx({ text: ASSISTANT_TEXT }), deps);

      // Assert: the audio is in the response but not in any put call argument
      expect(result.status).toBe(200);
      const body = result.body as { audio: string };
      expect(body.audio.length).toBeGreaterThan(0);
      // The GENERATED_AUDIO_TEXT marker must not appear anywhere in the put args
      expect(allPutStrings(spy.put)).not.toContain(GENERATED_AUDIO_TEXT);
      // The base64-encoded form must not appear either
      expect(allPutStrings(spy.put)).not.toContain(body.audio);
    });

    it("does not persist the assistant input text to the evidence store", async () => {
      // Arrange: use a distinctive input text that would be detectable if serialized into put args
      const spy = spyingStore();
      const deps = ttsDeps(spy);

      // Act
      const result = await handleVoiceSpeak(speakCtx({ text: ASSISTANT_TEXT }), deps);

      // Assert: the input text is forwarded to the provider but never reaches the evidence store
      expect(result.status).toBe(200);
      expect(spy.put).not.toHaveBeenCalled();
      expect(allPutStrings(spy.put)).not.toContain(ASSISTANT_TEXT);
    });
  });

  // ── Speak: failure paths ────────────────────────────────────────────────────────────────────

  describe("POST /api/voice/speak — non-persistence under provider failure (AC1 D2)", () => {
    it.each([
      ["rate-limited", 429],
      ["timeout", 504],
      ["payload-too-large", 413],
      ["unsupported-model", 503],
      ["transport", 502],
      ["empty-audio", 502],
      ["invalid-response", 502],
      ["tls-ca-failure", 502],
    ] as const)(
      "does not call evidenceStore.put when TTS provider fails with %s",
      async (kind, expectedStatus) => {
        // Arrange
        const spy = spyingStore();
        const deps = ttsDeps(spy, { ok: false, kind });

        // Act
        const result = await handleVoiceSpeak(speakCtx(), deps);

        // Assert: the failure envelope is returned and the evidence store is untouched
        expect(result.status).toBe(expectedStatus);
        expect(spy.put).not.toHaveBeenCalled();
      },
    );

    it("failure body does not contain the provider secret or base URL under TTS failure", async () => {
      // The failure envelope is the static redacted shape — no provider detail, no credential.
      const spy = spyingStore();
      const deps = ttsDeps(spy, { ok: false, kind: "transport" });

      const result = await handleVoiceSpeak(speakCtx(), deps);

      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain(PROVIDER_SECRET);
      expect(serialized).not.toContain(PROVIDER_BASE_URL);
      // And the store was not written either
      expect(spy.put).not.toHaveBeenCalled();
    });
  });

  // ── Cross-cutting: input text leaks ────────────────────────────────────────────────────────

  describe("combined dialogue round-trip — no content reaches evidence store", () => {
    it("a full dictation → speak round-trip triggers zero evidence store writes", async () => {
      // Arrange: one spying store shared to detect any write across both route legs
      const spy = spyingStore();
      const stt = sttDeps(spy);
      const tts = ttsDeps(spy);

      // Act: leg 1 — dictation
      const transcribeResult = await handleVoiceTranscribe(
        transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
        stt,
      );
      // Act: leg 2 — synthesis (simulates the assistant reply being spoken)
      const speakResult = await handleVoiceSpeak(speakCtx({ text: ASSISTANT_TEXT }), tts);

      // Assert: both routes complete successfully and the evidence store is never written
      expect(transcribeResult.status).toBe(200);
      expect(speakResult.status).toBe(200);
      expect(spy.put).not.toHaveBeenCalled();
    });

    it("zero put calls even when the transcribe leg succeeds and the speak leg fails", async () => {
      // Arrange: a degraded path where STT succeeds but TTS is rate-limited
      const spy = spyingStore();
      const stt = sttDeps(spy, sttOk());
      const tts = ttsDeps(spy, { ok: false, kind: "rate-limited" });

      // Act
      const transcribeResult = await handleVoiceTranscribe(
        transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
        stt,
      );
      const speakResult = await handleVoiceSpeak(speakCtx({ text: ASSISTANT_TEXT }), tts);

      // Assert: the partial failure still leaves the evidence store pristine
      expect(transcribeResult.status).toBe(200);
      expect(speakResult.status).toBe(429);
      expect(spy.put).not.toHaveBeenCalled();
    });

    it("zero put calls when both legs fail with different provider errors", async () => {
      // Arrange: both routes fail — the evidence store must still be untouched
      const spy = spyingStore();
      const stt = sttDeps(spy, { ok: false, kind: "timeout" });
      const tts = ttsDeps(spy, { ok: false, kind: "transport" });

      // Act
      const transcribeResult = await handleVoiceTranscribe(
        transcribeCtx({ audio: VALID_AUDIO_B64, mimeType: "audio/webm" }),
        stt,
      );
      const speakResult = await handleVoiceSpeak(speakCtx({ text: ASSISTANT_TEXT }), tts);

      // Assert: dual failure path — still zero evidence store writes
      expect(transcribeResult.status).toBe(504);
      expect(speakResult.status).toBe(502);
      expect(spy.put).not.toHaveBeenCalled();
    });
  });
});
