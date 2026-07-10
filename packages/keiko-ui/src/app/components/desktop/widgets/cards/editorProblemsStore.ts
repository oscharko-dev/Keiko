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

// ─── Module-level store, scoped per project root (Epic #2092 fix-up) ─────────────────────────────
// The desktop shell supports multiple simultaneously mounted editor windows bound to different
// project roots (see WindowsRegistry/resolveBoundRoot). A single process-wide store would let a
// project A diagnostic silently overwrite a same-relative-path project B diagnostic, and would make
// one project's problems appear in another project's panel. Each root gets its own aggregation.
interface ProjectProblemsState {
  diagnosticsByPath: Map<string, readonly EditorDiagnostic[]>;
  latestReport: VerificationReport | null;
  problems: readonly EditorProblem[];
  readonly listeners: Set<() => void>;
}

const projectStates = new Map<string, ProjectProblemsState>();

function projectState(root: string): ProjectProblemsState {
  let entry = projectStates.get(root);
  if (entry === undefined) {
    entry = {
      diagnosticsByPath: new Map(),
      latestReport: null,
      problems: [],
      listeners: new Set(),
    };
    projectStates.set(root, entry);
  }
  return entry;
}

function rebuild(entry: ProjectProblemsState): void {
  entry.problems = buildAllProblems(entry.diagnosticsByPath, entry.latestReport);
  for (const listener of [...entry.listeners]) listener();
}

export function setPaneDiagnostics(
  root: string,
  path: string,
  diagnostics: readonly EditorDiagnostic[],
): void {
  const entry = projectState(root);
  const next = new Map(entry.diagnosticsByPath);
  if (diagnostics.length === 0) next.delete(path);
  else next.set(path, diagnostics);
  entry.diagnosticsByPath = next;
  rebuild(entry);
}

export function removePaneDiagnostics(root: string, path: string): void {
  const entry = projectStates.get(root);
  if (entry === undefined || !entry.diagnosticsByPath.has(path)) return;
  const next = new Map(entry.diagnosticsByPath);
  next.delete(path);
  entry.diagnosticsByPath = next;
  rebuild(entry);
}

export function setVerificationReport(root: string, report: VerificationReport | null): void {
  const entry = projectState(root);
  entry.latestReport = report;
  rebuild(entry);
}

export function subscribeEditorProblems(root: string, listener: () => void): () => void {
  const entry = projectState(root);
  entry.listeners.add(listener);
  return (): void => {
    entry.listeners.delete(listener);
    if (
      entry.listeners.size === 0 &&
      entry.diagnosticsByPath.size === 0 &&
      entry.latestReport === null
    ) {
      projectStates.delete(root);
    }
  };
}

export function getEditorProblems(root: string): readonly EditorProblem[] {
  return projectStates.get(root)?.problems ?? [];
}

export function resetEditorProblemsStoreForTests(): void {
  projectStates.clear();
}

// Re-exported for the panel + tests so the canonical bounded/sorted snapshot is built in one place.
export { buildEditorProblemsSnapshot };
