import { afterEach, describe, expect, it, vi } from "vitest";

import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type {
  GatewayConfig,
  LiteLLMRerankRequest,
  RerankOutcome,
  RerankerConfig,
} from "@oscharko-dev/keiko-model-gateway";

import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import {
  applyRerankMapping,
  fallbackRerankSelection,
  rerankSelection,
} from "./grounded-rerank-facade.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogThreshold,
} from "./observability/index.js";
import { createInMemoryUiStore } from "./store/index.js";

type EgressConfig = NonNullable<GatewayConfig["egress"]>;

const GLOBAL_EGRESS: EgressConfig = {
  httpsProxy: "http://proxy.example:8080",
  noProxy: ["localhost"],
};

const RERANKER_EGRESS: EgressConfig = {
  caBundlePath: "/etc/keiko/reranker-ca.pem",
};

function rerankerConfig(egress?: EgressConfig): RerankerConfig {
  return {
    modelId: "qwen3-reranker",
    baseUrl: "https://reranker.example/v1",
    apiKey: "reranker-test-key",
    timeoutMs: 30_000,
    ...(egress === undefined ? {} : { egress }),
  };
}

function gatewayConfig(egress: EgressConfig = GLOBAL_EGRESS): GatewayConfig {
  return {
    providers: [],
    capabilities: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    egress,
    reranker: rerankerConfig(),
  };
}

function depsWith(
  config: GatewayConfig,
  rerankRequest: (request: LiteLLMRerankRequest) => Promise<RerankOutcome>,
): UiHandlerDeps {
  const env: Record<string, string> = {};
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, config),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    rerankRequest,
  };
}

function successfulOutcome(results: readonly { readonly index: number }[]): RerankOutcome {
  return { ok: true, value: { modelId: "qwen3-reranker", results } };
}

describe("rerankSelection", () => {
  it("passes the readiness fetch seam through the sole facade transport", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(gatewayConfig(), (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });

    await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fetchImpl,
      fallbackMode: "slice-topN",
    });

    expect(captured?.fetchImpl).toBe(fetchImpl);
    deps.store.close();
  });

  it("passes the shared gateway egress config when the reranker has no override", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(gatewayConfig(), (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });

    await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(captured?.egress).toEqual(GLOBAL_EGRESS);
    deps.store.close();
  });

  it("prefers a reranker-specific egress override", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const config: GatewayConfig = {
      ...gatewayConfig(GLOBAL_EGRESS),
      reranker: rerankerConfig(RERANKER_EGRESS),
    };
    const deps = depsWith(config, (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });

    await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(captured?.egress).toEqual(RERANKER_EGRESS);
    deps.store.close();
  });

  it("uses one gateway-config generation for reranker and shared egress", async () => {
    const pinnedEgress: EgressConfig = { noProxy: ["pinned.internal"] };
    const savedEgress: EgressConfig = { noProxy: ["saved.internal"] };
    const pinned: GatewayConfig = {
      ...gatewayConfig(pinnedEgress),
      reranker: { ...rerankerConfig(), baseUrl: "https://pinned.internal/v1" },
    };
    const saved: GatewayConfig = {
      ...gatewayConfig(savedEgress),
      reranker: { ...rerankerConfig(), baseUrl: "https://saved.internal/v1" },
    };
    let configReads = 0;
    let captured: LiteLLMRerankRequest | undefined;
    const base = depsWith(pinned, (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });
    const deps: UiHandlerDeps = {
      ...base,
      gatewayConfig: {
        storagePath: "/runtime/config.json",
        current: () => {
          configReads += 1;
          return configReads === 1 ? pinned : saved;
        },
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    };

    await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(configReads).toBe(1);
    expect(captured?.endpoint).toBe("https://pinned.internal/v1");
    expect(captured?.egress).toEqual(pinnedEgress);
    deps.store.close();
  });

  it("pins an explicitly observed absent gateway config", async () => {
    let configReads = 0;
    let transportCalls = 0;
    const deps = depsWith(gatewayConfig(), () => {
      transportCalls += 1;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });
    const runtimeDeps: UiHandlerDeps = {
      ...deps,
      gatewayConfig: {
        storagePath: "/runtime/config.json",
        current: () => {
          configReads += 1;
          return gatewayConfig();
        },
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    };

    const result = await rerankSelection({
      deps: runtimeDeps,
      gatewayConfig: null,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.diagnostics).toMatchObject({
      status: "disabled",
      failureKind: "not-configured",
    });
    expect({ configReads, transportCalls }).toEqual({ configReads: 0, transportCalls: 0 });
    deps.store.close();
  });

  it("denies external reranking before document materialization or transport", async () => {
    let documentCalls = 0;
    let transportCalls = 0;
    const deps = depsWith(gatewayConfig(), () => {
      transportCalls += 1;
      return Promise.resolve(successfulOutcome([{ index: 1 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b", "c"],
      documentFor: (candidate) => {
        documentCalls += 1;
        return candidate;
      },
      topN: 2,
      policy: { externalReranking: "deny", localReranking: "allow" },
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a", "b"]);
    expect(result.diagnostics).toEqual({
      status: "denied",
      mode: "local-only",
      candidateCount: 3,
      documentCount: 0,
      keptCount: 2,
      failureKind: "policy-denied",
      latencyMs: 0,
    });
    expect({ documentCalls, transportCalls }).toEqual({ documentCalls: 0, transportCalls: 0 });
    deps.store.close();
  });

  it("reports an unconfigured reranker without materializing documents", async () => {
    let documentCalls = 0;
    const deps = depsWith({ ...gatewayConfig(), reranker: undefined }, () =>
      Promise.resolve(successfulOutcome([{ index: 0 }])),
    );

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a"],
      documentFor: (candidate) => {
        documentCalls += 1;
        return candidate;
      },
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a"]);
    expect(result.diagnostics).toEqual({
      status: "disabled",
      mode: "none",
      candidateCount: 1,
      documentCount: 0,
      keptCount: 1,
      failureKind: "not-configured",
      latencyMs: 0,
    });
    expect(documentCalls).toBe(0);
    deps.store.close();
  });

  // Guard-order pin for issue #2567 D5. The configuration check runs BEFORE the empty-pool check, so
  // an unconfigured reranker reports "not-configured" even with nothing to rerank; only a CONFIGURED
  // reranker handed an empty pool reports the bare "disabled". See the rationale comment on
  // `rerankSelection` — the two pre-facade implementations disagreed here and this is the pinned
  // resolution, not an accident.
  it("reports not-configured ahead of an empty provider pool", async () => {
    const deps = depsWith({ ...gatewayConfig(), reranker: undefined }, () =>
      Promise.resolve(successfulOutcome([{ index: 0 }])),
    );

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: [],
      documentFor: (candidate: string) => candidate,
      topN: 4,
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual([]);
    expect(result.diagnostics).toEqual({
      status: "disabled",
      mode: "none",
      candidateCount: 0,
      documentCount: 0,
      keptCount: 0,
      failureKind: "not-configured",
      latencyMs: 0,
    });
    deps.store.close();
  });

  it("reports a bare disabled for an empty provider pool when a reranker IS configured", async () => {
    let transportCalls = 0;
    const deps = depsWith(gatewayConfig(), () => {
      transportCalls += 1;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b"],
      providerCandidates: [],
      documentFor: (candidate) => candidate,
      topN: 2,
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a", "b"]);
    expect(result.diagnostics).toEqual({
      status: "disabled",
      mode: "none",
      candidateCount: 0,
      documentCount: 0,
      keptCount: 2,
      latencyMs: 0,
    });
    expect(transportCalls).toBe(0);
    deps.store.close();
  });

  it("maps valid results and applies scores once", async () => {
    const deps = depsWith(gatewayConfig(), () =>
      Promise.resolve({
        ok: true,
        value: {
          modelId: "qwen3-reranker",
          results: [
            { index: 1, relevanceScore: 0.9 },
            { index: 0, relevanceScore: 0.6 },
          ],
        },
      }),
    );

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: [
        { id: "a", score: 0 },
        { id: "b", score: 0 },
      ],
      documentFor: (candidate) => candidate.id,
      topN: 2,
      applyScore: (candidate, rerank) => ({
        ...candidate,
        score: rerank.relevanceScore ?? candidate.score,
      }),
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual([
      { id: "b", score: 0.9 },
      { id: "a", score: 0.6 },
    ]);
    expect(result.diagnostics).toMatchObject({ status: "applied", keptCount: 2 });
    deps.store.close();
  });

  it.each([
    { label: "empty", results: [] },
    { label: "duplicate", results: [{ index: 0 }, { index: 0 }] },
    { label: "out-of-range", results: [{ index: 9 }] },
    { label: "non-integer", results: [{ index: 0.5 }] },
  ])("falls back with invalid diagnostics for $label mappings", async ({ results }) => {
    const deps = depsWith(gatewayConfig(), () => Promise.resolve(successfulOutcome(results)));

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a"]);
    expect(result.diagnostics).toMatchObject({
      status: "invalid-response",
      failureKind: "invalid-response",
      keptCount: 1,
    });
    deps.store.close();
  });

  it("uses identity fallback so empty provider results never drop candidates", async () => {
    const candidates = ["a", "b"] as const;
    const deps = depsWith(gatewayConfig(), () => Promise.resolve(successfulOutcome([])));

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates,
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "identity",
    });

    expect(result.selected).toBe(candidates);
    expect(result.diagnostics.status).toBe("invalid-response");
    deps.store.close();
  });

  it("maps thrown transport failures to redacted fallback diagnostics", async () => {
    const deps = depsWith(gatewayConfig(), () => {
      throw new Error("https://reranker.example/v1 leaked alpha and sk-secret");
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.diagnostics).toMatchObject({
      status: "unavailable",
      failureKind: "transport",
      candidateCount: 1,
      documentCount: 1,
      keptCount: 1,
    });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/reranker\.example|sk-secret/u);
    deps.store.close();
  });

  it("maps a thrown transport failure to cancelled for an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = depsWith(gatewayConfig(), () => Promise.reject(new Error("aborted")));

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      signal: controller.signal,
      fallbackMode: "slice-topN",
    });

    expect(result.diagnostics).toMatchObject({
      status: "unavailable",
      failureKind: "cancelled",
    });
    deps.store.close();
  });

  it.each(["rate-limited", "proxy-blocked-by-policy"] as const)(
    "maps %s outcomes to unavailable diagnostics",
    async (kind) => {
      const deps = depsWith(gatewayConfig(), () => Promise.resolve({ ok: false, kind }));

      const result = await rerankSelection({
        deps,
        query: "alpha",
        candidates: ["a", "b"],
        documentFor: (candidate) => candidate,
        topN: 1,
        fallbackMode: "slice-topN",
      });

      expect(result.diagnostics).toMatchObject({
        status: "unavailable",
        candidateCount: 2,
        documentCount: 2,
        keptCount: 1,
        failureKind: kind,
      });
      deps.store.close();
    },
  );

  it("keeps localReranking reserved and behaviorally inert", async () => {
    let transportCalls = 0;
    const deps = depsWith(gatewayConfig(), () => {
      transportCalls += 1;
      return Promise.resolve(successfulOutcome([{ index: 1 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b"],
      documentFor: (candidate) => candidate,
      topN: 1,
      policy: { externalReranking: "allow", localReranking: "deny" },
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["b"]);
    expect(transportCalls).toBe(1);
    deps.store.close();
  });

  it("separates fallback diagnostics from the pre-capped provider pool", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(gatewayConfig(), (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 1 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b", "c"],
      providerCandidates: ["a", "b"],
      documentFor: (candidate) => candidate,
      topN: 2,
      fallbackMode: "slice-topN",
    });

    expect(captured?.documents).toEqual(["a", "b"]);
    expect(result.selected).toEqual(["b"]);
    expect(result.diagnostics.candidateCount).toBe(2);
    deps.store.close();
  });
});

describe("rerank facade selection properties", () => {
  it("keeps mapped selections as bounded subset-permutations", () => {
    for (let size = 1; size <= 12; size += 1) {
      const candidates = Array.from({ length: size }, (_, index) => `candidate-${String(index)}`);
      const results = candidates.map((_candidate, index) => ({ index })).reverse();
      const topN = Math.max(1, Math.floor(size / 2));
      const selected = applyRerankMapping(candidates, results, topN);

      if (selected === undefined) throw new Error("valid generated mapping was rejected");
      expect(selected).toHaveLength(topN);
      expect(new Set(selected).size).toBe(selected.length);
      expect(selected.every((candidate) => candidates.includes(candidate))).toBe(true);
      expect(selected).not.toHaveLength(0);
    }
  });

  it("slices to topN in slice-topN mode and returns the input identity in identity mode", () => {
    const candidates = ["a", "b", "c"] as const;

    expect(fallbackRerankSelection(candidates, 2, "slice-topN")).toEqual(["a", "b"]);
    expect(fallbackRerankSelection(candidates, 1, "identity")).toBe(candidates);
    // Pins the documented exception to the AC3 invariant below: slice-topN with a non-positive topN
    // yields an EMPTY selection from a non-empty pool. No caller can reach it (every call site passes
    // a positive `maxPromptReferences`), so the behavior is pinned rather than changed.
    expect(fallbackRerankSelection(candidates, 0, "slice-topN")).toEqual([]);
    expect(fallbackRerankSelection(candidates, -1, "slice-topN")).toEqual([]);
  });

  // Seeded 32-bit LCG (Numerical Recipes constants): the generated provider responses below must be
  // reproducible from the seed alone, so this gate test carries no wall-clock or Math.random entropy.
  function createSeededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  // Mixed-shape indices: mostly in-range (which also produces natural DUPLICATES), plus out-of-range,
  // NaN and non-integer corruptions — the four rejection classes `mappedCandidateFor` guards.
  function generateRerankIndices(next: () => number, size: number): readonly number[] {
    const count = 1 + Math.floor(next() * size);
    return Array.from({ length: count }, () => {
      const roll = next();
      if (roll < 0.7) return Math.floor(next() * size);
      if (roll < 0.8) return size + Math.floor(next() * 4);
      if (roll < 0.9) return Number.NaN;
      return Math.floor(next() * size) + 0.5;
    });
  }

  function isValidRerankMapping(indices: readonly number[], size: number): boolean {
    const seen = new Set<number>();
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= size || seen.has(index)) return false;
      seen.add(index);
    }
    return true;
  }

  function expectMappingInvariant(
    candidates: readonly string[],
    indices: readonly number[],
    topN: number,
  ): boolean {
    const results = indices.map((index) => ({ index }));
    const selected = applyRerankMapping(candidates, results, topN);
    const valid = isValidRerankMapping(indices, candidates.length);

    if (!valid) {
      expect(selected).toBeUndefined();
    } else {
      if (selected === undefined) throw new Error("valid generated mapping was rejected");
      expect(selected).toHaveLength(Math.min(indices.length, topN));
      expect(new Set(selected).size).toBe(selected.length);
      expect(selected.every((candidate) => candidates.includes(candidate))).toBe(true);
    }
    // AC3's invariant, restated with the precondition it actually needs: given a NON-EMPTY candidate
    // pool AND topN > 0, the effective selection (mapping when usable, fallback otherwise) is never
    // empty. Without the `topN > 0` clause the claim is false — see the slice-topN pin above.
    const effective = selected ?? fallbackRerankSelection(candidates, topN, "slice-topN");
    expect(effective.length).toBeGreaterThan(0);
    return valid;
  }

  it("upholds the mapping and fallback invariants over seeded mixed-validity responses", () => {
    const next = createSeededRandom(0x5eed_2567);
    let mappedCount = 0;
    let rejectedCount = 0;

    for (let iteration = 0; iteration < 400; iteration += 1) {
      const size = 1 + Math.floor(next() * 12);
      const candidates = Array.from({ length: size }, (_, index) => `candidate-${String(index)}`);
      const topN = 1 + Math.floor(next() * size);
      const indices = generateRerankIndices(next, size);

      if (expectMappingInvariant(candidates, indices, topN)) mappedCount += 1;
      else rejectedCount += 1;
    }

    // Both branches must actually be exercised, otherwise the loop above proves only one of them.
    expect(mappedCount).toBeGreaterThan(0);
    expect(rejectedCount).toBeGreaterThan(0);
  });
});

// Every non-applied outcome hands the caller a usable selection, so nothing upstream can tell the
// provider was never asked, refused, or answered unusably. The log line is the only trace.
describe("rerankSelection activity log", () => {
  afterEach(() => {
    resetServerLogger();
  });

  function capture(level: ServerLogThreshold): BufferedServerLogSink {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level }));
    return sink;
  }

  const CANDIDATES = ["alpha document", "beta document", "gamma document"] as const;

  async function runSelection(
    deps: UiHandlerDeps,
    policy?: { readonly externalReranking: "allow" | "deny"; readonly localReranking: "allow" },
  ): Promise<void> {
    await rerankSelection({
      deps,
      query: "alpha",
      candidates: CANDIDATES,
      documentFor: (candidate) => candidate,
      topN: 2,
      fallbackMode: "slice-topN",
      ...(policy === undefined ? {} : { policy }),
    });
  }

  it("warns when policy denies external reranking and reports what the caller kept instead", async () => {
    const deps = depsWith(gatewayConfig(), () => Promise.reject(new Error("never called")));
    const sink = capture("info");

    await runSelection(deps, { externalReranking: "deny", localReranking: "allow" });

    const [event] = sink.events;
    expect(event?.level).toBe("warn");
    expect(event?.op).toBe("search.rerank.completed");
    expect(event?.category).toBe("search");
    expect(event?.errorKind).toBe("policy-denied");
    expect(event?.extra).toMatchObject({
      outcome: "denied",
      mode: "local-only",
      candidateCount: 3,
      keptCount: 2,
      fallbackMode: "slice-topN",
      topN: 2,
    });
  });

  it("warns on a provider fault and records the fallback size the caller silently received", async () => {
    const deps = depsWith(gatewayConfig(), () =>
      Promise.resolve({ ok: false, kind: "timeout" } as RerankOutcome),
    );
    const sink = capture("info");

    await runSelection(deps);

    const [event] = sink.events;
    expect(event?.level).toBe("warn");
    expect(event?.errorKind).toBe("timeout");
    expect(event?.extra).toMatchObject({
      outcome: "unavailable",
      mode: "provider-backed",
      documentCount: 3,
      keptCount: 2,
    });
  });

  it("warns when the provider answers with a mapping the facade cannot use", async () => {
    const deps = depsWith(gatewayConfig(), () =>
      Promise.resolve(successfulOutcome([{ index: 99 }])),
    );
    const sink = capture("info");

    await runSelection(deps);

    const [event] = sink.events;
    expect(event?.level).toBe("warn");
    expect(event?.errorKind).toBe("invalid-response");
    expect(event?.extra).toMatchObject({ outcome: "invalid-response", keptCount: 2 });
  });

  it("keeps the applied path and the unconfigured default install at debug", async () => {
    const applied = depsWith(gatewayConfig(), () =>
      Promise.resolve(successfulOutcome([{ index: 1 }, { index: 0 }])),
    );
    const unconfigured = depsWith({ ...gatewayConfig(), reranker: undefined }, () =>
      Promise.reject(new Error("never called")),
    );

    const atInfo = capture("info");
    await runSelection(applied);
    await runSelection(unconfigured);
    expect(atInfo.events).toEqual([]);

    const atDebug = capture("debug");
    await runSelection(applied);
    await runSelection(unconfigured);
    expect(atDebug.events.map((event) => event.extra?.outcome)).toEqual(["applied", "disabled"]);
    expect(atDebug.events.map((event) => event.level)).toEqual(["debug", "debug"]);
    expect(atDebug.events[1]?.errorKind).toBe("not-configured");
  });

  it("carries a duration and never a query, a document or the reranker credential", async () => {
    const deps = depsWith(gatewayConfig(), () =>
      Promise.resolve(successfulOutcome([{ index: 0 }, { index: 1 }])),
    );
    const sink = capture("debug");

    await runSelection(deps);

    const [event] = sink.events;
    expect(typeof event?.durationMs).toBe("number");
    expect(event?.extra).toHaveProperty("transportLatencyMs");
    const serialized = sink.lines().join("\n");
    // The query text, the candidate bodies and the reranker credential. `documentCount` is a
    // count and is expected to survive, so the assertion names the document TEXT, not the word.
    expect(serialized).not.toContain("alpha");
    expect(serialized).not.toContain("beta");
    expect(serialized).not.toContain("gamma");
    expect(serialized).not.toContain("reranker-test-key");
  });
});
