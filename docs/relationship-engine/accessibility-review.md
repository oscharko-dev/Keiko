# Relationship engine — accessibility review evidence (#543)

Status: Issue [#543](https://github.com/oscharko-dev/Keiko/issues/543) hardening evidence for Epic [#532](https://github.com/oscharko-dev/Keiko/issues/532).

This document records WCAG 2.2 AA verification for the relationship UI shipped in #540 and #541, with the activity layer and inspector chrome.

## Scope verified

- Color independence on every relationship state (lifecycle + activity).
- Reduced-motion alternatives.
- Keyboard-only flows for select / inspect / filter / focus-mode / exit.
- Focus visibility and target size on interactive controls.
- Semantic ARIA labels and live-region semantics for transitions and denials.
- Inspector behavior under empty / loading / error states.

## Verified controls

### 1. Color-independence matrix

Every lifecycle and activity state communicates via at least three of (text label, ARIA description, icon, color). The activity-state badge always emits text + ARIA + icon; color is optional. The matrix is enforced by tests in `RelationshipEdgeBadge.test.tsx` that assert each of the 9 activity states renders the spec-exact ARIA text from `activity-state.md §6` and an icon, without color-only assertions.

Forbidden combinations explicitly rejected:

- `bg-red-600` + `text-ink-inverse` (3.47:1) — never used.
- Failure / blocked states use `bg-red-500` + `text-ink-inverse` (5.57:1) — verified by regression test in `RelationshipEdgeBadge.test.tsx`.

### 2. Reduced-motion alternatives

Every animation in the relationship UI is prefixed with Tailwind's `motion-safe:` variant. The `useRelationshipActivityStream` hook reads `window.matchMedia('(prefers-reduced-motion: reduce)')` and emits an `animate` flag. When the flag is false, badges render static, no transitions, no pulses. Tests in `useRelationshipActivityStream.test.tsx` mock the matchMedia query and assert the static fallback.

The `high-throughput` state is a numeric aggregate (count over `T = 60s`), never a fast pulse. This is verified by a dedicated test that renders 50 events in 60 s and asserts the badge has no `animate-*` class.

### 3. Keyboard map verified

Every action in `inspector-spec.md` has a working chord registered through the existing `useKeyboardShortcuts.ts` substrate:

| Action                               | Chord                  | Verified by                           |
| ------------------------------------ | ---------------------- | ------------------------------------- |
| Create relationship (focused window) | `Shift+C`              | `RelationshipCreateDialog.test.tsx`   |
| Open command palette                 | existing palette chord | inherited from #66                    |
| Focus filter input                   | `/`                    | `RelationshipListPanel.test.tsx`      |
| Toggle focus mode                    | `F`                    | `RelationshipListPanel.test.tsx`      |
| Restore default / dismiss            | `Escape`               | `RelationshipListPanel.test.tsx`      |
| Inspect from focused edge            | `Enter` / `Space`      | `RelationshipEdgeBadge.test.tsx`      |
| Reconnect (lifecycle = blocked)      | `R`                    | `RelationshipInspectorPanel.test.tsx` |
| Archive (lifecycle = active)         | `A`                    | `RelationshipInspectorPanel.test.tsx` |
| Revoke (with confirmation)           | `Shift+Delete`         | `RelationshipInspectorPanel.test.tsx` |
| View Impact                          | `I`                    | `RelationshipInspectorPanel.test.tsx` |
| View Evidence                        | `E`                    | `RelationshipInspectorPanel.test.tsx` |

Tab order is sequential and natural (DOM order); no `tabIndex` overrides are used. `<button aria-pressed>` is used for the focus-mode and density toggles, avoiding the `role="radio"` roving-tabindex trap from memory.

### 4. Focus visibility and target size

Every interactive control renders `focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent`. No `focus:outline-none` without a `:focus-visible` replacement. Edge badge buttons and inspector action buttons measure at least 24 × 24 CSS pixels (WCAG 2.5.8 target size, new in WCAG 2.2). Verified by tests in `RelationshipEdgeBadge.test.tsx` and `RelationshipInspectorPanel.test.tsx`.

### 5. Semantic ARIA and live regions

- Each activity-state change emits `aria-live="polite"` updates (badge `aria-label` reflects the new state).
- Denial banners use `aria-live="assertive"` for immediate announcement.
- Truncation banners use `aria-live="polite"`.
- Inspector sections are landmark regions with `aria-labelledby` headings.
- `axe-core` runs over the inspector and a 25-mixed-state badge list pass without violations (jest-axe).

### 6. Inspector empty / loading / error states

- Empty state renders an `<output>` element with role implied; aria-busy is removed once loading completes.
- Loading state uses an `aria-busy="true"` chrome skeleton, not an animated spinner.
- Error state renders inside `role="alert"` to be announced by screen readers immediately.

## Findings

| Severity | Finding                                                                                                                                                                                                              | Disposition                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| LOW      | Two UI tests originally queried the error text by regex; the rendered text spans multiple inline elements, breaking the regex match. The tests were updated to use `role="alert"` and `data-testid` scoping in #543. | Fixed.                              |
| LOW      | The categorized health findings from #542 do not yet have a dedicated UI panel. When that follow-up lands, it MUST honor the same color-independence, motion, keyboard, and live-region rules captured here.         | Deferred with binding requirements. |
| INFO     | jest-axe assertions are inline inside component tests rather than in a dedicated a11y suite. The current arrangement keeps regressions tied to the component under test. No change recommended.                      | Accepted.                           |

No HIGH or BLOCKER findings. All five UI acceptance criteria for #543 are satisfied.
