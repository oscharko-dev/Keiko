import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  buildConsolidationJob,
  runConsolidation,
  transitionJob,
  type ConsolidationEmbedding,
  type ConsolidationResult,
} from "@oscharko-dev/keiko-memory-consolidation";
import {
  MEMORY_SCOPE_KINDS,
  MEMORY_CONSOLIDATION_EXCERPT_MAX_CHARS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type MemoryEdgeId,
  type MemoryId,
  type MemoryRecord,
  type MemoryScope,
  type MemoryScopeKind,
  type MemoryStatus,
  type MemoryType,
  type MemoryConsolidationJobEnvelopeWire,
  type MemoryConsolidationApplyPreconditionWire,
  type MemoryConsolidationApplicationWire,
  type MemoryConsolidationJobResponseWire,
  type MemoryConsolidationReviewItemWire,
  type MemoryConsolidationResultWire,
} from "@oscharko-dev/keiko-contracts";
import type {
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  MemoryStoragePreconditionError,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { contentFreeErrorClass, emitServerDiagnostic } from "./diagnostics-log.js";
import type {
  ConsolidationJobRecord,
  ConsolidationReviewSnapshot,
  ConsolidationJobSelection,
  ConsolidationJobSettings,
} from "./memory-consolidation-registry.js";
import { enrichReviewItemsWithAdvisory } from "./memory-conflict-advisory.js";
import { readJsonRequestBody } from "./bounded-request-body.js";
import { consolidationLogSinkFor } from "./process-log-sink.js";

const MAX_BODY_BYTES = 64_000;
const DEFAULT_JACCARD_THRESHOLD = 0.85;
const DEFAULT_STALE_CONFIDENCE_THRESHOLD = 0.3;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CLUSTERS_PER_RUN = 100;
const DEFAULT_MAX_RECORDS_PER_RUN = 1_000;
const MAX_CLUSTERS_PER_RUN_LIMIT = 1_000;
const MAX_RECORDS_PER_RUN_LIMIT = 1_000;
const DEFAULT_CONSOLIDATION_STATUSES: readonly MemoryStatus[] = [
  "accepted",
  "proposed",
  "conflicted",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number";
}

// Consolidated onto the shared bounded reader (#2902 w5-sse-counters) — the cap above is
// unchanged, only the ad hoc listener wiring is gone. The read-parse-validate wrapper itself is
// also consolidated (#2902 audit finding 3): `readJsonRequestBody` (bounded-request-body.ts) is
// the one owner of "bounded read, then parse+validate as a JSON object", previously hand-rolled
// identically in this file, memory-handlers.ts and memory-conv-handlers.ts.
function readJsonBody(
  req: IncomingMessage,
  correlationId?: string,
): Promise<Record<string, unknown> | RouteResult> {
  return readJsonRequestBody(req, MAX_BODY_BYTES, correlationId);
}

function resolveVault(deps: UiHandlerDeps): MemoryVaultStore | RouteResult {
  if (deps.memoryVault === undefined) {
    return {
      status: 503,
      body: errorBody("MEMORY_UNAVAILABLE", "Memory vault is not configured."),
    };
  }
  return deps.memoryVault;
}

function resolveJobRegistry(
  deps: UiHandlerDeps,
): import("./memory-consolidation-registry.js").ConsolidationJobRegistry | RouteResult {
  if (deps.consolidationJobs === undefined) {
    return {
      status: 503,
      body: errorBody("MEMORY_UNAVAILABLE", "Consolidation jobs are not configured."),
    } satisfies RouteResult;
  }
  return deps.consolidationJobs;
}

function isScopeKind(value: unknown): value is MemoryScopeKind {
  return typeof value === "string" && (MEMORY_SCOPE_KINDS as readonly string[]).includes(value);
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseScopedId(raw: Record<string, unknown>, key: string): string | null {
  const value = readString(raw, key);
  return value ?? null;
}

function parseScopeWithId<TScope extends MemoryScope>(
  raw: Record<string, unknown>,
  key: string,
  build: (id: string) => TScope,
): TScope | null {
  const value = parseScopedId(raw, key);
  return value === null ? null : build(value);
}

function parseScope(raw: unknown): MemoryScope | null {
  if (!isRecord(raw) || !isScopeKind(raw.kind)) return null;
  if (raw.kind === "global") return { kind: "global" };
  if (raw.kind === "user") {
    return parseScopeWithId(raw, "userId", (userId) => ({
      kind: "user",
      userId: userId as UserId,
    }));
  }
  if (raw.kind === "workspace") {
    return parseScopeWithId(raw, "workspaceId", (workspaceId) => ({
      kind: "workspace",
      workspaceId: workspaceId as WorkspaceId,
    }));
  }
  if (raw.kind === "project") {
    return parseScopeWithId(raw, "projectId", (projectId) => ({
      kind: "project",
      projectId: projectId as ProjectId,
    }));
  }
  return parseScopeWithId(raw, "workflowDefinitionId", (workflowDefinitionId) => ({
    kind: "workflow",
    workflowDefinitionId: workflowDefinitionId as WorkflowDefinitionId,
  }));
}

function parseScopes(raw: unknown): readonly MemoryScope[] | null {
  if (raw === undefined) return [{ kind: "global" }];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const scopes: MemoryScope[] = [];
  for (const item of raw) {
    const scope = parseScope(item);
    if (scope === null) return null;
    scopes.push(scope);
  }
  return scopes;
}

function parseTypes(raw: unknown): readonly MemoryType[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const types: MemoryType[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(MEMORY_TYPES as readonly string[]).includes(item)) {
      return null;
    }
    types.push(item as MemoryType);
  }
  return types;
}

function parseStatuses(raw: unknown): readonly MemoryStatus[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const statuses: MemoryStatus[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(MEMORY_STATUSES as readonly string[]).includes(item)) {
      return null;
    }
    statuses.push(item as MemoryStatus);
  }
  return statuses;
}

function parseOptionalNumber(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseSettingsRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined) return {};
  return isRecord(raw) ? raw : null;
}

interface SettingBounds {
  readonly lo: number;
  readonly hi: number;
  readonly integerOnly?: boolean;
}

const SETTING_BOUNDS: Record<keyof ConsolidationJobSettings, SettingBounds> = {
  jaccardThreshold: { lo: 0, hi: 1 },
  staleConfidenceThreshold: { lo: 0, hi: 1 },
  maxAgeMs: { lo: 0, hi: Number.MAX_SAFE_INTEGER },
  maxClustersPerRun: { lo: 0, hi: MAX_CLUSTERS_PER_RUN_LIMIT, integerOnly: true },
  maxRecordsPerRun: { lo: 0, hi: MAX_RECORDS_PER_RUN_LIMIT, integerOnly: true },
};

function resolveSetting(
  raw: Record<string, unknown>,
  key: keyof ConsolidationJobSettings,
  fallback: number,
): number | null {
  const value = parseOptionalNumber(raw[key]);
  if (value === null) return null;
  const n = value ?? fallback;
  const bounds = SETTING_BOUNDS[key];
  if (n < bounds.lo || n > bounds.hi) return null;
  if (bounds.integerOnly === true && !Number.isInteger(n)) return null;
  return n;
}

function parseSettings(raw: unknown): ConsolidationJobSettings | RouteResult {
  const record = parseSettingsRecord(raw);
  if (record === null) {
    return badRequest(
      "settings must be an object containing optional numeric consolidation settings.",
    );
  }
  const keys = Object.keys(SETTING_BOUNDS) as (keyof ConsolidationJobSettings)[];
  const defaults: ConsolidationJobSettings = {
    jaccardThreshold: DEFAULT_JACCARD_THRESHOLD,
    staleConfidenceThreshold: DEFAULT_STALE_CONFIDENCE_THRESHOLD,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    maxClustersPerRun: DEFAULT_MAX_CLUSTERS_PER_RUN,
    maxRecordsPerRun: DEFAULT_MAX_RECORDS_PER_RUN,
  };
  const result: Record<string, number> = {};
  for (const key of keys) {
    const value = resolveSetting(record, key, defaults[key]);
    if (value === null) {
      const bounds = SETTING_BOUNDS[key];
      const extra = bounds.integerOnly === true ? ", integer" : "";
      return badRequest(
        `settings.${key} must be a finite number in [${String(bounds.lo)}, ${String(bounds.hi)}]${extra}.`,
      );
    }
    result[key] = value;
  }
  return result as unknown as ConsolidationJobSettings;
}

interface CreateJobInput {
  readonly selection: ConsolidationJobSelection;
  readonly settings: ConsolidationJobSettings;
}

interface LoadedMemories {
  readonly records: readonly MemoryRecord[];
  readonly truncated: boolean;
}

function badRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function parseSelection(raw: Record<string, unknown>): ConsolidationJobSelection | RouteResult {
  const scopes = parseScopes(raw.scopes);
  if (scopes === null) {
    return badRequest("scopes must be a non-empty array of valid MemoryScope.");
  }
  const types = parseTypes(raw.types);
  if (raw.types !== undefined && types === null) {
    return badRequest(`types must be an array of: ${MEMORY_TYPES.join(", ")}.`);
  }
  const statuses = parseStatuses(raw.statuses);
  if (raw.statuses !== undefined && statuses === null) {
    return badRequest(`statuses must be an array of: ${MEMORY_STATUSES.join(", ")}.`);
  }
  if (raw.includeExpired !== undefined && typeof raw.includeExpired !== "boolean") {
    return badRequest("includeExpired must be a boolean when provided.");
  }
  return {
    scopes,
    types: types ?? undefined,
    statuses: statuses ?? undefined,
    includeExpired: raw.includeExpired === true,
  };
}

function parseCreateInput(raw: Record<string, unknown>): CreateJobInput | RouteResult {
  const selection = parseSelection(raw);
  if (isRouteResult(selection)) return selection;
  const settings = parseSettings(raw.settings);
  if (isRouteResult(settings)) return settings;
  return { selection, settings };
}

function loadSelectedMemories(
  vault: MemoryVaultStore,
  selection: ConsolidationJobSelection,
  maxRecords: number,
): LoadedMemories {
  const seen = new Map<string, MemoryRecord>();
  const statuses = selection.statuses ?? DEFAULT_CONSOLIDATION_STATUSES;
  if (statuses.length === 0 || maxRecords <= 0) return { records: [], truncated: false };
  const detectionLimit = maxRecords + 1;
  for (const scope of selection.scopes) {
    const remaining = detectionLimit - seen.size;
    if (remaining <= 0) break;
    const records = vault.listMemoriesByScope(scope, {
      ...(selection.types !== undefined ? { type: selection.types } : {}),
      status: statuses,
      includeExpired: selection.includeExpired,
      limit: remaining,
      orderBy: "updatedAt",
      orderDir: "desc",
    });
    for (const record of records) {
      seen.set(record.id, record);
      if (seen.size >= detectionLimit) break;
    }
  }
  // Newest first, matching the engine's own work-window ordering (boundedEligibleMemories). This
  // loader slices to maxRecords BEFORE runConsolidation sees the records, so an oldest-first order
  // here reproduced the frozen-window defect independently of the engine: past the cap the newest
  // memories were discarded before any duplicate or conflict scan could reach them.
  const sorted = [...seen.values()]
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id.localeCompare(b.id);
    })
    .slice(0, maxRecords);
  return {
    records: sorted,
    truncated: seen.size > maxRecords,
  };
}

function redactJob(
  deps: UiHandlerDeps,
  record: ConsolidationJobRecord,
  vault?: MemoryVaultStore,
): MemoryConsolidationJobEnvelopeWire {
  const job: MemoryConsolidationJobEnvelopeWire["job"] = {
    id: record.job.id,
    state: record.job.state,
    ...(record.job.startedAt !== undefined ? { startedAt: record.job.startedAt } : {}),
    ...(record.job.completedAt !== undefined ? { completedAt: record.job.completedAt } : {}),
    ...(record.job.result !== undefined
      ? { result: projectConsolidationResult(deps, record, vault) }
      : {}),
    ...(record.job.error !== undefined ? { error: record.job.error } : {}),
  };
  const selection: MemoryConsolidationJobEnvelopeWire["selection"] = {
    scopes: record.selection.scopes,
    includeExpired: record.selection.includeExpired,
    ...(record.selection.types !== undefined ? { types: record.selection.types } : {}),
    ...(record.selection.statuses !== undefined ? { statuses: record.selection.statuses } : {}),
  };
  const envelope: MemoryConsolidationJobEnvelopeWire = {
    job,
    createdAt: record.createdAt,
    selection,
    settings: record.settings,
    memoryCount: record.memoryCount,
    cancelRequested: record.cancelRequested,
  };
  return deps.redactor(envelope) as MemoryConsolidationJobEnvelopeWire;
}

function excerptForMemory(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore | undefined,
  snapshot: ConsolidationReviewSnapshot["memories"][number],
): MemoryConsolidationReviewItemWire["memoryExcerpts"][number] | undefined {
  const record = vault?.getMemory(snapshot.memoryId);
  if (record === undefined) return undefined;
  const redacted = deps.redactor(record.body);
  const body = typeof redacted === "string" ? redacted : "";
  return {
    memoryId: snapshot.memoryId,
    bodyExcerpt: body.slice(0, MEMORY_CONSOLIDATION_EXCERPT_MAX_CHARS),
    truncated: body.length > MEMORY_CONSOLIDATION_EXCERPT_MAX_CHARS,
    status: record.status,
    expectedUpdatedAt: snapshot.updatedAt,
  };
}

function projectReviewItem(
  deps: UiHandlerDeps,
  record: ConsolidationJobRecord,
  vault: MemoryVaultStore | undefined,
  item: NonNullable<ConsolidationResult["reviewItems"]>[number],
): MemoryConsolidationReviewItemWire {
  const snapshot = record.reviewSnapshots?.find((entry) => entry.itemId === item.id);
  const memoryExcerpts =
    snapshot?.memories.flatMap((memory) => {
      const excerpt = excerptForMemory(deps, vault, memory);
      return excerpt === undefined ? [] : [excerpt];
    }) ?? [];
  return { ...item, memoryExcerpts };
}

function projectConsolidationResult(
  deps: UiHandlerDeps,
  record: ConsolidationJobRecord,
  vault: MemoryVaultStore | undefined,
): MemoryConsolidationResultWire {
  const result = record.job.result;
  if (result === undefined) {
    throw new TypeError("Completed consolidation projection requires a result.");
  }
  return {
    ...result,
    reviewItems: result.reviewItems.map((item) => projectReviewItem(deps, record, vault, item)),
  };
}

function newMemoryEdgeId(): MemoryEdgeId {
  return randomUUID() as unknown as MemoryEdgeId;
}

interface BuildRunOptionsArgs {
  readonly jobId: string;
  readonly scheduledRecord: ConsolidationJobRecord | undefined;
  readonly createdAt: number;
  readonly vault: MemoryVaultStore;
  readonly memories: readonly MemoryRecord[];
  readonly selection: ConsolidationJobSelection;
  readonly settings: ConsolidationJobSettings;
}

function buildRunOptions(args: BuildRunOptionsArgs): Parameters<typeof runConsolidation>[1] {
  const { jobId, scheduledRecord, createdAt, vault, memories, selection, settings } = args;
  const memoryIds = memories.map((memory) => memory.id);
  const embeddings = vault.getEmbeddings(memoryIds);
  const accessStats = vault.getAccessStats(memoryIds);
  const includeStatuses = selection.statuses ?? DEFAULT_CONSOLIDATION_STATUSES;
  return {
    nowMs: createdAt,
    newEdgeId: newMemoryEdgeId,
    newReviewItemId: (): string => randomUUID(),
    jaccardThreshold: settings.jaccardThreshold,
    staleConfidenceThreshold: settings.staleConfidenceThreshold,
    maxAgeMs: settings.maxAgeMs,
    maxClustersPerRun: settings.maxClustersPerRun,
    maxRecordsPerRun: settings.maxRecordsPerRun,
    includeStatuses,
    embeddingFor: (memoryId: MemoryId): ConsolidationEmbedding | undefined => {
      const row = embeddings.get(memoryId);
      if (row === undefined) return undefined;
      return {
        vector: row.vector,
        provider: row.provider,
        modelId: row.modelId,
        metric: row.metric,
        ...(row.modelRevision !== undefined ? { modelRevision: row.modelRevision } : {}),
      };
    },
    accessStatsFor: (memoryId: MemoryId) => accessStats.get(memoryId),
    // Capture the record reference at schedule-time rather than re-fetching via the registry on
    // every poll — eliminates a theoretical race where the registry entry is replaced under the
    // closure before the signal is first checked.
    cancellationSignal: (): boolean => scheduledRecord?.cancelRequested === true,
    // Wires the process-wide activity log so `consolidation.summary.fallback` (the ONE line
    // `chooseSummaryBody`'s deterministic-union fallback emits) is durable rather than silently
    // unreachable, and stamps this job's own id as the event's `correlationId` — the package's
    // `ConsolidationLogEvent` carries no jobId field of its own — so an operator can join the
    // fallback reason back to the job that produced it (#2902 w6).
    logSink: consolidationLogSinkFor(jobId),
  };
}

function finalizeTerminalJob(
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  running: ReturnType<typeof transitionJob>,
  jobId: string,
  memories: readonly MemoryRecord[],
  result: ConsolidationResult,
  selectionTruncated = false,
): void {
  const completedAt = Date.now();
  const finalResult: ConsolidationResult =
    selectionTruncated && !result.truncated ? { ...result, truncated: true } : result;
  if (result.state === "completed") {
    const reviewSnapshots = buildReviewSnapshots(finalResult, memories);
    registry.complete(
      jobId,
      transitionJob(running, "completed", { completedAt, result: finalResult }),
      memories.length,
      reviewSnapshots,
    );
    return;
  }
  if (result.state === "canceled") {
    registry.complete(
      jobId,
      transitionJob(running, "canceled", { completedAt, result: finalResult }),
      memories.length,
    );
    return;
  }
  const message = "Consolidation run failed.";
  registry.fail(
    jobId,
    transitionJob(running, "failed", { completedAt, result: finalResult, error: message }),
    message,
    memories.length,
  );
}

function buildReviewSnapshots(
  result: ConsolidationResult,
  memories: readonly MemoryRecord[],
): readonly ConsolidationReviewSnapshot[] {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  return result.reviewItems.map((item) => ({
    itemId: item.id,
    memories: item.relatedMemoryIds.flatMap((memoryId) => {
      const memory = byId.get(memoryId);
      return memory === undefined
        ? []
        : [{ memoryId, status: memory.status, updatedAt: memory.updatedAt }];
    }),
  }));
}

function failScheduledJob(
  deps: UiHandlerDeps,
  correlationId: string,
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  running: ReturnType<typeof transitionJob>,
  jobId: string,
  memories: readonly MemoryRecord[],
  error: unknown,
): void {
  const completedAt = Date.now();
  // COUPLING-004: persist only the same fixed, cause-free string that finalizeTerminalJob() uses;
  // a raw error can contain a filesystem path or SQL fragment that must not cross into the browser.
  const message = "Consolidation run failed.";
  // The engine/vault throw that caused this job to fail was previously discarded here: the job was
  // marked permanently failed with no record of what threw. Log a content-free diagnostic (error
  // CLASS only, never the raw message) before the job transitions to its terminal "failed" state.
  emitServerDiagnostic(deps.diagnostics, {
    correlationId,
    timestamp: new Date(completedAt).toISOString(),
    operation: "memory.consolidation.job.run",
    source: "memory-consolidation.scheduled-job",
    errorClass: contentFreeErrorClass(error),
    message: "memory-consolidation-scheduled-job-failed",
  });
  registry.fail(
    jobId,
    transitionJob(running, "failed", { completedAt, error: message }),
    message,
    memories.length,
  );
}

function emptyConsolidationResult(state: ConsolidationResult["state"]): ConsolidationResult {
  return {
    state,
    edgesProposed: [],
    updatesProposed: [],
    summaryStatus: {
      kind: "not-configured",
      updatesProposed: 0,
      skippedMergeClusters: 0,
      fallbacksUsed: 0,
    },
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    conflictPairsDetected: 0,
    recordsInspected: 0,
    truncated: false,
    elapsedMs: 0,
  };
}

// Runs the pure engine unchanged, then — only for a nominally completed result — enriches
// review items with an advisory suggestion (Issue #2130 / ADR-0120). The enrichment call itself
// never throws (see memory-conflict-advisory.ts's own top-level guard); a cancel request that
// arrives during that window is folded back into `state: "canceled"` so the existing
// `finalizeTerminalJob` branch handles it exactly like an engine-detected cancellation.
async function enrichConsolidationResult(
  deps: UiHandlerDeps,
  jobId: string,
  result: ConsolidationResult,
  memories: readonly MemoryRecord[],
): Promise<ConsolidationResult> {
  if (result.state !== "completed") return result;
  const advisory = await enrichReviewItemsWithAdvisory(deps, jobId, result.reviewItems, memories);
  if (advisory.canceledDuringAdvisory) {
    return { ...result, state: "canceled", reviewItems: advisory.enrichedItems };
  }
  return { ...result, reviewItems: advisory.enrichedItems };
}

// Shared by both cancellation checkpoints in `runScheduledJob` (before and after the load, which
// used to duplicate the same transition+complete call inline) — extracted only to keep that
// function under the AGENTS.md max-lines-per-function ceiling.
function completeIfCanceled(
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  jobId: string,
  record: ConsolidationJobRecord,
  recordCount: number,
): boolean {
  if (!record.cancelRequested) return false;
  const canceled = transitionJob(record.job, "canceled", { completedAt: Date.now() });
  registry.complete(jobId, canceled, recordCount);
  return true;
}

async function runScheduledJob(
  deps: UiHandlerDeps,
  correlationId: string,
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  jobId: string,
  vault: MemoryVaultStore,
  selection: ConsolidationJobSelection,
  settings: ConsolidationJobSettings,
): Promise<void> {
  const queued = registry.get(jobId);
  if (queued?.job.state !== "queued") return;
  if (completeIfCanceled(registry, jobId, queued, 0)) return;
  const loaded = loadSelectedMemories(vault, selection, settings.maxRecordsPerRun);
  const memories = loaded.records;
  const afterLoad = registry.get(jobId);
  if (afterLoad?.job.state !== "queued") return;
  if (completeIfCanceled(registry, jobId, afterLoad, memories.length)) return;
  if (memories.length === 0 || settings.maxClustersPerRun === 0) {
    const result = emptyConsolidationResult("skipped");
    const skipped = transitionJob(afterLoad.job, "skipped", {
      completedAt: Date.now(),
      result,
    });
    registry.complete(jobId, skipped, memories.length);
    return;
  }
  const running = transitionJob(afterLoad.job, "running");
  registry.setRunning(jobId, running);
  const scheduledRecord = registry.get(jobId);
  try {
    const result = runConsolidation(
      memories,
      buildRunOptions({
        jobId,
        scheduledRecord,
        createdAt: queued.createdAt,
        vault,
        memories,
        selection,
        settings,
      }),
    );
    await finalizeScheduledConsolidation(deps, registry, running, jobId, memories, result, loaded);
  } catch (error) {
    failScheduledJob(deps, correlationId, registry, running, jobId, memories, error);
  }
}

// Split out of `runScheduledJob` solely to keep that function under the AGENTS.md
// max-lines-per-function ceiling; behaviourally this is still that function's success path.
async function finalizeScheduledConsolidation(
  deps: UiHandlerDeps,
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  running: ReturnType<typeof transitionJob>,
  jobId: string,
  memories: readonly MemoryRecord[],
  result: ConsolidationResult,
  loaded: { readonly truncated: boolean },
): Promise<void> {
  const enrichedResult = await enrichConsolidationResult(deps, jobId, result, memories);
  finalizeTerminalJob(registry, running, jobId, memories, enrichedResult, loaded.truncated);
}

function scheduleJob(
  deps: UiHandlerDeps,
  correlationId: string,
  jobId: string,
  vault: MemoryVaultStore,
  selection: ConsolidationJobSelection,
  settings: ConsolidationJobSettings,
): void {
  const registry = deps.consolidationJobs;
  if (registry === undefined) return;
  setImmediate(() => {
    void runScheduledJob(deps, correlationId, registry, jobId, vault, selection, settings);
  });
}

function registerJobLimit(): RouteResult {
  // COUPLING-004: never forward the raw `error.message` into the 409 envelope. A code-keyed fixed
  // string carries the outcome without leaking any dynamic detail across the trust boundary.
  return {
    status: 409,
    body: errorBody("CONSOLIDATION_JOB_LIMIT", "Consolidation job limit reached."),
  };
}

function createJobResponse(deps: UiHandlerDeps, record: ConsolidationJobRecord): RouteResult {
  const body: MemoryConsolidationJobResponseWire = { job: redactJob(deps, record) };
  return { status: 202, body };
}

export async function handleCreateConsolidationJob(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  const registry = resolveJobRegistry(deps);
  if (isRouteResult(registry)) return registry;
  const body = await readJsonBody(ctx.req, ctx.correlationId);
  if (isRouteResult(body)) return body;
  const input = parseCreateInput(body);
  if (isRouteResult(input)) return input;
  const createdAt = Date.now();
  const jobId = randomUUID();
  const job = buildConsolidationJob(jobId, createdAt);
  let record: ConsolidationJobRecord;
  try {
    record = registry.register({
      job,
      createdAt,
      selection: input.selection,
      settings: input.settings,
      memoryCount: 0,
    });
  } catch {
    return registerJobLimit();
  }
  scheduleJob(
    deps,
    ctx.correlationId ?? randomUUID(),
    jobId,
    vault,
    input.selection,
    input.settings,
  );
  return createJobResponse(deps, record);
}

export function handleGetConsolidationJob(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const registry = resolveJobRegistry(deps);
  if (isRouteResult(registry)) return registry;
  const jobId = ctx.params.jobId;
  if (jobId === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Consolidation job not found.") };
  }
  const record = registry.get(jobId);
  if (record === undefined) {
    return {
      status: 404,
      body: errorBody("NOT_FOUND", "Consolidation job not found."),
    };
  }
  const body: MemoryConsolidationJobResponseWire = {
    job: redactJob(deps, record, deps.memoryVault),
  };
  return { status: 200, body };
}

export function handleCancelConsolidationJob(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const registry = resolveJobRegistry(deps);
  if (isRouteResult(registry)) return registry;
  const jobId = ctx.params.jobId;
  if (jobId === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Consolidation job not found.") };
  }
  const updated = registry.requestCancel(jobId);
  if (updated === undefined) {
    return {
      status: 404,
      body: errorBody("NOT_FOUND", "Consolidation job not found."),
    };
  }
  if (updated.job.state === "queued") {
    const canceled = transitionJob(updated.job, "canceled", { completedAt: Date.now() });
    const finalRecord = registry.complete(updated.job.id, canceled, updated.memoryCount) ?? updated;
    const body: MemoryConsolidationJobResponseWire = {
      job: redactJob(deps, finalRecord, deps.memoryVault),
    };
    return { status: 202, body };
  }
  const body: MemoryConsolidationJobResponseWire = {
    job: redactJob(deps, updated, deps.memoryVault),
  };
  return { status: 202, body };
}

function parseApplyPreconditions(
  raw: Record<string, unknown>,
): readonly MemoryConsolidationApplyPreconditionWire[] | RouteResult {
  if (
    !Array.isArray(raw.preconditions) ||
    raw.preconditions.length === 0 ||
    raw.preconditions.length > DEFAULT_MAX_RECORDS_PER_RUN
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "preconditions must be a non-empty bounded array."),
    };
  }
  const preconditions: MemoryConsolidationApplyPreconditionWire[] = [];
  const ids = new Set<string>();
  for (const value of raw.preconditions) {
    const parsed = parseApplyPrecondition(value, ids);
    if (parsed === undefined) {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "Each apply precondition must be unique and valid."),
      };
    }
    ids.add(parsed.memoryId);
    preconditions.push(parsed);
  }
  return preconditions;
}

function parseApplyPrecondition(
  value: unknown,
  ids: ReadonlySet<string>,
): MemoryConsolidationApplyPreconditionWire | undefined {
  if (!isRecord(value) || typeof value.memoryId !== "string" || value.memoryId.length === 0) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value.expectedUpdatedAt) ||
    Number(value.expectedUpdatedAt) < 0 ||
    ids.has(value.memoryId)
  ) {
    return undefined;
  }
  return {
    memoryId: value.memoryId as MemoryId,
    expectedUpdatedAt: Number(value.expectedUpdatedAt),
  };
}

function preconditionsMatchSnapshot(
  requested: readonly MemoryConsolidationApplyPreconditionWire[],
  snapshot: ConsolidationReviewSnapshot,
): boolean {
  if (requested.length !== snapshot.memories.length) return false;
  const requestedById = new Map(
    requested.map((entry) => [entry.memoryId, entry.expectedUpdatedAt]),
  );
  return snapshot.memories.every(
    (memory) => requestedById.get(memory.memoryId) === memory.updatedAt,
  );
}

function applyTargets(
  item: MemoryConsolidationReviewItemWire,
): { readonly winner: MemoryId; readonly losers: readonly MemoryId[] } | undefined {
  const action = item.proposedAction;
  if (action === undefined) return undefined;
  return action.kind === "merge"
    ? { winner: action.winner, losers: action.losers }
    : { winner: action.newer, losers: [action.older] };
}

function findApplyInputs(
  record: ConsolidationJobRecord,
  itemId: string,
):
  | {
      readonly item: MemoryConsolidationReviewItemWire;
      readonly snapshot: ConsolidationReviewSnapshot;
      readonly targets: { readonly winner: MemoryId; readonly losers: readonly MemoryId[] };
    }
  | RouteResult {
  const sourceItem = record.job.result?.reviewItems.find((item) => item.id === itemId);
  const snapshot = record.reviewSnapshots?.find((entry) => entry.itemId === itemId);
  if (record.job.state !== "completed" || sourceItem === undefined || snapshot === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Consolidation review item not found.") };
  }
  const item: MemoryConsolidationReviewItemWire = { ...sourceItem, memoryExcerpts: [] };
  const targets = applyTargets(item);
  if (
    targets === undefined ||
    item.proposedEdges === undefined ||
    item.proposedEdges.length === 0
  ) {
    return {
      status: 409,
      body: errorBody("APPLY_UNAVAILABLE", "Review item has no governed apply action."),
    };
  }
  const initialById = new Map(snapshot.memories.map((memory) => [memory.memoryId, memory.status]));
  if (targets.losers.some((id) => initialById.get(id) !== "proposed")) {
    return {
      status: 409,
      body: errorBody("ILLEGAL_INITIAL_STATE", "Apply targets were not proposed at review time."),
    };
  }
  return { item, snapshot, targets };
}

function applicationResult(
  itemId: string,
  outcome: MemoryConsolidationApplicationWire["outcome"],
  winnerMemoryId: MemoryId,
  affectedMemoryIds: readonly MemoryId[],
  appliedAt: number,
): MemoryConsolidationApplicationWire {
  return { itemId, outcome, winnerMemoryId, affectedMemoryIds, appliedAt };
}

function conflictApplication(
  vault: MemoryVaultStore,
  itemId: string,
  targets: { readonly winner: MemoryId; readonly losers: readonly MemoryId[] },
  nowMs: number,
): MemoryConsolidationApplicationWire | undefined {
  const current = targets.losers.map((id) => vault.getMemory(id));
  if (current.some((memory) => memory?.status !== "proposed")) {
    return undefined;
  }
  const records = current.filter((memory): memory is MemoryRecord => memory !== undefined);
  vault.applyGraphMutation({
    preconditions: records.map((memory) => ({
      id: memory.id,
      expectedStatus: "proposed",
      expectedUpdatedAt: memory.updatedAt,
    })),
    updates: records.map((memory) => ({
      id: memory.id,
      expectedStatus: "proposed",
      expectedUpdatedAt: memory.updatedAt,
      patch: { status: "conflicted", staleReason: "consolidation review changed before apply" },
      nowMs,
    })),
    edges: [],
  });
  return applicationResult(itemId, "conflicted", targets.winner, targets.losers, nowMs);
}

function executeApply(
  vault: MemoryVaultStore,
  itemId: string,
  inputs: Exclude<ReturnType<typeof findApplyInputs>, RouteResult>,
): MemoryConsolidationApplicationWire | RouteResult {
  const nowMs = Math.max(Date.now(), ...inputs.snapshot.memories.map((item) => item.updatedAt)) + 1;
  try {
    vault.applyGraphMutation({
      preconditions: inputs.snapshot.memories.map((memory) => ({
        id: memory.memoryId,
        expectedStatus: memory.status,
        expectedUpdatedAt: memory.updatedAt,
      })),
      updates: inputs.targets.losers.map((id) => ({
        id,
        expectedStatus: "proposed",
        patch: { status: "superseded", staleReason: "applied consolidation review" },
        nowMs,
      })),
      edges: inputs.item.proposedEdges ?? [],
    });
    return applicationResult(
      itemId,
      "applied",
      inputs.targets.winner,
      inputs.targets.losers,
      nowMs,
    );
  } catch (error) {
    if (!(error instanceof MemoryStoragePreconditionError)) throw error;
    const application = conflictApplication(vault, itemId, inputs.targets, nowMs);
    if (application !== undefined) return application;
    return {
      status: 409,
      body: errorBody("APPLY_CONFLICT", "Consolidation apply preconditions no longer hold."),
    };
  }
}

interface ResolvedApplyRoute {
  readonly vault: MemoryVaultStore;
  readonly registry: NonNullable<UiHandlerDeps["consolidationJobs"]>;
  readonly jobId: string;
  readonly itemId: string;
  readonly record: ConsolidationJobRecord;
}

function resolveApplyRoute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): ResolvedApplyRoute | RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  const registry = resolveJobRegistry(deps);
  if (isRouteResult(registry)) return registry;
  const { jobId, itemId } = ctx.params;
  if (jobId === undefined || itemId === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Consolidation review item not found.") };
  }
  const record = registry.get(jobId);
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Consolidation job not found.") };
  }
  return { vault, registry, jobId, itemId, record };
}

function applicationResponse(application: MemoryConsolidationApplicationWire): RouteResult {
  return {
    status: application.outcome === "applied" ? 200 : 409,
    body: { application },
  };
}

function previousApplication(
  record: ConsolidationJobRecord,
  itemId: string,
): RouteResult | undefined {
  const existing = record.applications?.find((entry) => entry.itemId === itemId);
  return existing === undefined ? undefined : applicationResponse(existing);
}

export async function handleApplyConsolidationReviewItem(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const route = resolveApplyRoute(ctx, deps);
  if (isRouteResult(route)) return route;
  const previous = previousApplication(route.record, route.itemId);
  if (previous !== undefined) return previous;
  const inputs = findApplyInputs(route.record, route.itemId);
  if (isRouteResult(inputs)) return inputs;
  const body = await readJsonBody(ctx.req, ctx.correlationId);
  if (isRouteResult(body)) return body;
  const latest = route.registry.get(route.jobId);
  const concurrent = latest === undefined ? undefined : previousApplication(latest, route.itemId);
  if (concurrent !== undefined) return concurrent;
  const requested = parseApplyPreconditions(body);
  if (isRouteResult(requested)) return requested;
  if (!preconditionsMatchSnapshot(requested, inputs.snapshot)) {
    return {
      status: 409,
      body: errorBody("PRECONDITION_MISMATCH", "Review preconditions do not match the job."),
    };
  }
  const application = executeApply(route.vault, route.itemId, inputs);
  if (isRouteResult(application)) return application;
  route.registry.recordApplication(route.jobId, application);
  return applicationResponse(application);
}
