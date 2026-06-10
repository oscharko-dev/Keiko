# ADR-0033: Relationship engine — UI containment

## Status

Proposed (Epic #532, issue #537, 2026-06-06). Locks the user-visible contract for the relationship engine: which surfaces present relationships, how those surfaces compose onto the existing Keiko workspace shell, the bounded-render and accessibility guarantees, and the rejected alternatives. [ADR-0031](ADR-0031-relationship-storage-and-validation.md) covers policy, validation, and storage; [ADR-0032](ADR-0032-relationship-audit-and-activity-model.md) covers audit, evidence, and the activity-state model. This ADR completes the design phase for Epic #532 before implementation issues #538 – #542 begin.

## Context

Epic [#532](https://github.com/oscharko-dev/Keiko/issues/532) introduces a cross-domain relationship engine. Issues #533 – #536 produced the foundation:

- [#533](https://github.com/oscharko-dev/Keiko/issues/533) audited the existing graph / provenance / policy / evidence patterns (16 docs and the [reuse matrix](../relationship-engine/reuse-matrix.md)).
- [#534](https://github.com/oscharko-dev/Keiko/issues/534) locked the [taxonomy](../relationship-engine/taxonomy.md), [lifecycle](../relationship-engine/lifecycle.md), [compatibility matrix](../relationship-engine/compatibility-matrix.md), and [denial-reason catalog](../relationship-engine/denial-reasons.md).
- [#535](https://github.com/oscharko-dev/Keiko/issues/535) locked the [storage placement](../relationship-engine/storage.md), [API contract](../relationship-engine/api-contract.md), and [architecture](../relationship-engine/architecture.md); recorded in [ADR-0031](ADR-0031-relationship-storage-and-validation.md).
- [#536](https://github.com/oscharko-dev/Keiko/issues/536) locked the [audit events](../relationship-engine/audit-events.md), [activity-state model](../relationship-engine/activity-state.md), [evidence references](../relationship-engine/evidence-references.md), and [retention / privacy](../relationship-engine/retention-and-privacy.md); recorded in [ADR-0032](ADR-0032-relationship-audit-and-activity-model.md).

What was still open after ADR-0032:

- **Surface ownership**: which surfaces show relationships, which deliberately do not, and which existing Keiko components they extend.
- **Creation flows**: which gestures create a relationship, what validation preview surfaces while a gesture is in flight, where denial banners appear.
- **Visual density**: how the operator controls how many relationships render simultaneously, how the controlled graph composes with the workspace shell, and what bounded-render contract the UI honours on top of the API-side cap.
- **Inspector contract**: what the inspector explains for every relationship — type, lifecycle, activity, authority disclaimer, audit history, evidence references, impact, denial.
- **Accessibility**: how every state is communicated without colour or motion alone, what keyboard-only flows exist for every action, what screen-reader announcements surface.
- **Error and denial UX**: where every denial-reason code surfaces, what loading states render, what offline behaviour looks like.

These decisions cannot be safely inferred from the existing code or ADRs. The recurring failure mode the epic must avoid is a relationship UI that drifts into "graph editor product" — a decorative whiteboard that invents new authority, new telemetry, or new gestures. ADR-0033 records the containment decision that prevents the drift.

## Decision

### 1. Containment over composition: relationships are governance evidence, not a graph editor

The relationship surface is **containment-driven**, not graph-editor-driven. It explains what is connected, why, and whether the connection is currently honoured by the runtime. It does not freely place nodes, does not invent connections through aesthetic affordance, does not animate for ornament, and does not present a separate "graph view product" alongside the workspace.

Three consequences follow:

- **No new substrate.** Per [ADR-0026](ADR-0026-workspace-substrate.md) (Epic #518's workspace-substrate lock) and the [#529 deferral evidence](../workspace/518-canvas-graph-deferral.md), the relationship UI **reuses** the existing surfaces:
  - `Workspace.tsx` for the viewport.
  - `ConnectionsLayer.tsx` for the SVG edges between workspace windows.
  - `connector-graph.tsx` for the capsule-level (knowledge endpoint) graph.
  - `InspectorPanel.tsx` for the relationship inspector (additive sections; no new panel).
  - `TimelinePanel.tsx` for live activity events naming a relationship.
  - `CommandPalette.tsx` for typed `relationship.create` / `relationship.reconnect` actions.
  - `useKeyboardShortcuts.ts` for every chord; conflict-at-startup is fail-closed.
- **No invented copy.** Every user-visible denial message comes verbatim from the [denial-reason catalog](../relationship-engine/denial-reasons.md). Every activity badge label and ARIA description comes from [activity-state.md §6](../relationship-engine/activity-state.md). Every lifecycle chip label comes from [lifecycle.md §1](../relationship-engine/lifecycle.md).
- **No invented gesture.** Drag-to-connect is the existing workspace gesture ([`ConnectionsLayer.tsx:45`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx) `tempPath`). Right-click is the existing context-menu pattern. Command-palette is the existing `CommandPalette.tsx` flow. **No new gesture library is introduced.**

The relationship UI/UX blueprint formalises this in [docs/relationship-engine/ui-blueprint.md](../relationship-engine/ui-blueprint.md); the inspector contract in [inspector-spec.md](../relationship-engine/inspector-spec.md); the visual treatment in [activity-visualization.md](../relationship-engine/activity-visualization.md); the accessibility binding in [accessibility-checklist.md](../relationship-engine/accessibility-checklist.md); the error / denial catalogue in [error-and-denial-ux.md](../relationship-engine/error-and-denial-ux.md); the density / filtering / focus / semantic-zoom rules in [visual-density-rules.md](../relationship-engine/visual-density-rules.md).

### 2. Bounded-render is enforced UI-side AND API-side

The bounded-render contract has three layers, composed as `min(API hard cap, density-mode visible-edge cap)` for visible edges and `min(API hard cap, animation cap of 25)` for animated badges (per [visual-density-rules.md "Composition of caps"](../relationship-engine/visual-density-rules.md)).

| Layer            | Source of truth                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| API-side cap     | [api-contract.md §"Limit caps"](../relationship-engine/api-contract.md): `limit` default 64 / max 256; impact `maxNodes` default 256 / max 1024; impact `maxRelationships` default 512 / max 2048; impact `maxDepth` default 1 / max 3. |
| UI-side visible cap | [visual-density-rules.md "Per-density rendering caps"](../relationship-engine/visual-density-rules.md): Minimal = incident only; Standard = 25; Dense = 512. |
| Animation cap    | [activity-state.md §5.3](../relationship-engine/activity-state.md) `N_VISIBLE = 25` animated badges concurrently. |

Both layers fail closed: a bare `GET /api/relationships` returns `relationship/bounded-query-required` ([api-contract.md §4.3](../relationship-engine/api-contract.md)); a caller-requested cap above the hard ceiling returns `relationship/bounded-query-exceeded`. The UI surfaces server-applied caps via the in-band `truncated` / `truncationReason` body fields, rendered as a "Showing first N …" footer line per [error-and-denial-ux.md "Bounded-query-exceeded UX"](../relationship-engine/error-and-denial-ux.md).

This double-layer guarantees the UI never renders more than the API can return and never animates more than the perception cap allows, even if the API hard ceiling were raised.

### 3. Every state is text + ARIA + icon; colour is optional; motion is gated

Per [activity-state.md §6](../relationship-engine/activity-state.md), every relationship state — both **lifecycle** (7 states) and **activity** (9 states) — has four descriptors: a text label, an ARIA description, an icon shape, and an optional colour. A conformant renderer uses at least three of them (text + ARIA + icon) and MAY add colour. **A rendering that conveys state through colour alone, or through motion alone, is non-conformant.**

Two consequences follow:

- **`prefers-reduced-motion: reduce` is mandatory.** Every CSS animation in the relationship surface wraps in `@media (prefers-reduced-motion: no-preference)`. Under reduced motion, `processing` becomes a static segmented circle, pulses become static dots, and audit-row fade-in becomes instantaneous appearance. Per [activity-visualization.md "Motion rules"](../relationship-engine/activity-visualization.md), no new `@keyframes` rule is introduced; the five existing keyframes in `globals.css` (`spin`, `pulse`, `port-pulse`, `conn-dot-pulse`, `fadeUp`) are reused.
- **`prefers-contrast: more` is mandatory.** Sub-tinted backgrounds (the `color-mix(…)` pattern from `.arun-gate` and `.arun-error`) drop in high-contrast mode; the badge becomes `var(--card)` with a full-opacity coloured border. Per [activity-visualization.md "Contrast accommodations"](../relationship-engine/activity-visualization.md).

The colour-independence verification matrix in [accessibility-checklist.md "Color independence verification matrix"](../relationship-engine/accessibility-checklist.md) enumerates every state pair (text label, icon cue) and asserts uniqueness. A monochrome rendering still distinguishes every state by label and icon alone.

### 4. Inspector renders inside the existing `InspectorPanel`; no new panel

The relationship inspector is content rendered inside the existing [`InspectorPanel.tsx:11`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx). When the inspector is in relationship mode, the existing "Active window" sections continue to render below the new relationship sections. When focus leaves a relationship, the panel reverts to its pre-relationship behaviour. No new window type, no new panel, no new modal is introduced.

The 10-section order — type and display name, source endpoint, target endpoint, lifecycle status, activity, **authority status** (verbatim disclaimer "Relationship: governance only. No model/tool/file/workflow authority granted."), audit history, evidence references, impact summary, denial reason — is locked in [inspector-spec.md](../relationship-engine/inspector-spec.md). The five action buttons (Reconnect, Archive, Revoke, View Impact, View Evidence) are gated by lifecycle rules from [lifecycle.md §3](../relationship-engine/lifecycle.md).

### 5. Every action has a keyboard equivalent

Per [accessibility-checklist.md "Keyboard map for core actions"](../relationship-engine/accessibility-checklist.md), every relationship action — create, inspect, filter, focus, reconnect, archive, revoke, view impact, view evidence — has a chord registered through [`useKeyboardShortcuts.ts:137`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts). The command-palette path is the always-available keyboard equivalent for every pointer gesture (drag-to-connect, right-click "Connect to…").

No relationship action is reachable only by pointer. WCAG 2.1.1 compliance is the command-palette path; the other gestures are pointer affordances on top of it.

### 6. URL state is the share contract; `localStorage` holds density only

Filter state (`?relType=`, `?relLifecycle=`, `?relActivity=`, `?relSrcKind=`, `?relTgtKind=`) and focus state (`?relFocus=`) are URL-driven. Density mode is the only persisted preference (`localStorage.keiko.relationships.density`, default `minimal`). The URL is the share contract; the persisted density is per-operator. Per [visual-density-rules.md "URL-state model"](../relationship-engine/visual-density-rules.md).

`useSearchParams()` callsites are wrapped in `<Suspense>` per the [#64 lesson](https://github.com/oscharko-dev/Keiko/issues/64); double-encoding is forbidden; single-encoding via `URLSearchParams.set` is the only path.

## Alternatives considered

### A. Full graph editor (rejected)

A free-form node-and-edge editor with auto-layout, manual node placement, semantic colour coding, and ornamental motion was considered. Rejected because:

1. **Out of scope per epic non-goals.** [Epic #532](https://github.com/oscharko-dev/Keiko/issues/532) explicitly scopes the relationship engine to governance-evidence, not to whiteboard editing.
2. **Out of scope per [ADR-0026 / #529 deferral](../workspace/518-canvas-graph-deferral.md).** The workspace substrate is locked; an independent graph editor would duplicate `Workspace.tsx`, fragment workspace state ownership, and create a second registry contract.
3. **Authority drift risk.** A free-form editor implies "the user authored this layout"; a governance surface implies "the system recorded this evidence". The two semantics conflict.
4. **Telemetry drift risk.** A free-form editor invites layout persistence (which positions to remember), which invites telemetry (which layouts the operator preferred), which violates the [activity-state.md §1](../relationship-engine/activity-state.md) privacy invariant.

### B. Third-party graph library (rejected)

A dependency on `react-flow`, `d3-force`, `cytoscape`, or `vis-network` was considered. Rejected because:

1. **No-dependency invariant.** The repository operates under a zero-new-runtime-dependency invariant for Wave 3 (per the [reuse-matrix](../relationship-engine/reuse-matrix.md) and [ADR-0019](ADR-0019-modular-package-architecture.md) hardening trajectory). Adding any of these is forbidden.
2. **Substrate already exists.** [ConnectionsLayer.tsx](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx) and [connector-graph.tsx](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx) already deliver SVG edges with `aria-label`, `aria-live`, focus rings, and ≥ 24 × 24 hit targets — every primitive a third-party would supply, but with the existing Keiko a11y posture.
3. **Substrate-replacement risk.** A new library would impose its own DOM contract, breaking the existing `data-conn` attribute pattern, the `.conn-badge` button semantics, and the `.win-port` invisible-at-rest gesture.

### C. Independent canvas / WebGL renderer (rejected)

A canvas or WebGL renderer for scale was considered. Rejected because:

1. **Substrate locked per ADR-0026.** Independent canvas / graph substrate is explicitly rejected in [ADR-0026](ADR-0026-workspace-substrate.md) and reaffirmed in [518-canvas-graph-deferral.md](../workspace/518-canvas-graph-deferral.md).
2. **Bounded by design.** The bounded-render contract caps visible edges at 512 (Dense mode); DOM-rendered SVG performs well below that scale on every supported viewport. There is no measured failure to motivate a renderer change.
3. **Accessibility regression.** Canvas surfaces require manual focus, manual `aria-*` wiring, manual keyboard event routing — every facility the DOM already supplies free.

### D. Live collaborative editing (WebRTC / yjs) (rejected)

A WebRTC / CRDT live-collaboration surface for relationships was considered. Rejected because:

1. **Out of scope per epic non-goals.** Epic #532 is local-only.
2. **No-network invariant for activity layer.** [activity-state.md §1, §8 invariants 2 & 7](../relationship-engine/activity-state.md) forbid any network egress from the relationship surface.
3. **No-new-dependency invariant.** Any CRDT engine is a dependency.

### E. Separate "Relationships" tab in the main window region (rejected)

A standalone Relationships tab next to Workspace / Files / Terminal was considered. Rejected because:

1. **Surface fragmentation.** Relationships are governance evidence about the objects already in the workspace; a separate tab divorces them from the objects they describe.
2. **Inspector duplication.** A standalone tab would need its own inspector, duplicating `InspectorPanel.tsx`.
3. **No relationship-without-endpoint visibility.** Operators investigate relationships from the endpoints they connect; a separate tab inverts the workflow.

## Consequences

### Positive

- **Zero new runtime dependencies.** Confirmed against the design: every visual primitive, every CSS rule, every keyframe, every ARIA pattern is sourced from existing Keiko UI.
- **Zero new gestures.** The drag-to-connect gesture is already the workspace contract. The relationship engine reuses it; no new pointer handler is added.
- **Full WCAG 2.2 AA coverage.** The mapping in [accessibility-checklist.md "WCAG 2.2 AA mapping"](../relationship-engine/accessibility-checklist.md) covers every SC at risk for a graph surface.
- **Determinism.** Bounded-render caps are constants documented in normative tables; no UI-side variance.
- **Substrate alignment.** The relationship UI integrates with Workspace.tsx + ConnectionsLayer.tsx without contradiction with ADR-0026.

### Negative / acknowledged costs

- **No power-user graph view.** A user wanting a free-form whiteboard of all relationships is not served. This is intentional; the inspector + workspace edges are the governance surface.
- **Per-density caps are conservative.** Dense mode caps at 512 visible edges, even though the API can return 2048 in impact mode. This is intentional; DOM-rendered SVG and the operator's perceptual budget are the binding constraints.
- **Activity-state coupling to existing event streams.** The relationship surface is downstream of run / workflow / tool event streams ([activity-state.md §3](../relationship-engine/activity-state.md)). Any future change to those event names would require coordinated re-binding; documented in [activity-state.md §3](../relationship-engine/activity-state.md) with concrete file:line references.

## Risks and mitigations

- **Risk: developer drift to "add a graph library for performance".** Mitigation: this ADR + ADR-0026 + the bounded-render contract make the substrate decision binding. The hardening pass [#543](https://github.com/oscharko-dev/Keiko/issues/543) MUST grep `package.json` deltas for new graph / animation / canvas dependencies and fail closed.
- **Risk: developer drift to "invent a new state colour".** Mitigation: the colour palette is enumerated in [activity-visualization.md "Palette source"](../relationship-engine/activity-visualization.md) with file:line references to `globals.css`. New colour tokens require an ADR amendment, not a one-line CSS edit.
- **Risk: developer drift to "add a new chord".** Mitigation: the chord set is in [accessibility-checklist.md "Keyboard map for core actions"](../relationship-engine/accessibility-checklist.md); the conflict-at-startup gate at [`useKeyboardShortcuts.ts:149`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts) fails the build if a new chord collides with `WORKSPACE_RESERVED_CHORDS` or with the existing #66 / #67 chord set.
- **Risk: rendering more than the API returned.** Mitigation: the UI always renders from API response data, never from a client-derived expansion; `truncated: true` surfaces the cap to the operator (per [error-and-denial-ux.md "Bounded-query-exceeded UX"](../relationship-engine/error-and-denial-ux.md)).
- **Risk: announcing too much via `aria-live`.** Mitigation: assertive live regions are reserved for blocking events (creation denial, load error, offline); polite live regions are debounced at 2 second minimum interval per badge ([activity-visualization.md "No flashing thresholds"](../relationship-engine/activity-visualization.md)).
- **Risk: relationship-UI surfaces accidentally leaking endpoint content.** Mitigation: the inspector never inlines evidence manifest content; only links to the Evidence viewer. Audit-row summaries are bounded at 240 chars and redactor-clean by construction per [denial-reasons.md "Cross-cutting invariants"](../relationship-engine/denial-reasons.md).

## Compliance with epic invariants

- **No new third-party dependency**: confirmed; every visual primitive sources from existing Keiko UI; no graph / animation / canvas library is added.
- **No new database**: confirmed; the UI reads through the existing BFF routes locked by ADR-0031 / ADR-0032.
- **No new package**: confirmed; the relationship UI is content rendered inside the existing `@oscharko-dev/keiko-ui` package.
- **No content duplication**: confirmed; the inspector renders evidence references as links, never inlining manifest content.
- **No new authority**: confirmed; the inspector's authority status row renders the verbatim "Relationship: governance only. No model/tool/file/workflow authority granted." disclaimer.
- **No new telemetry**: confirmed; the activity-state derivation is in-memory only ([activity-state.md §1, §8](../relationship-engine/activity-state.md)).

## Related ADRs

- Dark Keiko palette — defined in [`packages/keiko-ui/src/app/globals.css`](../../packages/keiko-ui/src/app/globals.css) at the workspace-foundation level; the relationship surface reuses these tokens without amendment.
- [ADR-0024 — Installable PWA architecture](ADR-0024-installable-pwa-architecture.md) (the UI is fully offline-capable; the offline banner integrates with the PWA service worker).
- [ADR-0026 — Workspace substrate](ADR-0026-workspace-substrate.md) (locks the substrate; this ADR honours the lock).
- [ADR-0027 — Workspace state ownership](ADR-0027-workspace-state-ownership.md) (chat composer remains send-only; relationships are not conversational context).
- [ADR-0028 — Workspace commands / undo](ADR-0028-workspace-commands-undo.md) (`useKeyboardShortcuts.ts` substrate; conflict-at-startup gate).
- [ADR-0029 — Workspace object registry](ADR-0029-workspace-object-registry.md) (endpoint kinds; `AuthorityRequirement`).
- [ADR-0030 — Workspace security and evidence](ADR-0030-workspace-security-evidence.md) (security boundaries the UI honours).
- [ADR-0031 — Relationship storage and validation](ADR-0031-relationship-storage-and-validation.md) (storage placement; the UI never bypasses the BFF).
- [ADR-0032 — Relationship audit, evidence, activity-state](ADR-0032-relationship-audit-and-activity-model.md) (the UI surfaces audit and activity exclusively through its contracts).

## References

- [`docs/relationship-engine/ui-blueprint.md`](../relationship-engine/ui-blueprint.md), [`inspector-spec.md`](../relationship-engine/inspector-spec.md), [`activity-visualization.md`](../relationship-engine/activity-visualization.md), [`accessibility-checklist.md`](../relationship-engine/accessibility-checklist.md), [`error-and-denial-ux.md`](../relationship-engine/error-and-denial-ux.md), [`visual-density-rules.md`](../relationship-engine/visual-density-rules.md).
- [`docs/relationship-engine/taxonomy.md`](../relationship-engine/taxonomy.md), [`lifecycle.md`](../relationship-engine/lifecycle.md), [`denial-reasons.md`](../relationship-engine/denial-reasons.md), [`compatibility-matrix.md`](../relationship-engine/compatibility-matrix.md), [`activity-state.md`](../relationship-engine/activity-state.md), [`audit-events.md`](../relationship-engine/audit-events.md), [`evidence-references.md`](../relationship-engine/evidence-references.md), [`retention-and-privacy.md`](../relationship-engine/retention-and-privacy.md), [`api-contract.md`](../relationship-engine/api-contract.md), [`architecture.md`](../relationship-engine/architecture.md), [`storage.md`](../relationship-engine/storage.md), [`security-checklist.md`](../relationship-engine/security-checklist.md), [`audit-activity-checklist.md`](../relationship-engine/audit-activity-checklist.md).
- [`docs/workspace/518-ui-blueprint.md`](../workspace/518-ui-blueprint.md), [`518-ux-blueprint.md`](../workspace/518-ux-blueprint.md), [`518-canvas-graph-deferral.md`](../workspace/518-canvas-graph-deferral.md), [`518-architecture-blueprint.md`](../workspace/518-architecture-blueprint.md).
- Existing UI components: [`AppShell.tsx`](../../packages/keiko-ui/src/app/components/desktop/AppShell.tsx), [`Workspace.tsx`](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx), [`ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx), [`InspectorPanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx), [`TimelinePanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/TimelinePanel.tsx), [`CommandPalette.tsx`](../../packages/keiko-ui/src/app/components/desktop/modals/CommandPalette.tsx), [`useKeyboardShortcuts.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts), [`connector-graph.tsx`](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx), [`packages/keiko-ui/src/app/globals.css`](../../packages/keiko-ui/src/app/globals.css).
- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#538](https://github.com/oscharko-dev/Keiko/issues/538), [#539](https://github.com/oscharko-dev/Keiko/issues/539), [#540](https://github.com/oscharko-dev/Keiko/issues/540), [#541](https://github.com/oscharko-dev/Keiko/issues/541), [#542](https://github.com/oscharko-dev/Keiko/issues/542), [#543](https://github.com/oscharko-dev/Keiko/issues/543).
