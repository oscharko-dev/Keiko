import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  buildConsolidationJob,
  runConsolidation,
  transitionJob,
  type ConsolidationResult,
} from "@oscharko-dev/keiko-memory-consolidation";
import {
  MEMORY_SCOPE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type MemoryEdgeId,
  type MemoryRecord,
  type MemoryScope,
  type MemoryScopeKind,
  type MemoryStatus,
  type MemoryType,
} from "@oscharko-dev/keiko-contracts";
import type {
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type {
  ConsolidationJobRecord,
  ConsolidationJobSelection,
  ConsolidationJobSettings,
} from "./memory-consolidation-registry.js";

const MAX_BODY_BYTES = 64_000;
const DEFAULT_JACCARD_THRESHOLD = 0.85;
const DEFAULT_STALE_CONFIDENCE_THRESHOLD = 0.3;
const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CLUSTERS_PER_RUN = 100;
const DEFAULT_MAX_RECORDS_PER_RUN = 1_000;
const MAX_CLUSTERS_PER_RUN_LIMIT = 1_000;
const MAX_RECORDS_PER_RUN_LIMIT = 1_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number";
}

function readBody(req: IncomingMessage): Promise<string> {
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body too large.") };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
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
  if (typeof raw.includeExpired !== "undefined" && typeof raw.includeExpired !== "boolean") {
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
  const statuses = selection.statuses?.filter((status) => status === "accepted") ?? ["accepted"];
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
      orderDir: "asc",
    });
    for (const record of records) {
      seen.set(record.id, record);
      if (seen.size >= detectionLimit) break;
    }
  }
  const sorted = [...seen.values()]
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
      return a.id.localeCompare(b.id);
    })
    .slice(0, maxRecords);
  return {
    records: sorted,
    truncated: seen.size > maxRecords,
  };
}

function redactJob(deps: UiHandlerDeps, record: ConsolidationJobRecord): unknown {
  return deps.redactor({
    id: record.job.id,
    state: record.job.state,
    startedAt: record.job.startedAt,
    completedAt: record.job.completedAt,
    result: record.job.result,
    error: record.job.error,
    createdAt: record.createdAt,
    selection: record.selection,
    settings: record.settings,
    memoryCount: record.memoryCount,
    cancelRequested: record.cancelRequested,
  });
}

function newMemoryEdgeId(): MemoryEdgeId {
  return randomUUID() as unknown as MemoryEdgeId;
}

function buildRunOptions(
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  jobId: string,
  createdAt: number,
  settings: ConsolidationJobSettings,
): Parameters<typeof runConsolidation>[1] {
  return {
    nowMs: createdAt,
    newEdgeId: newMemoryEdgeId,
    newReviewItemId: (): string => randomUUID(),
    jaccardThreshold: settings.jaccardThreshold,
    staleConfidenceThreshold: settings.staleConfidenceThreshold,
    maxAgeMs: settings.maxAgeMs,
    maxClustersPerRun: settings.maxClustersPerRun,
    maxRecordsPerRun: settings.maxRecordsPerRun,
    cancellationSignal: (): boolean => registry.get(jobId)?.cancelRequested === true,
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
    registry.complete(
      jobId,
      transitionJob(running, "completed", { completedAt, result: finalResult }),
      memories.length,
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

function failScheduledJob(
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  running: ReturnType<typeof transitionJob>,
  jobId: string,
  memories: readonly MemoryRecord[],
  error: unknown,
): void {
  const completedAt = Date.now();
  const message = error instanceof Error ? error.message : "Consolidation run failed unexpectedly.";
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
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    recordsInspected: 0,
    truncated: false,
    elapsedMs: 0,
  };
}

function scheduleJob(
  deps: UiHandlerDeps,
  jobId: string,
  vault: MemoryVaultStore,
  selection: ConsolidationJobSelection,
  settings: ConsolidationJobSettings,
): void {
  const registry = deps.consolidationJobs;
  if (registry === undefined) return;
  setImmediate(() => {
    const queued = registry.get(jobId);
    if (queued?.job.state !== "queued") return;
    if (queued.cancelRequested) {
      const canceled = transitionJob(queued.job, "canceled", { completedAt: Date.now() });
      registry.complete(jobId, canceled, 0);
      return;
    }
    const loaded = loadSelectedMemories(vault, selection, settings.maxRecordsPerRun);
    const memories = loaded.records;
    const afterLoad = registry.get(jobId);
    if (afterLoad?.job.state !== "queued") return;
    if (afterLoad.cancelRequested) {
      const canceled = transitionJob(afterLoad.job, "canceled", { completedAt: Date.now() });
      registry.complete(jobId, canceled, memories.length);
      return;
    }
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
    try {
      const result = runConsolidation(
        memories,
        buildRunOptions(registry, jobId, queued.createdAt, settings),
      );
      finalizeTerminalJob(registry, running, jobId, memories, result, loaded.truncated);
    } catch (error) {
      failScheduledJob(registry, running, jobId, memories, error);
    }
  });
}

function registerJobLimit(error: unknown): RouteResult {
  return {
    status: 409,
    body: errorBody(
      "CONSOLIDATION_JOB_LIMIT",
      error instanceof Error ? error.message : "Consolidation job limit reached.",
    ),
  };
}

function createJobResponse(deps: UiHandlerDeps, record: ConsolidationJobRecord): RouteResult {
  return { status: 202, body: { job: redactJob(deps, record) } };
}

export async function handleCreateConsolidationJob(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  const registry = resolveJobRegistry(deps);
  if (isRouteResult(registry)) return registry;
  const body = await readJsonBody(ctx.req);
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
  } catch (error) {
    return registerJobLimit(error);
  }
  scheduleJob(deps, jobId, vault, input.selection, input.settings);
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
  return { status: 200, body: { job: redactJob(deps, record) } };
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
    return { status: 202, body: { job: redactJob(deps, finalRecord) } };
  }
  return { status: 202, body: { job: redactJob(deps, updated) } };
}
