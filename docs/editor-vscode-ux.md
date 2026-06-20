# Editor VS Code-feeling UX: shortcuts, command palette, status bar, search, accessibility

Issue [#1205](https://github.com/oscharko-dev/Keiko/issues/1205) · Parent epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Decision record
[ADR-0042](adr/ADR-0042-keiko-editor-package-and-boundaries.md).

This is the **UX interaction specification** for the Keiko Editor surface inside the Workspace card.
It raises the editor from a functional Monaco embedding to a coherent, VS Code-feeling tool surface:
familiar keyboard shortcuts (with a conflict review against the Workspace window chords), command
palette integration, a unified status bar, find/hunk navigation, and a calibrated accessibility
contract. It is deliberately **not** a full VS Code workbench reproduction and has no extension
marketplace (both explicit non-goals).

The work reuses the editor capabilities already shipped by the epic — the deterministic language
service ([#1198]), the governed completion gateway ([#1199]), inline completion ([#1200]), the
diagnostics/hover/symbol/format hooks ([#1201]), and the governed test-generation scaffold
([#1202]). #1205 adds only the **UX surface** over them; it introduces no new model call, BFF route,
or product capability.

[#1198]: https://github.com/oscharko-dev/Keiko/issues/1198
[#1199]: https://github.com/oscharko-dev/Keiko/issues/1199
[#1200]: https://github.com/oscharko-dev/Keiko/issues/1200
[#1201]: https://github.com/oscharko-dev/Keiko/issues/1201
[#1202]: https://github.com/oscharko-dev/Keiko/issues/1202

## Architecture (browser renders, host wires, server governs)

```
EditorWidget (keiko-ui card host)
  ├─ tab strip ........... role="tablist" → the active document tab (role="tab")
  ├─ action buttons ...... Generate Tests / Cancel / Reload / Save
  ├─ EditorSurface ....... next/dynamic(ssr:false) → KeikoCodeEditor (Monaco)
  │     └─ onMount wires: save action, Generate Tests command action,
  │        find/format/inline-suggest/command-palette/accessibility-help (Monaco built-ins),
  │        cursor + selection + diagnostics-summary reporting
  └─ EditorStatusBar ..... role="group" → the single, unified status surface (+ one polite live region)
```

The `@oscharko-dev/keiko-editor` package owns rendering, the Monaco runtime, the command-action
descriptors, the keybinding catalogue, and the pure status-bar view model (`deriveEditorStatusBar`).
The keiko-ui host owns the BFF calls, the file/save lifecycle, and the status-bar **data**. No editor
boundary is relaxed (ADR-0042 D1): the editor computes nothing and calls no model.

## Keyboard shortcuts and the Workspace conflict review

Familiar editor chords work because they are **Monaco built-ins** active whenever the editor is
focused, plus the Keiko-registered Save and Generate Tests actions. The full list, with the
Keiko-specific notes:

| Action                   | macOS              | Windows/Linux           | Source                                                                                                      |
| ------------------------ | ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Save document            | `⌘S`               | `Ctrl+S`                | Keiko action (`keiko.editor.save`); a capturing keydown backstop also blocks the browser "Save page" dialog |
| Command palette          | `F1`               | `F1`                    | Monaco `editor.action.quickCommand` (also in the right-click menu)                                          |
| Find / search            | `⌘F`               | `Ctrl+F`                | Monaco `actions.find`                                                                                       |
| Find next / previous     | `Enter` / `⇧Enter` | `Enter` / `Shift+Enter` | Monaco find widget                                                                                          |
| Format document          | `⇧⌥F`              | `Shift+Alt+F`           | Monaco `editor.action.formatDocument` (governed formatter, [#1201])                                         |
| Generate tests           | `⌘⌥T`              | `Ctrl+Alt+T`            | Keiko action (`keiko.editor.generateTests`); governed flow, off in v1                                       |
| Accept inline suggestion | `Tab`              | `Tab`                   | Monaco `editor.action.inlineSuggest.commit` ([#1200])                                                       |
| Reject / hide suggestion | `Esc`              | `Esc`                   | Monaco `editor.action.inlineSuggest.hide`                                                                   |
| Accessibility help       | `⌥F1`              | `Alt+F1`                | Monaco `editor.action.accessibilityHelp`                                                                    |
| Go to symbol             | `⌘⇧O`              | `Ctrl+Shift+O`          | Monaco, backed by the symbol provider ([#1201])                                                             |
| Toggle fold / unfold     | `⌥⌘[` / `⌥⌘]`      | `Ctrl+Shift+[` / `]`    | Monaco folding                                                                                              |

### Conflict review against Workspace-global shortcuts

The Workspace registers a single `window` `keydown` listener
([`useWorkspace.ts`](../packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts)) for window
management:

| Workspace chord        | Effect                              |
| ---------------------- | ----------------------------------- |
| `Cmd/Ctrl+Arrow`       | Move the frontmost window           |
| `Alt+Arrow`            | Resize the frontmost window         |
| `Cmd/Ctrl+Alt+±` / `0` | Window content zoom                 |
| `Escape`               | Cancel an in-flight connection drag |

`Cmd/Ctrl+Arrow` (Monaco: caret to line/document bounds) and `Alt+Arrow` (Monaco: move line up/down)
**would** collide with the editor. They do not, because the Workspace handler guards on
`isFormField(document.activeElement)` and returns early when a form field holds focus. **Monaco's
editing surface is a `<textarea>`**, so while the user is typing in the editor the Workspace window
chords are skipped and the keys reach Monaco instead. `Escape` is intentionally exempt from the guard
but is a no-op unless a connection drag is active, so it never corrupts editor text. This is the
mechanism that satisfies Acceptance Criterion 2 ("Workspace-global shortcuts do not corrupt editor
text input"); it is locked by a regression test (see Verification).

The Keiko-registered Generate Tests chord (`Cmd/Ctrl+Alt+T`) is an editor action, so it fires only
when the editor is focused — where the Workspace guard already shields the textarea — and it composes
no Workspace or Monaco built-in chord.

## Command palette integration

There is **one** command palette: Monaco's native quick-command palette (`F1`, or right-click →
Command Palette). It is keyboard-driven and screen-reader-supported, so the editor reuses it rather
than building a parallel palette. Keiko's host-owned commands are registered into it via
`editor.addAction`, so they appear alongside the built-ins with a consistent label and keybinding.

The #1205 command vocabulary is modelled deterministically in `EDITOR_COMMANDS` with capability- and
state-gated availability (`isCommandAvailable`), the same model shipped by [#1192]:

[#1192]: https://github.com/oscharko-dev/Keiko/issues/1192

| Command                  | Surfacing                             | Availability                                                                                            |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Save document            | Keiko action + palette                | Editable, dirty buffer                                                                                  |
| Generate tests           | Keiko action + palette + context menu | Governed TS/JS source; the server returns `disabled` in v1 (ADR-0042 D7)                                |
| Format document          | Monaco built-in (palette)             | `formatDocument` capability wired (governed formatter)                                                  |
| Find                     | Monaco built-in (palette)             | Always, once mounted                                                                                    |
| Accept inline completion | Monaco built-in                       | A ghost-text suggestion is visible                                                                      |
| Reject suggestion        | Monaco built-in                       | A ghost-text suggestion is visible                                                                      |
| Open diff                | Vocabulary (capability-gated)         | `previewPatch` capability — surfaces through the governed test-generation review flow ([#1195]/[#1202]) |
| Run verification         | Vocabulary (capability-gated)         | `runVerification` capability — part of the governed review flow, switched off in v1                     |

[#1195]: https://github.com/oscharko-dev/Keiko/issues/1195

"Open diff" and "Run verification" are deterministic vocabulary entries whose host capability is not
injected while the governed review flow is switched off (ADR-0042 D7); they do not register a live
palette action until that capability is enabled. This is stated precisely rather than presented as a
working feature.

## Status bar

The card renders one unified status bar (`EditorStatusBar`) at the bottom — the single status surface
(the editor's own footer is suppressed in the card to avoid two competing surfaces). Fields are
derived purely by `deriveEditorStatusBar`:

- **Language** — TypeScript / JavaScript / Plain Text.
- **Read-only** — shown only when the buffer is read-only (e.g. over the size limit).
- **Completions on/off** — whether the governed deterministic provider is available for the file type.
- **Problems** — error/warning/info counts from the diagnostics bridge ([#1201]); error tone when any
  error exists.
- **Run** — a compact, content-free test-generation/verification status; absent when idle.
- **Cursor** — `Ln, Col` (1-based for display).
- **Selection** — shown only for a multi-line selection.
- **Save** — Unsaved / Saving… / Saved / Save failed / Conflict.

Engineering note compliance: the bar carries no how-to text; it communicates state, not instructions.

## Multi-tab / multi-model scope

The Workspace card hosts a **single linked document** (the file chosen in the Files window drives the
editor target), so the tab strip is implemented as a valid single-document `tablist`/`tab`/`tabpanel`
structure rather than a full multi-tab manager. This is the feasible slice inside the card
constraints; opening multiple documents as competing tabs is out of scope for the single-file card
model and is intentionally **not** faked. Monaco preserves per-document scroll/fold/cursor view state
across host file swaps.

## Search and hunk navigation

In-file search is Monaco's find widget (`Cmd/Ctrl+F`) with seed-from-selection enabled. Hunk
navigation lives in the diff/patch review surface ([#1195]): `KeikoDiffEditor` exposes Monaco's
built-in `goToDiff` next/previous-change navigation when a generated patch is being reviewed.

## Accessibility

Calibrated to Monaco's documented capabilities (epic #1189 Review Addendum):

- **Editor chrome holds WCAG 2.2 AA.** The tab (`role="tab"`, keyboard-focusable, visible focus
  ring), the status bar (labelled `group`, per-field accessible names), the command palette (Monaco
  quick-input), the find widget, and the action buttons are all keyboard-operable with AA-contrast
  tones (`--warn`/`--danger` carry light-theme AA overrides).
- **Meaningful status without flooding.** The status bar exposes one polite live region carrying only
  meaningful state changes (save outcome, diagnostics, run state). The cursor position — which changes
  on every keystroke — is a labelled field read on demand, **never** in a live region, so assistive
  tech is not flooded.
- **Monaco screen-reader mode is enabled.** `accessibilitySupport: "auto"` makes Monaco detect an
  active screen reader and switch the editing surface into accessible-textarea mode automatically,
  preferred over a hard `"on"` that would degrade sighted keyboard users.
- **Accessibility help is reachable.** Monaco's accessibility-help dialog
  (`editor.action.accessibilityHelp`, `Alt+F1` / `⌥F1`) stays enabled and documents the
  editing-surface keybindings.
- **Keyboard-only edit→generate→review→apply path.** Save (`Cmd/Ctrl+S`), Generate Tests
  (`Cmd/Ctrl+Alt+T` or the palette), and the diff review actions are all reachable without a pointer.

### Known limitation (stated precisely, not silently failed)

The Monaco **editing canvas itself** is a virtualized, custom-rendered surface; it inherits Monaco's
documented accessibility behaviour rather than asserting full WCAG 2.2 AA on the canvas. Screen-reader
users operate it through Monaco's screen-reader mode and accessibility-help dialog. The Keiko chrome
around the canvas (tabs, status bar, palette, find, buttons) is held to WCAG 2.2 AA.

## Verification

- **Keyboard shortcut + command tests** — `command-actions.test.ts`, `on-mount.test.ts`
  (`packages/keiko-editor/src/components/`): the Generate Tests action id, `Cmd/Ctrl+Alt+T` chord,
  context-menu group, host-handler delegation, and disposal.
- **Workspace conflict regression** —
  `useWorkspace.keyboard.test.tsx`: a focused editor `<textarea>` skips the Workspace move/resize
  chords (Acceptance Criterion 2).
- **Status bar model + component** — `status-bar.test.ts`, `EditorStatusBar.test.tsx`: field
  derivation, the cursor-is-never-announced rule, tone mapping, and the single polite live region.
- **Host wiring** — `EditorWidget.test.tsx`: the tablist/tabpanel roles, cursor and diagnostics
  surfacing, the Generate Tests command wiring, and footer suppression.
- **Accessibility** — `KeikoCodeEditor.a11y.test.tsx`, `EditorStatusBar.test.tsx`, and the
  `accessibilitySupport: "auto"` assertion in `editor-options.test.ts`.
