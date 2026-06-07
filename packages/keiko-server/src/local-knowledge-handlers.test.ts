import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSourceToCapsule,
  createCapsule,
  listCapsules,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import {
  handleDeleteLocalKnowledgeCapsule,
  handleCancelLocalKnowledgeCapsuleIndexing,
  handleConnectLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsuleSet,
  handleUpdateLocalKnowledgeCapsule,
  handleDisconnectLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleListLocalKnowledgeCapsules,
  handleReindexLocalKnowledgeCapsule,
  handleStartLocalKnowledgeCapsuleIndexing,
  selectEmbeddingModelId,
} from "./local-knowledge-handlers.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";

function jsonRequest(body: Record<string, unknown> | undefined, method: string): IncomingMessage {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(bytes) as IncomingMessage;
  req.method = method;
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
}

function depsFor(tmp: string, overrideModelId?: string): UiHandlerDeps {
  const modelId = overrideModelId ?? "text-embedding-3-small";
  const localKnowledgeEmbeddingRequest = vi.fn<
    (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>
  >(() =>
    Promise.resolve({
      ok: true as const,
      value: {
        vector: Float32Array.from({ length: 1536 }, (_, index) => index / 1000),
        modelId,
      },
    }),
  );
  return {
    config: {
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
      circuitBreaker: {
        failureThreshold: 3,
        cooldownMs: 1_000,
        halfOpenProbes: 1,
      },
    },
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    uiDbPath: join(tmp, "keiko-ui.db"),
    localKnowledgeEmbeddingRequest,
  };
}

function capsuleId(value: string): KnowledgeCapsuleId {
  return value as KnowledgeCapsuleId;
}

function baseCtx(tmp: string, method: string, body?: Record<string, unknown>): RouteContext {
  return {
    req: jsonRequest(body, method),
    res: {} as never,
    params: {},
    url: new URL("http://127.0.0.1/api/local-knowledge/capsules"),
  };
}

function seedStore(tmp: string): {
  readonly store: ReturnType<typeof openKnowledgeStore>;
  readonly capId: KnowledgeCapsuleId;
  readonly dbPath: string;
} {
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: tmp });
  const store = openKnowledgeStore({ dbPath });
  const capId = capsuleId("cap-1");
  createCapsule(store, {
    id: capId,
    displayName: "Audit Capsule",
    tags: ["docs"],
    retrievalEffort: "default",
    outputMode: "snippets",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: {
      provider: "openai",
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    lifecycleState: "ready",
    storageReference: "capsules/cap-1",
  });
  return { store, capId, dbPath };
}

const tempDirs: string[] = [];

interface IndexingJobSummaryRow {
  readonly status: string;
  readonly processed_documents: number;
  readonly skipped_documents: number;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("local-knowledge handlers", () => {
  it("connects a folder source to a capsule so it can be indexed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const docsRoot = join(tmp, "manuals");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "guide.md"), "# Guide\n", "utf8");

    const result = await handleConnectLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "POST", {
          scope: { kind: "folder", rootPath: docsRoot, recursive: true },
          displayName: "Manuals",
        }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    // The freshly attached source is surfaced in the capsule detail body.
    expect(JSON.stringify(result.body)).toContain("Manuals");
  });

  it("refuses a source path in a denied location (deny list)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const deniedRoot = join(tmp, ".ssh");
    mkdirSync(deniedRoot, { recursive: true });

    const result = await handleConnectLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "POST", {
          scope: { kind: "folder", rootPath: deniedRoot, recursive: true },
        }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("denied");
  });

  it("refuses a non-existent source path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();

    const result = await handleConnectLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "POST", {
          scope: { kind: "folder", rootPath: join(tmp, "no-such-dir"), recursive: true },
        }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(400);
  });

  it("returns 404 when connecting a source to a missing capsule", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const docsRoot = join(tmp, "manuals");
    mkdirSync(docsRoot, { recursive: true });

    const result = await handleConnectLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "POST", {
          scope: { kind: "folder", rootPath: docsRoot, recursive: true },
        }),
        params: { capsuleId: "cap-missing" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(404);
  });

  it("composes a non-destructive capsule set from existing capsules", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();

    const result = await handleCreateLocalKnowledgeCapsuleSet(
      baseCtx(tmp, "POST", { displayName: "Quarterly Review", capsuleIds: ["cap-1"] }),
      depsFor(tmp),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body).toMatchObject({
      capsuleSet: { displayName: "Quarterly Review", capsuleCount: 1, capsuleIds: ["cap-1"] },
    });
    // Non-destructive: the member capsule is unchanged (still resolvable on its own).
    const detail = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(detail.status).toBe(200);
  });

  it("rejects a capsule set with an empty displayName", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleCreateLocalKnowledgeCapsuleSet(
      baseCtx(tmp, "POST", { displayName: "   ", capsuleIds: ["cap-1"] }),
      depsFor(tmp),
    );
    expect(result.status).toBe(400);
  });

  it("rejects a capsule set with an empty capsuleIds array", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleCreateLocalKnowledgeCapsuleSet(
      baseCtx(tmp, "POST", { displayName: "Set", capsuleIds: [] }),
      depsFor(tmp),
    );
    expect(result.status).toBe(400);
  });

  it("rejects a capsule set with duplicate capsule ids", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleCreateLocalKnowledgeCapsuleSet(
      baseCtx(tmp, "POST", { displayName: "Set", capsuleIds: ["cap-1", "cap-1"] }),
      depsFor(tmp),
    );
    expect(result.status).toBe(400);
  });

  it("rejects a capsule set exceeding the member cap", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const tooMany = Array.from({ length: 17 }, (_, i) => `cap-${String(i)}`);
    const result = await handleCreateLocalKnowledgeCapsuleSet(
      baseCtx(tmp, "POST", { displayName: "Set", capsuleIds: tooMany }),
      depsFor(tmp),
    );
    expect(result.status).toBe(400);
  });

  it("returns 404 when a capsule set references an unknown capsule", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleCreateLocalKnowledgeCapsuleSet(
      baseCtx(tmp, "POST", { displayName: "Set", capsuleIds: ["cap-does-not-exist"] }),
      depsFor(tmp),
    );
    expect(result.status).toBe(404);
  });

  it("renames a capsule via PATCH (displayName + description)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleUpdateLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "PATCH", { displayName: "Renamed Capsule", description: "Updated desc" }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      capsule: { displayName: "Renamed Capsule", description: "Updated desc" },
    });
  });

  it("rejects an empty capsule PATCH (no displayName or description)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleUpdateLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "PATCH", {}), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(result.status).toBe(400);
  });

  it("rejects a metadata-only capsule PATCH (metadata persistence not yet supported)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleUpdateLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "PATCH", { metadata: { team: "platform" } }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );
    expect(result.status).toBe(400);
  });

  it("returns 404 when PATCHing a missing capsule", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleUpdateLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "PATCH", { displayName: "X" }),
        params: { capsuleId: "cap-missing" },
      },
      depsFor(tmp),
    );
    expect(result.status).toBe(404);
  });

  it("creates a draft capsule with the default Local Knowledge policy", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);

    const result = await handleCreateLocalKnowledgeCapsule(
      baseCtx(tmp, "POST", { displayName: "New Capsule", description: "Created from UI" }),
      depsFor(tmp),
    );

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      capsule: {
        displayName: "New Capsule",
        description: "Created from UI",
        lifecycleState: "draft",
        retrievalEffort: "default",
        outputMode: "snippets",
        answerGroundingPolicy: "require-citations",
      },
    });
    const created = result.body as {
      readonly capsule: { readonly storageReference: string };
    };
    expect(created.capsule.storageReference).toMatch(/^capsules\//);

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const capsules = listCapsules(verify);
    verify.close();
    expect(capsules).toHaveLength(1);
    expect(capsules[0]).toMatchObject({
      displayName: "New Capsule",
      lifecycleState: "draft",
      sourceIds: [],
    });
  });

  it("lists persisted capsules", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleListLocalKnowledgeCapsules(baseCtx(tmp, "GET"), depsFor(tmp));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      capsules: [
        {
          id: "cap-1",
          displayName: "Audit Capsule",
          lifecycleState: "ready",
          sourceCount: 0,
        },
      ],
    });
  });

  it("returns capsule detail with health, source stats, diagnostics, and jobs", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: join(tmp, "docs"), recursive: true },
    });
    store._internal.db
      .prepare(
        "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES ('doc-1', :c, 'src-1', 'policy.txt', 10, 'text/plain', 'aa', 'text', '1', 10, 'failed', 'policy.txt')",
      )
      .run({ c: capId });
    store._internal.db
      .prepare(
        "INSERT INTO parser_diagnostics (id, capsule_id, document_id, severity, code, message, page_number, created_at) VALUES ('diag-1', :c, 'doc-1', 'error', 'PARSE_ERR', 'Parser failed', 1, 11)",
      )
      .run({ c: capId });
    store._internal.db
      .prepare(
        "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-1', :c, '[\"src-1\"]', 12, 13, 'failed', 1, 0, 1, 0, 'PARSE_ERR', 'Parser failed', NULL, 0)",
      )
      .run({ c: capId });
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      capsule: { id: "cap-1", displayName: "Audit Capsule" },
      health: {
        capsuleId: "cap-1",
        failedDocuments: 1,
        unsupportedDocuments: 0,
        unsupportedGuidance: [],
        vectorCompatible: true,
      },
      sources: [{ sourceId: "src-1", displayName: "Policies", failedCount: 1 }],
      parserDiagnostics: [{ code: "PARSE_ERR", message: "Parser failed", pageNumber: 1 }],
      indexingJobs: [{ id: "job-1", status: "failed", failedDocuments: 1 }],
    });
  });

  it("counts unsupported documents in skipped health totals", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: join(tmp, "docs"), recursive: true },
    });
    store._internal.db
      .prepare(
        "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES ('doc-1', :c, 'src-1', 'policy.bin', 10, 'application/octet-stream', 'aa', 'unsupported', '1', 10, 'unsupported', 'policy.bin')",
      )
      .run({ c: capId });
    store._internal.db
      .prepare(
        "INSERT INTO parsed_units (id, capsule_id, document_id, kind, unsupported_reason, character_start, character_end) VALUES ('unit-1', :c, 'doc-1', 'unsupported-media', 'image-not-supported', NULL, NULL)",
      )
      .run({ c: capId });
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      health: {
        skippedDocuments: 1,
        unsupportedDocuments: 1,
        unsupportedGuidance: [
          "Image-only documents need an OCR-capable extraction path before they can be indexed.",
        ],
      },
      sources: [{ sourceId: "src-1", skippedCount: 1 }],
    });
  });

  it("runs incremental refresh and records a skipped second pass for unchanged files", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "policy.md"),
      "# Policy\n\n" + "Policy alpha beta gamma delta epsilon.\n".repeat(20),
      "utf8",
    );

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: docsRoot, recursive: true },
    });
    store.close();

    const deps = depsFor(tmp);
    const first = await handleReindexLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "POST", { mode: "changed-files" }), params: { capsuleId: "cap-1" } },
      deps,
    );
    const second = await handleReindexLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "POST", { mode: "repair-failed" }), params: { capsuleId: "cap-1" } },
      deps,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const inspect = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const jobs = inspect._internal.db
      .prepare(
        "SELECT status, processed_documents, skipped_documents FROM indexing_jobs WHERE capsule_id = :c ORDER BY started_at ASC, id ASC",
      )
      .all({ c: "cap-1" }) as unknown as readonly IndexingJobSummaryRow[];
    const auditKinds = inspect._internal.db
      .prepare(
        "SELECT kind FROM capsule_audit_events WHERE capsule_id = :c ORDER BY occurred_at ASC, kind ASC",
      )
      .all({ c: "cap-1" }) as unknown as readonly { readonly kind: string }[];
    inspect.close();

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ status: "succeeded", processed_documents: 1 });
    expect(jobs[1]).toMatchObject({
      status: "succeeded",
      processed_documents: 0,
      skipped_documents: 0,
    });
    expect(auditKinds.map((row) => row.kind).sort()).toEqual([
      "indexing-job-completed",
      "indexing-job-completed",
      "indexing-job-started",
      "indexing-job-started",
    ]);
  });

  it("starts capsule indexing from the graph surface", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "policy.md"), "# Policy\n\nConnected source.\n", "utf8");

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: docsRoot, recursive: true },
    });
    store.close();

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, capsuleId: "cap-1" });

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const jobs = verify._internal.db
      .prepare(
        "SELECT COUNT(*) AS n FROM indexing_jobs WHERE capsule_id = :c AND status = 'succeeded'",
      )
      .get({ c: capId }) as { readonly n: number };
    verify.close();
    expect(jobs.n).toBe(1);
  });

  it("limits repair-failed reindex jobs to sources with failed documents", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(join(docsRoot, "failed"), { recursive: true });
    mkdirSync(join(docsRoot, "healthy"), { recursive: true });
    writeFileSync(join(docsRoot, "failed", "policy.md"), "# Failed\n\nNeeds retry.\n", "utf8");
    writeFileSync(join(docsRoot, "healthy", "guide.md"), "# Healthy\n\nAlready indexed.\n", "utf8");

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Failed docs",
      tags: [],
      scope: { kind: "folder", rootPath: join(docsRoot, "failed"), recursive: true },
    });
    addSourceToCapsule(store, capId, {
      id: "src-2" as never,
      displayName: "Healthy docs",
      tags: [],
      scope: { kind: "folder", rootPath: join(docsRoot, "healthy"), recursive: true },
    });
    store._internal.db
      .prepare(
        "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES ('doc-1', :c, 'src-1', 'policy.md', 10, 'text/markdown', 'aa', 'text', '1', 10, 'failed', 'policy.md')",
      )
      .run({ c: capId });
    store.close();

    const result = await handleReindexLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "POST", { mode: "repair-failed" }), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(result.status).toBe(200);

    const inspect = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const latestJob = inspect._internal.db
      .prepare(
        "SELECT source_ids_json FROM indexing_jobs WHERE capsule_id = :c ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get({ c: capId }) as { readonly source_ids_json: string };
    inspect.close();

    expect(JSON.parse(latestJob.source_ids_json)).toEqual(["src-1"]);
  });

  it("returns a structured error when persisted source metadata is corrupt", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: join(tmp, "docs"), recursive: true },
    });
    store._internal.db
      .prepare("UPDATE capsule_sources SET scope_json = '{' WHERE capsule_id = :c AND id = 'src-1'")
      .run({ c: capId });
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: { code: "LOCAL_KNOWLEDGE_UNAVAILABLE" },
    });
  });

  it("marks the latest persisted running job as cancellation-requested", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    store._internal.db
      .prepare(
        "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-running', :c, '[]', 10, NULL, 'running', 0, 0, 0, 0, NULL, NULL, NULL, 0)",
      )
      .run({ c: capId });
    store.close();

    const result = await handleCancelLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "DELETE", { confirm: true }), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, capsuleId: "cap-1" });

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const row = verify._internal.db
      .prepare("SELECT cancellation_requested FROM indexing_jobs WHERE id = 'job-running'")
      .get() as { readonly cancellation_requested: number };
    verify.close();
    expect(row.cancellation_requested).toBe(1);
  });

  it("disconnects a capsule by removing its linked sources and resetting it to draft", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: join(tmp, "docs-a"), recursive: true },
    });
    addSourceToCapsule(store, capId, {
      id: "src-2" as never,
      displayName: "Notes",
      tags: [],
      scope: { kind: "folder", rootPath: join(tmp, "docs-b"), recursive: true },
    });
    store.close();

    const result = await handleDisconnectLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "DELETE", { confirm: true }), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, capsuleId: "cap-1" });

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const capsule = verify._internal.db
      .prepare("SELECT lifecycle_state FROM capsules WHERE id = :c")
      .get({ c: capId }) as { readonly lifecycle_state: string };
    const sources = verify._internal.db
      .prepare("SELECT COUNT(*) AS n FROM capsule_sources WHERE capsule_id = :c")
      .get({ c: capId }) as { readonly n: number };
    verify.close();
    expect(capsule.lifecycle_state).toBe("draft");
    expect(sources.n).toBe(0);
  });

  it("deletes a capsule index explicitly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleDeleteLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "DELETE"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      capsuleId: "cap-1",
      affectedCapsuleSetIds: [],
      cleanupVerified: true,
    });

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const row = verify._internal.db
      .prepare("SELECT COUNT(*) AS n FROM capsules WHERE id = 'cap-1'")
      .get() as { readonly n: number };
    const auditRow = verify._internal.db
      .prepare(
        "SELECT kind FROM capsule_audit_events WHERE capsule_id = 'cap-1' ORDER BY occurred_at DESC LIMIT 1",
      )
      .get() as { readonly kind: string } | undefined;
    verify.close();
    expect(row.n).toBe(0);
    expect(auditRow).toEqual({ kind: "capsule-deleted" });
  });

  it("reports vectorCompatible=false when the gateway embedding model rotates away from the capsule's pinned model (#189 O2)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp, "text-embedding-3-large"),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      readonly health: {
        readonly vectorCompatible: boolean;
        readonly staleReasons: readonly string[];
      };
    };
    expect(body.health.vectorCompatible).toBe(false);
    expect(body.health.staleReasons.some((reason) => /embedding model/i.test(reason))).toBe(true);
  });

  it("rejects a reindex request with a non-boolean force field (#189 O2)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleReindexLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "POST", { mode: "changed-files", force: "yes" }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  describe("selectEmbeddingModelId (#621)", () => {
    it("returns undefined when providers list is empty", () => {
      expect(selectEmbeddingModelId({ providers: [] })).toBeUndefined();
    });

    it("returns undefined when config is null", () => {
      expect(selectEmbeddingModelId(null)).toBeUndefined();
    });

    it("returns undefined when config is undefined", () => {
      expect(selectEmbeddingModelId(undefined)).toBeUndefined();
    });

    it("picks the first embedding provider from a chat-first list", () => {
      const config = {
        providers: [
          { modelId: "gpt-oss-120b" },
          { modelId: "text-embedding-3-large" },
          { modelId: "text-embedding-3-small" },
        ],
      };
      expect(selectEmbeddingModelId(config)).toBe("text-embedding-3-large");
    });

    it("falls back to providers[0] when no provider matches /embed/i", () => {
      const config = {
        providers: [{ modelId: "gpt-oss-120b" }, { modelId: "gpt-oss-40b" }],
      };
      expect(selectEmbeddingModelId(config)).toBe("gpt-oss-120b");
    });

    it("matches embed pattern case-insensitively", () => {
      const config = { providers: [{ modelId: "My-EMBED-Model" }] };
      expect(selectEmbeddingModelId(config)).toBe("My-EMBED-Model");
    });

    it("returns the only provider when it is an embedding model", () => {
      const config = { providers: [{ modelId: "text-embedding-ada-002" }] };
      expect(selectEmbeddingModelId(config)).toBe("text-embedding-ada-002");
    });
  });

  describe("defaultEmbeddingIdentity vectorDimensions derivation (#621)", () => {
    // Exercise via handleCreateLocalKnowledgeCapsule which calls defaultEmbeddingIdentity.
    it("records 3072 dimensions for text-embedding-3-large", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
      tempDirs.push(tmp);

      const result = await handleCreateLocalKnowledgeCapsule(
        baseCtx(tmp, "POST", { displayName: "Large Embed" }),
        depsFor(tmp, "text-embedding-3-large"),
      );

      expect(result.status).toBe(201);
      const body = result.body as {
        readonly capsule: {
          readonly embeddingModelIdentity: { readonly vectorDimensions: number };
        };
      };
      expect(body.capsule.embeddingModelIdentity.vectorDimensions).toBe(3072);
    });

    it("records 1536 dimensions for text-embedding-3-small", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
      tempDirs.push(tmp);

      const result = await handleCreateLocalKnowledgeCapsule(
        baseCtx(tmp, "POST", { displayName: "Small Embed" }),
        depsFor(tmp, "text-embedding-3-small"),
      );

      expect(result.status).toBe(201);
      const body = result.body as {
        readonly capsule: {
          readonly embeddingModelIdentity: { readonly vectorDimensions: number };
        };
      };
      expect(body.capsule.embeddingModelIdentity.vectorDimensions).toBe(1536);
    });

    it("records 1536 dimensions as conservative fallback for an unknown model", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
      tempDirs.push(tmp);

      const result = await handleCreateLocalKnowledgeCapsule(
        baseCtx(tmp, "POST", { displayName: "Unknown Embed" }),
        depsFor(tmp, "my-custom-embedding-v1"),
      );

      expect(result.status).toBe(201);
      const body = result.body as {
        readonly capsule: {
          readonly embeddingModelIdentity: { readonly vectorDimensions: number };
        };
      };
      expect(body.capsule.embeddingModelIdentity.vectorDimensions).toBe(1536);
    });
  });

  it("selects the embedding provider over a chat-first provider when creating a capsule (#621)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);

    const deps: UiHandlerDeps = {
      ...depsFor(tmp, "text-embedding-3-small"),
      config: {
        providers: [
          {
            modelId: "gpt-oss-120b",
            baseUrl: "https://gateway.example.test/v1",
            apiKey: "redacted",
            timeoutMs: 30_000,
            maxRetries: 1,
            retryBaseDelayMs: 100,
          },
          {
            modelId: "text-embedding-3-small",
            baseUrl: "https://gateway.example.test/v1",
            apiKey: "redacted",
            timeoutMs: 30_000,
            maxRetries: 1,
            retryBaseDelayMs: 100,
          },
        ],
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
      },
    };

    const result = await handleCreateLocalKnowledgeCapsule(
      baseCtx(tmp, "POST", { displayName: "Mixed Config Capsule" }),
      deps,
    );

    expect(result.status).toBe(201);
    const body = result.body as {
      readonly capsule: {
        readonly embeddingModelIdentity: {
          readonly modelId: string;
          readonly vectorDimensions: number;
        };
      };
    };
    expect(body.capsule.embeddingModelIdentity.modelId).toBe("text-embedding-3-small");
    expect(body.capsule.embeddingModelIdentity.vectorDimensions).toBe(1536);
  });

  it("surfaces parserDiagnostics and indexingJobs truncation totals on the detail response (#189 F4)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: join(tmp, "docs"), recursive: true },
    });
    store._internal.db
      .prepare(
        "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES ('doc-1', :c, 'src-1', 'policy.txt', 10, 'text/plain', 'aa', 'text', '1', 10, 'failed', 'policy.txt')",
      )
      .run({ c: capId });
    store._internal.db
      .prepare(
        "INSERT INTO parser_diagnostics (id, capsule_id, document_id, severity, code, message, page_number, created_at) VALUES ('diag-1', :c, 'doc-1', 'error', 'PARSE_ERR', 'Parser failed', 1, 11)",
      )
      .run({ c: capId });
    store._internal.db
      .prepare(
        "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-1', :c, '[\"src-1\"]', 12, 13, 'failed', 1, 0, 1, 0, 'PARSE_ERR', 'Parser failed', NULL, 0)",
      )
      .run({ c: capId });
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      parserDiagnosticsTotal: 1,
      parserDiagnosticsTruncated: false,
      indexingJobsTotal: 1,
      indexingJobsTruncated: false,
    });
  });
});
