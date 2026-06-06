# ADR-0028: Workspace commands, events, selection, undo/redo boundaries

## Status

Accepted (Epic #518, 2026-06-06). Operationalizes the command, event, selection, and undo decisions recorded in [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).

## Context

Epic #518's [UX blueprint](../workspace/518-ux-blueprint.md) requires a command-driven interaction model (rather than mode-driven), a typed selection model, a discoverable command palette, a minimum keyboard shortcut set, and an undo/redo boundary that never silently rewrites evidence, applied patches, verification records, or model-call records.

`AppShell.tsx` already builds command records and feeds them to a `CommandPalette` modal. `useWorkspace` already owns single-window focus and z-ordering. The new behavior to design is the command record contract, the keyboard shortcut substrate, and the undo/redo boundary with its refusal-by-type.

## Decision

### 1. Command record contract

A workspace command is a typed record declared in `keiko-contracts`:

```
type CommandAuthority =
  | "user"           // UI-only mutation; runs immediately
  | "user-confirm"   // requires explicit confirmation through PermControl or AgentGateCard
  | "agent-proposal" // originates from an agent; user must accept
  | "tool"           // delegates to keiko-tools terminal-policy or applyPatch
  | "model";         // delegates to keiko-model-gateway

type CommandCategory =
  | "workspace" | "window" | "selection"
  | "navigation" | "review" | "verification"
  | "evidence" | "model";

interface KeyChord {
  readonly key: string;                  // e.g., "k"
  readonly mod: ReadonlyArray<"cmd" | "ctrl" | "alt" | "shift">;
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly category: CommandCategory;
  readonly authority: CommandAuthority;
  readonly shortcut?: KeyChord;
  readonly disabled?: () => string | null; // null = enabled; string = reason
  readonly run: (ctx: CommandContext) => Promise<void> | void;
}
```

- The `disabled()` return is the reason rendered in palette and tooltip when the command is unavailable. The substrate never hides disabled commands; it shows them with their reason (per WCAG 3.3.1).
- The substrate refuses to call `run()` on a `user-confirm` command without explicit confirmation captured in the command context.
- Each command is registered once at startup. Contextual commands contributed by a focused window are registered when the window opens and removed when it closes.

### 2. Event boundary

Workspace events (window-focus-change, window-move, palette-open, command-run) are React state changes inside the workspace hook. There is **no** global event bus.

BFF events (SSE chat-message-arrived, WebSocket run-progress) flow through hooks (`useChatSession`, `useWsContext`) that translate them into React state. They are not workspace-layer events at the substrate level. This separation prevents the substrate from observing or rewriting evidence/model/tool events.

### 3. Selection model

`useWorkspace` owns selection state. Selection is single-window by default. Multi-selection is the bounded extension landed in #527 if and only if the UX blueprint requires it for an in-scope behavior; otherwise multi-selection is deferred.

The substrate's typed `SelectionState` is exposed by `WorkspaceApi`:

```
interface SelectionState {
  readonly focusedWindowId: string | null;
  readonly selectedWindowIds: ReadonlyArray<string>; // currently length 0 or 1; multi later
}
```

### 4. Keyboard shortcut substrate

The `useKeyboardShortcuts` hook wires the minimum shortcut set declared in the [UX blueprint](../workspace/518-ux-blueprint.md#minimum-shortcut-set-the-contract-527-must-wire).

- Normalization: `Cmd` on macOS, `Ctrl` on Windows/Linux, detected via `navigator.platform`. Cross-platform commands declare `mod: ["cmd"]` and the hook substitutes `Ctrl` where appropriate.
- Conflict detection: at startup the hook builds a `Map<chord-string, commandId>`; duplicate chord declarations crash the build at module-evaluation. This is the substrate's first-user-action fail-closed.
- Browser-reserved chords (`Cmd/Ctrl+T`, `Cmd/Ctrl+R`, `Cmd/Ctrl+W` on browsers that intercept it, browser back/forward) are never claimed by workspace commands. The hook refuses to bind them.
- Modifier matching is exact: `Ctrl+K` does not match `Ctrl+Shift+K`.

### 5. Undo/redo boundary (the refusal contract)

The undo stack stores typed `Action` records declared in `keiko-contracts`:

```
type Action =
  | { kind: "ui.window.move"; windowId: string; before: Rect; after: Rect }
  | { kind: "ui.window.resize"; windowId: string; before: Rect; after: Rect }
  | { kind: "ui.window.zorder"; windowId: string; before: number; after: number }
  | { kind: "ui.window.close"; window: AppWindow }
  | { kind: "ui.window.open"; window: AppWindow }
  | { kind: "ui.workspace.pan"; before: View; after: View }
  | { kind: "ui.workspace.zoom"; before: View; after: View }
  | { kind: "ui.workspace.fit"; before: View; after: View }
  | { kind: "ui.panel.toggle"; panel: string; before: boolean; after: boolean }
  | { kind: "ui.selection.change"; before: SelectionState; after: SelectionState }
  | { kind: "ui.tab.switch"; before: string; after: string };
```

There is **no** Action variant for:

- Evidence creation, redaction, archival.
- Applied patches (the patch itself).
- Verification run start / completion / cancellation.
- Model call execution.
- Tool execution.
- Memory writes.
- Workspace FS writes.
- Durable config writes.

Because no constructor exists, the undo stack cannot record any of these actions and cannot reverse them. The refusal is **not** a runtime guard. It is the absence of the constructor in the discriminated union. A future contributor adding such a constructor would have to amend this ADR; PR review and the corresponding `arch:check:negative` test catch the attempt.

The `useUndoStack` hook exposes:

```
interface UndoStackApi {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;  // localized action label or null
  readonly redoLabel: string | null;
  push(action: Action): void;
  undo(): void;
  redo(): void;
  clear(): void;                       // called on project switch or shell teardown
}
```

The `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` commands map directly to `undo()` / `redo()`. The command tooltip reads "Undoes window and panel changes only. Evidence and patches cannot be undone."

When an authority moment that is *not* reversible completes (a patch is applied, a verification record is written), a transient toast in `NotificationsPanel` reads "Recorded as evidence; cannot be undone." This is informational only; it does not push an Action.

### 6. Wiring

- `AppShell.tsx` provides the `useUndoStack` instance via React context to `Workspace.tsx` and the command palette.
- `useWorkspace` calls `push()` whenever it mutates a state slice that has an Action variant.
- The `clear()` method is called on project switch (to prevent cross-project undo) and on shell teardown.

## Consequences

- The undo stack is a small, immutable history list with bounded length (default 100, configurable via the descriptor validator's policy). No memory growth concern at this scale.
- Adding a new reversible UI behavior is a single PR: add an Action variant, push it from the mutating call site, render the action label in `undoLabel`.
- Adding a non-reversible authority moment (a new tool, a new evidence-bearing window) requires NO Action work and therefore cannot break the boundary.
- The substrate cost of `useKeyboardShortcuts` is one `keydown` listener; no library.
- The conflict-at-startup rule means a contributor cannot ship a chord collision; the build fails first.

## Alternatives considered

- **Runtime refusal in the undo function** instead of compile-time refusal. Rejected. A runtime check is one PR away from being silently disabled; the absence of the constructor is not.
- **A general-purpose action bus** (Redux / Zustand) that could be inspected and replayed. Rejected. It would weaken the refusal and add a runtime dependency.
- **A separate undo stack per surface.** Rejected. The user expects a single Cmd/Ctrl+Z to act on the most recent UI action regardless of which surface produced it.

## Related

- ADR-0026 — Workspace substrate.
- ADR-0027 — Workspace state ownership and persistence.
- ADR-0029 — Workspace object registry and extension contract.
- ADR-0030 — Workspace security, evidence, and trust boundaries.
- [518-ux-blueprint.md](../workspace/518-ux-blueprint.md) — Command model, minimum shortcut set, undo boundary.
- Issue #527 — Interaction substrate implementation.
