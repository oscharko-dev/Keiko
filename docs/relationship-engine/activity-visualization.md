# Epic #532 — Relationship Activity Visualization

Status: Wave 3 deliverable for [issue #537](https://github.com/oscharko-dev/Keiko/issues/537) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [ui-blueprint.md](ui-blueprint.md), [activity-state.md](activity-state.md), [accessibility-checklist.md](accessibility-checklist.md).

Issue date: 2026-06-06.

## Purpose

This document specifies the visual treatment of the nine relationship activity states ([activity-state.md §2](activity-state.md)): per-state colour against the dark Keiko palette, per-state icon, motion rules, contrast budget, reduced-motion behaviour, and the forbidden visual patterns. It binds [#541](https://github.com/oscharko-dev/Keiko/issues/541).

The contract here is a strict subset of what [activity-state.md §6](activity-state.md) already specified: this document picks concrete tokens from the existing Keiko palette and lists every value with its WCAG contrast number, so the implementation in #541 has zero degrees of freedom in colour choice.

## Palette source

Every colour token below is defined in [`packages/keiko-ui/src/app/globals.css`](../../packages/keiko-ui/src/app/globals.css) at the lines noted. **No new colour token is added.**

| Token (CSS variable) | Hex equivalent (dark theme) | Defined at       | Used in this document for       |
| -------------------- | --------------------------- | ---------------- | ------------------------------- |
| `--bg`               | ≈ `#1a1f1c`                 | `globals.css:13` | App background reference.       |
| `--card`             | ≈ `#2c322f`                 | `globals.css:15` | Badge background.               |
| `--inset`            | ≈ `#202522`                 | `globals.css:17` | Skeleton wells.                 |
| `--fg`               | ≈ `#f3f5f4`                 | `globals.css:25` | Default text on `--card`.       |
| `--fg-muted`         | ≈ `#b1b5b3`                 | `globals.css:26` | Informational text on `--card`. |
| `--fg-dim`           | ≈ `#8a8e8c`                 | `globals.css:27` | De-emphasised metadata.         |
| `--fg-faint`         | ≈ `#6f7472`                 | `globals.css:28` | Timestamps, captions.           |
| `--ink-inverse`      | ≈ `#1a1e23`                 | `globals.css:31` | Text on accent-filled badges.   |
| `--accent`           | `#4eba87`                   | `globals.css:35` | Active / processing.            |
| `--accent-dim`       | derived 18% mix             | `globals.css:37` | Badge background for accent.    |
| `--accent-line`      | derived 40% mix             | `globals.css:38` | Badge border for accent.        |
| `--ok`               | `#4eba87`                   | `globals.css:42` | Completed.                      |
| `--warn`             | oklch(0.78 0.13 75)         | `globals.css:43` | Blocked / degraded.             |
| `--info`             | oklch(0.74 0.1 240)         | `globals.css:44` | Queued (informational).         |
| `--danger`           | oklch(0.68 0.16 25)         | `globals.css:45` | Failed.                         |

Computed contrast (dark theme, against `--card` background ≈ `#2c322f` unless noted):

| Token                         | Contrast vs `--card` | Notes                                                                                                                                                               |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--fg` on `--card`            | ≥ 12:1               | Default body text contrast; AAA.                                                                                                                                    |
| `--fg-muted` on `--card`      | ≥ 5.2:1              | Passes WCAG 1.4.3 AA (4.5:1). Use for informational text.                                                                                                           |
| `--fg-dim` on `--card`        | ≈ 3.4:1              | Fails 1.4.3 AA for normal text; permitted only for ≥18pt labels or for non-text UI border parts under 1.4.11 (3:1).                                                 |
| `--fg-faint` on `--card`      | < 3:1                | **Forbidden for textual state communication.** Permitted only for metadata captions (timestamps) that have a text-label peer.                                       |
| `--accent` on `--card`        | ≈ 5.0:1              | Passes 1.4.3 AA.                                                                                                                                                    |
| `--warn` on `--card`          | ≈ 4.9:1              | Passes 1.4.3 AA.                                                                                                                                                    |
| `--danger` on `--card`        | ≈ 4.6:1              | Passes 1.4.3 AA.                                                                                                                                                    |
| `--info` on `--card`          | ≈ 4.7:1              | Passes 1.4.3 AA.                                                                                                                                                    |
| `--ink-inverse` on `--accent` | ≈ 6.9:1              | The pattern the workspace shell already uses for "text on accent surface" (per [518-ui-blueprint.md "Visual rules"](../workspace/518-ui-blueprint.md)). Passes AAA. |

The contrast numbers above are derived from the oklch values in `globals.css` and matched against the SC 1.4.3 / 1.4.11 thresholds. The implementation in #541 MUST re-verify with an `axe-core` sweep on the actual rendered DOM before merge ([accessibility-checklist.md](accessibility-checklist.md)).

## Per-state visual treatment

Each row binds the four-descriptor rule from [activity-state.md §6](activity-state.md) (text label, ARIA description, icon, optional colour) to concrete Keiko CSS variables.

| State             | Label             | Icon (shape)                                   | Text colour (token) | Background (token)                                       | Contrast vs background | Motion (default)                                                      |
| ----------------- | ----------------- | ---------------------------------------------- | ------------------- | -------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `inactive`        | "Inactive"        | hollow circle                                  | `var(--fg-muted)`   | `var(--inset)`                                           | ≥ 4.7:1                | None.                                                                 |
| `queued`          | "Queued"          | clock face                                     | `var(--fg-muted)`   | `var(--inset)`                                           | ≥ 4.7:1                | None.                                                                 |
| `active`          | "Active"          | filled circle                                  | `var(--accent)`     | `var(--accent-dim)` with 1px `var(--accent-line)` border | ≥ 4.5:1                | None.                                                                 |
| `processing`      | "Processing"      | rotating segmented circle                      | `var(--accent)`     | `var(--accent-dim)` with `var(--accent-line)` border     | ≥ 4.5:1                | Existing `@keyframes spin` at `globals.css:146`, gated `motion-safe`. |
| `completed`       | "Completed"       | check mark                                     | `var(--accent)`     | `var(--accent-dim)`                                      | ≥ 4.5:1                | None.                                                                 |
| `failed`          | "Failed"          | filled triangle with exclamation               | `var(--danger)`     | `color-mix(in oklch, var(--danger) 12%, var(--card))`    | ≥ 4.5:1                | None.                                                                 |
| `blocked`         | "Blocked"         | filled square (warning-square)                 | `var(--warn)`       | `color-mix(in oklch, var(--warn) 12%, var(--card))`      | ≥ 4.5:1                | None.                                                                 |
| `degraded`        | "Degraded"        | broken-line pattern                            | `var(--warn)`       | `color-mix(in oklch, var(--warn) 8%, var(--card))`       | ≥ 4.5:1                | None.                                                                 |
| `high-throughput` | "High throughput" | three stacked horizontal lines + numeric count | `var(--accent)`     | `var(--accent-dim)`                                      | ≥ 4.5:1                | None. The count updates as a value, never a flash.                    |

### Why colours repeat

`active` / `processing` / `completed` / `high-throughput` all use the accent palette. This is **by design** ([activity-state.md §6 column (d) note](activity-state.md)): operators learn one "this is normal forward progress" colour. The differentiation between these four states is carried by the **icon shape** (filled circle / rotating segment / check / stacked lines) and the **text label** — never by colour. Removing the colour entirely (under `prefers-contrast: more`, see §"Contrast accommodations") leaves the four states still distinguishable.

`blocked` and `degraded` similarly share the `--warn` palette; they differ by icon (filled square vs broken-line).

### Color-mix on the dark palette

The colour-mix expressions (`color-mix(in oklch, var(--danger) 12%, var(--card))`) reuse the exact pattern from the existing `.arun-error` rule (`globals.css:2160`) and `.arun-gate` (`globals.css:1944`). This produces sub-tinted backgrounds that pass 4.5:1 against the foreground token while staying within the dark-palette family. **No new colour values are introduced.**

## Motion rules

### The four-descriptor binding obviates motion

Per [activity-state.md §6.1](activity-state.md), every state is distinguishable through icon shape and text label alone. **Motion is a redundant cue**, never the only cue. This is the mathematical reason reduced-motion does not regress accessibility.

### Mandatory `motion-safe` gating

Every animation in the relationship surface MUST be wrapped in the existing CSS `motion-safe` discipline. The relationship engine reuses only animations that already exist in `globals.css`:

| Animation                 | Existing definition                              | Gating                                                                                                                |
| ------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `processing` rotation     | `@keyframes spin` (`globals.css:146`)            | Wrapped: `@media (prefers-reduced-motion: no-preference) { … animation: spin 1.6s linear infinite; }`                 |
| Active edge pulse         | `@keyframes pulse` (`globals.css:151`)           | Same wrapping. Already used by `.arun .dot[data-live="true"]` at `globals.css:2172` — **no new keyframes are added.** |
| Source-port connect pulse | `@keyframes port-pulse` (`globals.css:1778`)     | Already gated by `data-connecting` attribute; the relationship UI inherits this unchanged.                            |
| Connection-dot temp pulse | `@keyframes conn-dot-pulse` (`globals.css:1695`) | Active only during the transient temp-path render. Wrapped under `motion-safe`.                                       |
| Fade-up of new audit rows | `@keyframes fadeUp` (`globals.css:160`)          | Wrapped. Already exists; no new keyframes.                                                                            |

No new `@keyframes` rule is introduced by #541.

### `prefers-reduced-motion: reduce` behaviour

When the user agent advertises reduced motion:

- `processing` rotation is replaced by a **static segmented circle** (the same icon shape with all segments rendered, no rotation). Per [activity-state.md §6.3](activity-state.md).
- Active edge pulse is replaced by a static dot at full opacity.
- Audit-row fade-up is replaced by an immediate appearance.
- `high-throughput` count updates remain (a number changing is **not** motion in the accessibility sense; it is a value update).

No transition exceeds 250 ms even when motion is enabled. The `pulse` keyframe runs at 1.3 s per cycle, the `spin` at 1.6 s, and the temp-dot pulse at 1.0 s — all well under the WCAG 2.3.1 three-flashes-per-second floor (see §"No flashing thresholds").

### `prefers-contrast: more` behaviour

Per [activity-state.md §6.3](activity-state.md), high-contrast mode:

- Drops the sub-tinted `color-mix(…)` backgrounds; the badge becomes `var(--card)` with a full-opacity border in the state's text colour token (`var(--accent)` / `var(--warn)` / `var(--danger)`).
- Increases icon stroke from 1.5 px to 2 px; the icon glyph is scaled 1.1× (still within the 24×24 minimum target — see [accessibility-checklist.md](accessibility-checklist.md)).
- Text label remains in its high-contrast position (`var(--fg)` for state-neutral tokens, or the bare token for accent / warn / danger).

The implementation in #541 reuses the existing media-query pattern from `globals.css` (no new media-query infrastructure).

## No flashing thresholds

WCAG 2.3.1 prohibits more than three flashes per second. The relationship surface adopts a stricter floor:

- **Maximum one transition every two seconds per badge.** The activity-state derivation is debounced server-side (per [activity-state.md §5](activity-state.md)); the UI additionally enforces a per-badge minimum interval of 2,000 ms between state changes. Faster source events fold into the same visible state without re-triggering the transition animation.
- `high-throughput` deliberately renders as a **count value** that increments — never a fast pulse. The count update has no transition animation; only the digit changes.
- No state uses an animation duration shorter than 200 ms or longer than 1.6 s.
- No state stacks two simultaneous animations on the same badge.

## Failure, blocked, degraded styling

These three states share the warning / danger family. The visual contract:

- `failed` uses `var(--danger)` on a `color-mix(in oklch, var(--danger) 12%, var(--card))` background — the exact pattern from `.arun-error` at `globals.css:2160`.
- `blocked` uses `var(--warn)` on `color-mix(in oklch, var(--warn) 12%, var(--card))` — matches `.arun-gate` at `globals.css:1944`.
- `degraded` uses `var(--warn)` on a lighter mix (8%) so the operator can distinguish "validator denied" from "endpoint not live" at a glance even though both are warning-class.

**Forbidden colour pair**: any combination producing a measured contrast below 4.5:1 against its rendered background. Implementation MUST run a contrast probe on the resolved oklch values (e.g. via `axe-core` or a CI contrast check) before merge. The historical Tailwind anti-pattern `bg-red-600 + text-ink-inverse` (3.47:1 in the prior project context that produced the rule) is explicitly forbidden here as a contrast floor — but it is moot in practice because Keiko's palette is CSS custom properties (oklch), not Tailwind, and the danger pair `--danger` / `color-mix(--danger 12%, --card)` is computed against the actual rendered card colour.

## Bounded animated count

At any moment, the relationship surface renders at most **`N_VISIBLE = 25`** animated badges concurrently ([activity-state.md §5.3](activity-state.md)). Beyond:

- The 26th and subsequent `active` / `processing` states surface as a **static aggregate count** badge ("+12 more processing"), not as additional animated badges.
- The aggregate carries `aria-live="polite"` with a debounced announcement ("12 more processing relationships") to avoid screen-reader thrashing.
- The aggregate **never enumerates** relationship ids; it surfaces only the count (per [activity-state.md §5.3](activity-state.md) privacy invariant).

When the active count drops below 25, the aggregate disappears and the individual badges re-emerge.

## Per-state ARIA wiring

Every activity badge is wrapped per [activity-state.md §6.2](activity-state.md):

```html
<span role="status" aria-live="polite" aria-atomic="true">
  <span aria-hidden="true"><!-- icon --></span>
  <span class="visually-hidden">{{ariaDescription}}</span>
  <span aria-hidden="true">{{label}}</span>
</span>
```

The `visually-hidden` class is the existing utility used in the workspace shell ([518-ui-blueprint.md](../workspace/518-ui-blueprint.md) accessibility-driven UI requirements). No new utility class is introduced.

## Implementation guard rails for #541

1. **No new CSS variables.** Every colour MUST come from the tokens enumerated in §"Palette source" above.
2. **No new `@keyframes` rule.** Every animation MUST reuse one of the five existing keyframes in `globals.css`.
3. **No JS-driven animation.** No `setInterval` / `requestAnimationFrame` for state pulsing; CSS animations only.
4. **`motion-safe` mandatory.** Every animated rule MUST be inside `@media (prefers-reduced-motion: no-preference) { … }`.
5. **`prefers-contrast: more` mandatory.** Every coloured background pair MUST have a high-contrast override.
6. **Static aggregate beyond N_VISIBLE = 25.** Enforced via the same bounded-render derivation that drives the badge list.
7. **No autoplay sound.** The relationship surface emits no audio. Period.
8. **No haptics.** The relationship surface emits no vibration / haptic API call.

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#541](https://github.com/oscharko-dev/Keiko/issues/541).
- Companions: [ui-blueprint.md](ui-blueprint.md), [inspector-spec.md](inspector-spec.md), [accessibility-checklist.md](accessibility-checklist.md), [visual-density-rules.md](visual-density-rules.md).
- Foundation: [activity-state.md](activity-state.md), [audit-events.md](audit-events.md), [retention-and-privacy.md](retention-and-privacy.md).
- Existing CSS: [`packages/keiko-ui/src/app/globals.css`](../../packages/keiko-ui/src/app/globals.css).
- Existing pattern callsites: `.arun-error` (`globals.css:2160`), `.arun-gate` (`globals.css:1944`), `.arun .dot[data-live="true"]` (`globals.css:2172`), `.conn-dot` (`globals.css:1689`).
- ADR: [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).
