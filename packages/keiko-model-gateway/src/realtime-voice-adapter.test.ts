import { describe, expect, it } from "vitest";
import { MAX_SDP_BYTES, requestRealtimeNegotiation } from "./realtime-voice-adapter.js";
import { OutboundHttpEgressError } from "./http.js";

const SECRET_API_KEY = ["sk-", "test-keiko-realtime-1234567890abcdef"].join("");
const ENDPOINT = "https://realtime.example.invalid/v1";
const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP =
  "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

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
  it("POSTs the opaque offer SDP as application/sdp to /realtime/calls with the model and auth header", async () => {
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
      return sdp(ANSWER_SDP);
    });

    const outcome = await requestRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, value: { answerSdp: ANSWER_SDP } });
    expect(seenUrl).toBe("https://realtime.example.invalid/v1/realtime/calls?model=keiko-realtime");
    expect(seenMethod).toBe("POST");
    expect(seenContentType).toBe("application/sdp");
    expect(seenAuth).toBe(`Bearer ${SECRET_API_KEY}`);
    expect(seenBody).toBe(OFFER_SDP);
  });

  it("supports a custom apiKeyHeaderName (Azure api-key) and url-encodes the model id", async () => {
    let header: string | null = null;
    let seenUrl = "";
    const fetchImpl = mockFetch((url, init) => {
      header = (init.headers as Record<string, string>)["api-key"] ?? null;
      seenUrl = url;
      return sdp(ANSWER_SDP);
    });
    const outcome = await requestRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      apiKeyHeaderName: "api-key",
      modelId: "gpt realtime/preview",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(header).toBe(SECRET_API_KEY);
    expect(seenUrl).toBe(
      "https://realtime.example.invalid/v1/realtime/calls?model=gpt%20realtime%2Fpreview",
    );
  });

  it("appends /realtime/calls without doubling a trailing slash on the endpoint", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return sdp(ANSWER_SDP);
    });
    await requestRealtimeNegotiation({
      endpoint: "https://realtime.example.invalid/v1/",
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl,
    });
    expect(seenUrl).toBe("https://realtime.example.invalid/v1/realtime/calls?model=keiko-realtime");
  });

  it("rejects an answer that is not a well-formed SDP (no v= line) as invalid-response", async () => {
    const outcome = await requestRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp("<html>provider error page</html>")),
    });
    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it("rejects an empty answer body as invalid-response", async () => {
    const outcome = await requestRealtimeNegotiation({
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
    const outcome = await requestRealtimeNegotiation({
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
    const outcome = await requestRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      fetchImpl: mockFetch(() => sdp("provider error body — never surfaced", status)),
    });
    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps a transport throw to transport", async () => {
    const outcome = await requestRealtimeNegotiation({
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
    const outcome = await requestRealtimeNegotiation({
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
    const timeout = await requestRealtimeNegotiation({
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
    const cancelled = await requestRealtimeNegotiation({
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
    const outcome = await requestRealtimeNegotiation({
      endpoint: ENDPOINT,
      apiKey: SECRET_API_KEY,
      modelId: "keiko-realtime",
      offerSdp: OFFER_SDP,
      timeoutMs: 1,
      fetchImpl: mockFetch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new DOMException("aborted", "AbortError");
      }),
    });
    expect(outcome).toEqual({ ok: false, kind: "timeout" });
  });

  it("never leaks the provider URL, offer SDP, or credential into the outcome on failure", async () => {
    const outcome = await requestRealtimeNegotiation({
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
