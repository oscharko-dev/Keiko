# Epic #532 — Relationship UI/UX Blueprint

Status: Wave 3 deliverable for [issue #537](https://github.com/oscharko-dev/Keiko/issues/537) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [taxonomy.md](taxonomy.md), [lifecycle.md](lifecycle.md), [denial-reasons.md](denial-reasons.md), [activity-state.md](activity-state.md), [architecture.md](architecture.md), [api-contract.md](api-contract.md), [audit-events.md](audit-events.md), [evidence-references.md](evidence-references.md).

Issue date: 2026-06-06.

## Purpose

This blueprint locks the user-visible contract for the relationship engine. It defines which surfaces present relationships, how relationships are created and validated, how visual density and filtering are governed, and how the relationship surface composes onto the existing Keiko workspace shell **without** introducing a new canvas, graph library, animation library, gesture library, or any other third-party dependency.

It binds the implementation issues [#540](https://github.com/oscharko-dev/Keiko/issues/540) (inspector + controlled graph visualization), [#541](https://github.com/oscharko-dev/Keiko/issues/541) (privacy-preserving activity visualization), and [#542](https://github.com/oscharko-dev/Keiko/issues/542) (bounded impact + dependency view + health checks).

The companion documents are normative: this blueprint reuses their constants and never re-defines them.

| Companion                                                  | Owned contract                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [inspector-spec.md](inspector-spec.md)                     | Inspector section order, action gating, empty/loading/error states.            |
| [activity-visualization.md](activity-visualization.md)     | Per-state visual treatment, motion rules, contrast budget.                     |
| [accessibility-checklist.md](accessibility-checklist.md)   | WCAG 2.2 AA mapping, keyboard map, screen-reader announcements.                |
| [error-and-denial-ux.md](error-and-denial-ux.md)           | Per-denial-code UI treatment, loading state taxonomy.                          |
| [visual-density-rules.md](visual-density-rules.md)         | Per-density caps, URL-state model, persistence rule, semantic-zoom thresholds. |
| [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md) | The containment decision and its alternatives.                                 |

## Engineering principle

> **Relationships are governance evidence, not a graph editor.**

The relationship surface explains _what is connected, why it is connected, and whether the connection is currently honoured by the rest of the runtime_. It is not a free-form whiteboard, not a node-and-edge editor, and not an analytics dashboard. Every visual affordance answers an operator question that already exists in the audit ledger or the live event stream; none invents new authority, new telemetry, or new gestures.

Three corollaries follow:

1. **No new substrate.** Per [ADR-0026](../adr/ADR-0026-workspace-substrate.md) and the [#529 deferral evidence](../workspace/518-canvas-graph-deferral.md), the relationship UI reuses `Workspace.tsx`, `ConnectionsLayer.tsx`, and `connector-graph.tsx`. No `react-flow`, `d3`, `cytoscape`, `framer-motion`, or any other library is added.
2. **No invented copy.** Every user-visible denial string is the message column from [denial-reasons.md](denial-reasons.md). Every activity badge label comes from [activity-state.md §6](activity-state.md). Lifecycle pill text comes from [lifecycle.md §1](lifecycle.md).
3. **Bounded everywhere.** Every visible list, edge set, animation, and aggregation is capped. The UI never renders more than the API can return ([api-contract.md §3.5](api-contract.md) `X-Truncated` header is honoured everywhere).

## Surface ownership

The relationship surface is composed of exactly five rendering loci. The blueprint enumerates each and the existing Keiko surface it extends.

### Surfaces that show relationships

| Surface                             | Existing component (file:line)                                                                                  | What it shows                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace edges**                 | [`ConnectionsLayer.tsx:68`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx)    | Each `Relationship` whose `sourceId` and `targetId` both name currently-open workspace windows renders as a `.conn-path` SVG edge. The existing `.conn-badge` `<button>` (`ConnectionsLayer.tsx:92`) becomes the relationship-inspector entry point: clicking focuses the inspector, the existing `removeConn` handler is rebound to a typed `DELETE /api/relationships/:id`. |
| **Relationship inspector**          | [`InspectorPanel.tsx:11`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx) | When the focused workspace window is an endpoint of an edge selected by the operator (or when a relationship id is the URL-state focus), the inspector renders the relationship sections defined in [inspector-spec.md](inspector-spec.md). Reuses the existing `rb-section-label` / `rb-rows` / `rb-row` row chrome from `globals.css:4404, 4428, 4433`.                     |
| **Capsule-level graph (knowledge)** | [`connector-graph.tsx`](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx)                    | The existing capsule-level connector graph already renders a small directed graph of knowledge nodes with `aria-live="assertive"` error alerts and ≥30×30 hit targets. Relationship entries whose source or target is a `knowledge` endpoint reuse the existing node and edge chrome. No new graph component is created.                                                      |
| **Activity timeline**               | [`TimelinePanel.tsx:26`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/TimelinePanel.tsx)   | Activity events from [activity-state.md §3](activity-state.md) that name a relationship are rendered as additional `.tl-row` entries with the relationship type badge inline. Reuses the existing `KIND_COLOR` mapping at `TimelinePanel.tsx:7` for backwards consistency.                                                                                                    |
| **Dependency / impact pane**        | (#542 — extension of `InspectorPanel.tsx` with a deferred-mounted tab section; **no new panel**)                | The bounded impact graph from [api-contract.md §4.7–§4.8](api-contract.md) renders as a list-with-edge-indicators _inside_ the inspector. It is not a separate window. The "View Impact" inspector action focuses the existing inspector on the impact tab.                                                                                                                   |

### Surfaces that deliberately do not show relationships

| Surface                                                                                                                            | Rationale                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat composer ([`ChatWindow.tsx`](../../packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx))                              | Relationships are governance evidence, not conversational context. The composer remains the user's send-only contract per ADR-0027.                                                                                                   |
| Settings panel ([`SettingsPanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx))        | Relationships are not configuration; they are records. Editing a relationship is a typed audited transition (per [lifecycle.md §4](lifecycle.md)), not a form save.                                                                   |
| Command palette result list ([`CommandPalette.tsx`](../../packages/keiko-ui/src/app/components/desktop/modals/CommandPalette.tsx)) | The palette _commands_ that act on relationships ("Create relationship…", "Reconnect…") are exposed there, but relationship _records_ are not enumerated in the palette result list. The palette is action-shaped, not record-shaped. |
| Workspace shader / chrome ([`WorkspaceShader.tsx`](../../packages/keiko-ui/src/app/components/desktop/WorkspaceShader.tsx))        | Tier-5 ambient per the [518-ui-blueprint](../workspace/518-ui-blueprint.md) tiering; never a relationship surface.                                                                                                                    |

## Creation flows

Three creation gestures exist. All three issue the same `POST /api/relationships` ([api-contract.md §4.2](api-contract.md)); all three rely on the existing keyboard substrate ([`useKeyboardShortcuts.ts:137`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts)). **No new gesture library is introduced.**

### (a) Drag-to-connect on the workspace shell

The workspace shell already supports a drag-to-connect gesture: invisible-at-rest ports on each window become visible on hover (CSS `.win-port` at `globals.css:1744`), and a click-and-drag from a source port to a target window triggers the existing `connecting` state (the `tempPath` helper at [`ConnectionsLayer.tsx:45`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx)). The relationship engine reuses this exact gesture; the only delta is that the commit phase becomes a typed `POST /api/relationships` instead of an in-process `addConn` call.

The validation preview during the drag is governed by [api-contract.md §4.1](api-contract.md) `POST /api/relationships/validate` (dry-run, no side effects). The preview cadence is at most **one validate call per 250 ms** of drag movement, debounced; the existing temp-path render continues at native frame rate.

Per-target highlight contract during the drag (existing CSS attributes from `globals.css`):

- `data-conn="valid"` (`globals.css:1839`) — the target accepts a relationship of the proposed type.
- `data-conn="source"` (`globals.css:1847`) — the source window pulses its port; the existing `@keyframes port-pulse` (`globals.css:1778`) is reused under `motion-safe` gating.
- `data-conn="invalid"` (`globals.css:1844`) — the target is dimmed to 0.42 opacity; the denial reason surfaces as a tooltip in the same denial banner placement (see §"Denial banner placement" below).

### (b) Right-click context menu

A right-click on a workspace window opens the existing context-menu chrome (the project already establishes a menu pattern via `EditorMenu.tsx`); a "Connect to…" item enters the connecting state at the clicked window. Keyboard equivalent: `Shift+C` on a focused window (registered through `useKeyboardShortcuts`, no new chord library — per the conflict-at-startup rule at [`useKeyboardShortcuts.ts:149`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts)).

### (c) Command palette

The existing `CommandPalette.tsx` exposes a typed `relationship.create` command. The palette flow:

1. Operator presses the existing palette chord (configured in `useKeyboardShortcuts`).
2. Operator types or selects `Create relationship…`.
3. A two-step prompt collects source then target by typed endpoint reference (kind, id). The prompt is the existing palette result-list UI; **no new modal is added**.
4. On submit, the BFF call from §(a) runs; denial / acceptance is announced via `aria-live="polite"`.

The command-palette path is the **only fully keyboard-accessible** creation flow, and is therefore the WCAG 2.1.1 compliance path. The other two are pointer-driven affordances with this fallback.

## Validation preview and denial banner placement

### Per-target highlight contract

While a drag-to-connect is in flight, every visible workspace window receives a `data-conn` attribute set by the validation oracle (per [api-contract.md §4.1](api-contract.md)). The oracle is called with the proposed `(sourceId, targetId, type)`; the response's `decision.outcome` maps to the attribute value:

| Validator outcome      | `data-conn`             | Visual effect (existing CSS)                         |
| ---------------------- | ----------------------- | ---------------------------------------------------- |
| `accept`               | `"valid"`               | 2px accent ring + elevated shadow.                   |
| `defer` (asynchronous) | `"valid"` (provisional) | Same; the commit re-runs the oracle server-side.     |
| `deny`                 | `"invalid"`             | Window fades to 0.42 opacity.                        |
| (source itself)        | `"source"`              | Source ring uses dimmed accent; port pulses (gated). |

The four-state mapping uses **only** existing CSS; #540 adds no new visual primitives.

### Denial banner placement

A denial during the validation preview surfaces in **one** location: a transient `.lk-alert` banner (existing CSS at `globals.css:5890`) anchored to the connecting cursor's window-of-record (the target the operator most recently hovered). The banner:

- Renders the user-facing message from [denial-reasons.md](denial-reasons.md) **verbatim** — no UI-side text invention.
- Carries `role="alert"` and `aria-live="assertive"` (matches the existing `connector-graph.tsx` `AlertBanner` pattern).
- Auto-dismisses on the next valid target or after 5 seconds of inactivity during preview.
- Includes a "Why?" link that focuses the inspector on the denial-reason summary (the inspector's denial section per [inspector-spec.md](inspector-spec.md)).

A denial in the commit phase (the operator released the pointer on an invalid target) surfaces in the same banner location but is **persistent** — it dismisses only on operator action — and is mirrored in the inspector's denial section.

## Visual density modes

The relationship surface supports three density modes. The default is **minimal**.

| Mode                  | Purpose                                                                                           | Per-mode caps (see [visual-density-rules.md](visual-density-rules.md))                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Minimal** (default) | Operator is doing other work; relationships are visible only when relevant to the focused window. | Visible edges: only those touching the focused workspace window. Animated badges: at most 5. No bundle expansion shown unless explicit click.                                      |
| **Standard**          | Operator is investigating relationships for the active project.                                   | Visible edges: per active-project filter, capped at 25 ([activity-state.md §5.3](activity-state.md) `N_VISIBLE = 25`). Animated badges: at most 25.                                |
| **Dense**             | Operator is reviewing a relationship audit; the inspector is open and impact is being analysed.   | Visible edges: capped at the API hard ceiling — `maxRelationships = 512` (default), `2048` (max) per [api-contract.md §4.8](api-contract.md). Animated badges: still capped at 25. |

Density mode persists in `localStorage` under the existing Keiko `keiko.*` prefix (per [#63 workspace shell precedent](https://github.com/oscharko-dev/Keiko/issues/63), e.g. `keiko.shell.sidebarCollapsed`): the key is `keiko.relationships.density`. The default ("minimal") is the value on first load and is the value rendered server-side under the static-export contract.

## Filtering

Filters are governed by URL state, mirroring the [#64 project-sidebar precedent](https://github.com/oscharko-dev/Keiko/issues/64) (`?project=`, `?chat=`). All filter URL params are read via `useSearchParams()` under a `<Suspense>` boundary (per [#64 lesson](https://github.com/oscharko-dev/Keiko/issues/64)).

| Filter dimension  | URL param        | Values                                                                                                                                                            |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relationship type | `?relType=`      | Closed set from [taxonomy.md §5](taxonomy.md). Multi-select via `,`. Absent = all types.                                                                          |
| Lifecycle state   | `?relLifecycle=` | Closed set from [lifecycle.md §1](lifecycle.md) (`draft`/`active`/`archived`/`superseded`/`revoked`/`blocked`/`stale`). Multi-select via `,`. Default = `active`. |
| Activity state    | `?relActivity=`  | Closed set from [activity-state.md §2](activity-state.md) (9 states). Multi-select via `,`. Absent = all states.                                                  |
| Source kind       | `?relSrcKind=`   | Closed kind set from [taxonomy.md §4](taxonomy.md). Multi-select via `,`. Absent = all kinds.                                                                     |
| Target kind       | `?relTgtKind=`   | Same as source.                                                                                                                                                   |
| Density mode      | `?relDensity=`   | `minimal` / `standard` / `dense`. Overrides `localStorage` for the active URL; not persisted from URL.                                                            |

The active filter is announced via `aria-live="polite"` ("Showing 12 of 47 relationships, filtered by type produces-evidence") on filter change. Filter input focus is reached via `/` (registered through `useKeyboardShortcuts`).

## Focus mode

A focus mode supports the "what touches this object?" investigation. When the operator selects a workspace window, presses `F`, or follows the inspector's "Focus" affordance:

- All relationships whose source or target is the focused endpoint render at full opacity (existing `.conn-path` styling at `globals.css:1677`).
- Every other relationship's `.conn-path` drops to opacity 0.25 (a one-line addition to the existing `.conn-path` rule, gated by a parent `data-relationship-focus` attribute on `.workspace`). Other windows themselves are dimmed via the existing `data-conn="invalid"` rule (0.42 opacity) — **reusing existing CSS**, not adding a second dimming primitive.
- The inspector pins to the focused endpoint until focus is released.

Restoration: pressing `Escape` (registered through `useKeyboardShortcuts`) clears focus and restores full opacity for all edges.

Focus mode honours the activity-state animated cap: even with all edges visible, at most 25 animated badges render concurrently ([activity-state.md §5.3](activity-state.md)).

## Edge bundling

Visual edge bundling collapses parallel and near-parallel edges that share an endpoint pair to a single visual edge with an aggregate count badge.

- Two edges share endpoint cluster when their `(sourceId, targetId)` pair matches.
- A bundle's aggregate count badge renders **only** when the bundle's edge count is strictly greater than **4**. At ≤ 4, edges render individually with vertical offset.
- The aggregate badge carries the badge count (e.g., "7"); the underlying types are revealed by clicking the badge (which switches the inspector to a bundle-summary view).
- The bundle never renders the relationship _ids_, only the count and the closed set of types in the bundle. This is the bounded-render contract from [activity-state.md §5.3](activity-state.md) applied to visual edges, not just badges.

Bundling is **purely visual**: it does not change the underlying record set. A bundle of 12 edges is still 12 rows in the relationship table, 12 audit events on `relationship.created`, 12 entries in the API list response.

## Semantic zoom

The workspace already exposes a zoom level via the `View { zoom }` camera record ([`types.ts:28`](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts)). The relationship surface defines **two** semantic-zoom thresholds:

| `View.zoom` band   | Rendering                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zoom < 0.5`       | **Aggregated.** Each cluster of co-resident windows aggregates to a single dot per the [activity-state.md §5.3](activity-state.md) bounded-render rule. Edges between clusters render only if their bundle count exceeds 4. No animated badges. |
| `0.5 ≤ zoom < 1.0` | **Standard.** Bundling on, individual edges render up to the density-mode cap. Animated badges visible.                                                                                                                                         |
| `zoom ≥ 1.0`       | **Detailed.** No bundling; every edge renders individually. Density-mode cap still applies.                                                                                                                                                     |

The thresholds correspond to the existing `.ws-zoom` chrome at `globals.css:696` and are read directly from `View.zoom`. **No additional zoom state is introduced.**

## Bounded rendering

The bounded-render contract has three layers, in order of authority:

1. **API-side cap.** The BFF refuses unbounded queries: `relationship/bounded-query-required` ([api-contract.md §4.3](api-contract.md)) on bare `GET /api/relationships`; `relationship/bounded-query-exceeded` ([api-contract.md "Limit caps"](api-contract.md)) when caller-requested limits exceed the per-endpoint hard cap (list: `256`; impact `maxNodes`: `1024`; impact `maxRelationships`: `2048`).
2. **UI-side cap.** Even when the API returns the full hard cap, the UI renders at most the density-mode cap. The `X-Truncated` response header drives a "Showing first N of M" footer line; see [error-and-denial-ux.md](error-and-denial-ux.md) §"Bounded-query-exceeded UX".
3. **Animation cap.** At most **25** animated badges concurrently (`N_VISIBLE` from [activity-state.md §5.3](activity-state.md)). Beyond, a static aggregate count replaces the per-edge badge — never the per-edge edge.

The three caps compose: `min(API_hard_cap, density_mode_cap, animation_cap_for_animated_subset_only)`. The UI never renders more edges than the API returned and never animates more than 25 badges, regardless of how many edges are visible.

## Acceptance criteria evidence

| #537 AC                                                                                                                  | Where in this document                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Every relationship state communicated through non-color-only means.                                                      | "Visual density modes" + companion [activity-visualization.md](activity-visualization.md) and [activity-state.md §6](activity-state.md). |
| Reduced-motion behaviour specified for all animated activity states.                                                     | Companion [activity-visualization.md](activity-visualization.md) §"Motion rules"; [activity-state.md §5.5, §6.3](activity-state.md).     |
| Keyboard-only flows exist for core relationship actions.                                                                 | "Creation flows" (c) command palette; companion [accessibility-checklist.md](accessibility-checklist.md).                                |
| Inspector explains meaning, authority status, activity state, audit events, evidence references.                         | Companion [inspector-spec.md](inspector-spec.md).                                                                                        |
| Blueprint limits visible / rendered edges through filtering, aggregation, viewport behaviour, or progressive disclosure. | "Visual density modes", "Filtering", "Focus mode", "Edge bundling", "Semantic zoom", "Bounded rendering".                                |
| No new dependency is required or proposed.                                                                               | "Engineering principle" + [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).                                                    |

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#540](https://github.com/oscharko-dev/Keiko/issues/540), [#541](https://github.com/oscharko-dev/Keiko/issues/541), [#542](https://github.com/oscharko-dev/Keiko/issues/542), [#543](https://github.com/oscharko-dev/Keiko/issues/543).
- Companions: [inspector-spec.md](inspector-spec.md), [activity-visualization.md](activity-visualization.md), [accessibility-checklist.md](accessibility-checklist.md), [error-and-denial-ux.md](error-and-denial-ux.md), [visual-density-rules.md](visual-density-rules.md).
- Foundation: [taxonomy.md](taxonomy.md), [lifecycle.md](lifecycle.md), [denial-reasons.md](denial-reasons.md), [activity-state.md](activity-state.md), [audit-events.md](audit-events.md), [evidence-references.md](evidence-references.md), [api-contract.md](api-contract.md), [architecture.md](architecture.md), [storage.md](storage.md), [security-checklist.md](security-checklist.md).
- ADRs: [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md), [ADR-0031](../adr/ADR-0031-relationship-storage-and-validation.md), [ADR-0032](../adr/ADR-0032-relationship-audit-and-activity-model.md), [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).
- Existing UI components: [`AppShell.tsx`](../../packages/keiko-ui/src/app/components/desktop/AppShell.tsx), [`Workspace.tsx`](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx), [`ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx), [`InspectorPanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx), [`TimelinePanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/TimelinePanel.tsx), [`CommandPalette.tsx`](../../packages/keiko-ui/src/app/components/desktop/modals/CommandPalette.tsx), [`useKeyboardShortcuts.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts), [`connector-graph.tsx`](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx).
- Workspace blueprints: [518-ui-blueprint.md](../workspace/518-ui-blueprint.md), [518-ux-blueprint.md](../workspace/518-ux-blueprint.md), [518-canvas-graph-deferral.md](../workspace/518-canvas-graph-deferral.md).
