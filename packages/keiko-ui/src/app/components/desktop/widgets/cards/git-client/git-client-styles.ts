// Shared inline-style tokens for the Git client shell (Issue #1574). Every value reads an existing
// globals.css custom property so the SHA-pinned globals.css (#1300 gate) stays untouched (ADR-0051,
// the same approach the removed GovernedGitFlowCard used). No new CSS is introduced.

import type { CSSProperties } from "react";

export const WORKSPACE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "100%",
  minWidth: 0,
  background: "var(--surface-primary)",
};

export const TOOLBAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-4)",
  flexWrap: "wrap",
  padding: "var(--space-4) var(--space-5)",
  borderBottom: "1px solid var(--border-subtle)",
  background: "var(--surface-primary)",
};

export const BODY_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.34fr) minmax(0, 1fr)",
  gap: 0,
  flex: 1,
  minHeight: 0,
};

export const SIDEBAR_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  borderRight: "1px solid var(--border-subtle)",
  background: "var(--surface-primary)",
};

export const PANE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  background: "var(--surface-primary)",
};

export const SEARCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-4)",
  borderBottom: "1px solid var(--border-subtle)",
};

export const INPUT_STYLE: CSSProperties = {
  width: "100%",
  minHeight: "var(--control-height)",
  padding: "0 var(--control-pad-x)",
  border: "1px solid var(--input-border)",
  borderRadius: "var(--radius-control)",
  background: "var(--input-surface)",
  color: "var(--input-text)",
  font: "var(--text-body-sm) var(--font-ui)",
};

export const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: "var(--space-3)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  overflow: "auto",
  flex: 1,
  minHeight: 0,
};

export const REPO_OPTION_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "var(--space-3) var(--space-4)",
  border: "1px solid transparent",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  minWidth: 0,
};

export const REPO_OPTION_SELECTED_STYLE: CSSProperties = {
  border: "1px solid var(--border-accent)",
  background: "var(--surface-inset)",
};

export const SUBTLE_TEXT_STYLE: CSSProperties = {
  margin: 0,
  font: "var(--text-body-sm) var(--font-ui)",
  color: "var(--text-secondary)",
};

export const MONO_PATH_STYLE: CSSProperties = {
  display: "block",
  marginTop: 2,
  font: "var(--text-caption) var(--font-mono)",
  color: "var(--text-secondary)",
  overflowWrap: "anywhere",
};

export const EMPTY_STATE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-3)",
  flex: 1,
  minHeight: 0,
  padding: "var(--space-7)",
  textAlign: "center",
  color: "var(--text-secondary)",
};

export const BUTTON_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-3)",
  minHeight: "var(--control-height)",
  padding: "0 var(--control-pad-x)",
  borderRadius: "var(--radius-control)",
  font: "var(--weight-medium) var(--text-body-sm) var(--font-ui)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const PRIMARY_BTN: CSSProperties = {
  ...BUTTON_BASE,
  border: "1px solid transparent",
  background: "var(--button-primary-surface)",
  color: "var(--button-primary-text)",
  fontWeight: "var(--weight-semibold)",
};

export const SECONDARY_BTN: CSSProperties = {
  ...BUTTON_BASE,
  border: "1px solid var(--button-secondary-border)",
  background: "var(--button-secondary-surface)",
  color: "var(--button-secondary-text)",
};

export const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-4)",
  padding: "var(--space-4) var(--space-5)",
  borderTop: "1px solid var(--border-subtle)",
  background: "var(--surface-primary)",
};

export function disabledStyle(disabled: boolean): CSSProperties {
  return disabled ? { opacity: "var(--opacity-disabled)", cursor: "not-allowed" } : {};
}

export const STATUS_PILL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "3px 10px",
  borderRadius: "var(--radius-pill)",
  border: "1px solid color-mix(in oklch, var(--text-secondary) 42%, transparent)",
  background: "var(--surface-inset)",
  color: "var(--text-secondary)",
  font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
  whiteSpace: "nowrap",
};

// ─── Staging + commit composer tokens (Issue #1575) ──────────────────────────────────────────────
// Carried forward from the removed GovernedGitFlowCard surface; every value reads an existing
// globals.css custom property so the SHA-pinned globals.css (#1300 gate) stays untouched (ADR-0051).

// Header row above the changed-file list carrying the stage-all / unstage-all actions.
export const CHANGES_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  flexWrap: "wrap",
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-subtle)",
};

// Compact secondary button used for stage-all / unstage-all and the diff scope toggle.
export const COMPACT_BTN: CSSProperties = {
  ...BUTTON_BASE,
  minHeight: "var(--control-height-sm, 26px)",
  padding: "0 var(--space-4)",
  gap: "var(--space-2)",
  font: "var(--weight-medium) var(--text-caption) var(--font-ui)",
  border: "1px solid var(--button-secondary-border)",
  background: "var(--button-secondary-surface)",
  color: "var(--button-secondary-text)",
};

// A single changed-file row: native checkbox + status glyph + path + indicator badges.
export const FILE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid transparent",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  minWidth: 0,
};

export const FILE_ROW_SELECTED_STYLE: CSSProperties = {
  border: "1px solid var(--border-accent)",
  background: "var(--surface-inset)",
};

export const FILE_SELECT_BTN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-primary)",
  textAlign: "left",
  cursor: "pointer",
  padding: 0,
};

// Small text indicator (Staged / Untracked / Conflict) — never colour alone, always a word.
export function badgeStyle(tone: "accent" | "warning" | "danger" | "neutral"): CSSProperties {
  const color =
    tone === "accent"
      ? "var(--text-accent)"
      : tone === "warning"
        ? "var(--feedback-warning)"
        : tone === "danger"
          ? "var(--feedback-danger)"
          : "var(--text-secondary)";
  return {
    flexShrink: 0,
    padding: "1px 7px",
    borderRadius: "var(--radius-pill)",
    border: `1px solid color-mix(in oklch, ${color} 40%, transparent)`,
    background: `color-mix(in oklch, ${color} 12%, transparent)`,
    color,
    font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
    whiteSpace: "nowrap",
  };
}

// Pinned commit composer beneath the changed-file list.
export const COMMIT_PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4)",
  borderTop: "1px solid var(--border-subtle)",
  background: "var(--surface-primary)",
};

export const TEXTAREA_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  minHeight: 64,
  padding: "var(--space-3) var(--control-pad-x)",
  resize: "vertical",
  lineHeight: "var(--leading-normal)",
};

export const FIELD_LABEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  minWidth: 0,
  font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--text-faint)",
};

export const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  flexWrap: "wrap",
};

export const PREVIEW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-control)",
  background: "var(--surface-inset)",
};

export const MONO_INLINE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-caption)",
  color: "var(--text-accent)",
};

// Diff scope segmented toggle (Worktree / Staged).
export const SCOPE_TOGGLE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  padding: 2,
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border-subtle)",
  background: "var(--surface-inset)",
};

export function scopeButtonStyle(active: boolean): CSSProperties {
  return {
    appearance: "none",
    minHeight: "var(--control-height-sm, 26px)",
    padding: "0 var(--space-4)",
    borderRadius: "var(--radius-control)",
    border: "1px solid transparent",
    background: active ? "var(--surface-primary)" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    font: `${active ? "var(--weight-semibold)" : "var(--weight-medium)"} var(--text-caption) var(--font-ui)`,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

export const DIFF_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  flexWrap: "wrap",
  padding: "var(--space-3) var(--space-4)",
  borderBottom: "1px solid var(--border-subtle)",
};
