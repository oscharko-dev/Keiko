/**
 * Pure derivation of the editor status-bar view model (Issue #1205).
 *
 * The status bar communicates editor state "without clutter" (Acceptance Criterion 3) and gives
 * screen-reader users meaningful, debounced status (Acceptance Criterion 5). All wording, ordering,
 * tone, and — crucially — which fields are *announced* live versus read only on demand is decided
 * here, so the contract is node-testable and the component stays a thin render.
 *
 * The cursor field is deliberately **not** announced: it changes on every keystroke and an `aria-live`
 * region over it would flood assistive tech. Only meaningful state — dirty/save outcome, diagnostics,
 * and run state — feeds {@link EditorStatusBarViewModel.liveSummary}, the single polite live region.
 */
import type { EditorLanguageId } from "../languages.js";
import type { EditorSaveStatus } from "./types.js";

/** Human-readable language label for the status bar, keyed by every governed {@link EditorLanguageId}. */
const LANGUAGE_LABELS: Readonly<Record<EditorLanguageId, string>> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  markdown: "Markdown",
  yaml: "YAML",
  python: "Python",
  java: "Java",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  shell: "Shell",
  plaintext: "Plain Text",
};

/** Resolve a governed language id to its display label. The map is exhaustive over the closed union. */
export function editorLanguageLabel(languageId: EditorLanguageId): string {
  return LANGUAGE_LABELS[languageId];
}

/** Diagnostic counts surfaced by the diagnostics bridge after each analysis (content-free). */
export interface EditorDiagnosticsSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

/** Visual emphasis for a status field; maps to a CSS tone class in the component. */
export type EditorStatusTone = "default" | "accent" | "warn" | "error";

/** A short, content-free description of the governed run/verification flow (#1202), host-derived. */
export interface EditorStatusRun {
  readonly label: string;
  readonly busy: boolean;
}

export interface EditorStatusLanguageService {
  readonly providerId: string | null;
  readonly available: boolean;
  readonly unavailableReason?: string | undefined;
}

/** Host-supplied inputs for {@link deriveEditorStatusBar}. Cursor is the 0-based editor contract. */
export interface EditorStatusBarInput {
  readonly languageId: EditorLanguageId;
  readonly cursor: { readonly line: number; readonly column: number } | null;
  /** Number of lines spanned by the current selection; omitted/≤1 hides the selection field. */
  readonly selectedLineCount?: number | undefined;
  readonly saveStatus: EditorSaveStatus;
  readonly dirty: boolean;
  readonly completionsEnabled: boolean;
  readonly largeFileMode?: "normal" | "degraded" | undefined;
  readonly diagnostics: EditorDiagnosticsSummary | null;
  readonly languageService?: EditorStatusLanguageService | undefined;
  readonly run?: EditorStatusRun | undefined;
  readonly readOnly?: boolean | undefined;
}

/**
 * One rendered status-bar cell.
 *
 * `live` fields contribute to an announced summary (the cursor never does). `assertive` fields are
 * the critical ones (a failed/conflicting save) that interrupt with `role="alert"`; non-assertive
 * live fields are announced politely. This mirrors the editor footer's proven status↔alert split
 * without mutating a single region's role.
 */
export interface EditorStatusField {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly tone: EditorStatusTone;
  readonly live: boolean;
  readonly assertive: boolean;
}

export interface EditorStatusBarViewModel {
  readonly fields: readonly EditorStatusField[];
  /** Polite screen-reader summary of meaningful, non-critical changes (never the cursor position). */
  readonly liveSummary: string;
  /** Assertive summary of critical state (a failed or conflicting save); empty when none. */
  readonly alertSummary: string;
}

function pluralize(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function cursorField(cursor: EditorStatusBarInput["cursor"]): EditorStatusField {
  if (cursor === null) {
    return {
      id: "cursor",
      label: "Ln —, Col —",
      ariaLabel: "Cursor position unavailable",
      tone: "default",
      live: false,
      assertive: false,
    };
  }
  // The contract is 0-based; humans (and VS Code) count lines and columns from 1.
  const line = cursor.line + 1;
  const column = cursor.column + 1;
  return {
    id: "cursor",
    label: `Ln ${String(line)}, Col ${String(column)}`,
    ariaLabel: `Line ${String(line)}, column ${String(column)}`,
    tone: "default",
    live: false,
    assertive: false,
  };
}

function saveField(input: EditorStatusBarInput): EditorStatusField {
  const base = { id: "save", live: true } as const;
  switch (input.saveStatus) {
    case "saving":
      return { ...base, label: "Saving…", ariaLabel: "Saving", tone: "accent", assertive: false };
    case "error":
      // A failed or conflicting save is critical and announced assertively (role="alert").
      return {
        ...base,
        label: "Save failed",
        ariaLabel: "Save failed",
        tone: "error",
        assertive: true,
      };
    case "conflict":
      return {
        ...base,
        label: "Conflict",
        ariaLabel: "Save conflict: the file changed elsewhere",
        tone: "warn",
        assertive: true,
      };
    case "idle":
    case "saved":
      break;
  }
  if (input.dirty) {
    return {
      ...base,
      label: "Unsaved",
      ariaLabel: "Unsaved changes",
      tone: "accent",
      assertive: false,
    };
  }
  return {
    ...base,
    label: "Saved",
    ariaLabel: "All changes saved",
    tone: "default",
    assertive: false,
  };
}

function diagnosticsField(summary: EditorDiagnosticsSummary | null): EditorStatusField | null {
  if (summary === null) {
    return null;
  }
  const { errors, warnings, infos } = summary;
  if (errors === 0 && warnings === 0 && infos === 0) {
    return {
      id: "problems",
      label: "No problems",
      ariaLabel: "No problems",
      tone: "default",
      live: true,
      assertive: false,
    };
  }
  const tone: EditorStatusTone = errors > 0 ? "error" : warnings > 0 ? "warn" : "default";
  const parts: string[] = [];
  if (errors > 0) parts.push(pluralize(errors, "error"));
  if (warnings > 0) parts.push(pluralize(warnings, "warning"));
  if (infos > 0) parts.push(pluralize(infos, "info"));
  const ariaLabel = `Problems: ${parts.join(", ")}`;
  const label = `${String(errors)} ⚠ ${String(warnings)}`;
  // Diagnostics are informational and announced politely; they never interrupt with an alert.
  return { id: "problems", label, ariaLabel, tone, live: true, assertive: false };
}

function runField(run: EditorStatusRun | undefined): EditorStatusField | null {
  if (run === undefined) {
    return null;
  }
  return {
    id: "run",
    label: run.label,
    ariaLabel: run.label,
    tone: run.busy ? "accent" : "default",
    live: true,
    assertive: false,
  };
}

function languageServiceField(
  service: EditorStatusLanguageService | undefined,
): EditorStatusField | null {
  if (service === undefined) return null;
  if (!service.available) {
    return {
      id: "language-service",
      label: "LSP unavailable",
      ariaLabel:
        service.unavailableReason === undefined
          ? "Language provider unavailable"
          : `Language provider unavailable: ${service.unavailableReason}`,
      tone: "warn",
      live: false,
      assertive: false,
    };
  }
  return {
    id: "language-service",
    label: service.providerId === null ? "Language ready" : `${service.providerId} ready`,
    ariaLabel:
      service.providerId === null
        ? "Language provider available"
        : `Language provider available: ${service.providerId}`,
    tone: "default",
    live: false,
    assertive: false,
  };
}

function selectionField(selectedLineCount: number | undefined): EditorStatusField | null {
  if (selectedLineCount === undefined || selectedLineCount <= 1) {
    return null;
  }
  const label = `${String(selectedLineCount)} lines selected`;
  return {
    id: "selection",
    label,
    ariaLabel: label,
    tone: "default",
    live: false,
    assertive: false,
  };
}

function largeFileField(mode: "normal" | "degraded" | undefined): EditorStatusField | null {
  if (mode !== "degraded") {
    return null;
  }
  return {
    id: "large-file",
    label: "Large file mode",
    ariaLabel: "Large file mode: completions and analysis disabled",
    tone: "warn",
    live: true,
    assertive: false,
  };
}

function languageField(languageId: EditorLanguageId): EditorStatusField {
  return {
    id: "language",
    label: editorLanguageLabel(languageId),
    ariaLabel: `Language: ${editorLanguageLabel(languageId)}`,
    tone: "default",
    live: false,
    assertive: false,
  };
}

function readonlyField(readOnly: boolean | undefined): EditorStatusField | null {
  if (readOnly !== true) return null;
  return {
    id: "readonly",
    label: "Read-only",
    ariaLabel: "Read-only document",
    tone: "warn",
    live: true,
    assertive: false,
  };
}

function completionsField(enabled: boolean): EditorStatusField {
  return {
    id: "completions",
    label: enabled ? "Completions on" : "Completions off",
    ariaLabel: enabled ? "Governed completions enabled" : "Governed completions unavailable for this file type",
    tone: "default",
    live: false,
    assertive: false,
  };
}

function pushOptional(fields: EditorStatusField[], field: EditorStatusField | null): void {
  if (field !== null) fields.push(field);
}

function statusSummary(fields: readonly EditorStatusField[], assertive: boolean): string {
  return fields
    .filter((field) => field.live && field.assertive === assertive)
    .map((field) => field.ariaLabel)
    .join(". ");
}

/**
 * Derive the status-bar view model from host state. Field order mirrors a serious editor: the
 * document identity (language, read-only) leads, then live editing signals (problems, run, save),
 * with cursor/selection as on-demand position fields. Only `live` fields feed {@link
 * EditorStatusBarViewModel.liveSummary}.
 */
export function deriveEditorStatusBar(input: EditorStatusBarInput): EditorStatusBarViewModel {
  const fields: EditorStatusField[] = [];

  fields.push(languageField(input.languageId));
  pushOptional(fields, readonlyField(input.readOnly));
  fields.push(completionsField(input.completionsEnabled));
  pushOptional(fields, largeFileField(input.largeFileMode));
  pushOptional(fields, diagnosticsField(input.diagnostics));
  pushOptional(fields, languageServiceField(input.languageService));
  pushOptional(fields, runField(input.run));
  fields.push(cursorField(input.cursor));
  pushOptional(fields, selectionField(input.selectedLineCount));
  fields.push(saveField(input));

  // Polite summary: meaningful, non-critical live fields. Assertive summary: critical fields only.
  // Splitting them keeps the cursor out of every announcement and lets a save error/conflict
  // interrupt without mutating a single region's role.
  return { fields, liveSummary: statusSummary(fields, false), alertSummary: statusSummary(fields, true) };
}
