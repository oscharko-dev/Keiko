# Epic #532 — Relationship UI Error and Denial UX

Status: Wave 3 deliverable for [issue #537](https://github.com/oscharko-dev/Keiko/issues/537) under parent epic [#532](https://github.com/oscharko-dev/Keiko/issues/532). Companion to [ui-blueprint.md](ui-blueprint.md), [accessibility-checklist.md](accessibility-checklist.md).

Issue date: 2026-06-06.

## Purpose

This document catalogues every error and denial path the relationship surface can present, how it renders, where it renders, and what remediation it offers. It binds [#540](https://github.com/oscharko-dev/Keiko/issues/540), [#541](https://github.com/oscharko-dev/Keiko/issues/541), and [#542](https://github.com/oscharko-dev/Keiko/issues/542).

The user-facing strings come **verbatim** from [denial-reasons.md](denial-reasons.md) and [api-contract.md](api-contract.md). The UI never invents copy.

## Three-layer error model

The relationship surface distinguishes three error categories. Each renders differently.

| Category                    | Source                                                                                 | Render location                                                              | ARIA live                                           | Persistence                                            |
| --------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| **Validator denial**        | `POST /api/relationships/validate` or `POST /api/relationships` returns a denial code. | Creation banner during preview; inspector "Denial reason" section on commit. | `assertive` during creation, `polite` in inspector. | Banner: transient. Inspector: until lifecycle changes. |
| **API error envelope**      | Typed error from any BFF route (per [api-contract.md §3.4](api-contract.md)).          | Inspector banner; toast for action errors.                                   | `assertive`                                         | Until operator dismisses or retries.                   |
| **Network / runtime error** | `fetch` rejection, JSON parse failure, timeout, offline.                               | Inspector banner; toast for action errors.                                   | `assertive`                                         | Until network returns.                                 |

All three reuse the existing `.lk-alert` chrome (`globals.css:5890`) for the banner shape and `.lk-alert-retry` (`globals.css:5898`) for the retry control. No new error chrome is introduced.

## Per-denial-code UI treatment

For every code in [denial-reasons.md "Catalog"](denial-reasons.md), this table specifies where the message renders, the severity, whether the creation flow continues or dismisses, and whether a "Why?" link opens an explain surface. The **user-facing message** column is the exact string from [denial-reasons.md](denial-reasons.md); the UI MUST NOT alter it.

| Code                                   | User-facing message (verbatim)                                                            | Where rendered                                                           | Dismisses creation?                         | "Why?" link opens                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `denied/non-existent-source`           | "The source endpoint does not exist."                                                     | Creation banner + inspector denial section.                              | Yes.                                        | Endpoint resolver explanation (link to [denial-reasons.md](denial-reasons.md) `non-existent-source` anchor in offline docs). |
| `denied/non-existent-target`           | "The target endpoint does not exist."                                                     | Same as source.                                                          | Yes.                                        | Same.                                                                                                                        |
| `denied/object-kind-not-yet-supported` | "The selected object kind is reserved for a future release."                              | Creation banner.                                                         | Yes.                                        | [taxonomy.md §4.2](taxonomy.md) forward-looking kinds anchor.                                                                |
| `denied/source-kind-not-allowed`       | "The source object kind is not permitted for this relationship type."                     | Creation banner.                                                         | No (operator can re-pick a different type). | [taxonomy.md §5](taxonomy.md) valid-source set anchor.                                                                       |
| `denied/target-kind-not-allowed`       | "The target object kind is not permitted for this relationship type."                     | Same as source-kind.                                                     | No.                                         | Same.                                                                                                                        |
| `denied/kind-incompatible`             | "The relationship type is not compatible with this combination of source and target."     | Creation banner.                                                         | No.                                         | [compatibility-matrix.md §3](compatibility-matrix.md).                                                                       |
| `denied/cardinality-exceeded`          | "Adding this relationship would exceed the allowed number of relationships for the type." | Creation banner + inspector denial.                                      | Yes.                                        | [taxonomy.md §7](taxonomy.md) cardinality rule.                                                                              |
| `denied/cycle-forbidden`               | "The relationship would create a forbidden cycle."                                        | Creation banner + inspector denial.                                      | Yes.                                        | [taxonomy.md §5.7](taxonomy.md) `depends-on` semantics.                                                                      |
| `denied/cross-workspace`               | "Source and target belong to different workspaces."                                       | Creation banner + inspector denial.                                      | Yes.                                        | Workspace scope explanation.                                                                                                 |
| `denied/path-not-contained`            | "The workspace path is outside the project boundary or matches a deny-listed pattern."    | Creation banner + inspector denial.                                      | Yes.                                        | Workspace deny-list explanation.                                                                                             |
| `denied/denied-by-deny-list`           | "The endpoint is excluded by the project deny list."                                      | Creation banner + inspector denial.                                      | Yes.                                        | Project deny-list configuration.                                                                                             |
| `denied/lifecycle-illegal-transition`  | "The requested lifecycle transition is not permitted from the current state."             | Inspector denial section (only — this code never fires during creation). | n/a                                         | [lifecycle.md §3](lifecycle.md) transition table.                                                                            |
| `denied/endpoint-tombstoned`           | "An endpoint has been forgotten and cannot be referenced."                                | Creation banner + inspector denial.                                      | Yes.                                        | Memory governance (forgetting endpoints).                                                                                    |
| `denied/endpoint-retired`              | "An endpoint has been retired by retention and is no longer available."                   | Creation banner + inspector denial.                                      | Yes.                                        | [retention-and-privacy.md](retention-and-privacy.md).                                                                        |
| `denied/endpoint-unavailable`          | "An endpoint is temporarily unavailable."                                                 | Creation banner.                                                         | No (transient — operator may retry).        | Endpoint liveness explanation.                                                                                               |
| `denied/payload-content-not-permitted` | "The relationship may not carry endpoint content."                                        | Creation banner + inspector denial.                                      | Yes.                                        | [taxonomy.md §12](taxonomy.md) payload contract.                                                                             |
| `denied/authority-insufficient`        | "The requesting surface does not have the authority to mutate this relationship."         | Inspector denial section.                                                | n/a                                         | [ADR-0029](../adr/ADR-0029-workspace-object-registry.md) `AuthorityRequirement`.                                             |
| `denied/schema-version-unsupported`    | "The relationship envelope uses a schema version the engine does not support."            | Creation banner + inspector denial.                                      | Yes.                                        | [taxonomy.md §3](taxonomy.md) schema-version pinning.                                                                        |

### Multiple denials

When `RelationshipPolicyDecision.reasons` has length > 1, the banner renders the **most-structural** reason (first per the [denial-reasons.md "Resolution order"](denial-reasons.md)) and a "View N more reasons" link expands the full list into the inspector. The full list always renders in inspector resolution order, never UI-side re-sorted.

### Creation banner anchoring

The creation denial banner anchors per [ui-blueprint.md "Denial banner placement"](ui-blueprint.md). The banner sits within the workspace surface (`.workspace`) so the operator can see both the banner and the source / target windows simultaneously. It does **not** overlay the inspector.

### Inspector denial section

When the inspector is rendering a relationship in `blocked` or `revoked` state, the denial section is the last section before the action button row. It carries:

- The first denial code as a heading: `denied/<slug>`.
- The user-facing message verbatim below it.
- A "View resolution guidance" link to the offline-docs anchor.
- A timestamp: "Denied at <ISO-8601>".
- For `revoked`: an "Audit history" anchor link that scrolls to the corresponding row.

## Loading state taxonomy

Three loading-state primitives are reused; no new spinner / progress bar is introduced.

| Primitive        | Existing source                                                                                                | Use case                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skeleton**     | `lk-status` skeleton blocks ([518-ui-blueprint.md "Visual state catalogue"](../workspace/518-ui-blueprint.md)) | List loads, inspector section loads, audit history page load. Renders after 500 ms threshold to avoid flash.                                                                          |
| **Spinner**      | `chat-spin` (`globals.css:396`)                                                                                | Action button in-flight state (e.g., during `PATCH /api/relationships/:id`). Renders inline inside the button while it is `aria-busy="true"`.                                         |
| **Progress bar** | `.arun-prog` (`globals.css:1904`)                                                                              | Bounded impact analysis (`GET /api/relationships/impact`) — shows the bounded-traversal progress when the API returns `truncated: true` and the client follows up with a deeper walk. |

The hardening pass MUST verify no `<progress>` / `<spinner>` from a third-party library is introduced.

## Network error UX

### Offline banner

When the local backend is unreachable (`fetch` rejection or 5xx > 3 consecutive retries):

- A **persistent** offline banner renders in the **Footer status area** ([518-ui-blueprint.md "Footer"](../workspace/518-ui-blueprint.md)) carrying the verbatim string from [accessibility-checklist.md](accessibility-checklist.md): "Unable to reach the local backend. Check that `keiko serve` is running."
- The offline banner uses `role="alert" aria-live="assertive"` for the first announcement; subsequent re-announcements are suppressed (the banner remains visible, but assistive technology is not re-announced).
- The relationship inspector remains rendered with its last known state; rows are decorated with `aria-busy="true"` until network returns.
- No action buttons mutate while offline; each carries `aria-disabled="true"` with the title "Local backend unavailable".

### Retry button placement

- For inspector loads: a "Retry" button inside the inspector `.lk-alert` banner (existing `.lk-alert-retry` at `globals.css:5898`).
- For action mutations: a "Retry" link in the toast that announces the failed action; the toast persists for 8 seconds (longer than the standard 6 s for transient toasts because the operator may need time to read the failure).
- Retries are bounded: at most 3 retries per user gesture, exponential back-off (500 ms, 1500 ms, 4500 ms). Beyond 3 retries the offline banner appears.

### Cursor-expired UX

When `GET /api/relationships` (paged) returns `relationship/cursor-expired` ([api-contract.md "cursor-expired"](api-contract.md)):

- The inline pagination control surfaces "Result set has changed. Reloading." with `aria-live="polite"`.
- The client re-issues the request without the stale cursor; the inspector returns to the first page transparently.
- No error banner is shown for this case — it is normal pagination drift.

## Bounded-query-exceeded UX

Two sub-cases:

### (a) API rejected the request because the caller exceeded the hard cap

Returns `relationship/bounded-query-exceeded` (HTTP 400) per [api-contract.md "Limit caps"](api-contract.md). The UI surfaces this as a `.lk-alert` banner:

- "Query exceeded the per-endpoint cap (<cap>). Refine your filter or paginate."
- The banner is `role="alert" aria-live="assertive"`.
- Action: "Reset to defaults" — resets the URL state filters to their defaults.

This case is expected to be **rare** because the UI never sends caller-requested limits above the documented defaults; it surfaces only on URL hand-crafting.

### (b) Server applied the bounded-query cap and returned a partial result

The response carries `X-Truncated: true` header and `truncated: true` + `nextCursor` body fields ([api-contract.md §3.5](api-contract.md)). The UI:

- Renders a **footer line** below the rendered list: "Showing first N of M relationships." Token N is the rendered count; M is `N` (from `entries.length`) **plus an estimate from `nextCursor` page count** if available — never a fabricated total.
- If the impact endpoint returns `truncationReason: "max-depth"` / `"max-nodes"` / `"max-relationships"`, the footer line also names the reason: "Impact analysis bounded at maximum depth (3)." / "Impact analysis bounded at 1024 nodes." / "Impact analysis bounded at 2048 relationships." — each verbatim from the [api-contract.md §4.7](api-contract.md) reason vocabulary.
- A "Load more" link issues the next-cursor request. The link is keyboard-accessible (`<a href>` not `<div role="link">`).
- The footer line has `aria-live="polite"` so it announces on initial render.

The footer line styling reuses `.footer` chrome (`globals.css:643`); no new chrome is introduced.

## Loading-skeleton avoidance for fast paths

Per the existing 500 ms skeleton-flash threshold in the workspace shell, fast loads (< 500 ms server time) render directly without a skeleton. The implementation in #540 / #542 MUST use the existing skeleton-debounce hook (or equivalent) rather than always rendering the skeleton.

## Forbidden patterns

The implementation MUST NOT:

- Render a third-party toast library (`react-toastify` / `react-hot-toast` / `sonner`). The toast surface is the existing Notifications panel (`NotificationsPanel.tsx`).
- Swallow errors silently. Every `catch` either renders the error banner or re-throws with redacted context.
- Render raw error stack traces. Server-side errors render their typed `code` / `message` from [api-contract.md §3.4](api-contract.md); never `Error.stack`.
- Auto-dismiss a denial of `denied/path-not-contained` / `denied/cross-workspace` / `denied/payload-content-not-permitted` (security-class denials) — these require explicit operator dismissal so the operator sees the security signal.
- Translate any denial message. The catalog is the single source of truth in this Wave.

## References

- Epic: [#532](https://github.com/oscharko-dev/Keiko/issues/532). Issue: [#537](https://github.com/oscharko-dev/Keiko/issues/537). Downstream: [#540](https://github.com/oscharko-dev/Keiko/issues/540), [#541](https://github.com/oscharko-dev/Keiko/issues/541), [#542](https://github.com/oscharko-dev/Keiko/issues/542).
- Companions: [ui-blueprint.md](ui-blueprint.md), [inspector-spec.md](inspector-spec.md), [activity-visualization.md](activity-visualization.md), [accessibility-checklist.md](accessibility-checklist.md), [visual-density-rules.md](visual-density-rules.md).
- Foundation: [denial-reasons.md](denial-reasons.md), [api-contract.md](api-contract.md), [taxonomy.md](taxonomy.md), [lifecycle.md](lifecycle.md), [compatibility-matrix.md](compatibility-matrix.md), [retention-and-privacy.md](retention-and-privacy.md).
- Existing UI: `globals.css` (`.lk-alert`, `.lk-alert-retry`, `chat-spin`, `.arun-prog`, `.footer`), [`NotificationsPanel.tsx`](../../packages/keiko-ui/src/app/components/desktop/widgets/panels/NotificationsPanel.tsx).
- Workspace blueprints: [518-ui-blueprint.md](../workspace/518-ui-blueprint.md), [518-ux-blueprint.md](../workspace/518-ux-blueprint.md).
- ADRs: [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0033](../adr/ADR-0033-relationship-ui-containment.md).
