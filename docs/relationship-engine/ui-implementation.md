# Relationship Engine — UI Implementation Notes

> For issues #541 (activity visualization) and #542 (impact / health) consumers.
> All file:line citations reference the `claude/issue-540-inspector-graph-viz` branch.

## Panel locations

| Panel           | File                                                                                         | Mount point                             |
| --------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| List panel      | `packages/keiko-ui/src/app/components/desktop/widgets/panels/RelationshipListPanel.tsx`      | `RelationshipsView` left column         |
| Inspector panel | `packages/keiko-ui/src/app/components/desktop/widgets/panels/RelationshipInspectorPanel.tsx` | `RelationshipsView` right column        |
| Activity badge  | `packages/keiko-ui/src/app/components/desktop/widgets/panels/RelationshipEdgeBadge.tsx`      | Inside list rows and `ConnectionsLayer` |
| Create dialog   | `packages/keiko-ui/src/app/components/desktop/modals/RelationshipCreateDialog.tsx`           | Triggered from page header              |
| Route page      | `packages/keiko-ui/src/app/relationships/page.tsx`                                           | `/relationships`                        |
| View            | `packages/keiko-ui/src/app/relationships/RelationshipsView.tsx`                              | Inside page Suspense boundary           |
| BFF client      | `packages/keiko-ui/src/app/relationships/api.ts`                                             | Imported by all panels above            |

## URL state model

All URL params are parsed in `RelationshipsView.tsx` via `useSearchParams()`, which is
wrapped in `<Suspense>` in `page.tsx` (Next.js static export requirement).

| Param            | Type                                 | Source of truth               | Notes                                           |
| ---------------- | ------------------------------------ | ----------------------------- | ----------------------------------------------- |
| `?relType=`      | `RelationshipType`                   | URL                           | One of `RELATIONSHIP_TYPES`                     |
| `?relLifecycle=` | `RelationshipLifecycleState`         | URL                           | One of `RELATIONSHIP_LIFECYCLE_STATES`          |
| `?relActivity=`  | `RelationshipActivityState`          | URL                           | One of `RELATIONSHIP_ACTIVITY_STATES`           |
| `?relSrcKind=`   | `RelationshipObjectKind`             | URL                           | One of `RELATIONSHIP_SUPPORTED_OBJECT_KINDS`    |
| `?relTgtKind=`   | `RelationshipObjectKind`             | URL                           | One of `RELATIONSHIP_SUPPORTED_OBJECT_KINDS`    |
| `?relDensity=`   | `"minimal" \| "standard" \| "dense"` | URL (+ localStorage fallback) | localStorage key: `keiko.relationships.density` |
| `?relFocus=`     | `string` (relationship id)           | URL                           | Drives inspector; clears via Escape             |

## BFF client exports (`api.ts`)

```typescript
// Error class — surfaces server code + message verbatim
export class RelationshipApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reasons: readonly RelationshipValidationError[];
}

// Types
export interface ApiRelationship { ... }
export interface CreateRelationshipProposal { ... }
export interface ListRelationshipsQuery { ... }
export interface ListRelationshipsResult { ... }
export interface ValidateResult { ... }
export interface ExplainResult { ... }
export interface DependencyReport { ... }   // Used by #542
export interface HealthResult { ... }       // Used by #542

// Functions
export async function validateRelationshipProposal(proposal): Promise<ValidateResult>
export async function createRelationship(proposal, idempotencyKey): Promise<{relationship, etag}>
export async function listRelationships(query): Promise<ListRelationshipsResult>
export async function getRelationship(id): Promise<ApiRelationship>
export async function patchRelationship(id, patch, ifMatch, idempotencyKey): Promise<{relationship, etag}>
export async function deleteRelationship(id, ifMatch, idempotencyKey): Promise<ApiRelationship>
export async function getDependencies(id, opts?): Promise<DependencyReport>  // Used by #542
export async function getImpact(endpointKind, endpointId, opts?): Promise<DependencyReport>  // Used by #542
export async function getExplain(id): Promise<ExplainResult>
export async function getHealth(): Promise<HealthResult>  // Used by #542
```

## CSS variables per activity state

`ACTIVITY_VISUALS` in `RelationshipEdgeBadge.tsx` maps each `RelationshipActivityState`
to a `{ textColor, bgColor }` pair using only existing CSS variables (no new tokens).

| Activity state    | textColor         | bgColor        | animated     |
| ----------------- | ----------------- | -------------- | ------------ |
| `inactive`        | `var(--fg-dim)`   | `var(--inset)` | false        |
| `queued`          | `var(--fg-muted)` | `var(--inset)` | false        |
| `active`          | `var(--ok)`       | `var(--inset)` | true (pulse) |
| `processing`      | `var(--info)`     | `var(--inset)` | true (spin)  |
| `completed`       | `var(--ok)`       | `var(--inset)` | false        |
| `failed`          | `var(--danger)`   | `var(--inset)` | false        |
| `blocked`         | `var(--warn)`     | `var(--inset)` | false        |
| `degraded`        | `var(--warn)`     | `var(--inset)` | true (pulse) |
| `high-throughput` | `var(--accent)`   | `var(--inset)` | true (pulse) |

All animations use `motion-safe:` Tailwind prefix (WCAG 2.3.3 / prefers-reduced-motion).

## Inspector sections (fixed order, inspector-spec.md)

The 10 sections rendered by `RelationshipInspectorPanel.tsx` in document order,
each marked with `data-section=` attribute for test targeting:

1. `data-section="type"` — relationship type + semantics label
2. `data-section="source"` — source endpoint kind + id (redaction-safe)
3. `data-section="target"` — target endpoint kind + id (redaction-safe)
4. `data-section="lifecycle"` — current lifecycle state + action buttons
5. `data-section="activity"` — activity state badge (reuses `RelationshipEdgeBadge`)
6. `data-section="authority"` — `RELATIONSHIP_AUTHORITY_DISCLAIMER` verbatim
7. `data-section="audit"` — lifecycle history (paged, from `getExplain`)
8. `data-section="evidence"` — evidence references (confidence + summary)
9. `data-section="impact"` — View Impact link (drives `onViewImpact` prop → #542)
10. `data-section="denial"` — conditional, shown only when `getExplain` returns `allowed: false`

## Authority disclaimer

```typescript
export const RELATIONSHIP_AUTHORITY_DISCLAIMER =
  "Relationship: governance only. No model/tool/file/workflow authority granted." as const;
```

This constant is exported from `RelationshipInspectorPanel.tsx` and must be rendered
verbatim in the authority section. Tests assert on the exact string.

## Action gating rules (inspector-spec.md §"Action gating")

| Lifecycle   | Reconnect | Archive | Revoke |
| ----------- | --------- | ------- | ------ |
| `pending`   | —         | —       | —      |
| `active`    | —         | yes     | yes    |
| `suspended` | yes       | yes     | yes    |
| `blocked`   | yes       | yes     | yes    |
| `archived`  | —         | —       | —      |
| `revoked`   | —         | —       | —      |
| `failed`    | yes       | —       | yes    |

## Keyboard map

All shortcuts fire only when focus is NOT inside an `<input>`, `<textarea>`, `<select>`,
or `contenteditable` element. See `RelationshipsView.tsx` and `RelationshipInspectorPanel.tsx`.

| Key            | Action                           | File:line                                                |
| -------------- | -------------------------------- | -------------------------------------------------------- |
| `R`            | Reconnect (lifecycle-gated)      | `RelationshipInspectorPanel.tsx` keyboard handler        |
| `A`            | Archive (lifecycle-gated)        | `RelationshipInspectorPanel.tsx` keyboard handler        |
| `Shift+Delete` | Revoke (lifecycle-gated)         | `RelationshipInspectorPanel.tsx` keyboard handler        |
| `I`            | View Impact (opens #542 surface) | `RelationshipInspectorPanel.tsx` keyboard handler        |
| `E`            | View Evidence                    | `RelationshipInspectorPanel.tsx` keyboard handler        |
| `F`            | Toggle focus mode                | `RelationshipListPanel.tsx` keyboard handler             |
| `Escape`       | Clear focus / close dialog       | `RelationshipsView.tsx` + `RelationshipCreateDialog.tsx` |
| `/`            | Focus filter input               | `RelationshipListPanel.tsx` keyboard handler             |

## Density caps (visual-density-rules.md)

| Density    | `DENSITY_EDGE_CAP` (API limit param) | `ANIMATION_CAP` |
| ---------- | ------------------------------------ | --------------- |
| `minimal`  | 5                                    | 25 (shared)     |
| `standard` | 25                                   | 25 (shared)     |
| `dense`    | 512                                  | 25 (shared)     |

`ANIMATION_CAP = 25` is a shared constant across all density modes. When the rendered
list exceeds 25 entries, animated badges beyond that count are rendered statically and an
aggregate badge shows the overflow count. See `RelationshipListPanel.tsx`.

## Optimistic concurrency

All `patchRelationship` / `deleteRelationship` calls pass:

- `If-Match: <etag>` header (current `etag` from last `getRelationship` response)
- `Idempotency-Key: crypto.randomUUID()` (fresh UUID per call, not per session)

On `412 Precondition Failed`, the panel re-fetches and re-renders with the latest state.

## Error surface rules (error-and-denial-ux.md)

- Server `code` and `message` are rendered verbatim — never translated or reworded by the UI.
- Denial section in the inspector shows the server's `code` in monospace + `message` in prose.
- Create dialog denial banner: `role="alert" aria-live="assertive"` (immediate announcement).
- Inspector error/denial: `role="status" aria-live="polite"` (non-disruptive update).
- Security-class denial codes (`denied/path-not-contained`, `denied/cross-workspace`,
  `denied/payload-content-not-permitted`) require explicit user dismissal — no auto-clear.

## Redaction invariant

The inspector renders `source.id` and `target.id` verbatim as returned by the server.
If the server redacts an ID to a placeholder (e.g. `"███████"`), the UI shows that
placeholder. The UI never attempts to un-redact or look up the original value.
This is asserted in `RelationshipInspectorPanel.test.tsx` "redaction invariant" test.

## Integration points for #541 and #542

### #541 — Privacy-preserving activity visualization

- Import `RelationshipEdgeBadge` and the `ACTIVITY_VISUALS` map from
  `packages/keiko-ui/src/app/components/desktop/widgets/panels/RelationshipEdgeBadge.tsx`
- The badge exposes `onClick` for graph-node click-through to the inspector
  (`?relFocus=<id>` URL param)
- `ANIMATION_CAP = 25` must be honored at the visualization layer too

### #542 — Impact analysis + dependency view + health checks

- Use `getDependencies(id, opts?)` from `api.ts` for depth-limited dependency trees
- Use `getImpact(endpointKind, endpointId, opts?)` for reverse-impact from an endpoint
- Use `getHealth()` from `api.ts` for the health dashboard totals
- The inspector's `onViewImpact` prop is a callback from the page; wire it to a
  `?tool=impact&relFocus=<id>` URL param (right-tool-area pattern from #67)
