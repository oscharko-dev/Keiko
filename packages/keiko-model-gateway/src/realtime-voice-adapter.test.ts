import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  DEFAULT_REALTIME_STREAMING_TRANSCRIPTION_MODEL,
  DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  DEFAULT_REALTIME_TRANSCRIPTION_DELAY,
  DEFAULT_REALTIME_TURN_DETECTION,
  DEFAULT_REALTIME_VOICE,
  MAX_SDP_BYTES,
  REALTIME_VOICES,
  isRealtimeVoice,
  requestRealtimeNegotiation,
  resolveRealtimeVoice,
  type RealtimeFunctionTool,
  type RealtimeSessionToolChoice,
  type RealtimeNegotiationRequest,
} from "./realtime-voice-adapter.js";
import { OutboundHttpEgressError } from "./http.js";

const SECRET_API_KEY = ["sk-", "test-keiko-realtime-1234567890abcdef"].join("");
const ENDPOINT = "https://realtime.example.invalid/v1";
const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP =
  "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const CONFIGURED_TRANSCRIPTION_MODEL = "configured-realtime-transcription";

type TestNegotiationRequest = Omit<RealtimeNegotiationRequest, "transcriptionModel"> &
  Partial<Pick<RealtimeNegotiationRequest, "transcriptionModel">>;

function requestConfiguredRealtimeNegotiation(
  request: TestNegotiationRequest,
): ReturnType<typeof requestRealtimeNegotiation> {
  return requestRealtimeNegotiation({
    transcriptionModel: CONFIGURED_TRANSCRIPTION_MODEL,
    ...request,
  });
}

type NarrowFetch = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  const f: NarrowFetch = async (url, init) => handler(url, init ?? {});
  return f as unknown as typeof fetch;
}

function sdp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/sdp" } });
}

function bodyToText(init: RequestInit): string {
  const body = init.body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("latin1");
  }
  return typeof body === "string" ? body : "";
}

describe("requestRealtimeNegotiation", () => {
  it("retains the published 0.2.15 compatibility symbols outside the productive session path", () => {
    const legacyTool: RealtimeFunctionTool = {
      type: "function",
      name: "legacy_grounding",
      parameters: {},
    };
    expect(DEFAULT_REALTIME_TRANSCRIPTION_MODEL).toBe("gpt-realtime-whisper");
    expect(DEFAULT_REALTIME_STREAMING_TRANSCRIPTION_MODEL).toBe("gpt-realtime-whisper");
    expect(DEFAULT_REALTIME_TRANSCRIPTION_DELAY).toBe("low");
    expect(DEFAULT_REALTIME_VOICE).toBe("alloy");
    expect(REALTIME_VOICES).toContain("alloy");
    expect(DEFAULT_REALTIME_TURN_DETECTION).toEqual({
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
      interrupt_response: true,
    });
    expect(isRealtimeVoice("alloy")).toBe(true);
    expect(resolveRealtimeVoice("unsupported")).toBe(DEFAULT_REALTIME_VOICE);
    expect(legacyTool.name).toBe("legacy_grounding");
    expectTypeOf<"none">().toExtend<RealtimeSessionToolChoice>();
  });

  it("keeps the published legacy request shape type-compatible but fails closed without an alias", async () => {
    let networkCalls = 0;
    const legacyRequest: RealtimeNegotiationRequest = {
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      instructions: "legacy assistant instruction",
      voiceId: "alloy",
      tools: [{ type: "function", name: "legacy_grounding", parameters: {} }],
      toolChoice: "auto",
      disableAutomaticResponse: true,
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => {
        networkCalls += 1;
        return sdp(ANSWER_SDP);
      }),
    };

    await expect(requestRealtimeNegotiation(legacyRequest)).resolves.toEqual({
      ok: false,
      kind: "unsupported-model",
    });
    expect(networkCalls).toBe(0);
  });

  it("uses the GA unified multipart call with the media-only session applied atomically", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenContentType = "";
    let seenAuth = "";
    let seenBody: BodyInit | null | undefined;
    const fetchImpl = mockFetch((url, init) => {
      seenUrl = url;
      seenMethod = init.method ?? "";
      const headers = init.headers as Record<string, string>;
      seenContentType = headers["content-type"] ?? "";
      seenAuth = headers.authorization ?? "";
      seenBody = init.body;
      return sdp(ANSWER_SDP);
    });

    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, value: { answerSdp: ANSWER_SDP } });
    expect(seenUrl).toBe("https://realtime.example.invalid/v1/realtime/calls");
    expect(seenMethod).toBe("POST");
    expect(seenContentType).toMatch(/^multipart\/form-data; boundary=keiko-realtime-/u);
    expect(seenAuth).toBe(`Bearer ${SECRET_API_KEY}`);
    expect(seenBody).toBeInstanceOf(Blob);
    const multipart = await (seenBody as Blob).text();
    expect(multipart).toContain('name="sdp"');
    expect(multipart).toContain(OFFER_SDP);
    expect(multipart).toContain('name="session"');
    expect(multipart).toContain('"model":"keiko-realtime"');
    expect(multipart).not.toContain("instructions");
    expect(multipart).not.toContain("tool_choice");
  });

  it("uses the input-only realtime session for standard-key live dictation", async () => {
    let seenBody: BodyInit | null | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      seenBody = init.body;
      return sdp(ANSWER_SDP);
    });

    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      sessionType: "transcription",
      transcriptionLanguage: "en",
      transcriptionDelay: "low",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, value: { answerSdp: ANSWER_SDP } });
    expect(seenBody).toBeInstanceOf(Blob);
    const multipart = await (seenBody as Blob).text();
    expect(multipart).toContain('"type":"realtime"');
    expect(multipart).toContain('"turn_detection":null');
    expect(multipart).toContain(`"model":"${CONFIGURED_TRANSCRIPTION_MODEL}","language":"en"`);
    expect(multipart).not.toContain('"type":"transcription"');
    expect(multipart).not.toContain('"delay"');
  });

  it("supports a custom apiKeyHeaderName (Azure api-key) and url-encodes the model id", async () => {
    let header: string | null = null;
    let seenUrl = "";
    const fetchImpl = mockFetch((url, init) => {
      header = (init.headers as Record<string, string>)["api-key"] ?? null;
      seenUrl = url;
      return sdp(ANSWER_SDP);
    });
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "gpt realtime/preview",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(header).toBe(SECRET_API_KEY);
    expect(seenUrl).toBe("https://realtime.example.invalid/v1/realtime/calls");
  });

  it("supports Azure-style ephemeral realtime sessions before the SDP call", async () => {
    const seen: {
      url: string;
      auth?: string | undefined;
      apiKey?: string | undefined;
      contentType?: string | undefined;
      body: string;
    }[] = [];
    const fetchImpl = mockFetch((url, init) => {
      const headers = init.headers as Record<string, string>;
      seen.push({
        url,
        auth: headers.authorization,
        apiKey: headers["api-key"],
        contentType: headers["content-type"],
        body: bodyToText(init),
      });
      if (url.endsWith("/realtime/client_secrets")) {
        return new Response(JSON.stringify({ value: "ephemeral-session-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, value: { answerSdp: ANSWER_SDP } });
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://realtime.example.invalid/v1/realtime/client_secrets",
      "https://realtime.example.invalid/v1/realtime/calls",
    ]);
    expect(seen[0]).toMatchObject({
      apiKey: SECRET_API_KEY,
      contentType: "application/json",
    });
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
      session: { type: "realtime", model: "keiko-realtime" },
    });
    expect(seen[1]).toMatchObject({
      auth: "Bearer ephemeral-session-token",
      contentType: "application/sdp",
      body: OFFER_SDP,
    });
    expect(seen[1]?.apiKey).toBeUndefined();
  });

  it("mints a media-only realtime session with transcription and response-disabled VAD", async () => {
    let clientSecretBody = "{}";
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/realtime/client_secrets")) {
        clientSecretBody = bodyToText(init);
        return new Response(JSON.stringify({ value: "ephemeral-session-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      transcriptionModel: "whisper-1",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    // The GA nested `audio.{input,output}` schema verified against the live endpoint (the top-level
    // `voice`/`input_audio_transcription` shape is rejected with HTTP 500).
    expect(JSON.parse(clientSecretBody)).toEqual({
      session: {
        type: "realtime",
        model: "keiko-realtime",
        output_modalities: ["audio"],
        audio: {
          input: {
            turn_detection: {
              ...DEFAULT_REALTIME_TURN_DETECTION,
              interrupt_response: false,
              create_response: false,
            },
            transcription: { model: "whisper-1" },
          },
        },
      },
    });
  });

  it("forwards an opt-in safety_identifier into the ephemeral session body when supplied", async () => {
    let clientSecretBody = "{}";
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/realtime/client_secrets")) {
        clientSecretBody = bodyToText(init);
        return new Response(JSON.stringify({ value: "ephemeral-session-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      safetyIdentifier: "keiko-voice-abc123",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    const parsed = JSON.parse(clientSecretBody) as { session: { safety_identifier?: unknown } };
    expect(parsed.session.safety_identifier).toBe("keiko-voice-abc123");
  });

  it("drops legacy assistant instructions, voice, and tools even from an untyped caller", async () => {
    let clientSecretBody = "{}";
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/realtime/client_secrets")) {
        clientSecretBody = bodyToText(init);
        return new Response(JSON.stringify({ value: "ephemeral-session-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    const legacyRequest = {
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      instructions: "legacy provider assistant instruction",
      voiceId: "shimmer",
      tools: [
        {
          type: "function",
          name: "search_keiko_grounding",
          parameters: { type: "object" },
        },
      ],
      toolChoice: "auto",
      fetchImpl,
    } as TestNegotiationRequest;
    await requestConfiguredRealtimeNegotiation(legacyRequest);

    const session = (JSON.parse(clientSecretBody) as { session: Record<string, unknown> }).session;
    expect(session.instructions).toBeUndefined();
    expect(session.tools).toBeUndefined();
    expect(session.tool_choice).toBeUndefined();
    expect((session.audio as { output?: unknown }).output).toBeUndefined();
  });

  it("uses configured input transcription and explicit VAD when optional fields are not supplied", async () => {
    let clientSecretBody = "{}";
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/realtime/client_secrets")) {
        clientSecretBody = bodyToText(init);
        return new Response(JSON.stringify({ value: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    const parsed = JSON.parse(clientSecretBody) as {
      session: {
        instructions?: unknown;
        audio: { output?: unknown; input: Record<string, unknown> };
      };
    };
    expect(parsed.session.instructions).toBeUndefined();
    expect(parsed.session.audio.output).toBeUndefined();
    expect(parsed.session.audio.input.transcription).toEqual({
      model: CONFIGURED_TRANSCRIPTION_MODEL,
    });
    expect(parsed.session.audio.input.turn_detection).toEqual({
      ...DEFAULT_REALTIME_TURN_DETECTION,
      interrupt_response: false,
      create_response: false,
    });
  });

  it("builds input-only realtime sessions for live dictation", async () => {
    let clientSecretBody = "{}";
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/realtime/client_secrets")) {
        clientSecretBody = bodyToText(init);
        return new Response(JSON.stringify({ value: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      sessionType: "transcription",
      transcriptionLanguage: "en",
      offerSdp: OFFER_SDP,
      safetyIdentifier: "must-not-be-forwarded",
      fetchImpl,
    });

    const parsed = JSON.parse(clientSecretBody) as {
      session: {
        type: unknown;
        output_modalities?: unknown;
        instructions?: unknown;
        voice?: unknown;
        audio: { input: { transcription: Record<string, unknown> }; output?: unknown };
        tools?: unknown;
        safety_identifier?: unknown;
      };
    };
    expect(parsed).toEqual({
      session: {
        type: "realtime",
        model: "keiko-realtime",
        output_modalities: ["audio"],
        audio: {
          input: {
            turn_detection: null,
            transcription: {
              model: CONFIGURED_TRANSCRIPTION_MODEL,
              language: "en",
            },
          },
        },
      },
    });
    expect(parsed.session.instructions).toBeUndefined();
    expect(parsed.session.audio.output).toBeUndefined();
    expect(parsed.session.tools).toBeUndefined();
    expect(parsed.session.safety_identifier).toBeUndefined();
  });

  it("always disables provider-native responses despite hostile turn-detection overrides", async () => {
    let clientSecretBody = "{}";
    const fetchImpl = mockFetch((url, init) => {
      if (url.endsWith("/realtime/client_secrets")) {
        clientSecretBody = bodyToText(init);
        return new Response(JSON.stringify({ value: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return sdp(ANSWER_SDP);
    });

    await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      realtimeAuthMode: "ephemeral-session",
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      turnDetection: {
        ...DEFAULT_REALTIME_TURN_DETECTION,
        interrupt_response: true,
        create_response: true,
      },
      fetchImpl,
    });

    const parsed = JSON.parse(clientSecretBody) as {
      session: { audio: { input: Record<string, unknown> } };
    };
    expect(parsed.session.audio.input.transcription).toEqual({
      model: CONFIGURED_TRANSCRIPTION_MODEL,
    });
    expect(parsed.session.audio.input.turn_detection).toEqual({
      ...DEFAULT_REALTIME_TURN_DETECTION,
      interrupt_response: false,
      create_response: false,
    });
  });

  it("fails closed before network access when the transcription alias is blank", async () => {
    let called = false;
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      transcriptionModel: "   ",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => {
        called = true;
        return sdp(ANSWER_SDP);
      }),
    });

    expect(outcome).toEqual({ ok: false, kind: "unsupported-model" });
    expect(called).toBe(false);
  });

  it("appends /realtime/calls without doubling a trailing slash on the endpoint", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return sdp(ANSWER_SDP);
    });
    await requestConfiguredRealtimeNegotiation({
      endpoint: "https://realtime.example.invalid/v1/",
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });
    expect(seenUrl).toBe("https://realtime.example.invalid/v1/realtime/calls");
  });

  it("rejects an answer that is not a well-formed SDP (no v= line) as invalid-response", async () => {
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp("<html>provider error page</html>")),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it("rejects an empty answer body as invalid-response", async () => {
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp("")),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it("rejects an answer larger than MAX_SDP_BYTES as invalid-response (unbounded-body defense)", async () => {
    const huge = "v=0\r\n" + "a=".repeat(MAX_SDP_BYTES);
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp(huge)),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it.each([
    [401, "wrong-header"],
    [403, "wrong-header"],
    [429, "rate-limited"],
    [404, "unsupported-model"],
    [413, "payload-too-large"],
    [400, "negotiation-failed"],
    [422, "negotiation-failed"],
    [500, "transport"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp("provider error body — never surfaced", status)),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a transport throw to transport", async () => {
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
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
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => {
        throw new OutboundHttpEgressError(code, "egress failure");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a thrown TimeoutError to timeout and a caller-aborted signal to cancelled", async () => {
    const timeout = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    });
    expect(timeout).toEqual({ ok: false, kind: "timeout" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      signal: controller.signal,
      fetchImpl: mockFetch(() => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(cancelled).toEqual({ ok: false, kind: "cancelled" });
  });

  it("maps a fired internal timeout signal to timeout (timeoutSignal.aborted branch)", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    try {
      const outcome = await requestConfiguredRealtimeNegotiation({
        endpoint: ENDPOINT,
        apiKey: SECRET_API_KEY,
        modelId: "keiko-realtime",
        offerSdp: OFFER_SDP,
        timeoutMs: 1,
        fetchImpl: mockFetch(() => {
          throw new DOMException("aborted", "AbortError");
        }),
      });
      expect(outcome).toEqual({ ok: false, kind: "timeout" });
    } finally {
      timeout.mockRestore();
    }
  });

  it("never leaks the provider URL, offer SDP, or credential into the outcome on failure", async () => {
    const outcome = await requestConfiguredRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp("provider 401 body", 401)),
    });
    const json = JSON.stringify(outcome);
    expect(json).not.toContain(SECRET_API_KEY);
    expect(json).not.toContain(ENDPOINT);
    expect(json).not.toContain("UDP/TLS/RTP/SAVPF");
  });
});
