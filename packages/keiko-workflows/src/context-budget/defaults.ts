// Default lane budget plan for the deterministic context allocator (ADR-0052 D3, "Default lane
// budget"). One ContextLaneBudget row per the eight lanes, pinned against DEFAULT_CONTEXT_PROFILE
// (effectiveInputBudget 116_000). The CONTRACT is the shape and the allocation order encoded by
// `priority`; the specific integers are TUNABLE and may be re-balanced without any surface change.
//
// Allocation order (priority, lower = earlier): system-contract=0, user-task=1, active-plan=2,
// working-memory=3, repo-evidence=4, tool-observations=5, history-summary=6, verification-evidence=7.
// system-contract + user-task are non-evictable (eviction "none", minReservedTokens > 0) and are
// reserved off the top. Per-lane maxTokens deliberately SUM ABOVE 116_000 — lanes compete and the
// allocator enforces effectiveInputBudget at runtime. The non-evictable minReserved sums
// (4_000 + 8_000 = 12_000) stay well under 116_000.

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PROFILE,
  type ContextBudget,
  type ContextLaneBudget,
} from "@oscharko-dev/keiko-contracts";

const DEFAULT_LANES: readonly ContextLaneBudget[] = [
  {
    laneId: "system-contract",
    priority: 0,
    maxTokens: 6_000,
    minReservedTokens: 4_000,
    eviction: "none",
  },
  {
    laneId: "user-task",
    priority: 1,
    maxTokens: 12_000,
    minReservedTokens: 8_000,
    eviction: "none",
  },
  {
    laneId: "active-plan",
    priority: 2,
    maxTokens: 16_000,
    minReservedTokens: 0,
    eviction: "summarize-then-drop",
  },
  {
    laneId: "working-memory",
    priority: 3,
    maxTokens: 24_000,
    minReservedTokens: 0,
    eviction: "summarize-then-drop",
  },
  {
    laneId: "repo-evidence",
    priority: 4,
    maxTokens: 48_000,
    minReservedTokens: 0,
    eviction: "drop-lowest-score",
  },
  {
    laneId: "tool-observations",
    priority: 5,
    maxTokens: 32_000,
    minReservedTokens: 0,
    eviction: "drop-oldest",
  },
  {
    laneId: "history-summary",
    priority: 6,
    maxTokens: 16_000,
    minReservedTokens: 0,
    eviction: "summarize-then-drop",
  },
  {
    laneId: "verification-evidence",
    priority: 7,
    maxTokens: 16_000,
    minReservedTokens: 0,
    eviction: "drop-oldest",
  },
] as const;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
  profile: DEFAULT_CONTEXT_PROFILE,
  lanes: DEFAULT_LANES,
} as const;
