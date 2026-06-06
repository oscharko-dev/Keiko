# Epic #532 — Relationship Inspector Specification

Status: Wave 3 deliverable for [issue #537](https://github.com/oscharko-dev/Keiko/issues/537) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [ui-blueprint.md](ui-blueprint.md).

Issue date: 2026-06-06.

## Purpose

This document specifies the relationship inspector: section order, content per section, action gating, empty / loading / error states, and the ARIA wiring. The inspector is the operator's single explanation surface for "what is this relationship, why is it here, what is happening to it, and what evidence backs it". It binds [#540](https://github.com/oscharko-dev/Keiko/issues/540).

## Containment

The relationship inspector is **not a new panel**. It is content rendered inside the existing [`InspectorPanel.tsx:11`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx) (107 lines, registered in `WindowsRegistry.ts`, docked on the right rail per [518-ui-blueprint.md](../workspace/518-ui-blueprint.md)). When the focused workspace window has no relationship context, `InspectorPanel.tsx` continues to render its existing "Active window" sections (size, position, configuration, governance) unchanged. When the focus is a relationship, the inspector adds a **prefixed relationship section** above the "Active window" section. Both sections are scrollable inside `.tw-pad` from `globals.css`.

## Activation

The inspector enters relationship mode when **any** of these become true:

1. The operator clicks a relationship edge's `.conn-badge` (existing button at [`ConnectionsLayer.tsx:92`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx)). The existing `removeConn` handler is **not removed**; it is reassigned to a typed `DELETE /api/relationships/:id` after a confirmation modal.
2. The URL state has `?relFocus=<relationshipId>` (per the URL-state model in [visual-density-rules.md](visual-density-rules.md)).
3. The activity timeline ([`TimelinePanel.tsx:26`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/TimelinePanel.tsx)) row carrying a relationship reference is activated (Enter / Space on the row).

The inspector exits relationship mode when the operator presses `Escape` (existing chord substrate) or selects a workspace window that is not an endpoint of the focused relationship.

## Section order

Sections render in this exact order. Each section is preceded by an `rb-section-label` heading (existing `globals.css:4404`).

1. **Type and display name**
2. **Source endpoint**
3. **Target endpoint**
4. **Lifecycle status** (chip)
5. **Activity** (current state + 5 most recent transitions)
6. **Authority status** (verbatim disclaimer)
7. **Audit history** (paged, append-only)
8. **Evidence references**
9. **Impact summary** (link to dependency view)
10. **Denial reason** (rendered ONLY when the lifecycle is `blocked`/`revoked` or the most recent transition attempt failed)

### 1. Type and display name

Renders the relationship's `type` (from the closed set in [taxonomy.md §5](taxonomy.md)) and a generated display name `"<sourceKind> <type> <targetKind>"`. The type chip uses the same `chip` styling as the existing context chips (`globals.css:1416`); the display name uses `insp-title` (`globals.css:4021`).

### 2. Source endpoint

Two rows in an `rb-rows` block:

- `Kind` — the source's `EndpointKind` from [taxonomy.md §4](taxonomy.md).
- `Reference` — the source's redacted reference string (id segment from the redactor; **never** the raw id verbatim if the redactor flagged it).

A "Reveal" affordance is **deliberately absent**. The inspector never un-redacts identifiers the redactor opaqued.

### 3. Target endpoint

Mirror of §2 for the target endpoint.

### 4. Lifecycle status

A single chip rendering the value from the closed `RelationshipLifecycle` set in [lifecycle.md §1](lifecycle.md). The chip's visible label is the bare state token; an `aria-describedby` association maps each state to its [lifecycle.md table description](lifecycle.md). The chip background and text colors are bound to the four-state palette below — never color alone:

| Lifecycle    | Chip background (token)                               | Chip text (token) | Icon           |
| ------------ | ----------------------------------------------------- | ----------------- | -------------- |
| `draft`      | `var(--inset)`                                        | `var(--fg-muted)` | hollow circle  |
| `active`     | `var(--accent-dim)`                                   | `var(--accent)`   | filled circle  |
| `archived`   | `var(--inset)`                                        | `var(--fg-dim)`   | filled square  |
| `superseded` | `var(--inset)`                                        | `var(--fg-dim)`   | arrow-right    |
| `revoked`    | `color-mix(in oklch, var(--danger) 14%, var(--card))` | `var(--danger)`   | filled X       |
| `blocked`    | `color-mix(in oklch, var(--warn) 12%, var(--card))`   | `var(--warn)`     | warning-square |
| `stale`      | `var(--inset)`                                        | `var(--fg-faint)` | hollow square  |

The exact background/text token tuples reuse existing Keiko semantic tokens (`globals.css:5-50`). No new color is introduced.

### 5. Activity (current state + 5 most recent transitions)

The current activity state from the closed nine-state set in [activity-state.md §2](activity-state.md), rendered with the four-descriptor binding from [activity-state.md §6](activity-state.md) (text + ARIA description + icon + optional color). The implementation is owned by [#541](https://github.com/oscharko-dev/Keiko/issues/541); the visual is normatively specified in the companion [activity-visualization.md](activity-visualization.md).

Below the current-state badge, the inspector lists the **5 most recent transitions** in a vertical list. Each row carries:

- Activity-state badge (after transition).
- ISO-8601 timestamp (`occurredAt`).
- The `RelationshipActivityKind` slug (from [lifecycle.md §5](lifecycle.md), e.g. `relationship:accepted`).

The list is capped at 5; older entries are reachable through the "Audit history" section (§7), which paginates. The cap is intentional: the inspector is a glance surface, not a log viewer.

### 6. Authority status (verbatim)

A single read-only `rb-row` rendering the following string **verbatim**:

> Relationship: governance only. No model/tool/file/workflow authority granted.

The string is a constant; it is not interpolated from data; it is not translatable in Wave 3 (i18n is out of scope for #532 per the epic non-goals). The constant lives in a shared `RELATIONSHIP_AUTHORITY_DISCLAIMER` export to prevent drift.

### 7. Audit history (paged)

Renders the per-relationship audit events from the closed nine-kind catalogue in [audit-events.md §3](audit-events.md). The contract:

- **Page size**: 10 events.
- **Pagination**: `nextCursor` opaque token returned by the BFF (mirrors [api-contract.md §3.5](api-contract.md) `nextCursor` discipline).
- **Empty state**: "No audit events for this relationship yet."
- **Per-row content**: kind slug, `occurredAt`, redacted `actor`, bounded `summary` (≤ 240 chars per [denial-reasons.md cross-cutting invariant 1](denial-reasons.md)). The row **never** renders endpoint content, prompts, document text, or tool output.
- **Evidence link**: when the audit row's `evidenceRunId` is non-null, the row carries a "View evidence" link that focuses the existing Evidence viewer (`ReviewWidget.tsx` evidence tab per [518-ui-blueprint.md](../workspace/518-ui-blueprint.md)). The inspector itself does not render evidence content; it only renders the link.
- **Append-only**: there is no edit, delete, or reorder affordance on audit rows. They are governance evidence.

### 8. Evidence references

Lists the evidence references the relationship carries (per [evidence-references.md](evidence-references.md)). Each reference is a typed pointer to an existing `EvidenceManifest` row; the inspector never inlines the manifest content. The list contract:

- One row per reference; each row links to the existing Evidence viewer.
- Maximum **5** references rendered inline; if the relationship has more, a "View all N evidence references" link expands the list in the Evidence viewer.
- A reference whose target manifest is `retired` (per [retention-and-privacy.md](retention-and-privacy.md)) renders with a "Retired" chip and no link.

### 9. Impact summary (link to dependency view)

A single `rb-row` with the bounded counts from the impact endpoint ([api-contract.md §4.8](api-contract.md)):

- `Forward dependencies`: integer count, capped at `maxRelationships = 512` by default.
- `Reverse dependencies`: same cap.
- `View Impact` button — switches the inspector to the dependency-view tab (per #542). The button is owned by [accessibility-checklist.md](accessibility-checklist.md) for the keyboard contract; the visual treatment is the existing `arun-btn` chrome (`globals.css:1972`).

The full dependency graph rendering is **inside the inspector** (a tab section), not a new window. This honours the no-new-panel rule.

### 10. Denial reason (conditional)

Rendered ONLY when:

- The relationship's lifecycle is `blocked` or `revoked`, OR
- The most recent transition attempt produced a `RelationshipPolicyDecision` with at least one denial reason.

The content:

- Each denial reason renders its **code** (e.g. `denied/cross-workspace`) and its **user-facing message verbatim** from [denial-reasons.md](denial-reasons.md).
- Reasons are ordered per the resolution order in [denial-reasons.md "Resolution order"](denial-reasons.md).
- The section uses the existing `.lk-alert` chrome (`globals.css:5890`) for visual emphasis but with `role="status" aria-live="polite"` (NOT `aria-live="assertive"`, because the denial is steady-state when the inspector is open — assertive belongs to the live denial banner during creation, per [ui-blueprint.md "Denial banner placement"](ui-blueprint.md)).

## Empty state

When activated with an unknown / not-found relationship id (e.g. URL points to a deleted relationship), the inspector renders:

- An `insp-empty` (`globals.css:4025`) message: "This relationship is no longer available."
- A subtitle: "It may have been deleted, retired by retention, or it never existed in this workspace."
- A single secondary action: "Clear focus" — clears the URL state and restores the inspector to the focused-window view.

The empty state never falls back to rendering the bare "Active window" sections; it is a deliberate explanation.

## Loading state

While `GET /api/relationships/:id` ([api-contract.md §4.4](api-contract.md)) is in flight:

- Each `rb-rows` block renders skeleton placeholders (3 lines per block) — reuses the existing `lk-status` skeleton pattern referenced in [518-ui-blueprint.md "Visual state catalogue"](../workspace/518-ui-blueprint.md).
- The skeleton is shown only after a 500 ms threshold to avoid flash on fast responses.
- `aria-busy="true"` is applied to the inspector container while loading.
- No spinner is shown above the section level; the existing `chat-spin` (`globals.css:396`) is used only inside `aria-busy` containers if the load exceeds 2 seconds.

## Error state

When `GET /api/relationships/:id` returns an error:

- The inspector renders an `.lk-alert` banner with `role="alert"` and `aria-live="assertive"`.
- The banner carries the user-facing error message from the typed BFF error envelope (per [api-contract.md §3.4](api-contract.md)).
- A "Retry" button reissues the GET. The button is the existing `lk-alert-retry` (`globals.css:5898`).
- The previous successful inspector state (if any) is **preserved** below the banner so the operator does not lose context.

Network-class errors (offline, fetch failure) render the same banner shape but with a fixed message: "Unable to reach the local backend. Check that `keiko serve` is running." No retry on offline; the retry surfaces when network returns.

## Action buttons

Five action buttons are rendered at the bottom of the relationship section. Each is gated by lifecycle rules from [lifecycle.md §3](lifecycle.md). The button row uses existing `arun-btn` chrome (`globals.css:1972`); the primary action uses `arun-btn.primary` (`globals.css:1986`).

| Action            | Visible when (lifecycle)                        | Issues                                                                            | Disabled-reason copy when not visible            |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Reconnect**     | `blocked`                                       | `PATCH /api/relationships/:id` with `lifecycle: "draft"` (replays validation)     | "Only blocked relationships can be reconnected." |
| **Archive**       | `active`                                        | `PATCH /api/relationships/:id` with `lifecycle: "archived"`                       | "Only active relationships can be archived."     |
| **Revoke**        | `active`, `blocked`, `archived`                 | `DELETE /api/relationships/:id` (server transitions to `revoked`; tombstone kept) | "Already revoked or superseded."                 |
| **View Impact**   | `active`                                        | Switches inspector to dependency tab (#542)                                       | "Impact analysis is unavailable in this state."  |
| **View Evidence** | (always when ≥ 1 evidence reference is present) | Focuses Evidence viewer on the first reference                                    | "No evidence references for this relationship."  |

Disabled buttons render with `aria-disabled="true"` and surface their disabled-reason via the existing `title` tooltip plus a palette-discoverable disabled label (per the [518-ui-blueprint.md "Accessibility-driven UI requirements"](../workspace/518-ui-blueprint.md) item 2).

### Keyboard map

All action buttons are reachable via Tab in declared order. Each has a single-letter chord for power users, registered through [`useKeyboardShortcuts.ts:137`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts) (no new chord library):

| Action        | Chord          |
| ------------- | -------------- |
| Reconnect     | `R`            |
| Archive       | `A`            |
| Revoke        | `Shift+Delete` |
| View Impact   | `I`            |
| View Evidence | `E`            |

The chord set is intentionally short and uses keys that do **not** collide with browser-reserved chords (per [`useKeyboardShortcuts.ts:7`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts) `WORKSPACE_RESERVED_CHORDS`). Conflict-at-startup ([`useKeyboardShortcuts.ts:149`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts)) fails the build if any of the chords collide with the existing #66/#67 chord set.

The full keyboard contract for the inspector (Tab order, focus restoration, roving tabindex on the tab strip) is owned by [accessibility-checklist.md](accessibility-checklist.md).

## Confirmation dialogs

`Revoke` and `Archive` route through the existing `PermControl` modal (`modals/PermControl.tsx` per [518-ui-blueprint.md](../workspace/518-ui-blueprint.md)). The dialog title states the action, the body lists the relationship's source / target / type, and the primary CTA is the action itself (red `var(--danger)` for `Revoke`; neutral for `Archive`). Focus traps and `aria-labelledby` are governed by the existing `PermControl` contract — no new modal is added.

## ARIA wiring summary

| Region                    | Role / ARIA                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Inspector container       | `aria-busy="true"` while loading; otherwise unset.                                                     |
| Section headings          | `<div role="heading" aria-level="3">` (matches existing `rb-section-label` semantics).                 |
| Activity badge            | Per [activity-state.md §6.2](activity-state.md) `role="status" aria-live="polite" aria-atomic="true"`. |
| Audit row "View evidence" | `<a>` with descriptive accessible name; never `<div role="link">`.                                     |
| Action buttons            | Each `<button type="button">` with `aria-label` when icon-only; otherwise visible label.               |
| Disabled actions          | `aria-disabled="true"` + visible disabled-reason via tooltip.                                          |
| Error banner              | `role="alert" aria-live="assertive"`.                                                                  |
| Denial reason section     | `role="status" aria-live="polite"`.                                                                    |
| Confirmation dialog       | Existing `PermControl` contract: `role="dialog" aria-modal="true" aria-labelledby aria-describedby`.   |

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#540](https://github.com/oscharko-dev/Keiko/issues/540).
- Companions: [ui-blueprint.md](ui-blueprint.md), [activity-visualization.md](activity-visualization.md), [accessibility-checklist.md](accessibility-checklist.md), [error-and-denial-ux.md](error-and-denial-ux.md), [visual-density-rules.md](visual-density-rules.md).
- Foundation: [lifecycle.md](lifecycle.md), [taxonomy.md](taxonomy.md), [denial-reasons.md](denial-reasons.md), [activity-state.md](activity-state.md), [audit-events.md](audit-events.md), [evidence-references.md](evidence-references.md), [api-contract.md](api-contract.md), [retention-and-privacy.md](retention-and-privacy.md).
- Existing UI: [`InspectorPanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/InspectorPanel.tsx), [`TimelinePanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/TimelinePanel.tsx), [`ConnectionsLayer.tsx`](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx), [`useKeyboardShortcuts.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/useKeyboardShortcuts.ts), `globals.css`.
- Workspace blueprints: [518-ui-blueprint.md](../workspace/518-ui-blueprint.md), [518-ux-blueprint.md](../workspace/518-ux-blueprint.md).
- ADRs: [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).
