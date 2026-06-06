# Epic #518 — Governed Workspace UX Blueprint

Status: Wave 2 deliverable for [issue #523](https://github.com/oscharko-dev/Keiko/issues/523) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Audit date: 2026-06-06. Builds on [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), and [518-product-boundaries.md](518-product-boundaries.md).

## Purpose

This document defines the UX behavior of Keiko's governed workspace foundation: navigation, selection, commands, undo/redo, context menus, error recovery, and the accessibility-first interaction contract. It is the input that constrains #524 (UI blueprint), #525 (architecture/ADRs), #526 (shell), #527 (interaction substrate), and the hardening pass in #530.

The blueprint is **deliberately conservative** about what the workspace foundation must do: it locks in behaviors already implemented by the desktop shell (`AppShell`, `Workspace`, `LeftRail`, `RightRail`, `Header`, `Footer`, `CommandPalette`, `useWorkspace`, connector graph) and adds only the behaviors named as genuine gaps in the capability audit.

## Interaction principles (apply everywhere)

1. **Commands over modes.** Every workspace action is a typed command discoverable through the command palette and reachable by keyboard. There are no modal "tools" the user must switch into. (Adapted from tldraw / Excalidraw; see [reference analysis](518-reference-analysis.md).)
2. **User authority moments are explicit.** Apply, verify, dismiss, archive, retry, and escalate are confirmation surfaces. The UI never silently performs them on the user's behalf.
3. **Evidence is never silently rewritten.** Undo/redo, retry, and dismiss never mutate evidence, applied patches, verification records, or model-call records.
4. **Keyboard-only is a first-class path.** Every command, navigation step, and authority moment is reachable without a pointing device.
5. **Failure preserves trust.** When a model call, tool call, workspace access, or workflow fails, the UI states exactly what failed, what was not changed, and what action is available next. Failures never appear as silent disabled controls.
6. **Reduced motion is honored.** All non-essential motion is gated by `prefers-reduced-motion` (`motion-safe:` Tailwind/CSS prefix).
7. **Hit targets meet WCAG 2.5.8.** Minimum 24×24 logical pixels for interactive targets; ≥30×30 for primary controls per the existing pattern in the connector graph.

## Entry behaviors

### First-run continuation

When the workspace opens with no connected project and no prior layout:

- Shell renders with LeftRail (Keiko / Project / Search / Plugins on the primary group; Automations / Keiko mobile on secondary), Header, an empty Workspace surface with a project-connect call to action, RightRail in default state, and Footer status indicators in their `unknown` state.
- The Workspace surface's empty state is a short, scannable instruction: "Connect a project to begin." with the `Project` keyboard hint (`g p` or whatever the matrix below allocates).
- Focus lands on the project-connect call to action.

### Returning-user behavior

When the workspace opens with prior durable state:

- The shell restores the last layout (window positions, sizes, z-order, open panels), the active project, and the inspector focus.
- Transient state (in-flight streaming, ephemeral notifications) does not restore.
- Focus lands on the last focused interactive control if it still exists; otherwise on the LeftRail.

### Project selection

- `Project` in the LeftRail opens `ProjectPanel`.
- The panel lists recent projects, an "Open folder" command, and the active project's connected scope.
- Selecting a project triggers `keiko-workspace` validation and updates the Footer's connected-project indicator.

## Navigation model

| Region                                                           | Owner             | Keyboard reach                                              | Behavior                                                                                                       |
| ---------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **LeftRail**                                                     | `AppShell`        | `Alt+1..7` (selectable cycle), `g <letter>` shortcut prefix | Tabs to global tools (Project, Search, Plugins, Automations, Keiko mobile) and to the Keiko Twin (top of rail) |
| **Header tabs**                                                  | `Header`          | `Ctrl+1..9` cycles tabs                                     | Switches workspace tabs (multi-workspace, per memory #64)                                                      |
| **Workspace**                                                    | `Workspace`       | `Tab` enters windows; `Shift+Tab` exits                     | Pan/zoom via keyboard (`Arrow` + `+/-`); fit-to-view via `f`                                                   |
| **RightRail**                                                    | `RightRail`       | `Alt+i` toggles inspector visibility                        | Inspector and supplemental panels                                                                              |
| **Footer**                                                       | `Footer`          | `Alt+s` focuses status surface                              | Indicators for connected project, model availability, workflow readiness, evidence access                      |
| **Modals (palette / new window / gateway setup / perm control)** | `AppShell.modals` | `Esc` closes; focus trap inside                             | Standard modal patterns                                                                                        |

### Command palette

- Opens via `Cmd/Ctrl+K` (existing palette) and via the Header `hd-tool-cta` button.
- Lists commands generated by `buildCommands` in `AppShell.tsx` plus contextual commands from focused windows.
- Filters by fuzzy match across command id, label, and category.
- `Enter` runs; `Esc` closes; arrow keys move.

### Workspace tabs

- Per memory #64, project tabs are persisted in the URL (`?project=`, `?chat=`). Tab list lives in the Header.
- New tab button creates a new project context (gated to existing project list).

## Selection model

Selection identifies the workspace objects the next command will act on.

| Object scope                | Single-select                  | Multi-select                              | Marquee select                          |
| --------------------------- | ------------------------------ | ----------------------------------------- | --------------------------------------- |
| **Workspace window**        | Click; arrow keys; `Tab` cycle | `Cmd/Ctrl+Click`; `Shift+Click` for range | Out of scope for #527 — record as defer |
| **LeftRail entry**          | Click / arrow                  | n/a                                       | n/a                                     |
| **Header tab**              | Click / arrow                  | n/a                                       | n/a                                     |
| **Inspector list rows**     | Click / arrow                  | `Shift+Click` for range                   | n/a                                     |
| **Connector graph capsule** | Click                          | `Cmd/Ctrl+Click` (existing)               | n/a                                     |

**Selection contract:**

1. Selection state lives in `useWorkspace`. The capability audit gap matrix specifies multi-select as the bounded extension.
2. Selection is keyboard-equivalent to pointer.
3. Focus follows selection by default; explicit `Tab` navigation moves focus without changing selection.
4. Selection is preserved across non-destructive actions (open inspector, run command) and cleared on destructive ones (window close, project switch).

## Command model

A command is a typed record:

```
type Command = {
  readonly id: string;            // stable id, used for shortcut binding and palette filtering
  readonly label: string;         // user-facing
  readonly category: "workspace" | "window" | "selection" | "navigation" | "review" | "verification" | "evidence" | "model";
  readonly authority: "user" | "user-confirm" | "agent-proposal" | "tool" | "model";
  readonly shortcut?: KeyChord;   // optional keyboard binding (declared once, conflict-resolved at startup)
  readonly disabled?: () => string | null; // null = enabled; string = reason shown in palette + tooltip
  readonly run: (ctx: CommandContext) => Promise<void> | void;
};
```

### Command discoverability

- Every command appears in the palette unless explicitly hidden.
- Disabled commands appear with their reason rendered in palette and tooltip; they are not removed (per WCAG 3.3.1 + product trust).
- Custom keyboard shortcuts must be declared once via the command record's `shortcut` field; the substrate detects conflicts at startup and refuses to start if two commands claim the same chord.

### Contextual commands

When a window is focused, the window contributes contextual commands (e.g., `Files: Reveal in OS file manager`, `Review: Apply patch`, `Chat: Copy run id`).

### Authority-gated commands

Commands with `authority: "user-confirm"` open a `PermControl` modal or an `AgentGateCard` review surface before running. The substrate refuses to call `run()` without explicit user confirmation captured in the command context.

### Minimum shortcut set (the contract #527 must wire)

| Action                       | Chord                               | Authority                                                 |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------- |
| Open command palette         | `Cmd/Ctrl+K`                        | user                                                      |
| New chat window              | `Cmd/Ctrl+N`                        | user                                                      |
| Cycle windows forward        | `Ctrl+Tab`                          | user                                                      |
| Cycle windows backward       | `Ctrl+Shift+Tab`                    | user                                                      |
| Close focused window         | `Cmd/Ctrl+W`                        | user                                                      |
| Toggle LeftRail              | `Alt+L`                             | user                                                      |
| Toggle RightRail / inspector | `Alt+I`                             | user                                                      |
| Toggle Footer                | `Alt+S`                             | user                                                      |
| Focus search                 | `Cmd/Ctrl+P`                        | user                                                      |
| Pan workspace (`Arrow`)      | `Arrow` keys when Workspace focused | user                                                      |
| Zoom in / out                | `+` / `-` when Workspace focused    | user                                                      |
| Fit to view                  | `f` when Workspace focused          | user                                                      |
| Undo (UI-state actions)      | `Cmd/Ctrl+Z`                        | user (refused for evidence/patch/verification/model-call) |
| Redo (UI-state actions)      | `Cmd/Ctrl+Shift+Z`                  | user (refused for evidence/patch/verification/model-call) |
| Escape / cancel              | `Esc`                               | user                                                      |
| Activate / Enter             | `Enter`                             | user                                                      |
| Confirm authority moment     | `Enter` inside `PermControl` modal  | user-confirm                                              |
| Dismiss authority moment     | `Esc` inside `PermControl` modal    | user                                                      |

This is the contract for the `useKeyboardShortcuts` hook the capability audit named.

### Conflict rules

- Shortcuts are declared once per command; the substrate checks at startup and refuses to start if two commands claim the same chord.
- Browser-reserved shortcuts (`Cmd/Ctrl+T` open tab, `Cmd/Ctrl+R` reload, etc.) are never claimed by the workspace.
- Shortcuts honor the user's OS conventions: `Cmd` on macOS; `Ctrl` on Windows/Linux. The capability audit's `useKeyboardShortcuts` hook normalizes via `navigator.platform`.

## Undo / redo boundary (the genuine new behavior)

### What is reversible

- Window move, resize, close-from-list, focus change, z-order change.
- Workspace pan / zoom / fit / reset.
- LeftRail/RightRail toggle, panel open/close, tab switch.
- Inspector field toggle.

### What is **not** reversible

- Evidence creation, redaction, archival.
- Patch application (the patch itself; the user can propose a reverse patch as a new action).
- Verification run start, completion, cancellation.
- Model call execution and the associated gateway record.
- Tool execution (terminal command, browser action, file write).
- Memory writes via `keiko-memory-*`.
- Workspace FS writes.

### The refusal contract

The undo stack stores typed `Action` records:

```
type Action =
  | { kind: "ui.window.move"; before: Rect; after: Rect; windowId: string }
  | { kind: "ui.window.resize"; before: Rect; after: Rect; windowId: string }
  | { kind: "ui.window.close"; window: AppWindow }
  | { kind: "ui.workspace.pan"; before: View; after: View }
  | { kind: "ui.workspace.zoom"; before: View; after: View }
  | { kind: "ui.panel.toggle"; panel: string; before: boolean; after: boolean }
  | { kind: "ui.selection.change"; before: SelectionState; after: SelectionState }
  | ...;
```

There is **no** action variant for evidence, patch, verification, or model call. The substrate cannot record such an action because the type system has no constructor for it. This is the refusal: not a runtime check but a compile-time impossibility.

### Surfacing the refusal

When an authority moment that is _not_ reversible completes, a transient toast in the Notifications panel reads "Recorded as evidence; cannot be undone." The undo command itself notes the boundary in its tooltip: "Undoes window and panel changes only. Evidence and patches cannot be undone."

## Context menus and inspector actions

- The workspace shell does not add a right-click menu in #527; right-click currently opens the system menu and Keiko respects that.
- Per-window inspector actions live in the `InspectorPanel` toolbar (top of `RightRail`).
- Inspector actions follow the same command contract; they appear in the palette filtered by the focused window.

## Object inspection

- Selecting a workspace window updates the `InspectorPanel` with that object's identity, lifecycle state, trust boundary, persistence expectation, and recent activity.
- Evidence-bearing objects show a "View evidence" action that opens a `ReviewWidget` filtered to that object.

## State patterns

| State                      | Visual rule                                                                                            | Behavior                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Empty**                  | Concise instruction + primary call to action with keyboard hint                                        | Focus on the call to action                                                                |
| **Loading**                | Skeleton or progress indicator; `aria-busy="true"`; `aria-live="polite"` summary                       | Commands acting on the loading object are disabled with reason "Loading…"                  |
| **Streaming**              | Inline streaming target with `aria-live="polite"`; cancel action visible                               | Cancel action runs on `Esc` or button                                                      |
| **Success**                | Quiet — no notification spam                                                                           | Status remains in the Footer                                                               |
| **Review-needed**          | `AgentGateCard` opens with explicit authority moment                                                   | Apply / dismiss / verify / escalate                                                        |
| **Blocked**                | Visible block reason; suggested action; `role="alert"` only when block is new                          | Commands acting on the blocked object are disabled with the block reason                   |
| **Degraded**               | Yellow indicator in Footer; degraded features marked at point-of-use                                   | Affected commands disabled with reason "Model unavailable", "Workspace disconnected", etc. |
| **Offline / disconnected** | Same as degraded; explicit "Reconnect" command                                                         | Commands needing the offline surface disabled                                              |
| **Stale**                  | Yellow indicator on the affected object; "Refresh" action                                              | Acting on stale data warns once before running                                             |
| **Error**                  | `role="alert"`, `aria-live="assertive"`; explanation of what failed, what was not changed, what to try | "Retry" command shown only when the failure is retryable                                   |

The substrate enforces the rule that disabled controls always render their reason (per command record `disabled()` return value).

## Error recovery

Each failure class has a deterministic recovery surface.

| Failure                          | Surface                                           | Recovery                                                          |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Model call failure               | `ChatWindow` + Notifications                      | Retry available; the failure does not consume an undoable slot    |
| Workspace access denied          | The affected widget shows the denied-path reason  | User picks a different path or extends the connected scope        |
| Command denied (terminal policy) | Terminal widget shows the policy reason           | User chooses an allowed command; policy is not relaxed at runtime |
| Patch conflict                   | `ReviewWidget` shows the conflict diff            | User edits or escalates                                           |
| Stale evidence reference         | The evidence row shows "Stale"                    | User refreshes the reference; underlying evidence is unchanged    |
| Missing context                  | `Chat` composer surfaces "Add context" affordance | User attaches context                                             |
| Unavailable workflow             | Workflow card shows "Unavailable" with reason     | User picks an alternate workflow or restores the prerequisite     |

## Accessibility contract

The implementation issues must satisfy:

| Area                   | Rule                                                                                                                                     | Verification                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Keyboard reachability  | Every interactive control reachable via `Tab` + activation via `Enter` / `Space`                                                         | Manual keyboard test + automated `axe-core` traversal |
| Focus visibility       | `:focus-visible` ring on every focusable control; never `outline: none` without replacement                                              | Automated focus-style test                            |
| Focus order            | Tab order matches reading order; no skipped headings                                                                                     | Manual + `axe-core`                                   |
| Focus trap             | Modals trap focus while open; `Esc` releases                                                                                             | Automated test per modal                              |
| Screen reader labeling | Every interactive control has an `aria-label` or visible label; rails use `aria-pressed`/`aria-current`; status surfaces use `aria-live` | `axe-core` + manual VoiceOver/NVDA spot check         |
| Reduced motion         | All non-essential motion gated by `prefers-reduced-motion`                                                                               | Manual check + CSS audit                              |
| Contrast               | All text ≥ 4.5:1; large text ≥ 3:1; icon-only controls have non-color affordance                                                         | `axe-core` color contrast check                       |
| Hit target             | ≥ 24×24 logical px for all interactive controls; ≥ 30×30 for primary                                                                     | Manual measure + CSS audit                            |
| Status announcements   | Streaming/error surfaces use `aria-live` correctly (`polite` for benign, `assertive` for blocking)                                       | Manual VO/NVDA test                                   |
| Non-pointer paths      | Pan / zoom / select all keyboard-reachable                                                                                               | Manual keyboard test                                  |

## Keyboard / input modality matrix

| Modality                     | Primary actions                                                                   | Coverage                                        |
| ---------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Keyboard**                 | Full command set; navigation; selection; activation; cancellation; undo (UI only) | Required                                        |
| **Pointer (mouse)**          | Click; drag windows; drag connections; right-click (OS menu)                      | Required                                        |
| **Trackpad**                 | Two-finger pan; pinch zoom (where supported by browser); click                    | Required (degrades to mouse when not available) |
| **Touch**                    | Tap to focus / open; long-press to inspect (where supported); pinch zoom          | Best-effort (workspace is desktop-first)        |
| **Screen reader**            | All controls labeled; status surfaces announced                                   | Required                                        |
| **Voice control (OS-level)** | Inherits from labels + accessible names                                           | Best-effort via labels                          |

## Reference-traced concepts

| Reference concept            | Where adapted in this blueprint                               |
| ---------------------------- | ------------------------------------------------------------- |
| tldraw command pattern       | "Command model" + minimum shortcut set                        |
| tldraw history API           | "Undo / redo boundary"                                        |
| AFFiNE command/quick-actions | "Command palette" + contextual commands                       |
| Excalidraw action reducer    | rejected — typed command records via `useWorkspace` substrate |
| React Flow node selection    | "Selection model"                                             |

## Follow-up ADR candidates (for #525)

Beyond the seven candidates already named:

8. ADR — Command record contract: typed command shape, authority class, conflict resolution at startup, disabled-reason rule.
9. ADR — Keyboard shortcut conflict resolution + platform normalization.

## Acceptance Criteria evidence

| #523 AC                                                                                          | Where in this document                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every primary journey has a defined UX flow                                                      | "Primary journeys" cross-reference + per-section coverage of navigation, selection, command, recovery                                              |
| Decisions distinguish structured workspace, optional canvas, optional graph                      | "Selection model" addresses windows separately from canvas/graph; canvas/graph deferred to existing substrate per [audit](518-capability-audit.md) |
| User authority moments defined: consent, review, apply, verify, dismiss, archive, escalation     | "Command model — Authority-gated commands" + "Object inspection" + "Error recovery"                                                                |
| Keyboard behavior: focus, activation, cancellation, escape, conflict rules, minimum shortcut set | "Minimum shortcut set" + "Conflict rules"                                                                                                          |
| Undo/redo: what is and is not reversible; evidence preserved                                     | "Undo / redo boundary"                                                                                                                             |
| Error and blocked states preserve user trust                                                     | "State patterns" + "Error recovery"                                                                                                                |
| Accessibility expectations explicit enough to verify                                             | "Accessibility contract"                                                                                                                           |
| No new third-party dependency                                                                    | Implicit throughout — every behavior is `useWorkspace` + React + browser native                                                                    |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#523](https://github.com/oscharko-dev/Keiko/issues/523)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), [518-product-boundaries.md](518-product-boundaries.md)
