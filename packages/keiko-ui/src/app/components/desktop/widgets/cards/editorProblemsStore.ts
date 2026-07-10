"use client";

// Issue #2213 (Epic #2092, ADR-0126) — a module-level, workspace-scoped aggregation of editor
// problems for the Problems panel. It is a bounded UNION of two differently-scoped sources:
//   1. open-file language diagnostics (per pane, keyed by path; live per keystroke-debounce), and
//   2. the latest verification run's failures (potentially referencing files that are not open).
// The panel reads one snapshot; EditorRuntimeWidget feeds pane diagnostics, and the verification run
// store feeds the latest report. Everything here is content-visible-to-the-user editor content (a
// diagnostic/failure message), NOT audit evidence — the ordinary no-secrets/no-cross-workspace rule
// applies, not redaction-before-display (ADR-0126 consequence).

import {
  buildEditorProblemsSnapshot,
  type EditorProblem,
  type EditorProblemSeverity,
  type VerificationKind,
  type VerificationReport,
  type VerificationResult,
} from "@oscharko-dev/keiko-contracts";
import type { EditorDiagnostic } from "@oscharko-dev/keiko-editor";

const FAILED_STATUSES: ReadonlySet<VerificationResult["status"]> = new Set([
  "failed",
  "timed-out",
  "resource-exceeded",
]);

// Language-diagnostic `hint` normalizes to `info`, keeping the panel severity set three-valued.
function normalizeSeverity(severity: EditorDiagnostic["severity"]): EditorProblemSeverity {
  return severity === "error" || severity === "warning" ? severity : "info";
}

// EditorRange positions are zero-based (LSP 3.17); EditorProblem line/column are 1-based when present.
export function diagnosticToProblem(
  path: string,
  diagnostic: EditorDiagnostic,
  index: number,
): EditorProblem {
  const line = diagnostic.range.start.line + 1;
  const column = diagnostic.range.start.column + 1;
  return {
    id: `d:${path}:${String(line)}:${String(column)}:${String(index)}`,
    severity: normalizeSeverity(diagnostic.severity),
    source: "language-diagnostic",
    file: path,
    line,
    column,
    message: diagnostic.message,
    kind: "language-diagnostic",
  };
}

// A failed result with structured locations becomes one problem per location; a failed result with NO
// locations (unmappable/best-effort empty) becomes ONE bounded summary row without a jump target.
export function verificationResultToProblems(result: VerificationResult): readonly EditorProblem[] {
  if (!FAILED_STATUSES.has(result.status)) return [];
  const kind: VerificationKind = result.kind;
  const locations = result.locations ?? [];
  if (locations.length === 0) {
    return [
      {
        id: `v:${kind}:summary`,
        severity: "error",
        source: "verification",
        file: `(${kind})`,
        message: result.outputSummary.length > 0 ? result.outputSummary : `${kind} failed`,
        kind,
      },
    ];
  }
  return locations.map((location, index) => ({
    id: `v:${kind}:${location.file}:${String(location.line ?? 0)}:${String(index)}`,
    severity: "error" as const,
    source: "verification" as const,
    file: location.file,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
    message: location.message,
    kind,
  }));
}

function buildAllProblems(
  diagnosticsByPath: ReadonlyMap<string, readonly EditorDiagnostic[]>,
  report: VerificationReport | null,
): readonly EditorProblem[] {
  const problems: EditorProblem[] = [];
  for (const [path, diagnostics] of diagnosticsByPath) {
    diagnostics.forEach((diagnostic, index) => {
      problems.push(diagnosticToProblem(path, diagnostic, index));
    });
  }
  if (report !== null) {
    for (const result of report.results) problems.push(...verificationResultToProblems(result));
  }
  return problems;
}

// ─── Module-level store ──────────────────────────────────────────────────────────────
let diagnosticsByPath = new Map<string, readonly EditorDiagnostic[]>();
let latestReport: VerificationReport | null = null;
let problems: readonly EditorProblem[] = [];
const listeners = new Set<() => void>();

function rebuild(): void {
  problems = buildAllProblems(diagnosticsByPath, latestReport);
  for (const listener of [...listeners]) listener();
}

export function setPaneDiagnostics(path: string, diagnostics: readonly EditorDiagnostic[]): void {
  const next = new Map(diagnosticsByPath);
  if (diagnostics.length === 0) next.delete(path);
  else next.set(path, diagnostics);
  diagnosticsByPath = next;
  rebuild();
}

export function removePaneDiagnostics(path: string): void {
  if (!diagnosticsByPath.has(path)) return;
  const next = new Map(diagnosticsByPath);
  next.delete(path);
  diagnosticsByPath = next;
  rebuild();
}

export function setVerificationReport(report: VerificationReport | null): void {
  latestReport = report;
  rebuild();
}

export function subscribeEditorProblems(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function getEditorProblems(): readonly EditorProblem[] {
  return problems;
}

export function resetEditorProblemsStoreForTests(): void {
  diagnosticsByPath = new Map();
  latestReport = null;
  problems = [];
  listeners.clear();
}

// Re-exported for the panel + tests so the canonical bounded/sorted snapshot is built in one place.
export { buildEditorProblemsSnapshot };
