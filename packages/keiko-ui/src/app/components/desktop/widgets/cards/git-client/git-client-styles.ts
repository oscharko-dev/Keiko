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
  outline: "none",
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
