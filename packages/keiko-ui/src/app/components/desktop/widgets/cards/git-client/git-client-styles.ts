// Shared inline-style tokens for the redesigned Git client window (Issue #1574 shell + #1575
// changes/diff/staging/commit, Epic #1571 — "Git Window" redesign handoff). Every value reads an
// existing globals.css custom property so the SHA-pinned globals.css (#1300 gate) stays untouched
// (ADR-0051). No new CSS is introduced — the redesign composes the design-system tokens
// (--surface / --card / --inset / --fg* / --accent* / --line* / --ed-*) via inline styles.
//
// The window renders its own contents only: a connected toolbar (or muted empty toolbar), a
// two-column body (changes/history + diff), and a centred connect panel for the empty state. The
// surrounding window chrome (head, zoom, Lift controls, footer) is provided by the workspace
// window manager, not this card.

import type { CSSProperties } from "react";

// ─── Shell ───────────────────────────────────────────────────────────────────────────────────────

export const WORKSPACE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "100%",
  minWidth: 0,
  background: "var(--card)",
  color: "var(--fg)",
};

// Connected toolbar: a row of left-aligned cells separated by hairlines, a spacer, then the right
// action group. 66px tall at comfortable widths; the cells wrap to additional rows when the window
// is narrowed (e.g. 360px) so every control stays reachable instead of overflowing off-screen
// (#GEN-UI-LAYOUT-003). minHeight (not a fixed height) lets the wrapped rows grow.
export const TOOLBAR_STYLE: CSSProperties = {
  minHeight: 66,
  flex: "none",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "stretch",
  borderBottom: "1px solid var(--line-soft)",
  background: "var(--surface)",
};

// Muted empty toolbar shown before a repository is connected.
export const TOOLBAR_EMPTY_STYLE: CSSProperties = {
  height: 66,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "0 18px",
  borderBottom: "1px solid var(--line-soft)",
  background: "var(--surface)",
};

// A single toolbar cell: leading icon, stacked label/value, trailing chevron.
export const TOOLBAR_CELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "0 18px",
  border: 0,
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  borderRight: "1px solid var(--line-soft)",
};

// Tiny mono caps label above a cell value ("Repository", "Current branch").
export const TOOLBAR_CELL_LABEL_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
  fontFamily: "var(--font-mono)",
  lineHeight: 1.1,
};

export const TOOLBAR_CELL_VALUE_STYLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--fg)",
  lineHeight: 1.1,
};

// Right action group at the end of the toolbar (Open in Editor / Open Files).
export const TOOLBAR_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 16px",
  borderLeft: "1px solid var(--line-soft)",
};

// Two-column body: fixed-width left column + flexing diff pane on the editor background.
export const BODY_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  minHeight: 0,
};

// Left column: 384px at comfortable widths, but capped at 45% of the body so the diff pane keeps a
// usable floor when the window is narrowed to ~360px (#GEN-UI-LAYOUT-003).
export const SIDEBAR_STYLE: CSSProperties = {
  width: "min(384px, 45%)",
  flex: "none",
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  borderRight: "1px solid var(--line-soft)",
  background: "var(--card)",
};

export const PANE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--ed-bg)",
};

// ─── Buttons ─────────────────────────────────────────────────────────────────────────────────────

const BUTTON_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  height: 34,
  padding: "0 13px",
  borderRadius: 9,
  font: "500 12.5px var(--font-ui)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Bordered secondary action (Open in Editor, Open Files, Create pull request, Merge…, Clone).
export const SECONDARY_BTN: CSSProperties = {
  ...BUTTON_BASE,
  border: "1px solid var(--line)",
  background: "var(--card)",
  color: "var(--fg)",
};

// Primary accent action (Commit, Connect repository).
export const PRIMARY_BTN: CSSProperties = {
  ...BUTTON_BASE,
  height: 40,
  padding: "0 18px",
  border: 0,
  background: "var(--accent)",
  color: "var(--ink-inverse)",
  font: "650 13px var(--font-ui)",
};

// Ghost icon button (zoom, split/settings in the diff header).
export function iconButtonStyle(size = 28): CSSProperties {
  return {
    display: "grid",
    placeItems: "center",
    width: size,
    height: size,
    border: 0,
    background: "transparent",
    borderRadius: 8,
    color: "var(--fg-faint)",
    cursor: "pointer",
  };
}

export function disabledStyle(disabled: boolean): CSSProperties {
  return disabled ? { opacity: "var(--opacity-disabled, 0.6)", cursor: "not-allowed" } : {};
}

// ─── Tabs (Changes / History) ────────────────────────────────────────────────────────────────────

export const TABS_ROW_STYLE: CSSProperties = {
  height: 44,
  flex: "none",
  display: "flex",
  alignItems: "stretch",
  padding: "0 8px",
  borderBottom: "1px solid var(--line-soft)",
};

export function tabButtonStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "0 12px",
    border: 0,
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    color: active ? "var(--fg)" : "var(--fg-muted)",
  };
}

export function tabBadgeStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 999,
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    fontWeight: 600,
    background: active ? "var(--accent-dim)" : "var(--inset)",
    color: active ? "var(--accent-on-tint)" : "var(--fg-muted)",
  };
}

export function tabUnderlineStyle(active: boolean): CSSProperties {
  return {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: -1,
    height: 2,
    borderRadius: 2,
    background: active ? "var(--accent)" : "transparent",
  };
}

// ─── Changes list ────────────────────────────────────────────────────────────────────────────────

// Summary strip above the file list: staged check + "N of M files staged" + add/del stats.
export const SUMMARY_STRIP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 14px 6px",
  color: "var(--fg-faint)",
};

export const SUMMARY_CHECK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 15,
  height: 15,
  flex: "none",
  borderRadius: 4,
  background: "var(--accent-solid)",
  color: "var(--accent-solid-ink)",
};

// Bulk stage/unstage action bar (kept from the live surface, restyled).
export const CHANGES_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  padding: "0 14px 8px",
};

export const COMPACT_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 26,
  padding: "0 10px",
  borderRadius: 7,
  border: "1px solid var(--line)",
  background: "var(--card)",
  color: "var(--fg-muted)",
  font: "500 11.5px var(--font-ui)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const FILE_LIST_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "2px 8px 8px",
};

export function fileRowStyle(selected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 11,
    width: "100%",
    padding: "9px 10px",
    border: 0,
    borderRadius: 9,
    cursor: "pointer",
    textAlign: "left",
    background: selected ? "var(--accent-dim)" : "transparent",
    boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
  };
}

// Square stage indicator (16px, leading): checked → accent fill; unchecked → ring.
export function stageBoxStyle(staged: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    flex: "none",
    borderRadius: 5,
    background: staged ? "var(--accent-solid)" : "transparent",
    boxShadow: staged ? "none" : "inset 0 0 0 1.5px var(--line-strong)",
    color: "var(--accent-solid-ink)",
    cursor: "pointer",
  };
}

// Trailing 18px status square (M/A/D/R + tint).
export function statusSquareStyle(status: string): CSSProperties {
  const color = statusColor(status);
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
    flex: "none",
    borderRadius: 5,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 700,
    background: `color-mix(in oklch, ${color} 16%, transparent)`,
    color,
  };
}

// M → info, A → ok, D → danger, R → warn; conflict/untracked map onto the same palette.
export function statusColor(status: string): string {
  switch (status) {
    case "A":
    case "?":
      return "var(--ok)";
    case "D":
      return "var(--danger)";
    case "U":
      return "var(--danger)";
    case "R":
    case "T":
      return "var(--warn)";
    case "M":
    case "C":
    default:
      return "var(--info)";
  }
}

export const FILE_NAME_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "var(--fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export const FILE_PATH_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--fg-faint)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// ─── Commit composer ─────────────────────────────────────────────────────────────────────────────

export const COMMIT_PANEL_STYLE: CSSProperties = {
  flex: "none",
  borderTop: "1px solid var(--line-soft)",
  background: "var(--surface)",
  padding: "13px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

// AI-suggestion header (spark + "Keiko suggested this summary" + Regenerate). Shown only when a
// genuine suggestion exists; never fabricated.
export const AI_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
};

export const GHOST_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: 0,
  background: "transparent",
  color: "var(--fg-faint)",
  font: "500 11.5px var(--font-ui)",
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: 6,
};

// Single-line summary input. The 2px accent edge marks AI-authored content when applicable.
export function summaryFieldStyle(aiAuthored: boolean): CSSProperties {
  return {
    width: "100%",
    minHeight: 38,
    padding: "0 12px",
    borderRadius: 9,
    border: 0,
    background: "var(--inset)",
    boxShadow: aiAuthored
      ? "inset 0 0 0 1px var(--line), inset 2px 0 0 var(--accent)"
      : "inset 0 0 0 1px var(--line)",
    color: "var(--fg)",
    font: "400 13px var(--font-ui)",
  };
}

export const DESCRIPTION_FIELD_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 54,
  padding: "9px 12px",
  borderRadius: 9,
  border: 0,
  background: "var(--inset)",
  boxShadow: "inset 0 0 0 1px var(--line)",
  color: "var(--fg-muted)",
  font: "400 13px var(--font-ui)",
  lineHeight: 1.5,
  resize: "vertical",
};

export const COAUTHOR_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  flexWrap: "wrap",
};

export const COAUTHOR_CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--accent-on-tint)",
  background: "var(--accent-dim)",
  padding: "2px 8px",
  borderRadius: 999,
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
};

export const FLOW_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

// ─── Diff pane ───────────────────────────────────────────────────────────────────────────────────

export const DIFF_HEADER_STYLE: CSSProperties = {
  height: 44,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "0 14px",
  borderBottom: "1px solid var(--line-soft)",
  background: "var(--surface)",
};

export const DIFF_PATH_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-faint)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

export const EXPLAIN_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 11px",
  borderRadius: 8,
  border: "1px solid var(--accent-line)",
  background: "var(--accent-dim)",
  color: "var(--accent-text)",
  font: "600 12px var(--font-ui)",
  cursor: "pointer",
};

// Diff scope segmented toggle (Worktree / Staged).
export const SCOPE_TOGGLE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: "var(--inset)",
  boxShadow: "inset 0 0 0 1px var(--line)",
};

export function scopeButtonStyle(active: boolean): CSSProperties {
  return {
    appearance: "none",
    height: 22,
    padding: "0 10px",
    borderRadius: 6,
    border: 0,
    background: active ? "var(--card)" : "transparent",
    color: active ? "var(--fg)" : "var(--fg-muted)",
    font: `${active ? 600 : 500} 11px var(--font-ui)`,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

// Agent "Explain diff" card. Rendered only when a genuine explanation is available.
export const AGENT_CARD_STYLE: CSSProperties = {
  position: "relative",
  margin: "12px 14px 4px",
  padding: "12px 13px",
  borderRadius: 12,
  background: "var(--accent-dim)",
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
  display: "flex",
  gap: 11,
};

export const AGENT_AVATAR_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  flex: "none",
  borderRadius: 8,
  background: "var(--card)",
  color: "var(--accent-text)",
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
};

export const CITATION_CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--accent-on-tint)",
  background: "var(--card)",
  padding: "2px 8px",
  borderRadius: 6,
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
};

// Footer kept for the connected diff pane (PR/Merge live in the composer now; this stays for the
// PR/Merge sub-panels' back action header).
export const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 14px",
  borderTop: "1px solid var(--line-soft)",
  background: "var(--surface)",
};

// ─── History ─────────────────────────────────────────────────────────────────────────────────────

export const HISTORY_LIST_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 0,
};

export function commitRowStyle(selected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 11,
    width: "100%",
    padding: "11px 10px",
    border: 0,
    borderRadius: 9,
    cursor: "pointer",
    textAlign: "left",
    background: selected ? "var(--accent-dim)" : "transparent",
    boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
  };
}

export function avatarStyle(size: number): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    flex: "none",
    borderRadius: "50%",
    background: "var(--accent-dim)",
    color: "var(--accent-text)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    boxShadow: "inset 0 0 0 1px var(--accent-line)",
  };
}

export const HEAD_PILL_STYLE: CSSProperties = {
  display: "inline-flex",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontWeight: 600,
  color: "var(--accent-on-tint)",
  background: "var(--accent-dim)",
  padding: "1px 6px",
  borderRadius: 999,
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
};

export const HASH_CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--fg-muted)",
  background: "var(--inset)",
  padding: "1px 7px",
  borderRadius: 6,
};

// Commit-detail header in the right pane (History view).
export const COMMIT_DETAIL_HEADER_STYLE: CSSProperties = {
  flex: "none",
  padding: "13px 16px",
  borderBottom: "1px solid var(--line-soft)",
  background: "var(--surface)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

// ─── Connect / empty state ───────────────────────────────────────────────────────────────────────

export const CONNECT_WRAP_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 40,
  overflowY: "auto",
};

export const CONNECT_COLUMN_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 520,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
};

export const CONNECT_MEDALLION_STYLE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 72,
  height: 72,
  borderRadius: 20,
  background: "var(--inset)",
  color: "var(--fg-dim)",
  boxShadow: "inset 0 0 0 1px var(--line-soft)",
};

export const CONNECT_TITLE_STYLE: CSSProperties = {
  fontSize: 19,
  fontWeight: 600,
  color: "var(--fg)",
  marginTop: 20,
  letterSpacing: "-0.01em",
};

export const CONNECT_SUBTITLE_STYLE: CSSProperties = {
  fontSize: 13.5,
  color: "var(--fg-muted)",
  lineHeight: 1.6,
  marginTop: 8,
  maxWidth: 400,
};

export const RECENT_LABEL_STYLE: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
  fontFamily: "var(--font-mono)",
  marginBottom: 8,
};

export function recentRowStyle(selected: boolean): CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "11px 13px",
    borderRadius: 11,
    border: selected ? "1px solid var(--accent-line)" : "1px solid var(--line-soft)",
    background: selected ? "var(--accent-dim)" : "var(--card)",
    cursor: "pointer",
    textAlign: "left",
  };
}

export const RECENT_MEDALLION_STYLE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 34,
  height: 34,
  flex: "none",
  borderRadius: 9,
  background: "var(--accent-dim)",
  color: "var(--accent-text)",
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
};

export const AGENT_HINT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  marginTop: 22,
  padding: "11px 13px",
  borderRadius: 11,
  background: "var(--accent-dim)",
  boxShadow: "inset 0 0 0 1px var(--accent-line)",
  textAlign: "left",
};

// ─── Shared text + preview ───────────────────────────────────────────────────────────────────────

export const SUBTLE_TEXT_STYLE: CSSProperties = {
  margin: 0,
  font: "400 13px var(--font-ui)",
  color: "var(--fg-muted)",
};

export const MONO_PATH_STYLE: CSSProperties = {
  display: "block",
  marginTop: 2,
  font: "400 11px var(--font-mono)",
  color: "var(--fg-faint)",
  overflowWrap: "anywhere",
};

export const MONO_INLINE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--accent-text)",
};

export const EMPTY_STATE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  flex: 1,
  minHeight: 0,
  padding: 28,
  textAlign: "center",
  color: "var(--fg-muted)",
};

// Live, secondary commit-policy preview block.
export const PREVIEW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 9,
  background: "var(--inset)",
  boxShadow: "inset 0 0 0 1px var(--line)",
};

// ─── Shared menu / dropdown primitives (branch picker, repository list) ───────────────────────────

export const INPUT_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 34,
  padding: "0 12px",
  border: 0,
  borderRadius: 9,
  background: "var(--inset)",
  boxShadow: "inset 0 0 0 1px var(--line)",
  color: "var(--fg)",
  font: "400 13px var(--font-ui)",
};

export const TEXTAREA_STYLE: CSSProperties = {
  ...DESCRIPTION_FIELD_STYLE,
};

export const MENU_STYLE: CSSProperties = {
  position: "absolute",
  zIndex: 20,
  top: "calc(100% + 6px)",
  left: 0,
  width: 300,
  maxWidth: "min(80vw, 360px)",
  borderRadius: 11,
  background: "var(--card)",
  boxShadow: "var(--shadow-pop)",
  padding: 8,
};

export const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  overflow: "auto",
  flex: 1,
  minHeight: 0,
};

export const REPO_OPTION_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  border: 0,
  borderRadius: 9,
  background: "transparent",
  color: "var(--fg)",
  cursor: "pointer",
  minWidth: 0,
};

export const REPO_OPTION_SELECTED_STYLE: CSSProperties = {
  background: "var(--accent-dim)",
  boxShadow: "inset 2px 0 0 var(--accent)",
};

export const SEARCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: 12,
  borderBottom: "1px solid var(--line-soft)",
};

export const STATUS_PILL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 10px",
  borderRadius: 999,
  background: "var(--inset)",
  boxShadow: "inset 0 0 0 1px var(--line)",
  color: "var(--fg-muted)",
  font: "600 11px var(--font-ui)",
  whiteSpace: "nowrap",
};
