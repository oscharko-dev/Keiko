// The shared model-role recommendation of every two-role model policy (Issue #4137): Quality
// Intelligence (generation and judge) and Keiko for Quality (Reviewer and Counter-checker) pick a
// first model, then prefer a DIFFERENT eligible model for the second role and fall back to the same
// model only when no other one qualifies. Each policy keeps its own eligibility rule and ordering;
// this module owns only the selection, so the "different second model" preference exists once.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";

/** A capability with its position in the configured list, the final tie-break of every order. */
export interface IndexedCapability {
  readonly capability: ModelCapability;
  readonly index: number;
}

export type IndexedCapabilityOrder = (a: IndexedCapability, b: IndexedCapability) => number;

/** The configured chat models, each with its index in the full configured list. */
export function indexedChatCapabilities(
  capabilities: readonly ModelCapability[],
): readonly IndexedCapability[] {
  return capabilities
    .map((capability, index) => ({ capability, index }))
    .filter((entry) => entry.capability.kind === "chat");
}

// contextWindow===0 is a runtime-discovered/unenriched placeholder (GEN-GATE-DISCOVERY-001).
// Total order (transitive) that (a) prefers any known capacity over the placeholder and
// (b) orders known capacities largest-first, while treating two placeholders as equal.
// Returning 0 for "0 vs X" and X vs Y descending is NOT a total order — the comparator
// would report cycles (4K < 128K, 0 == 128K, 0 == 4K) and Node's stable sort could leave
// the placeholder ahead of the largest window (PR-review follow-up on KEIKO-0501).
export function compareContextWindowDesc(
  a: number | undefined = 0,
  b: number | undefined = 0,
): number {
  const aKnown = a > 0;
  const bKnown = b > 0;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return b - a;
}

/**
 * The first model of `order` among the eligible candidates, preferring one whose id differs from
 * `avoidModelId`; the avoided model is chosen only when it is the sole eligible candidate.
 */
export function pickRoleModel(
  candidates: readonly IndexedCapability[],
  eligible: (capability: ModelCapability) => boolean,
  order: IndexedCapabilityOrder,
  avoidModelId?: string,
): ModelCapability | undefined {
  const pool = candidates.filter((entry): boolean => eligible(entry.capability));
  const different =
    avoidModelId === undefined
      ? pool
      : pool.filter((entry) => entry.capability.id !== avoidModelId);
  const chosen = different.length > 0 ? different : pool;
  return chosen.slice().sort(order)[0]?.capability;
}

export interface RoleRule {
  readonly eligible: (capability: ModelCapability) => boolean;
  readonly order: IndexedCapabilityOrder;
}

export interface RolePairRecommendation {
  readonly first: ModelCapability | undefined;
  readonly second: ModelCapability | undefined;
  /** Both roles resolved to one model because no different eligible model exists. */
  readonly singleModel: boolean;
}

/** Recommends a pair: the first role's best model, then a different second model when one exists. */
export function recommendRolePair(
  candidates: readonly IndexedCapability[],
  first: RoleRule,
  second: RoleRule,
): RolePairRecommendation {
  const firstModel = pickRoleModel(candidates, first.eligible, first.order);
  const secondModel = pickRoleModel(candidates, second.eligible, second.order, firstModel?.id);
  return {
    first: firstModel,
    second: secondModel,
    singleModel: firstModel !== undefined && firstModel.id === secondModel?.id,
  };
}
