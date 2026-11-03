# ADR-0114: Per-conversation chat sessions for concurrent chat windows

## Status

Accepted and implemented (2026-08-14).

## Context

The desktop canvas originally supported exactly one chat window. `WindowsRegistry` pinned
`chat` as `singleton: true`, and `workspaceActions.add()` replaced the existing window's
conversation when a second chat was opened. Before this decision, all window hosts consumed one
application-wide session:

- `AppShell` called `useChatSession()` once and shared that instance with every chat window through
  `ChatSessionProvider`. Conversation selection, messages, streaming state, and cancellation were
  therefore mutable state in the same shared instance.
- Issue #152 pinned the invariant "opening a different chat must abort any in-flight
  send so a late response from the prior chat never lands here" — correct for one shared
  slot, and exactly what makes a second concurrent conversation impossible.
- Every mounted `ChatWindowSessionHost` would have competed to retarget that shared session; two
  differently bound hosts would have caused ping-pong aborts, which is why the registry previously
  forbade the second window.

Users ask for several conversations side by side — the canvas product promise ("open
many windows, many streams") already holds for agent runs, terminals, and containers,
and chat is the visible exception.

### Existing surfaces inspected (reuse, not rebuild)

- `context/ChatSessionContext.tsx` already slices the session into **actions**,
  **catalog** (projects/chats/models/activeChat — GEN-PERF-CHAT-002), **activity**, and,
  since GEN-PERF-CHAT-014, a dedicated **streaming** slice plus a settled composer slice
  (`useChatSessionComposer`). The catalog slice is precisely the "thin shared catalog"
  this ADR keeps global; the streaming slice demonstrates the per-concern subscription
  discipline the per-conversation store needs.
- `packages/keiko-server/src/chat-stream-handlers.ts` (GEN-PERF-CHATSTREAM-001) already
  bulkheads concurrent chat SSE streams (default 16, env `KEIKO_CHAT_MAX_ACTIVE_STREAMS`,
  hard cap 64) and rejects with a JSON 429 BEFORE any SSE header; the client maps that to
  `StreamingUnavailableError` and transparently degrades to the buffered
  `/api/desktop/chat` path. The server side is therefore N-stream-capable today; chat
  persistence (`store.createMessage`/`listMessages`) is already keyed by `chatId`.
- `lib/api.ts` `sharedFetchChatMessages` already dedupes message fetches per `chatId`;
  module-level shared stores with subscription/ref-count discipline exist as precedent
  (`sharedEventSource.ts`, `useSSE.ts` subscriber registry).
- Window↔chat binding already rides `cfg.chatId` (persisted), with a per-chatId dedupe in
  `workspaceActions.add()` (open-again focuses the existing window).
- Voice: `useRealtimeVoice` and the composer voice affordances hold process-exclusive
  resources (microphone, one realtime session) inside the single composer instance.

## Decision

Use **one isolated chat-session instance per mounted chat window**, while retaining the existing
application session for global catalog and shell consumers — one conversation per window, N
windows.

1. **D1 — Conversation state ownership.** Every `ChatWindowSessionHost` mounts its own
   `useChatSession({ autoCreate: false })` and nested `ChatSessionProvider`. Messages, streaming
   assistant deltas, send status and abort controller, draft, attachments, errors, grounded and
   retrieval results, and latest memory therefore belong to that window instance. Unmounting a
   window aborts and disposes only that instance. Cold bootstrap requests and chat-mutation
   notifications remain shared and ref-counted, avoiding N identical network bootstraps while
   preserving per-window mutable state.
   A shared window's accepted creation identity also reaches the server. The existing private
   UiStore atomically binds that opaque identity and project to one conversation (schema 46),
   so independent browser coordinators and delivery retries cannot create duplicate conversations.
   Retries retain the accepted identity; an explicit new conversation receives a new identity.
   Legacy unbound windows use their stable window identity. Changed creation parameters conflict,
   while an omitted model remains an automatic choice independent of later default election.
   Project aliases resolve through the existing read-only workspace root/manifest index to the
   original registered project path before durable replay and accepted persistence. Filesystem
   canonical spelling alone does not replace that stored project identity. A denied fresh request
   does not register or update a project. Existing project names survive alias-based creation.
   A registered requested path and its mapped stored path must still resolve to their recorded root
   reference. Chat and project registration share this read-only check. Missing or retargeted stored
   aliases fail closed with `PROJECT_IDENTITY_CHANGED` before replay or project mutation and require
   explicit reconnect; they cannot redirect a new conversation to another physical root. This coherence
   check grants no governed root authority and does not require a durable-object identity for
   ordinary model-only chat. Existing creation-intent and workspace-root denial events record closed
   refusal reasons under the request correlation.
   V15 intentionally leaves older projects without workspace membership. Ordinary Chat preserves
   their exact existing lexical project identity, including when another registered root reaches
   the same directory; it neither redirects their history nor creates membership or trust. Explicit
   project registration retains its existing canonical registration and metadata migration behavior.
   Recovery returns the originally accepted conversation before current model admission. After an
   asynchronous readiness join, it rechecks durable acceptance and parameter conflicts before new
   model admission; a concurrent acceptance does not become a new request. Genuinely new requests
   still require the unchanged model guards. An explicit model remains part of the intent,
   and deletion retains a tombstone rather than resurrecting a conversation. This identity grants
   no browser session, project access or draft authority. The existing Activity Log records only
   the closed creation decision, completeness and loss state under the request correlation.
   Pending window snapshots preserve the same closed, secret-checked creation reference across
   independently connected browsers. Generating a persistable reference uses bounded secure
   draws; exhaustion fails before window creation and records a body-free client diagnostic.
   The same pending snapshot retains the originating automatic/explicit model choice. Independent
   hosts forward that choice through the existing creation owner; local catalog changes cannot
   change its meaning. A new incomplete or unsafe snapshot stays visibly blocked, with no legacy
   election fallback. Accepted bindings clear pending identity and selection together. Legacy calls
   retain their local readiness refusal; captured requests use the existing backend replay before
   fresh admission, which retains its original model and authority checks.
   Unsent text is additionally saved per `chatId` in the existing private UiStore (schema 44),
   through authenticated draft reads and revision-checked writes. Reload restores only that
   conversation's text; a conversation switch does not erase another conversation's saved draft.
   Concurrent tabs cannot overwrite a newer draft without resolving the stale revision. Browser
   storage and diagnostic evidence never contain draft text. Unconfirmed writes and transient
   attachments retain an unload warning instead of claiming durable recovery. Hidden-page and
   pagehide events additionally flush pending drafts; bounded save requests use fetch keepalive
   so an admitted write can finish across page teardown. Oversized drafts retain ordinary transport
   and the warning. This is best-effort transport, not a guarantee after forced termination, a
   pending revision conflict, or unavailable storage. Closing or cutting a
   chat window waits for private draft acknowledgement and refuses unresolved conflicts or staged
   attachments. A final synchronous readiness check preserves edits made during asynchronous
   connection teardown; acknowledged unbinds still remove their corresponding visible connections.
   The existing window-local draft mutation revision also identifies Composer acknowledgements.
   Published native edits carry their returned revision through the settled session slice; a new
   external revision can therefore clear the same empty string even when React never rendered the
   intermediate native text. An exact local acknowledgement preserves newer native input, while
   an older acknowledgement cannot replace a newer revision. Conversation replacement resets that
   binding. This transient revision is separate from the server's persisted compare-and-set revision
   and carries no draft text into evidence or browser storage. External resynchronization uses the
   existing body-free Composer activity event.
2. **D2 — Global shell session.** `AppShell` retains one application session for catalog, project,
   history, and shell consumers. Nested window providers shadow it for all ChatWindow descendants.
   A window never claims or mutates another window's active conversation state.
3. **D3 — Issue #152 becomes per-conversation.** "Switching this WINDOW to a different
   conversation aborts THAT conversation's in-flight send" — never a sibling window's.
   Each window session owns its late-response guard (responses land keyed by `chatId`, so a settled
   response can only ever land in its own conversation).
4. **D4 — Window binding and restoration.** `chat` is not a singleton. The per-`chatId` dedupe in
   `workspaceActions.add()` stays: opening the same conversation focuses its existing window, while
   a different conversation creates a collision-safe window identity. Durable window state keeps
   `chatId`, the owning project path for ordinary history/new-chat flows, and an explicit memory
   preference. Restoration loads the owning project before the conversation and never silently
   retargets a missing binding to a sibling chat. Privacy-preserving editor handoffs continue to
   omit their originating path from window configuration.
5. **D5 — Server posture is unchanged.** GEN-PERF-CHATSTREAM-001 remains the concurrency
   governance: above the cap, sends degrade per-conversation to the buffered path (already
   wired client-side). Memory actions and grounded answers already ride per-`chatId` requests.
   The draft repair adds only a private, chat-bound text record and its monotonic revision to the
   existing UiStore; it does not admit a turn or alter the model request. Clearing a sent draft
   keeps its revision tombstone so stale clients cannot resurrect the previous text.
6. **D6 — Voice stays a process-wide singleton.** Exactly one active voice dialogue
   across all chat windows (one microphone, one realtime session), bound to the
   conversation it was started in; other windows render a "voice busy elsewhere"
   affordance instead of a second mic. Dictation/playback affordances stay per-window but
   gate on the same global session.
7. **D7 — Background windows and memory are independent.** Every open chat window streams and renders
   independently — that IS the feature. The render-cost groundwork already exists
   (GEN-PERF-CHAT-014 settled/streaming slices, GEN-PERF-CHAT-015 turn containment,
   GEN-PERF-SSE-001 batching). Memory inclusion and token budget are keyed by `chatId`; the
   MemoriaViva switch in each chat controls only that conversation. The product-wide memory
   autonomy mode remains global and monotonic, so a window cannot widen governance authority.
8. **D8 — Resource governance.** Chats have no smaller, chat-specific UI quota: the existing global
   workspace limit of 128 windows is enforced consistently by live allocation, local persistence,
   and the BFF snapshot boundary. Active concurrent streams remain governed by
   GEN-PERF-CHATSTREAM-001 (default 16, hard cap 64), with the existing buffered-request degradation.
   Idle/open windows do not consume stream slots.

## Consequences

- Positive: concurrent conversations are a first-class canvas capability. State and cancellation
  are isolated by component lifetime, the shared bootstrap avoids redundant cold-start traffic,
  and the composer/panel memo work from GEN-PERF-CHAT-014 applies per window unchanged.
- Costs/risks: per-open-conversation client memory (bounded by open windows, message-fetch dedupe,
  and existing turn-windowing); parallel token spend becomes a user
  choice (bounded by the bulkhead + buffered degradation); the D1 refactor is the risk
  concentration and is protected by the relocated GEN-PERF-CHAT-001 regression; shell surfaces
  continue to use the global catalog rather than any arbitrary window session.
- Explicitly out of scope for v1: two windows on the SAME conversation, cross-window
  drag of a running stream, and any change to the voice singleton.

## Verification

The implementation is pinned at four ownership boundaries: distinct conversations create distinct
collision-safe windows; opening the same `chatId` focuses instead of duplicating; persisted layouts
retain multiple chats plus their project and memory preference; and mounted hosts receive distinct
session providers. Memory-store tests additionally prove that inclusion/budget changes do not cross
chat IDs while autonomy-mode changes still propagate globally.
