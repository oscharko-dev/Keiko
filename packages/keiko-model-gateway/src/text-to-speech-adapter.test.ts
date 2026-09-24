import { describe, expect, it, vi } from "vitest";
import {
  MAX_SPEECH_AUDIO_BYTES,
  requestTextToSpeech,
  requestTextToSpeechStream,
} from "./text-to-speech-adapter.js";
import { OutboundHttpEgressError } from "./http.js";
import { GATEWAY_VOICE_TIMEOUT_FLOOR_MS } from "./resilience.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// A recognizable audio byte marker so a test can assert the adapter returns the provider body verbatim
// without depending on real audio.
const AUDIO_MARKER = "KEIKO-SPOKEN-AUDIO";
const AUDIO_BYTES = new TextEncoder().encode(AUDIO_MARKER);
const SECRET_API_KEY = ["sk-", "test-keiko-tts-1234567890abcdef"].join("");
const ENDPOINT = "https://tts.example.invalid/v1";
const ANSWER = "The assistant's spoken answer.";

type NarrowFetch = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  const f: NarrowFetch = async (url, init) => handler(url, init ?? {});
  return f as unknown as typeof fetch;
}

function audioResponse(
  bytes: Uint8Array,
  contentType: string | null = "audio/mpeg",
  status = 200,
): Response {
  const headers: Record<string, string> = {};
  if (contentType !== null) {
    headers["content-type"] = contentType;
  }
  // Copy into an ArrayBuffer-backed Uint8Array so the body is a valid BodyInit (the `new Uint8Array`
  // array overload yields `Uint8Array<ArrayBuffer>`, unlike `TextEncoder().encode` which is ArrayBufferLike).
  const body = new Uint8Array(bytes.length);
  body.set(bytes);
  return new Response(body, { status, headers });
}

function bodyText(init: RequestInit): string {
  return typeof init.body === "string" ? init.body : "";
}

describe("requestTextToSpeech", () => {
  it("POSTs JSON to /audio/speech with model, input, voice, instructions, response_format, and auth header", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenContentType = "";
    let seenAuth = "";
    let seenBody = "";
    const fetchImpl = mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = init.method ?? "";
      const headers = init.headers as Record<string, string>;
      seenContentType = headers["content-type"] ?? "";
      seenAuth = headers.authorization ?? "";
      seenBody = bodyText(init);
      return audioResponse(AUDIO_BYTES);
    });

    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "verse",
      instructions: "Speak warmly with natural pacing.",
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Buffer.from(outcome.value.audio).toString("utf8")).toBe(AUDIO_MARKER);
      expect(outcome.value.mimeType).toBe("audio/mpeg");
    }
    expect(seenUrl).toBe("https://tts.example.invalid/v1/audio/speech");
    expect(seenMethod).toBe("POST");
    expect(seenContentType).toBe("application/json");
    expect(seenAuth).toBe(`Bearer ${SECRET_API_KEY}`);
    const payload = JSON.parse(seenBody) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "keiko-tts",
      input: ANSWER,
      voice: "verse",
      instructions: "Speak warmly with natural pacing.",
      response_format: "mp3",
    });
  });

  it("fails closed before egress when no explicit provider voice is pinned", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      requestTextToSpeech({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-tts",
        input: ANSWER,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "unsupported-model",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("fails closed before egress for an empty voice (%j)", async (voice) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      requestTextToSpeech({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-tts",
        input: ANSWER,
        voice,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "unsupported-model",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the streaming surface optional and fail-closed before egress", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      requestTextToSpeechStream({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-tts",
        input: ANSWER,
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "unsupported-model",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("supports a custom apiKeyHeaderName (Azure api-key), response format, and speed", async () => {
    let header: string | null = null;
    let seenBody = "";
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "opus",
      speed: 1.25,
      fetchImpl: mockFetch((_url, init) => {
        header = (init.headers as Record<string, string>)["api-key"] ?? null;
        seenBody = bodyText(init);
        return audioResponse(AUDIO_BYTES, "audio/ogg");
      }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mimeType).toBe("audio/ogg");
    }
    expect(header).toBe(SECRET_API_KEY);
    const payload = JSON.parse(seenBody) as Record<string, unknown>;
    expect(payload.response_format).toBe("opus");
    expect(payload.speed).toBe(1.25);
  });

  it("supports Azure OpenAI deployment endpoints with a separate api-version", async () => {
    let seenUrl = "";
    let header: string | null = null;
    let seenBody = "";
    const outcome = await requestTextToSpeech({
      endpoint: "https://voice.example.cognitiveservices.azure.com/",
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2025-03-01-preview",
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "alloy",
      fetchImpl: mockFetch((url, init) => {
        seenUrl = url;
        header = (init.headers as Record<string, string>)["api-key"] ?? null;
        seenBody = bodyText(init);
        return audioResponse(AUDIO_BYTES);
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(seenUrl).toBe(
      "https://voice.example.cognitiveservices.azure.com/openai/deployments/keiko-tts/audio/speech?api-version=2025-03-01-preview",
    );
    expect(header).toBe(SECRET_API_KEY);
    expect(JSON.parse(seenBody)).toMatchObject({ model: "keiko-tts", voice: "alloy" });
  });

  it("derives the mimeType from the requested format when the provider omits content-type", async () => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "wav",
      fetchImpl: mockFetch(() => audioResponse(AUDIO_BYTES, null)),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mimeType).toBe("audio/wav");
    }
  });

  it("ignores a non-audio content-type and falls back to the format default", async () => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => audioResponse(AUDIO_BYTES, "application/json")),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mimeType).toBe("audio/mpeg");
    }
  });

  it("strips content-type parameters down to the bare audio type", async () => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => audioResponse(AUDIO_BYTES, "audio/mpeg; charset=binary")),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mimeType).toBe("audio/mpeg");
    }
  });

  it("uses an Ogg container signature when Azure mislabels Opus audio as MPEG", async () => {
    const oggAudio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "opus",
      correlationId: "corr-tts-mime",
      log: {
        write(event): void {
          events.push(event);
        },
      },
      fetchImpl: mockFetch(() => audioResponse(oggAudio, "audio/mpeg")),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mimeType).toBe("audio/ogg");
    }
    // THE ATTEMPT LINE (speech.tts.request.dispatch) is always first, ahead of the narrower
    // MIME-correction line (#3602 review — the new per-call deadline had no line recording the
    // applied bound).
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      level: "info",
      category: "gateway",
      op: "speech.tts.request.dispatch",
      correlationId: "corr-tts-mime",
      extra: { modelId: "keiko-tts", timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS },
    });
    expect(events[1]).toMatchObject({
      level: "info",
      category: "gateway",
      op: "speech.tts.mime.corrected",
      correlationId: "corr-tts-mime",
      extra: {
        completeness: "complete",
        declaredMimeClass: "mp3",
        loss: "none",
        resolvedMimeClass: "opus",
      },
    });

    // Activity Log proof (#3532): the MIME-correction line as the production file sink would
    // persist it.
    const persisted = expectActivityLogProof(
      "speech.tts.mime.corrected.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(persisted).toMatchObject({ declaredMimeClass: "mp3", resolvedMimeClass: "opus" });
    // The dispatch line as the production file sink would persist it: the applied deadline is the
    // floor, not the caller's configured value (#3591).
    const dispatched = expectActivityLogProof(
      "speech.tts.request.dispatch.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(dispatched).toMatchObject({
      modelId: "keiko-tts",
      timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS,
    });
  });

  it.each([
    [
      "LiteLLM WAV",
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45],
      "audio/wav",
      "wav",
    ],
    ["FLAC", [0x66, 0x4c, 0x61, 0x43], "audio/flac", "flac"],
    ["MP3 ID3", [0x49, 0x44, 0x33], "audio/mpeg", "mp3"],
    ["MP3 frame", [0xff, 0xfb, 0x90, 0x64], "audio/mpeg", "mp3"],
  ] as const)("corrects a %s container mislabeled as PCM", async (_label, bytes, mime, kind) => {
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "pcm",
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      fetchImpl: mockFetch(() => audioResponse(new Uint8Array(bytes), "audio/pcm")),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.mimeType).toBe(mime);
    expect(events[1]).toMatchObject({
      op: "speech.tts.mime.corrected",
      extra: { declaredMimeClass: "pcm", resolvedMimeClass: kind },
    });
  });

  it.each([
    ["an exact four-byte capture pattern", [0x4f, 0x67, 0x67, 0x53]],
    ["a one-byte prefix", [0x4f]],
    ["a two-byte prefix", [0x4f, 0x67]],
    ["a three-byte prefix", [0x4f, 0x67, 0x67]],
    ["a malformed Ogg version", [0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]],
    ["hostile leading bytes before OggS", [0x00, 0x00, 0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]],
  ])("does not correct the declared MIME for %s", async (_label, bytes) => {
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "opus",
      log: {
        write(event): void {
          events.push(event);
        },
      },
      fetchImpl: mockFetch(() => audioResponse(new Uint8Array(bytes), "audio/mpeg")),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.mimeType).toBe("audio/mpeg");
    // Only the unconditional dispatch line — no MIME-correction event for an already-correct MIME.
    expect(events.map((event) => event.op)).toEqual(["speech.tts.request.dispatch"]);
  });

  it.each([
    ["reserved MPEG version", [0xff, 0xeb, 0x90, 0x64]],
    ["reserved MPEG layer", [0xff, 0xf9, 0x90, 0x64]],
    ["reserved bitrate", [0xff, 0xfb, 0xf0, 0x64]],
    ["reserved sample rate", [0xff, 0xfb, 0x9c, 0x64]],
    ["incomplete frame", [0xff, 0xfb, 0x90]],
  ])("does not infer MP3 from %s", async (_label, bytes) => {
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "pcm",
      log: { write: (event): void => void events.push(event) },
      fetchImpl: mockFetch(() => audioResponse(new Uint8Array(bytes), "audio/pcm")),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.mimeType).toBe("audio/pcm");
    // Only the unconditional dispatch line — no MIME-correction event for a non-matching signature.
    expect(events.map((event) => event.op)).toEqual(["speech.tts.request.dispatch"]);
  });

  it("returns empty-audio when a 2xx response carries no audio bytes", async () => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => audioResponse(new Uint8Array(0))),
    });
    expect(outcome).toEqual({ ok: false, kind: "empty-audio" });
  });

  it("returns invalid-response when the audio exceeds the byte cap", async () => {
    const tooBig = new Uint8Array(64);
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      maxAudioBytes: 16,
      fetchImpl: mockFetch(() => audioResponse(tooBig)),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it("exposes a positive default audio byte cap", () => {
    expect(MAX_SPEECH_AUDIO_BYTES).toBeGreaterThan(0);
  });

  it.each([
    [401, "wrong-header"],
    [403, "wrong-header"],
    [429, "rate-limited"],
    [404, "unsupported-model"],
    [413, "payload-too-large"],
    [500, "transport"],
  ])("maps HTTP %i to %s and never surfaces the provider body", async (status, kind) => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(
        () =>
          new Response("provider error body — never surfaced", {
            status,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a transport throw to transport", async () => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => {
        throw new Error("socket hang up");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind: "transport" });
  });

  it.each([
    ["PROXY_UNREACHABLE", "proxy-unreachable"],
    ["PROXY_AUTH_REQUIRED", "proxy-auth-required"],
    ["PROXY_EGRESS_FAILED", "proxy-egress-failed"],
    ["PROXY_BLOCKED_BY_POLICY", "proxy-blocked-by-policy"],
    ["TLS_CA_FAILURE", "tls-ca-failure"],
  ] as const)("maps egress error %s to %s", async (code, kind) => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => {
        throw new OutboundHttpEgressError(code, "egress failure");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a thrown TimeoutError to timeout and a caller-aborted signal to cancelled", async () => {
    const timeout = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    });
    expect(timeout).toEqual({ ok: false, kind: "timeout" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      signal: controller.signal,
      fetchImpl: mockFetch(() => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(cancelled).toEqual({ ok: false, kind: "cancelled" });
  });

  // Proves `requestTextToSpeech` itself wires its internal deadline into the outbound fetch
  // (mirrors the identical regression on the speech-to-text adapter, review finding on PR #3602).
  // `classifyDispatchError` is not exported from this module, so the assertion runs end to end:
  // `AbortSignal.timeout` is spied to assert the floored value it is called with, then swapped for
  // an already-fired signal so the whole request path ends in the timeout outcome for real.
  it("wires the floored internal deadline into the outbound fetch and ends in a timeout outcome", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      if (ms !== GATEWAY_VOICE_TIMEOUT_FLOOR_MS) return nativeTimeout(ms);
      const controller = new AbortController();
      controller.abort(new DOMException("the provider did not answer in time", "TimeoutError"));
      return controller.signal;
    });
    try {
      const outcome = await requestTextToSpeech({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-tts",
        input: ANSWER,
        voice: "configured-voice",
        // Below the floor: proves the CALL that reaches AbortSignal.timeout carries the floored
        // value, not the caller's smaller configured one.
        timeoutMs: 5_000,
        fetchImpl: mockFetch((_url, init) => {
          if (init.signal?.aborted === true) {
            throw init.signal.reason as Error;
          }
          throw new Error("the request should have carried an already-aborted signal");
        }),
      });
      expect(timeoutSpy).toHaveBeenCalledWith(GATEWAY_VOICE_TIMEOUT_FLOOR_MS);
      expect(outcome).toEqual({ ok: false, kind: "timeout" });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("never leaks the api key into the URL or request body", async () => {
    let seenUrl = "";
    let seenBody = "";
    await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "verse",
      fetchImpl: mockFetch((url, init) => {
        seenUrl = url;
        seenBody = bodyText(init);
        return audioResponse(AUDIO_BYTES);
      }),
    });
    expect(seenUrl).not.toContain(SECRET_API_KEY);
    expect(seenBody).not.toContain(SECRET_API_KEY);
  });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("requestTextToSpeechStream", () => {
  it("returns the provider body as a byte stream with the resolved mime type", async () => {
    const fetchImpl = mockFetch(() => audioResponse(AUDIO_BYTES, "audio/pcm"));
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "pcm",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mimeType).toBe("audio/pcm");
    expect(new TextDecoder().decode(await collect(outcome.value.body))).toBe(AUDIO_MARKER);
  });

  it("corrects an Azure Ogg stream MIME without dropping a split prefix", async () => {
    const chunks = [
      new Uint8Array([0x4f, 0x67]),
      new Uint8Array([0x67, 0x53, 0x00, 0x02]),
      new Uint8Array([0x11, 0x22, 0x33]),
    ];
    const expected = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
    const events: ModelGatewayLogEvent[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "opus",
      correlationId: "corr-tts-stream-mime",
      log: {
        write(event): void {
          events.push(event);
        },
      },
      fetchImpl: mockFetch(
        () => new Response(stream, { headers: { "content-type": "audio/mpeg" } }),
      ),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mimeType).toBe("audio/ogg");
    expect(await collect(outcome.value.body)).toEqual(expected);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "speech.tts.mime.corrected",
        correlationId: "corr-tts-stream-mime",
      }),
    );
  });

  it("corrects a LiteLLM WAV stream mislabeled as PCM without losing bytes", async () => {
    const chunks = [
      new Uint8Array([0x52, 0x49, 0x46]),
      new Uint8Array([0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1, 2]),
    ];
    const expected = new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "customer-speech",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "pcm",
      fetchImpl: mockFetch(
        () => new Response(stream, { headers: { "content-type": "audio/pcm" } }),
      ),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mimeType).toBe("audio/wav");
    expect(await collect(outcome.value.body)).toEqual(expected);
  });

  it("logs a correlated body-free failure when the response prefix cannot be read", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new TypeError("provider response prefix failed"));
      },
    });
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      correlationId: "corr-tts-stream-prefix",
      log: {
        write(event): void {
          events.push(event);
        },
      },
      fetchImpl: mockFetch(() => new Response(stream, { status: 200 })),
    });

    expect(outcome).toEqual({ ok: false, kind: "transport" });
    expect(events).toContainEqual({
      level: "error",
      category: "gateway",
      op: "speech.tts.stream.peek.failed",
      correlationId: "corr-tts-stream-prefix",
      errorKind: "internal",
      extra: {
        completeness: "complete",
        loss: "none",
        phase: "response-prefix",
        outcomeKind: "transport",
      },
    });
    expect(JSON.stringify(events)).not.toContain(ANSWER);
    expect(JSON.stringify(events)).not.toContain(SECRET_API_KEY);

    // Activity Log proof (#3532): the peek-failure line as the production file sink would
    // persist it.
    const peekFailed = events.find((event) => event.op === "speech.tts.stream.peek.failed");
    const persisted = expectActivityLogProof(
      "speech.tts.stream.peek.failed.emitted-line",
      formatActivityLogProofLine(peekFailed ?? {}),
    );
    expect(persisted).toMatchObject({ phase: "response-prefix", outcomeKind: "transport" });
  });

  it("fails closed when a successful streaming response contains zero audio bytes", async () => {
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl: mockFetch(() => new Response(new Uint8Array(), { status: 200 })),
    });

    expect(outcome).toEqual({ ok: false, kind: "empty-audio" });
  });

  it("maps a provider error status to a coded kind without streaming a body", async () => {
    const fetchImpl = mockFetch(() => new Response("provider error page", { status: 429 }));
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      fetchImpl,
    });
    expect(outcome).toEqual({ ok: false, kind: "rate-limited" });
  });

  it("errors the stream once the audio exceeds the size cap", async () => {
    const fetchImpl = mockFetch(() => audioResponse(new Uint8Array(100), "audio/pcm"));
    const outcome = await requestTextToSpeechStream({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      voice: "configured-voice",
      responseFormat: "pcm",
      maxAudioBytes: 10,
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await expect(collect(outcome.value.body)).rejects.toThrow();
  });
});
