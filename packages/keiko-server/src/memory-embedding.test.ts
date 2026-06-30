// #204 — memory embedding boundary tests.
//
// Covers: capability-aware model selection, embed-on-
// capture storage, the graceful no-model path, the swallow-on-failure contract, and the pure
// cosine helper. The gateway is driven through an injected fake adapter (no network).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryVault,
  type MemoryEmbeddingInput,
  type MemoryEmbeddingRow,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { MemoryId, MemoryRecord, MemoryUserId } from "@oscharko-dev/keiko-contracts";
import {
  cosineSimilarity,
  embedAndStoreMemory,
  embedMemoryText,
  findRelatedNeighbors,
  findSemanticDuplicate,
  insertSalienceMemoryWithNoveltyGate,
  memoryEmbeddingCalibrationFor,
  memoryEmbeddingProviderIdentity,
  RELATED_LINK_COSINE_THRESHOLD,
  selectMemoryEmbeddingModelId,
} from "./memory-embedding.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";

const EMBEDDING_MODEL = "text-embedding-3-large";
const CHAT_MODEL = "gpt-4o-mini";

function fakeVector(length: number, seed = 1): Float32Array {
  return Float32Array.from({ length }, (_, i) => ((i + seed) % 7) / 7);
}

function gatewayConfig(modelId: string): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "redacted",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

interface DepsOptions {
  readonly modelId?: string;
  readonly config?: GatewayConfig | undefined;
  readonly embeddingRequest?: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>;
}

function okAdapter(
  dimensions = 3072,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      value: { vector: fakeVector(dimensions), modelId: EMBEDDING_MODEL },
    }),
  );
}

function makeDeps(options: DepsOptions = {}): UiHandlerDeps {
  const modelId = options.modelId ?? EMBEDDING_MODEL;
  const config = options.config ?? gatewayConfig(modelId);
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...(options.embeddingRequest !== undefined
      ? { localKnowledgeEmbeddingRequest: options.embeddingRequest }
      : { localKnowledgeEmbeddingRequest: okAdapter() }),
  };
}

let vaults: MemoryVaultStore[] = [];
let dirs: string[] = [];

beforeEach(() => {
  vaults = [];
  dirs = [];
});

afterEach(() => {
  for (const v of vaults) {
    try {
      v.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-mem-embed-"));
  dirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  vaults.push(vault);
  return vault;
}

function memoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

function memoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

function insertAccepted(vault: MemoryVaultStore, body: string): MemoryRecord {
  const now = Date.now();
  const record: MemoryRecord = {
    id: memoryId(`mem-${Math.random().toString(36).slice(2, 10)}`),
    schemaVersion: "1",
    scope: { kind: "user", userId: memoryUserId("local-operator") },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  return vault.insertMemory(record);
}

describe("selectMemoryEmbeddingModelId (#204)", () => {
  it("returns an embedding model id when one is configured", () => {
    expect(selectMemoryEmbeddingModelId(gatewayConfig(EMBEDDING_MODEL))).toBe(EMBEDDING_MODEL);
  });

  it("returns undefined when the only model is a chat model", () => {
    expect(selectMemoryEmbeddingModelId(gatewayConfig(CHAT_MODEL))).toBeUndefined();
  });

  it("accepts an explicit embedding capability even when the model id is not embed-shaped", () => {
    const modelId = "gateway-vector-01";
    expect(
      selectMemoryEmbeddingModelId({
        ...gatewayConfig(modelId),
        capabilities: [
          {
            id: modelId,
            kind: "embedding",
            contextWindow: 0,
            maxOutputTokens: 0,
            toolCalling: false,
            structuredOutput: false,
            streaming: false,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "runtime-configured",
            preferredUseCases: ["Tests"],
            knownLimitations: ["None"],
          },
        ],
      }),
    ).toBe(modelId);
  });

  it("returns undefined when no gateway config is present", () => {
    expect(selectMemoryEmbeddingModelId(undefined)).toBeUndefined();
  });
});

describe("embedMemoryText (#204)", () => {
  it("returns a vault-ready embedding input from the adapter", async () => {
    const deps = makeDeps();
    const input = await embedMemoryText(deps, "The user is building a product named Keiko");
    const [provider] = gatewayConfig(EMBEDDING_MODEL).providers;
    expect(provider).toBeDefined();
    expect(input).not.toBeNull();
    expect(input?.metric).toBe("cosine");
    if (provider === undefined) throw new Error("expected configured embedding provider");
    expect(input?.provider).toBe(memoryEmbeddingProviderIdentity(provider));
    expect(input?.modelId).toBe(EMBEDDING_MODEL);
    expect(input?.vector.length).toBe(3072);
  });

  it("returns null when no embedding model is configured", async () => {
    const deps = makeDeps({ modelId: CHAT_MODEL });
    expect(await embedMemoryText(deps, "anything")).toBeNull();
  });

  it("returns null on empty text without calling the adapter", async () => {
    const adapter = okAdapter();
    const deps = makeDeps({ embeddingRequest: adapter });
    expect(await embedMemoryText(deps, "")).toBeNull();
    expect(adapter).not.toHaveBeenCalled();
  });

  it("returns null when the adapter reports a failure", async () => {
    const failing = vi.fn(() =>
      Promise.resolve({ ok: false as const, kind: "rate-limited" as const }),
    );
    const deps = makeDeps({ embeddingRequest: failing });
    expect(await embedMemoryText(deps, "text")).toBeNull();
  });

  it("falls back to a later configured embedding provider when the first one fails", async () => {
    const unhealthyModelId = "text-embedding-3-small";
    const healthyModelId = "Qwen3-Embedding-8B";
    const seenModelIds: string[] = [];
    const adapter = vi.fn((request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
      seenModelIds.push(request.modelId);
      if (request.modelId === unhealthyModelId) {
        return Promise.resolve({ ok: false as const, kind: "unsupported-model" as const });
      }
      return Promise.resolve({
        ok: true as const,
        value: { vector: fakeVector(1536), modelId: request.modelId },
      });
    });
    const deps = makeDeps({
      config: {
        providers: [
          {
            modelId: unhealthyModelId,
            baseUrl: "https://gateway.example.test/v1",
            apiKey: "redacted",
            timeoutMs: 30_000,
            maxRetries: 1,
            retryBaseDelayMs: 100,
          },
          {
            modelId: healthyModelId,
            baseUrl: "https://gateway.example.test/v1",
            apiKey: "redacted",
            timeoutMs: 30_000,
            maxRetries: 1,
            retryBaseDelayMs: 100,
          },
        ],
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
      },
      embeddingRequest: adapter,
    });

    const input = await embedMemoryText(deps, "semantic memory probe");

    expect(seenModelIds).toEqual([unhealthyModelId, healthyModelId]);
    expect(input?.modelId).toBe(healthyModelId);
    expect(input?.vector.length).toBe(1536);
  });

  it("returns null (never throws) when the adapter throws", async () => {
    const throwing = vi.fn(() => Promise.reject(new Error("boom")));
    const deps = makeDeps({ embeddingRequest: throwing });
    await expect(embedMemoryText(deps, "text")).resolves.toBeNull();
  });
});

describe("embedAndStoreMemory (#204)", () => {
  it("stores an embedding for a captured memory", async () => {
    const deps = makeDeps();
    const vault = makeVault();
    const record = insertAccepted(vault, "The user is building a product named Keiko");
    await embedAndStoreMemory(deps, vault, record.id, record.body);
    const stored = vault.getEmbedding(record.id);
    expect(stored).toBeDefined();
    expect(stored?.dimensions).toBe(3072);
    expect(stored?.metric).toBe("cosine");
  });

  it("is a no-op when no embedding model is configured", async () => {
    const deps = makeDeps({ modelId: CHAT_MODEL });
    const vault = makeVault();
    const record = insertAccepted(vault, "no model so no embedding");
    await embedAndStoreMemory(deps, vault, record.id, record.body);
    expect(vault.getEmbedding(record.id)).toBeUndefined();
  });

  it("swallows a vault rejection so capture is never broken", async () => {
    // An empty vector is rejected by gateEmbeddingInput. embedAndStoreMemory must not throw.
    const emptyVec = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { vector: new Float32Array(0), modelId: EMBEDDING_MODEL },
      }),
    );
    const deps = makeDeps({ embeddingRequest: emptyVec });
    const vault = makeVault();
    const record = insertAccepted(vault, "body");
    await expect(embedAndStoreMemory(deps, vault, record.id, record.body)).resolves.toBeUndefined();
    expect(vault.getEmbedding(record.id)).toBeUndefined();
  });
});

describe("cosineSimilarity (#204)", () => {
  it("is 1 for identical vectors", () => {
    const v = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(v, Float32Array.from([1, 2, 3]))).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
  });

  it("clamps a negative cosine (opposite vectors) to 0", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBe(0);
  });

  it("returns 0 for length mismatch", () => {
    expect(cosineSimilarity(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toBe(0);
  });

  it("returns 0 for a zero-magnitude vector", () => {
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

function makeRecord(
  body: string,
  id = `mem-${Math.random().toString(36).slice(2, 10)}`,
  user = "local-operator",
): MemoryRecord {
  const now = Date.now();
  return {
    id: memoryId(id),
    schemaVersion: "1",
    scope: { kind: "user", userId: memoryUserId(user) },
    type: "preference",
    body,
    provenance: {
      sourceKind: "system-default",
      capturedAt: now,
      confidence: 0.6,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("memoryEmbeddingCalibrationFor", () => {
  it("resolves thresholds from provider/model and model fallback keys", () => {
    const env = {
      KEIKO_MEMORY_EMBEDDING_CALIBRATION: JSON.stringify({
        "qwen/qwen3-embedding": {
          semanticDedupThreshold: 0.91,
          relatedLinkThreshold: 0.76,
          mmrLambda: 0.62,
        },
        "text-embedding-3-large": {
          semanticDedupThreshold: 0.95,
        },
      }),
    };
    expect(
      memoryEmbeddingCalibrationFor(env, {
        provider: "qwen",
        modelId: "qwen3-embedding",
      }),
    ).toEqual({
      semanticDedupThreshold: 0.91,
      relatedLinkThreshold: 0.76,
      mmrLambda: 0.62,
    });
    expect(
      memoryEmbeddingCalibrationFor(env, {
        provider: "openai",
        modelId: "text-embedding-3-large",
      }),
    ).toEqual({ semanticDedupThreshold: 0.95 });
  });

  it("ignores malformed calibration config and out-of-range values", () => {
    expect(
      memoryEmbeddingCalibrationFor(
        {
          KEIKO_MEMORY_EMBEDDING_CALIBRATION: JSON.stringify({
            "openai/text-embedding-3-large": {
              semanticDedupThreshold: 2,
              relatedLinkThreshold: -1,
              mmrLambda: "0.7",
            },
          }),
        },
        { provider: "openai", modelId: "text-embedding-3-large" },
      ),
    ).toEqual({});
    expect(
      memoryEmbeddingCalibrationFor(
        { KEIKO_MEMORY_EMBEDDING_CALIBRATION: "not json" },
        { provider: "openai", modelId: "text-embedding-3-large" },
      ),
    ).toEqual({});
  });
});

describe("findSemanticDuplicate (#204, O-F1)", () => {
  const embRow = (id: string, vector: Float32Array): MemoryEmbeddingRow => ({
    memoryId: memoryId(id),
    provider: "openai",
    modelId: EMBEDDING_MODEL,
    dimensions: vector.length,
    metric: "cosine",
    vector,
    createdAt: 0,
  });
  const candidate: MemoryEmbeddingInput = {
    provider: "openai",
    modelId: EMBEDDING_MODEL,
    metric: "cosine",
    vector: Float32Array.from([1, 0, 0]),
  };

  it("returns null for a null candidate (no embedder)", () => {
    expect(findSemanticDuplicate(null, new Map())).toBeNull();
  });

  it("returns null when no neighbour is similar enough", () => {
    const neighbors = new Map([[memoryId("a"), embRow("a", Float32Array.from([0, 1, 0]))]]);
    expect(findSemanticDuplicate(candidate, neighbors)).toBeNull();
  });

  it("returns the nearest neighbour at or above the threshold", () => {
    const neighbors = new Map([
      [memoryId("far"), embRow("far", Float32Array.from([0, 1, 0]))],
      [memoryId("near"), embRow("near", Float32Array.from([1, 0, 0]))],
    ]);
    expect(findSemanticDuplicate(candidate, neighbors)).toBe(memoryId("near"));
  });

  it("does not merge a moderately-similar value-change below the threshold", () => {
    // A vector that shares direction but is clearly distinct (cosine ~0.83 < 0.95).
    const neighbors = new Map([[memoryId("v"), embRow("v", Float32Array.from([1, 0.66, 0]))]]);
    expect(findSemanticDuplicate(candidate, neighbors)).toBeNull();
  });
});

describe("insertSalienceMemoryWithNoveltyGate (#204, O-F1)", () => {
  it("inserts a genuinely new memory and stores its embedding", async () => {
    const deps = makeDeps();
    const vault = makeVault();
    const rec = makeRecord("the user prefers tabs over spaces");
    const { inserted, mergedInto } = await insertSalienceMemoryWithNoveltyGate(deps, vault, rec);
    expect(mergedInto).toBeNull();
    expect(inserted?.id).toBe(rec.id);
    expect(vault.getEmbedding(rec.id)).toBeDefined();
  });

  it("merges a semantic near-duplicate into the canonical and reinforces it instead of inserting", async () => {
    // okAdapter returns one fixed vector for every input => candidate cosine 1 to the canonical.
    const deps = makeDeps();
    const vault = makeVault();
    const canonical = makeRecord("the user prefers postgres", "id-canonical");
    await insertSalienceMemoryWithNoveltyGate(deps, vault, canonical);
    const before = vault.getAccessStats([canonical.id]).get(canonical.id)?.accessCount ?? 0;

    const dup = makeRecord("the user's database is postgresql", "id-dup");
    const result = await insertSalienceMemoryWithNoveltyGate(deps, vault, dup);
    expect(result.inserted).toBeNull();
    expect(result.mergedInto).toBe(canonical.id);
    expect(vault.getMemory(dup.id)).toBeUndefined();
    const after = vault.getAccessStats([canonical.id]).get(canonical.id)?.accessCount ?? 0;
    expect(after).toBe(before + 1);
  });

  it("does not merge into superseded memories during the semantic novelty check", async () => {
    const deps = makeDeps();
    const vault = makeVault();
    const canonical = makeRecord("the user prefers postgres", "id-canonical");
    await insertSalienceMemoryWithNoveltyGate(deps, vault, canonical);
    vault.updateMemory(canonical.id, { status: "superseded" }, Date.now());

    const dup = makeRecord("the user's database is postgresql", "id-dup");
    const result = await insertSalienceMemoryWithNoveltyGate(deps, vault, dup);
    expect(result.mergedInto).toBeNull();
    expect(result.inserted?.id).toBe(dup.id);
  });

  it("does NOT merge across scopes even with an identical vector (isolation)", async () => {
    const deps = makeDeps();
    const vault = makeVault();
    const alice = makeRecord("shared body text", "id-alice", "alice");
    await insertSalienceMemoryWithNoveltyGate(deps, vault, alice);
    const bob = makeRecord("shared body text", "id-bob", "bob");
    const result = await insertSalienceMemoryWithNoveltyGate(deps, vault, bob);
    expect(result.mergedInto).toBeNull();
    expect(result.inserted?.id).toBe(bob.id);
  });

  it("inserts plainly when no embedding model is configured (graceful)", async () => {
    const deps = makeDeps({ modelId: CHAT_MODEL });
    const vault = makeVault();
    const rec = makeRecord("anything at all");
    const { inserted, mergedInto } = await insertSalienceMemoryWithNoveltyGate(deps, vault, rec);
    expect(mergedInto).toBeNull();
    expect(inserted?.id).toBe(rec.id);
    expect(vault.getEmbedding(rec.id)).toBeUndefined();
  });
});

describe("findRelatedNeighbors (#204, O-P4)", () => {
  const row = (id: string, vector: Float32Array): MemoryEmbeddingRow => ({
    memoryId: memoryId(id),
    provider: "openai",
    modelId: EMBEDDING_MODEL,
    dimensions: vector.length,
    metric: "cosine",
    vector,
    createdAt: 0,
  });
  const candidate: MemoryEmbeddingInput = {
    provider: "openai",
    modelId: EMBEDDING_MODEL,
    metric: "cosine",
    vector: Float32Array.from([1, 0, 0]),
  };

  it("returns nothing for a null candidate", () => {
    expect(findRelatedNeighbors(null, new Map())).toEqual([]);
  });

  it("includes a band neighbour but excludes below-band and duplicate neighbours", () => {
    const neighbors = new Map([
      [memoryId("below"), row("below", Float32Array.from([1, 1, 0]))], // cosine ~0.707 < 0.82
      [memoryId("band"), row("band", Float32Array.from([0.9, 0.436, 0]))], // cosine ~0.9, in band
      [memoryId("dup"), row("dup", Float32Array.from([1, 0, 0]))], // cosine 1.0 >= 0.95, a duplicate
    ]);
    expect(findRelatedNeighbors(candidate, neighbors)).toEqual([memoryId("band")]);
  });

  it("ranks by similarity descending and caps at maxLinks", () => {
    const neighbors = new Map([
      [memoryId("n1"), row("n1", Float32Array.from([0.85, 0.527, 0]))], // ~0.85
      [memoryId("n2"), row("n2", Float32Array.from([0.93, 0.367, 0]))], // ~0.93
      [memoryId("n3"), row("n3", Float32Array.from([0.9, 0.436, 0]))], // ~0.90
      [memoryId("n4"), row("n4", Float32Array.from([0.88, 0.475, 0]))], // ~0.88
    ]);
    // top-3 by similarity desc: n2, n3, n4; n1 dropped by the cap of 3.
    expect(findRelatedNeighbors(candidate, neighbors)).toEqual([
      memoryId("n2"),
      memoryId("n3"),
      memoryId("n4"),
    ]);
  });

  it("honours the configured lower-band threshold constant", () => {
    expect(RELATED_LINK_COSINE_THRESHOLD).toBeGreaterThan(0.5);
    expect(RELATED_LINK_COSINE_THRESHOLD).toBeLessThan(0.95);
  });
});

describe("insertSalienceMemoryWithNoveltyGate auto-linking (#204, O-P4)", () => {
  function perTextAdapter(): (r: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
    return vi.fn((r: OpenAIEmbeddingRequest) => {
      const text = typeof r.input === "string" ? r.input : "";
      const vector = text.includes("alpha")
        ? Float32Array.from([1, 0, 0])
        : text.includes("beta")
          ? Float32Array.from([0.9, 0.436, 0]) // cosine ~0.9 to alpha => related band
          : Float32Array.from([0, 0, 1]);
      return Promise.resolve({ ok: true as const, value: { vector, modelId: EMBEDDING_MODEL } });
    });
  }

  it("links a novel capture to its in-band neighbour when KEIKO_MEMORY_AUTO_LINK=1", async () => {
    const deps: UiHandlerDeps = {
      ...makeDeps({ embeddingRequest: perTextAdapter() }),
      env: { KEIKO_MEMORY_AUTO_LINK: "1" },
    };
    const vault = makeVault();
    const a = await insertSalienceMemoryWithNoveltyGate(
      deps,
      vault,
      makeRecord("alpha note", "id-alpha"),
    );
    const b = await insertSalienceMemoryWithNoveltyGate(
      deps,
      vault,
      makeRecord("beta note", "id-beta"),
    );
    expect(a.inserted?.id).toBe(memoryId("id-alpha"));
    expect(b.inserted?.id).toBe(memoryId("id-beta"));
    const edges = vault.listOutgoingEdges(memoryId("id-beta"));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("related");
    expect(edges[0]?.toMemoryId).toBe(memoryId("id-alpha"));
    // The first capture had no neighbours, so it forms no link.
    expect(vault.listOutgoingEdges(memoryId("id-alpha"))).toEqual([]);
  });

  it("forms no links when the flag is off (default — byte-identical)", async () => {
    const deps = makeDeps({ embeddingRequest: perTextAdapter() });
    const vault = makeVault();
    await insertSalienceMemoryWithNoveltyGate(deps, vault, makeRecord("alpha note", "id-alpha"));
    await insertSalienceMemoryWithNoveltyGate(deps, vault, makeRecord("beta note", "id-beta"));
    expect(vault.listOutgoingEdges(memoryId("id-beta"))).toEqual([]);
  });
});
