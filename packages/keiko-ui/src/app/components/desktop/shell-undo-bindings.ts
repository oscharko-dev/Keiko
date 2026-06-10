// Epic #518 / Issue #527 — Shell-level undo apply dispatcher + shortcut bindings.
//
// These are extracted from AppShell so the integration is unit-testable
// without mounting the full AppShell (which depends on ChatSessionProvider,
// TwinProvider, WsContext, WebSocket, and the workspace render tree).

import type {
  WorkspaceKeyboardShortcutBinding,
  WorkspaceUiAction,
} from "@oscharko-dev/keiko-contracts";
import { WIN_TYPES, type WindowType } from "./windows/WindowsRegistry";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";

// ─── Apply dispatcher ─────────────────────────────────────────────────────
//
// Maps an inverse WorkspaceUiAction back onto the workspace API. Currently
// wired for ui.panel.toggle; additional action kinds plug in here as
// future call sites instrument them. The dispatcher is pure with respect
// to the supplied WorkspaceApi so it can be exercised with a fake api in
// tests.

export function applyShellUndoAction(api: WorkspaceApi, action: WorkspaceUiAction): void {
  if (action.kind === "ui.panel.toggle" && action.panel in WIN_TYPES) {
    api.toggleTool(action.panel as WindowType);
  }
}

// ─── Shortcut bindings ────────────────────────────────────────────────────
//
// The shell-level keyboard contract is small by design (per ADR-0028 and
// the UX blueprint minimum shortcut set). Cmd+K palette-open stays inline
// in AppShell to preserve regression-free behaviour. The two undo/redo
// chords are routed through useKeyboardShortcuts so the conflict-at-startup
// + reserved-chord refusal contract applies.

export const SHELL_SHORTCUT_BINDINGS: readonly WorkspaceKeyboardShortcutBinding[] = [
  { commandId: "undo", chord: { key: "z", mod: ["cmd"] } },
  { commandId: "redo", chord: { key: "z", mod: ["cmd", "shift"] } },
  { commandId: "focus-status", chord: { key: "s", mod: ["alt"] } },
];
