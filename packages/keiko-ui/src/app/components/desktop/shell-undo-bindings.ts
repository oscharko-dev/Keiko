// Epic #518 / Issue #527 — Shell-level undo apply dispatcher.
//
// Extracted from AppShell so the integration is unit-testable without mounting the full
// AppShell (which depends on ChatSessionProvider, TwinProvider, WsContext, WebSocket, and
// the workspace render tree).
//
// The shell's live keyboard binding table is NOT here: it is resolved from the user's keybinding
// overrides in `shellShortcutState.ts`, which is what AppShell feeds to `useKeyboardShortcuts`. A
// second, hardcoded copy of that table used to live in this file with its own reserved/conflict
// pins; nothing read it, so those pins guarded a constant instead of the table the product
// dispatches. They now sit next to the live table in `shellShortcutState.test.ts`.

import type { WorkspaceUiAction } from "@oscharko-dev/keiko-contracts";
import { WIN_TYPES, type WindowType } from "./windows/WindowsRegistry";
import type { AppWindow } from "./windows/types";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";

// ─── Panel openness ───────────────────────────────────────────────────────
//
// The shell's single definition of "this panel is open": a window of that type exists and is not
// minimized. Both sides of undo read it through here — the `before`/`after` state recorded at
// toggle time and the live state the apply dispatcher compares against — so the recorded state and
// the applied state cannot drift apart on two copies of the same rule.

export function shellPanelIsOpen(wins: readonly AppWindow[] | null, panel: WindowType): boolean {
  const existing = wins?.find((win) => win.type === panel);
  return existing !== undefined && existing.minimized !== true;
}

// ─── Apply dispatcher ─────────────────────────────────────────────────────
//
// Maps an inverse WorkspaceUiAction back onto the workspace API. Currently
// wired for ui.panel.toggle; additional action kinds plug in here as
// future call sites instrument them. The dispatcher is pure with respect
// to the supplied ShellUndoTarget so it can be exercised with a fake api in
// tests.

/** What the dispatcher needs from the shell: the workspace API, plus a live openness read. */
export interface ShellUndoTarget {
  readonly api: WorkspaceApi;
  readonly isPanelOpen: (panel: WindowType) => boolean;
}

// Audit — this used to call `api.toggleTool(panel)` unconditionally: a STATE-DEPENDENT flip that
// reverses whatever the panel happens to be right now instead of applying what the action recorded.
// Toggle a panel open, close it by hand, then press Cmd+Z: the recorded state to restore is
// "closed", but the flip re-OPENED it. The dispatcher now applies the RECORDED state — the action's
// target state is compared against the live one and the transition runs only when the two differ,
// so replaying an action that is already satisfied is a no-op instead of a divergence.
export function applyShellUndoAction(target: ShellUndoTarget, action: WorkspaceUiAction): void {
  if (action.kind !== "ui.panel.toggle" || !(action.panel in WIN_TYPES)) return;
  const panel = action.panel as WindowType;
  // On an inverse action `after` is the state undo must restore; on a redo it is the state the
  // original action produced. Either way it is the recorded target state.
  const recordedOpen = action.after;
  if (target.isPanelOpen(panel) === recordedOpen) return;
  if (recordedOpen && panel === "search" && action.searchRoot !== undefined) {
    target.api.add("search", { root: action.searchRoot });
    return;
  }
  if (recordedOpen && panel === "governedGit" && action.projectRoot !== undefined) {
    target.api.add("governedGit", {
      projectPath: action.projectRoot,
      rootBinding: "coding-repository",
    });
    return;
  }
  target.api.toggleTool(panel);
}
