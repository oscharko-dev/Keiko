import type { CodingWorkbenchContextUsage } from "@oscharko-dev/keiko-contracts";

const MAX_RETAINED_RUNS = 16;
const MAX_RETAINED_SAMPLE_IDS = 2_048;
const MAX_OPAQUE_ID_BYTES = 512;
const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface CodingRuntimeUsageGeometry {
  readonly capacityTokens: number;
  readonly reservedOutputTokens: number;
}

export interface CodingRuntimeProviderUsageSample {
  readonly sampleId: string;
  readonly capacityTokens: number;
  readonly reservedOutputTokens: number;
  readonly inputTokens: number;
  readonly updatedAt: string;
}

/** The session a sample has no identity for: the runtime's own report (kept for that reader). */
const UNATTRIBUTED_SESSION = "runtime";
const MAX_SESSIONS_PER_RUN = 8;

interface RunUsage {
  readonly sampleIds: Set<string>;
  /** The latest provider sample of each conversation of the run, the primary one first. */
  readonly sessions: Map<string, CodingRuntimeProviderUsageSample>;
  /** The conversation the run was started with: the first one the registry heard from. */
  primaryKey: string | undefined;
  cumulativePromptTokens: number;
  latest: CodingWorkbenchContextUsage | undefined;
  compactionCount: number;
  lastCompactedAt: string | undefined;
}

/** What the registry made of a prompt size the gateway reported. */
export interface CodingRuntimeGatewaySampleOutcome {
  readonly accepted: boolean;
  readonly capacityTokens: number;
  readonly reservedOutputTokens: number;
}

export interface CodingRuntimeContextUsageRegistry {
  /** The context of the run's primary conversation: what the Workbench snapshot shows. */
  readonly read: (runId: string) => CodingWorkbenchContextUsage | undefined;
  /**
   * The fullest context among the run's conversations. A caller that cannot say which conversation
   * asks (the Jira relay sees only the run) must not size against a subagent's small prompt.
   */
  readonly readLargest: (runId: string) => CodingWorkbenchContextUsage | undefined;
  readonly recordProviderSample: (
    runId: string,
    sample: CodingRuntimeProviderUsageSample,
    sessionKey?: string,
  ) => boolean;
  /** The context window and output reserve the run's model was admitted with (set once at start). */
  readonly bindGeometry: (runId: string, geometry: CodingRuntimeUsageGeometry) => void;
  /**
   * A prompt size the provider reported to Keiko's own model gateway for this run (#4359). Every
   * native run reaches its model through that gateway, so this is the usage source that does not
   * depend on which events the pinned runtime emits. The conversation key (a digest of the
   * conversation's head) attributes the sample to the session that made the call, so a subagent's
   * prompt is never read as the primary conversation's context. Undefined when the run has no
   * bound geometry.
   */
  readonly recordGatewayPrompt: (
    runId: string,
    conversationKey: string,
    sampleId: string,
    inputTokens: number,
    updatedAt: string,
  ) => CodingRuntimeGatewaySampleOutcome | undefined;
  readonly recordCompaction: (runId: string, compactionId: string, updatedAt: string) => boolean;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_OPAQUE_ID_BYTES;
}

function validSample(sample: CodingRuntimeProviderUsageSample): boolean {
  return (
    validOpaqueId(sample.sampleId) &&
    validCount(sample.capacityTokens) &&
    sample.capacityTokens > 0 &&
    validCount(sample.reservedOutputTokens) &&
    validCount(sample.inputTokens) &&
    sample.reservedOutputTokens + sample.inputTokens <= sample.capacityTokens &&
    STRICT_UTC_INSTANT.test(sample.updatedAt)
  );
}

function runUsage(records: Map<string, RunUsage>, runId: string): RunUsage {
  const existing = records.get(runId);
  if (existing !== undefined) return existing;
  const created: RunUsage = {
    sampleIds: new Set(),
    sessions: new Map(),
    primaryKey: undefined,
    cumulativePromptTokens: 0,
    latest: undefined,
    compactionCount: 0,
    lastCompactedAt: undefined,
  };
  records.set(runId, created);
  while (records.size > MAX_RETAINED_RUNS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
  return created;
}

function rememberSample(record: RunUsage, sampleId: string): boolean {
  if (record.sampleIds.has(sampleId)) return false;
  record.sampleIds.add(sampleId);
  while (record.sampleIds.size > MAX_RETAINED_SAMPLE_IDS) {
    const oldest = record.sampleIds.values().next().value;
    if (oldest === undefined) break;
    record.sampleIds.delete(oldest);
  }
  return true;
}

function contextUsage(
  record: RunUsage,
  sample: CodingRuntimeProviderUsageSample,
): CodingWorkbenchContextUsage {
  const freeTokens = sample.capacityTokens - sample.inputTokens - sample.reservedOutputTokens;
  return {
    state: "available",
    source: "provider-reported",
    capacityTokens: sample.capacityTokens,
    usedInputTokens: sample.inputTokens,
    reservedOutputTokens: sample.reservedOutputTokens,
    freeTokens,
    cumulativePromptTokens: record.cumulativePromptTokens,
    ...(record.compactionCount === 0
      ? {}
      : {
          compaction: {
            count: record.compactionCount,
            ...(record.lastCompactedAt === undefined
              ? {}
              : { lastCompactedAt: record.lastCompactedAt }),
          },
        }),
    updatedAt: sample.updatedAt,
  };
}

interface UsageState {
  readonly records: Map<string, RunUsage>;
  readonly geometries: Map<string, CodingRuntimeUsageGeometry>;
}

function rememberSession(
  record: RunUsage,
  key: string,
  sample: CodingRuntimeProviderUsageSample,
): void {
  record.primaryKey ??= key;
  record.sessions.set(key, sample);
  while (record.sessions.size > MAX_SESSIONS_PER_RUN) {
    const evictable = [...record.sessions.keys()].find(
      (candidate) => candidate !== record.primaryKey,
    );
    if (evictable === undefined) break;
    record.sessions.delete(evictable);
  }
}

function recordSample(
  state: UsageState,
  runId: string,
  sample: CodingRuntimeProviderUsageSample,
  sessionKey: string,
): boolean {
  if (!validSample(sample)) return false;
  const record = runUsage(state.records, runId);
  const cumulativePromptTokens = record.cumulativePromptTokens + sample.inputTokens;
  if (!Number.isSafeInteger(cumulativePromptTokens)) return false;
  if (!rememberSample(record, sample.sampleId)) return false;
  record.cumulativePromptTokens = cumulativePromptTokens;
  rememberSession(record, sessionKey, sample);
  if (sessionKey === record.primaryKey) record.latest = contextUsage(record, sample);
  return true;
}

function readLargest(state: UsageState, runId: string): CodingWorkbenchContextUsage | undefined {
  const record = state.records.get(runId);
  if (record === undefined) return undefined;
  let fullest: CodingRuntimeProviderUsageSample | undefined;
  for (const sample of record.sessions.values())
    if (fullest === undefined || sample.inputTokens > fullest.inputTokens) fullest = sample;
  return fullest === undefined ? undefined : contextUsage(record, fullest);
}

function recordCompactionOf(
  records: Map<string, RunUsage>,
  runId: string,
  compactionId: string,
  updatedAt: string,
): boolean {
  if (!validOpaqueId(compactionId) || !STRICT_UTC_INSTANT.test(updatedAt)) return false;
  const record = runUsage(records, runId);
  if (!rememberSample(record, `compaction:${compactionId}`)) return false;
  record.compactionCount += 1;
  record.lastCompactedAt = updatedAt;
  if (record.latest?.state === "available") {
    record.latest = {
      ...record.latest,
      compaction: { count: record.compactionCount, lastCompactedAt: updatedAt },
      updatedAt,
    };
  }
  return true;
}

function bindGeometryOf(
  geometries: Map<string, CodingRuntimeUsageGeometry>,
  runId: string,
  geometry: CodingRuntimeUsageGeometry,
): void {
  geometries.set(runId, geometry);
  while (geometries.size > MAX_RETAINED_RUNS) {
    const oldest = geometries.keys().next().value;
    if (oldest === undefined) break;
    geometries.delete(oldest);
  }
}

export function createCodingRuntimeContextUsageRegistry(): CodingRuntimeContextUsageRegistry {
  const state: UsageState = { records: new Map(), geometries: new Map() };
  return {
    bindGeometry: (runId, geometry): void => {
      bindGeometryOf(state.geometries, runId, geometry);
    },
    recordGatewayPrompt: (
      runId,
      conversationKey,
      sampleId,
      inputTokens,
      updatedAt,
    ): CodingRuntimeGatewaySampleOutcome | undefined => {
      const geometry = state.geometries.get(runId);
      if (geometry === undefined) return undefined;
      const sample = { sampleId, ...geometry, inputTokens, updatedAt };
      return { accepted: recordSample(state, runId, sample, conversationKey), ...geometry };
    },
    read: (runId): CodingWorkbenchContextUsage | undefined => state.records.get(runId)?.latest,
    readLargest: (runId): CodingWorkbenchContextUsage | undefined => readLargest(state, runId),
    recordProviderSample: (runId, sample, sessionKey = UNATTRIBUTED_SESSION): boolean =>
      recordSample(state, runId, sample, sessionKey),
    recordCompaction: (runId, compactionId, updatedAt): boolean =>
      recordCompactionOf(state.records, runId, compactionId, updatedAt),
  };
}
