# ADR-0114: Per-conversation chat sessions for concurrent chat windows

## Status

Proposed (multi-chat epic — issue breakdown drafted alongside this ADR, 2026-07-07).

## Context

The desktop canvas supports exactly ONE chat window. `WindowsRegistry` pins the `chat`
window type as `singleton: true`, and `workspaceActions.add()` enforces it by reusing and
focusing the existing window instead of creating a second one. The singleton is not a UX
preference — it is a load-bearing guard for the session architecture underneath:

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

Replace the single shared chat session with **per-conversation session state keyed by
`chatId`, plus one thin global catalog** — one conversation per window, N windows.

1. **D1 — Conversation state container.** Extract everything conversation-scoped out of
   `useChatSession` into a module-level conversation store keyed by `chatId`: `messages`,
   `streamingAssistantMessage`, `sendStatus` + send `AbortController`, `draft`,
   `pendingAttachments`, `error`, `regeneratingMessageId`, `latestGrounded`,
   `latestMemory`, `lastSentDocuments`. Windows subscribe via a `useChatConversation(chatId)`
   hook (external store + selective subscription, the `sharedEventSource` precedent) so a
   token flush in conversation A never renders conversation B. Conversation entries are
   created on first bind and disposed (send aborted, state dropped) when the last window
   unbinds — bounded by the open-window cap (D4).
2. **D2 — The catalog stays global and thin.** Projects, chats, models, `loading`,
   `noEligibleModels`, and catalog actions remain one shared slice (the existing
   `ChatSessionCatalog`). The global `activeChat` DATA slot is retired; "focused
   conversation" becomes a pure UI concept (window focus) with no data-access authority.
3. **D3 — Issue #152 becomes per-conversation.** "Switching this WINDOW to a different
   conversation aborts THAT conversation's in-flight send" — never a sibling window's.
   The late-response guard moves from the global `activeChatIdRef` into each
   conversation entry (responses land keyed by `chatId`, so a settled response can only
   ever land in its own conversation).
4. **D4 — Window binding.** `chat` loses `singleton: true`. The per-`chatId` dedupe in
   `workspaceActions.add()` STAYS: exactly one window per conversation (a second open on
   the same chat focuses the existing window — split-composer on one conversation is
   explicitly out of scope for v1). A UI-side open-chat-window cap of 8 (comfortably
   under the server bulkhead's 16) fails closed with a visible notice instead of
   degrading resource behavior silently.
5. **D5 — Server posture is unchanged.** GEN-PERF-CHATSTREAM-001 remains the concurrency
   governance: above the cap, sends degrade per-conversation to the buffered path (already
   wired client-side). No wire, schema, or persistence change is required; memory actions
   and grounded answers already ride per-`chatId` requests.
6. **D6 — Voice stays a process-wide singleton.** Exactly one active voice dialogue
   across all chat windows (one microphone, one realtime session), bound to the
   conversation it was started in; other windows render a "voice busy elsewhere"
   affordance instead of a second mic. Dictation/playback affordances stay per-window but
   gate on the same global session.
7. **D7 — Background windows are fully live.** Every open chat window streams and renders
   independently — that IS the feature. The render-cost groundwork already exists
   (GEN-PERF-CHAT-014 settled/streaming slices, GEN-PERF-CHAT-015 turn containment,
   GEN-PERF-SSE-001 batching); minimized windows keep their streams (an answer is never
   lost by minimizing) and surface an unread indicator on restore (UX child issue).
8. **D8 — Migration is slice-wise, no feature flag.** First land the pure extraction
   (D1) with the singleton still in place and byte-equal behavior (regression suite over
   the existing ChatWindow/session tests), then per-conversation lifecycle (D3), then the
   singleton removal (D4). Persisted workspaces restore unchanged (`cfg.chatId` is
   already the anchor).

## Consequences

- Positive: concurrent conversations become a first-class canvas capability; the
  strangler-style extraction finally decomposes the 2200-line `useChatSession` hook into
  catalog + conversation units with their own tests; the composer/panel memo work from
  GEN-PERF-CHAT-014 applies per window unchanged.
- Costs/risks: per-open-conversation memory (bounded by the window cap, the message
  fetch dedupe, and the existing turn-windowing); parallel token spend becomes a user
  choice (bounded by the bulkhead + buffered degradation); the D1 refactor is the risk
  concentration — it must ship behavior-neutral behind the existing test suite before any
  visible product change; AppShell surfaces that assumed "the one chat" (Files↔Chat
  binding, footer status, chat history highlighting) need explicit multi-window review.
- Explicitly out of scope for v1: two windows on the SAME conversation, cross-window
  drag of a running stream, and any change to the voice singleton.

## Delivery plan

Epic + six children (issue bodies drafted with this ADR; sequence is strict):
1. Extract the per-conversation state container (behavior-neutral, singleton intact).
2. Conversation-keyed send/stream/abort lifecycle (#152 per conversation).
3. Window binding: drop the chat singleton, keep per-chatId dedupe, add the open-window
   cap, rework `ChatWindowSessionHost` to bind-without-claiming.
4. Catalog & chrome integration: chat history "open in new window", footer/rails,
   title sync, focused-conversation UI.
5. Voice, grounded answers, and memory under multi-session (voice global gate).
6. E2E + evidence: two-parallel-streams smoke, bulkhead 429→buffered e2e, workspace-perf
   scenario with two streaming chat windows, docs/troubleshooting entry.
