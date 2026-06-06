// Epic #518 / Issue #527 — Workspace UI interaction substrate contracts.
//
// These types are consumed by the workspace UI (`@oscharko-dev/keiko-ui`)
// and by the registration-time descriptor validator that #528 lands. They
// have no runtime cost; they are the typed contract that makes the
// workspace's command + undo + keyboard substrate reviewable.
//
// The Action union is the load-bearing guarantee for ADR-0028. It declares
// constructors only for UI-state mutations. There is no Action variant for
// evidence creation, applied patches, verification records, model calls,
// tool execution, memory writes, workspace FS writes, or durable config
// writes — so the undo stack cannot record or reverse those classes. The
// refusal is compile-time, not runtime.
//
// File name `workspace-ui.ts` avoids a collision with the existing
// `workspace.ts` that owns the `@oscharko-dev/keiko-workspace` package
// types.

// ─── Geometry (re-used by ui Action variants) ─────────────────────────────

export interface WorkspaceUiRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface WorkspaceUiView {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

export interface WorkspaceUiSelectionState {
  readonly focusedWindowId: string | null;
  readonly selectedWindowIds: readonly string[];
}

// ─── Command record ──────────────────────────────────────────────────────

export type WorkspaceCommandAuthority =
  | "user"
  | "user-confirm"
  | "agent-proposal"
  | "tool"
  | "model";

export type WorkspaceCommandCategory =
  | "workspace"
  | "window"
  | "selection"
  | "navigation"
  | "review"
  | "verification"
  | "evidence"
  | "model";

export type WorkspaceKeyChordModifier = "cmd" | "ctrl" | "alt" | "shift";

export interface WorkspaceKeyChord {
  readonly key: string;
  readonly mod: readonly WorkspaceKeyChordModifier[];
}

export interface WorkspaceCommandContext {
  readonly userConfirmed: boolean;
  readonly sourceObjectId?: string;
}

export interface WorkspaceCommand {
  readonly id: string;
  readonly label: string;
  readonly category: WorkspaceCommandCategory;
  readonly authority: WorkspaceCommandAuthority;
  readonly shortcut?: WorkspaceKeyChord;
  readonly disabled?: () => string | null;
  readonly run: (ctx: WorkspaceCommandContext) => Promise<void> | void;
}

// ─── Undo Action discriminated union (refusal contract) ───────────────────

export interface WorkspaceUiWindowSnapshot {
  readonly id: string;
  readonly type: string;
  readonly rect: WorkspaceUiRect;
  readonly z: number;
}

export type WorkspaceUiAction =
  | {
      readonly kind: "ui.window.move";
      readonly windowId: string;
      readonly before: WorkspaceUiRect;
      readonly after: WorkspaceUiRect;
    }
  | {
      readonly kind: "ui.window.resize";
      readonly windowId: string;
      readonly before: WorkspaceUiRect;
      readonly after: WorkspaceUiRect;
    }
  | {
      readonly kind: "ui.window.zorder";
      readonly windowId: string;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly kind: "ui.window.close";
      readonly windowId: string;
      readonly windowSnapshot: WorkspaceUiWindowSnapshot;
    }
  | {
      readonly kind: "ui.window.open";
      readonly windowId: string;
      readonly windowSnapshot: WorkspaceUiWindowSnapshot;
    }
  | {
      readonly kind: "ui.workspace.pan";
      readonly before: WorkspaceUiView;
      readonly after: WorkspaceUiView;
    }
  | {
      readonly kind: "ui.workspace.zoom";
      readonly before: WorkspaceUiView;
      readonly after: WorkspaceUiView;
    }
  | {
      readonly kind: "ui.workspace.fit";
      readonly before: WorkspaceUiView;
      readonly after: WorkspaceUiView;
    }
  | {
      readonly kind: "ui.panel.toggle";
      readonly panel: string;
      readonly before: boolean;
      readonly after: boolean;
    }
  | {
      readonly kind: "ui.selection.change";
      readonly before: WorkspaceUiSelectionState;
      readonly after: WorkspaceUiSelectionState;
    }
  | {
      readonly kind: "ui.tab.switch";
      readonly before: string;
      readonly after: string;
    };

// Type-only proof that the Action union never extends into
// evidence/patch/verification/model-call/tool/memory/fs/config kinds.
// The `WorkspaceUiActionKind` literal union ONLY contains ui.* members.
export type WorkspaceUiActionKind = WorkspaceUiAction["kind"];

// ─── Undo stack API ──────────────────────────────────────────────────────

export interface WorkspaceUndoStackApi {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  push(action: WorkspaceUiAction): void;
  undo(): void;
  redo(): void;
  clear(): void;
}

// ─── Keyboard shortcut substrate ──────────────────────────────────────────

export interface WorkspaceKeyboardShortcutBinding {
  readonly commandId: string;
  readonly chord: WorkspaceKeyChord;
}

export interface WorkspaceKeyboardShortcutConflict {
  readonly chord: WorkspaceKeyChord;
  readonly commandIds: readonly string[];
}

export const WORKSPACE_RESERVED_CHORDS: readonly WorkspaceKeyChord[] = [
  { key: "t", mod: ["cmd"] },
  { key: "t", mod: ["ctrl"] },
  { key: "r", mod: ["cmd"] },
  { key: "r", mod: ["ctrl"] },
  { key: "n", mod: ["cmd", "shift"] },
  { key: "n", mod: ["ctrl", "shift"] },
];

// ─── Pure helpers ─────────────────────────────────────────────────────────

// Exhaustive discriminated-union dispatch; one branch per WorkspaceUiAction kind
// is the pattern the type system requires.
// eslint-disable-next-line complexity
export function workspaceActionLabel(action: WorkspaceUiAction): string {
  switch (action.kind) {
    case "ui.window.move":
      return "Move window";
    case "ui.window.resize":
      return "Resize window";
    case "ui.window.zorder":
      return "Reorder window";
    case "ui.window.close":
      return "Close window";
    case "ui.window.open":
      return "Open window";
    case "ui.workspace.pan":
      return "Pan workspace";
    case "ui.workspace.zoom":
      return "Zoom workspace";
    case "ui.workspace.fit":
      return "Fit workspace to view";
    case "ui.panel.toggle":
      return `Toggle ${action.panel} panel`;
    case "ui.selection.change":
      return "Change selection";
    case "ui.tab.switch":
      return "Switch tab";
  }
}

export function workspaceChordKey(chord: WorkspaceKeyChord): string {
  const sorted = [...chord.mod].sort();
  return `${sorted.join("+")}|${chord.key.toLowerCase()}`;
}

export function workspaceChordsEqual(a: WorkspaceKeyChord, b: WorkspaceKeyChord): boolean {
  return workspaceChordKey(a) === workspaceChordKey(b);
}

export function isWorkspaceReservedChord(chord: WorkspaceKeyChord): boolean {
  for (const reserved of WORKSPACE_RESERVED_CHORDS) {
    if (workspaceChordsEqual(chord, reserved)) return true;
  }
  return false;
}

// ─── Inverse-action helper for the undo stack ─────────────────────────────
//
// Pure function that computes the inverse of any ui.* action by swapping
// before/after. Lives next to the contracts so consumers and tests share
// the canonical inverse implementation.

// Exhaustive discriminated-union dispatch; one branch per WorkspaceUiAction kind
// is the pattern the type system requires.
// eslint-disable-next-line complexity
export function workspaceInverseAction(action: WorkspaceUiAction): WorkspaceUiAction {
  switch (action.kind) {
    case "ui.window.move":
      return { ...action, before: action.after, after: action.before };
    case "ui.window.resize":
      return { ...action, before: action.after, after: action.before };
    case "ui.window.zorder":
      return { ...action, before: action.after, after: action.before };
    case "ui.window.close":
      return { ...action, kind: "ui.window.open" };
    case "ui.window.open":
      return { ...action, kind: "ui.window.close" };
    case "ui.workspace.pan":
      return { ...action, before: action.after, after: action.before };
    case "ui.workspace.zoom":
      return { ...action, before: action.after, after: action.before };
    case "ui.workspace.fit":
      return { ...action, before: action.after, after: action.before };
    case "ui.panel.toggle":
      return { ...action, before: action.after, after: action.before };
    case "ui.selection.change":
      return { ...action, before: action.after, after: action.before };
    case "ui.tab.switch":
      return { ...action, before: action.after, after: action.before };
  }
}
