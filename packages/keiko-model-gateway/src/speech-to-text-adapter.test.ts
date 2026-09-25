import { describe, expect, it, vi } from "vitest";
import { classifyDispatchError, requestSpeechToText } from "./speech-to-text-adapter.js";
import { OutboundHttpEgressError } from "./http.js";
import { GATEWAY_VOICE_TIMEOUT_FLOOR_MS } from "./resilience.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

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

async function bodyToText(init: RequestInit): Promise<string> {
  const body = init.body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("latin1");
  }
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer()).toString("latin1");
  }
  return typeof body === "string" ? body : "";
}

describe("requestSpeechToText", () => {
  it("POSTs multipart/form-data to /audio/transcriptions with the audio, model, and auth header", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenContentType = "";
    let seenContentLength = "";
    let seenAuth = "";
    let seenBlobBody = false;
    let seenBody = "";
    const fetchImpl = mockFetch(async (url, init) => {
      seenUrl = url;
      seenMethod = init.method ?? "";
      const headers = init.headers as Record<string, string>;
      seenContentType = headers["content-type"] ?? "";
      seenContentLength = headers["content-length"] ?? "";
      seenAuth = headers.authorization ?? "";
      seenBlobBody = init.body instanceof Blob;
      seenBody = await bodyToText(init);
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
    expect(Number(seenContentLength)).toBeGreaterThan(AUDIO.byteLength);
    expect(seenAuth).toBe(`Bearer ${SECRET_API_KEY}`);
    expect(seenBlobBody).toBe(true);
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
    const events: ModelGatewayLogEvent[] = [];
    const fetchImpl = mockFetch(async (_url, init) => {
      header = (init.headers as Record<string, string>)["api-key"] ?? null;
      body = await bodyToText(init);
      return ok({ text: "hallo" });
    });
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/ogg",
      language: "de-DE",
      correlationId: "corr-stt-language",
      log: {
        write(event): void {
          events.push(event);
        },
      },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(header).toBe(SECRET_API_KEY);
    expect(body).toContain('name="language"');
    expect(body).toContain("\r\n\r\nde\r\n");
    expect(body).not.toContain("\r\n\r\nde-DE\r\n");
    // THE ATTEMPT LINE (speech.stt.request.dispatch) is always first, ahead of the narrower,
    // conditional normalization line (#3602 review — the new per-call deadline had no line
    // recording the applied bound), and THE COMPLETION LINE (speech.stt.request.completed) is
    // always last (#3602 review — a timeout, a rate limit, and an invalid response were
    // indistinguishable from a still-running call once only the dispatch line existed).
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      level: "info",
      category: "gateway",
      op: "speech.stt.request.dispatch",
      correlationId: "corr-stt-language",
      extra: { modelId: "keiko-stt", timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS },
    });
    expect(events[1]).toMatchObject({
      level: "info",
      category: "gateway",
      op: "speech.stt.language.normalized",
      correlationId: "corr-stt-language",
      extra: {
        completeness: "complete",
        declaredSubtagCount: 2,
        loss: "none",
        resolvedSubtagCount: 1,
        primaryLanguagePreserved: true,
      },
    });
    expect(events[2]).toMatchObject({
      level: "info",
      category: "gateway",
      op: "speech.stt.request.completed",
      correlationId: "corr-stt-language",
      extra: {
        modelId: "keiko-stt",
        outcome: "succeeded",
        timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS,
      },
    });
    expect(events[2]?.extra).not.toHaveProperty("failureKind");
    expect(events[2]?.errorKind).toBeUndefined();

    // Activity Log proof (#3532): the normalization line as the production file sink would
    // persist it.
    const persisted = expectActivityLogProof(
      "speech.stt.language.normalized.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(persisted).toMatchObject({
      declaredSubtagCount: 2,
      resolvedSubtagCount: 1,
      primaryLanguagePreserved: true,
    });
    // The dispatch line as the production file sink would persist it: the applied deadline is the
    // floor, not the caller's configured value (#3591).
    const dispatched = expectActivityLogProof(
      "speech.stt.request.dispatch.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(dispatched).toMatchObject({
      modelId: "keiko-stt",
      timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS,
    });
    // The completed line as the production file sink would persist it: the outcome and the
    // applied deadline travel together (#3602 review).
    const completed = expectActivityLogProof(
      "speech.stt.request.completed.emitted-line",
      formatActivityLogProofLine(events[2] ?? {}),
    );
    expect(completed).toMatchObject({
      modelId: "keiko-stt",
      outcome: "succeeded",
      timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS,
    });
  });

  it("preserves a primary language tag without emitting a normalization event", async () => {
    let body = "";
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/ogg",
      language: "de",
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      fetchImpl: mockFetch(async (_url, init) => {
        body = await bodyToText(init);
        return ok({ text: "hallo" });
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(body).toContain("\r\n\r\nde\r\n");
    // The unconditional dispatch and completed lines — no normalization event for an
    // already-primary tag.
    expect(events.map((event) => event.op)).toEqual([
      "speech.stt.request.dispatch",
      "speech.stt.request.completed",
    ]);
  });

  it("omits an empty language hint without emitting a normalization event", async () => {
    let body = "";
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/ogg",
      language: "",
      log: { write: (event): void => void events.push(event) },
      fetchImpl: mockFetch(async (_url, init) => {
        body = await bodyToText(init);
        return ok({ text: "hallo" });
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(body).not.toContain('name="language"');
    // The unconditional dispatch and completed lines — no normalization event for an absent
    // language hint.
    expect(events.map((event) => event.op)).toEqual([
      "speech.stt.request.dispatch",
      "speech.stt.request.completed",
    ]);
  });

  it("normalizes a maximum-length validated language hint and logs the boundary", async () => {
    let body = "";
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/ogg",
      language: "abc-12345678-12345678-12345678-1234",
      correlationId: "corr-stt-language-boundary",
      log: { write: (event): void => void events.push(event) },
      fetchImpl: mockFetch(async (_url, init) => {
        body = await bodyToText(init);
        return ok({ text: "hallo" });
      }),
    });

    expect(outcome.ok).toBe(true);
    expect(body).toContain("\r\n\r\nabc\r\n");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ op: "speech.stt.request.dispatch" });
    expect(events[1]).toMatchObject({
      level: "info",
      category: "gateway",
      op: "speech.stt.language.normalized",
      correlationId: "corr-stt-language-boundary",
      extra: {
        completeness: "complete",
        declaredSubtagCount: 5,
        loss: "none",
        resolvedSubtagCount: 1,
        primaryLanguagePreserved: true,
      },
    });
    expect(events[2]).toMatchObject({ op: "speech.stt.request.completed" });
  });

  it("includes an optional domain-keyword prompt field in the multipart body", async () => {
    let body = "";
    const fetchImpl = mockFetch(async (_url, init) => {
      body = await bodyToText(init);
      return ok({ text: "hallo" });
    });
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/ogg",
      prompt: "Keiko, Repository",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(body).toContain('name="prompt"');
    expect(body).toContain("\r\n\r\nKeiko, Repository\r\n");
  });

  it("supports Azure OpenAI deployment endpoints with a separate api-version", async () => {
    let seenUrl = "";
    let seenHeader: string | null = null;
    let seenBody = "";
    const fetchImpl = mockFetch(async (url, init) => {
      seenUrl = url;
      seenHeader = (init.headers as Record<string, string>)["api-key"] ?? null;
      seenBody = await bodyToText(init);
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

  // #3591: the internal AbortSignal.timeout is now floored to GATEWAY_VOICE_TIMEOUT_FLOOR_MS
  // (120s) regardless of a smaller configured value, so it can no longer be made to fire for real
  // inside a unit test the way a tiny `timeoutMs` used to. `classifyDispatchError` is the exact
  // production function `requestSpeechToText` calls to map a bare AbortError onto "timeout" when
  // its OWN internal signal (not the caller's) is the one that fired — proven directly here
  // against a manually-aborted signal instead of waiting on the real timer.
  it("maps a fired internal timeout signal to timeout (timeoutSignal.aborted branch)", () => {
    const timeoutSignal = new AbortController();
    timeoutSignal.abort();
    const outcome = classifyDispatchError(
      new DOMException("aborted", "AbortError"),
      timeoutSignal.signal,
      undefined,
    );
    expect(outcome).toBe("timeout");
  });

  // Proves `requestSpeechToText` itself — not just `classifyDispatchError` in isolation — wires
  // its internal deadline into the outbound fetch (review finding on PR #3602: the end-to-end pin
  // this test replaces was deleted when the floor made it impossible to fire for real inside a
  // unit test, leaving nothing proving the wiring still exists). `AbortSignal.timeout` is spied so
  // the call it receives for the internal deadline can be asserted directly, then swapped for an
  // already-fired signal so the whole request path — dispatch, classification, and the outcome
  // `requestSpeechToText` returns — is exercised exactly as it would be for a real fired timeout.
  it("wires the floored internal deadline into the outbound fetch and ends in a timeout outcome", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      if (ms !== GATEWAY_VOICE_TIMEOUT_FLOOR_MS) return nativeTimeout(ms);
      const controller = new AbortController();
      controller.abort(new DOMException("the provider did not answer in time", "TimeoutError"));
      return controller.signal;
    });
    try {
      const outcome = await requestSpeechToText({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-stt",
        audio: AUDIO,
        mimeType: "audio/webm",
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

  // THE COMPLETION LINE (review finding on PR #3602: the dispatch line alone left a timeout, a
  // rate limit, and an invalid response indistinguishable from a still-running call). Proves the
  // timeout path specifically, since that is the scenario the finding names.
  it("logs the completed line with a timeout failureKind and errorKind on a timeout outcome", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      correlationId: "corr-stt-timeout",
      log: { write: (event): void => void events.push(event) },
      fetchImpl: mockFetch(() => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind: "timeout" });
    const completed = events.find((event) => event.op === "speech.stt.request.completed");
    expect(completed).toMatchObject({
      level: "warn",
      category: "gateway",
      op: "speech.stt.request.completed",
      correlationId: "corr-stt-timeout",
      errorKind: "timeout",
      extra: {
        outcome: "failed",
        failureKind: "timeout",
        timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS,
      },
    });
  });

  // A non-timeout failure: proves the completed line's failureKind/errorKind distinguish a rate
  // limit from a timeout instead of collapsing every failure into one shape.
  it("logs the completed line with a rate-limited failureKind and errorKind on a 429 outcome", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestSpeechToText({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-stt",
      audio: AUDIO,
      mimeType: "audio/webm",
      correlationId: "corr-stt-rate-limit",
      log: { write: (event): void => void events.push(event) },
      fetchImpl: mockFetch(() => new Response("", { status: 429 })),
    });
    expect(outcome).toEqual({ ok: false, kind: "rate-limited" });
    const completed = events.find((event) => event.op === "speech.stt.request.completed");
    expect(completed).toMatchObject({
      level: "warn",
      category: "gateway",
      op: "speech.stt.request.completed",
      correlationId: "corr-stt-rate-limit",
      errorKind: "rate-limited",
      extra: {
        outcome: "failed",
        failureKind: "rate-limited",
        timeoutMs: GATEWAY_VOICE_TIMEOUT_FLOOR_MS,
      },
    });
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
    const fetchImpl = mockFetch(async (_url, init) => {
      body = await bodyToText(init);
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
    const fetchImpl = mockFetch(async (_url, init) => {
      body = await bodyToText(init);
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
