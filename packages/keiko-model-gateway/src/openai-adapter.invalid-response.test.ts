// A response over the body size limit and a complete SSE frame that is not JSON are deterministic
// faults of the provider's answer, not transport cuts: they must not surface as the retryable
// TransportError the gateway would re-run for the whole outage window. A frame cut off by the
// connection (no terminating newline) stays a transport-class fault.
import { describe, expect, it } from "vitest";
import { TransportError } from "@oscharko-dev/keiko-security/errors/gateway";
import { MAX_RESPONSE_BYTES } from "./http.js";
import { OpenAiAdapter, ProviderResponseInvalidError } from "./openai-adapter.js";
import type { GatewayRequest, GatewayStreamChunk, ModelProviderConfig } from "./types.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-key",
  timeoutMs: 30_000,
  maxRetries: 1,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayRequest = {
  modelId: PROVIDER.modelId,
  messages: [{ role: "user", content: "Answer." }],
};

function adapterFor(body: string, contentType: string): OpenAiAdapter {
  return new OpenAiAdapter({
    fetchImpl: (): Promise<Response> =>
      Promise.resolve(new Response(body, { headers: { "content-type": contentType } })),
    now: (): number => Date.parse("2026-10-28T00:00:00Z"),
    requestId: "invalid-response-fixture",
    costClass: "low",
  });
}

async function streamFailure(adapter: OpenAiAdapter): Promise<unknown> {
  try {
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapter.callStream(REQUEST, PROVIDER)) chunks.push(chunk);
  } catch (error) {
    return error;
  }
  throw new Error("expected the stream to fail");
}

const FRAME = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

describe("an unusable provider response", () => {
  it("is a non-retryable invalid response when the SSE stream exceeds the size limit", async () => {
    const body = FRAME("x".repeat(1_000_000)).repeat(Math.ceil(MAX_RESPONSE_BYTES / 1_000_000) + 1);
    const failure = await streamFailure(adapterFor(body, "text/event-stream"));
    expect(failure).toBeInstanceOf(ProviderResponseInvalidError);
    expect(failure).not.toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({ retryable: false, reason: "size-exceeded" });
  });

  it("is a non-retryable invalid response when a complete SSE frame is not JSON", async () => {
    const failure = await streamFailure(
      adapterFor(`${FRAME("hello")}data: {oops}\n\n`, "text/event-stream"),
    );
    expect(failure).toBeInstanceOf(ProviderResponseInvalidError);
    expect(failure).toMatchObject({ retryable: false, reason: "json-invalid" });
  });

  it("is a non-retryable invalid response when a buffered body exceeds the size limit", async () => {
    const body = JSON.stringify({ pad: "x".repeat(MAX_RESPONSE_BYTES + 1) });
    const failure = await adapterFor(body, "application/json")
      .call(REQUEST, PROVIDER)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderResponseInvalidError);
    expect(failure).not.toBeInstanceOf(TransportError);
  });

  it("keeps a frame cut off before its newline a retryable transport fault", async () => {
    const failure = await streamFailure(
      adapterFor(`${FRAME("hello")}data: {"choices":[{"del`, "text/event-stream"),
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({ retryable: true });
  });
});
