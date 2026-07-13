// Editor problems-aggregation model (Issue #2210, Epic #2092, ADR-0126 D2). A bounded aggregation
// view over two differently-scoped sources: open-file language diagnostics and the latest
// verification run's failures. This leaf owns the wire shape, the caps that keep a pathological
// workspace from flooding the UI, and ONE canonical total-order comparator + snapshot builder so the
// problems-panel child issue (#2213) and its tests reuse them instead of re-deriving the sort/caps.
//
// This panel is intentionally NOT content-free: its whole purpose is to show the developer the real
// diagnostic/failure message so they can fix it (ADR-0126 consequence). The ordinary editor-content
// rules apply (no secrets, no cross-workspace leakage) — not the audit ledger's redaction rule.
// Leaf-package rule (ADR-0019): no @oscharko-dev/keiko-* imports; pure types + functions only.

import { isVerificationKind } from "./editor-verification.js";
import type { VerificationKind } from "./verification.js";

export const EDITOR_PROBLEMS_SCHEMA_VERSION = "1" as const;

// Bounded aggregation caps (ADR-0126 D2). A per-file cap and a total cap, both surfaced on the
// snapshot so the panel can render "showing N of totalCount" instead of silently dropping rows.
export const EDITOR_PROBLEMS_PER_FILE_CAP = 100;
export const EDITOR_PROBLEMS_TOTAL_CAP = 1_000;
export const EDITOR_PROBLEM_MESSAGE_MAX_CHARS = 1_024;
const EDITOR_PROBLEM_ID_MAX_CHARS = 256;
const EDITOR_PROBLEM_PATH_MAX_BYTES = 4_096;
const EDITOR_PROBLEM_COORDINATE_MAX = 2_147_483_647;
const EDITOR_PROBLEM_TEXT_ENCODER = new TextEncoder();

// Language-diagnostic `hint` is normalized to `info` by the producer (Issue #2213); the panel
// severity set stays three-valued (ADR-0126 D2).
export type EditorProblemSeverity = "error" | "warning" | "info";
export type EditorProblemSource = "language-diagnostic" | "verification";
export type EditorProblemKind = VerificationKind | "language-diagnostic";

export interface EditorProblem {
  readonly id: string;
  readonly severity: EditorProblemSeverity;
  readonly source: EditorProblemSource;
  // Workspace-relative path.
  readonly file: string;
  // 1-based when present; absent for an unmappable verification failure (rendered without a jump).
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  // Length-capped (EDITOR_PROBLEM_MESSAGE_MAX_CHARS) diagnostic/failure text.
  readonly message: string;
  // Origin kind: a VerificationKind (for verification failures) or the language-diagnostic marker.
  readonly kind: EditorProblemKind;
}

export interface EditorProblemsSnapshot {
  readonly schemaVersion: typeof EDITOR_PROBLEMS_SCHEMA_VERSION;
  readonly problems: readonly EditorProblem[];
  // The true, pre-cap count so the panel can show "showing problems.length of totalCount".
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly perFileCap: number;
  readonly totalCap: number;
}

// ─── Total-order comparator (ADR-0126 D2) ────────────────────────────────────────────

const SEVERITY_RANK: Readonly<Record<EditorProblemSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

// A missing line/column sorts AFTER any present coordinate within the same file.
function coordinateOrLast(value: number | undefined): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Deterministic TOTAL order: severity descending, then file ascending, then line, then column, then
// source, then message, then id. The trailing tie-breaks make ties at severity/file/line/column
// resolve deterministically without relying on the JavaScript sort's stability.
export function compareEditorProblems(a: EditorProblem, b: EditorProblem): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    compareStrings(a.file, b.file) ||
    coordinateOrLast(a.line) - coordinateOrLast(b.line) ||
    coordinateOrLast(a.column) - coordinateOrLast(b.column) ||
    compareStrings(a.source, b.source) ||
    compareStrings(a.message, b.message) ||
    compareStrings(a.id, b.id)
  );
}

// Sorts, then applies the per-file and total caps, producing the bounded snapshot with an honest
// totalCount and truncated flag. Highest-severity problems survive the caps because sorting runs
// first. This is the ONE canonical bounded aggregation the panel reuses (ADR-0126 D2).
export function buildEditorProblemsSnapshot(
  problems: readonly EditorProblem[],
  perFileCap: number = EDITOR_PROBLEMS_PER_FILE_CAP,
  totalCap: number = EDITOR_PROBLEMS_TOTAL_CAP,
): EditorProblemsSnapshot {
  const totalCount = problems.length;
  const sorted = [...problems].sort(compareEditorProblems);
  const perFile = new Map<string, number>();
  const capped: EditorProblem[] = [];
  for (const problem of sorted) {
    if (capped.length >= totalCap) break;
    const seen = perFile.get(problem.file) ?? 0;
    if (seen >= perFileCap) continue;
    perFile.set(problem.file, seen + 1);
    capped.push(problem);
  }
  return {
    schemaVersion: EDITOR_PROBLEMS_SCHEMA_VERSION,
    problems: capped,
    totalCount,
    truncated: capped.length < totalCount,
    perFileCap,
    totalCap,
  };
}

// ─── Guards ────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= EDITOR_PROBLEM_COORDINATE_MAX
  );
}

function isCanonicalProblemPath(value: unknown): value is string {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\")) return false;
  if (EDITOR_PROBLEM_TEXT_ENCODER.encode(value).length > EDITOR_PROBLEM_PATH_MAX_BYTES)
    return false;
  const parts = value.split("/");
  return (
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\u0000")
  );
}

export function isEditorProblemSeverity(value: unknown): value is EditorProblemSeverity {
  return value === "error" || value === "warning" || value === "info";
}

export function isEditorProblemSource(value: unknown): value is EditorProblemSource {
  return value === "language-diagnostic" || value === "verification";
}

function isEditorProblemKind(value: unknown): value is EditorProblemKind {
  return value === "language-diagnostic" || isVerificationKind(value);
}

function sourceMatchesKind(value: Readonly<Record<string, unknown>>): boolean {
  return value.source === "language-diagnostic"
    ? value.kind === "language-diagnostic"
    : value.source === "verification" && isVerificationKind(value.kind);
}

function hasValidProblemIdentity(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isNonEmptyString(value.id) &&
    value.id.length <= EDITOR_PROBLEM_ID_MAX_CHARS &&
    isEditorProblemSeverity(value.severity) &&
    isEditorProblemSource(value.source) &&
    isCanonicalProblemPath(value.file)
  );
}

function hasValidProblemPosition(value: Readonly<Record<string, unknown>>): boolean {
  if (value.line !== undefined && !isCoordinate(value.line)) return false;
  return value.column === undefined || (value.line !== undefined && isCoordinate(value.column));
}

function hasValidProblemMessage(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.message === "string" &&
    value.message.length <= EDITOR_PROBLEM_MESSAGE_MAX_CHARS &&
    !value.message.includes("\u0000")
  );
}

export function isEditorProblem(value: unknown): value is EditorProblem {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["id", "severity", "source", "file", "line", "column", "message", "kind"]) &&
    hasValidProblemIdentity(value) &&
    hasValidProblemPosition(value) &&
    hasValidProblemMessage(value) &&
    isEditorProblemKind(value.kind) &&
    sourceMatchesKind(value)
  );
}

function isDenseProblemArray(value: unknown, totalCap: number): value is readonly EditorProblem[] {
  return (
    Array.isArray(value) &&
    value.length <= totalCap &&
    Object.keys(value).length === value.length &&
    value.every(isEditorProblem)
  );
}

function perFileCountsFit(problems: readonly EditorProblem[], perFileCap: number): boolean {
  const counts = new Map<string, number>();
  for (const problem of problems) {
    const count = (counts.get(problem.file) ?? 0) + 1;
    if (count > perFileCap) return false;
    counts.set(problem.file, count);
  }
  return true;
}

function hasValidSnapshotCaps(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { perFileCap: number; totalCap: number } {
  if (!isPositiveInteger(value.perFileCap) || value.perFileCap > EDITOR_PROBLEMS_PER_FILE_CAP) {
    return false;
  }
  return isPositiveInteger(value.totalCap) && value.totalCap <= EDITOR_PROBLEMS_TOTAL_CAP;
}

function hasValidSnapshotSummary(
  value: Readonly<Record<string, unknown>>,
  problems: readonly EditorProblem[],
): boolean {
  if (!isNonNegativeInteger(value.totalCount)) return false;
  if (problems.length > value.totalCount) return false;
  return value.truncated === problems.length < value.totalCount;
}

export function isEditorProblemsSnapshot(value: unknown): value is EditorProblemsSnapshot {
  if (!isRecord(value)) return false;
  if (!hasValidSnapshotCaps(value)) return false;
  if (!isDenseProblemArray(value.problems, value.totalCap)) return false;
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "problems",
      "totalCount",
      "truncated",
      "perFileCap",
      "totalCap",
    ]) &&
    value.schemaVersion === EDITOR_PROBLEMS_SCHEMA_VERSION &&
    hasValidSnapshotSummary(value, value.problems) &&
    perFileCountsFit(value.problems, value.perFileCap)
  );
}
