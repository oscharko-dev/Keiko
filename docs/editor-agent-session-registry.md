# Agent editor session registry, action queue, and SSE events

The agent editor control plane lets agents discover live editor sessions and queue actions for a
connected browser bridge, without the server ever mutating editor state. It is owned by Issue #1392
(Epic #1491) and builds on the public contract from
[`docs/editor-agent-contracts.md`](./editor-agent-contracts.md). The governing decision record is
[ADR-0060](./adr/ADR-0060-agent-editor-session-registry-and-queue.md).

The runtime is split between the HTTP edge
([`agentRoutes.ts`](../packages/keiko-server/src/editor/agentRoutes.ts)) and the in-memory control-plane
registry ([`agentSessionRegistry.ts`](../packages/keiko-server/src/editor/agentSessionRegistry.ts)). The
server **coordinates**; the browser bridge (the keiko-ui editor runtime) **owns** live editor mutation.

## Routes

| Method | Path                         | Purpose                                                        |
| ------ | ---------------------------- | -------------------------------------------------------------- |
| GET    | `/api/editor/agent/sessions` | List the registered session snapshots.                         |
| POST   | `/api/editor/agent/snapshot` | Register a bridge snapshot, or read a (text-bounded) snapshot. |
| POST   | `/api/editor/agent/actions`  | Queue an action, or report a browser action result.            |
| GET    | `/api/editor/agent/events`   | Subscribe to the SSE event stream (session / action / result). |

The two mutating routes (`snapshot`, `actions`) are state-changing, so they inherit the centralized BFF
CSRF / same-origin guard: a JSON content type, the `X-Keiko-CSRF: 1` header, and a loopback
`Host`/`Origin` are all required.

## Bridge liveness

A browser bridge becomes **live** by opening the SSE stream with its session id:

```
GET /api/editor/agent/events?sessionId=<sessionId>
```

The registry tracks the live connection count per session. A connection without a `sessionId` is a
global **observer** — it receives events but does not count as a bridge. Queueing an action for a
session with no live bridge is answered with a structured `NO_ACTIVE_BRIDGE` conflict (HTTP 409),
distinct from `NO_ACTIVE_SESSION` (no snapshot registered at all). Event fan-out is scoped: a
session-scoped event reaches only the global observers plus that session's own bridge connections.

## Action queue lifecycle

A queued action is admitted to a bounded per-session queue (`EDITOR_AGENT_MAX_QUEUED_PER_SESSION`) and
armed with a deadline (`EDITOR_AGENT_ACTION_TIMEOUT_MS`):

- **Queued** — the action is accepted (HTTP 202) and broadcast to the session's bridge as an `action`
  event. For `applyPatch`, the contract `textEdits` are derived (whole-document replace) so the browser
  reviews a concrete edit.
- **Resolved** — the bridge reports a result on `POST /api/editor/agent/actions`
  (`{ kind: "result", result }`). The result is correlated to the queued action, its timeout is cleared,
  the slot is freed, and a `result` event is fanned out.
- **Timed out** — if no result arrives before the deadline, the action is failed with the structured
  lifecycle code `TIMED_OUT`, a `result` event is fanned out, and the slot is reclaimed (the queue
  self-heals; a silent or disconnected bridge cannot strand it).
- **Rejected** — when the bounded depth is already saturated, a further action is rejected with
  `QUEUE_FULL` (HTTP 429) backpressure.

`TIMED_OUT` and `QUEUE_FULL` are **lifecycle failures** (status `failed`), kept disjoint from the
preflight **conflict** taxonomy (`DIRTY`, `VERSION_MISMATCH`, `CONTENT_HASH_MISMATCH`,
`NO_ACTIVE_SESSION`, `NO_ACTIVE_BRIDGE`, `INVALID_EDITS`, `OUT_OF_SCOPE`, `PRECONDITION_REQUIRED`).

## Safety

- **No editor mutation on the server** — the registry only records, bounds, times out, and fans out.
- **Workspace containment** — an agent-supplied target file that escapes the workspace root is rejected
  with `OUT_OF_SCOPE`, reusing the Issue #1394 containment gate.
- **No raw source content in logs** — snapshot text, text edits, and patch bodies are never logged.
- **No persistence** — session state is in-memory only; long-term persistence, remote multi-user
  collaboration, and model invocation are out of scope.
