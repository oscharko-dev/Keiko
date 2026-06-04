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
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "./openai-embedding-adapter.js";

const SECRET_API_KEY = "sk-test-keiko-embedding-1234567890abcdef";
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
      apiKey: "sk-test",
      modelId: "text-embedding-3-small",
      input: "ping",
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(capturedAuth).toBe("Bearer sk-test");
  });

  it("does NOT double-prefix when the apiKey already includes 'Bearer ' (Copilot)", async () => {
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
      apiKey: "Bearer already-prefixed",
      modelId: "m",
      input: "ping",
      fetchImpl,
    });
    expect(capturedAuth).toBe("Bearer already-prefixed");
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
