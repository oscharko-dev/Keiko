# Epic #532 — Visual Density, Filtering, Focus, and Semantic Zoom Rules

Status: Wave 3 deliverable for [issue #537](https://github.com/oscharko-dev/Keiko/issues/537) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [ui-blueprint.md](ui-blueprint.md), [activity-state.md](activity-state.md), [api-contract.md](api-contract.md).

Issue date: 2026-06-06.

## Purpose

This document is the **single normative reference** for the visual density mode, filtering URL-state model, focus mode, edge bundling, and semantic-zoom thresholds. It restates the contract from [ui-blueprint.md](ui-blueprint.md) with precise numeric caps and one-table-per-rule presentation so [#540](https://github.com/oscharko-dev/Keiko/issues/540) and [#542](https://github.com/oscharko-dev/Keiko/issues/542) implementations have zero degrees of freedom on these parameters.

## Per-density rendering caps

The relationship surface supports three density modes. Defaults below assume the workspace contains an arbitrary number of relationships; the caps are upper bounds, not targets.

| Cap dimension                           | Minimal (default)                                             | Standard                                                                                   | Dense                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Visible edges                           | Only edges touching focused window.                           | Per active-project filter, capped at **25** ([activity-state.md §5.3](activity-state.md)). | Per active filters, capped at **512** ([api-contract.md §4.8](api-contract.md) default `maxRelationships`). |
| Concurrent animated activity badges     | **5**                                                         | **25** (`N_VISIBLE`)                                                                       | **25** (`N_VISIBLE` — the animation cap is shared across all modes).                                        |
| Audit history page size                 | **10**                                                        | **10**                                                                                     | **10**                                                                                                      |
| Inspector evidence-reference rows       | **5** (inline) + "View all N" link                            | **5** (inline) + "View all N" link                                                         | **5** (inline) + "View all N" link                                                                          |
| Activity recent-transitions inline rows | **3**                                                         | **5**                                                                                      | **5**                                                                                                       |
| Edge-bundle aggregation threshold       | bundle aggregates if pair count > **2**                       | bundle aggregates if pair count > **4**                                                    | bundle aggregates if pair count > **4**                                                                     |
| Tooltip auto-dismiss timeout            | **5 s** (banner inactivity)                                   | **5 s**                                                                                    | **8 s** (operator likely reviewing)                                                                         |
| Default `prefers-reduced-motion`        | Implicit: minimal renders no motion regardless of preference. | Honoured.                                                                                  | Honoured.                                                                                                   |

### Why `N_VISIBLE = 25` regardless of mode

The animated-badge cap is **the same in all modes** because it is a privacy + perception cap, not a layout cap (per [activity-state.md §5.3](activity-state.md)). Dense mode shows more **edges**; it does not show more **animated badges**.

### Why minimal mode caps at 5 animated badges

Minimal mode shows only edges touching the focused window. The maximum incident edge count on a single workspace window in practice is bounded by per-window port topology and target workspace cardinality; 5 is conservative even for a deeply connected hub window.

## URL-state model

Filter and view state are URL-driven, mirroring the [#64 project-sidebar precedent](https://github.com/oscharko-dev/Keiko/issues/64).

### Filter params

| Param            | Multi-value separator | Closed value set                                                                                                                                  | Default                                                                                      |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `?relType=`      | `,`                   | [taxonomy.md §5](taxonomy.md) relationship types.                                                                                                 | absent ⇒ all types                                                                           |
| `?relLifecycle=` | `,`                   | [lifecycle.md §1](lifecycle.md): `draft`/`active`/`archived`/`superseded`/`revoked`/`blocked`/`stale`.                                            | absent ⇒ `active` (per [api-contract.md §4.3](api-contract.md) default-visibility behaviour) |
| `?relActivity=`  | `,`                   | [activity-state.md §2](activity-state.md): `inactive`/`queued`/`active`/`processing`/`completed`/`failed`/`blocked`/`degraded`/`high-throughput`. | absent ⇒ all states                                                                          |
| `?relSrcKind=`   | `,`                   | [taxonomy.md §4](taxonomy.md) `EndpointKind`.                                                                                                     | absent ⇒ all kinds                                                                           |
| `?relTgtKind=`   | `,`                   | [taxonomy.md §4](taxonomy.md) `EndpointKind`.                                                                                                     | absent ⇒ all kinds                                                                           |

### View params

| Param          | Closed value set                 | Default                                                                                                                                          | Persistence                                                                   |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `?relDensity=` | `minimal` / `standard` / `dense` | absent ⇒ value of `keiko.relationships.density` from `localStorage` (default `minimal` on first load).                                           | `localStorage` persistence (NOT URL persistence — URL is a session override). |
| `?relFocus=`   | relationship id                  | absent ⇒ inspector renders the focused window's relationships, not a pinned single id.                                                           | Not persisted. Cleared by `Escape`.                                           |
| `?relZoom=`    | numeric in `[0.1, 4.0]`          | absent ⇒ falls through to `View.zoom` from the workspace ([`types.ts:28`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts)). | Not persisted. The URL param is only used for deep links into the workspace.  |

### URL serialization rules

- Param keys are **lowercase**.
- Multi-values are comma-separated with no spaces (`?relType=produces-evidence,depends-on`).
- Unknown values produce a typed error envelope server-side ([api-contract.md §3.4](api-contract.md) `relationship/bad-request`); the UI surfaces the error per [error-and-denial-ux.md](error-and-denial-ux.md) "API error envelope".
- Single `encodeURIComponent` on each value (per [#64 lesson](https://github.com/oscharko-dev/Keiko/issues/64) — double-encoding is forbidden; `URLSearchParams.set` already encodes; `useSearchParams().get()` already decodes).
- The encoded URL never exceeds **2,048 bytes** total. If construction would exceed, the UI surfaces "Too many filters; clear filters or use fewer values."

### Suspense boundary

All filter URL params are read via `useSearchParams()` under a `<Suspense>` boundary, per the [#64 lesson](https://github.com/oscharko-dev/Keiko/issues/64): a Client Component reading `useSearchParams()` without a `<Suspense>` ancestor breaks the static export. The relationship surface MUST wrap any subtree that calls `useSearchParams()` in `<Suspense fallback={<RelationshipFilterSkeleton />}>`.

## Persistence rule

Density mode persists in `localStorage` under the key:

```
keiko.relationships.density
```

The `keiko.*` prefix matches the existing Keiko `localStorage` namespace ([`keiko.shell.sidebarCollapsed` from #63](https://github.com/oscharko-dev/Keiko/issues/63)). The value is one of `"minimal"` / `"standard"` / `"dense"`; any other value is treated as `"minimal"` and the key is rewritten on first read.

The URL param `?relDensity=` overrides the persisted value **for the current URL only**; it is not written back to `localStorage`. This lets the operator share a "look at this in dense mode" link without permanently switching density for the recipient.

## Focus mode

| Trigger                                                               | Effect                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Operator presses `F` with workspace shell focus.                      | Toggles `data-relationship-focus="true"` on `.workspace` root.                                         |
| Operator selects a workspace window (single-click activation).        | Sets `data-relationship-focus="<windowId>"` on `.workspace` root.                                      |
| Operator follows the inspector's "Focus on this endpoint" affordance. | Same as above.                                                                                         |
| Operator presses `Escape` with workspace shell focus.                 | Clears `data-relationship-focus`. Restores full opacity to all edges.                                  |
| Inspector receives focus on a non-relationship-endpoint window.       | No effect on focus mode. The inspector renders the window's relationships independently of focus mode. |

CSS effect (one-line addition to existing `.conn-path` rule at `globals.css:1677`):

```css
.workspace[data-relationship-focus] .conn-path:not([data-incident="true"]) {
  opacity: 0.25;
}
```

Edges incident to the focused window receive `data-incident="true"` in the rendering pass. Other windows are dimmed via the existing `data-conn="invalid"` rule (0.42 opacity) — **reusing existing CSS**.

## Edge bundling thresholds

| Condition                                           | Rendering                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Pair count between same `(sourceId, targetId)` is 1 | Single edge, no bundle.                                                                   |
| Pair count is 2, 3, or 4 (Standard/Dense)           | Edges render individually with vertical offset; no aggregate badge.                       |
| Pair count is 2 (Minimal)                           | Bundle aggregates with count badge.                                                       |
| Pair count > threshold for current density          | Single bundle path with aggregate count badge (e.g., "7"). Click → inspector bundle view. |

Bundle expansion: a click on the aggregate badge opens the inspector in **bundle mode** — a section listing the closed set of types in the bundle with their counts, never enumerating relationship ids. Selecting a row in bundle mode focuses the inspector on a single relationship of that type within the bundle (the most recently audited one).

## Semantic-zoom thresholds

| `View.zoom` band   | Rendering                                                                                                                                                               | Source of truth                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `zoom < 0.5`       | **Aggregated.** Each cluster of co-resident workspace windows aggregates to a single dot; edges between clusters render only when bundle count > 4. No animated badges. | `View.zoom` from [`types.ts:28`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts). |
| `0.5 ≤ zoom < 1.0` | **Standard.** Edge bundling per the density-mode threshold; animated badges visible up to `N_VISIBLE = 25`.                                                             | Same.                                                                                                  |
| `zoom ≥ 1.0`       | **Detailed.** No bundling; every edge renders individually. Density-mode visible-edge cap still applies.                                                                | Same.                                                                                                  |

The thresholds are constants. No URL param tunes them. The transition between bands is **discrete** (not interpolated) to avoid visual thrashing during pan/zoom.

### Co-resident cluster definition

Two workspace windows are co-resident when their bounding boxes overlap or their centres are within 64 px of each other in **world coordinates** (per [`Workspace.tsx`](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx) CSS-transform projection model from ADR-0026). Cluster identity is computed lazily once per zoom-band entry, never per frame.

## Composition of caps

When the operator selects Standard density at `zoom = 0.8` with `?relLifecycle=active,blocked&relActivity=processing`:

1. **API call.** `GET /api/relationships?lifecycle=active,blocked&activityHint=processing&limit=64` — never bare ([api-contract.md §4.3](api-contract.md)).
2. **API caps.** Server returns at most 64 entries, optionally `truncated: true` with `nextCursor`.
3. **Density cap.** UI renders at most 25 edges (Standard's `N_VISIBLE`).
4. **Semantic zoom.** Zoom 0.8 is Standard band: bundling on (threshold 4); animated badges visible.
5. **Animation cap.** At most 25 animated badges concurrently regardless.
6. **Focus mode.** If active, only incident edges render at full opacity; others at 0.25.

The composition is **always `min(API hard cap, density cap, animation cap)`** for the animated-badge count, and `min(API hard cap, density visible-edge cap)` for the visible-edge count.

## Forbidden patterns

The implementation MUST NOT:

- Tune `N_VISIBLE` per density mode (it is a fixed 25; only the **visible-edge** cap varies per density).
- Persist `?relFocus=` to `localStorage` (focus is per-session).
- Persist filter params to `localStorage` (filters are URL-only — the URL is the share contract).
- Read `?relDensity=` and silently write it to `localStorage` (URL override is one-shot).
- Introduce a new `keiko.relationships.*` `localStorage` key without an entry in this document.
- Use a `setTimeout` to debounce filter URL writes shorter than 250 ms (matches the existing search-input cadence).
- Interpolate semantic-zoom bands (the transition is discrete by design).

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#540](https://github.com/oscharko-dev/Keiko/issues/540), [#542](https://github.com/oscharko-dev/Keiko/issues/542).
- Companions: [ui-blueprint.md](ui-blueprint.md), [inspector-spec.md](inspector-spec.md), [activity-visualization.md](activity-visualization.md), [accessibility-checklist.md](accessibility-checklist.md), [error-and-denial-ux.md](error-and-denial-ux.md).
- Foundation: [activity-state.md](activity-state.md), [lifecycle.md](lifecycle.md), [taxonomy.md](taxonomy.md), [api-contract.md](api-contract.md).
- Existing UI: [`types.ts`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts), [`Workspace.tsx`](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx), [`ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx).
- ADRs: [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).
