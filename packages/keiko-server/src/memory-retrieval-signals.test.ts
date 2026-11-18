import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault } from "@oscharko-dev/keiko-memory-vault";

import type { MemoryId, MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts";
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
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

const { embedMock, observations, searchMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  observations: [] as {
    readonly cacheGroupKey: string;
    readonly cacheKey: string;
    readonly ids: readonly string[];
    readonly revision: string;
  }[],
  searchMock: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-local-knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-local-knowledge")>();
  return { ...actual, searchUsearchAnnIndex: searchMock };
});

const { buildConversationRetrievalSignals } = await import("./memory-retrieval-signals.js");

const NOW_MS = 10_000;
const QUERY_TEXT = "memory query";
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
  return buildConversationRetrievalSignals(DEPS, vault, QUERY_TEXT, [SCOPE], NOW_MS, ALLOWED_GATE);
}

const ALLOWED_GATE = {
  allowed: true,
  reason: "allowed",
  matchesQuery: (query: string | undefined) => query === QUERY_TEXT,
  providerIdentity: IDENTITY.provider,
  embedQuery: embedMock,
} as const;

// A recording diagnostics sink, so a test can assert on the redaction-safe record a degraded
// semantic-retrieval path emits instead of on a console.warn call (#2902 O-F4).
function depsWithDiagnostics(): {
  readonly deps: UiHandlerDeps;
  readonly calls: ServerDiagnosticRecord[];
} {
  const calls: ServerDiagnosticRecord[] = [];
  const deps = {
    env: {},
    diagnostics: { record: (record: ServerDiagnosticRecord) => calls.push(record) },
  } as unknown as UiHandlerDeps;
  return { deps, calls };
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
        cacheGroupKey: request.partition.cacheGroupKey,
        cacheKey: request.partition.cacheKey,
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
  it("loads reinforcement only for eligible memories in the requested scopes", async () => {
    const alpha = memoryId("alpha");
    const archived = memoryId("archived");
    const outside = memoryId("outside");
    const stat = { lastAccessedAt: NOW_MS, accessCount: 2, outcomeCount: 0, utilitySum: 0 };
    const getAccessStats = vi.fn((ids?: readonly MemoryId[]) => {
      const stats = new Map([
        [alpha, stat],
        [archived, stat],
        [outside, stat],
      ]);
      return ids === undefined ? stats : new Map([...stats].filter(([id]) => ids.includes(id)));
    });
    const vault = {
      ...vaultFor(
        () => [metadata(alpha, 100), { ...metadata(archived, 200), status: "archived" }],
        new Map(),
      ),
      getAccessStats,
    };

    const signals = await collectSignals(vault);

    expect(getAccessStats).toHaveBeenCalledExactlyOnceWith([alpha]);
    expect([...signals.strengthById.keys()]).toEqual([alpha]);
  });

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
    expect(observations[0]?.cacheKey).toBe(observations[1]?.cacheKey);
    expect(observations[0]?.cacheGroupKey).toBe(observations[1]?.cacheGroupKey);
  });

  it("separates candidate-set caches while retaining one logical invalidation group", async () => {
    const alpha = memoryId("alpha");
    const beta = memoryId("beta");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [alpha, embedding(alpha, new Float32Array([1, 0]))],
      [beta, embedding(beta, new Float32Array([0, 1]))],
    ]);
    let includeBeta = true;
    const vault = vaultFor(
      () => (includeBeta ? [metadata(alpha, 200), metadata(beta, 100)] : [metadata(alpha, 200)]),
      embeddings,
    );

    await collectSignals(vault);
    includeBeta = false;
    await collectSignals(vault);

    expect(observations[0]?.cacheKey).not.toBe(observations[1]?.cacheKey);
    expect(observations[0]?.cacheGroupKey).toBe(observations[1]?.cacheGroupKey);
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
    expect(observations[0]?.cacheKey).toBe(observations[1]?.cacheKey);
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
    const { deps, calls } = depsWithDiagnostics();

    const signals = await buildConversationRetrievalSignals(
      deps,
      vault,
      QUERY_TEXT,
      [SCOPE],
      NOW_MS,
      ALLOWED_GATE,
    );

    expect(observations[0]?.ids).toEqual(["valid"]);
    expect([...(signals.semanticById?.keys() ?? [])]).toEqual([valid]);
    // Degraded semantic retrieval reaches the redaction-safe operator diagnostic sink (so it
    // lands in server.log and a support bundle), never only a console.warn nobody captures.
    const skipped = calls.find(
      (record) => record.operation === "memory.retrieval.semantic-skipped",
    );
    expect(skipped).toMatchObject({
      code: "identity-mismatch",
      semanticSkippedCount: 2,
      semanticCandidateCount: 3,
    });
    // Never the raw model id — only bounded counts and the closed-vocabulary reason code.
    expect(JSON.stringify(skipped)).not.toContain(IDENTITY.modelId);
  });

  it.each(["no-embeddings", "blocked-by-policy"] as const)(
    "records expected %s as a routine observation (#4247)",
    async (reason) => {
      const alpha = memoryId("alpha");
      const vault = vaultFor(() => [metadata(alpha, 100)], new Map());
      const { deps, calls } = depsWithDiagnostics();
      await buildConversationRetrievalSignals(
        deps,
        vault,
        QUERY_TEXT,
        [SCOPE],
        NOW_MS,
        reason === "no-embeddings" ? ALLOWED_GATE : { allowed: false, reason },
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          operation: "memory.retrieval.semantic-disabled",
          code: reason,
          diagnosticOutcome: "routine",
        }),
      );
    },
  );

  it("reports the vector-index failure reason without misclassifying it as an identity mismatch", async () => {
    const alpha = memoryId("alpha");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [alpha, embedding(alpha, new Float32Array([1, 0]))],
    ]);
    const vault = vaultFor(() => [metadata(alpha, 100)], embeddings);
    searchMock.mockResolvedValueOnce({ ok: false, reason: "runtime-integrity-failed" });
    const { deps, calls } = depsWithDiagnostics();

    const signals = await buildConversationRetrievalSignals(
      deps,
      vault,
      QUERY_TEXT,
      [SCOPE],
      NOW_MS,
      ALLOWED_GATE,
    );

    expect(signals.semanticById).toBeUndefined();
    const disabled = calls.find(
      (record) => record.operation === "memory.retrieval.semantic-disabled",
    );
    expect(disabled).toMatchObject({
      diagnosticOutcome: undefined,
      code: "vector-index-failed:runtime-integrity-failed",
      semanticCandidateCount: 1,
    });
  });

  it("reports a degraded conversation-memory recall diagnostic, not a knowledge-store citation one", async () => {
    // Regression pin (#2902 Finding 1 refinement): this module feeds chat/BFF conversation-memory
    // recall, not the local-knowledge citation-grounding pipeline. Its diagnostics must never be
    // mistaken for a local-knowledge-store event.
    const alpha = memoryId("alpha");
    const embeddings = new Map<MemoryId, MemoryEmbeddingRow>([
      [alpha, embedding(alpha, new Float32Array([1, 0]))],
    ]);
    const vault = vaultFor(() => [metadata(alpha, 100)], embeddings);
    searchMock.mockResolvedValueOnce({ ok: false, reason: "runtime-integrity-failed" });
    const { deps, calls } = depsWithDiagnostics();

    await buildConversationRetrievalSignals(deps, vault, QUERY_TEXT, [SCOPE], NOW_MS, ALLOWED_GATE);

    const disabled = calls.find(
      (record) => record.operation === "memory.retrieval.semantic-disabled",
    );
    expect(disabled?.source).toBe("memory-retrieval-signals");
    expect(disabled?.source).not.toMatch(/local-knowledge/iu);
  });
});

describe("semantic candidate validity before the bounded sweep", () => {
  it.each([
    { name: "future-only", futureCount: 1, current: false },
    { name: "future records ahead of a current record", futureCount: 160, current: true },
    { name: "inclusive valid-from boundary", futureCount: 0, current: true },
  ])("$name uses only facts valid at the pinned instant", async ({ futureCount, current }) => {
    const memoryDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-valid-query-"));
    const vault = createMemoryVault({
      memoryDir,
      vaultKey: Buffer.alloc(32, 3),
      now: () => NOW_MS,
    });
    const put = (id: string, validFrom: number, updatedAt: number): void => {
      const record: MemoryRecord = {
        id: memoryId(id),
        schemaVersion: "1",
        scope: SCOPE,
        type: "procedural",
        status: "accepted",
        body: "Use the published release checklist.",
        provenance: {
          sourceKind: "explicit-user-instruction",
          sensitivity: "public",
          confidence: 1,
          capturedAt: 1,
        },
        validity: { validFrom },
        createdAt: 1,
        updatedAt,
        pinned: false,
        tags: [],
      };
      vault.insertMemory(record);
      vault.upsertEmbedding(record.id, {
        provider: IDENTITY.provider,
        modelId: IDENTITY.modelId,
        metric: "cosine",
        vector: new Float32Array([1, 0]),
      });
    };
    try {
      if (current) put("current", NOW_MS, 1);
      for (let index = 0; index < futureCount; index += 1)
        put(`future-${String(index)}`, NOW_MS + 1, NOW_MS);
      const getAccessStats = vi.spyOn(vault, "getAccessStats");
      const signals = await collectSignals(vault);
      expect([...(signals.semanticById?.keys() ?? [])]).toEqual(
        current ? [memoryId("current")] : [],
      );
      expect(embedMock).toHaveBeenCalledTimes(current ? 1 : 0);
      expect(getAccessStats).toHaveBeenCalledExactlyOnceWith(current ? [memoryId("current")] : []);
      expect(observations.flatMap((entry) => entry.ids)).toEqual(current ? ["current"] : []);
    } finally {
      vault.close();
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });
});
