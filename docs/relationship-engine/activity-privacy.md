# Epic #532 — Relationship Activity Visualization: Privacy Summary

Issue: [#541](https://github.com/oscharko-dev/Keiko/issues/541). Parent: [retention-and-privacy.md](retention-and-privacy.md).

Date: 2026-06-06.

## What this layer does NOT do

This is a precise list of what the activity visualization layer, introduced in #541, **never** does. Each item is backed by the structural contract in [retention-and-privacy.md](retention-and-privacy.md).

### Storage

- **Does not write to disk.** No `fs.writeFile`, no `node:sqlite` INSERT, no evidence persist call is reachable from the activity derivation module or the `useRelationshipActivityStream` hook. (retention-and-privacy.md §3.4 — zero retention.)
- **Does not snapshot activity state.** Process exit drops the in-memory Map. There is no serialization path. A restart re-derives from durable sources.

### Network

- **Does not send activity data to any remote endpoint.** The SSE stream at `GET /api/relationships/events` is served by the local BFF over a local socket. No `fetch` call in the activity layer points outside the local process. (retention-and-privacy.md §2.)
- **Does not emit telemetry.** Activity visualization is a rendered projection of already-redacted state; it is not a new telemetry stream. (retention-and-privacy.md §5.1.)

### Payload content

- **Does not log or store raw prompts, model output, document content, tool stdout/stderr, patch bodies, secrets, credentials, or PII.** The `RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS` list in `@oscharko-dev/keiko-contracts` is applied to every inbound SSE message before the state is stored; any message containing a forbidden key is silently dropped in its entirety.
- **Does not enumerate contributing event IDs.** The `high-throughput` state surfaces only a numeric count (`N_THROUGHPUT` threshold per activity-state.md §5.4), never a list of event or run IDs.
- **Does not carry exception messages from failed runs.** The `failed` state surfaces the relationship ID and the text label "Failed"; exception detail is read from the existing redacted `EvidenceFailure` by the inspector panel, not from the activity layer.

### Cross-workspace

- **Does not cross workspace boundaries.** The in-memory subscriber filters by `workspaceId` at source. An activity event for workspace B is never applied to workspace A's state. (retention-and-privacy.md §5.3.)

## What this layer DOES

- Reads `relationships.lifecycle` (durable, read-only) and the in-process harness event stream (ephemeral, already body-free).
- Derives one of nine `RelationshipActivityState` values per relationship in-memory.
- Emits the state as a body-free SSE message on the local socket for the inspector panel.
- Renders the state as a labeled badge with icon and ARIA description (no color-only communication per WCAG 2.2 AA).

## Allowlist

Every inbound SSE payload is stripped to exactly these keys before the state is stored:

| Key         | Purpose                                                |
| ----------- | ------------------------------------------------------ |
| `kind`      | Event kind discriminant (e.g. `relationship:activity`) |
| `id`        | Relationship ID (opaque, workspace-scoped)             |
| `state`     | One of the 9 `RelationshipActivityState` literals      |
| `timestamp` | Epoch-ms of observation (most-recent only)             |
| `count`     | Numeric aggregate for `high-throughput` only           |

Any key not in this list is silently discarded before the message is processed.

## References

- [retention-and-privacy.md](retention-and-privacy.md) — full bounding contract
- [activity-state.md](activity-state.md) — nine states, bounded derivation, forbidden fields (§7)
- [activity-visualization.md](activity-visualization.md) — per-state visual treatment
- `packages/keiko-contracts/src/relationships.ts` — `RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS`
- `packages/keiko-ui/src/app/components/desktop/widgets/panels/useRelationshipActivityStream.ts` — implementation
