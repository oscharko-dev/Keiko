// Pure structural validators for the shaped tool-observation contracts (ADR-0054, PR3-W1). No
// filesystem, no clock, no crypto, no randomness — every helper inspects the structure of an
// `unknown` payload and reports which invariants failed. Follows the connected-context.ts isRecord
// + predicate envelope and reuses ContextValidationResult. STRUCTURAL ONLY: shape, finite
// non-negative numbers, bounded counts within the MAX_* constants, valid stream enum, valid
// laneId/kind. Policy (e.g. which tools may be shaped) is NOT enforced here.
//
// Split from context-observations.ts to keep both files under the 400-LOC budget (mirrors the
// context-engineering-validation.ts split).

import { CONTEXT_ENGINEERING_SCHEMA_VERSION } from "./context-engineering.js";
import {
  MAX_FAILING_TEST_NAMES,
  MAX_OBSERVATION_EXCERPT_BYTES,
  MAX_OBSERVATION_QUERY_BYTES,
  MAX_STACK_FRAME_LINES,
  MAX_TOP_RANGES,
} from "./context-observations.js";
import { isContextLaneId } from "./context-engineering-validation.js";
import type { ContextValidationResult } from "./context-engineering-validation.js";

const TOOL_OBSERVATION_KINDS: readonly string[] = ["command", "test", "search", "browser"];
const STREAMS: readonly string[] = ["stdout", "stderr"];

// ─── Shared primitives (local; contracts is a leaf, no shared-util import) ──────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isExitCode(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalFiniteNonNegativeNumber(value: unknown): boolean {
  return value === undefined || isFiniteNonNegativeNumber(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
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

// ─── Kind guard ──────────────────────────────────────────────────────────────
export function isContextToolObservationKind(value: unknown): boolean {
  return typeof value === "string" && TOOL_OBSERVATION_KINDS.includes(value);
}

// ─── ContextToolRehydrationHandle ──────────────────────────────────────────────
function collectRehydration(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(
    reasons,
    value.schemaVersion !== CONTEXT_ENGINEERING_SCHEMA_VERSION,
    `${prefix}.schemaVersion mismatch`,
  );
  pushIf(reasons, !isContextLaneId(value.laneId), `${prefix}.laneId invalid`);
  pushIf(reasons, value.kind !== "tool-result", `${prefix}.kind invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.artifactId), `${prefix}.artifactId invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.itemCount), `${prefix}.itemCount invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.approxTokens), `${prefix}.approxTokens invalid`);
  pushIf(
    reasons,
    !isOptionalNonEmptyString(value.notPersistedReason),
    `${prefix}.notPersistedReason invalid`,
  );
  return reasons;
}

export function validateContextToolRehydrationHandle(value: unknown): ContextValidationResult {
  return buildResult(collectRehydration(value, "rehydration"));
}

function collectOptionalRehydration(value: unknown, prefix: string): string[] {
  return value === undefined ? [] : collectRehydration(value, prefix);
}

// ─── Shared injection-signal optionals (command/test/search/browser) ────────────
function collectInjectionOptionals(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(
    reasons,
    !isOptionalFiniteNonNegativeNumber(value.injectionSignalCount),
    `${prefix}.injectionSignalCount invalid`,
  );
  pushIf(
    reasons,
    !isOptionalBoolean(value.hasCriticalInjectionSignal),
    `${prefix}.hasCriticalInjectionSignal invalid`,
  );
  return reasons;
}

// ─── ShapedStreamExcerpt ────────────────────────────────────────────────────────
function collectExcerpts(value: unknown, prefix: string): string[] {
  if (!Array.isArray(value)) {
    return [`${prefix}.excerpts invalid`];
  }
  const reasons: string[] = [];
  let totalBytes = 0;
  value.forEach((entry, index) => {
    const at = `${prefix}.excerpts[${String(index)}]`;
    if (!isRecord(entry)) {
      reasons.push(`${at} invalid`);
      return;
    }
    pushIf(
      reasons,
      typeof entry.stream !== "string" || !STREAMS.includes(entry.stream),
      `${at}.stream invalid`,
    );
    pushIf(reasons, !isFiniteNonNegativeNumber(entry.bytes), `${at}.bytes invalid`);
    pushIf(reasons, typeof entry.text !== "string", `${at}.text invalid`);
    if (isFiniteNonNegativeNumber(entry.bytes)) {
      totalBytes += entry.bytes;
    }
  });
  pushIf(reasons, totalBytes > MAX_OBSERVATION_EXCERPT_BYTES, `${prefix}.excerpts exceed byte cap`);
  return reasons;
}

// ─── ShapedCommandObservation ───────────────────────────────────────────────────
function collectCommand(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.observationId), `${prefix}.observationId invalid`);
  pushIf(reasons, !isExitCode(value.exitCode), `${prefix}.exitCode invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.durationMs), `${prefix}.durationMs invalid`);
  pushIf(reasons, typeof value.timedOut !== "boolean", `${prefix}.timedOut invalid`);
  pushIf(reasons, typeof value.truncated !== "boolean", `${prefix}.truncated invalid`);
  pushIf(
    reasons,
    !isOptionalFiniteNonNegativeNumber(value.omittedByteCount),
    `${prefix}.omittedByteCount invalid`,
  );
  reasons.push(...collectExcerpts(value.excerpts, prefix));
  reasons.push(...collectInjectionOptionals(value, prefix));
  reasons.push(...collectOptionalRehydration(value.rehydration, `${prefix}.rehydration`));
  return reasons;
}

export function validateShapedCommandObservation(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["command invalid"]);
  }
  const reasons: string[] = [];
  pushIf(reasons, value.kind !== "command", "command.kind invalid");
  reasons.push(...collectCommand(value, "command"));
  return buildResult(reasons);
}

// ─── ShapedTestObservation ──────────────────────────────────────────────────────
function collectTestCounts(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [`${prefix}.counts invalid`];
  }
  const reasons: string[] = [];
  for (const key of ["passed", "failed", "skipped"] as const) {
    pushIf(reasons, !isFiniteNonNegativeNumber(value[key]), `${prefix}.counts.${key} invalid`);
  }
  return reasons;
}

function collectBoundedStringArray(value: unknown, prefix: string, cap: number): string[] {
  if (!Array.isArray(value)) {
    return [`${prefix} invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, value.length > cap, `${prefix} exceeds cap`);
  value.forEach((entry, index) => {
    pushIf(reasons, typeof entry !== "string", `${prefix}[${String(index)}] invalid`);
  });
  return reasons;
}

function collectTest(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.observationId), `${prefix}.observationId invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.verificationKind), `${prefix}.verificationKind invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.status), `${prefix}.status invalid`);
  pushIf(reasons, !isExitCode(value.exitCode), `${prefix}.exitCode invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.durationMs), `${prefix}.durationMs invalid`);
  pushIf(reasons, typeof value.truncated !== "boolean", `${prefix}.truncated invalid`);
  pushIf(
    reasons,
    !isOptionalFiniteNonNegativeNumber(value.omittedByteCount),
    `${prefix}.omittedByteCount invalid`,
  );
  reasons.push(...collectTestCounts(value.counts, prefix));
  reasons.push(
    ...collectBoundedStringArray(
      value.failingTestNames,
      `${prefix}.failingTestNames`,
      MAX_FAILING_TEST_NAMES,
    ),
  );
  reasons.push(
    ...collectBoundedStringArray(
      value.stackFrameExcerpts,
      `${prefix}.stackFrameExcerpts`,
      MAX_STACK_FRAME_LINES,
    ),
  );
  pushIf(reasons, typeof value.outputSummary !== "string", `${prefix}.outputSummary invalid`);
  reasons.push(...collectInjectionOptionals(value, prefix));
  reasons.push(...collectOptionalRehydration(value.rehydration, `${prefix}.rehydration`));
  return reasons;
}

export function validateShapedTestObservation(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["test invalid"]);
  }
  const reasons: string[] = [];
  pushIf(reasons, value.kind !== "test", "test.kind invalid");
  reasons.push(...collectTest(value, "test"));
  return buildResult(reasons);
}

// ─── ShapedSearchObservation ────────────────────────────────────────────────────
function collectTopRanges(value: unknown, prefix: string): string[] {
  if (!Array.isArray(value)) {
    return [`${prefix}.topRanges invalid`];
  }
  const reasons: string[] = [];
  pushIf(reasons, value.length > MAX_TOP_RANGES, `${prefix}.topRanges exceeds cap`);
  value.forEach((entry, index) => {
    const at = `${prefix}.topRanges[${String(index)}]`;
    if (!isRecord(entry)) {
      reasons.push(`${at} invalid`);
      return;
    }
    pushIf(reasons, !isNonEmptyTrimmed(entry.scopePath), `${at}.scopePath invalid`);
    pushIf(reasons, !isFiniteNonNegativeNumber(entry.startLine), `${at}.startLine invalid`);
    pushIf(reasons, !isFiniteNonNegativeNumber(entry.endLine), `${at}.endLine invalid`);
    pushIf(reasons, !isFiniteNonNegativeNumber(entry.score), `${at}.score invalid`);
  });
  return reasons;
}

function collectSearch(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.observationId), `${prefix}.observationId invalid`);
  const query = value.query;
  pushIf(
    reasons,
    typeof query !== "string" || query.length > MAX_OBSERVATION_QUERY_BYTES,
    `${prefix}.query invalid`,
  );
  pushIf(reasons, !isNonEmptyTrimmed(value.searchKind), `${prefix}.searchKind invalid`);
  pushIf(
    reasons,
    !isFiniteNonNegativeNumber(value.candidateCount),
    `${prefix}.candidateCount invalid`,
  );
  pushIf(reasons, !isFiniteNonNegativeNumber(value.omittedCount), `${prefix}.omittedCount invalid`);
  pushIf(reasons, typeof value.truncated !== "boolean", `${prefix}.truncated invalid`);
  reasons.push(...collectTopRanges(value.topRanges, prefix));
  reasons.push(...collectInjectionOptionals(value, prefix));
  return reasons;
}

export function validateShapedSearchObservation(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["search invalid"]);
  }
  const reasons: string[] = [];
  pushIf(reasons, value.kind !== "search", "search.kind invalid");
  reasons.push(...collectSearch(value, "search"));
  return buildResult(reasons);
}

// ─── ShapedBrowserObservation (forward-defined; still validated) ─────────────────
function collectBrowser(value: Record<string, unknown>, prefix: string): string[] {
  const reasons: string[] = [];
  pushIf(reasons, !isNonEmptyTrimmed(value.observationId), `${prefix}.observationId invalid`);
  pushIf(reasons, !isNonEmptyTrimmed(value.checkDescription), `${prefix}.checkDescription invalid`);
  pushIf(reasons, typeof value.passed !== "boolean", `${prefix}.passed invalid`);
  pushIf(reasons, !isFiniteNonNegativeNumber(value.durationMs), `${prefix}.durationMs invalid`);
  pushIf(
    reasons,
    !isOptionalFiniteNonNegativeNumber(value.a11yViolationCount),
    `${prefix}.a11yViolationCount invalid`,
  );
  pushIf(
    reasons,
    !isOptionalNonEmptyString(value.screenshotScopePath),
    `${prefix}.screenshotScopePath invalid`,
  );
  reasons.push(...collectInjectionOptionals(value, prefix));
  reasons.push(...collectOptionalRehydration(value.rehydration, `${prefix}.rehydration`));
  return reasons;
}

export function validateShapedBrowserObservation(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["browser invalid"]);
  }
  const reasons: string[] = [];
  pushIf(reasons, value.kind !== "browser", "browser.kind invalid");
  reasons.push(...collectBrowser(value, "browser"));
  return buildResult(reasons);
}

// ─── Discriminated dispatch ──────────────────────────────────────────────────────
export function validateContextToolObservation(value: unknown): ContextValidationResult {
  if (!isRecord(value)) {
    return buildResult(["observation invalid"]);
  }
  switch (value.kind) {
    case "command":
      return validateShapedCommandObservation(value);
    case "test":
      return validateShapedTestObservation(value);
    case "search":
      return validateShapedSearchObservation(value);
    case "browser":
      return validateShapedBrowserObservation(value);
    default:
      return buildResult(["observation.kind invalid"]);
  }
}
