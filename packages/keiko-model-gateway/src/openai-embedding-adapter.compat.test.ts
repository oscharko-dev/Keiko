import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ladderDeadlineMs,
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  resetStrictGatewayMemoForTests,
} from "./openai-embedding-adapter.js";

beforeEach(() => {
  resetStrictGatewayMemoForTests();
});

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
    // array+extras 400, minimal array 400, item 1: extras 400 + minimal 200 (memoizes the
    // strict shape), item 2: minimal-first 200 — the memo saves the doomed extras round trip.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
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
      // kind and status must be a coherent pair from the SAME response — the last answer on
      // the wire was the 503, so the outcome reports the 503.
      expect(outcome.kind).toBe("http-error");
      expect(outcome.status).toBe(503);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("remembers a strict endpoint and skips the doomed extras round trip", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if ("encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "unknown field" } }, 400));
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    const request = {
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      input: "ping",
      fetchImpl,
    };
    await requestOpenAIEmbedding(request);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = await requestOpenAIEmbedding(request);
    expect(second.ok).toBe(true);
    // The memoized strictness sends the minimal shape FIRST: exactly one additional call.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect("encoding_format" in bodyOf(fetchImpl.mock.calls[2] as unknown[])).toBe(false);
  });

  it("scales the ladder budget per item instead of strangling slow gateways", () => {
    // Field incident (0.3.11): a FLAT 30s budget for a 64-item batch served one item per
    // request expired mid-batch; the batcher retried the transient timeout and discarded the
    // partial progress every time — indexing spun for hours without an error. The budget is
    // per-item times count, with the 15-minute runaway backstop.
    expect(ladderDeadlineMs(64, 30_000)).toBe(900_000);
    expect(ladderDeadlineMs(10, 200)).toBe(2_000);
    expect(ladderDeadlineMs(1, undefined)).toBe(30_000);
    expect(ladderDeadlineMs(0, 30_000)).toBe(30_000);
    expect(ladderDeadlineMs(1_000, 30_000)).toBe(900_000);
  });

  it("completes a slow strict gateway batch that a flat per-batch budget would strangle", async () => {
    const delayMs = 100;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input) || "encoding_format" in body) {
        return jsonResponse({ error: { message: "bad" } }, 400);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
      return jsonResponse({ data: [{ embedding: [1, 0] }], model: "multilingual-e5-large" });
    });
    // Ten items at ~100ms each need ~1s of wire time. A FLAT budget of timeoutMs (300ms)
    // expired after ~3 items — this pin fails against that shape. The scaled budget
    // (10 × 300ms) completes the batch with 3x headroom.
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: Array.from({ length: 10 }, (_, i) => `chunk-${String(i)}`),
      timeoutMs: 300,
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toHaveLength(10);
    }
  });

  it("stops the scalar fallback at the batch deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input) || "encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "bad" } }, 400));
      }
      return Promise.resolve(
        jsonResponse({ data: [{ embedding: [1, 0] }], model: "multilingual-e5-large" }),
      );
    });
    // timeoutMs 0: the ladder's absolute deadline is already exhausted when the scalar
    // fallback starts — it must stop with a timeout instead of walking all inputs.
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins", "zwei", "drei"],
      timeoutMs: 0,
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("timeout");
    }
    // Only the two array rungs ran; no per-item scalar request was issued past the deadline.
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

  it("carries the completed prefix when the ladder deadline expires mid-batch", async () => {
    // Non-convergence pin: a deadline expiry that DISCARDS the completed scalar prefix makes the
    // batcher's transient retry re-run an identical doomed full-length trial — indexing can then
    // never finish once inputCount x per-item latency exceeds the ladder cap. The failure must
    // hand the finished embeddings back so a retry resumes behind them.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let scalarCalls = 0;
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
        const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
        if (Array.isArray(body.input) || "encoding_format" in body) {
          return Promise.resolve(jsonResponse({ error: { message: "bad" } }, 400));
        }
        scalarCalls += 1;
        // Each served item costs 100ms of wall clock against the 5 x 50ms = 250ms ladder budget.
        vi.setSystemTime(Date.now() + 100);
        return Promise.resolve(
          jsonResponse({ data: [{ embedding: [1, 0] }], model: "multilingual-e5-large" }),
        );
      });
      const outcome = await requestOpenAIEmbeddingBatch({
        endpoint: "https://siu.llm.intern/v1",
        apiKey: "k",
        modelId: "multilingual-e5-large",
        inputs: ["eins", "zwei", "drei", "vier", "fuenf"],
        timeoutMs: 50,
        fetchImpl,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe("timeout");
        // Items 1-3 fit the budget (100/200/300ms checks pass at 0/100/200 elapsed); item 4 finds
        // the 250ms deadline exhausted. The three finished embeddings survive the failure.
        expect(outcome.partial).toHaveLength(3);
      }
      expect(scalarCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the completed prefix past a transient mid-batch item failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input) || "encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "bad" } }, 400));
      }
      if (body.input === "drei") {
        return Promise.resolve(jsonResponse({ error: { message: "busy" } }, 429));
      }
      return Promise.resolve(
        jsonResponse({ data: [{ embedding: [1, 0] }], model: "multilingual-e5-large" }),
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins", "zwei", "drei", "vier"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("rate-limited");
      expect(outcome.partial).toHaveLength(2);
    }
  });

  it("keeps a zero-progress failure partial-free so the batcher burns its retry budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input) || "encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "bad" } }, 400));
      }
      return Promise.resolve(jsonResponse({ error: { message: "busy" } }, 429));
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["eins", "zwei"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("rate-limited");
      expect(outcome.partial).toBeUndefined();
    }
  });
});
