// Pure structural validators for the PR2 rich compaction vocabulary (ADR-0053). No filesystem,
// no clock, no crypto, no randomness — every helper inspects the structure of an `unknown`
// payload and reports which invariants failed. Split from context-engineering-validation.ts to
// keep both files under the 400-LOC budget (mirrors the memory-validation split).
//
// REFINEMENT 1 (anti-poisoning): validateContextPreservedFact rejects a "fact" that has neither a
// sourceRef nor inferred===true. REFINEMENT 2: the rehydration handle carries an excerpt-content
// hash, validated as a string when present. Assumptions (rationale + confidence) and facts
// (statement + sourceRef/inferred) are validated as structurally distinct shapes.

import { CONTEXT_ENGINEERING_SCHEMA_VERSION } from "./context-engineering.js";
import type { ContextProvenanceRefKind } from "./context-engineering.js";
import { isContextLaneId } from "./context-engineering-validation.js";
import type { ContextValidationResult } from "./context-engineering-validation.js";

const PROVENANCE_REF_KINDS: readonly string[] = [
  "repo-file",
  "tool-result",
  "evidence-atom",
  "message",
];

const ASSUMPTION_CONFIDENCES: readonly string[] = ["low", "medium", "high"];

const COMMAND_OUTCOME_SUMMARY_MAX_CHARS = 200;

// ─── Shared primitives (local; contracts is a leaf, no shared-util import) ──────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyTrimmed(value);
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

// ─── ContextProvenanceRefKind ──────────────────────────────────────────────────
export function isContextProvenanceRefKind(value: unknown): value is ContextProvenanceRefKind {
  return typeof value === "string" && PROVENANCE_REF_KINDS.includes(value);
}

// ─── lineRange (shared by ref + rehydration handle) ─────────────────────────────
function collectLineRange(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${prefix}.lineRange invalid`];
  }
  const { startLine, endLine } = value;
  if (
    !isFiniteNumber(startLine) ||
    !isFiniteNumber(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return [`${prefix}.lineRange invalid`];
  }
  return [];
}

// ─── ContextProvenanceRef ────────────────────────────────────────────────────────
function collectProvenanceRef(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isContextProvenanceRefKind(value.kind), `${prefix}.kind invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.stableId), `${prefix}.stableId invalid`);
  pushIf(reasons, !isOptionalNonEmptyString(value.scopePath), `${prefix}.scopePath invalid`);
  pushIf(reasons, !isOptionalNonEmptyString(value.contentHash), `${prefix}.contentHash invalid`);
  pushIf(
    reasons,
    !isOptionalNonEmptyString(value.evidenceAtomId),
    `${prefix}.evidenceAtomId invalid`,
  );
  pushIf(
    reasons,
    !isOptionalNonEmptyString(value.notPersistedReason),
    `${prefix}.notPersistedReason invalid`,
  );
  reasons.push(...collectLineRange(value.lineRange, prefix));
  return reasons;
}

export function validateContextProvenanceRef(value: unknown): ContextValidationResult {
  return buildResult(collectProvenanceRef(value, "provenanceRef"));
}

function collectOptionalRef(value: unknown, prefix: string): string[] {
  return value === undefined ? [] : collectProvenanceRef(value, prefix);
}

function collectRefArray(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  value.forEach((entry, index) => {
    reasons.push(...collectProvenanceRef(entry, `${prefix}[${String(index)}]`));
  });
  return reasons;
}

// ─── ContextPreservedFact (REFINEMENT 1: sourceRef OR inferred) ──────────────────
function collectPreservedFact(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.statement), `${prefix}.statement invalid`);
  pushIf(
    reasons,
    value.inferred !== undefined && typeof value.inferred !== "boolean",
    `${prefix}.inferred invalid`,
  );
  const hasSource = value.sourceRef !== undefined;
  const isInferred = value.inferred === true;
  pushIf(reasons, !hasSource && !isInferred, `${prefix} requires sourceRef or inferred`);
  reasons.push(...collectOptionalRef(value.sourceRef, `${prefix}.sourceRef`));
  reasons.push(...collectRefArray(value.corroborating, `${prefix}.corroborating`));
  return reasons;
}

export function validateContextPreservedFact(value: unknown): ContextValidationResult {
  return buildResult(collectPreservedFact(value, "preservedFact"));
}

// ─── ContextAssumption (structurally distinct: rationale + confidence) ───────────
function collectAssumption(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.statement), `${prefix}.statement invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.rationale), `${prefix}.rationale invalid`);
  pushIf(
    reasons,
    typeof value.confidence !== "string" || !ASSUMPTION_CONFIDENCES.includes(value.confidence),
    `${prefix}.confidence invalid`,
  );
  return reasons;
}

export function validateContextAssumption(value: unknown): ContextValidationResult {
  return buildResult(collectAssumption(value, "assumption"));
}

// ─── ContextUserConstraint ───────────────────────────────────────────────────────
function collectUserConstraint(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.statement), `${prefix}.statement invalid`);
  reasons.push(...collectOptionalRef(value.sourceRef, `${prefix}.sourceRef`));
  return reasons;
}

// ─── ContextCommandOutcome (summary <= 200 chars) ────────────────────────────────
function collectCommandOutcome(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.command), `${prefix}.command invalid`);
  pushIf(reasons, !isFiniteNumber(value.exitCode), `${prefix}.exitCode invalid`);
  const summary = value.summary;
  pushIf(
    reasons,
    typeof summary !== "string" || summary.length > COMMAND_OUTCOME_SUMMARY_MAX_CHARS,
    `${prefix}.summary invalid`,
  );
  return reasons;
}

export function validateContextCommandOutcome(value: unknown): ContextValidationResult {
  return buildResult(collectCommandOutcome(value, "commandOutcome"));
}

// ─── ContextInvalidationKey ──────────────────────────────────────────────────────
function collectInvalidationKey(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.scopePath), `${prefix}.scopePath invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.contentHash), `${prefix}.contentHash invalid`);
  return reasons;
}

export function validateContextInvalidationKey(value: unknown): ContextValidationResult {
  return buildResult(collectInvalidationKey(value, "invalidationKey"));
}

// ─── ContextRehydrationHandle ────────────────────────────────────────────────────
function collectHandleBase(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, schemaMismatch(value.schemaVersion), `${prefix}.schemaVersion mismatch`);
  pushIf(reasons, !isContextLaneId(value.laneId), `${prefix}.laneId invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.handleId), `${prefix}.handleId invalid`);
  pushIf(
    reasons,
    !isFiniteNumber(value.itemCount) || value.itemCount < 0,
    `${prefix}.itemCount invalid`,
  );
  pushIf(
    reasons,
    !isFiniteNumber(value.approxTokens) || value.approxTokens < 0,
    `${prefix}.approxTokens invalid`,
  );
  return reasons;
}

function collectHandleOptionals(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(
    reasons,
    value.kind !== undefined && !isContextProvenanceRefKind(value.kind),
    `${prefix}.kind invalid`,
  );
  pushIf(reasons, !isOptionalNonEmptyString(value.scopePath), `${prefix}.scopePath invalid`);
  pushIf(reasons, !isOptionalNonEmptyString(value.contentHash), `${prefix}.contentHash invalid`);
  pushIf(
    reasons,
    !isOptionalNonEmptyString(value.evidenceAtomId),
    `${prefix}.evidenceAtomId invalid`,
  );
  pushIf(
    reasons,
    !isOptionalNonEmptyString(value.notPersistedReason),
    `${prefix}.notPersistedReason invalid`,
  );
  pushIf(
    reasons,
    value.approvedSummary !== undefined && typeof value.approvedSummary !== "string",
    `${prefix}.approvedSummary invalid`,
  );
  reasons.push(...collectLineRange(value.lineRange, prefix));
  return reasons;
}

function collectRehydrationHandle(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  return [...collectHandleBase(value, prefix), ...collectHandleOptionals(value, prefix)];
}

export function validateContextRehydrationHandle(value: unknown): ContextValidationResult {
  return buildResult(collectRehydrationHandle(value, "rehydrationHandle"));
}

// ─── ContextCompactionRecord ─────────────────────────────────────────────────────
function collectRecordRequired(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, schemaMismatch(value.schemaVersion), `${prefix}.schemaVersion mismatch`);
  pushIf(reasons, !isContextLaneId(value.laneId), `${prefix}.laneId invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.reason), `${prefix}.reason invalid`);
  for (const key of ["itemsBefore", "itemsAfter", "tokensBefore", "tokensAfter"] as const) {
    const n = value[key];
    pushIf(reasons, !isFiniteNumber(n) || n < 0, `${prefix}.${key} invalid`);
  }
  pushIf(
    reasons,
    value.summaryRefHash !== undefined && typeof value.summaryRefHash !== "string",
    `${prefix}.summaryRefHash invalid`,
  );
  if (value.rehydration !== undefined) {
    reasons.push(...collectRehydrationHandle(value.rehydration, `${prefix}.rehydration`));
  }
  return reasons;
}

function collectStringArray(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  value.forEach((entry, index) => {
    pushIf(reasons, typeof entry !== "string", `${prefix}[${String(index)}] invalid`);
  });
  return reasons;
}

function collectTypedArray(
  value: unknown,
  prefix: string,
  collect: (entry: unknown, p: string) => string[],
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  value.forEach((entry, index) => {
    reasons.push(...collect(entry, `${prefix}[${String(index)}]`));
  });
  return reasons;
}

function collectRecordOptionals(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(
    reasons,
    value.orderedAt !== undefined && !isFiniteNumber(value.orderedAt),
    `${prefix}.orderedAt invalid`,
  );
  reasons.push(...collectRefArray(value.sourceSpans, `${prefix}.sourceSpans`));
  reasons.push(
    ...collectTypedArray(value.preservedFacts, `${prefix}.preservedFacts`, collectPreservedFact),
  );
  reasons.push(...collectTypedArray(value.assumptions, `${prefix}.assumptions`, collectAssumption));
  reasons.push(
    ...collectTypedArray(value.userConstraints, `${prefix}.userConstraints`, collectUserConstraint),
  );
  reasons.push(
    ...collectTypedArray(value.commandOutcomes, `${prefix}.commandOutcomes`, collectCommandOutcome),
  );
  reasons.push(
    ...collectTypedArray(
      value.invalidationKeys,
      `${prefix}.invalidationKeys`,
      collectInvalidationKey,
    ),
  );
  for (const key of [
    "decisions",
    "openQuestions",
    "filesInspected",
    "filesChanged",
    "failingTests",
    "droppedCategories",
  ] as const) {
    reasons.push(...collectStringArray(value[key], `${prefix}.${key}`));
  }
  return reasons;
}

export function validateContextCompactionRecord(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["compactionRecord invalid"]);
  }
  return buildResult([
    ...collectRecordRequired(value, "compactionRecord"),
    ...collectRecordOptionals(value, "compactionRecord"),
  ]);
}
