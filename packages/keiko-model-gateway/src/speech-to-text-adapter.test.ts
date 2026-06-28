import { describe, expect, it } from "vitest";
import { requestSpeechToText } from "./speech-to-text-adapter.js";
import { OutboundHttpEgressError } from "./http.js";

// A recognizable ASCII audio marker so we can locate the binary `file` part inside the multipart
// body the adapter builds, without depending on real audio bytes.
const AUDIO_MARKER = "KEIKO-AUDIO-BYTES";
const AUDIO = new TextEncoder().encode(AUDIO_MARKER);
const SECRET_API_KEY = ["sk-", "test-keiko-stt-1234567890abcdef"].join("");
const ENDPOINT = "https://stt.example.invalid/v1";

type NarrowFetch = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  const f: NarrowFetch = async (url, init) => handler(url, init ?? {});
  return f as unknown as typeof fetch;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bodyToText(init: RequestInit): string {
  const body = init.body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("latin1");
  }
  return typeof body === "string" ? body : "";
}

describe("requestSpeechToText", () => {
  it("POSTs multipart/form-data to /audio/transcriptions with the audio, model, and auth header", async () => {
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
      seenBody = bodyToText(init);
      return ok({ text: "hello world" });
    });

    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, value: { transcript: "hello world" } });
    expect(seenUrl).toBe("https://stt.example.invalid/v1/audio/transcriptions");
    expect(seenMethod).toBe("POST");
    expect(seenContentType).toMatch(/^multipart\/form-data; boundary=keiko-stt-/);
    expect(seenAuth).toBe(`Bearer ${SECRET_API_KEY}`);
    // The binary file part, its declared content type, and the model field are all present.
    expect(seenBody).toContain('name="file"; filename="audio.webm"');
    expect(seenBody).toContain("Content-Type: audio/webm");
    expect(seenBody).toContain(AUDIO_MARKER);
    expect(seenBody).toContain('name="model"');
    expect(seenBody).toContain("keiko-stt");
    expect(seenBody).toContain('name="response_format"');
  });

  it("supports a custom apiKeyHeaderName (Azure api-key) and an optional language field", async () => {
    let header: string | null = null;
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      header = (init.headers as Record<string, string>)["api-key"] ?? null;
      body = bodyToText(init);
      return ok({ text: "hallo" });
    });
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/ogg",
      language: "de",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(header).toBe(SECRET_API_KEY);
    expect(body).toContain('name="language"');
    expect(body).toContain("\r\n\r\nde\r\n");
  });

  it("supports Azure OpenAI deployment endpoints with a separate api-version", async () => {
    let seenUrl = "";
    let seenHeader: string | null = null;
    let seenBody = "";
    const fetchImpl = mockFetch((url, init) => {
      seenUrl = url;
      seenHeader = (init.headers as Record<string, string>)["api-key"] ?? null;
      seenBody = bodyToText(init);
      return ok({ text: "azure transcript" });
    });

    const outcome = await requestSpeechToText({
      endpoint: "https://voice.example.cognitiveservices.azure.com/",
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2025-03-01-preview",
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/wav",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, value: { transcript: "azure transcript" } });
    expect(seenUrl).toBe(
      "https://voice.example.cognitiveservices.azure.com/openai/deployments/keiko-stt/audio/transcriptions?api-version=2025-03-01-preview",
    );
    expect(seenHeader).toBe(SECRET_API_KEY);
    expect(seenBody).toContain('name="model"');
    expect(seenBody).toContain("keiko-stt");
  });

  it("preserves an empty transcript (silence) as a success", async () => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => ok({ text: "" })),
    });
    expect(outcome).toEqual({ ok: true, value: { transcript: "" } });
  });

  it("surfaces content-free confidence, language, and duration when the provider reports them", async () => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() =>
        ok({ text: "ok", confidence: 0.92, language: "en", duration: 2.5 }),
      ),
    });
    expect(outcome).toEqual({
      ok: true,
      value: { transcript: "ok", confidence: 0.92, language: "en", durationMs: 2500 },
    });
  });

  it("drops an out-of-range confidence rather than echoing it (documented [0,1] contract)", async () => {
    for (const confidence of [1.5, -0.1, 42]) {
      const outcome = await requestSpeechToText({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-stt",
        audio: AUDIO,
        mimeType: "audio/webm",
        fetchImpl: mockFetch(() => ok({ text: "ok", confidence })),
      });
      expect(outcome).toEqual({ ok: true, value: { transcript: "ok" } });
    }
    // Boundary values 0 and 1 are kept.
    const lo = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => ok({ text: "ok", confidence: 0 })),
    });
    expect(lo).toEqual({ ok: true, value: { transcript: "ok", confidence: 0 } });
  });

  it("returns invalid-response when the body has no text field", async () => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => ok({ segments: [] })),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it("returns invalid-response when the body is not valid JSON", async () => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(
        () =>
          new Response("not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it.each([
    [401, "wrong-header"],
    [403, "wrong-header"],
    [429, "rate-limited"],
    [404, "unsupported-model"],
    [413, "payload-too-large"],
    [500, "transport"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => new Response("provider error body — never surfaced", { status })),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a transport throw to transport", async () => {
    const transport = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => {
        throw new Error("socket hang up");
      }),
    });
    expect(transport).toEqual({ ok: false, kind: "transport" });
  });

  it.each([
    ["PROXY_UNREACHABLE", "proxy-unreachable"],
    ["PROXY_AUTH_REQUIRED", "proxy-auth-required"],
    ["PROXY_EGRESS_FAILED", "proxy-egress-failed"],
    ["PROXY_BLOCKED_BY_POLICY", "proxy-blocked-by-policy"],
    ["TLS_CA_FAILURE", "tls-ca-failure"],
  ] as const)("maps egress error %s to %s", async (code, kind) => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => {
        throw new OutboundHttpEgressError(code, "egress failure");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a thrown TimeoutError to timeout and a caller-aborted signal to cancelled", async () => {
    const timeout = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    });
    expect(timeout).toEqual({ ok: false, kind: "timeout" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      signal: controller.signal,
      fetchImpl: mockFetch(() => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(cancelled).toEqual({ ok: false, kind: "cancelled" });
  });

  it("maps a fired internal timeout signal to timeout (timeoutSignal.aborted branch)", async () => {
    // timeoutMs is tiny and the mock resolves only after a real delay, so the adapter's internal
    // AbortSignal.timeout fires before the throw — exercising the timeoutSignal.aborted path (a bare
    // AbortError without TimeoutError name), which differs from the thrown-TimeoutError path above.
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      timeoutMs: 1,
      fetchImpl: mockFetch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind: "timeout" });
  });

  it("never leaks the provider URL or credential into the outcome on failure", async () => {
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl: mockFetch(() => new Response("", { status: 401 })),
    });
    const json = JSON.stringify(outcome);
    expect(json).not.toContain(SECRET_API_KEY);
    expect(json).not.toContain(ENDPOINT);
  });

  it("sanitizes CR/LF/quote out of textual multipart fields (injection defense)", async () => {
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      body = bodyToText(init);
      return ok({ text: "x" });
    });
    await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      // A malicious model id attempting to inject an extra multipart header.
      modelId: 'evil"\r\nContent-Disposition: form-data; name="admin"',
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl,
    });
    // The injected CRLF and quote are stripped, so no second admin field is created.
    expect(body).not.toContain('name="admin"');
    expect(body).toContain("evilContent-Disposition: form-data; name=admin");
  });

  it("strips embedded CRLF from a field so no extra multipart part is injected (boundary count intact)", async () => {
    let body = "";
    const fetchImpl = mockFetch((_url, init) => {
      body = bodyToText(init);
      return ok({ text: "x" });
    });
    await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      // CRLF-only injection (no quote): would add a spurious Content-Disposition header if not sanitized.
      modelId: "m\r\nContent-Disposition: form-data; name=injected",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl,
    });
    // The CRLF is stripped, so the injected text folds into the model field VALUE rather than becoming
    // its own header line — no spurious multipart part is created.
    expect(body).toContain(
      'name="model"\r\n\r\nmContent-Disposition: form-data; name=injected\r\n',
    );
    expect(body).not.toContain("\r\nContent-Disposition: form-data; name=injected\r\n");
  });

  it("appends /audio/transcriptions without doubling a trailing slash on the endpoint", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return ok({ text: "x" });
    });
    await requestSpeechToText({
      endpoint: "https://stt.example.invalid/v1/",
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      fetchImpl,
    });
    expect(seenUrl).toBe("https://stt.example.invalid/v1/audio/transcriptions");
  });
});
