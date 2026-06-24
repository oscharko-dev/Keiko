// Pure, deterministic, no-IO lane budget allocator (ADR-0052 D3/D6). Mirrors the immutable
// state pattern of planner/governor.ts: never mutates inputs, returns fresh objects, no clock,
// no randomness, no network. estimateTokens from keiko-contracts is the SINGLE token currency
// (ADR-0052 gate 3) — no other ratio appears in this module.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  CONTEXT_LANE_IDS,
  estimateTokens,
  type ContextAssemblyDiagnostics,
  type ContextBudget,
  type ContextBudgetPressure,
  type ContextLaneBudget,
  type ContextLaneDiagnostics,
  type ContextLaneId,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";

export interface ContextLaneItemInput {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

export interface ContextLaneInput {
  readonly laneId: ContextLaneId;
  readonly items: readonly ContextLaneItemInput[];
}

export interface AllocateContextInput {
  readonly profile: ContextProfile;
  readonly budget: ContextBudget;
  readonly lanes: readonly ContextLaneInput[];
}

export interface AllocatedContextLane {
  readonly laneId: ContextLaneId;
  readonly includedItemIds: readonly string[];
  readonly excludedItemIds: readonly string[];
  readonly estimatedTokens: number;
  readonly diagnostics: ContextLaneDiagnostics;
}

export interface AllocateContextResult {
  readonly lanes: readonly AllocatedContextLane[];
  readonly diagnostics: ContextAssemblyDiagnostics;
  readonly totalEstimatedTokens: number;
}

interface LaneFill {
  readonly includedIds: readonly string[];
  readonly excludedIds: readonly string[];
  readonly tokens: number;
  readonly droppedForBudget: boolean;
}

const CANONICAL_INDEX: ReadonlyMap<ContextLaneId, number> = new Map(
  CONTEXT_LANE_IDS.map((id, index) => [id, index]),
);

function canonicalIndex(laneId: ContextLaneId): number {
  return CANONICAL_INDEX.get(laneId) ?? CONTEXT_LANE_IDS.length;
}

// Deterministic score-greedy fill by TOKEN budget. Mirrors the proven ordering of
// selectScoredTextByByteBudget (packages/keiko-workspace/src/contextPack.ts:53): score DESC,
// then id ASC (localeCompare) for stable ties, greedy-fill until the cap is reached. Byte-reuse
// was rejected here because that primitive measures utf8 BYTES, which would corrupt the single
// token currency the allocator must use (estimateTokens) for every lane.
function selectScoredByTokenBudget(
  items: readonly ContextLaneItemInput[],
  tokenBudget: number,
): LaneFill {
  const ordered = [...items].sort((a, b) => {
    const byScore = b.score - a.score;
    return byScore !== 0 ? byScore : a.id.localeCompare(b.id);
  });
  const includedIds: string[] = [];
  const excludedIds: string[] = [];
  let tokens = 0;
  for (const item of ordered) {
    const cost = estimateTokens(item.text);
    if (tokens + cost > tokenBudget) {
      excludedIds.push(item.id);
      continue;
    }
    includedIds.push(item.id);
    tokens += cost;
  }
  return { includedIds, excludedIds, tokens, droppedForBudget: excludedIds.length > 0 };
}

// Non-evictable lanes include EVERY item (reserved off the top, never dropped) even if their
// total exceeds the budget — that overflow is the only permitted exception (forces "exceeded").
function includeAll(items: readonly ContextLaneItemInput[]): LaneFill {
  const includedIds = items.map((item) => item.id);
  let tokens = 0;
  for (const item of items) {
    tokens += estimateTokens(item.text);
  }
  return { includedIds, excludedIds: [], tokens, droppedForBudget: false };
}

function pressureFor(tokens: number, cap: number): ContextBudgetPressure {
  if (cap <= 0) {
    return tokens > 0 ? "exceeded" : "low";
  }
  const ratio = tokens / cap;
  if (ratio >= 1) {
    return "exceeded";
  }
  if (ratio >= 0.85) {
    return "high";
  }
  if (ratio >= 0.6) {
    return "moderate";
  }
  return "low";
}

function laneDiagnostics(
  laneId: ContextLaneId,
  fill: LaneFill,
  cap: number,
): ContextLaneDiagnostics {
  const base: ContextLaneDiagnostics = {
    laneId,
    estimatedTokens: fill.tokens,
    includedItems: fill.includedIds.length,
    excludedItems: fill.excludedIds.length,
    budgetPressure: pressureFor(fill.tokens, cap),
    provenanceCounts: {
      included: fill.includedIds.length,
      excluded: fill.excludedIds.length,
    },
  };
  return fill.droppedForBudget ? { ...base, compactionReason: "budget" } : base;
}

function toAllocatedLane(laneId: ContextLaneId, fill: LaneFill, cap: number): AllocatedContextLane {
  return {
    laneId,
    includedItemIds: fill.includedIds,
    excludedItemIds: fill.excludedIds,
    estimatedTokens: fill.tokens,
    diagnostics: laneDiagnostics(laneId, fill, cap),
  };
}

interface PlannedLane {
  readonly row: ContextLaneBudget;
  readonly items: readonly ContextLaneItemInput[];
}

// Joins each present input lane to its budget row. Lanes absent from input.lanes contribute
// nothing; an input lane with no matching budget row is ignored gracefully (no throw).
function planLanes(input: AllocateContextInput): readonly PlannedLane[] {
  const itemsByLane = new Map<ContextLaneId, readonly ContextLaneItemInput[]>();
  for (const lane of input.lanes) {
    itemsByLane.set(lane.laneId, lane.items);
  }
  const planned: PlannedLane[] = [];
  for (const row of input.budget.lanes) {
    const items = itemsByLane.get(row.laneId);
    if (items !== undefined) {
      planned.push({ row, items });
    }
  }
  return planned;
}

function isNonEvictable(row: ContextLaneBudget): boolean {
  return row.eviction === "none";
}

// Evictable lanes are filled in priority order (lower priority first; canonical lane order
// breaks ties) so eviction is deterministic and matches the ADR allocation order.
function byEvictionOrder(a: PlannedLane, b: PlannedLane): number {
  const byPriority = a.row.priority - b.row.priority;
  return byPriority !== 0
    ? byPriority
    : canonicalIndex(a.row.laneId) - canonicalIndex(b.row.laneId);
}

function fillEvictableLanes(
  lanes: readonly PlannedLane[],
  budgetAfterReserved: number,
): ReadonlyMap<ContextLaneId, LaneFill> {
  const ordered = [...lanes].sort(byEvictionOrder);
  const fills = new Map<ContextLaneId, LaneFill>();
  let remaining = Math.max(0, budgetAfterReserved);
  for (const lane of ordered) {
    const cap = Math.min(lane.row.maxTokens, remaining);
    const fill = selectScoredByTokenBudget(lane.items, cap);
    fills.set(lane.row.laneId, fill);
    remaining -= fill.tokens;
  }
  return fills;
}

interface LaneFillResult {
  readonly fills: ReadonlyMap<ContextLaneId, LaneFill>;
  readonly reservedTokens: number;
  // True when any non-evictable lane was forced past its own cap — the only permitted overflow,
  // which forces overall budgetPressure "exceeded" (ADR-0052 D3, allocator obligation).
  readonly nonEvictableOverflow: boolean;
}

function buildLaneFills(planned: readonly PlannedLane[], effectiveBudget: number): LaneFillResult {
  const fills = new Map<ContextLaneId, LaneFill>();
  let reservedTokens = 0;
  let nonEvictableOverflow = false;
  const evictable: PlannedLane[] = [];
  for (const lane of planned) {
    if (isNonEvictable(lane.row)) {
      const fill = includeAll(lane.items);
      fills.set(lane.row.laneId, fill);
      reservedTokens += fill.tokens;
      if (fill.tokens > lane.row.maxTokens) {
        nonEvictableOverflow = true;
      }
    } else {
      evictable.push(lane);
    }
  }
  const evictableFills = fillEvictableLanes(evictable, effectiveBudget - reservedTokens);
  for (const [laneId, fill] of evictableFills) {
    fills.set(laneId, fill);
  }
  return { fills, reservedTokens, nonEvictableOverflow };
}

function capForLane(budget: ContextBudget, laneId: ContextLaneId): number {
  for (const row of budget.lanes) {
    if (row.laneId === laneId) {
      return row.maxTokens;
    }
  }
  return 0;
}

// Emits the allocated lanes in the canonical CONTEXT_LANE_IDS order so a later prompt assembler
// can place them START -> END deterministically (lost-in-the-middle layout obligation).
function orderResults(
  budget: ContextBudget,
  fills: ReadonlyMap<ContextLaneId, LaneFill>,
): readonly AllocatedContextLane[] {
  const out: AllocatedContextLane[] = [];
  for (const laneId of CONTEXT_LANE_IDS) {
    const fill = fills.get(laneId);
    if (fill !== undefined) {
      out.push(toAllocatedLane(laneId, fill, capForLane(budget, laneId)));
    }
  }
  return out;
}

export function allocateContext(input: AllocateContextInput): AllocateContextResult {
  const effectiveBudget = input.profile.effectiveInputBudget;
  const planned = planLanes(input);
  const { fills, reservedTokens, nonEvictableOverflow } = buildLaneFills(planned, effectiveBudget);
  const lanes = orderResults(input.budget, fills);

  const totalEstimatedTokens = lanes.reduce((sum, lane) => sum + lane.estimatedTokens, 0);
  const overflow = nonEvictableOverflow || reservedTokens > effectiveBudget;
  const budgetPressure: ContextBudgetPressure = overflow
    ? "exceeded"
    : pressureFor(totalEstimatedTokens, effectiveBudget);
  const diagnostics: ContextAssemblyDiagnostics = {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: input.profile,
    totalEstimatedTokens,
    budgetPressure,
    lanes: lanes.map((lane) => lane.diagnostics),
    orderedForRecency: true,
  };
  return { lanes, diagnostics, totalEstimatedTokens };
}
