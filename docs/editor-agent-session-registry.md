# Agent editor session registry, action queue, and SSE events

The agent editor control plane lets agents discover live editor sessions and queue actions for a
connected browser bridge. The browser owns live Monaco state; for `applyChangeset`, the server owns
the governed atomic disk transaction and the browser reconciles affected open buffers afterward. It
is owned by Issue #1392 (Epic #1491) and builds on the public contract from
[`docs/editor-agent-contracts.md`](./editor-agent-contracts.md). The governing decision record is
[ADR-0060](./adr/ADR-0060-agent-editor-session-registry-and-queue.md), as amended by
[ADR-0125](./adr/ADR-0125-governed-agent-docking-and-editor-changesets.md).

The runtime is split between the HTTP edge
([`agentRoutes.ts`](../packages/keiko-server/src/editor/agentRoutes.ts)) and the in-memory control-plane
registry ([`agentSessionRegistry.ts`](../packages/keiko-server/src/editor/agentSessionRegistry.ts)). The
server coordinates authority, preflight, queueing, terminal confirmation, and atomic changeset disk
mutation; the browser bridge owns active-buffer/Monaco mutation, review UI, and reconciliation.

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
GET /api/editor/agent/events?sessionId=<sessionId>&bridgeStreamId=<pageStreamId>&bridgeDecisionCapability=<memoryOnlyCapability>
```

Initial snapshot registration issues the random decision capability; the browser keeps it only in
module memory and presents it for snapshot refresh, result posting, and the exact session-scoped SSE
subscription. The server retains only its digest and scrubs the capability and stream id from request
and diagnostic URLs after authentication. Reconnecting the same page stream atomically supersedes
its previous liveness contribution. A connection without authenticated session/capability pairs is a
global **observer** and does not count as a bridge. Queueing an action for a session with no live
bridge is answered with `NO_ACTIVE_BRIDGE` (HTTP 409), distinct from `NO_ACTIVE_SESSION`. Event fan-out
is scoped to global body-free observers and the action's authenticated session bridge.

## Action queue lifecycle

A queued action is admitted to a bounded per-session queue (`EDITOR_AGENT_MAX_QUEUED_PER_SESSION`) and
armed with a deadline (`EDITOR_AGENT_ACTION_TIMEOUT_MS`):

- **Queued** — the action is accepted (HTTP 202) and broadcast to the session's bridge as an `action`
  event. For patch and changeset actions, `requiresReview: true` opens the existing review path;
  `false` permits direct confirmation/application under the resolved mode policy; omission retains
  legacy review behavior.
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
`NO_ACTIVE_SESSION`, `NO_ACTIVE_BRIDGE`, `INVALID_EDITS`, `OUT_OF_SCOPE`, `PRECONDITION_REQUIRED`,
`POLICY_DENIED`, `APPROVAL_REQUIRED`).

## Safety

- **Split mutation ownership** — the registry itself only records, bounds, times out, and fans out.
  The browser owns Monaco state. A validated `applyChangeset` commits through one server-owned atomic
  workspace transaction, followed by browser reconciliation.
- **Workspace containment** — an agent-supplied target file that escapes the workspace root is rejected
  with `OUT_OF_SCOPE`, reusing the Issue #1394 containment gate.
- **No raw source content in logs** — snapshot text, text edits, and patch bodies are never logged.
- **No persistence** — session state is in-memory only; long-term persistence, remote multi-user
  collaboration, and model invocation are out of scope.
