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
- The substrate refuses to call `run()` on a `user-confirm` command without explicit confirmation captured in the command context. **Delivery status (Issue #527):** the `WorkspaceCommand` contract (`authority`, `disabled()`, `WorkspaceCommandContext`) is provided as the reusable substrate. The current shell command palette registers only UI-only commands (open/toggle/tile/cascade/theme/undo/redo), and every privileged confirmation (model/tool/patch/agent-proposal) is owned by the widget authority layer (`PermControl` / `AgentGateCard` / `ReviewWidget`). Gating palette `run()` on `WorkspaceCommandContext.userConfirmed` is wired when the first privileged command is registered in the palette; until then the command-level `authority` field is advisory and no privileged action is reachable through the palette.
- Each command is registered once at startup. Contextual commands contributed by a focused window are registered when the window opens and removed when it closes.

### 2. Event boundary

Workspace events (window-focus-change, window-move, palette-open, command-run) are React state changes inside the workspace hook. There is **no** global event bus.

BFF events (SSE chat-message-arrived, WebSocket run-progress) flow through hooks (`useChatSession`, `useWsContext`) that translate them into React state. They are not workspace-layer events at the substrate level. This separation prevents the substrate from observing or rewriting evidence/model/tool events.

### 3. Selection model

`useWorkspace` currently owns single-window focus and z-ordering. The typed `SelectionState` contract exists in `keiko-contracts`, but `WorkspaceApi` on `dev` does not yet expose that state as a first-class runtime selection API. Multi-selection remains deferred unless a downstream issue proves it is needed.

The substrate's typed `SelectionState` is the contract shape reserved for future selection wiring:

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
- Browser-reserved chords (`Cmd/Ctrl+T`, `Cmd/Ctrl+R`, `Cmd/Ctrl+W`, and `Cmd/Ctrl+Shift+N`) are never claimed by workspace commands. The hook refuses to bind them; `WORKSPACE_RESERVED_CHORDS` in `keiko-contracts` is the source of truth.
- Modifier matching is exact: `Ctrl+K` does not match `Ctrl+Shift+K`.

**Amendment (2026-07-30, 0.3.0 release audit, #2802) — the throw guards declarations; a persisted override is hostile input.** The conflict-at-startup and reserved-chord refusals above are guards on _declared_ bindings — the compile-time command records this ADR defines — and they keep their current form: `useKeyboardShortcuts` throws `WorkspaceShortcutConflictError` / `WorkspaceShortcutReservedError` when it is handed a table that violates either rule, the default table is pinned reserved-free and conflict-free by test so a contributor still cannot ship a collision, and neither throw may be softened, downgraded, or made conditional. ADR-0133 D5 later introduced `keybindingOverrides`, a persisted, hand-editable setting that did not exist when this section was written; a persisted override is untrusted runtime input, not a binding declaration, and it must never reach the substrate in a state the substrate refuses — one corrupt record would otherwise throw in render on every load and leave the desktop unrenderable, with the settings panel that could repair it inside the surface that no longer renders. Between the effective-settings registry and the substrate there is therefore exactly one dispatch-safe projection (`dispatchableWorkspaceShortcutsForContext`), and that projection is the fail-closed point for persisted data: a malformed, browser-reserved, or chord-colliding override is refused there and the command falls back to its own default binding, or to no binding when that default is itself unusable, and an unoverridden command claims its chord before any overridden one, so a persisted record can never take a chord away from a stock binding. Because a physical chord has several spellings, reservation and collision are compared on the normalized chord, not on the binding string, and the M7 reserved list must remain at least as strict as `WORKSPACE_RESERVED_CHORDS`. Refusal is not silence: the projection reports each refusal as a body-free `{ commandId, reasonCode }` pair — closed-registry identifiers and closed reason codes only, never the rejected record, its raw binding text, an unknown command id, a scope path, or any settings content — which the Keyboard Shortcuts settings panel renders on the affected row and the shell emits at most once per distinct refusal signature per session. The shell error boundary above `AppShellInner`, with its reset-persisted-keybinding-overrides recovery, remains defence in depth for a render-time throw this projection does not anticipate; it is not a substitute for the projection, and its existence is never a reason to let a refused chord through.

### 5. Undo/redo boundary (the refusal contract)

The undo stack stores typed `Action` records declared in `keiko-contracts`:

```
// Rect = WorkspaceUiRect; View = WorkspaceUiView;
// SelectionState = WorkspaceUiSelectionState; WindowSnapshot = WorkspaceUiWindowSnapshot
type Action =
  | { kind: "ui.window.move"; windowId: string; before: WorkspaceUiRect; after: WorkspaceUiRect }
  | { kind: "ui.window.resize"; windowId: string; before: WorkspaceUiRect; after: WorkspaceUiRect }
  | { kind: "ui.window.zorder"; windowId: string; before: number; after: number }
  | { kind: "ui.window.close"; windowId: string; windowSnapshot: WorkspaceUiWindowSnapshot }
  | { kind: "ui.window.open"; windowId: string; windowSnapshot: WorkspaceUiWindowSnapshot }
  | { kind: "ui.workspace.pan"; before: WorkspaceUiView; after: WorkspaceUiView }
  | { kind: "ui.workspace.zoom"; before: WorkspaceUiView; after: WorkspaceUiView }
  | { kind: "ui.workspace.fit"; before: WorkspaceUiView; after: WorkspaceUiView }
  | { kind: "ui.panel.toggle"; panel: string; before: boolean; after: boolean }
  | { kind: "ui.selection.change"; before: WorkspaceUiSelectionState; after: WorkspaceUiSelectionState }
  | { kind: "ui.tab.switch"; before: string; after: string };
```

There is **no** Action variant for:

- Evidence creation, redaction, archival.
- Applied patches (the patch itself).
- Verification run start / completion / cancellation.
- **Review-session state** (review annotations, review-window progress, accept/reject decisions on agent-proposed patches via `ReviewWidget` / `AgentGateCard`). Review-session state is treated equivalently to verification records and applied patches: it is an irreversible authority moment that produces evidence, not a UI layout change. Issue #525 AC6 names this boundary explicitly.
- Model call execution.
- Tool execution.
- Memory writes.
- Workspace FS writes.
- Durable config writes.

Because no constructor exists, the undo stack cannot record any of these actions and cannot reverse them. The primary refusal is **not** a runtime guard — it is the absence of the constructor in the discriminated union, backed by a compile-time assertion that every `WorkspaceUiActionKind` is `ui.`-prefixed (a non-`ui.` kind fails `tsc`). A future contributor adding such a constructor would have to amend this ADR; PR review, the compile-time assertion, and the `useUndoStack.test.tsx` refusal test catch the attempt. There is no dedicated `arch:check:negative` fixture for this invariant; `arch:check:negative` enforces the ADR-0019 package-direction rules.

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

The `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` commands map directly to `undo()` / `redo()`. The command tooltip names the scope that is actually instrumented, never the scope the union could carry: "Evidence, review decisions, verification records, and applied patches cannot be undone" always holds, and the reversible half tracks §6 "Current wiring". Today only `ui.panel.toggle` is pushed, so the empty-stack labels read "Undo (panel changes only)" / "Redo (panel changes only)" (`shell.command.{undo,redo}.panelOnly`). The earlier "window and panel changes only" wording promised a scope no call site records — a window move/resize/maximize/close never reaches the stack — and is corrected here rather than in the product: whichever mutation kinds §6 lists as pushed is what the label may claim, so instrumenting the window kinds widens the label in the same change.

Applying a recorded action is state-setting, not toggling: `applyShellUndoAction` compares the action's recorded target state against the live panel state (through the one `shellPanelIsOpen` rule that `AppShell` also records with) and performs the transition only when the two differ. A state-dependent flip diverges from the record as soon as the user moves the panel by hand between the original action and the undo.

When an authority moment that is _not_ reversible completes (a patch is applied, a verification record is written), a transient toast in `NotificationsPanel` reads "Recorded as evidence; cannot be undone." This is informational only; it does not push an Action.

### 6. Wiring

- `AppShell.tsx` owns the `useUndoStack` instance and routes the undo / redo / `focus-status` shortcuts through `useKeyboardShortcuts`; the undo and redo commands are contributed to the command palette under the "Edit" group.
- **Current wiring (Issue #527):** `AppShell` pushes `ui.panel.toggle` actions, so tool-panel open/close is reversible via `Cmd/Ctrl+Z`. The remaining `ui.*` Action variants (window move/resize/zorder/open/close, workspace pan/zoom/fit, selection, tab) are declared in the union and reversible-by-construction through `workspaceInverseAction`, but their mutating call sites do not yet call `push()`, and `applyShellUndoAction` is intentionally a no-op for those kinds. Instrumenting each remaining mutation is additive, cannot weaken the refusal boundary, and is tracked as a follow-up.
- The `clear()` method is available to drop the stack on project switch (to prevent cross-project undo) and on shell teardown; the current single-project shell discards the stack when `AppShellInner` unmounts.

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

## Date

2026-06-06
