import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { handleVoiceTranscribe } from "./voice-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext } from "./routes.js";
import type {
  GatewayConfig,
  SpeechToTextOutcome,
  SpeechToTextRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";

const PROVIDER_SECRET = "voice-secret-token-1234567890";
const PROVIDER_BASE_URL = "https://keiko-stt.example.com";

// A configured STT-only voice provider shaped like the existing keiko-stt deployment (Issue #493/#494).
const VOICE_STT_CONFIG: GatewayConfig = {
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

// A chat-only (no voice) config — the regulated no-voice baseline.
const CHAT_ONLY_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "example-chat-model",
      baseUrl: "https://api.example.com",
      apiKey: "example-test-token-1234567890",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "example-chat-model",
      kind: "chat",
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: false,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "",
      preferredUseCases: [],
      knownLimitations: [],
    },
  ],
};

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const VALID_AUDIO = b64("keiko-dictation-audio-bytes");

function ctx(body: unknown): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/voice/transcribe"),
  };
}

function spyingStore(): { store: EvidenceStore; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn(() => "");
  return {
    store: { put, list: () => [], get: () => undefined, delete: () => undefined },
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

// A stub STT seam that records the forwarded request and returns a fixed outcome.
function stubTranscribe(outcome: SpeechToTextOutcome): {
  fn: (request: SpeechToTextRequest) => Promise<SpeechToTextOutcome>;
  seen: SpeechToTextRequest[];
} {
  const seen: SpeechToTextRequest[] = [];
  return {
    fn: (request: SpeechToTextRequest): Promise<SpeechToTextOutcome> => {
      seen.push(request);
      return Promise.resolve(outcome);
    },
    seen,
  };
}

function sttDeps(
  overrides: Partial<UiHandlerDeps> = {},
  outcome: SpeechToTextOutcome = { ok: true, value: { transcript: "the quick brown fox" } },
): { deps: UiHandlerDeps; seen: SpeechToTextRequest[] } {
  const stub = stubTranscribe(outcome);
  const deps = depsWith({
    config: VOICE_STT_CONFIG,
    configPresent: true,
    voiceTranscriptionRequest: stub.fn,
    ...overrides,
  });
  return { deps, seen: stub.seen };
}

describe("POST /api/voice/transcribe — capability gate (AC1/AC2)", () => {
  it("returns 503 VOICE_UNAVAILABLE when no config is resolved (AC1)", async () => {
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      depsWith({}),
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: { code: "VOICE_UNAVAILABLE", message: "Speech-to-text dictation is not available." },
    });
  });

  it("returns 503 VOICE_UNAVAILABLE for a no-voice (chat-only) deployment (AC1)", async () => {
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      depsWith({ config: CHAT_ONLY_CONFIG, configPresent: true }),
    );
    expect(result.status).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe("VOICE_UNAVAILABLE");
  });

  it("returns 503 VOICE_UNAVAILABLE when voice is disabled by policy, even with a provider (AC2)", async () => {
    const { deps } = sttDeps({ env: { KEIKO_VOICE_DISABLED: "1" } });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe("VOICE_UNAVAILABLE");
  });

  it("does not call the STT seam when the route is unavailable", async () => {
    const { deps, seen } = sttDeps({ env: { KEIKO_VOICE_DISABLED: "true" } });
    await handleVoiceTranscribe(ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }), deps);
    expect(seen).toHaveLength(0);
  });

  it("returns 503 VOICE_UNAVAILABLE for a speech-output-only (TTS) deployment with no dictation (AC1)", async () => {
    // available=true (profile speech-output) but capabilities.speechToText=false — exercises the
    // explicit `!voice.capabilities.speechToText` gate, distinct from the `!voice.available` branch.
    const ttsOnly: GatewayConfig = {
      ...VOICE_STT_CONFIG,
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
          supportsSpeechOutput: true,
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
    const { deps } = sttDeps({ config: ttsOnly });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe("VOICE_UNAVAILABLE");
  });
});

describe("POST /api/voice/transcribe — successful dictation (AC3/AC4/AC6)", () => {
  it("transcribes against the configured keiko-stt provider and returns the transcript (AC6)", async () => {
    const { deps, seen } = sttDeps();
    const result = await handleVoiceTranscribe(
      ctx({
        audio: VALID_AUDIO,
        mimeType: "audio/webm;codecs=opus",
        durationMs: 4000,
        language: "en",
      }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ transcript: "the quick brown fox" });
    // The audio was forwarded to the configured provider only (AC3 routing), with the normalized MIME.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endpoint).toBe(PROVIDER_BASE_URL);
    expect(seen[0]?.apiKey).toBe(PROVIDER_SECRET);
    expect(seen[0]?.modelId).toBe("keiko-stt");
    expect(seen[0]?.mimeType).toBe("audio/webm");
    expect(seen[0]?.language).toBe("en");
    expect(Buffer.from(seen[0]?.audio ?? new Uint8Array()).toString("utf8")).toBe(
      "keiko-dictation-audio-bytes",
    );
  });

  it("surfaces content-free provider metadata when present", async () => {
    const { deps } = sttDeps(
      {},
      { ok: true, value: { transcript: "hi", confidence: 0.9, language: "en", durationMs: 1500 } },
    );
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.body).toEqual({
      transcript: "hi",
      confidence: 0.9,
      language: "en",
      durationMs: 1500,
    });
  });

  it("never returns the provider base URL or credential to the browser (AC4)", async () => {
    const { deps } = sttDeps();
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    const json = JSON.stringify(result.body);
    expect(json).not.toContain(PROVIDER_SECRET);
    expect(json).not.toContain(PROVIDER_BASE_URL);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("baseUrl");
  });

  it("does not persist audio to the evidence store (AC3)", async () => {
    const { store, put } = spyingStore();
    const { deps } = sttDeps({ evidenceStore: store });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/transcribe — request validation (D3/D5)", () => {
  it("rejects a missing or unsupported audio MIME type (415-class → 400)", async () => {
    const { deps } = sttDeps();
    const noMime = await handleVoiceTranscribe(ctx({ audio: VALID_AUDIO }), deps);
    expect(noMime.status).toBe(400);
    expect((noMime.body as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_AUDIO_FORMAT",
    );
    const badMime = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "text/plain" }),
      deps,
    );
    expect((badMime.body as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_AUDIO_FORMAT",
    );
  });

  it("rejects empty or non-base64 audio", async () => {
    const { deps } = sttDeps();
    const empty = await handleVoiceTranscribe(ctx({ audio: "", mimeType: "audio/webm" }), deps);
    expect(empty.status).toBe(400);
    expect((empty.body as { error: { code: string } }).error.code).toBe("INVALID_AUDIO");
    const garbage = await handleVoiceTranscribe(
      ctx({ audio: "!!!not base64!!!", mimeType: "audio/webm" }),
      deps,
    );
    expect((garbage.body as { error: { code: string } }).error.code).toBe("INVALID_AUDIO");
  });

  it("rejects an oversized audio clip with 413 (D5 oversized, decoded-audio cap)", async () => {
    const { deps, seen } = sttDeps();
    const tooBig = Buffer.alloc(4_000_001).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: tooBig, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(413);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    // Distinct from the envelope cap below: this is the post-decode audio-bytes guard.
    expect(body.error.message).toContain("audio clip exceeds the size limit");
    expect(seen).toHaveLength(0);
  });

  it("rejects an oversized JSON request envelope with 413 before any audio work (D5, MAX_BODY_BYTES)", async () => {
    const { deps, seen } = sttDeps();
    // Stream > 6 MB across multiple chunks so readBody's accumulation guard rejects before JSON.parse.
    const chunks = Array.from({ length: 7 }, () => Buffer.alloc(1_000_000, 120));
    const req = Readable.from(chunks) as IncomingMessage;
    const result = await handleVoiceTranscribe(
      {
        req,
        res: {} as RouteContext["res"],
        params: {},
        url: new URL("http://127.0.0.1/api/voice/transcribe"),
      },
      deps,
    );
    expect(result.status).toBe(413);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    // The envelope-cap branch carries its own message, distinct from the decoded-audio cap above.
    expect(body.error.message).toBe("Request body exceeds the size limit.");
    // AC3: no audio is forwarded to the provider when the envelope is rejected.
    expect(seen).toHaveLength(0);
  });

  it("accepts on-boundary audio size and duration (off-by-one mutation trap)", async () => {
    const { deps, seen } = sttDeps();
    const exactAudio = Buffer.alloc(4_000_000).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: exactAudio, mimeType: "audio/webm", durationMs: 120_000 }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.audio.byteLength).toBe(4_000_000);
  });

  it("rejects an invalid declared duration", async () => {
    const { deps } = sttDeps();
    for (const durationMs of [-1, 0, 1.5, 120_001, "10"]) {
      const result = await handleVoiceTranscribe(
        ctx({ audio: VALID_AUDIO, mimeType: "audio/webm", durationMs }),
        deps,
      );
      expect(result.status).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe("INVALID_DURATION");
    }
  });

  it("rejects an invalid language tag", async () => {
    const { deps } = sttDeps();
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm", language: "not a lang!!" }),
      deps,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("INVALID_LANGUAGE");
  });

  it("rejects a non-JSON body deterministically", async () => {
    const { deps } = sttDeps();
    const req = Readable.from([Buffer.from("not json", "utf8")]) as IncomingMessage;
    const result = await handleVoiceTranscribe(
      {
        req,
        res: {} as RouteContext["res"],
        params: {},
        url: new URL("http://127.0.0.1/api/voice/transcribe"),
      },
      deps,
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("POST /api/voice/transcribe — provider failure mapping (AC5)", () => {
  it.each([
    ["rate-limited", 429, "VOICE_RATE_LIMITED"],
    ["timeout", 504, "VOICE_TIMEOUT"],
    ["payload-too-large", 413, "PAYLOAD_TOO_LARGE"],
    ["unsupported-model", 503, "VOICE_UNAVAILABLE"],
    ["wrong-header", 502, "VOICE_PROVIDER_ERROR"],
    ["transport", 502, "VOICE_PROVIDER_ERROR"],
    ["proxy-unreachable", 502, "VOICE_PROVIDER_ERROR"],
    ["proxy-auth-required", 502, "VOICE_PROVIDER_ERROR"],
    ["proxy-egress-failed", 502, "VOICE_PROVIDER_ERROR"],
    ["proxy-blocked-by-policy", 502, "VOICE_PROVIDER_ERROR"],
    ["tls-ca-failure", 502, "VOICE_PROVIDER_ERROR"],
    ["invalid-response", 502, "VOICE_PROVIDER_ERROR"],
    ["cancelled", 502, "VOICE_PROVIDER_ERROR"],
  ] as const)("maps provider failure %s to %i %s", async (kind, status, code) => {
    const { deps } = sttDeps({}, { ok: false, kind });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(status);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe(code);
    // Deterministic, secret-free message: no provider URL or credential leaks (AC5).
    expect(body.error.message).not.toContain(PROVIDER_SECRET);
    expect(body.error.message).not.toContain(PROVIDER_BASE_URL);
  });

  it("produces a deterministic response for the same failure input (AC5)", async () => {
    const first = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      sttDeps({}, { ok: false, kind: "transport" }).deps,
    );
    const second = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      sttDeps({}, { ok: false, kind: "transport" }).deps,
    );
    expect(first).toEqual(second);
  });
});
