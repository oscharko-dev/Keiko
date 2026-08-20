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
          data: [{ embedding: body.input === "one" ? [1, 0] : [0, 1] }],
          model: "multilingual-e5-large",
        }),
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://siu.llm.intern/v1",
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs: ["one", "two"],
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
      inputs: ["one", "two"],
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
      inputs: ["single"],
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
    // Hermetic clock: each served item ADVANCES the faked Date by 100ms instead of sleeping,
    // so the pin exercises exactly the budget arithmetic with zero wall-clock dependence.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
        const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
        if (Array.isArray(body.input) || "encoding_format" in body) {
          return Promise.resolve(jsonResponse({ error: { message: "bad" } }, 400));
        }
        vi.setSystemTime(Date.now() + 100);
        return Promise.resolve(
          jsonResponse({ data: [{ embedding: [1, 0] }], model: "multilingual-e5-large" }),
        );
      });
      // Ten items at 100ms each need 1s of budget. A FLAT budget of timeoutMs (300ms)
      // expired after ~3 items — this pin fails against that shape. The scaled budget
      // (10 x 300ms) completes the batch with 3x headroom.
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
    } finally {
      vi.useRealTimers();
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
      inputs: ["one", "two", "three"],
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
      if (body.input === "two") {
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
      inputs: ["one", "two", "three"],
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
        inputs: ["one", "two", "three", "four", "five"],
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
      if (body.input === "three") {
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
      inputs: ["one", "two", "three", "four"],
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
      inputs: ["one", "two"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("rate-limited");
      expect(outcome.partial).toBeUndefined();
    }
  });
});

// Second field incident (0.3.13), measured against the customer's own endpoint:
//   {"model":…,"input":"test"}                       -> HTTP 200 in 0.21s
//   {"model":…,"input":[3 items],"encoding_format":…} -> HTTP 400 (UnsupportedParamsError)
//   {"model":…,"input":[36 items]}                    -> HTTP 500 in 18.87s
// The gateway serves single inputs and fails the ARRAY — but with 500, not with the 400/422
// the ladder degraded on. So every attempt paid ~19s, returned a transient failure, and the
// batcher retried the identical doomed array: zero vectors, no error surfaced, for as long as
// an operator let it run. The capsule preflight embeds a 5-input probe batch through the same
// path, so the run died before its first document — "0 of 1 documents, 0 of 36 vectors".
describe("batch failure that is not a clean shape rejection", () => {
  const CUSTOMER_GATEWAY = "https://siu.llm.intern/v1";

  function batchRequest(
    inputs: readonly string[],
    fetchImpl: typeof fetch,
  ): Parameters<typeof requestOpenAIEmbeddingBatch>[0] {
    return {
      endpoint: CUSTOMER_GATEWAY,
      apiKey: "k",
      modelId: "multilingual-e5-large",
      inputs,
      fetchImpl,
    };
  }

  it("degrades to per-item scalars when the gateway answers the array with 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if ("encoding_format" in body) {
        return Promise.resolve(
          jsonResponse({ error: { message: "litellm.UnsupportedParamsError" } }, 400),
        );
      }
      if (Array.isArray(body.input)) {
        return Promise.resolve(jsonResponse({ error: { message: "internal error" } }, 500));
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    const outcome = await requestOpenAIEmbeddingBatch(batchRequest(["a", "b", "c"], fetchImpl));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toHaveLength(3);
  });

  it("remembers the endpoint so the next batch skips the doomed array entirely", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if ("encoding_format" in body) {
        return Promise.resolve(jsonResponse({ error: { message: "unsupported" } }, 400));
      }
      if (Array.isArray(body.input)) {
        return Promise.resolve(jsonResponse({ error: { message: "internal error" } }, 500));
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    await requestOpenAIEmbeddingBatch(batchRequest(["a", "b"], fetchImpl));
    fetchImpl.mockClear();
    const second = await requestOpenAIEmbeddingBatch(batchRequest(["c", "d"], fetchImpl));
    expect(second.ok).toBe(true);
    const arrayCalls = fetchImpl.mock.calls.filter((call) =>
      Array.isArray(bodyOf(call as unknown[]).input),
    );
    expect(arrayCalls).toHaveLength(0);
  });

  it("degrades when the array attempt fails without any HTTP answer at all", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input)) {
        return Promise.reject(new TypeError("socket hang up"));
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    const outcome = await requestOpenAIEmbeddingBatch(batchRequest(["a", "b"], fetchImpl));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toHaveLength(2);
  });

  // The probe must never dress a real outage up as a shape problem, and must never turn one
  // failed batch into N failed requests against a gateway that is genuinely down.
  it("reports the original failure, after exactly one probe, when scalars fail too", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { message: "service unavailable" } }, 503)),
    );
    const outcome = await requestOpenAIEmbeddingBatch(
      batchRequest(["a", "b", "c", "d"], fetchImpl),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Items that DID embed one at a time are the same evidence as a fully successful fallback:
  // the array shape is at fault, and the completed prefix must survive so the batcher resumes
  // behind it instead of re-paying every finished embedding.
  it("keeps partial scalar progress and still remembers the endpoint", async () => {
    let scalarCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input)) {
        return Promise.resolve(jsonResponse({ error: { message: "internal error" } }, 500));
      }
      scalarCalls += 1;
      return Promise.resolve(
        scalarCalls === 1
          ? jsonResponse(SCALAR_OK)
          : jsonResponse({ error: { message: "unavailable" } }, 503),
      );
    });
    const first = await requestOpenAIEmbeddingBatch(batchRequest(["a", "b", "c"], fetchImpl));
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.partial).toHaveLength(1);

    const bodiesBefore = fetchImpl.mock.calls.length;
    await requestOpenAIEmbeddingBatch(batchRequest(["d", "e"], fetchImpl));
    const laterBodies = fetchImpl.mock.calls
      .slice(bodiesBefore)
      .map((call) => bodyOf(call as unknown[]));
    expect(laterBodies.some((body) => Array.isArray(body.input))).toBe(false);
  });

  // The ladder budget is the runaway backstop. An exhausted budget must not start a probe it
  // cannot finish — that would turn one expired batch into N more expiring requests.
  it("does not probe when the ladder budget is already exhausted", async () => {
    // The clock is driven, not waited on: the array attempt itself consumes more than the whole
    // ladder budget, which is what an expired budget looks like in the field. No sleeping, no
    // ordering race — the guard is reached on every run or not at all.
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchImpl = vi.fn<typeof fetch>(() => {
      clock += ladderDeadlineMs(3, undefined) + 1;
      return Promise.reject(new TypeError("socket hang up"));
    });
    const outcome = await requestOpenAIEmbeddingBatch(batchRequest(["a", "b", "c"], fetchImpl));
    expect(outcome.ok).toBe(false);
    // One array attempt and nothing else: a budget with no room left must not start a probe it
    // cannot finish.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  // A cancellation that lands AFTER the gateway answered never reaches the error classifier, so
  // the failure still reads "http-error" while the caller is already gone. Checking only the
  // failure kind would fire the probe into a cancelled run.
  it("does not probe when the caller aborted after the failed array answer", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(() => {
      controller.abort();
      return Promise.resolve(jsonResponse({ error: { message: "internal error" } }, 500));
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      ...batchRequest(["a", "b", "c"], fetchImpl),
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The routing fields decide the URL. A deployment-style endpoint whose array attempt fails
  // must probe the SAME deployment URL — a probe sent to the plain /embeddings path tests a
  // different endpoint and can only report a false outage.
  it("keeps deployment routing on the scalar probe", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((url, init) => {
      urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input)) {
        return Promise.resolve(jsonResponse({ error: { message: "internal error" } }, 500));
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://contoso.openai.azure.test",
      apiKey: "k",
      modelId: "deployment-name",
      inputs: ["a", "b"],
      endpointStyle: "azure-openai-deployment",
      apiVersion: "2024-02-01",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(urls).toHaveLength(3);
    expect(urls.every((url) => url.includes("/openai/deployments/deployment-name/"))).toBe(true);
    expect(urls.every((url) => url.includes("api-version=2024-02-01"))).toBe(true);
  });

  // A throttle is the one failure that says nothing about the shape. Serving this batch item
  // by item is right; remembering the endpoint as array-hostile because of it would turn a
  // passing rate limit into a process-lifetime degradation.
  it("serves a throttled batch item by item without memoizing the endpoint", async () => {
    let arrayCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      if (Array.isArray(body.input)) {
        arrayCalls += 1;
        // Throttled while the limit holds, healthy once it passes.
        return Promise.resolve(
          arrayCalls === 1
            ? jsonResponse({ error: { message: "slow down" } }, 429)
            : jsonResponse({
                data: [
                  { index: 0, embedding: [0.6, 0.8] },
                  { index: 1, embedding: [0.8, 0.6] },
                ],
                model: "multilingual-e5-large",
              }),
        );
      }
      return Promise.resolve(jsonResponse(SCALAR_OK));
    });
    const first = await requestOpenAIEmbeddingBatch(batchRequest(["a", "b"], fetchImpl));
    expect(first.ok).toBe(true);
    const second = await requestOpenAIEmbeddingBatch(batchRequest(["c", "d"], fetchImpl));
    expect(second.ok).toBe(true);
    // The second batch tried the array again instead of being permanently degraded.
    expect(arrayCalls).toBeGreaterThanOrEqual(2);
  });

  it("does not fan out into scalar requests when the caller cancelled the batch", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const outcome = await requestOpenAIEmbeddingBatch({
      ...batchRequest(["a", "b", "c"], fetchImpl),
      signal: AbortSignal.abort(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
