import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryConsolidationJobEnvelopeWire,
  MemoryId,
  MemoryRecord,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import {
  createDefaultChatCapability,
  type GatewayConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  createConsolidationJobRegistry,
  type ConsolidationJobRegistry,
} from "./memory-consolidation-registry.js";
import {
  handleApplyConsolidationReviewItem,
  handleCancelConsolidationJob,
  handleCreateConsolidationJob,
  handleGetConsolidationJob,
} from "./memory-consolidation-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { createUiServer, UI_HOST } from "./server.js";

function makeReq(payload: unknown): IncomingMessage {
  const json = JSON.stringify(payload);
  return Readable.from([Buffer.from(json)]) as unknown as IncomingMessage;
}

function makeCtx(
  path: string,
  payload: unknown,
  params: Record<string, string> = {},
): RouteContext {
  const socket = new Socket();
  return {
    req: makeReq(payload),
    res: { socket } as unknown as RouteContext["res"],
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function makeDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    consolidationJobs: createConsolidationJobRegistry(),
    ...overrides,
  };
}

let activeVaults: MemoryVaultStore[] = [];
let tmpDirs: string[] = [];

beforeEach(() => {
  activeVaults = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const vault of activeVaults) {
    try {
      vault.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-consolidation-mem-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  activeVaults.push(vault);
  return vault;
}

function brandedMemoryId(value: string): MemoryId {
  return value as unknown as MemoryId;
}

function brandedMemoryUserId(value: string): MemoryUserId {
  return value as unknown as MemoryUserId;
}

function insertAcceptedMemory(
  vault: MemoryVaultStore,
  options: { id: string; body: string; userId?: string; confidence?: number },
): MemoryRecord {
  return insertMemory(vault, { ...options, status: "accepted" });
}

function insertMemory(
  vault: MemoryVaultStore,
  options: {
    id: string;
    body: string;
    userId?: string;
    confidence?: number;
    status: MemoryRecord["status"];
  },
): MemoryRecord {
  const now = Date.now();
  const record: MemoryRecord = {
    id: brandedMemoryId(options.id),
    schemaVersion: "1",
    scope: { kind: "user", userId: brandedMemoryUserId(options.userId ?? "u-1") },
    type: "preference",
    body: options.body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: now,
      confidence: options.confidence ?? 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: now },
    status: options.status,
    pinned: false,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  return vault.insertMemory(record);
}

function asJson(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

function asJobEnvelope(result: RouteResult): MemoryConsolidationJobEnvelopeWire {
  return asJson(result).job as MemoryConsolidationJobEnvelopeWire;
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("memory consolidation job handlers", () => {
  it("returns 503 when no vault is configured", async () => {
    const result = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {}),
      makeDeps({ memoryVault: undefined }),
    );
    expect(result.status).toBe(503);
  });

  it("registers a queued job and then skips when no memories match", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
        settings: { maxClustersPerRun: 10 },
      }),
      deps,
    );
    expect(result.status).toBe(202);
    const created = asJobEnvelope(result);
    expect(created.job.state).toBe("queued");
    expect(created.memoryCount).toBe(0);
    expect(created.settings.maxClustersPerRun).toBe(10);
    expect(created.settings.maxRecordsPerRun).toBe(1_000);
    await flushImmediate();
    const getResult = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${created.job.id}`, {}, { jobId: created.job.id }),
      deps,
    );
    const skipped = asJobEnvelope(getResult);
    expect(skipped.job.state).toBe("skipped");
    expect(skipped.memoryCount).toBe(0);
  });

  it("creates a job that can be polled to completion with review data", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { id: "m-1", body: "user prefers tabs in editor" });
    insertAcceptedMemory(vault, { id: "m-2", body: "user prefers tabs in the editor" });
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
        settings: { jaccardThreshold: 0.4 },
      }),
      deps,
    );
    expect(createResult.status).toBe(202);
    const createdJob = asJobEnvelope(createResult).job;
    await flushImmediate();
    const getResult = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
      deps,
    );
    expect(getResult.status).toBe(200);
    const fetched = asJobEnvelope(getResult);
    expect(fetched.job.state).toBe("completed");
    expect(fetched.memoryCount).toBe(2);
    expect(fetched.job.result?.edgesProposed).toHaveLength(3);
    expect(fetched.job.result?.recordsInspected).toBe(2);
    expect(fetched.job.result?.truncated).toBe(false);
    expect(fetched.job.result?.elapsedMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(fetched.job.result?.conflictPairsDetected).toBe(0);
  });

  it("wires stored embeddings into consolidation semantic duplicate detection", async () => {
    const vault = makeVault();
    const a = insertAcceptedMemory(vault, {
      id: "m-1",
      body: "deployment target is the Berlin workspace",
    });
    const b = insertAcceptedMemory(vault, {
      id: "m-2",
      body: "ship releases to the German operations environment",
    });
    vault.upsertEmbedding(a.id, {
      provider: "test",
      modelId: "mem-embed",
      metric: "cosine",
      vector: new Float32Array([1, 0]),
    });
    vault.upsertEmbedding(b.id, {
      provider: "test",
      modelId: "mem-embed",
      metric: "cosine",
      vector: new Float32Array([0.96, 0.28]),
    });
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
        settings: { jaccardThreshold: 0.99 },
      }),
      deps,
    );
    expect(createResult.status).toBe(202);
    const createdJob = asJobEnvelope(createResult).job;
    await flushImmediate();
    const getResult = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
      deps,
    );
    const fetched = asJobEnvelope(getResult);
    expect(fetched.job.state).toBe("completed");
    expect(fetched.job.result?.recordsInspected).toBe(2);
    expect(fetched.job.result?.edgesProposed).toHaveLength(3);
  });

  it("loads proposed memories by default and routes duplicate output to review", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { id: "m-1", body: "user prefers tabs in editor" });
    insertMemory(vault, {
      id: "m-2",
      body: "user prefers tabs in editor",
      status: "proposed",
    });
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    expect(createResult.status).toBe(202);
    const createdJob = asJobEnvelope(createResult).job;
    await flushImmediate();
    const getResult = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
      deps,
    );
    const fetched = asJobEnvelope(getResult);
    expect(fetched.job.state).toBe("completed");
    expect(fetched.memoryCount).toBe(2);
    expect(fetched.job.result?.edgesProposed).toEqual([]);
    expect(fetched.job.result?.reviewItems.map((item) => item.reason)).toEqual([
      "duplicate-review",
    ]);
    expect(fetched.job.result?.reviewItems[0]?.evidence?.[0]?.kind).toBe("lexical-similarity");
  });

  it("applies a reviewed proposal once and keeps the response body-free", async () => {
    const vault = makeVault();
    const proposed = insertMemory(vault, {
      id: "m-proposed",
      body: "sensitive local preference",
      status: "proposed",
    });
    insertAcceptedMemory(vault, {
      id: "m-winner",
      body: "sensitive local preference",
    });
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const jobId = asJobEnvelope(createResult).job.id;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
        deps,
      ),
    );
    const item = fetched.job.result?.reviewItems[0];
    expect(item?.memoryExcerpts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: proposed.id,
          bodyExcerpt: "sensitive local preference",
          expectedUpdatedAt: proposed.updatedAt,
        }),
      ]),
    );
    if (item === undefined) throw new Error("Expected a consolidation review item.");

    const apply = await handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        {
          preconditions: item.memoryExcerpts.map(({ memoryId, expectedUpdatedAt }) => ({
            memoryId,
            expectedUpdatedAt,
          })),
        },
        { jobId, itemId: item.id },
      ),
      deps,
    );

    expect(apply.status).toBe(200);
    expect(apply.body).toMatchObject({
      application: {
        outcome: "applied",
        itemId: item.id,
        affectedMemoryIds: [proposed.id],
      },
    });
    expect(JSON.stringify(apply.body)).not.toContain("sensitive local preference");
    expect(vault.getMemory(proposed.id)?.status).toBe("superseded");
    expect(vault.listOutgoingEdges(proposed.id)).toHaveLength(3);

    const second = await handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        {
          preconditions: item.memoryExcerpts.map(({ memoryId, expectedUpdatedAt }) => ({
            memoryId,
            expectedUpdatedAt,
          })),
        },
        { jobId, itemId: item.id },
      ),
      deps,
    );
    expect(second).toEqual(apply);
    expect(vault.listOutgoingEdges(proposed.id)).toHaveLength(3);
  });

  it("propagates non-precondition apply failures without a follow-up mutation or evidence leak", async () => {
    const vault = makeVault();
    const proposed = insertMemory(vault, {
      id: "m-storage-failure-proposed",
      body: "private storage failure proposal",
      status: "proposed",
    });
    insertAcceptedMemory(vault, {
      id: "m-storage-failure-winner",
      body: "private storage failure proposal",
    });
    const evidence = new Map<string, string>();
    const diagnostics: unknown[] = [];
    const deps = makeDeps({
      memoryVault: vault,
      diagnostics: { record: (record) => diagnostics.push(record) },
      evidenceStore: {
        put: (key, value) => {
          evidence.set(key, value);
          return key;
        },
        list: () => [...evidence.keys()],
        get: (key) => evidence.get(key),
        delete: (key) => evidence.delete(key),
      },
    });
    const created = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const jobId = asJobEnvelope(created).job.id;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
        deps,
      ),
    );
    const item = fetched.job.result?.reviewItems[0];
    if (item === undefined) throw new Error("Expected a consolidation review item.");
    const rawFailure = "private storage backend response";
    const applyGraphMutation = vi.spyOn(vault, "applyGraphMutation").mockImplementationOnce(() => {
      throw new Error(rawFailure);
    });

    const staticRoot = mkdtempSync(join(realpathSync(tmpdir()), "keiko-consolidation-static-"));
    tmpDirs.push(staticRoot);
    const serverDeps = {
      staticRoot,
      csp: "default-src 'none'",
      port: 0,
      handlerDeps: deps,
    };
    const server = createUiServer(serverDeps);
    await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
    const port = (server.address() as AddressInfo).port;
    serverDeps.port = port;
    let responseText = "";
    let responseStatus = 0;
    try {
      const response = await fetch(
        `http://${UI_HOST}:${String(port)}/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
          body: JSON.stringify({
            preconditions: item.memoryExcerpts.map(({ memoryId, expectedUpdatedAt }) => ({
              memoryId,
              expectedUpdatedAt,
            })),
          }),
        },
      );
      responseStatus = response.status;
      responseText = await response.text();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }

    expect(responseStatus).toBe(500);
    expect(JSON.parse(responseText)).toMatchObject({
      error: { code: "INTERNAL", message: "An unexpected error occurred." },
    });
    expect(responseText).not.toContain(rawFailure);
    expect(applyGraphMutation).toHaveBeenCalledTimes(1);
    expect(vault.getMemory(proposed.id)?.status).toBe("proposed");
    expect(vault.listOutgoingEdges(proposed.id)).toEqual([]);
    expect(JSON.stringify(diagnostics)).not.toContain(rawFailure);
    expect([...evidence.values()].join("\n")).not.toContain(rawFailure);
    expect([...evidence.values()].join("\n")).not.toContain("private storage failure proposal");
  });

  it("does not restore evidence-only review items as apply authority after restart", async () => {
    const vault = makeVault();
    insertMemory(vault, {
      id: "m-restart-proposed",
      body: "restart secret marker",
      status: "proposed",
    });
    insertAcceptedMemory(vault, {
      id: "m-restart-winner",
      body: "restart secret marker",
    });
    const evidence = new Map<string, string>();
    const evidenceStore = {
      put: (key: string, value: string): string => {
        evidence.set(key, value);
        return key;
      },
      list: (): readonly string[] => [...evidence.keys()],
      get: (key: string): string | undefined => evidence.get(key),
      delete: (key: string): boolean => evidence.delete(key),
    };
    const registry = createConsolidationJobRegistry({ evidenceStore });
    const deps = makeDeps({ memoryVault: vault, consolidationJobs: registry });
    const created = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const jobId = asJobEnvelope(created).job.id;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
        deps,
      ),
    );
    const item = fetched.job.result?.reviewItems[0];
    if (item === undefined) throw new Error("Expected a consolidation review item.");
    const mismatchedPreconditions = [
      {
        memoryId: item.memoryExcerpts[0]?.memoryId ?? brandedMemoryId("missing"),
        expectedUpdatedAt: 0,
      },
    ];

    const beforeRestart = await handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        { preconditions: mismatchedPreconditions },
        { jobId, itemId: item.id },
      ),
      deps,
    );
    expect(beforeRestart.status).toBe(409);
    expect(beforeRestart.body).toMatchObject({ error: { code: "PRECONDITION_MISMATCH" } });
    expect([...evidence.values()].join("")).not.toContain("restart secret marker");

    const restoredDeps = makeDeps({
      memoryVault: vault,
      consolidationJobs: createConsolidationJobRegistry({ evidenceStore }),
    });
    const afterRestart = await handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        { preconditions: mismatchedPreconditions },
        { jobId, itemId: item.id },
      ),
      restoredDeps,
    );
    expect(afterRestart.status).toBe(404);
    expect(afterRestart.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("moves a stale proposal to conflicted without persisting excerpts as evidence", async () => {
    const vault = makeVault();
    const proposed = insertMemory(vault, {
      id: "m-stale-proposal",
      body: "private stale proposal",
      status: "proposed",
    });
    const winner = insertAcceptedMemory(vault, {
      id: "m-stale-winner",
      body: "private stale proposal",
    });
    const evidence = new Map<string, string>();
    const deps = makeDeps({
      memoryVault: vault,
      consolidationJobs: createConsolidationJobRegistry({
        evidenceStore: {
          put: (key, value) => {
            evidence.set(key, value);
            return key;
          },
          list: () => [],
          get: (key) => evidence.get(key),
          delete: (key) => evidence.delete(key),
        },
      }),
    });
    const created = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const jobId = asJobEnvelope(created).job.id;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
        deps,
      ),
    );
    const item = fetched.job.result?.reviewItems[0];
    if (item === undefined) throw new Error("Expected a consolidation review item.");
    vault.updateMemory(winner.id, { body: "changed after review" }, winner.updatedAt + 1);

    const result = await handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        {
          preconditions: item.memoryExcerpts.map(({ memoryId, expectedUpdatedAt }) => ({
            memoryId,
            expectedUpdatedAt,
          })),
        },
        { jobId, itemId: item.id },
      ),
      deps,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      application: { outcome: "conflicted", affectedMemoryIds: [proposed.id] },
    });
    expect(vault.getMemory(proposed.id)?.status).toBe("conflicted");
    expect([...evidence.values()].join("")).not.toContain("private stale proposal");
    expect([...evidence.values()].join("")).not.toContain("bodyExcerpt");
  });

  it("fails closed when a proposed apply target has entered an illegal state", async () => {
    const vault = makeVault();
    const proposed = insertMemory(vault, {
      id: "m-illegal-proposal",
      body: "same proposal body",
      status: "proposed",
    });
    insertAcceptedMemory(vault, { id: "m-illegal-winner", body: "same proposal body" });
    const deps = makeDeps({ memoryVault: vault });
    const created = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const jobId = asJobEnvelope(created).job.id;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
        deps,
      ),
    );
    const item = fetched.job.result?.reviewItems[0];
    if (item === undefined) throw new Error("Expected a consolidation review item.");
    vault.updateMemory(proposed.id, { status: "rejected" }, proposed.updatedAt + 1);

    const result = await handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        {
          preconditions: item.memoryExcerpts.map(({ memoryId, expectedUpdatedAt }) => ({
            memoryId,
            expectedUpdatedAt,
          })),
        },
        { jobId, itemId: item.id },
      ),
      deps,
    );

    expect(result.status).toBe(409);
    expect(vault.getMemory(proposed.id)?.status).toBe("rejected");
    expect(vault.listOutgoingEdges(proposed.id)).toEqual([]);
  });

  it("propagates an edge constraint failure without relabeling the proposal as conflicted", async () => {
    const vault = makeVault();
    const proposed = insertMemory(vault, {
      id: "m-edge-proposal",
      body: "edge drift proposal",
      status: "proposed",
    });
    insertAcceptedMemory(vault, { id: "m-edge-winner", body: "edge drift proposal" });
    const deps = makeDeps({ memoryVault: vault });
    const created = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const jobId = asJobEnvelope(created).job.id;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
        deps,
      ),
    );
    const item = fetched.job.result?.reviewItems[0];
    const firstEdge = item?.proposedEdges?.[0];
    if (item === undefined || firstEdge === undefined) {
      throw new Error("Expected a consolidation review edge.");
    }
    vault.insertEdge(firstEdge);

    const apply = handleApplyConsolidationReviewItem(
      makeCtx(
        `/api/memory/consolidation/jobs/${jobId}/review-items/${item.id}/apply`,
        {
          preconditions: item.memoryExcerpts.map(({ memoryId, expectedUpdatedAt }) => ({
            memoryId,
            expectedUpdatedAt,
          })),
        },
        { jobId, itemId: item.id },
      ),
      deps,
    );

    await expect(apply).rejects.toThrow();
    expect(vault.getMemory(proposed.id)?.status).toBe("proposed");
    expect(vault.listOutgoingEdges(proposed.id)).toEqual([firstEdge]);
  });

  it("caps loaded records and marks the result truncated when a selection exceeds maxRecordsPerRun", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { id: "m-1", body: "unique memory one" });
    insertAcceptedMemory(vault, { id: "m-2", body: "unique memory two" });
    insertAcceptedMemory(vault, { id: "m-3", body: "unique memory three" });
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
        settings: { maxRecordsPerRun: 2 },
      }),
      deps,
    );
    expect(createResult.status).toBe(202);
    const createdJob = asJobEnvelope(createResult).job;
    await flushImmediate();
    const getResult = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
      deps,
    );
    const fetched = asJobEnvelope(getResult);
    expect(fetched.job.state).toBe("completed");
    expect(fetched.memoryCount).toBe(2);
    expect(fetched.job.result?.recordsInspected).toBe(2);
    expect(fetched.job.result?.truncated).toBe(true);
  });

  // The explicit-job loader does its own oldest-first pre-sort before slicing, so it reproduced
  // the engine's frozen-window defect independently of the engine's own comparator: the newest
  // memories were dropped before runConsolidation ever saw them. Both wired call sites have to
  // window on recency, or fixing one leaves the other silently broken.
  it("keeps the newest records when a selection exceeds maxRecordsPerRun", async () => {
    const vault = makeVault();
    const oldest = insertAcceptedMemory(vault, { id: "m-1", body: "unrelated archived note" });
    const middle = insertAcceptedMemory(vault, { id: "m-2", body: "user prefers tabs in editor" });
    const newest = insertAcceptedMemory(vault, { id: "m-3", body: "user prefers tabs in editor" });
    // Distinct, increasing updatedAt values: the helper stamps Date.now(), so records inserted in
    // one tick would otherwise be ordered only by the id tiebreak. Each stamp must stay at or
    // after its own createdAt, which the record validator enforces.
    vault.updateMemory(oldest.id, { tags: ["archive"] }, oldest.createdAt + 1_000);
    vault.updateMemory(middle.id, { tags: ["archive"] }, middle.createdAt + 2_000);
    vault.updateMemory(newest.id, { tags: ["archive"] }, newest.createdAt + 3_000);
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
        settings: { maxRecordsPerRun: 2 },
      }),
      deps,
    );
    expect(createResult.status).toBe(202);
    const createdJob = asJobEnvelope(createResult).job;
    await flushImmediate();
    const fetched = asJobEnvelope(
      handleGetConsolidationJob(
        makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
        deps,
      ),
    );
    expect(fetched.job.result?.recordsInspected).toBe(2);
    expect(fetched.job.result?.truncated).toBe(true);
    // The identical bodies of m-2/m-3 form a duplicate cluster, which surfaces as proposed edges.
    // Nothing at all is proposed if the window kept m-1 and m-2 instead.
    const endpoints =
      fetched.job.result?.edgesProposed.flatMap((edge) => [edge.fromMemoryId, edge.toMemoryId]) ??
      [];
    expect(endpoints).toContain("m-3");
    expect(endpoints).toContain("m-2");
    expect(endpoints).not.toContain("m-1");
  });

  it("cancels a queued job before execution starts", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { id: "m-1", body: "user prefers tabs in editor" });
    insertAcceptedMemory(vault, { id: "m-2", body: "user prefers tabs in the editor" });
    const deps = makeDeps({ memoryVault: vault });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
      }),
      deps,
    );
    const createdJob = asJobEnvelope(createResult).job;
    const cancelResult = handleCancelConsolidationJob(
      makeCtx(
        `/api/memory/consolidation/jobs/${createdJob.id}/cancel`,
        {},
        { jobId: createdJob.id },
      ),
      deps,
    );
    expect(cancelResult.status).toBe(202);
    const canceled = asJobEnvelope(cancelResult);
    expect(canceled.cancelRequested).toBe(true);
    expect(canceled.job.state).toBe("canceled");
    await flushImmediate();
    const fetched = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
      deps,
    );
    expect(asJobEnvelope(fetched).job.state).toBe("canceled");
  });

  it("folds a cancel request that arrives during the advisory phase into a canceled job (Issue #2130 / ADR-0120 D8)", async () => {
    const vault = makeVault();
    insertAcceptedMemory(vault, { id: "m-1", body: "user prefers dark mode everywhere" });
    insertAcceptedMemory(vault, { id: "m-2", body: "user prefers dark mode everywhere" });
    insertAcceptedMemory(vault, { id: "m-3", body: "user prefers dark mode everywhere" });
    const registry = createConsolidationJobRegistry();
    const modelId = "advisory-model";
    // Set once handleCreateConsolidationJob resolves, below — well before the model call actually
    // runs (it only runs once the job's setImmediate-scheduled work executes). A mutable container
    // (rather than a reassigned `let`) is captured by the closure below.
    const jobRef: { id?: string } = {};
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        // Simulate a cancel request landing while the advisory model call is in flight — exactly
        // the race ADR-0120 D8 closes (previously silently dropped once the pure engine returned).
        if (jobRef.id !== undefined) registry.requestCancel(jobRef.id);
        return Promise.resolve({
          modelId,
          content: "",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: { keep: "A", rationale: "Clear duplicate." },
          usage: {
            requestId: "advisory-request",
            promptTokens: 1,
            completionTokens: 1,
            latencyMs: 1,
            costClass: "medium",
          },
        });
      },
    };
    const config: GatewayConfig = {
      providers: [
        {
          modelId,
          baseUrl: "https://provider.example/v1",
          apiKey: "test-secret-value-1234567890",
          timeoutMs: 30_000,
          maxRetries: 0,
          retryBaseDelayMs: 500,
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      capabilities: [
        {
          ...createDefaultChatCapability(modelId),
          structuredOutput: true,
          supportsResponseFormat: true,
        },
      ],
    };
    const deps = makeDeps({
      memoryVault: vault,
      consolidationJobs: registry,
      env: { KEIKO_MEMORY_CONFLICT_ADVISORY: "1" },
      config,
      configPresent: true,
      modelPortFactory: () => model,
    });

    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", { scopes: [{ kind: "user", userId: "u-1" }] }),
      deps,
    );
    expect(createResult.status).toBe(202);
    jobRef.id = asJobEnvelope(createResult).job.id;
    const jobId = jobRef.id;
    await flushImmediate();

    const fetched = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${jobId}`, {}, { jobId }),
      deps,
    );
    const envelope = asJobEnvelope(fetched);
    expect(envelope.cancelRequested).toBe(true);
    expect(envelope.job.state).toBe("canceled");
    // The pure engine's own result (reviewItems, merge action) is preserved on the canceled
    // envelope — only `state` folds to "canceled"; the advisory pass does not discard work.
    expect(envelope.job.result?.reviewItems).toHaveLength(1);
    expect(envelope.job.result?.reviewItems[0]?.reason).toBe("multi-way-duplicate");
  });

  it("returns 400 for malformed settings", async () => {
    const vault = makeVault();
    const deps = makeDeps({ memoryVault: vault });
    const result = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", {
        scopes: [{ kind: "user", userId: "u-1" }],
        settings: { jaccardThreshold: "not-a-number" },
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it("does NOT forward a secret-bearing register() fault into the 409 envelope (COUPLING-004)", async () => {
    // The job-limit path must return a fixed code-keyed string, never the thrown error.message —
    // which a future registry implementation could compose from dynamic (path/credential) detail.
    const secret = "sk-" + "test0ABC123DEF456GHI789";
    const rawMessage = `registry full at /srv/keiko/jobs.db with token ${secret}`;
    const base = createConsolidationJobRegistry();
    const throwingRegistry: ConsolidationJobRegistry = {
      ...base,
      register: () => {
        throw new Error(rawMessage);
      },
    };
    const vault = makeVault();
    const result = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", { scopes: [{ kind: "user", userId: "u-1" }] }),
      makeDeps({ memoryVault: vault, consolidationJobs: throwingRegistry }),
    );
    expect(result.status).toBe(409);
    const body = result.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CONSOLIDATION_JOB_LIMIT");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/srv/keiko");
    expect(body.error.message).toBe("Consolidation job limit reached.");
  });

  it("does NOT persist a secret-bearing engine fault onto a failed job envelope (COUPLING-004)", async () => {
    // When the scheduled run throws (here: getEmbeddings faults mid-run) the job's stored `error`
    // must be a fixed, cause-free string. It surfaces to the browser via the job envelope, so a raw
    // path or credential in the engine error must never reach it.
    const secret = "sk-" + "test0ABC123DEF456GHI789";
    const rawMessage = `embedding read /srv/vault/embeddings.db failed: token ${secret}`;
    const vault = makeVault();
    insertAcceptedMemory(vault, { id: "m-1", body: "user prefers tabs in editor" });
    insertAcceptedMemory(vault, { id: "m-2", body: "user prefers tabs in the editor" });
    const faulty: MemoryVaultStore = {
      ...vault,
      getEmbeddings: () => {
        throw new Error(rawMessage);
      },
    };
    const deps = makeDeps({ memoryVault: faulty });
    const createResult = await handleCreateConsolidationJob(
      makeCtx("/api/memory/consolidation/jobs", { scopes: [{ kind: "user", userId: "u-1" }] }),
      deps,
    );
    expect(createResult.status).toBe(202);
    const createdJob = asJobEnvelope(createResult).job;
    await flushImmediate();
    const getResult = handleGetConsolidationJob(
      makeCtx(`/api/memory/consolidation/jobs/${createdJob.id}`, {}, { jobId: createdJob.id }),
      deps,
    );
    const fetched = asJobEnvelope(getResult);
    expect(fetched.job.state).toBe("failed");
    expect(fetched.job.error).toBe("Consolidation run failed.");
    const serialized = JSON.stringify(getResult.body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/srv/vault");
  });

  describe("settings range validation", () => {
    async function postSettings(
      vault: MemoryVaultStore,
      settings: Record<string, unknown>,
    ): Promise<RouteResult> {
      const result = await handleCreateConsolidationJob(
        makeCtx("/api/memory/consolidation/jobs", {
          scopes: [{ kind: "global" }],
          settings,
        }),
        makeDeps({ memoryVault: vault }),
      );
      if (result.status === 202) await flushImmediate();
      return result;
    }

    it("rejects jaccardThreshold above 1 with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { jaccardThreshold: 1.1 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("jaccardThreshold");
    });

    it("rejects jaccardThreshold below 0 with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { jaccardThreshold: -0.1 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("jaccardThreshold");
    });

    it("rejects staleConfidenceThreshold above 1 with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { staleConfidenceThreshold: 2 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("staleConfidenceThreshold");
    });

    it("rejects negative maxAgeMs with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxAgeMs: -1 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxAgeMs");
    });

    it("rejects negative maxClustersPerRun with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxClustersPerRun: -5 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxClustersPerRun");
    });

    it("rejects non-integer maxClustersPerRun with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxClustersPerRun: 1.5 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxClustersPerRun");
    });

    it("rejects maxClustersPerRun above the hard cap with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxClustersPerRun: 1_001 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxClustersPerRun");
    });

    it("rejects negative maxRecordsPerRun with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxRecordsPerRun: -1 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxRecordsPerRun");
    });

    it("rejects non-integer maxRecordsPerRun with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxRecordsPerRun: 1.5 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxRecordsPerRun");
    });

    it("rejects maxRecordsPerRun above the hard cap with 400 naming the field", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxRecordsPerRun: 1_001 });
      expect(result.status).toBe(400);
      const body = asJson(result);
      expect((body.error as { message: string }).message).toContain("maxRecordsPerRun");
    });

    it("accepts boundary value jaccardThreshold=0", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { jaccardThreshold: 0 });
      expect(result.status).toBe(202);
    });

    it("accepts boundary value jaccardThreshold=1", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { jaccardThreshold: 1 });
      expect(result.status).toBe(202);
    });

    it("accepts boundary value maxAgeMs=0", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxAgeMs: 0 });
      expect(result.status).toBe(202);
    });

    it("accepts boundary value maxClustersPerRun=0 (skipped job)", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxClustersPerRun: 0 });
      expect(result.status).toBe(202);
    });

    it("accepts boundary value maxRecordsPerRun=0 (skipped job)", async () => {
      const vault = makeVault();
      const result = await postSettings(vault, { maxRecordsPerRun: 0 });
      expect(result.status).toBe(202);
    });
  });
});
