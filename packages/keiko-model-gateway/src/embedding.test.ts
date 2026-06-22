import { describe, expect, it } from "vitest";
import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";
import {
  assertCompatibleEmbeddingIdentity,
  verifyEmbeddingCapability,
  type EmbeddingProbeOptions,
  type OpenAIEmbeddingAdapter,
} from "./embedding.js";
import {
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "./openai-embedding-adapter.js";
import { OutboundHttpEgressError } from "./http.js";

const SECRET_API_KEY = ["sk-", "test-keiko-embedding-1234567890abcdef"].join("");
const PROVIDER_ENDPOINT = "https://internal.example.invalid/v1";

const PROBE: EmbeddingProbeOptions = {
  modelId: "embedding-small",
  provider: "internal-openai-compatible",
  vectorMetric: "cosine",
};

function adapterReturning(outcome: OpenAIEmbeddingOutcome): OpenAIEmbeddingAdapter {
  return {
    endpoint: PROVIDER_ENDPOINT,
    apiKey: SECRET_API_KEY,
    request: () => Promise.resolve(outcome),
  };
}

function recordingAdapter(outcome: OpenAIEmbeddingOutcome): {
  adapter: OpenAIEmbeddingAdapter;
  seen: OpenAIEmbeddingRequest[];
} {
  const seen: OpenAIEmbeddingRequest[] = [];
  const adapter: OpenAIEmbeddingAdapter = {
    endpoint: PROVIDER_ENDPOINT,
    apiKey: SECRET_API_KEY,
    request: (input) => {
      seen.push(input);
      return Promise.resolve(outcome);
    },
  };
  return { adapter, seen };
}

function successOutcome(dimensions: number, modelRevision?: string): OpenAIEmbeddingOutcome {
  return {
    ok: true,
    value: {
      vector: new Float32Array(dimensions).fill(0.5),
      modelId: PROBE.modelId,
      ...(modelRevision !== undefined ? { modelRevision } : {}),
    },
  };
}

function assertSafeMessage(safeMessage: string): void {
  expect(safeMessage).not.toContain(SECRET_API_KEY);
  expect(safeMessage).not.toContain(PROVIDER_ENDPOINT);
  expect(safeMessage).not.toContain("ping");
  expect(safeMessage).not.toContain("http://");
  expect(safeMessage).not.toContain("https://");
}

describe("verifyEmbeddingCapability", () => {
  it("returns ok with detected dimensions when the gateway responds with a valid vector", async () => {
    const result = await verifyEmbeddingCapability(adapterReturning(successOutcome(1536)), PROBE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.vectorDimensions).toBe(1536);
      expect(result.identity.provider).toBe(PROBE.provider);
      expect(result.identity.vectorMetric).toBe("cosine");
      expect(result.identity.modelRevision).toBeUndefined();
    }
  });

  it("carries modelRevision into the identity when the adapter exposes one", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning(successOutcome(8, "rev-7")),
      PROBE,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.modelRevision).toBe("rev-7");
    }
  });

  it("keeps the request model id stable and records provider canonicalization as modelRevision", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({
        ok: true,
        value: {
          vector: new Float32Array(8).fill(0.5),
          modelId: "text-embedding-3-small@2026-06",
        },
      }),
      PROBE,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.modelId).toBe(PROBE.modelId);
      expect(result.identity.modelRevision).toBe("text-embedding-3-small@2026-06");
    }
  });

  it("rejects when expectedDimensions does not match the detected vector length", async () => {
    const result = await verifyEmbeddingCapability(adapterReturning(successOutcome(512)), {
      ...PROBE,
      expectedDimensions: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("dimension-mismatch");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("trusts the detected dimensions over a client-supplied expectation when they agree", async () => {
    const result = await verifyEmbeddingCapability(adapterReturning(successOutcome(1024)), {
      ...PROBE,
      expectedDimensions: 1024,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.vectorDimensions).toBe(1024);
    }
  });

  it("maps wrong-header adapter outcomes to wrong-header without leaking", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "wrong-header" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-header");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("maps rate-limited adapter outcomes to rate-limited", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "rate-limited" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rate-limited");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("maps unsupported-model adapter outcomes to unsupported-model", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "unsupported-model" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported-model");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("maps timeout adapter outcomes to timeout", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "timeout" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("maps transport adapter outcomes to unavailable", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "transport" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unavailable");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("maps outbound egress adapter outcomes to distinct safe reasons", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "proxy-blocked-by-policy" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("proxy-blocked-by-policy");
      expect(result.safeMessage).toContain("proxy");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("maps invalid-response adapter outcomes to invalid-response", async () => {
    const result = await verifyEmbeddingCapability(
      adapterReturning({ ok: false, kind: "invalid-response" }),
      PROBE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-response");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("fails fast with missing-credentials when the adapter has no API key", async () => {
    let called = false;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: PROVIDER_ENDPOINT,
      apiKey: "   ",
      request: () => {
        called = true;
        return Promise.resolve(successOutcome(8));
      },
    };
    const result = await verifyEmbeddingCapability(adapter, PROBE);
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing-credentials");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("treats an empty vector as invalid-response even when the adapter reports ok", async () => {
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: PROVIDER_ENDPOINT,
      apiKey: SECRET_API_KEY,
      request: () =>
        Promise.resolve({
          ok: true,
          value: { vector: new Float32Array(0), modelId: PROBE.modelId },
        }),
    };
    const result = await verifyEmbeddingCapability(adapter, PROBE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-response");
    }
  });

  it("passes the configured probe input, model id, and timeout to the adapter", async () => {
    const signal = new AbortController().signal;
    const { adapter, seen } = recordingAdapter(successOutcome(4));
    await verifyEmbeddingCapability(adapter, {
      ...PROBE,
      signal,
      timeoutMs: 5_000,
    });
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request).toBeDefined();
    if (request !== undefined) {
      expect(request.modelId).toBe(PROBE.modelId);
      expect(request.input).toBe("ping");
      expect(request.timeoutMs).toBe(5_000);
      expect(request.signal).toBe(signal);
      expect(request.apiKey).toBe(SECRET_API_KEY);
    }
  });

  it("ensures the probe input is never echoed into any failure safeMessage", async () => {
    const kinds = [
      "wrong-header",
      "rate-limited",
      "unsupported-model",
      "timeout",
      "transport",
      "proxy-unreachable",
      "proxy-auth-required",
      "proxy-egress-failed",
      "proxy-blocked-by-policy",
      "tls-ca-failure",
      "invalid-response",
    ] as const;
    const results = await Promise.all(
      kinds.map((kind) => verifyEmbeddingCapability(adapterReturning({ ok: false, kind }), PROBE)),
    );
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        assertSafeMessage(result.safeMessage);
      }
    }
  });
});

const STORED: EmbeddingModelIdentity = {
  provider: "internal-openai-compatible",
  modelId: "embedding-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  modelRevision: "rev-1",
};

describe("assertCompatibleEmbeddingIdentity", () => {
  it("returns ok with no warning when every field is identical", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, { ...STORED });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toBeUndefined();
    }
  });

  it("flags provider mismatch as incompatible", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, {
      ...STORED,
      provider: "other-provider",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("incompatible-with-stored-identity");
      assertSafeMessage(result.safeMessage);
    }
  });

  it("flags modelId mismatch as incompatible", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, {
      ...STORED,
      modelId: "embedding-large",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("incompatible-with-stored-identity");
    }
  });

  it("flags vectorDimensions mismatch as incompatible", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, {
      ...STORED,
      vectorDimensions: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("incompatible-with-stored-identity");
    }
  });

  it("flags vectorMetric mismatch as incompatible", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, {
      ...STORED,
      vectorMetric: "euclidean",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("incompatible-with-stored-identity");
    }
  });

  it("returns ok with a model-revision-changed warning when only modelRevision differs", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, {
      ...STORED,
      modelRevision: "rev-2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toBeDefined();
      if (result.warning !== undefined) {
        expect(result.warning.code).toBe("model-revision-changed");
        expect(result.warning.previousRevision).toBe("rev-1");
        expect(result.warning.currentRevision).toBe("rev-2");
      }
    }
  });

  it("returns ok with a warning when previous revision was undefined and current is set", () => {
    const baseline: EmbeddingModelIdentity = {
      provider: STORED.provider,
      modelId: STORED.modelId,
      vectorDimensions: STORED.vectorDimensions,
      vectorMetric: STORED.vectorMetric,
    };
    const result = assertCompatibleEmbeddingIdentity(baseline, {
      ...baseline,
      modelRevision: "rev-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning?.code).toBe("model-revision-changed");
      expect(result.warning?.previousRevision).toBeUndefined();
      expect(result.warning?.currentRevision).toBe("rev-1");
    }
  });

  it("returns the CURRENT identity (not stored) on a revision-only change (#192 Copilot)", () => {
    const result = assertCompatibleEmbeddingIdentity(STORED, {
      ...STORED,
      modelRevision: "rev-NEW",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Returning `current` allows callers to persist the new revision and avoid a
      // permanent warning on every subsequent compatibility check.
      expect(result.identity.modelRevision).toBe("rev-NEW");
    }
  });
});

// Direct transport tests for the OpenAI embeddings adapter. Verifies header formatting
// (Bearer prefix reuse via apiKeyHeaderValue), status→kind classification, JSON shape
// parsing, and timeout vs cancellation distinction. #192 Copilot finding #5 — extensive
// transport coverage was missing for the new embeddings adapter.
describe("requestOpenAIEmbedding (direct transport)", () => {
  // gatewayFetch always passes a string URL as the first argument, so we can narrow to
  // (string, RequestInit?). The narrowed function is structurally compatible with the
  // wider `typeof fetch` signature accepted by `OpenAIEmbeddingRequest.fetchImpl`.
  type NarrowFetch = (url: string, init?: RequestInit) => Promise<Response>;
  function mockFetch(
    handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  ): typeof fetch {
    const f: NarrowFetch = async (url, init) => handler(url, init ?? {});
    return f as unknown as typeof fetch;
  }

  function makeSuccessBody(vector: readonly number[] = [0.1, 0.2, 0.3]): string {
    return JSON.stringify({
      data: [{ embedding: vector }],
      model: "text-embedding-3-small",
      model_revision: "rev-1",
    });
  }

  it("formats the authorization header as 'Bearer <key>' for the default header name", async () => {
    const apiKey = ["sk-", "test"].join("");
    let capturedAuth: string | null = null;
    const fetchImpl = mockFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      capturedAuth = headers.authorization ?? null;
      return new Response(makeSuccessBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const outcome = await requestOpenAIEmbedding({
      endpoint: "https://example.test/v1",
      apiKey,
      modelId: "text-embedding-3-small",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(capturedAuth).toBe(`Bearer ${apiKey}`);
  });

  it("does NOT double-prefix when the apiKey already includes 'Bearer ' (Copilot)", async () => {
    const bearerKey = ["Bearer", " ", "already-prefixed"].join("");
    let capturedAuth: string | null = null;
    const fetchImpl = mockFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      capturedAuth = headers.authorization ?? null;
      return new Response(makeSuccessBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await requestOpenAIEmbedding({
      endpoint: "https://example.test/v1",
      apiKey: bearerKey,
      modelId: "m",
      input: "ping",
      fetchImpl,
    });
    expect(capturedAuth).toBe(bearerKey);
  });

  it("uses raw key value for non-Bearer header names (e.g. api-key)", async () => {
    let capturedHeaderValue: string | null = null;
    const fetchImpl = mockFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      capturedHeaderValue = headers["api-key"] ?? null;
      return new Response(makeSuccessBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await requestOpenAIEmbedding({
      endpoint: "https://example.test/v1",
      apiKey: "raw-key",
      apiKeyHeaderName: "api-key",
      modelId: "m",
      input: "ping",
      fetchImpl,
    });
    expect(capturedHeaderValue).toBe("raw-key");
  });

  it("classifies status codes deterministically (401→wrong-header, 429→rate-limited, 404→unsupported-model, 500→transport)", async () => {
    const cases: [number, string][] = [
      [401, "wrong-header"],
      [403, "wrong-header"],
      [429, "rate-limited"],
      [404, "unsupported-model"],
      [500, "transport"],
      [502, "transport"],
    ];
    for (const [status, expectedKind] of cases) {
      const fetchImpl = mockFetch(() => new Response("error body — never read", { status }));
      const outcome = await requestOpenAIEmbedding({
        endpoint: "https://example.test/v1",
        apiKey: "k",
        modelId: "m",
        input: "ping",
        fetchImpl,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe(expectedKind);
    }
  });

  it("returns invalid-response when the JSON shape is missing data[0].embedding", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ data: [{}] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcome = await requestOpenAIEmbedding({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid-response");
  });

  it("classifies outbound egress transport errors distinctly", async () => {
    const fetchImpl = mockFetch(() =>
      Promise.reject(
        new OutboundHttpEgressError("TLS_CA_FAILURE", "custom CA secret was not trusted"),
      ),
    );
    const outcome = await requestOpenAIEmbedding({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("tls-ca-failure");
  });

  it("returns 'cancelled' when the caller's signal aborts (#192 Copilot)", async () => {
    const controller = new AbortController();
    const fetchImpl = mockFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          // Simulate fetch reacting to the abort. The classifier should treat caller-abort
          // as cancellation, NOT a timeout.
          controller.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const promise = requestOpenAIEmbedding({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      input: "ping",
      signal: controller.signal,
      timeoutMs: 60_000,
      fetchImpl,
    });
    controller.abort();
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("cancelled");
  });
});

describe("requestOpenAIEmbeddingBatch (array transport, #189 GRD-004)", () => {
  type NarrowFetch = (url: string, init?: RequestInit) => Promise<Response>;
  function mockFetch(
    handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  ): typeof fetch {
    const f: NarrowFetch = async (url, init) => handler(url, init ?? {});
    return f as unknown as typeof fetch;
  }
  function arrayBody(items: { index: number; embedding: readonly number[] }[]): string {
    return JSON.stringify({ data: items, model: "text-embedding-3-large" });
  }

  it("posts an array `input` and maps data[i].embedding back to value[i] in order", async () => {
    let sentBody: unknown = null;
    const fetchImpl = mockFetch((_url, init) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(
        arrayBody([
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] },
          { index: 2, embedding: [0, 0, 1] },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "text-embedding-3-large",
      inputs: ["a", "b", "c"],
      fetchImpl,
    });
    expect((sentBody as { input: unknown }).input).toEqual(["a", "b", "c"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.map((v) => Array.from(v.vector))).toEqual([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]);
    }
  });

  it("re-aligns by declared `index` even when the provider returns items out of order", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          arrayBody([
            { index: 2, embedding: [3, 3, 3] },
            { index: 0, embedding: [1, 1, 1] },
            { index: 1, embedding: [2, 2, 2] },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      inputs: ["x", "y", "z"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.map((v) => v.vector[0])).toEqual([1, 2, 3]);
    }
  });

  it("rejects a response whose data length does not match inputs (invalid-response)", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(arrayBody([{ index: 0, embedding: [1, 2, 3] }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      inputs: ["a", "b"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid-response");
  });

  it("rejects a duplicate / out-of-range index (invalid-response)", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          arrayBody([
            { index: 0, embedding: [1, 1] },
            { index: 0, embedding: [2, 2] },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      inputs: ["a", "b"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid-response");
  });

  it("returns an empty result without issuing a request for empty inputs", async () => {
    let called = 0;
    const fetchImpl = mockFetch(() => {
      called += 1;
      return new Response("{}", { status: 200 });
    });
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      inputs: [],
      fetchImpl,
    });
    expect(called).toBe(0);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toEqual([]);
  });

  it("classifies HTTP status (429 → rate-limited)", async () => {
    const fetchImpl = mockFetch(() => new Response("", { status: 429 }));
    const outcome = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "k",
      modelId: "m",
      inputs: ["a"],
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("rate-limited");
  });
});

describe("requestOpenAIEmbeddingBatch — branch coverage (#189 GRD-004)", () => {
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

  it("uses a custom apiKeyHeaderName and forwards the caller signal", async () => {
    let header: string | null = null;
    let hadSignal = false;
    const fetchImpl = mockFetch((_url, init) => {
      header = (init.headers as Record<string, string>)["api-key"] ?? null;
      hadSignal = init.signal != null;
      return ok({ data: [{ index: 0, embedding: [1, 2] }] });
    });
    const out = await requestOpenAIEmbeddingBatch({
      endpoint: "https://example.test/v1",
      apiKey: "raw-key",
      apiKeyHeaderName: "api-key",
      modelId: "m",
      inputs: ["a"],
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(header).toBe("raw-key");
    expect(hadSignal).toBe(true);
  });

  it("resolves modelId per item, then top-level model, then the request modelId", async () => {
    // item-level model wins
    const a = await requestOpenAIEmbeddingBatch({
      endpoint: "https://e/v1", apiKey: "k", modelId: "req-model", inputs: ["x"],
      fetchImpl: mockFetch(() => ok({ data: [{ index: 0, embedding: [1], model: "item-model" }] })),
    });
    expect(a.ok && a.value[0]?.modelId).toBe("item-model");
    // top-level model when no item model
    const b = await requestOpenAIEmbeddingBatch({
      endpoint: "https://e/v1", apiKey: "k", modelId: "req-model", inputs: ["x"],
      fetchImpl: mockFetch(() => ok({ model: "top-model", data: [{ index: 0, embedding: [1] }] })),
    });
    expect(b.ok && b.value[0]?.modelId).toBe("top-model");
    // request modelId when neither present
    const c = await requestOpenAIEmbeddingBatch({
      endpoint: "https://e/v1", apiKey: "k", modelId: "req-model", inputs: ["x"],
      fetchImpl: mockFetch(() => ok({ data: [{ index: 0, embedding: [1] }] })),
    });
    expect(c.ok && c.value[0]?.modelId).toBe("req-model");
  });

  it("carries model_revision when the payload provides one", async () => {
    const out = await requestOpenAIEmbeddingBatch({
      endpoint: "https://e/v1", apiKey: "k", modelId: "m", inputs: ["x"],
      fetchImpl: mockFetch(() => ok({ model_revision: "rev-9", data: [{ index: 0, embedding: [1] }] })),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value[0]?.modelRevision).toBe("rev-9");
  });

  it("rejects a non-record data item, a missing index, and a non-array embedding", async () => {
    for (const data of [[42], [{ embedding: [1] }], [{ index: 0, embedding: "nope" }]]) {
      const out = await requestOpenAIEmbeddingBatch({
        endpoint: "https://e/v1", apiKey: "k", modelId: "m", inputs: ["x"],
        fetchImpl: mockFetch(() => ok({ data })),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe("invalid-response");
    }
  });

  it("rejects when the payload is not an object or has no data array", async () => {
    for (const body of ["[]", JSON.stringify({ data: "x" })]) {
      const out = await requestOpenAIEmbeddingBatch({
        endpoint: "https://e/v1", apiKey: "k", modelId: "m", inputs: ["x"],
        fetchImpl: mockFetch(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe("invalid-response");
    }
  });

  it("maps a transport failure and a 500 status to error kinds", async () => {
    const thrown = await requestOpenAIEmbeddingBatch({
      endpoint: "https://e/v1", apiKey: "k", modelId: "m", inputs: ["x"],
      fetchImpl: mockFetch(() => { throw new Error("socket hang up"); }),
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.kind).toBe("transport");
    const server = await requestOpenAIEmbeddingBatch({
      endpoint: "https://e/v1", apiKey: "k", modelId: "m", inputs: ["x"],
      fetchImpl: mockFetch(() => new Response("", { status: 500 })),
    });
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.kind).toBe("transport");
  });
});
