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
  return parseScopeWithId(
    raw,
    "workflowDefinitionId",
    (workflowDefinitionId) => ({
      kind: "workflow",
      workflowDefinitionId: workflowDefinitionId as WorkflowDefinitionId,
    }),
  );
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

function resolveSetting(
  raw: Record<string, unknown>,
  key: keyof ConsolidationJobSettings,
  fallback: number,
): number | null {
  const value = parseOptionalNumber(raw[key]);
  return value === null ? null : (value ?? fallback);
}

function parseSettings(raw: unknown): ConsolidationJobSettings | null {
  const record = parseSettingsRecord(raw);
  if (record === null) return null;
  const jaccardThreshold = resolveSetting(
    record,
    "jaccardThreshold",
    DEFAULT_JACCARD_THRESHOLD,
  );
  const staleConfidenceThreshold = resolveSetting(
    record,
    "staleConfidenceThreshold",
    DEFAULT_STALE_CONFIDENCE_THRESHOLD,
  );
  const maxAgeMs = resolveSetting(record, "maxAgeMs", DEFAULT_MAX_AGE_MS);
  const maxClustersPerRun = resolveSetting(
    record,
    "maxClustersPerRun",
    DEFAULT_MAX_CLUSTERS_PER_RUN,
  );
  if (jaccardThreshold === null || staleConfidenceThreshold === null) return null;
  if (maxAgeMs === null || maxClustersPerRun === null) return null;
  return {
    jaccardThreshold,
    staleConfidenceThreshold,
    maxAgeMs,
    maxClustersPerRun,
  };
}

interface CreateJobInput {
  readonly selection: ConsolidationJobSelection;
  readonly settings: ConsolidationJobSettings;
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
  if (settings === null) {
    return badRequest(
      "settings must be an object containing optional numeric consolidation settings.",
    );
  }
  return { selection, settings };
}

function loadSelectedMemories(
  vault: MemoryVaultStore,
  selection: ConsolidationJobSelection,
): readonly MemoryRecord[] {
  const seen = new Map<string, MemoryRecord>();
  for (const scope of selection.scopes) {
    const records = vault.listMemoriesByScope(scope, {
      ...(selection.types !== undefined ? { type: selection.types } : {}),
      ...(selection.statuses !== undefined ? { status: selection.statuses } : {}),
      includeExpired: selection.includeExpired,
    });
    for (const record of records) {
      seen.set(record.id, record);
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.id.localeCompare(b.id);
  });
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
    cancellationSignal: (): boolean => registry.get(jobId)?.cancelRequested === true,
  };
}

function finalizeTerminalJob(
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  running: ReturnType<typeof transitionJob>,
  jobId: string,
  memories: readonly MemoryRecord[],
  result: ConsolidationResult,
): void {
  const completedAt = Date.now();
  if (result.state === "completed") {
    registry.complete(
      jobId,
      transitionJob(running, "completed", { completedAt, result }),
      memories.length,
    );
    return;
  }
  if (result.state === "canceled") {
    registry.complete(
      jobId,
      transitionJob(running, "canceled", { completedAt, result }),
      memories.length,
    );
    return;
  }
  const message = "Consolidation run failed.";
  registry.fail(
    jobId,
    transitionJob(running, "failed", { completedAt, result, error: message }),
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
  const message =
    error instanceof Error ? error.message : "Consolidation run failed unexpectedly.";
  registry.fail(
    jobId,
    transitionJob(running, "failed", { completedAt, error: message }),
    message,
    memories.length,
  );
}

function scheduleJob(
  deps: UiHandlerDeps,
  jobId: string,
  memories: readonly MemoryRecord[],
  settings: ConsolidationJobSettings,
): void {
  const registry = deps.consolidationJobs;
  if (registry === undefined) return;
  setImmediate(() => {
    const queued = registry.get(jobId);
    if (queued?.job.state !== "queued") return;
    if (queued.cancelRequested) {
      const canceled = transitionJob(queued.job, "canceled", { completedAt: Date.now() });
      registry.complete(jobId, canceled, memories.length);
      return;
    }
    const running = transitionJob(queued.job, "running");
    registry.setRunning(jobId, running);
    try {
      const result = runConsolidation(
        memories,
        buildRunOptions(registry, jobId, queued.createdAt, settings),
      );
      finalizeTerminalJob(registry, running, jobId, memories, result);
    } catch (error) {
      failScheduledJob(registry, running, jobId, memories, error);
    }
  });
}

function skippedJob(
  jobId: string,
  createdAt: number,
  selection: ConsolidationJobSelection,
  settings: ConsolidationJobSettings,
  memoryCount: number,
): ConsolidationJobRecord {
  const base = buildConsolidationJob(jobId, createdAt);
  const result: ConsolidationResult = {
    state: "skipped",
    edgesProposed: [],
    updatesProposed: [],
    staleFlags: [],
    reviewItems: [],
    clustersInspected: 0,
    elapsedMs: 0,
  };
  return {
    job: transitionJob(base, "skipped", { completedAt: createdAt, result }),
    createdAt,
    selection,
    settings,
    memoryCount,
    cancelRequested: false,
  };
}

function registerRecord(
  registry: NonNullable<UiHandlerDeps["consolidationJobs"]>,
  record: ConsolidationJobRecord,
): ConsolidationJobRecord {
  return registry.register({
    job: record.job,
    createdAt: record.createdAt,
    selection: record.selection,
    settings: record.settings,
    memoryCount: record.memoryCount,
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
  const memories = loadSelectedMemories(vault, input.selection);
  const jobId = randomUUID();
  if (memories.length === 0 || input.settings.maxClustersPerRun === 0) {
    const record = skippedJob(jobId, createdAt, input.selection, input.settings, memories.length);
    try {
      registerRecord(registry, record);
    } catch (error) {
      return registerJobLimit(error);
    }
    return createJobResponse(deps, record);
  }
  const job = buildConsolidationJob(jobId, createdAt);
  let record: ConsolidationJobRecord;
  try {
    record = registry.register({
      job,
      createdAt,
      selection: input.selection,
      settings: input.settings,
      memoryCount: memories.length,
    });
  } catch (error) {
    return registerJobLimit(error);
  }
  scheduleJob(deps, jobId, memories, input.settings);
  return createJobResponse(deps, record);
}

export function handleGetConsolidationJob(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
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

export function handleCancelConsolidationJob(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
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
