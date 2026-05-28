import { describe, expect, it } from "vitest";
import { OpenAiAdapter } from "../../src/gateway/openai-adapter.js";
import {
  AuthenticationError,
  CancelledError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
} from "../../src/gateway/errors.js";
import type { GatewayRequest, ModelProviderConfig } from "../../src/gateway/types.js";

const CONFIG: ModelProviderConfig = {
  modelId: "gpt-oss-120b",
  baseUrl: "https://provider.example/v1",
  apiKey: "sk-test-secret-key-1234567890abcd",
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
};

const REQUEST: GatewayRequest = {
  modelId: "gpt-oss-120b",
  messages: [{ role: "user", content: "hi" }],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function adapterWith(fetchImpl: typeof fetch): OpenAiAdapter {
  return new OpenAiAdapter({ fetchImpl, requestId: "fixed-id", costClass: "high", now: () => 0 });
}

describe("OpenAiAdapter.call", () => {
  it("returns a NormalizedResponse on a 200 with correct modelId and usage", async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      ),
    );
    const result = await adapter.call(REQUEST, CONFIG);
    expect(result.modelId).toBe("gpt-oss-120b");
    expect(result.content).toBe("pong");
    expect(result.usage.promptTokens).toBe(3);
    expect(result.usage.requestId).toBe("fixed-id");
    expect(result.usage.costClass).toBe("high");
  });

  it("sends the bearer credential in the Authorization header", async () => {
    let seenAuth: string | null = null;
    const adapter = adapterWith((_url, init) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization");
      return Promise.resolve(
        jsonResponse({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }),
      );
    });
    await adapter.call(REQUEST, CONFIG);
    expect(seenAuth).toBe("Bearer sk-test-secret-key-1234567890abcd");
  });

  it("throws AuthenticationError on HTTP 401", async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(jsonResponse({ error: "bad key" }, { status: 401 })),
    );
    await expect(adapter.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("throws AuthenticationError on HTTP 403", async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(jsonResponse({ error: "forbidden" }, { status: 403 })),
    );
    await expect(adapter.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("throws RateLimitError with retryAfterMs from the Retry-After header", async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(jsonResponse({}, { status: 429, headers: { "retry-after": "5" } })),
    );
    try {
      await adapter.call(REQUEST, CONFIG);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(5000);
    }
  });

  it("yields a null retryAfterMs when the Retry-After header is non-numeric", async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(jsonResponse({}, { status: 429, headers: { "retry-after": "soon" } })),
    );
    try {
      await adapter.call(REQUEST, CONFIG);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBeNull();
    }
  });

  it("throws ProviderError carrying the http status on a 500", async () => {
    const adapter = adapterWith(() => Promise.resolve(jsonResponse({}, { status: 503 })));
    try {
      await adapter.call(REQUEST, CONFIG);
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).httpStatus).toBe(503);
    }
  });

  it("throws TransportError when fetch rejects with a network TypeError", async () => {
    const adapter = adapterWith(() => Promise.reject(new TypeError("network down")));
    await expect(adapter.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(TransportError);
  });

  it("throws CancelledError when the cancellation signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = adapterWith(() => Promise.reject(new Error("should not be called")));
    await expect(
      adapter.call({ ...REQUEST, cancellationSignal: controller.signal }, CONFIG),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it("never includes the raw response body verbatim in a thrown error", async () => {
    const secretBody = { error: "contains sk-leak-aaaaaaaaaaaaaaaaaaaa internal trace" };
    const adapter = adapterWith(() => Promise.resolve(jsonResponse(secretBody, { status: 500 })));
    try {
      await adapter.call(REQUEST, CONFIG);
      expect.unreachable("should throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-leak-aaaaaaaaaaaaaaaaaaaa");
      expect((error as Error).message).not.toContain("internal trace");
    }
  });

  it("never includes the apiKey in a thrown error", async () => {
    const adapter = adapterWith(() => Promise.reject(new TypeError("boom")));
    try {
      await adapter.call(REQUEST, CONFIG);
      expect.unreachable("should throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(CONFIG.apiKey);
    }
  });

  it("throws TimeoutError when fetch aborts with a TimeoutError DOMException", async () => {
    const adapter = adapterWith(() =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    );
    await expect(adapter.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("throws TransportError when the provider body is not valid JSON", async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(new Response("<<not json>>", { status: 200 })),
    );
    await expect(adapter.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(TransportError);
  });

  it("serialises tool definitions and a json_schema response format into the request body", async () => {
    let sentBody: unknown;
    const adapter = adapterWith((_url, init) => {
      const raw = init?.body;
      sentBody = typeof raw === "string" ? JSON.parse(raw) : null;
      return Promise.resolve(
        jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
      );
    });
    await adapter.call(
      {
        ...REQUEST,
        tools: [{ name: "search", description: "find", parameters: { type: "object" } }],
        responseFormat: { type: "json_schema", schema: { type: "object" } },
      },
      CONFIG,
    );
    const body = sentBody as {
      tools: { type: string; function: { name: string } }[];
      response_format: { type: string };
    };
    expect(body.tools[0]?.function.name).toBe("search");
    expect(body.response_format.type).toBe("json_schema");
  });
});
