import { describe, expect, it, vi } from "vitest";

import { requestLiteLLMRerank, type LiteLLMRerankRequest } from "./rerank-adapter.js";
import { OutboundHttpEgressError } from "./http.js";

const SECRET_API_KEY = "sk-rerank-secret-1234567890";
const QUERY = "Which policy mentions alpha?";
const DOCUMENTS = ["alpha document", "beta document", "gamma document"];

function baseRequest(overrides: Partial<LiteLLMRerankRequest> = {}): LiteLLMRerankRequest {
  return {
    endpoint: "https://litellm.local/v1",
    apiKey: SECRET_API_KEY,
    modelId: "qwen3-reranker",
    query: QUERY,
    documents: DOCUMENTS,
    topN: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestLiteLLMRerank", () => {
  it("sends the Cohere-compatible model, query, documents, and top_n body", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ results: [{ index: 2, relevance_score: 0.91 }] })),
    );

    const outcome = await requestLiteLLMRerank(baseRequest({ fetchImpl }));

    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://litellm.local/v1/rerank");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${SECRET_API_KEY}`);
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "qwen3-reranker",
      query: QUERY,
      documents: DOCUMENTS,
      top_n: 2,
    });
  });

  it("maps response indices back to original candidate positions in provider order", async () => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({
              results: [
                { index: 2, relevance_score: 0.95 },
                { index: 0, relevance_score: 0.7 },
              ],
            }),
          ),
      }),
    );

    expect(outcome).toEqual({
      ok: true,
      value: {
        modelId: "qwen3-reranker",
        results: [
          { index: 2, relevanceScore: 0.95 },
          { index: 0, relevanceScore: 0.7 },
        ],
      },
    });
  });

  it("maps sorted document-text responses back to unique original documents", async () => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({
              results: [
                { document: { text: "beta document" }, relevance_score: 0.8 },
                { document: "alpha document", relevance_score: 0.5 },
              ],
            }),
          ),
      }),
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.results.map((item) => item.index)).toEqual([1, 0]);
    }
  });

  it.each([
    [401, "wrong-header"],
    [403, "wrong-header"],
    [404, "unsupported-model"],
    [429, "rate-limited"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({ error: { message: "do not leak provider body" } }, status),
          ),
      }),
    );

    expect(outcome).toEqual({ ok: false, kind });
  });

  it("maps timeout failures to timeout", async () => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () => Promise.reject(new DOMException("deadline", "TimeoutError")),
      }),
    );

    expect(outcome).toEqual({ ok: false, kind: "timeout" });
  });

  it.each([
    ["PROXY_UNREACHABLE", "proxy-unreachable"],
    ["PROXY_AUTH_REQUIRED", "proxy-auth-required"],
    ["PROXY_EGRESS_FAILED", "proxy-egress-failed"],
    ["PROXY_BLOCKED_BY_POLICY", "proxy-blocked-by-policy"],
    ["TLS_CA_FAILURE", "tls-ca-failure"],
  ] as const)("maps egress %s to %s", async (code, kind) => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () => Promise.reject(new OutboundHttpEgressError(code, "egress failed")),
      }),
    );

    expect(outcome).toEqual({ ok: false, kind });
  });

  it("returns invalid-response for ambiguous response shapes without guessing", async () => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () => Promise.resolve(jsonResponse({ results: [{ relevance_score: 0.8 }] })),
      }),
    );

    expect(outcome).toEqual({ ok: false, kind: "invalid-response" });
  });

  it("does not leak query, documents, endpoint, API key, or provider body in error outcomes", async () => {
    const outcome = await requestLiteLLMRerank(
      baseRequest({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse(
              {
                error: {
                  message: `${SECRET_API_KEY} ${QUERY} ${DOCUMENTS[0] ?? ""}`,
                },
              },
              500,
            ),
          ),
      }),
    );

    const serialized = JSON.stringify(outcome);
    expect(outcome).toEqual({ ok: false, kind: "transport" });
    expect(serialized).not.toContain(SECRET_API_KEY);
    expect(serialized).not.toContain(QUERY);
    expect(serialized).not.toContain(DOCUMENTS[0] ?? "");
    expect(serialized).not.toContain("litellm.local");
  });
});
