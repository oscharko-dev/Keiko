import { describe, expect, it } from "vitest";
import { MAX_SPEECH_AUDIO_BYTES, requestTextToSpeech } from "./text-to-speech-adapter.js";
import { OutboundHttpEgressError } from "./http.js";

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
  it("POSTs JSON to /audio/speech with model, input, voice, response_format, and auth header", async () => {
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
      response_format: "mp3",
    });
  });

  it("defaults the voice to alloy and mp3 when none is pinned", async () => {
    let seenBody = "";
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
      fetchImpl: mockFetch((_url, init) => {
        seenBody = bodyText(init);
        return audioResponse(AUDIO_BYTES);
      }),
    });
    expect(outcome.ok).toBe(true);
    const payload = JSON.parse(seenBody) as Record<string, unknown>;
    expect(payload.voice).toBe("alloy");
    expect(payload.response_format).toBe("mp3");
    expect(payload.speed).toBeUndefined();
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
      fetchImpl: mockFetch(() => audioResponse(AUDIO_BYTES, "audio/mpeg; charset=binary")),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.mimeType).toBe("audio/mpeg");
    }
  });

  it("returns empty-audio when a 2xx response carries no audio bytes", async () => {
    const outcome = await requestTextToSpeech({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-tts",
      input: ANSWER,
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
      signal: controller.signal,
      fetchImpl: mockFetch(() => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(cancelled).toEqual({ ok: false, kind: "cancelled" });
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
