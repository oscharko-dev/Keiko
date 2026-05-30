# ADR-0015: Chat as a Thin View of Canonical Run and Evidence Stores

## Status

Accepted

Decided alongside issue #66 (epic #61 child 5/7). The ADR formalises the choice to treat the
project-scoped chat history as a concise journal that references the canonical run and evidence
stores, rather than as a second audit ledger that replicates their content. Implementation lands
in `src/ui/store/{schema,types,messages,db,index}.ts`, the new PATCH Route 23 in
`src/ui/{routes,store-handlers}.ts`, the new `ui/lib/run-summary.ts`, and the new
`ui/app/components/shell/{useRunStatusSync,RunSummaryCard}.{ts,tsx}` modules.

## Context

Issue #66 connects workflow execution back into the project-scoped chat history. When the user
launches a workflow from the composer (issue #65), the chat must surface a lightweight summary
message with a status, a label, and traceable links to the existing `/run` and `/evidence/detail`
detail pages. The summary must transition from `running` to `completed`, `failed`, or `cancelled`
without persisting the underlying event stream.

Five forces shape the design.

**The chat database must not become a second audit ledger.** ADR-0010 (run-scoped evidence
manifests, append-only file store, redacted-by-construction) is already the authoritative record
for a run. Replicating any of its contents into `chat_messages` widens the at-rest secret surface
(every redaction bug now has two write paths), forces ADR-0010's retention policy onto the chat
DB, and contradicts the issue's explicit "chat is a concise work journal, not a second audit
ledger" engineering note. The chat may **reference** a run by id; it must not **embed** its
events, diffs, manifests, or private logs.

**The run registry is bounded; the evidence store is durable.** `src/ui/runs.ts` keeps a
600-second TTL on completed runs (memory #11). After that window a `GET /api/runs/:runId`
returns 404 but the manifest at `/api/evidence/:runId` is still there. The chat-side status sync
must reflect this asymmetry: a 404 on `/api/runs` is not a terminal "unavailable" — the manifest
fallback path turns it into a faithful PATCH. Only when **both** endpoints 404 does the chat
surface a non-crashing unavailable state.

**Run status mutates over time but the chat row must be stable.** The user opens the chat once
and may leave the tab open across the run. The summary row must transition from `running` to a
terminal status in place — not by appending a second message. Otherwise the chat shows two
entries per launch and the user cannot tell the historical record from a stale ping. AC1 makes
this explicit ("exactly one user message and one run summary message"). The PATCH-on-the-same-row
shape is the only mechanism that satisfies AC1.

**Wave 1 chose SSE for the run/event detail surface (ADR-0011 D8).** The `/api/runs/:runId/events`
stream already carries the full event sequence to the dedicated `/run?id=...` page. The chat
does NOT show the event content — only the terminal status and the short result text. Importing
SSE into the chat layer would require event-type discrimination, ring-buffer replay logic, and a
second consumer of the same event stream — without adding any user-visible information. A simple
polling loop on `GET /api/runs/:runId` is sufficient, simpler, and lower-risk.

**The `verify` and `explain-plan` runs are not workflows.** Issue #65 introduced two harness task
runs that do not carry a `workflowId`. The chat must still label them unambiguously ("Verify",
"Explain Plan") without overloading `workflow_id` semantics. The schema needs an additive
discriminator.

## Decisions

### D1 — PATCH the row, never append on completion.

Issue Route 23 is `PATCH /api/chats/messages?id=<messageId>`. The handler accepts any subset of
`{ workflowStatus, shortResult, taskType }`; an empty patch is `INVALID_REQUEST`. The store
runs `shortResult` through the existing `processShortResult` (redact + truncate to 200 chars),
so the redaction guarantee that `createMessage` gave POST applies equally to PATCH. The route
shares the existing CSRF + JSON-Content-Type guard (memory #62 M1, `src/ui/server.ts`).

Why a PATCH instead of an append-on-completion POST: AC1 requires exactly one summary message per
launch. The PATCH-on-the-row shape is the only mechanism that preserves the invariant under
concurrent users, refresh, and a wide variety of failure modes.

### D2 — UI-side sync, not backend coupling.

The run engine is not modified. The card-level `useRunStatusSync` hook runs in the chat layer,
polls the run registry, falls back to the evidence manifest, and dispatches the PATCH. This
preserves three boundaries:

- `src/audit/`, `src/ui/run-engine.ts`, and `src/ui/store/` stay mutually independent. No new
  compile-time edge between subsystems.
- The bounded 600s run-registry TTL is no longer a constraint — the evidence fallback handles
  late catch-up.
- A future replacement of the chat layer can re-implement the sync without touching the harness.

### D3 — Polling, not chat-side SSE.

`GET /api/runs/:runId` returns `{ report: { status: "running" } }` while the run is in flight
and the redacted final report once it terminates. Polling at 1500 ms (with backoff to 6000 ms
after 60 s) is sufficient because the chat does not render events; it only needs the terminal
status and the short result. SSE for the chat would require event-type discrimination and replay
logic the chat has no use for.

The poll stops on terminal status, component unmount, or `unavailable=true`. The current
`fetchJson` wrapper does not expose an `AbortSignal`, so cancellation uses a closure-scoped
`cancelled` flag that is the single source of truth for loop termination: an in-flight fetch
at unmount-time still resolves, but the flag gates every subsequent state mutation, including
the PATCH on a terminal report. A slow request therefore cannot PATCH or rerender after the
card leaves the tree. A transient PATCH failure reschedules the loop (subject to the same
backoff) rather than stranding the row in a non-terminal status until reload.

### D4 — Extend `WorkflowStatus` with `"cancelled"`.

Backend `RunStatus` (`src/ui/runs.ts`) already has `cancelled`. Chat `WorkflowStatus` did not.
The status set is JS-side only (the schema has no `CHECK` on `workflow_status`), so the change
is purely a code edit in `src/ui/store/types.ts`, `src/ui/store/messages.ts` `STATUSES`, and
`src/ui/store-handlers.ts` `WORKFLOW_STATUSES`. No DB migration is needed for the status enum.

### D5 — Additive `task_type` column (schema V2).

`verify` and `explain-plan` runs carry no `workflowId`. To label them unambiguously without
overloading `workflow_id`, the schema gets an additive `task_type TEXT` column via V2 migration
(`ALTER TABLE chat_messages ADD COLUMN task_type TEXT;`). STRICT-table SQLite requires an
explicit type for `ADD COLUMN`; `TEXT` matches the other discriminator columns. Existing rows
materialise `NULL`. The render layer reads `workflowId` first, falls back to `taskType`, and
defaults to "Workflow run" when both are absent.

The taskType validator is `[a-z][a-z0-9-]*` (≤ 64 chars) on both POST and PATCH so the label
stays URL-safe and matches the BFF descriptor identifiers.

### D6 — Pure summary builder.

`formatRunSummary(report: unknown, fallbackKind): { workflowStatus, shortResult }` lives in
`ui/lib/run-summary.ts`. It is defensive by construction: `unknown` input, no throws, conservative
fallback ("Completed." / "Failed." / "Cancelled.") on shape mismatch. Per-kind text strings are:

- `unit-tests` completed: `"Generated N test files; M tests proposed."` (or `"Generated N test files."` when counts are absent).
- `bug-investigation` completed: `"Investigation complete; root cause documented."`
- `verify` completed: `"Verification passed: N classifications."`
- `explain-plan` completed: `"Plan generated; N steps."`
- failed: `"Run failed: <message>."` (truncated to fit the 200-char cap).
- cancelled: `"Run cancelled."`

The 200-char cap is enforced on the client too (the BFF re-truncates) so the wire never carries
pathological failure messages.

### D7 — Unavailable state is presentation-only.

When `/api/runs/:runId` 404 and `/api/evidence/:runId` 404 both happen, the persisted
`workflowStatus` stays unchanged. The card renders the last-known status alongside an
unobtrusive "Run details no longer available." hint; the two links are rendered but
`aria-disabled="true"` + `tabIndex={-1}` + `pointer-events-none cursor-not-allowed opacity-50`
so they communicate the missing target without crashing the chat. The persisted DB row stays
honest (it records what we last knew, not a synthetic "unavailable" state).

### D8 — Reload path uses the same hook.

On reload, `ChatView` fetches messages, sees a `system` message with `runId` and a non-terminal
`workflowStatus`, and the `RunSummaryCard` it renders runs `useRunStatusSync` exactly the same
way as on the first launch. There is no separate "reload" code path; the catch-up is the normal
case.

## Consequences

### Positive

- Chat history stays a concise journal. Searching, archiving, deleting, and exporting chats are
  all unaffected by the run/evidence retention rules.
- No new at-rest secret surface in `chat_messages`. The redactor seam runs on every persisted
  `shortResult` (memory #62 H1 production-wiring test extended to PATCH).
- The run-detail surface (`/run`, `/evidence/detail`) remains the single source of truth for
  events, diffs, manifests, and apply gates. The chat references them; it never embeds them.
- The chat survives the bounded 600-second run-registry TTL because the manifest fallback covers
  the late-arrival case.
- The 23rd route is additive — it does not change the existing 22 contract behaviours.

### Negative

- Polling is wasteful for a long-idle running run. The 6000 ms backoff after 60 s mitigates the
  worst case; the median run terminates inside the 1500 ms base interval anyway.
- The `formatRunSummary` per-kind text strings are baked into the client. Adding a new workflow
  requires editing `WORKFLOW_LABELS`, `classifyKind`, and the per-kind formatter. The cost is
  bounded — the same edits are required to surface the run anywhere else in the UI.
- A user closing the chat tab mid-run misses the live status; the next time the chat opens, the
  hook catches up via either the run registry (within 600 s) or the evidence manifest (after).
  This is acceptable because the canonical sources hold the truth.

### Neutral

- The chat now displays a status badge with iconography. The icon set is intentionally minimal
  (`✓`, `✕`, `⊘`, `◐`) so it works without any new font or asset dependency.

## Alternatives considered and rejected

- **Append a completion message on terminal.** Violates AC1 ("exactly one user message and one
  run summary message"). Forces the user to scan two entries per launch and creates a state
  divergence when an older client renders a chat written by a newer client.
- **Backend-driven PATCH from the run engine.** Creates a new compile-time edge between
  `src/audit/`, the run engine, and the chat store. Couples chat persistence to the harness
  state machine. Hard to test in isolation; hard to evolve.
- **SSE-driven chat sync.** Imports a stream consumer for events the chat never renders. Adds
  event-type discrimination + replay logic that the polling solution does not need.
- **CHECK constraint on `workflow_status`.** Locks the status set into the schema; every future
  status addition becomes a migration. The JS-side `STATUSES` set was already the source of
  truth (memory #62); keeping it that way is consistent.

## Out-of-scope

- No new run engine, SSE route, or evidence store.
- No detailed run-event timeline in the chat (the `/run?id=…` page already does that).
- No `applyRun` UI in chat (the `/run?id=…` page already does that).
- No archival or deletion policy for chat messages.
- No per-project default-model setting.
- No general-chat (free-form assistant text) — only workflow run summaries are added.
