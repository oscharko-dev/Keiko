// #204 — memory embedding boundary tests.
//
// Covers: model selection (the /embed/i re-check that rejects a chat-model fallback), embed-on-
// capture storage, the graceful no-model path, the swallow-on-failure contract, and the pure
// cosine helper. The gateway is driven through an injected fake adapter (no network).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
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

  it("returns undefined when the only model is a chat model (no /embed/ fallback)", () => {
    // selectEmbeddingModelId would fall back to providers[0] (the chat model). The memory
    // re-check MUST reject it so a chat model is never used to embed.
    expect(selectMemoryEmbeddingModelId(gatewayConfig(CHAT_MODEL))).toBeUndefined();
  });

  it("returns undefined when no gateway config is present", () => {
    expect(selectMemoryEmbeddingModelId(undefined)).toBeUndefined();
  });
});

describe("embedMemoryText (#204)", () => {
  it("returns a vault-ready embedding input from the adapter", async () => {
    const deps = makeDeps();
    const input = await embedMemoryText(deps, "The user is building a product named Keiko");
    expect(input).not.toBeNull();
    expect(input?.metric).toBe("cosine");
    expect(input?.provider).toBe("openai");
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
