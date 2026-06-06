# Epic #532 — Relationship UI Accessibility Checklist

Status: Wave 3 deliverable for [issue #537](https://github.com/oscharko-dev/Keiko/issues/537) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [ui-blueprint.md](ui-blueprint.md), [inspector-spec.md](inspector-spec.md), [activity-visualization.md](activity-visualization.md).

Issue date: 2026-06-06.

## Purpose

This document binds the relationship surface to WCAG 2.2 AA. Every implementation issue ([#540](https://github.com/oscharko-dev/Keiko/issues/540), [#541](https://github.com/oscharko-dev/Keiko/issues/541), [#542](https://github.com/oscharko-dev/Keiko/issues/542)) MUST satisfy every check below. The hardening pass ([#543](https://github.com/oscharko-dev/Keiko/issues/543)) re-verifies.

## WCAG 2.2 AA mapping

| SC         | Requirement                                                                 | Where in the relationship surface                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1.3.1**  | Info and relationships expressed programmatically.                          | Inspector sections use `<div role="heading" aria-level="3">`; edges expose a `<button>` with descriptive `aria-label` (`ConnectionsLayer.tsx:99`); activity badges use `role="status"` + `aria-live="polite"` + `aria-atomic="true"`.                                                                                                                    |
| **1.4.3**  | Contrast (minimum) 4.5:1 for normal text, 3:1 for large text.               | Every colour pair enumerated in [activity-visualization.md "Palette source"](activity-visualization.md) is at ≥ 4.5:1 against its background; `--fg-faint` is forbidden for textual state communication.                                                                                                                                                 |
| **1.4.11** | Non-text contrast 3:1 against adjacent colours.                             | Focus rings use `var(--accent)` on `var(--card)` (≈ 5:1, exceeds 3:1); edge `.conn-path` `stroke: var(--accent)` against `var(--bg)` exceeds 3:1; icon strokes ≥ 1.5 px at 24×24 minimum hit target.                                                                                                                                                     |
| **1.4.12** | Text spacing: no loss of content/functionality when user overrides spacing. | Inspector rows use `rb-row` flex layout; no fixed-width text containers below 280 px; spacing is in `em`/`rem` units, not absolute `px` for line-height.                                                                                                                                                                                                 |
| **1.4.13** | Content on hover or focus is dismissible, hoverable, persistent.            | Denial tooltip during creation is dismissable by `Escape`, hoverable (operator can move pointer onto the banner), persistent until inactivity timeout or operator action.                                                                                                                                                                                |
| **2.1.1**  | Keyboard: all functionality available via keyboard.                         | Every action has a keyboard equivalent — see "Keyboard map for core actions" below. The command palette path is the always-available keyboard equivalent for every pointer gesture.                                                                                                                                                                      |
| **2.1.2**  | No keyboard trap.                                                           | Modals trap focus and restore on close (the existing `PermControl` contract); the inspector returns focus to the originating edge `.conn-badge` on exit; `Escape` releases focus mode and dismisses banners.                                                                                                                                             |
| **2.1.4**  | Character key shortcuts can be turned off or remapped.                      | Single-letter chords (`R`/`A`/`I`/`E`/`F`/`/`) are registered through `useKeyboardShortcuts` ([`useKeyboardShortcuts.ts:137`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts)) and only fire when the focus is inside the inspector or the workspace shell, never globally. They are remappable via the same registry. |
| **2.4.3**  | Focus order matches reading order.                                          | Tab order: edge badge → inspector type → endpoint rows → lifecycle chip → activity → audit history → evidence references → impact → denial reason → action buttons (R/A/Revoke/I/E). Matches section order in [inspector-spec.md](inspector-spec.md).                                                                                                    |
| **2.4.6**  | Headings and labels describe topic or purpose.                              | Section headings use the literal section name from [inspector-spec.md](inspector-spec.md); no generic "Details" / "Info".                                                                                                                                                                                                                                |
| **2.4.7**  | Focus visible.                                                              | Every focusable element gets `focus-visible:outline 2px solid var(--accent)` with 2 px offset (the existing pattern at `globals.css:1305` / `1328` / `1768`). `focus:outline-none` without a `focus-visible:` replacement is forbidden.                                                                                                                  |
| **2.4.11** | Focus not obscured (minimum).                                               | The focused element is fully visible; the inspector scrolls to the focused row; modals never overlap the focused edge during creation preview.                                                                                                                                                                                                           |
| **2.5.7**  | Dragging movements have a single-pointer alternative.                       | Drag-to-connect has a single-pointer alternative (right-click menu) **and** a non-pointer alternative (command palette).                                                                                                                                                                                                                                 |
| **2.5.8**  | Target size (minimum) 24×24 CSS px.                                         | Action buttons use existing `arun-btn` (≥ 28×30 from `globals.css:1972`); edge `.conn-badge` is ≥ 24×24 with adequate padding (`globals.css:1706`); icon-only inspector buttons enforce a minimum 24×24 footprint per [#67 memory pattern](https://github.com/oscharko-dev/Keiko/issues/67).                                                             |
| **3.2.1**  | Focus does not trigger context change.                                      | Tab into a relationship row never opens a modal; opening a modal requires explicit Enter / Space.                                                                                                                                                                                                                                                        |
| **3.2.2**  | Input does not trigger context change.                                      | Filter inputs do not auto-navigate; the URL state updates after a 250 ms debounce, mirroring the existing search-input cadence.                                                                                                                                                                                                                          |
| **3.3.1**  | Error identification: errors identified in text.                            | Every denial reason renders its user-facing message verbatim from [denial-reasons.md](denial-reasons.md). Network errors render the typed BFF error envelope ([api-contract.md §3.4](api-contract.md)).                                                                                                                                                  |
| **3.3.3**  | Error suggestion: suggestions provided.                                     | Each denial code maps to a remediation hint (see [error-and-denial-ux.md](error-and-denial-ux.md)).                                                                                                                                                                                                                                                      |
| **4.1.2**  | Name, role, value programmatically determinable.                            | Every interactive element has explicit role and name (`<button type="button" aria-label="…">`); icon-only buttons always carry `aria-label`.                                                                                                                                                                                                             |
| **4.1.3**  | Status messages: announced via `aria-live` without focus change.            | Activity-state changes via `aria-live="polite"`; creation denials via `aria-live="assertive"`; load errors via `aria-live="assertive"` with `role="alert"`; filter changes via `aria-live="polite"` ("Showing 12 of 47…").                                                                                                                               |

## Keyboard map for core actions

The keyboard map below combines the inspector chords from [inspector-spec.md "Keyboard map"](inspector-spec.md) with the surface-wide chords introduced by the blueprint. All chords are registered through [`useKeyboardShortcuts.ts:137`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts); the conflict-at-startup gate at `useKeyboardShortcuts.ts:149` fails the build if any chord collides with `WORKSPACE_RESERVED_CHORDS` or with the existing #66 / #67 chord set.

| Action                                                   | Chord             | Notes                                                                                                                       |
| -------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Open command palette                                     | (existing chord)  | Per the existing workspace contract. The palette is the always-available keyboard equivalent for creation.                  |
| Create relationship (from focused window)                | `Shift+C`         | Opens the palette pre-filled with "Create relationship from <focused window>".                                              |
| Cycle to next workspace window                           | (existing chord)  | Tab cycles among workspace windows; relationship surfaces inherit the existing #527 substrate.                              |
| Focus filter input                                       | `/`               | Matches the existing search-input chord precedent; focuses the relationship filter input in the inspector / surface header. |
| Toggle focus mode                                        | `F`               | Toggles `data-relationship-focus` on `.workspace`; restoration via `Escape`.                                                |
| Restore default view (clear filters, focus, density)     | `Escape`          | When pressed at the workspace root (no input focus), clears focus mode and dismisses the denial banner.                     |
| Inspect a relationship from a focused edge `.conn-badge` | `Enter` / `Space` | Native button activation.                                                                                                   |
| Reconnect a blocked relationship                         | `R`               | Inspector chord; gated by lifecycle ([inspector-spec.md "Action buttons"](inspector-spec.md)).                              |
| Archive an active relationship                           | `A`               | Inspector chord; gated by lifecycle. Requires confirmation modal.                                                           |
| Revoke a relationship                                    | `Shift+Delete`    | Inspector chord; requires confirmation modal. Standard "destructive needs modifier" pattern.                                |
| View impact (switch inspector tab)                       | `I`               | Inspector chord.                                                                                                            |
| View evidence (focus Evidence viewer)                    | `E`               | Inspector chord; gated by evidence-reference count > 0.                                                                     |

### Creation flow keyboard sequence (no pointer)

1. Press the palette chord. The palette opens.
2. Type "create relationship" and select it. A two-step prompt opens.
3. Source step: select the source kind from the closed `EndpointKind` set ([taxonomy.md §4](taxonomy.md)); the cursor lands in a search input over already-open workspace windows.
4. Pick the source endpoint by typing its name or arrow-navigating.
5. Target step: same as source.
6. Press `Enter`. The validate-then-create cycle runs. Result announces via `aria-live="polite"` (success) or `aria-live="assertive"` (denial). On denial, the inspector opens to the denial section.

This sequence is the WCAG 2.1.1 keyboard-equivalent of the drag-to-connect gesture. **No relationship action is reachable only by pointer.**

### Inspect flow keyboard sequence

1. Tab into the workspace shell.
2. Tab to a workspace window.
3. Tab to the edge `.conn-badge`. (Edges are reachable in DOM order; the inspector relationship-focus state additionally exposes per-edge badges as siblings of the window in tab order.)
4. Press `Enter`. Inspector opens.
5. Tab through inspector sections in declared order.
6. Press `Escape` to exit inspector and restore focus to the originating edge badge.

### Filter flow keyboard sequence

1. Press `/`. Filter input gains focus.
2. Type a filter token (e.g., `type:produces-evidence`).
3. Press `Enter`. URL state updates; `aria-live="polite"` announces "Showing N of M relationships, filtered by …".
4. Press `Escape` in the input to clear the filter and announce "Filter cleared".

## Screen-reader behaviour

| Surface                            | Announcement                                                                                               | ARIA-live         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| Edge appears                       | None (passive content; edges are not announced individually).                                              | n/a               |
| Edge is focused (via Tab)          | Native button announcement: `aria-label="Inspect relationship: <type> from <sourceKind> to <targetKind>"`. | n/a               |
| Inspector opens for a relationship | "Inspector: <type> relationship, lifecycle <state>, activity <state>."                                     | `polite`          |
| Activity state changes             | "<Type> relationship activity: <new state>."                                                               | `polite`          |
| Denial during creation preview     | "<User-facing denial message from [denial-reasons.md](denial-reasons.md)>"                                 | `assertive`       |
| Denial in inspector                | Same message; rendered as static section content.                                                          | `polite`          |
| Load error                         | "Unable to load relationship details. Retry."                                                              | `assertive`       |
| Network offline                    | "Unable to reach the local backend. Check that keiko serve is running."                                    | `assertive`       |
| Filter change                      | "Showing N of M relationships, filtered by …" / "Filter cleared".                                          | `polite`          |
| Aggregate render (> N_VISIBLE)     | "12 more relationships are processing." (debounced; max one announcement per 2 seconds)                    | `polite`          |
| Confirmation modal opens           | Native dialog announcement (existing `PermControl` contract).                                              | n/a (role=dialog) |

**No autoplay sound. No vibration. No screen-reader interruption.** Every assertive announcement is short and informational; every polite announcement is debounced to prevent thrashing.

## Color independence verification matrix

Every activity state and every lifecycle state MUST be distinguishable without colour. The verification matrix:

| State family | Member            | Text label cue    | Icon cue                           | Position cue           | Color cue (optional)   |
| ------------ | ----------------- | ----------------- | ---------------------------------- | ---------------------- | ---------------------- |
| Activity     | `inactive`        | "Inactive"        | hollow circle                      | inspector + edge badge | `--fg-muted`           |
| Activity     | `queued`          | "Queued"          | clock face                         | inspector + edge badge | `--fg-muted`           |
| Activity     | `active`          | "Active"          | filled circle                      | inspector + edge badge | `--accent`             |
| Activity     | `processing`      | "Processing"      | rotating / static segmented circle | inspector + edge badge | `--accent`             |
| Activity     | `completed`       | "Completed"       | check mark                         | inspector + edge badge | `--accent`             |
| Activity     | `failed`          | "Failed"          | triangle with exclamation          | inspector + edge badge | `--danger`             |
| Activity     | `blocked`         | "Blocked"         | warning-square                     | inspector + edge badge | `--warn`               |
| Activity     | `degraded`        | "Degraded"        | broken-line pattern                | inspector + edge badge | `--warn`               |
| Activity     | `high-throughput` | "High throughput" | stacked-lines + numeric count      | inspector + edge badge | `--accent`             |
| Lifecycle    | `draft`           | "Draft"           | hollow circle                      | inspector chip         | `--fg-muted`           |
| Lifecycle    | `active`          | "Active"          | filled circle                      | inspector chip         | `--accent`             |
| Lifecycle    | `archived`        | "Archived"        | filled square                      | inspector chip         | `--fg-dim`             |
| Lifecycle    | `superseded`      | "Superseded"      | arrow-right                        | inspector chip         | `--fg-dim`             |
| Lifecycle    | `revoked`         | "Revoked"         | filled X                           | inspector chip         | `--danger`             |
| Lifecycle    | `blocked`         | "Blocked"         | warning-square                     | inspector chip         | `--warn`               |
| Lifecycle    | `stale`           | "Stale"           | hollow square                      | inspector chip         | `--fg-faint` (caption) |

Every cell pair in (text label, icon cue) is **unique** within its state family. A monochrome rendering still distinguishes every state.

The verification rule for #541 / #542: after rendering, the test suite MUST run a screenshot of the inspector under `prefers-contrast: more` + monochrome filter and assert that all visible state badges remain distinguishable by label + icon alone (no automated metric; manual review under a documented checklist).

## Focus management

| Scenario                                         | Focus behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspector opens (relationship mode)              | Focus moves to the inspector's first interactive control (the "Inspect relationship" heading is rendered as `<h3>` for screen-reader landing; first focusable control after is the relationship type chip if it links to documentation, else the action button row).                                                                                                                                                                                                                                                                                                                    |
| Inspector closes                                 | Focus returns to the originating edge `.conn-badge`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Modal opens (`PermControl` for Archive / Revoke) | The existing `PermControl` contract traps focus and labels via `aria-labelledby aria-describedby`. Focus on close returns to the inspector action button.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Filter input gains focus (`/`)                   | Cursor lands in the input. Tab moves to the next inspector section, never out of the inspector container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Escape` at workspace root                       | Clears focus mode and dismisses banners. Focus stays at the workspace root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Roving tabindex on inspector tab strip           | If the inspector exposes a tab strip (e.g., "Details / Audit history / Evidence / Impact"), it uses roving tabindex per the [#65 memory pattern](https://github.com/oscharko-dev/Keiko/issues/65) — `aria-selected` on the active tab, `tabIndex={0}` on the active tab and `tabIndex={-1}` on the inactive tabs, arrow-keys to move selection. Each inactive tab still has a `focus-visible:` ring rule so a user who routes around the roving model with Shift+Tab does not lose focus visibility ([#67 WCAG 2.4.7 BLOCKER lesson](https://github.com/oscharko-dev/Keiko/issues/67)). |

### `focus:outline-none` rule

`focus:outline-none` is **forbidden** unless paired with a `focus-visible:` rule that restores visible focus. The hardening pass ([#543](https://github.com/oscharko-dev/Keiko/issues/543)) MUST grep for `focus:outline-none` across the relationship surface and assert every occurrence has a sibling `focus-visible:` rule.

## Forms and inputs

| Input                                  | Label requirement                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Filter inputs                          | Visible `<label>` (not `aria-label` only); placeholder is not a label.                               |
| Source / target type pickers (palette) | The palette result list rows are `<button>` elements with descriptive text; no `<select>` is needed. |
| Confirmation dialog primary CTA        | Descriptive button text ("Revoke relationship") — never bare "OK" / "Yes".                           |

## Forbidden patterns

The implementation MUST NOT:

- Use `<div onClick>` for any interactive surface. Use `<button type="button">` always.
- Use `role="link"` on `<div>` / `<span>` to fake a link. Use `<a href>` always.
- Use `tabIndex={-1}` without a `focus-visible:` replacement.
- Use color alone to indicate state (per the verification matrix above).
- Use motion alone to indicate state (per [activity-visualization.md](activity-visualization.md)).
- Auto-focus on page load except the documented modal contract.
- Trap focus outside an explicit modal context.
- Suppress browser context menus globally; only the workspace's window-context menu suppresses the native context menu within the window region.
- Use `outline: none` without `focus-visible:` replacement.
- Use `aria-live="assertive"` for non-blocking announcements.
- Auto-dismiss assertive alerts in under 5 seconds.
- Render Tailwind class `bg-red-600 text-ink-inverse` (computed 3.47:1 in prior project context — kept as a contrast floor reminder; the Keiko palette is CSS custom properties, not Tailwind, but the contrast floor applies to any equivalent computed pair).

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#540](https://github.com/oscharko-dev/Keiko/issues/540), [#541](https://github.com/oscharko-dev/Keiko/issues/541), [#542](https://github.com/oscharko-dev/Keiko/issues/542), [#543](https://github.com/oscharko-dev/Keiko/issues/543).
- Companions: [ui-blueprint.md](ui-blueprint.md), [inspector-spec.md](inspector-spec.md), [activity-visualization.md](activity-visualization.md), [error-and-denial-ux.md](error-and-denial-ux.md).
- Foundation: [activity-state.md](activity-state.md), [denial-reasons.md](denial-reasons.md), [lifecycle.md](lifecycle.md), [taxonomy.md](taxonomy.md).
- Existing UI: [`useKeyboardShortcuts.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts), [`ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx), [`InspectorPanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx), `globals.css`.
- Workspace blueprints: [518-ui-blueprint.md](../workspace/518-ui-blueprint.md), [518-ux-blueprint.md](../workspace/518-ux-blueprint.md).
- ADRs: [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).
