import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
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
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  createConsolidationJobRegistry,
  type ConsolidationJobRegistry,
} from "./memory-consolidation-registry.js";
import {
  handleCancelConsolidationJob,
  handleCreateConsolidationJob,
  handleGetConsolidationJob,
} from "./memory-consolidation-handlers.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext, RouteResult } from "./routes.js";

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
  const dir = mkdtempSync(join(tmpdir(), "keiko-consolidation-mem-"));
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
