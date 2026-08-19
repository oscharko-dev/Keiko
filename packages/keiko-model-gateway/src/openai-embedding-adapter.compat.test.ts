import { describe, expect, it, vi } from "vitest";
import { requestOpenAIEmbedding, requestOpenAIEmbeddingBatch } from "./openai-embedding-adapter.js";

// Strict-gateway compatibility ladder (customer field incident, 0.3.10): certain
// OpenAI-compatible gateways (LiteLLM routes over TEI-style backends) answer HTTP 400 to
// optional extras a plain curl never sends — the unconditional `encoding_format` and, on
// some backends, the array `input` shape. The adapter must fall back to the minimal wire
// shape instead of failing the entire indexing preflight.

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

const SCALAR_OK = { data: [{ embedding: [0.6, 0.8] }], model: "multilingual-e5-large" };

describe("strict-gateway embedding compat fallback", () => {
  it("retries a scalar request without encoding_format after an answered 400", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if ("encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "unknown field" } }, 400));
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    const outcome = await requestOpenAIEmbedding({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect("encoding_format" in bodyOf(fetchImpl.mock.calls[1] as unknown[])).toBe(false);
  });

  it("degrades a batch to per-item scalars when the gateway rejects array input", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input) || "encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "bad request" } }, 400));
      }
      return Promise.resolve(
        jsonResponse({
          data: [{ embedding: body.input === "eins" ? [1, 0] : [0, 1] }],
          model: "multilingual-e5-large",
        }),
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins", "zwei"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toHaveLength(2);
      expect(Array.from(outcome.value[0]?.vector ?? [])).toEqual([1, 0]);
      expect(Array.from(outcome.value[1]?.vector ?? [])).toEqual([0, 1]);
    }
    // array+extras 400, minimal array 400, then per item: extras 400 + minimal 200 (×2).
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("keeps the batch shape when only encoding_format is rejected", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if ("encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "unknown field" } }, 400));
      }
      return Promise.resolve(
        jsonResponse({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [0, 1] },
          ],
          model: "multilingual-e5-large",
        }),
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins", "zwei"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces the original 400 with status when the minimal retry also fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { message: "no" } }, 400)),
    );
    const outcome = await requestOpenAIEmbedding({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("http-error");
      expect(outcome.status).toBe(400);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a non-strict failure of the minimal batch retry with the original status", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      calls += 1;
      // First (extras) answer: strict 400. Minimal retry: hard 503 — NOT a shape problem, so
      // the ladder must stop and report the ORIGINAL strict status through the taxonomy.
      return Promise.resolve(
        jsonResponse(
          { error: { message: calls === 1 ? "shape" : "down" } },
          calls === 1 ? 400 : 503,
        ),
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(400);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails the scalar-fallback batch on the first failing item", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input) || "encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "bad" } }, 400));
      }
      if (body.input === "zwei") {
        return Promise.resolve(jsonResponse({ error: { message: "auth" } }, 401));
      }
      return Promise.resolve(
        jsonResponse({ data: [{ embedding: [1, 0] }], model: "multilingual-e5-large" }),
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins", "zwei", "drei"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("wrong-header");
    }
  });

  it("does not compat-retry auth failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { message: "auth" } }, 401)),
    );
    const outcome = await requestOpenAIEmbedding({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("wrong-header");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
