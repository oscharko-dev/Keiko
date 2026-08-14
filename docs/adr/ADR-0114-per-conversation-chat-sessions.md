# ADR-0114: Per-conversation chat sessions for concurrent chat windows

## Status

Accepted and implemented (2026-08-14).

## Context

The desktop canvas originally supported exactly one chat window. `WindowsRegistry` pinned
`chat` as `singleton: true`, and `workspaceActions.add()` replaced the existing window's
conversation when a second chat was opened. The guard existed because all window hosts consumed
one application-wide session:

- `AppShell` calls `useChatSession()` exactly once and shares the instance app-wide
  through `ChatSessionProvider`. The hook owns ONE `sendControllerRef`, ONE
  `streamingAssistantMessage`, ONE `messages` array, and ONE `activeChat` slot.
- Issue #152 pinned the invariant "opening a different chat must abort any in-flight
  send so a late response from the prior chat never lands here" — correct for one shared
  slot, and exactly what makes a second concurrent conversation impossible.
- `ChatWindowSessionHost` (widgets/index.tsx) races every mounted chat-typed window to
  claim the global `activeChat`; with two differently-bound hosts this would ping-pong
  aborts, which is why the registry forbids the second window in the first place.

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
2. **D2 — Global shell session.** `AppShell` retains one application session for catalog, project,
   history, and shell consumers. Nested window providers shadow it for all ChatWindow descendants.
   A window never claims or mutates another window's `activeChat` slot.
3. **D3 — Issue #152 becomes per-conversation.** "Switching this WINDOW to a different
   conversation aborts THAT conversation's in-flight send" — never a sibling window's.
   The late-response guard moves from the global `activeChatIdRef` into each
   conversation entry (responses land keyed by `chatId`, so a settled response can only
   ever land in its own conversation).
4. **D4 — Window binding and restoration.** `chat` is not a singleton. The per-`chatId` dedupe in
   `workspaceActions.add()` stays: opening the same conversation focuses its existing window, while
   a different conversation creates a collision-safe window identity. Durable window state keeps
   `chatId`, the owning project path for ordinary history/new-chat flows, and an explicit memory
   preference. Restoration loads the owning project before the conversation and never silently
   retargets a missing binding to a sibling chat. Privacy-preserving editor handoffs continue to
   omit their originating path from window configuration.
5. **D5 — Server posture is unchanged.** GEN-PERF-CHATSTREAM-001 remains the concurrency
   governance: above the cap, sends degrade per-conversation to the buffered path (already
   wired client-side). No wire, schema, or persistence change is required; memory actions
   and grounded answers already ride per-`chatId` requests.
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
8. **D8 — Resource governance.** Open windows are not capped by an arbitrary UI count. Active
   concurrent streams remain governed by GEN-PERF-CHATSTREAM-001 (default 16, hard cap 64), with
   the existing buffered-request degradation. Idle/open windows do not consume stream slots.

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
