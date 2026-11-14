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

/** The conversation a sample has no identity for. */
const UNATTRIBUTED_CONVERSATION: CodingRuntimeConversation = {
  agentKey: "runtime",
  headKey: "runtime",
  toolBearing: true,
};
const MAX_SESSIONS_PER_RUN = 8;
/**
 * A conversation that has seen no request while the run served this many further requests of
 * other conversations has ended: its last prompt size no longer describes the run's pressure.
 */
const LIVE_REQUEST_WINDOW = 16;

/**
 * Which conversation of a run a call belongs to, from what the model gateway sees of the request.
 * The rule: only requests that offer tools count (the runtime's title and summary requests do
 * not); a conversation is its agent (the digest of its system prompt) plus its head (that digest
 * with the first user message); a new head of the same agent supersedes the old one (a
 * compaction or history rewrite continues the conversation under a new head); the primary is the
 * first agent that offered tools; a conversation unheard of for {@link LIVE_REQUEST_WINDOW}
 * further requests has ended.
 */
export interface CodingRuntimeConversation {
  readonly agentKey: string;
  readonly headKey: string;
  readonly toolBearing: boolean;
}

interface SessionSample {
  readonly sample: CodingRuntimeProviderUsageSample;
  readonly agentKey: string;
  /** The run's request counter when this conversation was last heard from. */
  readonly seq: number;
}

interface RunUsage {
  readonly sampleIds: Set<string>;
  /** The latest provider sample of each live conversation of the run, by head. */
  readonly sessions: Map<string, SessionSample>;
  /** The agent of the first request that offered tools: the run's own conversation. */
  primaryAgent: string | undefined;
  /** Requests that offered tools so far: the clock a conversation's liveness is read against. */
  requestSeq: number;
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
    conversation?: CodingRuntimeConversation,
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
    conversation: CodingRuntimeConversation,
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
    primaryAgent: undefined,
    requestSeq: 0,
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

/** The held conversation with the most input tokens: the one a describe must size against. */
function fullestHead(record: RunUsage): string | undefined {
  let fullest: [string, number] | undefined;
  for (const [head, held] of record.sessions)
    if (fullest === undefined || held.sample.inputTokens > fullest[1])
      fullest = [head, held.sample.inputTokens];
  return fullest?.[0];
}

/** The oldest idle conversation that is neither the fullest nor the primary's, if any. */
function evictable(record: RunUsage): string | undefined {
  const fullest = fullestHead(record);
  const candidates = [...record.sessions].filter(
    ([head, held]) => head !== fullest && held.agentKey !== record.primaryAgent,
  );
  return candidates.sort((a, b) => a[1].seq - b[1].seq)[0]?.[0];
}

function rememberSession(
  record: RunUsage,
  conversation: CodingRuntimeConversation,
  sample: CodingRuntimeProviderUsageSample,
): void {
  record.primaryAgent ??= conversation.agentKey;
  record.requestSeq += 1;
  // A new head of the same agent continues that conversation: the old head is superseded.
  for (const [head, held] of record.sessions)
    if (held.agentKey === conversation.agentKey && head !== conversation.headKey)
      record.sessions.delete(head);
  record.sessions.set(conversation.headKey, {
    sample,
    agentKey: conversation.agentKey,
    seq: record.requestSeq,
  });
  while (record.sessions.size > MAX_SESSIONS_PER_RUN) {
    const victim = evictable(record);
    if (victim === undefined) break;
    record.sessions.delete(victim);
  }
}

function recordSample(
  state: UsageState,
  runId: string,
  sample: CodingRuntimeProviderUsageSample,
  conversation: CodingRuntimeConversation,
): boolean {
  if (!validSample(sample)) return false;
  const record = runUsage(state.records, runId);
  const cumulativePromptTokens = record.cumulativePromptTokens + sample.inputTokens;
  if (!Number.isSafeInteger(cumulativePromptTokens)) return false;
  if (!rememberSample(record, sample.sampleId)) return false;
  record.cumulativePromptTokens = cumulativePromptTokens;
  if (!conversation.toolBearing) {
    if (record.latest?.state === "available")
      record.latest = { ...record.latest, cumulativePromptTokens };
    return true;
  }
  rememberSession(record, conversation, sample);
  if (conversation.agentKey === record.primaryAgent) record.latest = contextUsage(record, sample);
  return true;
}

function readLargest(state: UsageState, runId: string): CodingWorkbenchContextUsage | undefined {
  const record = state.records.get(runId);
  if (record === undefined) return undefined;
  let fullest: CodingRuntimeProviderUsageSample | undefined;
  for (const held of record.sessions.values()) {
    if (held.seq <= record.requestSeq - LIVE_REQUEST_WINDOW && held.seq !== record.requestSeq)
      continue;
    if (fullest === undefined || held.sample.inputTokens > fullest.inputTokens)
      fullest = held.sample;
  }
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
      conversation,
      sampleId,
      inputTokens,
      updatedAt,
    ): CodingRuntimeGatewaySampleOutcome | undefined => {
      const geometry = state.geometries.get(runId);
      if (geometry === undefined) return undefined;
      const sample = { sampleId, ...geometry, inputTokens, updatedAt };
      return { accepted: recordSample(state, runId, sample, conversation), ...geometry };
    },
    read: (runId): CodingWorkbenchContextUsage | undefined => state.records.get(runId)?.latest,
    readLargest: (runId): CodingWorkbenchContextUsage | undefined => readLargest(state, runId),
    recordProviderSample: (runId, sample, conversation = UNATTRIBUTED_CONVERSATION): boolean =>
      recordSample(state, runId, sample, conversation),
    recordCompaction: (runId, compactionId, updatedAt): boolean =>
      recordCompactionOf(state.records, runId, compactionId, updatedAt),
  };
}
