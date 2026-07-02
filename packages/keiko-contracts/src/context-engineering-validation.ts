// Pure structural validators for the context-engineering contracts (ADR-0052). No filesystem,
// no clock, no crypto, no randomness — every helper inspects the structure of an `unknown`
// payload and reports which invariants failed. Follows the connected-context.ts isRecord +
// predicate envelope. STRUCTURAL ONLY: shape, finite non-negative numbers, schemaVersion
// literal, enum membership, the effectiveInputBudget identity. Policy (e.g. "system-contract
// must be non-evictable") is NOT enforced here — that belongs to the allocator.
//
// Split from context-engineering.ts to keep both files under the 400-LOC budget (mirrors the
// memory-validation.ts / memory-operations-validation.ts split).

import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  CONTEXT_EVICTION_POLICIES,
  CONTEXT_LANE_IDS,
  CONTEXT_TOKEN_ACCOUNTING_SOURCES,
} from "./context-engineering.js";
import type {
  ContextBudgetPressure,
  ContextEvictionPolicy,
  ContextLaneId,
  ContextTokenAccountingSource,
} from "./context-engineering.js";

// ─── Result envelope (house pattern) ───────────────────────────────────────────
export type ContextValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

const BUDGET_PRESSURES: readonly ContextBudgetPressure[] = ["low", "moderate", "high", "exceeded"];

// ─── Shared primitives (local; contracts is a leaf, no shared-util import) ──────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function pushIf(reasons: string[], condition: boolean, reason: string): void {
  if (condition) {
    reasons.push(reason);
  }
}

function buildResult(reasons: readonly string[]): ContextValidationResult {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function schemaMismatch(actual: unknown): boolean {
  return actual !== CONTEXT_ENGINEERING_SCHEMA_VERSION;
}

// ─── Enum guards ────────────────────────────────────────────────────────────────
export function isContextLaneId(value: unknown): value is ContextLaneId {
  return typeof value === "string" && CONTEXT_LANE_IDS.includes(value as ContextLaneId);
}

function isEvictionPolicy(value: unknown): value is ContextEvictionPolicy {
  return (
    typeof value === "string" && CONTEXT_EVICTION_POLICIES.includes(value as ContextEvictionPolicy)
  );
}

function isBudgetPressure(value: unknown): value is ContextBudgetPressure {
  return typeof value === "string" && BUDGET_PRESSURES.includes(value as ContextBudgetPressure);
}

function isTokenAccountingSource(value: unknown): value is ContextTokenAccountingSource {
  return (
    typeof value === "string" &&
    CONTEXT_TOKEN_ACCOUNTING_SOURCES.includes(value as ContextTokenAccountingSource)
  );
}

// ─── ContextProfile ─────────────────────────────────────────────────────────────
const TOKEN_ACCOUNTING_KEYS: ReadonlySet<string> = new Set([
  "source",
  "counterId",
  "scaleMilli",
  "offsetTokens",
]);

function collectProfileReasons(profile: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, schemaMismatch(profile.schemaVersion), `${prefix}.schemaVersion mismatch`);
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(profile.maxInputTokens),
    `${prefix}.maxInputTokens invalid`,
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(profile.reservedOutputTokens),
    `${prefix}.reservedOutputTokens invalid`,
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(profile.safetyMarginTokens),
    `${prefix}.safetyMarginTokens invalid`,
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(profile.effectiveInputBudget),
    `${prefix}.effectiveInputBudget invalid`,
  );
  pushIf(reasons, !isNonEmptyTrimmed(profile.tokenEstimatorId), `${prefix}.tokenEstimatorId empty`);
  return reasons;
}

function collectTokenAccounting(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${prefix}.tokenAccounting invalid`];
  }
  const reasons: string[] = [];
  reasons.push(...collectTokenAccountingKnownKeys(value, prefix));
  pushIf(
    reasons,
    !isTokenAccountingSource(value.source),
    `${prefix}.tokenAccounting.source invalid`,
  );
  pushIf(reasons, !isNonEmptyTrimmed(value.counterId), `${prefix}.tokenAccounting.counterId empty`);
  reasons.push(...collectTokenAccountingNumbers(value, prefix));
  return reasons;
}

function collectTokenAccountingKnownKeys(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  for (const key of Object.keys(value)) {
    pushIf(
      reasons,
      !TOKEN_ACCOUNTING_KEYS.has(key),
      `${prefix}.tokenAccounting.${key} unrecognised`,
    );
  }
  return reasons;
}

function collectTokenAccountingNumbers(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(
    reasons,
    value.scaleMilli !== undefined &&
      (typeof value.scaleMilli !== "number" ||
        !Number.isInteger(value.scaleMilli) ||
        value.scaleMilli <= 0),
    `${prefix}.tokenAccounting.scaleMilli invalid`,
  );
  pushIf(
    reasons,
    value.source === "calibrated" && value.scaleMilli === undefined,
    `${prefix}.tokenAccounting.scaleMilli invalid`,
  );
  pushIf(
    reasons,
    value.offsetTokens !== undefined &&
      (typeof value.offsetTokens !== "number" ||
        !Number.isInteger(value.offsetTokens) ||
        value.offsetTokens < 0),
    `${prefix}.tokenAccounting.offsetTokens invalid`,
  );
  return reasons;
}

function checkBudgetIdentity(profile: Record<string, unknown>, prefix: string): string[] {
  const max = profile.maxInputTokens;
  const reserved = profile.reservedOutputTokens;
  const safety = profile.safetyMarginTokens;
  const effective = profile.effectiveInputBudget;
  if (
    typeof max !== "number" ||
    typeof reserved !== "number" ||
    typeof safety !== "number" ||
    typeof effective !== "number"
  ) {
    return [];
  }
  const expected = Math.max(0, max - reserved - safety);
  return effective === expected ? [] : [`${prefix}.effectiveInputBudget mismatch`];
}

function validateModelMetadata(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${prefix}.model invalid`];
  }
  const reasons: string[] = [];
  for (const key of ["id", "provider", "notes"] as const) {
    const field = value[key];
    pushIf(
      reasons,
      field !== undefined && typeof field !== "string",
      `${prefix}.model.${key} invalid`,
    );
  }
  return reasons;
}

function collectProfile(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons = collectProfileReasons(value, prefix);
  reasons.push(...checkBudgetIdentity(value, prefix));
  reasons.push(...collectTokenAccounting(value.tokenAccounting, prefix));
  reasons.push(...validateModelMetadata(value.model, prefix));
  return reasons;
}

export function validateContextProfile(value: unknown): ContextValidationResult {
  return buildResult(collectProfile(value, "profile"));
}

// ─── ContextLaneBudget ────────────────────────────────────────────────────────
function collectLaneBudget(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isContextLaneId(value.laneId), `${prefix}.laneId invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.priority), `${prefix}.priority invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.maxTokens), `${prefix}.maxTokens invalid`);
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(value.minReservedTokens),
    `${prefix}.minReservedTokens invalid`,
  );
  pushIf(reasons, !isEvictionPolicy(value.eviction), `${prefix}.eviction invalid`);
  return reasons;
}

// ─── ContextBudget ──────────────────────────────────────────────────────────────
export function validateContextBudget(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["budget invalid"]);
  }
  const reasons: string[] = [];
  pushIf(reasons, schemaMismatch(value.schemaVersion), "budget.schemaVersion mismatch");
  reasons.push(...collectProfile(value.profile, "budget.profile"));
  if (!Array.isArray(value.lanes)) {
    reasons.push("budget.lanes invalid");
    return buildResult(reasons);
  }
  value.lanes.forEach((lane, index) => {
    reasons.push(...collectLaneBudget(lane, `budget.lanes[${String(index)}]`));
  });
  return buildResult(reasons);
}

// ─── ContextLaneDiagnostics ──────────────────────────────────────────────────────
function collectLaneDiagnostics(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isContextLaneId(value.laneId), `${prefix}.laneId invalid`);
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(value.estimatedTokens),
    `${prefix}.estimatedTokens invalid`,
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(value.includedItems),
    `${prefix}.includedItems invalid`,
  );
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(value.excludedItems),
    `${prefix}.excludedItems invalid`,
  );
  pushIf(reasons, !isBudgetPressure(value.budgetPressure), `${prefix}.budgetPressure invalid`);
  pushIf(
    reasons,
    value.compactionReason !== undefined && typeof value.compactionReason !== "string",
    `${prefix}.compactionReason invalid`,
  );
  reasons.push(...collectProvenanceCounts(value.provenanceCounts, prefix));
  return reasons;
}

function collectProvenanceCounts(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${prefix}.provenanceCounts invalid`];
  }
  const reasons: string[] = [];
  for (const count of Object.values(value)) {
    pushIf(reasons, !isFiniteNonNegativeNumber(count), `${prefix}.provenanceCounts value invalid`);
  }
  return reasons;
}

// ─── ContextAssemblyDiagnostics ──────────────────────────────────────────────────
export function validateContextAssemblyDiagnostics(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["assembly invalid"]);
  }
  const reasons: string[] = [];
  pushIf(reasons, schemaMismatch(value.schemaVersion), "assembly.schemaVersion mismatch");
  reasons.push(...collectProfile(value.profile, "assembly.profile"));
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(value.totalEstimatedTokens),
    "assembly.totalEstimatedTokens invalid",
  );
  pushIf(reasons, !isBudgetPressure(value.budgetPressure), "assembly.budgetPressure invalid");
  pushIf(
    reasons,
    typeof value.orderedForRecency !== "boolean",
    "assembly.orderedForRecency invalid",
  );
  if (!Array.isArray(value.lanes)) {
    reasons.push("assembly.lanes invalid");
    return buildResult(reasons);
  }
  value.lanes.forEach((lane, index) => {
    reasons.push(...collectLaneDiagnostics(lane, `assembly.lanes[${String(index)}]`));
  });
  return buildResult(reasons);
}
