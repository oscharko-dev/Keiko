# ADR-0060: Agent editor session registry, action queue, and SSE events

## Status

Accepted

## Context

Issue #1392 (Epic #1491) owns the BFF runtime that lets agents discover live editor sessions and queue
actions for a connected browser bridge. It builds directly on the public contract ratified by Issue
#1391 ([ADR-0059](ADR-0059-agent-editor-public-contracts.md)) and the safe apply-edits preflight added
by Issue #1394 ([ADR-0058](ADR-0058-safe-apply-edits-and-patch-workflow.md)). Its scope is "server
routes for sessions, snapshots, actions, and events; a live registry of browser bridges, queued
actions, action results, timeouts, and structured failures," and its acceptance criteria are:

1. No active bridge returns a structured unavailable response.
2. Queued actions time out safely.
3. Mutating routes require CSRF / same-origin protection.
4. File targets remain workspace-contained.
5. The server never mutates React/editor state directly.

The BFF routes (`GET /api/editor/agent/sessions`, `POST /api/editor/agent/snapshot`,
`POST /api/editor/agent/actions`, `GET /api/editor/agent/events`) and the snapshot/preflight/idempotency
machinery already exist from #1391/#1394. The gap #1392 closes is the _live_ control plane: bridge
liveness, a bounded and self-healing action queue, result correlation, and bounded event fan-out.

## Decision

### D1 — The server coordinates; the browser bridge owns mutation (AC5)

The server never executes an action and never mutates React/Monaco state. The BFF records snapshots,
validates and bounds actions, fans out events, and times out unacknowledged work. The browser bridge
(the keiko-ui editor runtime) is the only component that mutates the editor and reports results. This
preserves React/Monaco ownership and avoids brittle remote DOM control. The registry
(`packages/keiko-server/src/editor/agentSessionRegistry.ts`) is the single owner of the in-memory,
non-persistent control-plane state; the route module (`agentRoutes.ts`) is the HTTP edge that parses,
enforces preflight policy, and threads idempotency.

### D2 — Bridge liveness is the live SSE connection, scoped by session (AC1)

A browser bridge becomes _live_ by opening the SSE stream `GET /api/editor/agent/events?sessionId=<id>`;
the registry tracks the live connection count per session. A connection without a `sessionId` is a
global observer that receives events but is not a bridge for any session. The liveness gate runs last
in preflight, after the #1391/#1394 structural gates, so an otherwise-valid action for a session with
no live bridge is answered with a new structured `NO_ACTIVE_BRIDGE` conflict (HTTP 409) rather than
queued where it could never be executed. `NO_ACTIVE_SESSION` (no snapshot registered at all) remains
the distinct earlier gate. The browser bridge passes its `sessionId` on the SSE URL; the existing
client-side session filter is retained as defense in depth.

### D3 — A bounded, self-healing action queue with deadlines (AC2)

Each queued action is admitted to a bounded per-session queue and armed with a timeout. If the bridge
never reports a result before `EDITOR_AGENT_ACTION_TIMEOUT_MS`, the action is failed with the new
structured lifecycle code `TIMED_OUT`, a result event is fanned out, and the queue slot is reclaimed —
so a silent or disconnected bridge cannot strand the queue. When the bounded depth
(`EDITOR_AGENT_MAX_QUEUED_PER_SESSION`) is already saturated, a further action is rejected with
`QUEUE_FULL` (HTTP 429) backpressure rather than growing the queue without limit. A browser result
correlated to a queued action clears its timeout and frees the slot. `TIMED_OUT` and `QUEUE_FULL` are
_lifecycle failures_ (status `failed`), kept disjoint from the preflight _conflict_ taxonomy; both are
added additively to the contract (`EDITOR_AGENT_FAILURE_CODES`, `EditorAgentActionFailure`,
`isEditorAgentFailureCode`).

### D4 — Existing security gates are reused, not relaxed (AC3, AC4)

CSRF / same-origin protection is the centralized BFF guard in `server.ts`: every state-changing method
requires `Content-Type: application/json` and the `X-Keiko-CSRF: 1` header, and the loopback
`Host`/`Origin` check rejects non-local authorities. The mutating agent routes (snapshot, actions)
inherit this unchanged; the new server-level security tests assert it directly. Workspace containment
of an agent-supplied target file (AC4) reuses the Issue #1394 `OUT_OF_SCOPE` gate
(`isContainedAgentPath` + `validatePatch`); no new containment code or conflict code is introduced for
it. No raw source content (snapshot text, text edits, patch bodies) is logged anywhere on this path.

### D5 — Bounded event fan-out (performance)

A session-scoped event reaches only the global observers plus that session's own bridge connections,
never every bridge, so action fan-out is bounded by a single session's audience. The queue depth is
bounded per session (D3). No long-term session state is persisted, and remote multi-user collaborative
sessions and model invocation remain out of scope.

## Consequences

- The contract leaf gains one preflight conflict code (`NO_ACTIVE_BRIDGE`) and a small lifecycle-failure
  taxonomy (`TIMED_OUT`, `QUEUE_FULL`), all additive and schema-version-compatible (`"1"`).
- The BFF route module delegates all mutable control-plane state to `agentSessionRegistry.ts`; the
  #1391/#1394 preflight policy and applyPatch derivation are preserved unchanged in behaviour.
- The browser bridge SSE URL carries its `sessionId`; this is the only keiko-ui change.
- Tests: registry unit tests (liveness, queue lifecycle, timeout/cleanup, bounded queue, scoped
  fan-out), route integration tests (the eight server scenarios), security tests at the real HTTP
  boundary (CSRF, host, containment), and a no-raw-source-in-logs guard.

Documented in [`docs/editor-agent-session-registry.md`](../editor-agent-session-registry.md).
