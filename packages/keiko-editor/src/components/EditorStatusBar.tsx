"use client";

/**
 * `EditorStatusBar` — the editor's compact, accessible status strip (Issue #1205).
 *
 * Presentational and host-agnostic: it renders a fully-derived {@link EditorStatusBarViewModel} (the
 * host computes it with {@link import("./status-bar.js").deriveEditorStatusBar}). It owns no state and
 * imports no Monaco, so it stays node-renderable and reusable outside `keiko-ui` (ADR-0042 D1).
 *
 * Accessibility contract (Acceptance Criteria 3 & 5): the visible fields are a labelled `group` read
 * on demand by assistive tech as the user navigates. Two visually-hidden live regions announce
 * changes — a polite `status` region for meaningful non-critical state (`liveSummary`: save progress,
 * diagnostics, run state) and an assertive `alert` region for critical state (`alertSummary`: a failed
 * or conflicting save). The cursor — which changes on every keystroke — is in neither region.
 */
import { type ReactElement } from "react";

import type { EditorStatusBarViewModel, EditorStatusTone } from "./status-bar.js";

export interface EditorStatusBarProps {
  readonly viewModel: EditorStatusBarViewModel;
}

const TONE_CLASS: Readonly<Record<EditorStatusTone, string>> = {
  default: "",
  accent: "ed-sb-accent",
  warn: "ed-sb-warn",
  error: "ed-sb-error",
};

export function EditorStatusBar({ viewModel }: EditorStatusBarProps): ReactElement {
  return (
    <div
      className="ed-statusbar"
      role="group"
      aria-label="Editor status"
      data-testid="editor-status-bar"
    >
      {viewModel.fields.map((field) => {
        const toneClass = TONE_CLASS[field.tone];
        return (
          <span
            key={field.id}
            className={toneClass.length > 0 ? `ed-sb-field ${toneClass}` : "ed-sb-field"}
            data-field={field.id}
            aria-label={field.ariaLabel}
            title={field.ariaLabel}
          >
            {field.label}
          </span>
        );
      })}
      <span
        className="ed-sb-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="editor-status-bar-live"
      >
        {viewModel.liveSummary}
      </span>
      <span
        className="ed-sb-live"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="editor-status-bar-alert"
      >
        {viewModel.alertSummary}
      </span>
    </div>
  );
}
