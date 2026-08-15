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
  "user" | "user-confirm" | "agent-proposal" | "tool" | "model";

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
      /**
       * Present only for a Search open transition. Keeping the selected root on the in-memory
       * action lets redo recreate the singleton with the same workspace ownership.
       */
      readonly searchRoot?: string | undefined;
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

// Compile-time refusal witness (ADR-0028 §5 / ADR-0030 rule 4): every
// WorkspaceUiAction kind MUST be `ui.`-prefixed. Adding an evidence/patch/
// verification/model/tool/memory/fs/config kind makes this fail `tsc`,
// before any test runs.
type AssertUiPrefixed<K extends `ui.${string}`> = K;
export type WorkspaceUiActionKindChecked = AssertUiPrefixed<WorkspaceUiActionKind>;

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
  { key: "w", mod: ["cmd"] },
  { key: "w", mod: ["ctrl"] },
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
  const sorted = [...chord.mod].sort((a, b) => a.localeCompare(b));
  return `${sorted.join("+")}|${chord.key.toLowerCase()}`;
}

export function workspaceChordsEqual(a: WorkspaceKeyChord, b: WorkspaceKeyChord): boolean {
  return workspaceChordKey(a) === workspaceChordKey(b);
}

// ─── The physical chord vocabulary (0.3.0 release audit, #2802) ───────────────────────────────
//
// `workspaceChordKey` above names a DECLARATION: it keeps `cmd` and `ctrl` apart because that is
// how a binding is written. The keyboard does not. `cmd` is the Meta key on macOS and the Control
// key everywhere else, so two different declarations can be the same physical keystroke — `cmd|p`
// and `ctrl|p` are both plain Ctrl+P on Windows and Linux. Claiming, collision detection and
// reservation must therefore compare the PHYSICAL key the matcher receives, never the declaration.
// Comparing declarations is what let a persisted `Ctrl+Meta+T` past every guard and onto the
// substrate, where it fired on a plain Ctrl+T and took the browser's own chord away from the user.

export type WorkspaceKeyChordPlatform = "mac" | "other";

export type WorkspacePhysicalModifier = "meta" | "ctrl" | "alt" | "shift";

const WORKSPACE_KEY_CHORD_PLATFORMS: readonly WorkspaceKeyChordPlatform[] = ["mac", "other"];

/**
 * The modifier names a `KeyboardEvent` must have asserted for `mod` to match on `platform`. This is
 * the ONE place `cmd` is resolved to a real key; every matcher, claim and conflict check derives
 * from it so no consumer can grow a second, disagreeing collapse.
 */
export function workspacePlatformModifiers(
  mod: readonly WorkspaceKeyChordModifier[],
  platform: WorkspaceKeyChordPlatform,
): ReadonlySet<WorkspacePhysicalModifier> {
  const physical = new Set<WorkspacePhysicalModifier>();
  for (const modifier of mod) {
    physical.add(physicalModifier(modifier, platform));
  }
  return physical;
}

function physicalModifier(
  modifier: WorkspaceKeyChordModifier,
  platform: WorkspaceKeyChordPlatform,
): WorkspacePhysicalModifier {
  if (modifier !== "cmd") return modifier;
  return platform === "mac" ? "meta" : "ctrl";
}

/** The keystroke `chord` occupies on `platform`. */
export function workspaceChordKeyForPlatform(
  chord: WorkspaceKeyChord,
  platform: WorkspaceKeyChordPlatform,
): string {
  const sorted = [...workspacePlatformModifiers(chord.mod, platform)].sort((a, b) =>
    a.localeCompare(b),
  );
  return `${sorted.join("+")}|${chord.key.toLowerCase()}`;
}

/**
 * Every keystroke `chord` can occupy on any supported platform. A dispatch table claims all of
 * them at once, so one persisted settings file cannot be safe on macOS and ambiguous on Windows.
 */
export function workspaceChordClaimKeys(chord: WorkspaceKeyChord): readonly string[] {
  return [
    ...new Set(
      WORKSPACE_KEY_CHORD_PLATFORMS.map((platform) =>
        workspaceChordKeyForPlatform(chord, platform),
      ),
    ),
  ];
}

/** True when the two chords are the same keystroke on at least one supported platform. */
export function workspaceChordsCollide(a: WorkspaceKeyChord, b: WorkspaceKeyChord): boolean {
  const keys = new Set(workspaceChordClaimKeys(a));
  return workspaceChordClaimKeys(b).some((key) => keys.has(key));
}

/**
 * A chord carrying BOTH `cmd` and `ctrl` is not expressible. Off macOS `cmd` collapses onto the
 * Control key, so `["ctrl","cmd"]` becomes indistinguishable from `["ctrl"]` at match time — a
 * state no reservation and no conflict check can name, and the exact hole a persisted
 * `Ctrl+Meta+T` used to reach the substrate and fire on a plain Ctrl+T. The vocabulary is refused
 * here rather than taught to every consumer, so there is one answer for every surface.
 */
export function isWorkspaceDispatchableChord(chord: WorkspaceKeyChord): boolean {
  return !(chord.mod.includes("cmd") && chord.mod.includes("ctrl"));
}

/**
 * Reservation is decided on the PHYSICAL chord: a declaration is reserved when it lands on a
 * reserved keystroke on any supported platform. Strictly stronger than the declaration comparison
 * it replaces — every chord that was reserved before still is.
 */
export function isWorkspaceReservedChord(chord: WorkspaceKeyChord): boolean {
  for (const reserved of WORKSPACE_RESERVED_CHORDS) {
    if (workspaceChordsCollide(chord, reserved)) return true;
  }
  return false;
}

// The two predicates above are a must-call-BOTH pair: dispatchable alone still admits a chord the
// host OS or browser has reserved. Every caller had to remember the composition, and nothing tested
// it, so this is the single predicate a caller should reach for. The individual predicates stay
// exported — they are how a caller reports WHICH rule a chord failed.
export function isWorkspaceChordAcceptable(chord: WorkspaceKeyChord): boolean {
  return isWorkspaceDispatchableChord(chord) && !isWorkspaceReservedChord(chord);
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
