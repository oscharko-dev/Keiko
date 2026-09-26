import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
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
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

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

class FakeResponse extends EventEmitter {
  destroyed = false;
  closed = false;
  writableEnded = false;

  public override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "close") {
      this.destroyed = true;
      this.closed = true;
    }
    return super.emit(event, ...args);
  }
}

function voiceContext(
  body: unknown,
  correlationId?: string,
): {
  readonly context: RouteContext;
  readonly request: IncomingMessage;
  readonly response: FakeResponse;
} {
  const request = Readable.from([Buffer.from(JSON.stringify(body), "utf8")], {
    autoDestroy: false,
  }) as IncomingMessage;
  const response = new FakeResponse();
  return {
    request,
    response,
    context: {
      req: request,
      res: response as unknown as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/voice/transcribe"),
      correlationId,
    },
  };
}

function ctx(body: unknown, correlationId?: string): RouteContext {
  return voiceContext(body, correlationId).context;
}

function spyingStore(): { store: EvidenceStore; put: ReturnType<typeof vi.fn> } {
  const put = vi.fn(() => "");
  return {
    store: { put, list: () => [], get: () => undefined, delete: () => undefined },
    put,
  };
}

// Capturing operator-diagnostic sink (never the default stderr sink) for the Finding 2 (#2895
// audit) observability pins — same pattern as gateway-readiness.test.ts / gateway-setup.test.ts.
function capturingDiagnostics(): {
  readonly sink: ServerDiagnosticSink;
  readonly records: ServerDiagnosticRecord[];
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    records,
    sink: {
      record: (entry: ServerDiagnosticRecord): void => {
        records.push(entry);
      },
    },
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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  it("aborts transcription and removes lifecycle listeners on client disconnect", async () => {
    const fixture = voiceContext({ audio: VALID_AUDIO, mimeType: "audio/webm" });
    const captured = deferred<SpeechToTextRequest>();
    const deps = depsWith({
      config: VOICE_STT_CONFIG,
      configPresent: true,
      voiceTranscriptionRequest: (request): Promise<SpeechToTextOutcome> => {
        captured.resolve(request);
        return new Promise((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              resolve({ ok: false, kind: "cancelled" });
            },
            { once: true },
          );
        });
      },
    });

    const handling = handleVoiceTranscribe(fixture.context, deps);
    const request = await captured.promise;
    expect(request.signal).toBeDefined();
    expect(request.signal?.aborted).toBe(false);
    fixture.response.emit("close");
    expect(request.signal?.aborted).toBe(true);
    await expect(handling).resolves.toMatchObject({
      status: 499,
      body: { error: { code: "REQUEST_CANCELLED" } },
    });
    expect(fixture.request.listenerCount("aborted")).toBe(0);
    expect(fixture.response.listenerCount("close")).toBe(0);
  });

  it("maps a provider rejection after disconnect to request cancellation", async () => {
    const fixture = voiceContext({ audio: VALID_AUDIO, mimeType: "audio/webm" });
    const captured = deferred<SpeechToTextRequest>();
    const deps = depsWith({
      config: VOICE_STT_CONFIG,
      configPresent: true,
      voiceTranscriptionRequest: (request): Promise<SpeechToTextOutcome> => {
        captured.resolve(request);
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    const handling = handleVoiceTranscribe(fixture.context, deps);
    await captured.promise;
    fixture.response.emit("close");

    await expect(handling).resolves.toMatchObject({
      status: 499,
      body: { error: { code: "REQUEST_CANCELLED" } },
    });
  });

  it("transcribes against the configured keiko-stt provider and returns the transcript (AC6)", async () => {
    const activityLog = { write: vi.fn() };
    const { deps, seen } = sttDeps({ activityLog });
    const result = await handleVoiceTranscribe(
      ctx(
        {
          audio: VALID_AUDIO,
          mimeType: "audio/webm;codecs=opus",
          durationMs: 4000,
          language: "en",
        },
        "corr-stt-wiring-0001",
      ),
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
    expect(seen[0]?.log).toBe(activityLog);
    expect(seen[0]?.correlationId).toBe("corr-stt-wiring-0001");
    expect(Buffer.from(seen[0]?.audio ?? new Uint8Array()).toString("utf8")).toBe(
      "keiko-dictation-audio-bytes",
    );
  });

  it("applies the default domain-keyword prompt, and forwards a caller override", async () => {
    const withDefault = sttDeps();
    await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      withDefault.deps,
    );
    // No caller prompt → the language-neutral domain default, so proper nouns like "Keiko" transcribe.
    expect(withDefault.seen[0]?.prompt).toContain("Keiko");

    const withOverride = sttDeps();
    await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm", prompt: "  custom domain terms  " }),
      withOverride.deps,
    );
    // A caller prompt is trimmed and forwarded verbatim (overrides the default).
    expect(withOverride.seen[0]?.prompt).toBe("custom domain terms");
  });

  it("KEIKO-0649: truncates the caller prompt on code-point boundaries, never on a lone surrogate", async () => {
    // 499 ASCII chars + one four-byte astral code point (U+1F600, encoded as two UTF-16 units)
    // is 501 UTF-16 units = trimmed.length 501, > MAX_DICTATION_PROMPT_LENGTH (500). A
    // UTF-16-unit-based slice would keep 500 units and split the surrogate pair, leaving a lone
    // high surrogate at the end -- corrupting the JSON serialization to the ASR provider.
    const asciiPrefix = "a".repeat(499);
    const emoji = "\u{1F600}";
    const smuggledPrompt = `${asciiPrefix}${emoji}`;
    expect(smuggledPrompt).toHaveLength(501);

    const { deps, seen } = sttDeps();
    await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm", prompt: smuggledPrompt }),
      deps,
    );
    const forwarded = seen[0]?.prompt;
    expect(forwarded).toBeDefined();
    // Every code point in the forwarded prompt is a well-formed character; no lone surrogates.
    const codePoints = Array.from(forwarded ?? "");
    for (const cp of codePoints) {
      const code = cp.codePointAt(0);
      expect(code).toBeDefined();
      // A well-formed code point is either below the surrogate range or a full pair (code point
      // > 0xFFFF, which iterating with [...] resolves as one code point of length 2).
      const isLoneSurrogate =
        code !== undefined && code >= 0xd800 && code <= 0xdfff && cp.length === 1;
      expect(isLoneSurrogate).toBe(false);
    }
    // The forwarded prompt round-trips cleanly through JSON.
    expect(() => JSON.parse(JSON.stringify(forwarded)) as unknown).not.toThrow();
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
        correlationId: undefined,
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
    const { deps, seen } = sttDeps();
    for (const durationMs of [-1, 0, 1.5, 120_001, "10"]) {
      const result = await handleVoiceTranscribe(
        ctx({ audio: VALID_AUDIO, mimeType: "audio/webm", durationMs }),
        deps,
      );
      expect(result.status).toBe(400);
      expect((result.body as { error: { code: string } }).error.code).toBe("INVALID_DURATION");
    }
    // AC3: no audio is forwarded to the provider on any of these shape-rejection paths. Relocated
    // from the removed KEIKO-0844 density cross-validation test (#2895 audit, Finding 1) — that
    // guard rejected a truthful high-density clip as a false positive and was removed (see
    // "accepts a truthful 384kHz/32-bit/6-channel WAV" below), but "no audio reaches the provider
    // when durationMs is rejected" is a real protection this file must keep proving.
    expect(seen).toHaveLength(0);
  });

  // Builds a real (not schematic) 44-byte canonical RIFF/WAVE PCM header followed by
  // `payloadBytes` of silence, so a WAV fixture carries the same fixed container overhead a real
  // encoder would produce — this is what F1's regression class (a WAV rejected purely by its own
  // header) must never again reach.
  function buildWavBuffer(payloadBytes: number): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + payloadBytes, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (PCM)
    header.writeUInt16LE(2, 22); // NumChannels (stereo)
    header.writeUInt32LE(48_000, 24); // SampleRate
    header.writeUInt32LE(48_000 * 2 * 2, 28); // ByteRate
    header.writeUInt16LE(4, 32); // BlockAlign
    header.writeUInt16LE(16, 34); // BitsPerSample
    header.write("data", 36, "ascii");
    header.writeUInt32LE(payloadBytes, 40);
    return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
  }

  // #2895 audit, Finding 1 (repository owner, P2): the owner disproved the b6ab3958/#3348 comment's
  // "can no longer reject any real encoder output" claim — a valid WAVEFORMATEXTENSIBLE PCM stream
  // can legitimately exceed even the widened 6144 bytes/ms ceiling, e.g. 384 kHz / 32-bit / 6
  // channels = 384_000 * 4 * 6 = 9_216_000 bytes/s = 9216 bytes/ms. A 400ms clip at that density is
  // 9216 * 400 = 3_686_400 payload bytes (+44-byte header = 3_686_444 bytes, ~3.69 MB) — comfortably
  // under MAX_AUDIO_BYTES (4_000_000) with a truthful durationMs, yet the former cross-check
  // rejected it (3_686_444 > the old 8192 + 6144*400 = 2_465_792 threshold). This is the regression
  // fixture for that removal: it fails red (400 INVALID_DURATION) before the fix and passes green
  // (200, forwarded to the provider exactly once) after it — see the red-then-green evidence in the
  // PR description / commit message for the actual before/after run.
  it("accepts a truthful 384kHz/32-bit/6-channel WAV clip above the former density ceiling (#2895 audit)", async () => {
    const { deps, seen } = sttDeps();
    const wav = buildWavBuffer(3_686_400).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: wav, mimeType: "audio/wav", durationMs: 400 }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.audio.byteLength).toBe(3_686_444);
  });

  // Codex (#3348): the previous MIME-tiered ceiling (384 bytes/ms for "lossless" containers)
  // rejected legitimate high-rate lossless audio that the endpoint otherwise admits — MIME type
  // alone never constrains sample rate, bit depth, or channel count. These three cases were all
  // rejected with INVALID_DURATION before the fix and must now be accepted.
  it("accepts a truthful 96kHz/24-bit/stereo WAV clip the MIME allowlist admits (Codex, #3348)", async () => {
    const { deps, seen } = sttDeps();
    // 96_000 Hz * 3 bytes (24-bit) * 2 channels * 1s = 576_000 payload bytes; + 44-byte header.
    const wav = buildWavBuffer(576_000).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: wav, mimeType: "audio/wav", durationMs: 1000 }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("accepts a truthful 48kHz/24-bit/6-channel WAV clip (Codex, #3348 multichannel case)", async () => {
    const { deps, seen } = sttDeps();
    // 48_000 Hz * 3 bytes (24-bit) * 6 channels * 1s = 864_000 payload bytes; + 44-byte header.
    const wav = buildWavBuffer(864_000).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: wav, mimeType: "audio/wav", durationMs: 1000 }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("accepts truthful lossless content inside an admitted lossy-tier container (Codex, #3348)", async () => {
    const { deps, seen } = sttDeps();
    // audio/mp4 legitimately carries ALAC or LPCM; MIME type alone cannot distinguish that from a
    // compressed AAC stream, so the ceiling must not assume every mp4 clip is highly compressed.
    // 44.1kHz/16-bit/stereo PCM-equivalent density: 44_100 * 2 * 2 = 176_400 bytes/s.
    const dense = Buffer.alloc(176_400).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: dense, mimeType: "audio/mp4", durationMs: 1000 }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
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
        correlationId: undefined,
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

describe("POST /api/voice/transcribe — validation-rejection activity log (Finding 2, #2895 audit)", () => {
  it("emits a body-free diagnostic carrying the request's own correlation id for an unsupported MIME type", async () => {
    const { sink, records } = capturingDiagnostics();
    const { deps } = sttDeps({ diagnostics: sink });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "text/plain" }, "req-voice-corr-0001"),
      deps,
    );
    expect(result.status).toBe(400);
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe("UNSUPPORTED_AUDIO_FORMAT");
    expect(records[0]?.correlationId).toBe("req-voice-corr-0001");
    expect(records[0]?.operation).toBe("POST /api/voice/transcribe");
    expect(records[0]?.errorClass).toBe("VoiceDictationValidationRejected");
  });

  it("falls back to the sanctioned UNKNOWN_CORRELATION_ID marker, never a fresh mint, when the request carries none", async () => {
    const { sink, records } = capturingDiagnostics();
    const { deps } = sttDeps({ diagnostics: sink });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "text/plain" }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(records).toHaveLength(1);
    expect(records[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    // Guards against a future re-mint: a UUID never satisfies this shape (mirrors the sibling
    // gateway-setup.test.ts pin for the same AGENTS.md section 8 rule).
    expect(records[0]?.correlationId).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("emits a coarse audioBytesBucket for a payload-too-large rejection, with no audio content on the line", async () => {
    const { sink, records } = capturingDiagnostics();
    const { deps, seen } = sttDeps({ diagnostics: sink });
    const tooBig = Buffer.alloc(4_000_001, 7).toString("base64");
    const result = await handleVoiceTranscribe(
      ctx({ audio: tooBig, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(413);
    expect(seen).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(records[0]?.audioBytesBucket).toBe("over-limit");
    const serialized = JSON.stringify(records[0]);
    // Body-free (ADR-0173 D4): no audio bytes, no base64 fragment, no secret, and nowhere near the
    // size an audio-bearing line would be.
    expect(serialized).not.toContain(tooBig.slice(0, 200));
    expect(serialized).not.toContain(PROVIDER_SECRET);
    expect(serialized.length).toBeLessThan(1000);
  });

  it("emits the closed reason for an invalid duration shape, distinct from the payload-too-large reason", async () => {
    const { sink, records } = capturingDiagnostics();
    const { deps } = sttDeps({ diagnostics: sink });
    // A distinctive, implausible-to-collide declared duration: proves the RAW value never reaches
    // the diagnostic line (only the closed `code` and the coarse `audioBytesBucket` do). "-1" would
    // be a weaker probe here — it can coincidentally appear inside the record's own ISO `timestamp`
    // field (e.g. any "-1x" day-of-month), making that assertion date-dependent and non-hermetic.
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm", durationMs: -424_242 }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe("INVALID_DURATION");
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain(VALID_AUDIO);
    expect(serialized).not.toContain("424242");
  });

  it("emits no diagnostic on a successful dictation request", async () => {
    const { sink, records } = capturingDiagnostics();
    const { deps } = sttDeps({ diagnostics: sink });
    const result = await handleVoiceTranscribe(
      ctx({ audio: VALID_AUDIO, mimeType: "audio/webm" }),
      deps,
    );
    expect(result.status).toBe(200);
    expect(records).toHaveLength(0);
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
