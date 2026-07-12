import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { handleVoiceSpeak, handleVoiceSpeakStream } from "./voice-handlers.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { STREAMING, type RouteContext, type RouteResult } from "./routes.js";
import type {
  GatewayConfig,
  TextToSpeechOutcome,
  TextToSpeechRequest,
  TextToSpeechStreamOutcome,
} from "@oscharko-dev/keiko-model-gateway";

const PROVIDER_SECRET = "voice-tts-secret-token-1234567890";
const PROVIDER_BASE_URL = "https://keiko-tts.example.com";
const MAPPED_FEMALE_VOICE = "verse-internal-voice-id-998877";
const AUDIO_MARKER = "KEIKO-SPOKEN-AUDIO-BYTES";

// A speech-output voice provider whose credential-tier voiceProfiles map personas to provider voice
// ids (Issue #1557 seam). The voice id is sensitive and must never appear in any BFF response.
const SPEECH_OUTPUT_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "keiko-tts",
      baseUrl: PROVIDER_BASE_URL,
      apiKey: PROVIDER_SECRET,
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
      voiceProfiles: [
        { persona: "female", voiceId: MAPPED_FEMALE_VOICE },
        { persona: "male", voiceId: "ember-internal-voice-id-112233" },
      ],
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
      supportsSpeechSynthesisInstructions: true,
      supportedVoicePersonas: ["female", "male"],
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

// A speech-output provider WITHOUT any persona mapping: synthesis still works with the adapter's
// default voice (no voiceProfiles configured).
const SPEECH_OUTPUT_NO_PERSONA_CONFIG: GatewayConfig = {
  ...SPEECH_OUTPUT_CONFIG,
  providers: [
    {
      modelId: "keiko-tts",
      baseUrl: PROVIDER_BASE_URL,
      apiKey: PROVIDER_SECRET,
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
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

// An STT-only provider: dictation but no speech output. The speak route must report unavailable.
const STT_ONLY_CONFIG: GatewayConfig = {
  ...SPEECH_OUTPUT_CONFIG,
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
      supportsSpeechOutput: false,
      supportedVoicePersonas: [],
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

function audioBytes(): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder().encode(AUDIO_MARKER);
  const bytes = new Uint8Array(text.byteLength);
  bytes.set(text);
  return bytes;
}

function audioOk(): TextToSpeechOutcome {
  return {
    ok: true,
    value: {
      audio: audioBytes(),
      mimeType: "audio/mpeg",
    },
  };
}

function ctx(body: unknown): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/voice/speak"),
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

function stubSpeak(outcome: TextToSpeechOutcome): {
  fn: (request: TextToSpeechRequest) => Promise<TextToSpeechOutcome>;
  seen: TextToSpeechRequest[];
} {
  const seen: TextToSpeechRequest[] = [];
  return {
    fn: (request: TextToSpeechRequest): Promise<TextToSpeechOutcome> => {
      seen.push(request);
      return Promise.resolve(outcome);
    },
    seen,
  };
}

function speakDeps(
  overrides: Partial<UiHandlerDeps> = {},
  outcome: TextToSpeechOutcome = audioOk(),
): { deps: UiHandlerDeps; seen: TextToSpeechRequest[] } {
  const stub = stubSpeak(outcome);
  const deps = depsWith({
    config: SPEECH_OUTPUT_CONFIG,
    configPresent: true,
    voiceSpeechRequest: stub.fn,
    ...overrides,
  });
  return { deps, seen: stub.seen };
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe("POST /api/voice/speak — capability gate (AC1/AC4)", () => {
  it("returns 503 VOICE_UNAVAILABLE when no config is resolved", async () => {
    const result = await handleVoiceSpeak(ctx({ text: "hello" }), depsWith({}));
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: { code: "VOICE_UNAVAILABLE", message: "Assistant speech output is not available." },
    });
  });

  it("returns 503 VOICE_UNAVAILABLE for a no-voice (chat-only) deployment", async () => {
    const result = await handleVoiceSpeak(
      ctx({ text: "hello" }),
      depsWith({ config: CHAT_ONLY_CONFIG, configPresent: true }),
    );
    expect(result.status).toBe(503);
    expect(errorCode(result.body)).toBe("VOICE_UNAVAILABLE");
  });

  it("returns 503 VOICE_UNAVAILABLE for an STT-only deployment with no speech output", async () => {
    const { deps } = speakDeps({ config: STT_ONLY_CONFIG });
    const result = await handleVoiceSpeak(ctx({ text: "hello" }), deps);
    expect(result.status).toBe(503);
    expect(errorCode(result.body)).toBe("VOICE_UNAVAILABLE");
  });

  it("returns 503 VOICE_UNAVAILABLE when voice is disabled by policy, even with a provider", async () => {
    const { deps, seen } = speakDeps({ env: { KEIKO_VOICE_DISABLED: "1" } });
    const result = await handleVoiceSpeak(ctx({ text: "hello" }), deps);
    expect(result.status).toBe(503);
    expect(errorCode(result.body)).toBe("VOICE_UNAVAILABLE");
    // The synthesis seam is never called for a disabled deployment (zero provider work).
    expect(seen).toHaveLength(0);
  });
});

describe("POST /api/voice/speak — successful synthesis (AC1/AC2)", () => {
  it("synthesizes the visible answer against the configured provider and returns base64 audio", async () => {
    const { deps, seen } = speakDeps();
    const answer = "This is exactly the assistant text shown in the transcript.";
    const result = await handleVoiceSpeak(ctx({ text: answer }), deps);
    expect(result.status).toBe(200);
    const body = result.body as { audio: string; mimeType: string };
    expect(Buffer.from(body.audio, "base64").toString("utf8")).toBe(AUDIO_MARKER);
    expect(body.mimeType).toBe("audio/mpeg");
    // The exact visible text is forwarded to the configured provider (AC2: spoken == visible).
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endpoint).toBe(PROVIDER_BASE_URL);
    expect(seen[0]?.apiKey).toBe(PROVIDER_SECRET);
    expect(seen[0]?.modelId).toBe("keiko-tts");
    expect(seen[0]?.input).toBe(answer);
    expect(seen[0]?.instructions).toContain("thoughtful colleague");
    expect(seen[0]?.instructions).toContain("careful articulation and moderate vocal effort");
    // The interactive speak path requests opus (audio/ogg): faster to first audio and ~4x smaller
    // than the previous mp3 default (measured against the live endpoint).
    expect(seen[0]?.responseFormat).toBe("opus");
  });

  it("sends speech-friendly prose while the visible answer keeps clickable Markdown sources", async () => {
    const { deps, seen } = speakDeps();
    const visible =
      "See [the runbook](https://example.invalid/runbook?token=secret) [1].\n\n### Sources\n- [1] [Runbook](https://example.invalid/runbook)";

    const result = await handleVoiceSpeak(ctx({ text: visible }), deps);

    expect(result.status).toBe(200);
    expect(seen[0]?.input).toBe("See the runbook.");
    expect(seen[0]?.input).not.toContain("https://");
    expect(seen[0]?.input).not.toContain("[1]");
  });

  it("resolves the persona → voice id server-side and never returns the voice id (content-free)", async () => {
    const { deps, seen } = speakDeps();
    const result = await handleVoiceSpeak(ctx({ text: "spoken answer", persona: "female" }), deps);
    expect(result.status).toBe(200);
    // The mapped provider voice id is forwarded to the provider...
    expect(seen[0]?.voice).toBe(MAPPED_FEMALE_VOICE);
    // ...but never appears in the response body, nor does the secret or base URL.
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(MAPPED_FEMALE_VOICE);
    expect(serialized).not.toContain(PROVIDER_SECRET);
    expect(serialized).not.toContain(PROVIDER_BASE_URL);
  });

  it("falls back to a persona-mapped voice in canonical order when none is requested", async () => {
    const { deps, seen } = speakDeps();
    await handleVoiceSpeak(ctx({ text: "spoken answer" }), deps);
    // Canonical order is male, female, neutral; male is mapped first.
    expect(seen[0]?.voice).toBe("ember-internal-voice-id-112233");
  });

  it("synthesizes with the adapter default voice when the provider maps no personas", async () => {
    const { deps, seen } = speakDeps({ config: SPEECH_OUTPUT_NO_PERSONA_CONFIG });
    const result = await handleVoiceSpeak(ctx({ text: "spoken answer" }), deps);
    expect(result.status).toBe(200);
    // No voice id is pinned by the BFF; the adapter applies its provider-neutral default.
    expect(seen[0]?.voice).toBeUndefined();
  });

  it("falls back to a mapped voice in canonical order when the requested persona is unmapped", async () => {
    // SPEECH_OUTPUT_CONFIG maps female + male but NOT neutral. A request for the unmapped persona must
    // still synthesize, using the first persona-mapped provider in canonical order (male) rather than
    // rejecting (D4 fallback contract).
    const { deps, seen } = speakDeps();
    const result = await handleVoiceSpeak(ctx({ text: "spoken answer", persona: "neutral" }), deps);
    expect(result.status).toBe(200);
    expect(seen[0]?.voice).toBe("ember-internal-voice-id-112233");
  });
});

describe("POST /api/voice/speak — request validation", () => {
  it("returns 400 INVALID_TEXT when text is missing or empty", async () => {
    const { deps } = speakDeps();
    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }]) {
      const result = await handleVoiceSpeak(ctx(body), deps);
      expect(result.status).toBe(400);
      expect(errorCode(result.body)).toBe("INVALID_TEXT");
    }
  });

  it("returns 413 PAYLOAD_TOO_LARGE when the answer exceeds the synthesis input bound", async () => {
    const { deps, seen } = speakDeps();
    const result = await handleVoiceSpeak(ctx({ text: "a".repeat(4097) }), deps);
    expect(result.status).toBe(413);
    expect(errorCode(result.body)).toBe("PAYLOAD_TOO_LARGE");
    // Over-long text is rejected before any provider call (it is never truncated — AC2).
    expect(seen).toHaveLength(0);
  });

  it("returns 400 INVALID_PERSONA for an unsupported persona", async () => {
    const { deps } = speakDeps();
    const result = await handleVoiceSpeak(ctx({ text: "hi", persona: "robot" }), deps);
    expect(result.status).toBe(400);
    expect(errorCode(result.body)).toBe("INVALID_PERSONA");
  });
});

describe("POST /api/voice/speak — provider failure mapping (AC4)", () => {
  it.each([
    ["rate-limited", 429, "VOICE_RATE_LIMITED"],
    ["timeout", 504, "VOICE_TIMEOUT"],
    ["payload-too-large", 413, "PAYLOAD_TOO_LARGE"],
    ["unsupported-model", 503, "VOICE_UNAVAILABLE"],
    ["transport", 502, "VOICE_PROVIDER_ERROR"],
    ["empty-audio", 502, "VOICE_PROVIDER_ERROR"],
    ["invalid-response", 502, "VOICE_PROVIDER_ERROR"],
    ["tls-ca-failure", 502, "VOICE_PROVIDER_ERROR"],
  ] as const)("maps adapter failure %s to HTTP %i %s", async (kind, status, code) => {
    const { deps } = speakDeps({}, { ok: false, kind });
    const result = await handleVoiceSpeak(ctx({ text: "hello" }), deps);
    expect(result.status).toBe(status);
    expect(errorCode(result.body)).toBe(code);
    // No provider body, URL, or secret is ever interpolated into a failure envelope.
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(PROVIDER_SECRET);
    expect(serialized).not.toContain(PROVIDER_BASE_URL);
  });
});

// A minimal ServerResponse fake capturing the streaming write path.
class FakeRes extends EventEmitter {
  statusCode: number | undefined;
  headers: Record<string, string> | undefined;
  readonly chunks: Uint8Array[] = [];
  ended = false;
  destroyed = false;
  private writeCount = 0;

  constructor(private readonly backpressureAt?: number) {
    super();
  }
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  write(chunk: Uint8Array): boolean {
    this.chunks.push(chunk);
    this.writeCount += 1;
    if (this.writeCount === this.backpressureAt) {
      queueMicrotask(() => this.emit("drain"));
      return false;
    }
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks[i];
      if (chunk !== undefined) {
        i += 1;
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
}

function streamCtx(body: unknown, res: FakeRes): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: res as unknown as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/voice/speak/stream"),
    correlationId: "voice-stream-test",
  };
}

function streamOk(
  body: ReadableStream<Uint8Array>,
  mimeType = "audio/pcm",
): TextToSpeechStreamOutcome {
  return { ok: true, value: { body, mimeType } };
}

describe("POST /api/voice/speak/stream", () => {
  it("requests pcm, streams the provider bytes with audio/pcm, and returns STREAMING", async () => {
    const seen: TextToSpeechRequest[] = [];
    const res = new FakeRes();
    const deps = depsWith({
      config: SPEECH_OUTPUT_CONFIG,
      configPresent: true,
      voiceSpeechStreamRequest: (
        request: TextToSpeechRequest,
      ): Promise<TextToSpeechStreamOutcome> => {
        seen.push(request);
        return Promise.resolve(
          streamOk(streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])),
        );
      },
    });

    const outcome = await handleVoiceSpeakStream(streamCtx({ text: "spoken answer" }, res), deps);
    expect(outcome).toBe(STREAMING);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("audio/pcm");
    expect(Buffer.concat(res.chunks.map((c) => Buffer.from(c)))).toEqual(
      Buffer.from([1, 2, 3, 4, 5]),
    );
    expect(res.ended).toBe(true);
    // The streaming path requests raw pcm (fastest to first audio).
    expect(seen[0]?.responseFormat).toBe("pcm");
    expect(seen[0]?.signal).toBeDefined();
  });

  it("waits for response drain under backpressure without truncating the PCM stream", async () => {
    const res = new FakeRes(1);
    const deps = depsWith({
      config: SPEECH_OUTPUT_CONFIG,
      configPresent: true,
      voiceSpeechStreamRequest: (): Promise<TextToSpeechStreamOutcome> =>
        Promise.resolve(streamOk(streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]))),
    });

    const outcome = await handleVoiceSpeakStream(streamCtx({ text: "spoken answer" }, res), deps);

    expect(outcome).toBe(STREAMING);
    expect(Buffer.concat(res.chunks.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6]),
    );
    expect(res.destroyed).toBe(false);
    expect(res.ended).toBe(true);
  });

  it("returns a coded error RouteResult BEFORE any headers when synthesis fails", async () => {
    const res = new FakeRes();
    const deps = depsWith({
      config: SPEECH_OUTPUT_CONFIG,
      configPresent: true,
      voiceSpeechStreamRequest: (): Promise<TextToSpeechStreamOutcome> =>
        Promise.resolve({ ok: false, kind: "rate-limited" }),
    });
    const outcome = await handleVoiceSpeakStream(streamCtx({ text: "spoken answer" }, res), deps);
    expect(outcome).not.toBe(STREAMING);
    expect((outcome as RouteResult).status).toBe(429);
    expect(res.statusCode).toBeUndefined(); // never committed a 200 + audio headers
    expect(res.ended).toBe(false);
  });

  it("emits a redacted diagnostic when a committed provider stream fails", async () => {
    const res = new FakeRes();
    const diagnostics: string[] = [];
    const failed = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("stream transport failed"));
      },
    });
    const deps = depsWith({
      config: SPEECH_OUTPUT_CONFIG,
      configPresent: true,
      diagnostics: {
        record: (record): void => {
          diagnostics.push(record.operation);
        },
      },
      voiceSpeechStreamRequest: (): Promise<TextToSpeechStreamOutcome> =>
        Promise.resolve(streamOk(failed)),
    });

    const outcome = await handleVoiceSpeakStream(streamCtx({ text: "spoken answer" }, res), deps);

    expect(outcome).toBe(STREAMING);
    expect(diagnostics).toEqual(["voice.speech.stream"]);
    expect(res.ended).toBe(true);
  });

  it("returns 503 VOICE_UNAVAILABLE for an STT-only deployment (no streaming)", async () => {
    const res = new FakeRes();
    const outcome = await handleVoiceSpeakStream(
      streamCtx({ text: "x" }, res),
      depsWith({ config: STT_ONLY_CONFIG, configPresent: true }),
    );
    expect((outcome as RouteResult).status).toBe(503);
    expect(res.statusCode).toBeUndefined();
  });
});
