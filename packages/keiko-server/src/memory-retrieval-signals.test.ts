import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryId, MemoryScope } from "@oscharko-dev/keiko-contracts";
import type {
  UsearchAnnSearchRequest,
  UsearchAnnSearchResult,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  MemoryEmbeddingInput,
  MemoryEmbeddingRow,
  MemoryMetadata,
  MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";

import type { UiHandlerDeps } from "./deps.js";

const { embedMock, observations, searchMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  observations: [] as { readonly ids: readonly string[]; readonly revision: string }[],
  searchMock: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-local-knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-local-knowledge")>();
  return { ...actual, searchUsearchAnnIndex: searchMock };
});

vi.mock("./memory-embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-embedding.js")>();
  return { ...actual, embedMemoryText: embedMock };
});

const { buildConversationRetrievalSignals } = await import("./memory-retrieval-signals.js");

const NOW_MS = 10_000;
const SCOPE: MemoryScope = { kind: "global" };
const IDENTITY = {
  provider: "test-provider",
  modelId: "test-embedding",
  vectorDimensions: 2,
  vectorMetric: "cosine",
} as const;
const QUERY_EMBEDDING: MemoryEmbeddingInput = {
  provider: IDENTITY.provider,
  modelId: IDENTITY.modelId,
  metric: IDENTITY.vectorMetric,
  vector: new Float32Array([1, 0]),
};
const DEPS = { env: {} } as unknown as UiHandlerDeps;

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function metadata(id: MemoryId, updatedAt: number): MemoryMetadata {
  return {
    id,
    schemaVersion: "1",
    scope: SCOPE,
    type: "preference",
    status: "accepted",
    sensitivity: "public",
    pinned: false,
    confidence: 1,
    validity: { validFrom: 1 },
    createdAt: 1,
    updatedAt,
  };
}

function embedding(memoryIdValue: MemoryId, vector: Float32Array): MemoryEmbeddingRow {
  return {
    memoryId: memoryIdValue,
    provider: IDENTITY.provider,
    modelId: IDENTITY.modelId,
    dimensions: IDENTITY.vectorDimensions,
    metric: IDENTITY.vectorMetric,
    vector,
    createdAt: 1,
  };
}

function vaultFor(
  metadataRows: () => readonly MemoryMetadata[],
  embeddings: ReadonlyMap<MemoryId, MemoryEmbeddingRow>,
): MemoryVaultStore {
  return {
    listMemoryMetadataByScope: metadataRows,
    getEmbeddings: (ids: readonly MemoryId[]) =>
      new Map(
        ids.flatMap((id) => {
          const row = embeddings.get(id);
          return row === undefined ? [] : [[id, row] as const];
        }),
      ),
    getAccessStats: () => new Map(),
  } as unknown as MemoryVaultStore;
}

function collectSignals(
  vault: MemoryVaultStore,
): ReturnType<typeof buildConversationRetrievalSignals> {
  return buildConversationRetrievalSignals(DEPS, vault, "memory query", [SCOPE], NOW_MS, {
    allowed: true,
    reason: "allowed",
  });
}

beforeEach(() => {
  observations.length = 0;
  embedMock.mockReset();
  embedMock.mockResolvedValue(QUERY_EMBEDDING);
  searchMock.mockReset();
  searchMock.mockImplementation(
    (request: UsearchAnnSearchRequest): Promise<UsearchAnnSearchResult> => {
      const entries = request.partition.loadEntries();
      observations.push({
        ids: entries.map((entry) => entry.id),
        revision: request.partition.revision,
      });
      return Promise.resolve({
        ok: true,
        mode: "exact",
        candidates: entries.map((entry) => ({ id: entry.id, score: 1 })),
        examinedCandidates: entries.length,
        estimatedIndexBytes: entries.reduce((total, entry) => total + entry.vector.byteLength, 0),
      });
    },
  );
});

describe("buildConversationRetrievalSignals", () => {
  it("reuses one canonical memory partition for candidate permutations", async () => {
    const alpha = memoryId("alpha");
    const beta = memoryId("beta");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [alpha, embedding(alpha, new Float32Array([1, 0]))],
      [beta, embedding(beta, new Float32Array([0, 1]))],
    ]);
    let reversed = false;
    const vault = vaultFor(
      () =>
        reversed
          ? [metadata(alpha, 100), metadata(beta, 200)]
          : [metadata(alpha, 200), metadata(beta, 100)],
      embeddings,
    );

    await collectSignals(vault);
    reversed = true;
    await collectSignals(vault);

    expect(observations.map((observation) => observation.ids)).toEqual([
      ["alpha", "beta"],
      ["alpha", "beta"],
    ]);
    expect(observations[0]?.revision).toBe(observations[1]?.revision);
  });

  it("changes the canonical partition revision when vector bytes change", async () => {
    const alpha = memoryId("alpha");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [alpha, embedding(alpha, new Float32Array([1, 0]))],
    ]);
    const vault = vaultFor(() => [metadata(alpha, 100)], embeddings);

    await collectSignals(vault);
    embeddings.set(alpha, embedding(alpha, new Float32Array([0, 1])));
    await collectSignals(vault);

    expect(observations[0]?.revision).not.toBe(observations[1]?.revision);
  });

  it("skips only stored rows whose vector norm is zero or non-finite", async () => {
    const invalidNonFinite = memoryId("invalid-non-finite");
    const invalidZero = memoryId("invalid-zero");
    const valid = memoryId("valid");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [invalidNonFinite, embedding(invalidNonFinite, new Float32Array([Number.NaN, 1]))],
      [invalidZero, embedding(invalidZero, new Float32Array([0, 0]))],
      [valid, embedding(valid, new Float32Array([1, 0]))],
    ]);
    const vault = vaultFor(
      () => [metadata(invalidNonFinite, 300), metadata(invalidZero, 200), metadata(valid, 100)],
      embeddings,
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const signals = await collectSignals(vault);

      expect(observations[0]?.ids).toEqual(["valid"]);
      expect([...(signals.semanticById?.keys() ?? [])]).toEqual([valid]);
      expect(warning).toHaveBeenCalledWith(
        "memory semantic scores skipped for incompatible embeddings",
        {
          reason: "identity-mismatch",
          skipped: 2,
          candidates: 3,
          queryModelId: IDENTITY.modelId,
        },
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("reports the vector-index failure reason without misclassifying it as an identity mismatch", async () => {
    const alpha = memoryId("alpha");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [alpha, embedding(alpha, new Float32Array([1, 0]))],
    ]);
    const vault = vaultFor(() => [metadata(alpha, 100)], embeddings);
    searchMock.mockResolvedValueOnce({ ok: false, reason: "runtime-integrity-failed" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const signals = await collectSignals(vault);

      expect(signals.semanticById).toBeUndefined();
      expect(warning).toHaveBeenCalledWith("memory semantic scores disabled", {
        reason: "vector-index-failed",
        vectorIndexReason: "runtime-integrity-failed",
        candidates: 1,
      });
    } finally {
      warning.mockRestore();
    }
  });
});
