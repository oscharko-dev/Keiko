import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSourceToCapsule,
  createCapsule,
  createCapsuleSet,
  getCapsule,
  listCapsules,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleDetails,
  upsertExtractionCheckpoint,
  type OcrAdapter,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  CapsuleHealth,
  CapsuleLargeDocumentHealth,
  DocumentId,
  CapsuleSetId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  GatewayRequest,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import {
  handleDeleteLocalKnowledgeCapsule,
  handleCancelLocalKnowledgeCapsuleIndexing,
  handleConnectLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsuleSet,
  handleUpdateLocalKnowledgeCapsule,
  handleDisconnectLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleListLocalKnowledgeCapsuleSets,
  handleListLocalKnowledgeCapsules,
  handleReindexLocalKnowledgeCapsule,
  handleRebindLocalKnowledgeCapsuleSource,
  handleStartLocalKnowledgeCapsuleIndexing,
  selectEmbeddingModelId,
} from "./local-knowledge-handlers.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
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

function embeddingProviderIdentityForTest(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `openai-compatible:${fingerprint}`;
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

function embeddingCapability(modelId: string): NonNullable<GatewayConfig["capabilities"]>[number] {
  return {
    id: modelId,
    kind: "embedding",
    contextWindow: 8_191,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured embedding endpoint",
    preferredUseCases: ["Embeddings"],
    knownLimitations: ["None"],
  };
}

function gatewayConfigWithChatModels(chatModelIds: readonly string[]): GatewayConfig {
  const embeddingProvider = gatewayConfig("text-embedding-3-small").providers[0];
  if (embeddingProvider === undefined) throw new Error("missing embedding provider");
  return {
    providers: [
      embeddingProvider,
      ...chatModelIds.map((modelId) => ({
        modelId,
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "redacted",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      })),
    ],
    capabilities: [
      embeddingCapability("text-embedding-3-small"),
      ...chatModelIds.map((modelId) => chatCapability(modelId)),
    ],
    circuitBreaker: gatewayConfig("text-embedding-3-small").circuitBreaker,
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

function baseCtx(_tmp: string, method: string, body?: Record<string, unknown>): RouteContext {
  return {
    req: jsonRequest(body, method),
    res: {} as never,
    params: {},
    url: new URL("http://127.0.0.1/api/local-knowledge/capsules"),
  };
}

function knowledgePodsCtx(tmp: string, method: string): RouteContext {
  const ctx = baseCtx(tmp, method);
  ctx.url.searchParams.set("includeKnowledgePods", "1");
  return ctx;
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
    modelUsePolicy: standardPodModelUsePolicy(),
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

function seedIndexedChunk(
  store: ReturnType<typeof openKnowledgeStore>,
  capId: KnowledgeCapsuleId,
  rootPath: string,
): void {
  addSourceToCapsule(store, capId, {
    id: "src-context" as KnowledgeSourceId,
    displayName: "Context Source",
    tags: [],
    scope: { kind: "folder", rootPath, recursive: true },
  });
  store._internal.db
    .prepare(
      "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES ('doc-context', :c, 'src-context', 'context.txt', 12, 'text/plain', 'ctx-hash', 'text', '1', 10, 'extracted', 'context.txt')",
    )
    .run({ c: capId });
  store._internal.db
    .prepare(
      "INSERT INTO parsed_units (id, capsule_id, document_id, kind, character_start, character_end) VALUES ('unit-context', :c, 'doc-context', 'text', 0, 12)",
    )
    .run({ c: capId });
  store._internal.db
    .prepare(
      "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash, chunking_strategy_version, character_start, character_end, contextual_retrieval_key, context_status) VALUES ('chunk-context', :c, 'src-context', 'doc-context', 'unit-context', 0, 3, 'safe-hash', 'chunk-v1', 0, 12, 'indexed-text=contextual-v1|prompt=old|model=old|chunk=safe-hash', 'generated')",
    )
    .run({ c: capId });
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
    expect(result.body).toMatchObject({
      sources: [{ scope: { kind: "folder", recursive: true } }],
    });
    expect(JSON.stringify(result.body)).toContain("manuals");
  });

  it("connect is idempotent: the same folder connected twice yields exactly one source", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const docsRoot = join(tmp, "manuals");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "guide.md"), "# Guide\n", "utf8");
    const connect = (rootPath: string): Promise<RouteResult> =>
      handleConnectLocalKnowledgeCapsule(
        {
          ...baseCtx(tmp, "POST", {
            scope: { kind: "folder", rootPath, recursive: true },
            displayName: "Manuals",
          }),
          params: { capsuleId: "cap-1" },
        },
        depsFor(tmp),
      );

    const first = await connect(docsRoot);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Double-click: identical path again. A trailing-slash spelling of the same folder must
    // fold into the same canonical identity as well.
    const second = await connect(docsRoot);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const third = await connect(`${docsRoot}/`);
    expect(third.status, JSON.stringify(third.body)).toBe(200);

    const body = third.body as { readonly sources: readonly unknown[] };
    expect(body.sources).toHaveLength(1);
  });

  it("connect keeps genuinely different folders as separate sources", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const rootA = join(tmp, "manuals");
    const rootB = join(tmp, "controlling");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const connect = (rootPath: string, displayName: string): Promise<RouteResult> =>
      handleConnectLocalKnowledgeCapsule(
        {
          ...baseCtx(tmp, "POST", {
            scope: { kind: "folder", rootPath, recursive: true },
            displayName,
          }),
          params: { capsuleId: "cap-1" },
        },
        depsFor(tmp),
      );

    const first = await connect(rootA, "Manuals");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await connect(rootB, "Controlling");
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const body = second.body as { readonly sources: readonly unknown[] };
    expect(body.sources).toHaveLength(2);
  });

  it("files-scope connect is idempotent when the files array is permuted", async () => {
    // Regression for #964 follow-up: [a,b] and [b,a] must fold to the same scopeIdentity so
    // the second connect is a no-op and no duplicate source row is created.
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "alpha.md"), "# Alpha\n", "utf8");
    writeFileSync(join(docsRoot, "beta.md"), "# Beta\n", "utf8");

    const connectFiles = (files: string[]): Promise<RouteResult> =>
      handleConnectLocalKnowledgeCapsule(
        {
          ...baseCtx(tmp, "POST", {
            scope: { kind: "files", rootPath: docsRoot, files },
            displayName: "Docs",
          }),
          params: { capsuleId: "cap-1" },
        },
        depsFor(tmp),
      );

    const first = await connectFiles(["alpha.md", "beta.md"]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Same set, reversed order — must be a no-op.
    const second = await connectFiles(["beta.md", "alpha.md"]);
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const body = second.body as { readonly sources: readonly unknown[] };
    expect(body.sources).toHaveLength(1);
  });

  it("files-scope connect creates a distinct source when the file set genuinely differs", async () => {
    // Negative test: a logically different files set must still produce a second source.
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "alpha.md"), "# Alpha\n", "utf8");
    writeFileSync(join(docsRoot, "beta.md"), "# Beta\n", "utf8");
    writeFileSync(join(docsRoot, "gamma.md"), "# Gamma\n", "utf8");

    const connectFiles = (files: string[]): Promise<RouteResult> =>
      handleConnectLocalKnowledgeCapsule(
        {
          ...baseCtx(tmp, "POST", {
            scope: { kind: "files", rootPath: docsRoot, files },
            displayName: "Docs",
          }),
          params: { capsuleId: "cap-1" },
        },
        depsFor(tmp),
      );

    const first = await connectFiles(["alpha.md", "beta.md"]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Different set (gamma replaces beta) — must produce a second source.
    const second = await connectFiles(["alpha.md", "gamma.md"]);
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const body = second.body as { readonly sources: readonly unknown[] };
    expect(body.sources).toHaveLength(2);
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

  it("rebinds a source root without changing the source id and marks the capsule stale", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const seeded = seedStore(tmp);
    const oldRoot = join(tmp, "old-manuals");
    const newRoot = join(tmp, "new-manuals");
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(newRoot, { recursive: true });
    addSourceToCapsule(seeded.store, seeded.capId, {
      id: "src-rebind" as KnowledgeSourceId,
      displayName: "Manuals",
      tags: [],
      scope: { kind: "folder", rootPath: oldRoot, recursive: true },
    });
    seeded.store.close();

    const result = await handleRebindLocalKnowledgeCapsuleSource(
      {
        ...baseCtx(tmp, "PATCH", { rootPath: newRoot }),
        params: { capsuleId: "cap-1", sourceId: "src-rebind" },
      },
      depsFor(tmp),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      capsule: { lifecycleState: "stale" },
      sources: [
        {
          sourceId: "src-rebind",
          scope: { kind: "folder", rootPath: realpathSync(newRoot), recursive: true },
        },
      ],
    });
    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const auditRows = verify._internal.db
      .prepare(
        "SELECT kind, source_id, details_json FROM capsule_audit_events WHERE capsule_id = :c ORDER BY occurred_at ASC",
      )
      .all({ c: "cap-1" }) as unknown as readonly {
      readonly kind: string;
      readonly source_id: string | null;
      readonly details_json: string | null;
    }[];
    verify.close();
    expect(auditRows).toEqual([
      {
        kind: "source-rebound",
        source_id: "src-rebind",
        details_json: JSON.stringify({
          previousScopeKind: "folder",
          currentScopeKind: "folder",
        }),
      },
    ]);
  });

  it("rejects rebind when another source already uses the target root and scope", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const seeded = seedStore(tmp);
    const rootA = join(tmp, "manuals-a");
    const rootB = join(tmp, "manuals-b");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    addSourceToCapsule(seeded.store, seeded.capId, {
      id: "src-a" as KnowledgeSourceId,
      displayName: "A",
      tags: [],
      scope: { kind: "folder", rootPath: rootA, recursive: true },
    });
    addSourceToCapsule(seeded.store, seeded.capId, {
      id: "src-b" as KnowledgeSourceId,
      displayName: "B",
      tags: [],
      scope: { kind: "folder", rootPath: realpathSync(rootB), recursive: true },
    });
    seeded.store.close();

    const result = await handleRebindLocalKnowledgeCapsuleSource(
      {
        ...baseCtx(tmp, "PATCH", { rootPath: rootB }),
        params: { capsuleId: "cap-1", sourceId: "src-a" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("already uses");
  });

  it("refuses to rebind a source root into a denied location", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const seeded = seedStore(tmp);
    const safeRoot = join(tmp, "manuals");
    const deniedRoot = join(tmp, ".ssh");
    mkdirSync(safeRoot, { recursive: true });
    mkdirSync(deniedRoot, { recursive: true });
    addSourceToCapsule(seeded.store, seeded.capId, {
      id: "src-safe" as KnowledgeSourceId,
      displayName: "Manuals",
      tags: [],
      scope: { kind: "folder", rootPath: safeRoot, recursive: true },
    });
    seeded.store.close();

    const result = await handleRebindLocalKnowledgeCapsuleSource(
      {
        ...baseCtx(tmp, "PATCH", { rootPath: deniedRoot }),
        params: { capsuleId: "cap-1", sourceId: "src-safe" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("denied");
  });

  it("rejects source rebind while indexing is already running", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const seeded = seedStore(tmp);
    const oldRoot = join(tmp, "manuals");
    const newRoot = join(tmp, "manuals-new");
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(newRoot, { recursive: true });
    addSourceToCapsule(seeded.store, seeded.capId, {
      id: "src-running" as KnowledgeSourceId,
      displayName: "Manuals",
      tags: [],
      scope: { kind: "folder", rootPath: oldRoot, recursive: true },
    });
    seeded.store._internal.db
      .prepare(
        "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-rebind-running', :c, '[\"src-running\"]', 12, NULL, 'running', 1, 0, 0, 0, NULL, NULL, NULL, 0)",
      )
      .run({ c: seeded.capId });
    localKnowledgeIndexingRegistry.start("cap-1");
    localKnowledgeIndexingRegistry.attachJobId("cap-1", "job-rebind-running");
    seeded.store.close();

    const result = await handleRebindLocalKnowledgeCapsuleSource(
      {
        ...baseCtx(tmp, "PATCH", { rootPath: newRoot }),
        params: { capsuleId: "cap-1", sourceId: "src-running" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("already running");
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

  it("updates contextual retrieval settings via PATCH and reports re-index-required health", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    seedIndexedChunk(store, capId, docsRoot);
    store.close();

    const result = await handleUpdateLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "PATCH", {
          contextualRetrieval: {
            enabled: true,
            modelId: "context-chat",
            strict: false,
            maxContextChars: 320,
            documentContextMaxChars: 8000,
          },
        }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp, gatewayConfigWithChatModels(["context-chat"])),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      capsule: {
        lifecycleState: "stale",
        contextualRetrieval: {
          enabled: true,
          modelId: "context-chat",
          strict: false,
          maxContextChars: 320,
          documentContextMaxChars: 8000,
        },
      },
    });
    const body = result.body as { readonly health: CapsuleHealth };
    expect(body.health.staleReasons).toContain(
      "Contextual retrieval settings changed. Run full rebuild / rechunk to rebuild retrieval text.",
    );
    expect(body.health.contextualRetrieval).toMatchObject({
      enabled: true,
      source: "capsule",
      status: "rebuild-required",
      rebuildRequired: true,
      staleChunkCount: 1,
      modelId: "context-chat",
    });
  });

  it("does not mark legacy raw chunks stale when no contextual retrieval policy is active", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    seedIndexedChunk(store, capId, docsRoot);
    store._internal.db
      .prepare(
        "UPDATE chunks SET contextual_retrieval_key = NULL, context_status = NULL WHERE capsule_id = :c",
      )
      .run({ c: capId });
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = result.body as { readonly health: CapsuleHealth };
    expect(body.health.staleReasons).not.toContain(
      "Contextual retrieval settings changed. Run full rebuild / rechunk to rebuild retrieval text.",
    );
  });

  it("rejects invalid contextual retrieval PATCH payloads", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();

    const result = await handleUpdateLocalKnowledgeCapsule(
      {
        ...baseCtx(tmp, "PATCH", {
          contextualRetrieval: { enabled: true, modelId: "bad\u0001model" },
        }),
        params: { capsuleId: "cap-1" },
      },
      depsFor(tmp),
    );

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("contextualRetrieval.modelId");
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

  it("lists persisted capsules without pod projection by default", async () => {
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
    expect(JSON.stringify(result.body)).not.toContain("knowledgePods");
    expect(JSON.stringify(result.body)).not.toContain(tmp);
  });

  it("lists persisted capsules with opt-in additive pod summaries", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleListLocalKnowledgeCapsules(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );
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
      knowledgePods: [
        {
          id: "cap-1",
          kind: "pod",
          displayName: "Audit Capsule",
          readiness: "degraded",
          counts: {
            capsuleCount: 1,
            sourceCount: 0,
            documentCount: 0,
            chunkCount: 0,
            vectorCount: 0,
          },
          privacy: {
            localFirst: true,
            rawContentExposed: false,
            privatePathsExposed: false,
          },
          compatibility: {
            backingKind: "knowledge-capsule",
            migrationRequired: false,
            persistedStateRenamed: false,
          },
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain(tmp);
  });

  it("redacts legacy capsule display names in opt-in pod list responses", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    updateCapsuleDetails(store, capId, {
      displayName: "/Users/alice/private/customer.pdf?client_secret=value",
    });
    store.close();

    const result = await handleListLocalKnowledgeCapsules(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );
    const body = JSON.stringify(result.body);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      capsules: [{ id: "cap-1", displayName: "Knowledge Pod" }],
      knowledgePods: [{ id: "cap-1", displayName: "Knowledge Pod" }],
    });
    expect(body).not.toContain("/Users/alice");
    expect(body).not.toContain("client_secret");
  });

  it("fails closed when capsule pod summary validation rejects corrupt state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    store._internal.db
      .prepare("UPDATE capsules SET lifecycle_state = 'published' WHERE id = :c")
      .run({ c: capId });
    store.close();

    const result = await handleListLocalKnowledgeCapsules(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );

    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).toContain("Local knowledge storage is unavailable.");
    expect(JSON.stringify(result.body)).not.toContain("published");
  });

  it("lists persisted capsule sets without pod projection by default", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "Audit Pod Set",
      tags: ["audit"],
      capsuleIds: [capId],
    });
    store.close();

    const result = await handleListLocalKnowledgeCapsuleSets(baseCtx(tmp, "GET"), depsFor(tmp));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      capsuleSets: [
        {
          id: "set-1",
          displayName: "Audit Pod Set",
          capsuleCount: 1,
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain("knowledgePods");
  });

  it("lists persisted capsule sets with opt-in additive pod-set summaries", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "Audit Pod Set",
      tags: ["audit"],
      capsuleIds: [capId],
    });
    store.close();

    const result = await handleListLocalKnowledgeCapsuleSets(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      capsuleSets: [
        {
          id: "set-1",
          displayName: "Audit Pod Set",
          capsuleCount: 1,
        },
      ],
      knowledgePods: [
        {
          id: "set-1",
          kind: "pod-set",
          displayName: "Audit Pod Set",
          readiness: "degraded",
          counts: { capsuleCount: 1, sourceCount: 0 },
          compatibility: {
            backingKind: "capsule-set",
            capsuleIds: [capId],
            migrationRequired: false,
            persistedStateRenamed: false,
          },
        },
      ],
    });
  });

  it("redacts legacy capsule-set display names in opt-in pod-set list responses", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "https://gateway.example.test/v1?client_secret=value",
      tags: ["audit"],
      capsuleIds: [capId],
    });
    store.close();

    const result = await handleListLocalKnowledgeCapsuleSets(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );
    const body = JSON.stringify(result.body);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      capsuleSets: [{ id: "set-1", displayName: "Knowledge Pod Set" }],
      knowledgePods: [{ id: "set-1", displayName: "Knowledge Pod Set" }],
    });
    expect(body).not.toContain("https://gateway.example.test");
    expect(body).not.toContain("client_secret");
  });

  it("fails closed when pod-set summary validation rejects corrupt set state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "Audit Pod Set",
      tags: [],
      capsuleIds: [capId],
    });
    store._internal.db
      .prepare("UPDATE schema_meta SET key = 'capsule_set:/tmp/set-1' WHERE key = :k")
      .run({ k: "capsule_set:set-1" });
    store._internal.db
      .prepare("UPDATE capsule_set_members SET set_id = '/tmp/set-1' WHERE set_id = :s")
      .run({ s: "set-1" });
    store.close();

    const result = await handleListLocalKnowledgeCapsuleSets(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );

    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).toContain("Local knowledge storage is unavailable.");
    expect(JSON.stringify(result.body)).not.toContain("/tmp/set-1");
  });

  it("fails closed when pod-set member summary validation rejects corrupt state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "Audit Pod Set",
      tags: [],
      capsuleIds: [capId],
    });
    store._internal.db
      .prepare("UPDATE capsules SET vector_metric = 'manhattan' WHERE id = :c")
      .run({ c: capId });
    store.close();

    const result = await handleListLocalKnowledgeCapsuleSets(
      knowledgePodsCtx(tmp, "GET"),
      depsFor(tmp),
    );

    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).toContain("Local knowledge storage is unavailable.");
    expect(JSON.stringify(result.body)).not.toContain("manhattan");
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

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);

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

  it("maps full-reembed and full-rebuild modes to a force reindex even when files are unchanged", async () => {
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
      { ...baseCtx(tmp, "POST", { mode: "full-reembed" }), params: { capsuleId: "cap-1" } },
      deps,
    );
    const third = await handleReindexLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "POST", { mode: "full-rebuild" }), params: { capsuleId: "cap-1" } },
      deps,
    );

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(third.status, JSON.stringify(third.body)).toBe(200);

    const inspect = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const jobs = inspect._internal.db
      .prepare(
        "SELECT status, processed_documents FROM indexing_jobs WHERE capsule_id = :c ORDER BY started_at ASC, id ASC",
      )
      .all({ c: "cap-1" }) as unknown as readonly {
      readonly status: string;
      readonly processed_documents: number;
    }[];
    inspect.close();

    expect(jobs).toHaveLength(3);
    expect(jobs[1]).toMatchObject({ status: "succeeded", processed_documents: 1 });
    expect(jobs[2]).toMatchObject({ status: "succeeded", processed_documents: 1 });
  });

  it("rebinds capsule embedding identity before full-reembed when the configured model changed", async () => {
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

    const result = await handleReindexLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "POST", { mode: "full-reembed" }), params: { capsuleId: "cap-1" } },
      depsFor(tmp, "text-embedding-3-large"),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const inspect = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const capsule = getCapsule(inspect, capId);
    inspect.close();

    expect(capsule?.embeddingModelIdentity.modelId).toBe("text-embedding-3-large");
    expect(capsule?.embeddingModelIdentity.vectorDimensions).toBe(3072);
    expect(capsule?.embeddingModelIdentity.embeddingSpaceFingerprint).toMatch(
      /^keiko-embedding-space-fingerprint-v1:[a-f0-9]{24}$/u,
    );
  });

  it("wires opt-in contextual retrieval through the normal indexing handler", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "policy.md"),
      "# Policy\n\n" + "Release TS-999 changes retry handling and billing rollout.\n".repeat(24),
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

    const embeddingInputs: string[] = [];
    const contextCalls: GatewayRequest[] = [];
    const embeddingProvider = gatewayConfig("text-embedding-3-small").providers[0];
    if (embeddingProvider === undefined) throw new Error("missing embedding provider");
    const base = depsFor(tmp, {
      providers: [
        embeddingProvider,
        {
          modelId: "context-chat",
          baseUrl: "https://gateway.example.test/v1",
          apiKey: "redacted",
          timeoutMs: 30_000,
          maxRetries: 1,
          retryBaseDelayMs: 100,
        },
      ],
      capabilities: [embeddingCapability("text-embedding-3-small"), chatCapability("context-chat")],
      circuitBreaker: gatewayConfig("text-embedding-3-small").circuitBreaker,
    });
    const deps: UiHandlerDeps = {
      ...base,
      env: {
        KEIKO_LOCAL_KNOWLEDGE_CONTEXTUAL_RETRIEVAL: "true",
        KEIKO_LOCAL_KNOWLEDGE_CONTEXT_MODEL_ID: "context-chat",
      },
      localKnowledgeContextualRetrievalChatGateway: {
        chat: (request) => {
          contextCalls.push(request);
          return Promise.resolve({
            modelId: request.modelId,
            content: "Context: TS-999 retry handling and billing rollout.",
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "ctx-1",
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "low",
            },
          });
        },
      },
      localKnowledgeEmbeddingRequest: vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          embeddingInputs.push(request.input);
          return Promise.resolve({
            ok: true,
            value: {
              vector: Float32Array.from(
                { length: embeddingDimensionsForTestModel(request.modelId) },
                (_, index) => index / 1000,
              ),
              modelId: request.modelId,
            },
          });
        },
      ),
    };

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(contextCalls).not.toHaveLength(0);
    expect(contextCalls[0]?.modelId).toBe("context-chat");
    expect(contextCalls[0]?.messages[1]?.content).toContain("<document>");
    expect(
      embeddingInputs.some((input) =>
        input.startsWith("Context: TS-999 retry handling and billing rollout."),
      ),
    ).toBe(true);

    const inspect = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const row = inspect._internal.db
      .prepare(
        "SELECT context_status FROM chunks WHERE capsule_id = :c ORDER BY order_index ASC LIMIT 1",
      )
      .get({ c: capId }) as { readonly context_status: string | null } | undefined;
    inspect.close();

    expect(row?.context_status).toBe("generated");
  });

  it("uses per-capsule contextual retrieval settings and model id without the env flag", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "policy.md"),
      "# Policy\n\n" + "Capsule-level context model selection for TS-999.\n".repeat(24),
      "utf8",
    );

    const { store, capId } = seedStore(tmp);
    updateCapsuleDetails(store, capId, {
      contextualRetrieval: { enabled: true, modelId: "capsule-chat", maxContextChars: 320 },
    });
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: docsRoot, recursive: true },
    });
    store.close();

    const embeddingInputs: string[] = [];
    const contextCalls: GatewayRequest[] = [];
    const base = depsFor(tmp, gatewayConfigWithChatModels(["env-chat", "capsule-chat"]));
    const deps: UiHandlerDeps = {
      ...base,
      env: {},
      localKnowledgeContextualRetrievalChatGateway: {
        chat: (request) => {
          contextCalls.push(request);
          return Promise.resolve({
            modelId: request.modelId,
            content: "Context: capsule selected TS-999 context.",
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "ctx-1",
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "low",
            },
          });
        },
      },
      localKnowledgeEmbeddingRequest: vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          embeddingInputs.push(request.input);
          return Promise.resolve({
            ok: true,
            value: {
              vector: Float32Array.from(
                { length: embeddingDimensionsForTestModel(request.modelId) },
                (_, index) => index / 1000,
              ),
              modelId: request.modelId,
            },
          });
        },
      ),
    };

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(contextCalls.length).toBeGreaterThan(0);
    expect(contextCalls[0]?.modelId).toBe("capsule-chat");
    expect(
      embeddingInputs.some((input) => input.startsWith("Context: capsule selected TS-999")),
    ).toBe(true);
  });

  it("lets an explicit disabled capsule setting override an enabled env default", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, "policy.md"),
      "# Policy\n\n" + "Disabled contextual retrieval should embed raw chunks.\n".repeat(24),
      "utf8",
    );

    const { store, capId } = seedStore(tmp);
    updateCapsuleDetails(store, capId, { contextualRetrieval: { enabled: false } });
    addSourceToCapsule(store, capId, {
      id: "src-1" as never,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: docsRoot, recursive: true },
    });
    store.close();

    const embeddingInputs: string[] = [];
    const contextCalls: GatewayRequest[] = [];
    const base = depsFor(tmp, gatewayConfigWithChatModels(["context-chat"]));
    const deps: UiHandlerDeps = {
      ...base,
      env: {
        KEIKO_LOCAL_KNOWLEDGE_CONTEXTUAL_RETRIEVAL: "true",
        KEIKO_LOCAL_KNOWLEDGE_CONTEXT_MODEL_ID: "context-chat",
      },
      localKnowledgeContextualRetrievalChatGateway: {
        chat: (request) => {
          contextCalls.push(request);
          return Promise.resolve({
            modelId: request.modelId,
            content: "Context: env default should not be used.",
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "ctx-1",
              promptTokens: 1,
              completionTokens: 1,
              latencyMs: 1,
              costClass: "low",
            },
          });
        },
      },
      localKnowledgeEmbeddingRequest: vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          embeddingInputs.push(request.input);
          return Promise.resolve({
            ok: true,
            value: {
              vector: Float32Array.from(
                { length: embeddingDimensionsForTestModel(request.modelId) },
                (_, index) => index / 1000,
              ),
              modelId: request.modelId,
            },
          });
        },
      ),
    };

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(contextCalls).toHaveLength(0);
    expect(embeddingInputs.some((input) => input.startsWith("Context:"))).toBe(false);

    const inspect = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const row = inspect._internal.db
      .prepare(
        "SELECT context_status FROM chunks WHERE capsule_id = :c ORDER BY order_index ASC LIMIT 1",
      )
      .get({ c: capId }) as { readonly context_status: string | null } | undefined;
    inspect.close();

    expect(row?.context_status).toBe("disabled");
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

  it("refreshes compatible embedding fingerprint drift before normal indexing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "policy.md"), "# Policy\n\nConnected source.\n", "utf8");

    const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: tmp });
    const store = openKnowledgeStore({ dbPath });
    const baseUrl = "https://gateway.example.test/v1";
    const capId = "cap-fingerprint-drift" as KnowledgeCapsuleId;
    createCapsule(store, {
      id: capId,
      displayName: "Fingerprint Drift",
      tags: [],
      retrievalEffort: "default",
      outputMode: "snippets",
      answerGroundingPolicy: "require-citations",
      modelUsePolicy: standardPodModelUsePolicy(),
      embeddingModelIdentity: {
        provider: embeddingProviderIdentityForTest(baseUrl),
        modelId: "text-embedding-3-large",
        vectorDimensions: 3072,
        vectorMetric: "cosine",
        normalization: "l2",
        instructionVersion: "keiko-embedding-input-v1",
        embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:aaaaaaaaaaaaaaaaaaaaaaaa",
      },
      lifecycleState: "ready",
      storageReference: "capsules/cap-fingerprint-drift",
    });
    addSourceToCapsule(store, capId, {
      id: "src-fingerprint-drift" as KnowledgeSourceId,
      displayName: "Policies",
      tags: [],
      scope: { kind: "folder", rootPath: docsRoot, recursive: true },
    });
    store.close();

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: String(capId) } },
      depsFor(tmp, "text-embedding-3-large"),
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const verify = openKnowledgeStore({ dbPath });
    const capsule = getCapsule(verify, capId);
    const vectorRows = verify._internal.db
      .prepare(
        "SELECT embedding_space_fingerprint FROM vectors WHERE capsule_id = :c ORDER BY id ASC",
      )
      .all({ c: capId }) as unknown as readonly {
      readonly embedding_space_fingerprint: string | null;
    }[];
    verify.close();

    expect(capsule?.embeddingModelIdentity.embeddingSpaceFingerprint).toMatch(
      /^keiko-embedding-space-fingerprint-v1:[a-f0-9]{24}$/u,
    );
    expect(capsule?.embeddingModelIdentity.embeddingSpaceFingerprint).not.toBe(
      "keiko-embedding-space-fingerprint-v1:aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(vectorRows.length).toBeGreaterThan(0);
    expect(
      vectorRows.every(
        (row) =>
          row.embedding_space_fingerprint ===
          capsule?.embeddingModelIdentity.embeddingSpaceFingerprint,
      ),
    ).toBe(true);
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
          return Promise.resolve({ ok: false, kind: "invalid-response" });
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

  it("indexes configured OCR text from image files through extraction, chunking, and embeddings", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "scan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    const { store, capId } = seedStore(tmp);
    addSourceToCapsule(store, capId, {
      id: "src-ocr" as never,
      displayName: "Scans",
      tags: [],
      scope: {
        kind: "files",
        rootPath: docsRoot,
        files: ["scan.png"],
      },
    });
    store.close();

    const ocrPage = vi.fn<OcrAdapter["ocrPage"]>((input) =>
      Promise.resolve(
        input.bytes.byteLength === 0
          ? { ok: false, reason: "unsupported-input" }
          : { ok: true, text: "Scanned invoice total 42", confidence: 0.91 },
      ),
    );
    const base = depsFor(tmp);
    const embeddingRequest = base.localKnowledgeEmbeddingRequest;
    if (embeddingRequest === undefined) throw new Error("missing embedding request");
    const embeddingInputs: string[] = [];
    const deps: UiHandlerDeps = {
      ...base,
      localKnowledgeOcrAdapter: { kind: "ocr", ocrPage },
      localKnowledgeEmbeddingRequest: vi.fn((request: OpenAIEmbeddingRequest) => {
        embeddingInputs.push(request.input);
        return embeddingRequest(request);
      }),
    };

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      { ...baseCtx(tmp, "POST", { confirm: true }), params: { capsuleId: "cap-1" } },
      deps,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(embeddingInputs.some((input) => input.includes("Scanned invoice total 42"))).toBe(true);

    const verify = openKnowledgeStore({
      dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
    });
    const doc = verify._internal.db
      .prepare("SELECT id, status, parser_id FROM documents WHERE capsule_id = :c")
      .get({ c: capId }) as {
      readonly id: string;
      readonly status: string;
      readonly parser_id: string;
    };
    const text = verify._internal.db
      .prepare(
        "SELECT normalized_text FROM document_texts WHERE capsule_id = :c AND document_id = :d",
      )
      .get({ c: capId, d: doc.id }) as { readonly normalized_text: string };
    verify.close();

    expect(doc).toMatchObject({ status: "extracted", parser_id: "ocr-pipeline" });
    expect(text.normalized_text).toBe("Scanned invoice total 42");

    const detail = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      deps,
    );
    const body = detail.body as { readonly largeDocumentHealth: CapsuleLargeDocumentHealth };
    expect(body.largeDocumentHealth.capabilities.ocr).toBe("available");
  });

  it("surfaces configured OCR engine failures in capsule large-document health", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const deps: UiHandlerDeps = {
      ...depsFor(tmp),
      localKnowledgeOcrAdapter: {
        kind: "ocr",
        ocrPage: () => Promise.resolve({ ok: false, reason: "engine-error" }),
      },
    };

    const detail = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      deps,
    );

    const body = detail.body as { readonly largeDocumentHealth: CapsuleLargeDocumentHealth };
    expect(body.largeDocumentHealth.capabilities.ocr).toBe("failing");
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

  it("leaves a stranded running job untouched on the no-recover read path but flips it when recovering", () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store, capId } = seedStore(tmp);
    store._internal.db
      .prepare(
        "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, finished_at, status, total_documents, processed_documents, failed_documents, skipped_documents, last_error_code, last_error_message, resume_token, cancellation_requested) VALUES ('job-stranded', :c, '[]', 10, NULL, 'running', 3, 1, 0, 1, NULL, NULL, NULL, 0)",
      )
      .run({ c: capId });
    store.close();

    const statusOf = (env: { readonly store: ReturnType<typeof openKnowledgeStore> }): string =>
      (
        env.store._internal.db
          .prepare("SELECT status FROM indexing_jobs WHERE id = 'job-stranded'")
          .get() as { readonly status: string }
      ).status;

    // Read path (recover: false) must NOT finalize the orphan — an actively-running job in another
    // process would otherwise be misread as abandoned and flipped to `failed` on every read.
    const readEnv = openKnowledgeStoreForDeps(depsFor(tmp), { recover: false });
    try {
      expect(statusOf(readEnv)).toBe("running");
    } finally {
      readEnv.close();
    }

    // Management/remediation path (recover: true) DOES finalize the orphan to a terminal state.
    const recoverEnv = openKnowledgeStoreForDeps(depsFor(tmp), { recover: true });
    try {
      expect(statusOf(recoverEnv)).toBe("failed");
    } finally {
      recoverEnv.close();
    }
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
        readonly embeddingCompatibility?: CapsuleHealth["embeddingCompatibility"];
        readonly staleReasons: readonly string[];
      };
    };
    expect(body.health.vectorCompatible).toBe(false);
    expect(body.health.embeddingCompatibility).toMatchObject({
      status: "incompatible",
      reason: "pinned-model-not-configured",
      pinnedModelId: "text-embedding-3-small",
      currentModelId: "text-embedding-3-large",
    });
    expect(body.health.staleReasons.some((reason) => /embedding model/i.test(reason))).toBe(true);
  });

  it("reports vectorCompatible=false when gateway config is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const { store } = seedStore(tmp);
    store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      { ...depsFor(tmp), config: undefined, configPresent: false },
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      readonly health: {
        readonly vectorCompatible: boolean;
        readonly embeddingCompatibility?: CapsuleHealth["embeddingCompatibility"];
        readonly staleReasons: readonly string[];
      };
    };
    expect(body.health.vectorCompatible).toBe(false);
    expect(body.health.embeddingCompatibility).toMatchObject({
      status: "unknown",
      reason: "gateway-config-missing",
      pinnedModelId: "text-embedding-3-small",
    });
    expect(body.health.staleReasons.some((reason) => /gateway configuration/i.test(reason))).toBe(
      true,
    );
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
        readonly embeddingCompatibility?: CapsuleHealth["embeddingCompatibility"];
        readonly staleReasons: readonly string[];
      };
    };
    expect(body.health.vectorCompatible).toBe(false);
    expect(body.health.embeddingCompatibility).toMatchObject({
      status: "incompatible",
      reason: "configured-model-not-embedding",
      pinnedModelId: "text-embedding-3-small",
    });
    expect(
      body.health.staleReasons.some((reason) =>
        /not available as an embedding model/i.test(reason),
      ),
    ).toBe(true);
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

    it("passes shared gateway egress to embedding probes when the provider has no override", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
      tempDirs.push(tmp);
      const egress = { httpsProxy: "http://proxy.example:8080", noProxy: ["localhost"] };
      const config: GatewayConfig = { ...gatewayConfig("text-embedding-3-small"), egress };
      const seen: OpenAIEmbeddingRequest[] = [];
      const deps: UiHandlerDeps = {
        ...depsFor(tmp, config),
        localKnowledgeEmbeddingRequest: vi.fn(
          (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
            seen.push(request);
            return Promise.resolve({
              ok: true as const,
              value: {
                vector: Float32Array.from(
                  { length: embeddingDimensionsForTestModel(request.modelId) },
                  (_, index) => index / 1000,
                ),
                modelId: request.modelId,
              },
            });
          },
        ),
      };

      const result = await handleCreateLocalKnowledgeCapsule(
        baseCtx(tmp, "POST", { displayName: "Egress Bound" }),
        deps,
      );

      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((request) => request.egress === egress)).toBe(true);
      deps.store.close();
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

  it("falls back to a later healthy embedding provider when the first LiteLLM embedding is unhealthy", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const seenModelIds: string[] = [];
    const unhealthyModelId = "multilingual-e5-large";
    const healthyModelId = "Qwen3-Embedding-8B";
    const deps: UiHandlerDeps = {
      ...depsFor(tmp, healthyModelId),
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
        capabilities: [
          chatCapability("gpt-oss-120b"),
          embeddingCapability(unhealthyModelId),
          embeddingCapability(healthyModelId),
        ],
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
      },
      localKnowledgeEmbeddingRequest: vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          seenModelIds.push(request.modelId);
          if (request.modelId === unhealthyModelId) {
            return Promise.resolve({ ok: false as const, kind: "unsupported-model" as const });
          }
          return Promise.resolve({
            ok: true as const,
            value: {
              vector: Float32Array.from({ length: 1536 }, (_, index) => index / 1000),
              modelId: request.modelId,
            },
          });
        },
      ),
    };

    const result = await handleCreateLocalKnowledgeCapsule(
      baseCtx(tmp, "POST", { displayName: "LiteLLM Fallback Capsule" }),
      deps,
    );

    expect(result.status).toBe(201);
    expect(seenModelIds[0]).toBe(unhealthyModelId);
    expect(seenModelIds.slice(1)).toEqual([
      healthyModelId,
      healthyModelId,
      healthyModelId,
      healthyModelId,
    ]);
    const body = result.body as {
      readonly capsule: {
        readonly embeddingModelIdentity: {
          readonly modelId: string;
          readonly vectorDimensions: number;
        };
      };
    };
    expect(body.capsule.embeddingModelIdentity.modelId).toBe(healthyModelId);
    expect(body.capsule.embeddingModelIdentity.vectorDimensions).toBe(1536);
  });

  it("repairs a LiteLLM upstream embedding alias before indexing an existing capsule", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const docsRoot = join(tmp, "docs");
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, "policy.md"), "# Policy\n\nKeiko indexes this file.\n", "utf8");

    const routeModelId = "Qwen3-Embedding-8B";
    const upstreamModelId = "RedHatAI/Qwen3-Embedding-8B";
    const baseUrl = "https://gateway.example.test/v1";
    const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: tmp });
    const store = openKnowledgeStore({ dbPath });
    createCapsule(store, {
      id: "cap-litellm-alias" as KnowledgeCapsuleId,
      displayName: "LiteLLM Alias Capsule",
      tags: [],
      retrievalEffort: "default",
      outputMode: "snippets",
      answerGroundingPolicy: "require-citations",
      modelUsePolicy: standardPodModelUsePolicy(),
      embeddingModelIdentity: {
        provider: embeddingProviderIdentityForTest(baseUrl),
        modelId: upstreamModelId,
        vectorDimensions: 4096,
        vectorMetric: "cosine",
      },
      lifecycleState: "ready",
      storageReference: "capsules/cap-litellm-alias",
    });
    addSourceToCapsule(store, "cap-litellm-alias" as KnowledgeCapsuleId, {
      id: "src-litellm-alias" as KnowledgeSourceId,
      displayName: "Policies",
      tags: [],
      scope: { kind: "files", rootPath: docsRoot, files: ["policy.md"] },
    });
    store.close();

    const deps: UiHandlerDeps = {
      ...depsFor(tmp),
      config: {
        providers: [
          {
            modelId: routeModelId,
            baseUrl,
            apiKey: "redacted",
            timeoutMs: 30_000,
            maxRetries: 1,
            retryBaseDelayMs: 100,
          },
        ],
        capabilities: [embeddingCapability(routeModelId)],
        circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
      },
      localKnowledgeEmbeddingRequest: vi.fn(
        (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
          expect(request.modelId).toBe(routeModelId);
          return Promise.resolve({
            ok: true as const,
            value: {
              vector: Float32Array.from({ length: 4096 }, (_, index) => index / 1000),
              modelId: upstreamModelId,
            },
          });
        },
      ),
    };

    const result = await handleStartLocalKnowledgeCapsuleIndexing(
      {
        ...baseCtx(tmp, "POST", { confirm: true }),
        params: { capsuleId: "cap-litellm-alias" },
      },
      deps,
    );

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const verify = openKnowledgeStore({ dbPath });
    const capsule = getCapsule(verify, "cap-litellm-alias" as KnowledgeCapsuleId);
    const vectors = verify._internal.db
      .prepare(
        "SELECT embedding_model_id, embedding_model_revision, vector_dimensions FROM vectors WHERE capsule_id = :c",
      )
      .all({ c: "cap-litellm-alias" }) as unknown as readonly {
      readonly embedding_model_id: string;
      readonly embedding_model_revision: string | null;
      readonly vector_dimensions: number;
    }[];
    verify.close();

    expect(capsule?.embeddingModelIdentity).toMatchObject({
      modelId: routeModelId,
      modelRevision: upstreamModelId,
      vectorDimensions: 4096,
    });
    expect(vectors.length).toBeGreaterThan(0);
    expect(
      vectors.every(
        (row) =>
          row.embedding_model_id === routeModelId &&
          row.embedding_model_revision === upstreamModelId &&
          row.vector_dimensions === 4096,
      ),
    ).toBe(true);
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

describe("local-knowledge large-document health (Issue #1286)", () => {
  function seedLargeDocumentCheckpoint(
    store: ReturnType<typeof openKnowledgeStore>,
    capId: KnowledgeCapsuleId,
  ): void {
    upsertExtractionCheckpoint(store._internal.db, {
      capsuleId: capId,
      documentId: "doc-1" as DocumentId,
      jobId: "job-1",
      strategy: "progressive-pdf",
      phase: "embedding",
      pageCursor: 12,
      sectionCursor: 0,
      objectCursor: 100,
      extractedTextBytes: 5000,
      chunkCursor: 20,
      embeddedChunkCursor: 8,
      retryCount: 0,
      coverage: "partial",
      fingerprint: {
        sourceContentHash: "abcd",
        parserVersion: "progressive-pdf@1",
        policyFingerprint: "ldp1",
        chunkingStrategyVersion: "chunker@2",
        embeddingIdentity: {
          provider: "openai",
          modelId: "text-embedding-3-small",
          vectorDimensions: 1536,
          vectorMetric: "cosine",
        },
      },
      terminalDiagnostics: [],
      createdAt: 1,
      updatedAt: 2,
    });
    store._internal.db
      .prepare(
        "INSERT INTO parser_diagnostics (id, capsule_id, document_id, severity, code, message, page_number, created_at) VALUES (:id, :c, NULL, 'warning', 'PARTIAL_COVERAGE', :m, NULL, 1)",
      )
      .run({
        id: "diag-1",
        c: capId,
        m: "page has no extractable text layer; indexed with partial coverage",
      });
  }

  it("surfaces resource policy, progress, partial coverage, quality warnings, and resumable docs", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    const seeded = seedStore(tmp);
    seedLargeDocumentCheckpoint(seeded.store, seeded.capId);
    seeded.store.close();

    const result = await handleGetLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "GET"), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    const largeDoc = body.largeDocumentHealth as CapsuleLargeDocumentHealth;
    expect(largeDoc.resourcePolicy.largeFileThresholdBytes).toBeGreaterThan(0);
    expect(largeDoc.capabilities.ocr).toBe("unavailable");
    expect(largeDoc.progress).toHaveLength(1);
    expect(largeDoc.progress[0]?.phase).toBe("embedding");
    expect(largeDoc.progress[0]?.resumable).toBe(true);
    expect(largeDoc.resumableDocuments).toContain("doc-1");
    expect(largeDoc.partialCoverageDocuments).toBe(1);
    expect(largeDoc.qualityWarnings).toHaveLength(1);

    const health = body.health as CapsuleHealth;
    expect(health.partialCoverageDocuments).toBe(1);
    expect(health.resumableDocuments).toBe(1);
    expect(health.qualityWarnings).toHaveLength(1);
    // Redaction: the surfaced warning carries no absolute path.
    expect(health.qualityWarnings?.[0]).not.toContain("/");
  });

  it("accepts the resume reindex mode without a validation error", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-"));
    tempDirs.push(tmp);
    seedStore(tmp).store.close();
    const result = await handleReindexLocalKnowledgeCapsule(
      { ...baseCtx(tmp, "POST", { mode: "resume" }), params: { capsuleId: "cap-1" } },
      depsFor(tmp),
    );
    // The capsule has no sources, so the handler returns a conflict rather than indexing — but the
    // `resume` mode passes validation (a rejected mode would be a 400 invalid-request).
    expect(result.status).not.toBe(400);
  });
});
