import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSourceToCapsule,
  createCapsule,
  getCapsule,
  listCapsules,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
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
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import { createInMemoryUiStore } from "./store/index.js";

function jsonRequest(body: Record<string, unknown> | undefined, method: string): IncomingMessage {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(bytes) as IncomingMessage;
  req.method = method;
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
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
    circuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 1_000,
      halfOpenProbes: 1,
    },
  };
}

function embeddingDimensionsForTestModel(modelId: string): number {
  if (modelId.toLowerCase().includes("text-embedding-3-large")) return 3072;
  if (modelId === "my-custom-embedding-v1") return 768;
  return 1536;
}

function chatCapability(modelId: string): NonNullable<GatewayConfig["capabilities"]>[number] {
  return {
    id: modelId,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "runtime-configured",
    preferredUseCases: ["Tests"],
    knownLimitations: ["None"],
  };
}

function depsFor(tmp: string, override?: string | GatewayConfig): UiHandlerDeps {
  const config =
    typeof override === "string" || override === undefined
      ? gatewayConfig(override ?? "text-embedding-3-small")
      : override;
  const localKnowledgeEmbeddingRequest = vi.fn<
    (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>
  >((request) =>
    Promise.resolve({
      ok: true as const,
      value: {
        vector: Float32Array.from(
          { length: embeddingDimensionsForTestModel(request.modelId) },
          (_, index) => index / 1000,
        ),
        modelId: request.modelId,
      },
    }),
  );
  return {
    config,
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitUntil timed out");
}

afterEach(() => {
  localKnowledgeIndexingRegistry.reset();
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
    expect(JSON.stringify(result.body)).toContain('"scope":{"kind":"folder"}');
    expect(JSON.stringify(result.body)).not.toContain(docsRoot);
  });

  it("writes source-added audit history when a source is connected", async () => {
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
    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const auditKinds = verify._internal.db
      .prepare(
        "SELECT kind FROM capsule_audit_events WHERE capsule_id = :c ORDER BY occurred_at ASC, kind ASC",
      )
      .all({ c: "cap-1" }) as unknown as readonly { readonly kind: string }[];
    const membershipKinds = verify._internal.db
      .prepare(
        "SELECT change_kind FROM capsule_membership_changes WHERE capsule_id = :c ORDER BY occurred_at ASC, id ASC",
      )
      .all({ c: "cap-1" }) as unknown as readonly { readonly change_kind: string }[];
    verify.close();

    expect(auditKinds.map((row) => row.kind)).toContain("source-added");
    expect(membershipKinds.map((row) => row.change_kind)).toEqual(["add-source"]);
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

  it("re-validates the deny list at index time, not only at connect time (#189 audit)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    // A source whose canonical root resolves into a denied location is attached directly to the
    // store, bypassing the connect-time guard (the TOCTOU case: a folder moved/symlink-swapped
    // into a denied path after it was connected). Starting indexing must refuse it.
    const seeded = seedStore(tmp);
    const deniedRoot = join(tmp, ".aws");
    mkdirSync(deniedRoot, { recursive: true });
    writeFileSync(join(deniedRoot, "credentials"), "[default]\n", "utf8");
    addSourceToCapsule(seeded.store, seeded.capId, {
      id: "src-denied" as KnowledgeSourceId,
      displayName: "denied",
      tags: [],
      scope: { kind: "folder", rootPath: deniedRoot, recursive: true },
    });
    seeded.store.close();

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
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

  it("blocks capsule creation when no embedding-capable model is configured", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);

    const result = await handleCreateLocalKnowledgeCapsule(
      baseCtx(tmp, "POST", { displayName: "Chat Only Capsule" }),
      depsFor(tmp, gatewayConfig("gpt-oss-120b")),
    );

    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("embedding-capable");
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

  it("runs incremental refresh and treats repair-failed with no failed sources as a no-op", async () => {
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

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "succeeded", processed_documents: 1 });
    expect(auditKinds.map((row) => row.kind).sort()).toEqual([
      "indexing-job-completed",
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

  it("rejects capsule indexing before any source is attached", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);

    const created = await handleCreateLocalKnowledgeCapsule(
      baseCtx(tmp, "POST", { displayName: "Empty Capsule" }),
      depsFor(tmp),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const createdBody = created.body as { readonly capsule: { readonly id: KnowledgeCapsuleId } };
    const emptyCapsuleId = createdBody.capsule.id;

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      {
        ...baseCtx(tmp, "POST", { confirm: true }),
        params: { capsuleId: String(emptyCapsuleId) },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(409);
    const body = result.body as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(body.error.code).toBe("LOCAL_KNOWLEDGE_CONFLICT");
    expect(body.error.message).toContain("Attach at least one source");

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const jobs = verify._internal.db
      .prepare("SELECT COUNT(*) AS n FROM indexing_jobs WHERE capsule_id = :c")
      .get({ c: emptyCapsuleId }) as { readonly n: number };
    const capsule = getCapsule(verify, emptyCapsuleId);
    verify.close();

    expect(jobs.n).toBe(0);
    expect(capsule?.lifecycleState).toBe("draft");
  });

  it("projects embedding-failed runs into capsule health instead of indexed source counts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "alpha.md"), "# Alpha\n\nA.\n", "utf8");
    writeFileSync(join(docsRoot, "beta.md"), "# Beta\n\nB.\n", "utf8");

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: {
        kind: "files",
        rootPath: docsRoot,
        files: ["alpha.md", "beta.md"],
      },
    });
    store.close();

    let calls = 0;
    const deps: UiHandlerDeps = {
      ...depsFor(tmp),
      localKnowledgeEmbeddingRequest: vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({
              ok: true,
              value: {
                vector: Float32Array.from({ length: 1536 }, (_, index) => index / 1000),
                modelId: request.modelId,
              },
            });
          }
          return Promise.resolve({ ok: false, kind: "rate-limited" });
        },
      ),
    };

    const start = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );
    expect(start.status).toBe(409);

    const detail = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      deps,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      health: {
        lifecycleState: "error",
        failedDocuments: 2,
      },
      sources: [
        {
          sourceId: "src-1",
          indexedCount: 0,
          failedCount: 2,
          skippedCount: 0,
        },
      ],
      indexingJobs: [
        {
          status: "failed",
          processedDocuments: 0,
          failedDocuments: 2,
        },
      ],
    });
  });

  it("records unsupported documents as skipped rather than processed in job history", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "keiko-logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
      "utf8",
    );

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Unsupported",
      tags: [],
      scope: {
        kind: "files",
        rootPath: docsRoot,
        files: ["keiko-logo.svg"],
      },
    });
    store.close();

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(result.status).toBe(200);

    const detail = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      health: {
        skippedDocuments: 1,
        unsupportedDocuments: 1,
      },
      sources: [{ sourceId: "src-1", indexedCount: 0, skippedCount: 1 }],
      indexingJobs: [
        {
          status: "succeeded",
          processedDocuments: 0,
          skippedDocuments: 1,
        },
      ],
    });
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
      .prepare("UPDATE knowledge_sources SET scope_json = '{' WHERE id = 'src-1'")
      .run();
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: {
        code: "LOCAL_KNOWLEDGE_UNAVAILABLE",
        message:
          "Local knowledge storage is unavailable. Check the local runtime state and try again.",
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(tmp);
    expect(JSON.stringify(result.body)).not.toContain("scope_json");
  });

  it("recovers an orphaned running job to a terminal state after restart", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    store._internal.db
      .prepare("UPDATE capsules SET lifecycle_state = 'indexing' WHERE id = :c")
      .run({ c: capId });
    store._internal.db
      .prepare(
        "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-running', :c, '[]', 10, NULL, 'running', 3, 1, 0, 1, NULL, NULL, 'doc-1#u0#c3', 0)",
      )
      .run({ c: capId });
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      health: { lifecycleState: "error" },
      indexingJobs: [
        {
          id: "job-running",
          status: "failed",
          totalDocuments: 3,
          processedDocuments: 1,
          skippedDocuments: 1,
          lastError: {
            code: "INDEXING_INTERRUPTED",
          },
        },
      ],
    });
  });

  it("cancels an active indexing job instead of leaving it running", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "policy.md"), "# Policy\n\nCancelable run.\n", "utf8");

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: docsRoot, recursive: true },
    });
    store.close();

    const started = deferred<undefined>();
    const deps: UiHandlerDeps = {
      ...depsFor(tmp),
      localKnowledgeEmbeddingRequest: vi.fn(
        async (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          started.resolve(undefined);
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted === true) {
              resolve();
              return;
            }
            request.signal?.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
          throw new DOMException("aborted", "AbortError");
        },
      ),
    };

    const startPromise = handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );
    await started.promise;
    await waitUntil(() => {
      const inspect = openKnowledgeStore({
        dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
      });
      try {
        const row = inspect._internal.db
          .prepare(
            "SELECT COUNT(*) AS n FROM indexing_jobs WHERE capsule_id = :c AND status = 'running'",
          )
          .get({ c: capId }) as { readonly n: number };
        return row.n === 1;
      } finally {
        inspect.close();
      }
    });

    const cancelResult = await handleCancelLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "DELETE", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );
    const startResult = await startPromise;

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const row = verify._internal.db
      .prepare(
        "SELECT status, finished_at, cancellation_requested FROM indexing_jobs WHERE capsule_id = :c ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get({ c: capId }) as {
      readonly status: string;
      readonly finished_at: number | null;
      readonly cancellation_requested: number;
    };
    verify.close();
    expect(cancelResult.status).toBe(200);
    expect(cancelResult.body).toMatchObject({ ok: true, capsuleId: "cap-1" });
    expect(startResult.status).toBe(409);
    expect(startResult.body).toMatchObject({
      error: { code: "indexing-cancelled" },
      capsuleId: "cap-1",
    });
    expect(row.status).toBe("cancelled");
    expect(row.finished_at).not.toBeNull();
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

  it("reports vectorCompatible=false when the configured model is present but explicitly chat-only", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp, {
        ...gatewayConfig("text-embedding-3-small"),
        capabilities: [chatCapability("text-embedding-3-small")],
      }),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      readonly health: {
        readonly vectorCompatible: boolean;
        readonly staleReasons: readonly string[];
      };
    };
    expect(body.health.vectorCompatible).toBe(false);
    expect(body.health.staleReasons.some((reason) => /cannot serve embeddings/i.test(reason))).toBe(
      true,
    );
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

    it("returns undefined when no configured provider is embedding-capable", () => {
      const config = {
        providers: [{ modelId: "gpt-oss-120b" }, { modelId: "gpt-oss-40b" }],
      };
      expect(selectEmbeddingModelId(config)).toBeUndefined();
    });

    it("matches embed pattern case-insensitively", () => {
      const config = { providers: [{ modelId: "My-EMBED-Model" }] };
      expect(selectEmbeddingModelId(config)).toBe("My-EMBED-Model");
    });

    it("returns the only provider when it is an embedding model", () => {
      const config = { providers: [{ modelId: "text-embedding-ada-002" }] };
      expect(selectEmbeddingModelId(config)).toBe("text-embedding-ada-002");
    });

    it("respects an explicit chat override for an embedding-looking model id", () => {
      const modelId = "text-embedding-3-small";
      const config = {
        ...gatewayConfig(modelId),
        capabilities: [chatCapability(modelId)],
      };
      expect(selectEmbeddingModelId(config)).toBeUndefined();
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

    it("records probed dimensions for an unknown OpenAI-compatible embedding model", async () => {
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
      expect(body.capsule.embeddingModelIdentity.vectorDimensions).toBe(768);
    });

    it("marks new capsules incompatible when the configured embedding gateway changes", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
      tempDirs.push(tmp);
      const modelId = "text-embedding-3-small";

      const created = await handleCreateLocalKnowledgeCapsule(
        baseCtx(tmp, "POST", { displayName: "Gateway Bound" }),
        depsFor(tmp, modelId),
      );

      expect(created.status).toBe(201);
      const createdBody = created.body as {
        readonly capsule: {
          readonly id: KnowledgeCapsuleId;
          readonly embeddingModelIdentity: { readonly provider: string };
        };
      };
      expect(createdBody.capsule.embeddingModelIdentity.provider).toMatch(
        /^openai-compatible:[0-9a-f]{16}$/,
      );
      expect(createdBody.capsule.embeddingModelIdentity.provider).not.toContain("gateway.example");

      const baseGateway = gatewayConfig(modelId);
      const baseProvider = baseGateway.providers[0];
      if (baseProvider === undefined) throw new Error("test gateway missing provider");
      const changedGateway = {
        ...baseGateway,
        providers: [
          {
            ...baseProvider,
            baseUrl: "https://other-gateway.example.test/v1",
          },
        ],
      };
      const fetched = await handleGetLocalKnowledgeCapsule(
        {
          ...baseCtx(tmp, "GET"),
          params: { capsuleId: createdBody.capsule.id },
        },
        depsFor(tmp, changedGateway),
      );

      expect(fetched.status).toBe(200);
      const fetchedBody = fetched.body as {
        readonly health: {
          readonly vectorCompatible: boolean;
          readonly staleReasons: readonly string[];
        };
      };
      expect(fetchedBody.health.vectorCompatible).toBe(false);
      expect(
        fetchedBody.health.staleReasons.some((reason) => /embedding gateway/i.test(reason)),
      ).toBe(true);
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
