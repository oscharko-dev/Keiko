# ADR-0115: Realtime voice live memory recall — mid-session `recall_keiko_memory` tool, session priming, and spaced reinforcement

## Status

Accepted (MemoriaViva conversational-memory milestone)

## Version

0.1.0

## Context

Before this change the realtime voice stack (Epic #491, ADR-0100..0111) injected MemoriaViva memory
into a session in exactly ONE place: `buildRealtimeInstructions` in
[`packages/keiko-server/src/voice-realtime.ts`](../../packages/keiko-server/src/voice-realtime.ts)
baked a memory block into the session instructions at negotiation time, keyed on the LATEST user
message (`latestRealtimeMemoryQuery`). Two gaps followed:

1. **No mid-session recall.** The memory block is assembled once, at session start. When a spoken
   conversation moves to a topic the session-start block did not cover, the assistant had no way to
   reach back into long-term memory — the opposite of how a colleague pauses to remember something
   relevant later in a conversation.
2. **A fresh session with no prior user message got no memory at all.** `resolveRealtimeMemoryRuntime`
   returned `null` when there was no latest user message, so opening a voice session on a new chat
   surfaced nothing Keiko already knows about the user. The chat title was deliberately never used as
   a query substitute (it would be a misleading lexical signal), leaving priming unaddressed.

The grounded voice tool (`search_keiko_grounding`, `voice-realtime-grounded-tool.ts`) already
establishes the pattern for a provider-invoked, BFF-resolved realtime function tool. This ADR mirrors
that pattern for long-term memory.

## Decision

### D1 — A mid-session `recall_keiko_memory` realtime function tool

A second realtime function tool, `recall_keiko_memory`, is advertised to the provider whenever the
session has MemoriaViva enabled AND the negotiated provider supports tool calling
(`shouldIncludeRealtimeMemory(deps, chatContext) && realtimeProviderSupportsTools(...)`). The provider
calls it with a short retrieval CUE describing what to remember; the browser forwards the call to a
new additive BFF route `POST /api/voice/realtime/memory-tool`
([`voice-realtime-memory-tool.ts`](../../packages/keiko-server/src/voice-realtime-memory-tool.ts)),
which retrieves and returns a content-safe spoken instruction plus the recalled block.

Unlike the grounded tool, memory recall **persists nothing to the chat**: a recall is an internal
remembering act, not a visible question/answer turn. Its only side effects are the vault access
counters (reinforcement-on-recall) and the `memory:retrieved` audit event, both inside the shared
retrieval core (D3). On an empty recall the tool instructs the assistant to say it does not remember
and, when it matters, to ASK the user — never to invent a memory (the follow-up-question behaviour the
dialogue mode is built around).

### D2 — Session priming: query-less recall for a fresh session

`resolveRealtimeMemoryRuntime` no longer bails when there is no latest user message. Instead the
retrieval runs QUERY-LESS: it ranks on the non-lexical signals (pinned, reinforcement strength,
recency, provenance confidence, source importance) with no query embedding egress. The chat title is
still never used as a query. This lets a voice session opened on a fresh chat greet the user with what
Keiko durably knows, exactly as a colleague would.

### D3 — One shared retrieval core, so the two surfaces cannot drift

Both the session-start block and the mid-session tool call ONE exported core,
`recallRealtimeMemoryBlock(deps, chatId, { queryText?, budgetTokens? })`. Ranking signals
(`buildConversationRetrievalSignals`), the RRF fusion mode, reinforcement recording, and the retrieval
audit live in that single function, so priming and mid-session recall can never diverge in how they
rank or reinforce. A live cue is embedded (semantic recall participates); a query-less priming recall
is not.

### D4 — Spaced reinforcement damping (human-memory spacing principle)

Massed repetition inside one conversational episode is ONE encoding event, not many. A voice session's
instructions can be rebuilt several times in quick succession (reconnects, renegotiations,
mid-session recalls) with the same effective cue; without damping every rebuild would bump the same
memories' access counters and inflate reinforcement strength without a genuinely new recall. A
per-`(chatId, memoryId)` damper suppresses re-reinforcement inside a 10-minute window (bounded to
4096 entries, oldest-half eviction). A genuinely new recall of the same memory in a DIFFERENT chat
still reinforces, and a later real session strengthens again. The retrieval AUDIT is never damped —
every retrieval event stays visible to governance.

### D5 — Tool posture

Session tools are advertised via a single `realtimeSessionTools(groundingToolEnabled, memoryToolEnabled)`
helper. Grounding-only preserves the pre-memory posture byte-for-byte (the grounding tool is pinned so
the provider consults sources before answering). As soon as the memory recall tool joins, `tool_choice`
widens to `"auto"`: pinning would force every response through one tool, and memory recall is a
judgement call the instructions license, not a mandate. The system instructions gain a memory addendum
(`REALTIME_MEMORY_VOICE_ADDENDUM`) that instructs the model to recall when the user refers to earlier
conversations/preferences/decisions, to treat recalled memory as untrusted reference data, and to ask
rather than guess on ambiguity.

## Consequences

### Positive

- A spoken dialogue can reach back into long-term memory at any point, and a fresh session opens
  already primed with what Keiko knows — the conversational "working memory" the milestone targets.
- Reinforcement now reflects genuine recall episodes rather than session mechanics (spacing principle),
  so a memory's access-driven strength is not inflated by reconnects.
- Zero drift between priming and mid-session recall (single core); zero new chat-persistence surface
  (the tool writes nothing to the chat).

### Negative / Neutral

- The memory tool is only offered when the provider supports tool calling; providers without it keep
  the session-start block only (graceful degradation, unchanged posture).
- The damper is process-local (one loopback server = one damper), consistent with the existing
  auto-maintenance cursor; it is not shared across processes.

## Related

- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) — voice capability architecture.
- [ADR-0102](ADR-0102-realtime-voice-transport.md) — realtime transport and control plane.
- [ADR-0109](ADR-0109-voice-session-recap.md) — the capture-side sibling (voice → proposed memories).
- Epic [#204] MemoriaViva governed memory vault; retrieval reinforcement (`strength.ts`) and
  maintenance (`maintenance.ts`).

## Date

2026-07-07
