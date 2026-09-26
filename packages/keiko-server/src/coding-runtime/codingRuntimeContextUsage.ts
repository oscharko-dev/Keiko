import type { CodingWorkbenchContextUsage } from "@oscharko-dev/keiko-contracts";

const MAX_RETAINED_RUNS = 16;
const MAX_RETAINED_SAMPLE_IDS = 2_048;
const MAX_OPAQUE_ID_BYTES = 512;
const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface CodingRuntimeProviderUsageSample {
  readonly sampleId: string;
  readonly capacityTokens: number;
  readonly reservedOutputTokens: number;
  readonly inputTokens: number;
  readonly updatedAt: string;
}

interface RunUsage {
  readonly sampleIds: Set<string>;
  cumulativePromptTokens: number;
  latest: CodingWorkbenchContextUsage | undefined;
  compactionCount: number;
  lastCompactedAt: string | undefined;
}

export interface CodingRuntimeContextUsageRegistry {
  readonly read: (runId: string) => CodingWorkbenchContextUsage | undefined;
  readonly recordProviderSample: (
    runId: string,
    sample: CodingRuntimeProviderUsageSample,
  ) => boolean;
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

export function createCodingRuntimeContextUsageRegistry(): CodingRuntimeContextUsageRegistry {
  const records = new Map<string, RunUsage>();
  return {
    read: (runId): CodingWorkbenchContextUsage | undefined => records.get(runId)?.latest,
    recordProviderSample: (runId, sample): boolean => {
      if (!validSample(sample)) return false;
      const record = runUsage(records, runId);
      const cumulativePromptTokens = record.cumulativePromptTokens + sample.inputTokens;
      if (!Number.isSafeInteger(cumulativePromptTokens)) return false;
      if (!rememberSample(record, sample.sampleId)) return false;
      record.cumulativePromptTokens = cumulativePromptTokens;
      record.latest = contextUsage(record, sample);
      return true;
    },
    recordCompaction: (runId, compactionId, updatedAt): boolean => {
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
    },
  };
}
