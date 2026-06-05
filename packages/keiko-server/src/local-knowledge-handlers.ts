import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  createSqliteAuditSink,
  createDefaultParserRegistry,
  deleteCapsule,
  getCapsule,
  listCapsuleSets,
  listCapsuleSources,
  listCapsules,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  runIndexingJob,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  CapsuleHealth,
  DocumentId,
  IndexingJobRecord,
  KnowledgeCapsule,
  KnowledgeSource,
  KnowledgeSourceId,
  ParserDiagnostic,
  KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import {
  KnowledgeNotFoundError,
  KnowledgeStoreError,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  currentGatewayConfig,
  type UiHandlerDeps,
} from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import {
  requestOpenAIEmbedding,
  type ModelProviderConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

const MAX_BODY_BYTES = 32_000;

class InvalidRequest extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function badRequest(code: string, message: string): RouteResult {
  return { status: 400, body: errorBody(code, message) };
}

function conflict(message: string): RouteResult {
  return { status: 409, body: errorBody("LOCAL_KNOWLEDGE_CONFLICT", message) };
}

function serviceUnavailable(message: string): RouteResult {
  return { status: 503, body: errorBody("LOCAL_KNOWLEDGE_UNAVAILABLE", message) };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: errorBody("NOT_FOUND", message) };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === undefined || req.method === "GET" || req.method === "HEAD") {
    return {};
  }
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRequest("Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseScope(kind: string, json: string): KnowledgeSourceScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new KnowledgeStoreError(
      `Corrupt capsule_sources.scope_json (kind=${kind}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KnowledgeStoreError(`Corrupt capsule_sources.scope_json (kind=${kind}).`);
  }
  return { kind, ...parsed } as KnowledgeSourceScope;
}

function scopeToJson(scope: KnowledgeSourceScope): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    if (key === "kind") continue;
    copy[key] = value;
  }
  return JSON.stringify(copy);
}

function runtimeStateDir(deps: UiHandlerDeps): string | undefined {
  if (deps.uiDbPath === undefined || deps.uiDbPath.length === 0) {
    return undefined;
  }
  return dirname(deps.uiDbPath);
}

function openStoreForDeps(deps: UiHandlerDeps): {
  readonly store: ReturnType<typeof openKnowledgeStore>;
  readonly dbPath: string;
  close(): void;
} {
  const root = runtimeStateDir(deps);
  if (root === undefined) {
    throw new KnowledgeStoreError("UI runtime-state path is unavailable.");
  }
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: root });
  const store = openKnowledgeStore({ dbPath });
  return {
    store,
    dbPath,
    close: (): void => {
      store.close();
    },
  };
}

function storageSizeBytes(dbPath: string): number {
  let total = 0;
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      total += statSync(path).size;
    } catch {
      // Optional sidecars or unopened DB paths are fine.
    }
  }
  return total;
}

function configuredProviderForCapsule(
  deps: UiHandlerDeps,
  capsule: KnowledgeCapsule,
): ModelProviderConfig | undefined {
  const config = currentGatewayConfig(deps);
  return config?.providers.find(
    (provider) => provider.modelId === capsule.embeddingModelIdentity.modelId,
  );
}

function vectorCompatibility(
  deps: UiHandlerDeps,
  capsule: KnowledgeCapsule,
): { readonly vectorCompatible: boolean; readonly staleReasons: readonly string[] } {
  const reasons: string[] = [];
  const provider = configuredProviderForCapsule(deps, capsule);
  if (currentGatewayConfig(deps) !== undefined && provider === undefined) {
    reasons.push("The configured embedding model no longer matches this capsule.");
  }
  if (capsule.lifecycleState === "stale") {
    reasons.push("The capsule is marked stale and should be refreshed.");
  }
  if (capsule.lifecycleState === "error") {
    reasons.push("The last indexing run ended with errors.");
  }
  return { vectorCompatible: provider !== undefined || currentGatewayConfig(deps) === undefined, staleReasons: reasons };
}

interface SourceStatsRow {
  readonly source_id: string;
  readonly display_name: string;
  readonly scope_kind: string;
  readonly scope_json: string;
  readonly indexed_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
}

function loadSourceStats(store: ReturnType<typeof openKnowledgeStore>, capsuleId: string): readonly {
  readonly sourceId: string;
  readonly displayName: string;
  readonly scope: KnowledgeSource["scope"];
  readonly indexedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}[] {
  const rows = store._internal.db.prepare(
    [
      "SELECT s.id AS source_id, s.display_name, s.scope_kind, s.scope_json,",
      "  SUM(CASE WHEN d.status = 'extracted' THEN 1 ELSE 0 END) AS indexed_count,",
      "  SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,",
      "  SUM(CASE WHEN d.status IN ('skipped', 'unsupported') THEN 1 ELSE 0 END) AS skipped_count",
      "FROM capsule_sources AS s",
      "LEFT JOIN documents AS d ON d.capsule_id = s.capsule_id AND d.source_id = s.id",
      "WHERE s.capsule_id = :c",
      "GROUP BY s.id, s.display_name, s.scope_kind, s.scope_json",
      "ORDER BY s.created_at ASC, s.id ASC",
    ].join(" "),
  ).all({ c: capsuleId }) as unknown as readonly SourceStatsRow[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    displayName: row.display_name,
    scope: parseScope(row.scope_kind, row.scope_json),
    indexedCount: row.indexed_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
  }));
}

interface ParserDiagnosticRow {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly document_id: string | null;
  readonly page_number: number | null;
}

function loadParserDiagnostics(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): readonly ParserDiagnostic[] {
  const rows = store._internal.db.prepare(
    [
      "SELECT severity, code, message, document_id, page_number",
      "FROM parser_diagnostics",
      "WHERE capsule_id = :c",
      "ORDER BY created_at DESC, id DESC",
    ].join(" "),
  ).all({ c: capsuleId }) as unknown as readonly ParserDiagnosticRow[];
  return rows.map((row) => ({
    severity: row.severity as ParserDiagnostic["severity"],
    code: row.code,
    message: row.message,
    ...(row.document_id !== null ? { documentId: row.document_id as DocumentId } : {}),
    ...(row.page_number !== null ? { pageNumber: row.page_number } : {}),
  }));
}

interface UnsupportedReasonRow {
  readonly unsupported_reason: string | null;
}

function unsupportedGuidanceFor(reason: string): string {
  if (reason === "pdf-no-text-layer" || reason === "pdf-not-implemented") {
    return "Scanned PDFs need an OCR-capable extraction path. Configure a verified OCR or vision adapter, or provide a text-layer PDF.";
  }
  if (reason === "image-not-supported") {
    return "Image-only documents need an OCR-capable extraction path before they can be indexed.";
  }
  if (reason.startsWith("ocr-failed:")) {
    return "OCR extraction failed for at least one document. Review the OCR adapter configuration and retry indexing.";
  }
  return "Some documents are unsupported in this build. Review the health diagnostics for the affected formats and next steps.";
}

function loadUnsupportedGuidance(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): readonly string[] {
  const rows = store._internal.db.prepare(
    [
      "SELECT DISTINCT unsupported_reason",
      "FROM parsed_units",
      "WHERE capsule_id = :c AND kind = 'unsupported-media'",
      "ORDER BY unsupported_reason ASC",
    ].join(" "),
  ).all({ c: capsuleId }) as unknown as readonly UnsupportedReasonRow[];
  const guidance = new Set<string>();
  for (const row of rows) {
    if (typeof row.unsupported_reason !== "string" || row.unsupported_reason.length === 0) continue;
    guidance.add(unsupportedGuidanceFor(row.unsupported_reason));
  }
  return [...guidance];
}

interface IndexingJobRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly source_ids_json: string;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly status: string;
  readonly total_documents: number;
  readonly processed_documents: number;
  readonly failed_documents: number;
  readonly skipped_documents: number;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
}

interface FailedSourceIdRow {
  readonly source_id: string;
}

function parseSourceIds(json: string): readonly KnowledgeSourceId[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new KnowledgeStoreError(
      `Corrupt indexing_jobs.source_ids_json: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry as KnowledgeSourceId);
}

function rowToIndexingJobRecord(row: IndexingJobRow): IndexingJobRecord {
  return {
    id: row.id,
    capsuleId: row.capsule_id as KnowledgeCapsule["id"],
    sourceIds: parseSourceIds(row.source_ids_json),
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    status: row.status as IndexingJobRecord["status"],
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    failedDocuments: row.failed_documents,
    skippedDocuments: row.skipped_documents,
    ...(row.last_error_code !== null && row.last_error_message !== null
      ? { lastError: { code: row.last_error_code, message: row.last_error_message } }
      : {}),
  };
}

function loadIndexingJobs(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): readonly IndexingJobRecord[] {
  const rows = store._internal.db.prepare(
    [
      "SELECT id, capsule_id, source_ids_json, started_at, finished_at, status,",
      "  total_documents, processed_documents, failed_documents, skipped_documents,",
      "  last_error_code, last_error_message, resume_token",
      "FROM indexing_jobs",
      "WHERE capsule_id = :c",
      "ORDER BY started_at DESC, id DESC",
    ].join(" "),
  ).all({ c: capsuleId }) as unknown as readonly IndexingJobRow[];
  return rows.map((row) => rowToIndexingJobRecord(row));
}

function countForTable(
  store: ReturnType<typeof openKnowledgeStore>,
  table: "documents" | "chunks" | "vectors",
  capsuleId: string,
): number {
  const row = store._internal.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c`)
    .get({ c: capsuleId }) as { readonly n: number };
  return row.n;
}

function countDocumentStatus(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
  status: "failed" | "skipped" | "unsupported",
): number {
  const row =
    status === "failed"
      ? (store._internal.db
          .prepare("SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c AND status = 'failed'")
          .get({ c: capsuleId }) as { readonly n: number })
      : status === "unsupported"
        ? (store._internal.db
            .prepare("SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c AND status = 'unsupported'")
            .get({ c: capsuleId }) as { readonly n: number })
      : (store._internal.db
          .prepare(
            "SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c AND status IN ('skipped', 'unsupported')",
          )
          .get({ c: capsuleId }) as { readonly n: number });
  return row.n;
}

function lastIndexedAt(store: ReturnType<typeof openKnowledgeStore>, capsuleId: string): number | undefined {
  const row = store._internal.db
    .prepare(
      "SELECT MAX(finished_at) AS finished_at FROM indexing_jobs WHERE capsule_id = :c AND finished_at IS NOT NULL",
    )
    .get({ c: capsuleId }) as { readonly finished_at: number | null };
  return row.finished_at ?? undefined;
}

function buildCapsuleHealth(
  deps: UiHandlerDeps,
  store: ReturnType<typeof openKnowledgeStore>,
  dbPath: string,
  capsule: KnowledgeCapsule,
): CapsuleHealth {
  const documentCount = countForTable(store, "documents", capsule.id);
  const chunkCount = countForTable(store, "chunks", capsule.id);
  const vectorCount = countForTable(store, "vectors", capsule.id);
  const failedDocuments = countDocumentStatus(store, capsule.id, "failed");
  const skippedDocuments = countDocumentStatus(store, capsule.id, "skipped");
  const unsupportedDocuments = countDocumentStatus(store, capsule.id, "unsupported");
  const compatibility = vectorCompatibility(deps, capsule);
  const indexedAt = lastIndexedAt(store, capsule.id);
  const unsupportedGuidance =
    unsupportedDocuments > 0
      ? loadUnsupportedGuidance(store, capsule.id)
      : [];
  return {
    capsuleId: capsule.id,
    lifecycleState: capsule.lifecycleState,
    storageSizeBytes: storageSizeBytes(dbPath),
    documentCount,
    chunkCount,
    vectorCount,
    ...(indexedAt !== undefined ? { lastIndexedAt: indexedAt } : {}),
    embeddingIdentity: capsule.embeddingModelIdentity,
    vectorCompatible: compatibility.vectorCompatible,
    failedDocuments,
    skippedDocuments,
    unsupportedDocuments,
    unsupportedGuidance:
      unsupportedDocuments > 0 && unsupportedGuidance.length === 0
        ? [
            "Some documents were skipped because this build cannot extract them yet. Review the health diagnostics for the affected formats and next steps.",
          ]
        : unsupportedGuidance,
    staleReasons: compatibility.staleReasons,
  };
}

function createEmbeddingAdapter(
  provider: ModelProviderConfig,
  requestImpl: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>,
): OpenAIEmbeddingAdapter {
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    request: (request) =>
      requestImpl({
        ...request,
        endpoint: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.apiKeyHeaderName !== undefined
          ? { apiKeyHeaderName: provider.apiKeyHeaderName }
          : {}),
      }),
  };
}

function requestEmbeddingImpl(
  deps: UiHandlerDeps,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return deps.localKnowledgeEmbeddingRequest ?? requestOpenAIEmbedding;
}

function canonicalizeScopeRoot(scope: KnowledgeSourceScope): KnowledgeSourceScope {
  const safeRealPath = (path: string): string => {
    try {
      return nodeWorkspaceFs.realPath(path);
    } catch {
      return path;
    }
  };
  if (scope.kind === "folder" || scope.kind === "files") {
    return { ...scope, rootPath: safeRealPath(scope.rootPath) };
  }
  return { ...scope, repositoryRoot: safeRealPath(scope.repositoryRoot) };
}

function canonicalizeCapsuleSourceRoots(
  store: ReturnType<typeof openKnowledgeStore>,
  capsule: KnowledgeCapsule,
): void {
  const now = store._internal.now();
  for (const source of listCapsuleSources(store, capsule.id)) {
    const canonicalScope = canonicalizeScopeRoot(source.scope);
    if (JSON.stringify(canonicalScope) === JSON.stringify(source.scope)) {
      continue;
    }
    store._internal.db
      .prepare(
        "UPDATE capsule_sources SET scope_json = :scope_json, updated_at = :updated_at WHERE capsule_id = :c AND id = :id",
      )
      .run({
        scope_json: scopeToJson(canonicalScope),
        updated_at: now,
        c: capsule.id,
        id: source.id,
      });
  }
}

function actionResponse(capsuleId: string): RouteResult {
  return { status: 200, body: { ok: true, capsuleId } };
}

function deleteActionResponse(input: {
  readonly capsuleId: string;
  readonly affectedCapsuleSetIds: readonly string[];
  readonly cleanupVerified: boolean;
}): RouteResult {
  return {
    status: 200,
    body: {
      ok: true,
      capsuleId: input.capsuleId,
      affectedCapsuleSetIds: input.affectedCapsuleSetIds,
      cleanupVerified: input.cleanupVerified,
    },
  };
}

function parseCapsuleId(ctx: RouteContext): KnowledgeCapsule["id"] {
  const capsuleId = ctx.params.capsuleId;
  if (capsuleId === undefined) {
    throw new InvalidRequest("Route parameter capsuleId is required.");
  }
  return capsuleId as KnowledgeCapsule["id"];
}

function parseReindexMode(body: Record<string, unknown>): "changed-files" | "repair-failed" | undefined {
  const mode = body.mode;
  if (mode === undefined || mode === "changed-files" || mode === "repair-failed") {
    return mode;
  }
  throw new InvalidRequest('Field "mode" must be "changed-files" or "repair-failed".');
}

async function runCapsuleIndexingJob(
  deps: UiHandlerDeps,
  store: ReturnType<typeof openKnowledgeStore>,
  capsule: KnowledgeCapsule,
  mode: "changed-files" | "repair-failed" | undefined,
): Promise<
  | { readonly kind: "job-completed"; readonly result: { readonly failedDocuments: number } }
  | { readonly kind: "job-failed" }
  | undefined
> {
  const provider = configuredProviderForCapsule(deps, capsule);
  if (provider === undefined) {
    return { kind: "job-failed" };
  }
  canonicalizeCapsuleSourceRoots(store, capsule);
  const adapter = createEmbeddingAdapter(provider, requestEmbeddingImpl(deps));
  const sourceIds = mode === "repair-failed" ? failedSourceIds(store, capsule.id) : undefined;
  let terminal:
    | { readonly kind: "job-completed"; readonly result: { readonly failedDocuments: number } }
    | { readonly kind: "job-failed" }
    | undefined;
  for await (const event of runIndexingJob({
    capsuleId: capsule.id,
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    parserRegistry: createDefaultParserRegistry(),
    workspaceFs: nodeWorkspaceFs,
    embeddingAdapter: adapter,
    auditSink: createSqliteAuditSink(store),
    store,
    force: false,
  })) {
    if (event.kind === "job-completed" || event.kind === "job-failed") {
      terminal = event;
    }
  }
  return terminal;
}

function failedSourceIds(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: KnowledgeCapsule["id"],
): readonly KnowledgeSourceId[] {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT DISTINCT source_id",
        "FROM documents",
        "WHERE capsule_id = :c AND status = 'failed' AND source_id IS NOT NULL",
        "ORDER BY source_id ASC",
      ].join(" "),
    )
    .all({ c: capsuleId }) as unknown as readonly FailedSourceIdRow[];
  return rows.map((row) => row.source_id as KnowledgeSourceId);
}

async function runHandler(worker: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await worker();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit.") };
    }
    if (error instanceof InvalidRequest) {
      return badRequest("INVALID_REQUEST", error.message);
    }
    if (error instanceof KnowledgeNotFoundError) {
      return notFound(error.message);
    }
    if (error instanceof KnowledgeStoreError) {
      return serviceUnavailable(error.message);
    }
    throw error;
  }
}

export async function handleListLocalKnowledgeCapsules(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(() => {
    const env = openStoreForDeps(deps);
    try {
      const capsules = listCapsules(env.store).map((capsule) => ({
        id: capsule.id,
        displayName: capsule.displayName,
        lifecycleState: capsule.lifecycleState,
        sourceCount: capsule.sourceIds.length,
        updatedAt: capsule.updatedAt,
      }));
      return { status: 200, body: { capsules } };
    } finally {
      env.close();
    }
  });
}

export async function handleListLocalKnowledgeCapsuleSets(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(() => {
    const env = openStoreForDeps(deps);
    try {
      const capsuleSets = listCapsuleSets(env.store).map((capsuleSet) => ({
        id: capsuleSet.id,
        displayName: capsuleSet.displayName,
        capsuleCount: capsuleSet.capsuleIds.length,
        composedAt: capsuleSet.composedAt,
      }));
      return { status: 200, body: { capsuleSets } };
    } finally {
      env.close();
    }
  });
}

export async function handleGetLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(() => {
    const capsuleId = parseCapsuleId(ctx);
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      return {
        status: 200,
        body: {
          capsule,
          health: buildCapsuleHealth(deps, env.store, env.dbPath, capsule),
          sources: loadSourceStats(env.store, capsule.id),
          parserDiagnostics: loadParserDiagnostics(env.store, capsule.id),
          indexingJobs: loadIndexingJobs(env.store, capsule.id),
        },
      };
    } finally {
      env.close();
    }
  });
}

export async function handleDeleteLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    await readJsonObject(ctx.req);
    const env = openStoreForDeps(deps);
    try {
      const result = deleteCapsule(env.store, capsuleId, createSqliteAuditSink(env.store));
      return deleteActionResponse(result);
    } finally {
      env.close();
    }
  });
}

export async function handleReindexLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    const mode = parseReindexMode(await readJsonObject(ctx.req));
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      if (configuredProviderForCapsule(deps, capsule) === undefined) {
        return conflict(
          "No configured embedding model matches this capsule. Update the Model Gateway configuration before refreshing it.",
        );
      }
      const terminal = await runCapsuleIndexingJob(deps, env.store, capsule, mode);
      if (terminal?.kind === "job-failed") {
        return conflict(
          "Capsule refresh failed. Review the capsule health diagnostics and job history for details.",
        );
      }
      return actionResponse(capsule.id);
    } finally {
      env.close();
    }
  });
}
