// Exploration plan factory and retrieval-ring composition (Epic #177, Issue #181).
// Consumes #178 contracts and #179 search-limits surface. Produces a JSON-safe ExplorationPlan
// BEFORE any retrieval work runs. Deterministic planId via node:crypto SHA-256. No IO, no
// network. Execution and persistence of plans land in #182/#183/#187.

import { createHash } from "node:crypto";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  validateSelectedScope,
  type ExplorationBudget,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchLimits } from "@oscharko-dev/keiko-workspace";

import { extractAnchors, type SearchAnchor, type SearchAnchorKind } from "./anchors.js";

// ─── Public types ─────────────────────────────────────────────────────────────

// The planner emits "ready" / "completed" / "budget-exhausted" / "clarification-needed" /
// "scope-invalid". Execution status ("running") is owned by the governor's separate
// GovernorState union — keeping it out of this surface avoids a misleading "running" plan
// state that the planner itself never produces.
export type ExplorationPlanState =
  | "ready"
  | "completed"
  | "budget-exhausted"
  | "clarification-needed"
  | "scope-invalid";

export type RetrievalRingKind = "lexical" | "structural" | "git-history";

export interface RetrievalRing {
  readonly kind: RetrievalRingKind;
  readonly label: string;
  readonly anchorTerms: readonly string[];
  readonly searchLimits: SearchLimits;
  readonly rationale: string;
}

export type ClarificationReason = "no-anchors" | "too-generic" | "scope-empty" | "scope-invalid";

export interface ClarificationPrompt {
  readonly reason: ClarificationReason;
  readonly suggestedQuestions: readonly string[];
  readonly minimumAnchorCount: number;
}

export interface ExplorationPlan {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  readonly planId: string;
  readonly state: ExplorationPlanState;
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly rings: readonly RetrievalRing[];
  readonly budget: ExplorationBudget;
  readonly clarification: ClarificationPrompt | undefined;
  readonly createdAtMs: number;
}

export interface CreatePlanInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly budget?: ExplorationBudget;
  readonly maxAnchors?: number;
}

export interface CreatePlanDeps {
  readonly nowMs?: () => number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ANCHORS = 8;

const RING_WEIGHTS: Readonly<Record<RetrievalRingKind, number>> = {
  lexical: 0.55,
  structural: 0.3,
  "git-history": 0.15,
};

const MIN_EXCERPT_BYTES_PER_FILE = 8192;

const RING_LABELS: Readonly<Record<RetrievalRingKind, string>> = {
  lexical: "Lexical scan across the selected scope",
  structural: "Structural lookups around identifier and path anchors",
  "git-history": "Recent git-history signal across the workspace",
};

const RING_RATIONALES: Readonly<Record<RetrievalRingKind, string>> = {
  lexical: "Lexical anchors are always cheap to scan first and bound the working set.",
  structural:
    "Identifier or path anchors warrant structural lookups so callers are reached without a full text scan.",
  "git-history":
    "Workspace-level queries benefit from recency signal because no sub-scope was preselected.",
};

const NO_ANCHOR_QUESTIONS: readonly string[] = [
  "Which file or symbol should I focus on?",
  "What error message did you see?",
  "Name a function or class to start from.",
];

const TOO_GENERIC_QUESTIONS: readonly string[] = [
  "Can you name the file, class, or function this should touch?",
  "Is there a recent error message or log line that anchors the question?",
];

const SCOPE_EMPTY_QUESTIONS: readonly string[] = [
  "Which folder or files within the workspace should I look at?",
  "Is this question about the whole workspace, or a specific module?",
];

const SCOPE_INVALID_QUESTIONS: readonly string[] = [
  "The selected scope did not validate; please reselect files or a directory.",
];

// ─── Budget slicing ───────────────────────────────────────────────────────────

function atLeastOne(value: number): number {
  return Math.max(1, Math.floor(value));
}

function sliceLimits(budget: ExplorationBudget, weight: number): SearchLimits {
  const perRingExcerptBytes = budget.excerptBytesMax * weight;
  // Per-file is a quarter of the per-ring excerpt allotment, bounded below by 8 KiB so a
  // small ring still has enough headroom to read one usable hunk.
  const maxBytesPerFileScanned = Math.max(
    MIN_EXCERPT_BYTES_PER_FILE,
    Math.floor(perRingExcerptBytes / 4),
  );
  // Matches budget allotted at 50% per ring (the planner doesn't know match density yet).
  const matchesBudget = budget.searchCallsMax * weight * 0.5;
  // maxBytesPerFileScanned has an 8 KiB floor that can push the ring's worst-case excerpt
  // budget (files * bytes-per-file) past its weighted share of excerptBytesMax. Cap
  // maxFilesScanned so the worst case stays within the slice while preserving the floor.
  const filesByBudget = budget.filesReadMax * weight;
  const filesByExcerpt = perRingExcerptBytes / maxBytesPerFileScanned;
  return {
    maxFilesScanned: atLeastOne(Math.min(filesByBudget, filesByExcerpt)),
    maxMatchesReturned: atLeastOne(matchesBudget),
    maxBytesPerFileScanned,
    elapsedMsMax: atLeastOne(budget.elapsedMsMax * weight),
  };
}

// ─── Ring composition ─────────────────────────────────────────────────────────

function anchorTerms(anchors: readonly SearchAnchor[]): readonly string[] {
  return anchors.map((a) => a.term);
}

function hasKind(anchors: readonly SearchAnchor[], kind: SearchAnchorKind): boolean {
  return anchors.some((a) => a.kind === kind);
}

function buildRing(
  kind: RetrievalRingKind,
  anchors: readonly SearchAnchor[],
  budget: ExplorationBudget,
): RetrievalRing {
  return {
    kind,
    label: RING_LABELS[kind],
    anchorTerms: anchorTerms(anchors),
    searchLimits: sliceLimits(budget, RING_WEIGHTS[kind]),
    rationale: RING_RATIONALES[kind],
  };
}

function composeRings(
  anchors: readonly SearchAnchor[],
  scope: SelectedScope,
  budget: ExplorationBudget,
): readonly RetrievalRing[] {
  const rings: RetrievalRing[] = [buildRing("lexical", anchors, budget)];
  if (hasKind(anchors, "identifier") || hasKind(anchors, "path")) {
    rings.push(buildRing("structural", anchors, budget));
  }
  if (scope.relativePaths.length === 0) {
    rings.push(buildRing("git-history", anchors, budget));
  }
  return rings;
}

// ─── Clarification helpers ────────────────────────────────────────────────────

function maxAnchorWeight(anchors: readonly SearchAnchor[]): number {
  let max = 0;
  for (const a of anchors) {
    if (a.weight > max) {
      max = a.weight;
    }
  }
  return max;
}

function buildClarification(
  reason: ClarificationReason,
  suggestedQuestions: readonly string[],
  minimumAnchorCount: number,
): ClarificationPrompt {
  return { reason, suggestedQuestions, minimumAnchorCount };
}

interface ClarificationDecision {
  readonly state: ExplorationPlanState;
  readonly clarification: ClarificationPrompt | undefined;
}

function decideClarification(
  anchors: readonly SearchAnchor[],
  scope: SelectedScope,
): ClarificationDecision {
  if (anchors.length === 0) {
    return {
      state: "clarification-needed",
      clarification: buildClarification("no-anchors", NO_ANCHOR_QUESTIONS, 1),
    };
  }
  // Threshold is <= literal weight so a prompt yielding only `literal` anchors (weight 0.5,
  // i.e. no quoted/path/identifier signal) requests clarification before any retrieval runs.
  if (maxAnchorWeight(anchors) <= 0.5) {
    return {
      state: "clarification-needed",
      clarification: buildClarification("too-generic", TOO_GENERIC_QUESTIONS, 1),
    };
  }
  if (scope.relativePaths.length === 0 && anchors.length < 2) {
    return {
      state: "clarification-needed",
      clarification: buildClarification("scope-empty", SCOPE_EMPTY_QUESTIONS, 2),
    };
  }
  return { state: "ready", clarification: undefined };
}

// ─── Plan ID derivation ───────────────────────────────────────────────────────

interface PlanSeed {
  readonly scopeId: string;
  readonly queryKind: string;
  readonly queryText: string;
  readonly anchorTerms: readonly string[];
  readonly ringKinds: readonly string[];
}

function canonicalize(seed: PlanSeed): string {
  // JSON.stringify with sorted keys via explicit ordering — never relies on object key order.
  return JSON.stringify([
    seed.scopeId,
    seed.queryKind,
    seed.queryText,
    [...seed.anchorTerms].sort(),
    [...seed.ringKinds].sort(),
  ]);
}

function derivePlanId(seed: PlanSeed): string {
  const hash = createHash("sha256").update(canonicalize(seed)).digest("hex");
  return `pl-${hash.slice(0, 16)}`;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

interface ResolvedInputs {
  readonly budget: ExplorationBudget;
  readonly maxAnchors: number;
  readonly nowMs: () => number;
}

function resolveInputs(input: CreatePlanInput, deps: CreatePlanDeps | undefined): ResolvedInputs {
  return {
    budget: input.budget ?? DEFAULT_EXPLORATION_BUDGET,
    maxAnchors: input.maxAnchors ?? DEFAULT_MAX_ANCHORS,
    nowMs: deps?.nowMs ?? Date.now,
  };
}

function buildScopeInvalidPlan(input: CreatePlanInput, resolved: ResolvedInputs): ExplorationPlan {
  const clarification = buildClarification("scope-invalid", SCOPE_INVALID_QUESTIONS, 0);
  const seed: PlanSeed = {
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    anchorTerms: [],
    ringKinds: [],
  };
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    planId: derivePlanId(seed),
    state: "scope-invalid",
    scope: input.scope,
    query: input.query,
    anchors: [],
    rings: [],
    budget: resolved.budget,
    clarification,
    createdAtMs: resolved.nowMs(),
  };
}

export function createExplorationPlan(
  input: CreatePlanInput,
  deps?: CreatePlanDeps,
): ExplorationPlan {
  const resolved = resolveInputs(input, deps);
  const scopeResult = validateSelectedScope(input.scope);
  if (!scopeResult.ok) {
    return buildScopeInvalidPlan(input, resolved);
  }
  const extraction = extractAnchors({
    text: input.query.text,
    maxAnchors: resolved.maxAnchors,
  });
  const decision = decideClarification(extraction.anchors, input.scope);
  const rings =
    decision.state === "ready"
      ? composeRings(extraction.anchors, input.scope, resolved.budget)
      : [];
  const seed: PlanSeed = {
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    anchorTerms: extraction.anchors.map((a) => a.term),
    ringKinds: rings.map((r) => r.kind),
  };
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    planId: derivePlanId(seed),
    state: decision.state,
    scope: input.scope,
    query: input.query,
    anchors: extraction.anchors,
    rings,
    budget: resolved.budget,
    clarification: decision.clarification,
    createdAtMs: resolved.nowMs(),
  };
}
