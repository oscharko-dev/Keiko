import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  addSourceToCapsule,
  composeCapsules,
  CompositionError,
  createSqliteAuditSink,
  createDefaultParserRegistry,
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsuleSets,
  listCapsuleSources,
  listCapsules,
  openKnowledgeStore,
  removeSourceFromCapsule,
  resolveKnowledgeStorePath,
  runIndexingJob,
  updateCapsuleDetails,
  updateCapsuleState,
  type CapsuleDetailsPatch,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  CapsuleHealth,
  DocumentId,
  IndexingJobRecord,
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
  ParserDiagnostic,
  KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import { KnowledgeNotFoundError, KnowledgeStoreError } from "@oscharko-dev/keiko-local-knowledge";
import {
  CAPSULE_SET_MAX_MEMBERS,
  isSafeDisplaySummary,
  validateCapsuleReindexRequest,
  validateKnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import {
  findConfiguredCapability,
  requestOpenAIEmbedding,
  verifyEmbeddingCapability,
  type GatewayConfig,
  type ModelProviderConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";

const MAX_BODY_BYTES = 32_000;
// F4 (Epic #189): cap unbounded BFF response collections so a worst-case capsule with
// thousands of parser diagnostics / job rows cannot inflate a single JSON response.
const MAX_DIAGNOSTICS_PER_RESPONSE = 500;
const MAX_JOBS_PER_RESPONSE = 500;
const LOCAL_KNOWLEDGE_STORE_UNAVAILABLE_MESSAGE =
  "Local knowledge storage is unavailable. Check the local runtime state and try again.";

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

// LK-001 / LK-003 (Epic #189): structured 409 conflict variants that surface the
// affected capsule + job so the UI can route the user back to the right run without
// re-fetching the capsule detail.
function indexingConflict(
  code: "indexing-cancelled" | "indexing-already-running",
  message: string,
  capsuleId: string,
  jobId: string,
): RouteResult {
  return {
    status: 409,
    body: { ...errorBody(code, message), capsuleId, jobId },
  };
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

interface RecoverableRunningJobRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly cancellation_requested: number;
}

function recoverAbandonedIndexingJobs(store: ReturnType<typeof openKnowledgeStore>): void {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT id, capsule_id, cancellation_requested",
        "FROM indexing_jobs",
        "WHERE status = 'running'",
        "ORDER BY started_at ASC, id ASC",
      ].join(" "),
    )
    .all() as unknown as readonly RecoverableRunningJobRow[];
  if (rows.length === 0) {
    return;
  }
  const finishedAt = store._internal.now();
  for (const row of rows) {
    if (
      localKnowledgeIndexingRegistry.isActiveCapsule(row.capsule_id) ||
      localKnowledgeIndexingRegistry.isActiveJob(row.id)
    ) {
      continue;
    }
    const cancelled = row.cancellation_requested === 1;
    store._internal.db
      .prepare(
        [
          "UPDATE indexing_jobs SET",
          "  status = :status,",
          "  finished_at = :finished_at,",
          "  last_error_code = :error_code,",
          "  last_error_message = :error_message",
          "WHERE id = :id AND status = 'running'",
        ].join(" "),
      )
      .run({
        status: cancelled ? "cancelled" : "failed",
        finished_at: finishedAt,
        error_code: cancelled ? "CANCELLED" : "INDEXING_INTERRUPTED",
        error_message: cancelled
          ? "Indexing was cancelled before the run could be finalized."
          : "Indexing stopped unexpectedly before completion. Restart the run to finish indexing.",
        id: row.id,
      });
    try {
      updateCapsuleState(store, row.capsule_id as KnowledgeCapsuleId, "error");
    } catch {
      // informational only — the recovered job row is the durable source of truth
    }
  }
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
  recoverAbandonedIndexingJobs(store);
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

interface EmbeddingSelectionConfig {
  readonly providers: readonly { readonly modelId: string }[];
  readonly capabilities?: GatewayConfig["capabilities"];
}

function configuredCapabilityForModel(
  config: EmbeddingSelectionConfig,
  modelId: string,
): ReturnType<typeof findConfiguredCapability> {
  return findConfiguredCapability(config as GatewayConfig, modelId);
}

function isConfiguredEmbeddingModel(config: EmbeddingSelectionConfig, modelId: string): boolean {
  return configuredCapabilityForModel(config, modelId)?.kind === "embedding";
}

function configuredEmbeddingProvider(
  config: GatewayConfig | undefined,
  modelId: string,
): ModelProviderConfig | undefined {
  if (config === undefined) return undefined;
  const provider = config.providers.find((entry) => entry.modelId === modelId);
  if (provider === undefined) return undefined;
  return isConfiguredEmbeddingModel(config, provider.modelId) ? provider : undefined;
}

function configuredProviderForCapsule(
  deps: UiHandlerDeps,
  capsule: KnowledgeCapsule,
): ModelProviderConfig | undefined {
  const provider = configuredEmbeddingProvider(
    currentGatewayConfig(deps),
    capsule.embeddingModelIdentity.modelId,
  );
  if (provider === undefined) return undefined;
  return storedProviderMatchesConfiguredProvider(capsule.embeddingModelIdentity.provider, provider)
    ? provider
    : undefined;
}

function embeddingCompatibilityReason(
  config: GatewayConfig | undefined,
  capsule: KnowledgeCapsule,
): string | undefined {
  if (config === undefined) return undefined;
  const modelId = capsule.embeddingModelIdentity.modelId;
  if (!config.providers.some((entry) => entry.modelId === modelId)) {
    return "The configured embedding model no longer matches this capsule.";
  }
  const provider = configuredEmbeddingProvider(config, modelId);
  if (provider === undefined) {
    return "The configured model for this capsule cannot serve embeddings.";
  }
  if (!storedProviderMatchesConfiguredProvider(capsule.embeddingModelIdentity.provider, provider)) {
    return "The configured embedding gateway no longer matches this capsule.";
  }
  return undefined;
}

function vectorCompatibility(
  deps: UiHandlerDeps,
  capsule: KnowledgeCapsule,
): { readonly vectorCompatible: boolean; readonly staleReasons: readonly string[] } {
  const config = currentGatewayConfig(deps);
  const reasons: string[] = [];
  const provider = configuredProviderForCapsule(deps, capsule);
  const embeddingReason = embeddingCompatibilityReason(config, capsule);
  if (embeddingReason !== undefined) reasons.push(embeddingReason);
  if (capsule.lifecycleState === "stale") {
    reasons.push("The capsule is marked stale and should be refreshed.");
  }
  if (capsule.lifecycleState === "error") {
    reasons.push("The last indexing run ended with errors.");
  }
  return {
    vectorCompatible: provider !== undefined || config === undefined,
    staleReasons: reasons,
  };
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

function loadSourceStats(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): readonly {
  readonly sourceId: string;
  readonly displayName: string;
  readonly scope: { readonly kind: KnowledgeSource["scope"]["kind"] };
  readonly indexedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}[] {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT s.id AS source_id, ks.display_name, ks.scope_kind, ks.scope_json,",
        "  SUM(CASE WHEN d.status = 'extracted' THEN 1 ELSE 0 END) AS indexed_count,",
        "  SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,",
        "  SUM(CASE WHEN d.status IN ('skipped', 'unsupported') THEN 1 ELSE 0 END) AS skipped_count",
        "FROM capsule_sources AS s",
        "JOIN knowledge_sources AS ks ON ks.id = s.id",
        "LEFT JOIN documents AS d ON d.capsule_id = s.capsule_id AND d.source_id = s.id",
        "WHERE s.capsule_id = :c",
        "GROUP BY s.id, ks.display_name, ks.scope_kind, ks.scope_json",
        "ORDER BY s.created_at ASC, s.id ASC",
      ].join(" "),
    )
    .all({ c: capsuleId }) as unknown as readonly SourceStatsRow[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    displayName: row.display_name,
    scope: { kind: parseScope(row.scope_kind, row.scope_json).kind },
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

interface DiagnosticsPage {
  readonly items: readonly ParserDiagnostic[];
  readonly total: number;
}

function loadParserDiagnostics(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): DiagnosticsPage {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT severity, code, message, document_id, page_number",
        "FROM parser_diagnostics",
        "WHERE capsule_id = :c",
        "ORDER BY created_at DESC, id DESC",
        "LIMIT :limit",
      ].join(" "),
    )
    .all({
      c: capsuleId,
      limit: MAX_DIAGNOSTICS_PER_RESPONSE,
    }) as unknown as readonly ParserDiagnosticRow[];
  const totalRow = store._internal.db
    .prepare("SELECT COUNT(*) AS n FROM parser_diagnostics WHERE capsule_id = :c")
    .get({ c: capsuleId }) as { readonly n: number };
  const items = rows.map((row) => ({
    severity: row.severity as ParserDiagnostic["severity"],
    code: row.code,
    message: row.message,
    ...(row.document_id !== null ? { documentId: row.document_id as DocumentId } : {}),
    ...(row.page_number !== null ? { pageNumber: row.page_number } : {}),
  }));
  return { items, total: totalRow.n };
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
  const rows = store._internal.db
    .prepare(
      [
        "SELECT DISTINCT unsupported_reason",
        "FROM parsed_units",
        "WHERE capsule_id = :c AND kind = 'unsupported-media'",
        "ORDER BY unsupported_reason ASC",
      ].join(" "),
    )
    .all({ c: capsuleId }) as unknown as readonly UnsupportedReasonRow[];
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

interface IndexingJobsPage {
  readonly items: readonly IndexingJobRecord[];
  readonly total: number;
}

function loadIndexingJobs(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): IndexingJobsPage {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT id, capsule_id, source_ids_json, started_at, finished_at, status,",
        "  total_documents, processed_documents, failed_documents, skipped_documents,",
        "  last_error_code, last_error_message, resume_token",
        "FROM indexing_jobs",
        "WHERE capsule_id = :c",
        "ORDER BY started_at DESC, id DESC",
        "LIMIT :limit",
      ].join(" "),
    )
    .all({
      c: capsuleId,
      limit: MAX_JOBS_PER_RESPONSE,
    }) as unknown as readonly IndexingJobRow[];
  const totalRow = store._internal.db
    .prepare("SELECT COUNT(*) AS n FROM indexing_jobs WHERE capsule_id = :c")
    .get({ c: capsuleId }) as { readonly n: number };
  const items = rows.map((row) => rowToIndexingJobRecord(row));
  return { items, total: totalRow.n };
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
          .prepare(
            "SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c AND status = 'failed'",
          )
          .get({ c: capsuleId }) as { readonly n: number })
      : status === "unsupported"
        ? (store._internal.db
            .prepare(
              "SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c AND status = 'unsupported'",
            )
            .get({ c: capsuleId }) as { readonly n: number })
        : (store._internal.db
            .prepare(
              "SELECT COUNT(*) AS n FROM documents WHERE capsule_id = :c AND status IN ('skipped', 'unsupported')",
            )
            .get({ c: capsuleId }) as { readonly n: number });
  return row.n;
}

function lastIndexedAt(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: string,
): number | undefined {
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
    unsupportedDocuments > 0 ? loadUnsupportedGuidance(store, capsule.id) : [];
  return {
    capsuleId: capsule.id,
    sourceIds: capsule.sourceIds,
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
    ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
    request: (request) =>
      requestImpl({
        ...request,
        endpoint: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.apiKeyHeaderName !== undefined
          ? { apiKeyHeaderName: provider.apiKeyHeaderName }
          : {}),
        ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
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
    // Re-validate the deny-list against the canonical (realpath-resolved) root at index time,
    // not only at connect time. A folder that was safe when connected can later be moved or
    // symlink-swapped so its realpath resolves into a denied location (e.g. ~/.ssh); refuse to
    // index it rather than walking credential files inside it. Runs for every source, including
    // already-canonical ones, so it must precede the no-op skip below.
    if (isDenied(connectScopeRootPath(canonicalScope))) {
      throw new InvalidRequest("Source path is in a denied location and cannot be indexed.");
    }
    if (JSON.stringify(canonicalScope) === JSON.stringify(source.scope)) {
      continue;
    }
    store._internal.db
      .prepare(
        "UPDATE knowledge_sources SET scope_json = :scope_json, updated_at = :updated_at WHERE id = :id",
      )
      .run({
        scope_json: scopeToJson(canonicalScope),
        updated_at: now,
        id: source.id,
      });
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

// F4 (Epic #189): the response shape for both GET /capsules/:id and POST /capsules
// includes truncation metadata so a future UI can prompt the user to refine their
// view when the persisted history grew past the per-response cap.
function buildCapsuleResponseBody(
  deps: UiHandlerDeps,
  store: ReturnType<typeof openKnowledgeStore>,
  dbPath: string,
  capsule: KnowledgeCapsule,
): Record<string, unknown> {
  const diagnostics = loadParserDiagnostics(store, capsule.id);
  const jobs = loadIndexingJobs(store, capsule.id);
  return {
    capsule,
    health: buildCapsuleHealth(deps, store, dbPath, capsule),
    sources: loadSourceStats(store, capsule.id),
    parserDiagnostics: diagnostics.items,
    parserDiagnosticsTotal: diagnostics.total,
    parserDiagnosticsTruncated: diagnostics.total > diagnostics.items.length,
    indexingJobs: jobs.items,
    indexingJobsTotal: jobs.total,
    indexingJobsTruncated: jobs.total > jobs.items.length,
  };
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

function requireSafeDisplayText(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isSafeDisplaySummary(trimmed)) {
    throw new InvalidRequest(`Field "${field}" must be a browser-safe non-empty string.`);
  }
  return trimmed;
}

function safeOptionalDisplayText(field: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidRequest(`Field "${field}" must be a string when provided.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!isSafeDisplaySummary(trimmed)) {
    throw new InvalidRequest(`Field "${field}" must be browser-safe when provided.`);
  }
  return trimmed;
}

function parseCreateCapsuleInput(body: Record<string, unknown>): {
  readonly displayName: string;
  readonly description?: string;
} {
  if (typeof body.displayName !== "string") {
    throw new InvalidRequest('Field "displayName" must be a non-empty string.');
  }
  const displayName = requireSafeDisplayText("displayName", body.displayName);
  const description = safeOptionalDisplayText("description", body.description);
  return description === undefined ? { displayName } : { displayName, description };
}

function normalizedEndpointFingerprint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function embeddingProviderIdentity(provider: ModelProviderConfig): string {
  return `openai-compatible:${normalizedEndpointFingerprint(provider.baseUrl)}`;
}

function storedProviderMatchesConfiguredProvider(
  storedProvider: string,
  provider: ModelProviderConfig,
): boolean {
  // Legacy capsules created before #192 audit fixes stored the generic "openai" label.
  // Keep those usable; new capsules store a non-secret endpoint fingerprint so future
  // gateway swaps mark them incompatible instead of mixing unrelated vector spaces.
  if (!storedProvider.startsWith("openai-compatible:")) return true;
  return storedProvider === embeddingProviderIdentity(provider);
}

// Issue #621 / #677: select the first provider whose resolved capability is embedding-capable.
// Falling back to a chat model creates capsules that can never index successfully.
export function selectEmbeddingModelId(
  config: EmbeddingSelectionConfig | null | undefined,
): string | undefined {
  if (config === undefined || config === null || config.providers.length === 0) return undefined;
  return config.providers.find((provider) => isConfiguredEmbeddingModel(config, provider.modelId))
    ?.modelId;
}

function createCapsuleStorageReference(capsuleId: string): string {
  return `capsules/${capsuleId}`;
}

async function verifiedNewCapsuleEmbeddingIdentity(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<
  | { readonly ok: true; readonly identity: KnowledgeCapsule["embeddingModelIdentity"] }
  | { readonly ok: false; readonly result: RouteResult }
> {
  const adapter = createEmbeddingAdapter(provider, requestEmbeddingImpl(deps));
  try {
    const result = await verifyEmbeddingCapability(adapter, {
      modelId: provider.modelId,
      provider: embeddingProviderIdentity(provider),
      vectorMetric: "cosine",
      timeoutMs: provider.timeoutMs,
    });
    if (result.ok) {
      return { ok: true, identity: result.identity };
    }
    return { ok: false, result: conflict(result.safeMessage) };
  } catch {
    return {
      ok: false,
      result: conflict("embedding capability preflight failed before capsule creation"),
    };
  }
}

async function resolveNewCapsuleEmbeddingIdentity(
  deps: UiHandlerDeps,
): Promise<
  | { readonly ok: true; readonly identity: KnowledgeCapsule["embeddingModelIdentity"] }
  | { readonly ok: false; readonly result: RouteResult }
> {
  const config = currentGatewayConfig(deps);
  const configuredModelId = selectEmbeddingModelId(config);
  if (configuredModelId === undefined) {
    return {
      ok: false,
      result: conflict(
        "No configured embedding-capable model is available for new capsules. Configure the Model Gateway first.",
      ),
    };
  }
  const provider = configuredEmbeddingProvider(config, configuredModelId);
  if (provider === undefined) {
    return {
      ok: false,
      result: conflict(
        "No configured embedding-capable model is available for new capsules. Configure the Model Gateway first.",
      ),
    };
  }
  return verifiedNewCapsuleEmbeddingIdentity(deps, provider);
}

function latestRunningJobId(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: KnowledgeCapsule["id"],
): string | undefined {
  const row = store._internal.db
    .prepare(
      [
        "SELECT id",
        "FROM indexing_jobs",
        "WHERE capsule_id = :c AND status = 'running'",
        "ORDER BY started_at DESC, id DESC",
        "LIMIT 1",
      ].join(" "),
    )
    .get({ c: capsuleId }) as { readonly id: string } | undefined;
  return row?.id;
}

function requestRunningJobCancellation(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: KnowledgeCapsule["id"],
): boolean {
  const jobId = latestRunningJobId(store, capsuleId);
  if (jobId === undefined) {
    return false;
  }
  store._internal.db
    .prepare(
      "UPDATE indexing_jobs SET cancellation_requested = 1 WHERE id = :id AND capsule_id = :c",
    )
    .run({ id: jobId, c: capsuleId });
  localKnowledgeIndexingRegistry.cancel(String(capsuleId));
  return true;
}

function emptyCapsuleIndexingConflict(): RouteResult {
  return conflict("Attach at least one source to this capsule before indexing it.");
}

function assertScopeShape(scope: KnowledgeSourceScope): void {
  const result = validateKnowledgeSourceScope(scope);
  if (result.ok) return;
  throw new InvalidRequest(result.errors.join(" "));
}

function disconnectCapsuleSources(
  store: ReturnType<typeof openKnowledgeStore>,
  capsuleId: KnowledgeCapsule["id"],
): void {
  const auditSink = createSqliteAuditSink(store);
  const sources = listCapsuleSources(store, capsuleId);
  for (const source of sources) {
    assertScopeShape(source.scope);
    removeSourceFromCapsule(store, capsuleId, source.id, auditSink);
  }
  updateCapsuleState(store, capsuleId, "draft");
}

// LK-001 (Epic #189): job-cancelled is a distinct terminal kind. Callers must surface it
// as 409, not 200, so the UI never reads a cancelled run as a successful one.
type IndexingTerminal =
  | {
      readonly kind: "job-completed";
      readonly jobId: string;
      readonly result: { readonly failedDocuments: number };
    }
  | { readonly kind: "job-cancelled"; readonly jobId: string }
  | { readonly kind: "job-failed"; readonly jobId: string };

interface RunCapsuleIndexingJobOptions {
  readonly mode: "changed-files" | "repair-failed" | undefined;
  // O2-GAP-1 (Epic #189): reindex callers can request a full re-embed when the embedding
  // model has rotated. Start-indexing keeps force=false so a first-pass run never wipes
  // a partially-built index.
  readonly force: boolean;
}

// LK-001 (Epic #189): both the start and refresh handlers map a terminal IndexingTerminal
// to the same 3-way response — cancelled → 409 cancelled, failed → 409 failed-message,
// any other (completed or absent) → 200 ok. Extracted so each handler stays under the
// 50-LOC per-function ceiling.
function indexingCompletionResponse(
  capsuleId: KnowledgeCapsule["id"],
  terminal: IndexingTerminal | undefined,
  failedMessage: string,
): RouteResult {
  if (terminal?.kind === "job-cancelled") {
    return indexingConflict(
      "indexing-cancelled",
      "Indexing job was cancelled.",
      capsuleId,
      terminal.jobId,
    );
  }
  if (terminal?.kind === "job-failed") {
    return conflict(failedMessage);
  }
  return actionResponse(capsuleId);
}

async function runCapsuleIndexingJob(
  deps: UiHandlerDeps,
  store: ReturnType<typeof openKnowledgeStore>,
  capsule: KnowledgeCapsule,
  options: RunCapsuleIndexingJobOptions,
): Promise<IndexingTerminal | undefined> {
  const provider = configuredProviderForCapsule(deps, capsule);
  if (provider === undefined) {
    return { kind: "job-failed", jobId: "" };
  }
  canonicalizeCapsuleSourceRoots(store, capsule);
  const adapter = createEmbeddingAdapter(provider, requestEmbeddingImpl(deps));
  const sourceIds =
    options.mode === "repair-failed" ? failedSourceIds(store, capsule.id) : undefined;
  const controller = localKnowledgeIndexingRegistry.start(String(capsule.id));
  let terminal: IndexingTerminal | undefined;
  try {
    for await (const event of runIndexingJob({
      capsuleId: capsule.id,
      ...(sourceIds !== undefined ? { sourceIds } : {}),
      parserRegistry: createDefaultParserRegistry(),
      workspaceFs: nodeWorkspaceFs,
      embeddingAdapter: adapter,
      auditSink: createSqliteAuditSink(store),
      store,
      force: options.force,
      signal: controller.signal,
    })) {
      if (event.kind === "job-started") {
        localKnowledgeIndexingRegistry.attachJobId(String(capsule.id), event.jobId);
      }
      if (
        event.kind === "job-completed" ||
        event.kind === "job-failed" ||
        event.kind === "job-cancelled"
      ) {
        terminal = event;
      }
    }
  } finally {
    localKnowledgeIndexingRegistry.complete(String(capsule.id));
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
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof InvalidRequest) {
      return badRequest("INVALID_REQUEST", error.message);
    }
    if (error instanceof KnowledgeNotFoundError) {
      return notFound(error.message);
    }
    if (error instanceof KnowledgeStoreError) {
      return serviceUnavailable(LOCAL_KNOWLEDGE_STORE_UNAVAILABLE_MESSAGE);
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

// ─── Create a capsule set (Slice 4 / Issue #189) — non-destructive composition ──

function parseSetCapsuleIds(raw: unknown): readonly KnowledgeCapsuleId[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InvalidRequest('Field "capsuleIds" must be a non-empty array.');
  }
  if (raw.length > CAPSULE_SET_MAX_MEMBERS) {
    throw new InvalidRequest(
      `A capsule set may reference at most ${String(CAPSULE_SET_MAX_MEMBERS)} capsules.`,
    );
  }
  const seen = new Set<string>();
  const capsuleIds: KnowledgeCapsuleId[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new InvalidRequest('Every "capsuleIds" entry must be a non-empty string.');
    }
    if (seen.has(id)) {
      throw new InvalidRequest(`Duplicate capsule id in the set request: ${id}.`);
    }
    seen.add(id);
    capsuleIds.push(id as KnowledgeCapsuleId);
  }
  return capsuleIds;
}

function parseCreateCapsuleSetInput(body: Record<string, unknown>): {
  readonly displayName: string;
  readonly description?: string;
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
} {
  if (typeof body.displayName !== "string") {
    throw new InvalidRequest('Field "displayName" must be a non-empty string.');
  }
  const displayName = requireSafeDisplayText("displayName", body.displayName);
  const capsuleIds = parseSetCapsuleIds(body.capsuleIds);
  const description = safeOptionalDisplayText("description", body.description);
  return description === undefined
    ? { displayName, capsuleIds }
    : { displayName, description, capsuleIds };
}

export async function handleCreateLocalKnowledgeCapsuleSet(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const input = parseCreateCapsuleSetInput(await readJsonObject(ctx.req));
    const env = openStoreForDeps(deps);
    try {
      const set = composeCapsules(env.store, {
        displayName: input.displayName,
        ...(input.description !== undefined ? { description: input.description } : {}),
        capsuleIds: input.capsuleIds,
      });
      return {
        status: 201,
        body: {
          capsuleSet: {
            id: set.id,
            displayName: set.displayName,
            ...(set.description !== undefined ? { description: set.description } : {}),
            capsuleIds: set.capsuleIds,
            capsuleCount: set.capsuleIds.length,
            composedAt: set.composedAt,
          },
        },
      };
    } catch (error) {
      if (error instanceof CompositionError) {
        return badRequest("INVALID_REQUEST", error.message);
      }
      throw error;
    } finally {
      env.close();
    }
  });
}

// ─── Update a capsule's display name / description (Slice 4 / Issue #189) ───────
// Metadata persistence requires a schema migration and is intentionally NOT supported here yet;
// a metadata-bearing patch is rejected with a clear 400 rather than silently dropped.

function parseUpdateCapsuleInput(body: Record<string, unknown>): CapsuleDetailsPatch {
  if (body.metadata !== undefined) {
    throw new InvalidRequest(
      "Capsule metadata updates are not yet supported; update displayName or description.",
    );
  }
  const patch: { displayName?: string; description?: string } = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") {
      throw new InvalidRequest('Field "displayName" must be a non-empty string when provided.');
    }
    patch.displayName = requireSafeDisplayText("displayName", body.displayName);
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      throw new InvalidRequest('Field "description" must be a string when provided.');
    }
    const trimmed = body.description.trim();
    if (!isSafeDisplaySummary(trimmed)) {
      throw new InvalidRequest('Field "description" must be browser-safe when provided.');
    }
    patch.description = trimmed;
  }
  if (patch.displayName === undefined && patch.description === undefined) {
    throw new InvalidRequest("Patch must include displayName or description.");
  }
  return patch;
}

export async function handleUpdateLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    const patch = parseUpdateCapsuleInput(await readJsonObject(ctx.req));
    const env = openStoreForDeps(deps);
    try {
      const capsule = updateCapsuleDetails(env.store, capsuleId, patch);
      return {
        status: 200,
        body: buildCapsuleResponseBody(deps, env.store, env.dbPath, capsule),
      };
    } finally {
      env.close();
    }
  });
}

export async function handleCreateLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const input = parseCreateCapsuleInput(await readJsonObject(ctx.req));
    const env = openStoreForDeps(deps);
    try {
      const embeddingIdentity = await resolveNewCapsuleEmbeddingIdentity(deps);
      if (!embeddingIdentity.ok) {
        return embeddingIdentity.result;
      }
      const capsuleId = randomUUID() as KnowledgeCapsule["id"];
      const capsule = createCapsule(
        env.store,
        {
          id: capsuleId,
          displayName: input.displayName,
          ...(input.description !== undefined ? { description: input.description } : {}),
          tags: [],
          retrievalEffort: "default",
          outputMode: "snippets",
          answerGroundingPolicy: "require-citations",
          embeddingModelIdentity: embeddingIdentity.identity,
          lifecycleState: "draft",
          storageReference: createCapsuleStorageReference(capsuleId),
        },
        createSqliteAuditSink(env.store),
      );
      return {
        status: 201,
        body: buildCapsuleResponseBody(deps, env.store, env.dbPath, capsule),
      };
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
        body: buildCapsuleResponseBody(deps, env.store, env.dbPath, capsule),
      };
    } finally {
      env.close();
    }
  });
}

export async function handleStartLocalKnowledgeCapsuleIndexing(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    await readJsonObject(ctx.req);
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      if (capsule.sourceIds.length === 0) {
        return emptyCapsuleIndexingConflict();
      }
      if (configuredProviderForCapsule(deps, capsule) === undefined) {
        return conflict(
          "No configured embedding-capable model matches this capsule. Update the Model Gateway configuration before indexing it.",
        );
      }
      // LK-003 (Epic #189): refuse to start a second concurrent indexer for the same
      // capsule — the orchestrator persists running jobs, so a duplicate POST would
      // race the in-flight one and corrupt vector counts.
      const runningJobId = latestRunningJobId(env.store, capsule.id);
      if (runningJobId !== undefined) {
        return indexingConflict(
          "indexing-already-running",
          "An indexing job is already running for this capsule.",
          capsule.id,
          runningJobId,
        );
      }
      const terminal = await runCapsuleIndexingJob(deps, env.store, capsule, {
        mode: undefined,
        force: false,
      });
      return indexingCompletionResponse(
        capsule.id,
        terminal,
        "Capsule indexing failed. Review the capsule health diagnostics and job history for details.",
      );
    } finally {
      env.close();
    }
  });
}

export async function handleCancelLocalKnowledgeCapsuleIndexing(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    await readJsonObject(ctx.req);
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      if (!requestRunningJobCancellation(env.store, capsule.id)) {
        return conflict("No running indexing job was found for this capsule.");
      }
      return actionResponse(capsule.id);
    } finally {
      env.close();
    }
  });
}

// ─── Connect a source folder to a capsule (Epic #189) ─────────────────────────
// A connector's entry point: attach a host folder (or file set) as a knowledge source
// so it can be indexed. Connectors deliberately reach OUTSIDE the workspace (the product
// connects ANY machine folder of manuals), so containment is by realpath + the always-on
// deny list (never index ~/.ssh, ~/.aws, .git, …) — not a workspace root. Per-file size
// and format limits are enforced later by the indexing discovery walk.

function connectScopeRootPath(scope: KnowledgeSourceScope): string {
  return scope.kind === "folder" || scope.kind === "files" ? scope.rootPath : scope.repositoryRoot;
}

function parseConnectSourceInput(body: Record<string, unknown>): {
  readonly scope: KnowledgeSourceScope;
  readonly displayName: string;
} {
  const scopeRaw = body.scope;
  if (typeof scopeRaw !== "object" || scopeRaw === null || Array.isArray(scopeRaw)) {
    throw new InvalidRequest('Field "scope" must be a knowledge-source scope object.');
  }
  const scope = scopeRaw as KnowledgeSourceScope;
  assertScopeShape(scope);
  const displayNameRaw = body.displayName;
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim().length > 0
      ? requireSafeDisplayText("displayName", displayNameRaw)
      : basename(connectScopeRootPath(scope));
  if (!isSafeDisplaySummary(displayName)) {
    throw new InvalidRequest('Field "displayName" must be browser-safe when provided.');
  }
  return { scope, displayName };
}

// Canonicalize (realpath) then refuse denied locations and non-directory roots BEFORE
// touching the store. realpath resolves symlinks so a link into ~/.ssh cannot slip past.
function guardConnectorSourcePath(scope: KnowledgeSourceScope): KnowledgeSourceScope {
  const canonical = canonicalizeScopeRoot(scope);
  const root = connectScopeRootPath(canonical);
  if (isDenied(root)) {
    throw new InvalidRequest("Source path is in a denied location and cannot be indexed.");
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(root);
  } catch {
    throw new InvalidRequest("Source path does not exist or is not accessible.");
  }
  if (!stats.isDirectory()) {
    throw new InvalidRequest("Source path must be an existing directory.");
  }
  return canonical;
}

export async function handleConnectLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    const { scope, displayName } = parseConnectSourceInput(await readJsonObject(ctx.req));
    const guarded = guardConnectorSourcePath(scope);
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      addSourceToCapsule(
        env.store,
        capsule.id,
        {
          id: randomUUID() as KnowledgeSourceId,
          displayName,
          tags: [],
          scope: guarded,
        },
        createSqliteAuditSink(env.store),
      );
      const updated = getCapsule(env.store, capsule.id) ?? capsule;
      return {
        status: 201,
        body: buildCapsuleResponseBody(deps, env.store, env.dbPath, updated),
      };
    } finally {
      env.close();
    }
  });
}

export async function handleDisconnectLocalKnowledgeCapsule(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const capsuleId = parseCapsuleId(ctx);
    await readJsonObject(ctx.req);
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      disconnectCapsuleSources(env.store, capsule.id);
      return actionResponse(capsule.id);
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
    const body = await readJsonObject(ctx.req);
    const reindexRequest = validateCapsuleReindexRequest({ ...body, capsuleId });
    if (!reindexRequest.ok) {
      throw new InvalidRequest(reindexRequest.errors.join(" "));
    }
    const mode = reindexRequest.value.mode;
    const force = reindexRequest.value.force ?? false;
    const env = openStoreForDeps(deps);
    try {
      const capsule = getCapsule(env.store, capsuleId);
      if (capsule === undefined) {
        return notFound(`Capsule not found: ${capsuleId}`);
      }
      if (capsule.sourceIds.length === 0) {
        return emptyCapsuleIndexingConflict();
      }
      if (configuredProviderForCapsule(deps, capsule) === undefined) {
        return conflict(
          "No configured embedding-capable model matches this capsule. Update the Model Gateway configuration before refreshing it.",
        );
      }
      // LK-003 (Epic #189): same concurrent-run guard as the start handler.
      const runningJobId = latestRunningJobId(env.store, capsule.id);
      if (runningJobId !== undefined) {
        return indexingConflict(
          "indexing-already-running",
          "An indexing job is already running for this capsule.",
          capsule.id,
          runningJobId,
        );
      }
      const terminal = await runCapsuleIndexingJob(deps, env.store, capsule, {
        mode,
        force,
      });
      return indexingCompletionResponse(
        capsule.id,
        terminal,
        "Capsule refresh failed. Review the capsule health diagnostics and job history for details.",
      );
    } finally {
      env.close();
    }
  });
}
