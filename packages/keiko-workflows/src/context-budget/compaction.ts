// Pure, deterministic, no-IO compaction builder (ADR-0053 D4/D7). Consumes the allocator's
// excludedItemIds and emits one ContextCompactionRecord per evicted lane. No clock, no randomness:
// orderedAt is caller-injected, every hash is deterministic over the same bytes, so running the
// builder twice on the same input yields a deeply-equal result. Secret scrubbing uses redact()
// from keiko-security (NOT keiko-memory-capture — that would add a forbidden package-graph edge).

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  validateContextCompactionRecord,
  type ContextCompactionRecord,
  type ContextInvalidationKey,
  type ContextLaneId,
  type ContextProvenanceRef,
  type ContextRehydrationHandle,
} from "@oscharko-dev/keiko-contracts";

import type { AllocateContextResult, AllocatedContextLane, ContextLaneInput } from "./allocator.js";
import {
  buildInvalidationKeys,
  buildRehydrationHandle,
  buildSourceSpans,
  itemsByIds,
  laneItems,
  projectDigest,
  summaryHashOf,
  tokensForItems,
  type CompactionDigest,
  type DigestProjection,
} from "./compaction-helpers.js";

export type { CompactionDigest } from "./compaction-helpers.js";

export interface BuildCompactionInput {
  readonly result: AllocateContextResult;
  readonly lanes: readonly ContextLaneInput[];
  readonly provenance: ReadonlyMap<string, ContextProvenanceRef>;
  readonly orderedAt: number;
  readonly fileHashes?: ReadonlyMap<string, string> | undefined;
  readonly digest?: CompactionDigest | undefined;
}

const HISTORY_SUMMARY_LANE: ContextLaneId = "history-summary";

interface RecordCore {
  readonly laneId: ContextLaneId;
  readonly reason: string;
  readonly itemsBefore: number;
  readonly itemsAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summaryRefHash: string;
  readonly orderedAt: number;
  readonly sourceSpans: readonly ContextProvenanceRef[];
  readonly invalidationKeys: readonly ContextInvalidationKey[];
  readonly rehydration: ContextRehydrationHandle;
}

function reasonFor(lane: AllocatedContextLane): string {
  return lane.diagnostics.compactionReason ?? "budget";
}

function buildCore(
  input: BuildCompactionInput,
  lane: AllocatedContextLane,
  index: number,
): RecordCore {
  const allItems = laneItems(input.lanes, lane.laneId);
  const included = itemsByIds(allItems, lane.includedItemIds);
  const excluded = itemsByIds(allItems, lane.excludedItemIds);
  const spans = buildSourceSpans(excluded, input.provenance);
  const tokensBefore = tokensForItems(allItems);
  const tokensAfter = tokensForItems(included);
  return {
    laneId: lane.laneId,
    reason: reasonFor(lane),
    itemsBefore: allItems.length,
    itemsAfter: included.length,
    tokensBefore,
    tokensAfter,
    summaryRefHash: summaryHashOf(excluded),
    orderedAt: input.orderedAt + index,
    sourceSpans: spans,
    invalidationKeys: buildInvalidationKeys(spans, input.fileHashes),
    rehydration: buildRehydrationHandle({
      laneId: lane.laneId,
      excludedIds: lane.excludedItemIds,
      spans,
      approxTokens: tokensBefore - tokensAfter,
    }),
  };
}

function withDigest(
  record: ContextCompactionRecord,
  projection: DigestProjection,
): ContextCompactionRecord {
  return { ...record, ...projection };
}

function assembleRecord(core: RecordCore): ContextCompactionRecord {
  const record: ContextCompactionRecord = {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: core.laneId,
    reason: core.reason,
    itemsBefore: core.itemsBefore,
    itemsAfter: core.itemsAfter,
    tokensBefore: core.tokensBefore,
    tokensAfter: core.tokensAfter,
    summaryRefHash: core.summaryRefHash,
    rehydration: core.rehydration,
    orderedAt: core.orderedAt,
    sourceSpans: core.sourceSpans,
    ...(core.invalidationKeys.length > 0 ? { invalidationKeys: core.invalidationKeys } : {}),
  };
  return record;
}

function digestOnlyRecord(
  input: BuildCompactionInput,
  projection: DigestProjection,
): ContextCompactionRecord {
  const record: ContextCompactionRecord = {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: HISTORY_SUMMARY_LANE,
    reason: "summarize-then-drop",
    itemsBefore: 0,
    itemsAfter: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    orderedAt: input.orderedAt,
    ...projection,
  };
  return record;
}

function evictedLanes(result: AllocateContextResult): readonly AllocatedContextLane[] {
  return result.lanes.filter((lane) => lane.excludedItemIds.length > 0);
}

function assertValid(record: ContextCompactionRecord): ContextCompactionRecord {
  const validation = validateContextCompactionRecord(record);
  if (!validation.ok) {
    throw new Error(
      `buildCompactionRecords produced an invalid record: ${validation.reasons.join(", ")}`,
    );
  }
  return record;
}

// Builds one ContextCompactionRecord per evicted lane (in allocator order). The optional digest is
// attached to the FIRST emitted record; if no lane evicted but a digest is supplied, a single
// digest-only history-summary record is emitted instead. Throws if any produced record fails
// validation (a builder bug). Pure and idempotent.
export function buildCompactionRecords(
  input: BuildCompactionInput,
): readonly ContextCompactionRecord[] {
  const lanes = evictedLanes(input.result);
  const projection = input.digest === undefined ? undefined : projectDigest(input.digest);
  if (lanes.length === 0) {
    return projection === undefined ? [] : [assertValid(digestOnlyRecord(input, projection))];
  }
  return lanes.map((lane, index) => {
    const base = assembleRecord(buildCore(input, lane, index));
    const enriched = index === 0 && projection !== undefined ? withDigest(base, projection) : base;
    return assertValid(enriched);
  });
}
