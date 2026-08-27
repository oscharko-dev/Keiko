# ADR-0154: Canonical Twin Voice pipeline and media-only Realtime authority

## Status

Accepted (independent audit of PR #2665, 2026-07-22).

Supersedes [ADR-0096](ADR-0096-voice-dialogue-session-orchestration.md) D2, D3, D7, and D8.
It also supersedes [ADR-0116](ADR-0116-realtime-voice-live-memory-recall.md): Realtime providers no
longer receive memory context or invoke memory tools. The canonical chat pipeline performs MemoriaViva
retrieval and capture for spoken turns instead.

Where [ADR-0094](ADR-0094-voice-provider-capability-registry-extension.md) allowed a Realtime-only
provider to contribute an assistant persona or provider voice id, this decision narrows persona
selection to an explicit speech-output provider.

It also amends the productive integration or proof scope of
[ADR-0095](ADR-0095-voice-assistant-speech-synthesis.md),
[ADR-0103](ADR-0103-voice-timing-engine.md),
[ADR-0104](ADR-0104-voice-turn-manager.md),
[ADR-0105](ADR-0105-voice-transcript-segment-semantics.md),
[ADR-0107](ADR-0107-discussion-intelligence.md),
[ADR-0108](ADR-0108-voice-spoken-action-governance.md),
[ADR-0109](ADR-0109-voice-session-recap.md),
[ADR-0110](ADR-0110-voice-evaluation-harness.md), and
[ADR-0111](ADR-0111-voice-production-readiness-gate.md). Their reusable contracts remain; historical
assumptions that a provider-owned Voice turn bypasses canonical chat, that recap is the primary memory
path, or that the old contract harness alone proves current readiness do not.

## Date

2026-07-22

## Version

0.1.0

## Context

PR #2665 changed Digital Twin Voice from a provider-owned speech-to-speech answer path into an
interface for Keiko's normal chat. The intended invariant is stronger than transport parity:

> Once a spoken user turn has a final transcript, it is the same user message as if the user had
> typed that text into the Composer.

Before that change, the Realtime session could receive assistant instructions, conversation memory,
grounding tools, and an output voice. The browser could forward function calls and consume provider
assistant audio or text. A separate `/api/desktop/chat/voice-turn` route could append a completed
provider answer. Those paths created two answer authorities. The provider path could bypass or drift
from canonical chat persistence, project/workspace/user scopes, MemoriaViva, repository and Knowledge
Pod retrieval, grounding, citations, governance, and diagnostics.

The audit also found that older decisions and current code disagreed. ADR-0096 specified a batch
STT+TTS dialogue fallback and deferred live Realtime transcripts, while the shipped Twin interface now
uses Realtime WebRTC for live capture, VAD, partial transcription, and final transcription. ADR-0116
made the Realtime provider a memory/tool consumer, which conflicts with the single-answer-authority
invariant. Leaving those decisions active would invite the parallel response architecture to return.

The remaining architecture needs three independent capabilities:

1. a Realtime media/transcription deployment for WebRTC input, VAD, and final transcripts;
2. the normal chat model and canonical chat pipeline for every assistant answer; and
3. an explicit speech-output deployment plus persona mapping for optional TTS playback.

No deployment name, model default, or provider voice id is universally compatible across OpenAI,
Azure Foundry, and customer-hosted endpoints. Each required deployment alias and output voice mapping
must therefore be explicit.

## Decision

### D1 — A final Voice transcript enters the one canonical chat pipeline exactly once

Twin Voice delivers a settled final transcript through the same `sendMessage` operation used by the
Composer. It carries the active chat, project, workspace, user, memory, grounding, and selected-model
context without a Voice-specific substitute. The canonical server path owns user-message persistence,
assistant generation, retrieval, citations, MemoriaViva capture, and assistant-message persistence.

Partial transcripts are display-only and never enter chat persistence. A provider item identity is
bounded and deduplicated across recoverable reconnects. A canonical Voice turn identity is also
deduplicated per chat so replayed finals and repeated callbacks cannot create a second turn.

The Realtime owner keeps only the short continuation buffer, then transfers a final turn exactly once
through a synchronous handoff. The canonical Chat session captures the immutable chat/model/memory
target and optimistic user projection during that handoff and owns the bounded FIFO from then on. Its
queue survives Voice mode leave, media replacement, and active-chat changes; Realtime never polls or
retries a turn after transfer. The per-item completion promise is used only to bind canonical TTS to
the matching assistant message.

The browser-side Voice handoff FIFO is not the only concurrency boundary. At the BFF, every canonical
turn runs through one store-bound serializer lane keyed by `chatId`. Buffered desktop sends, SSE desktop
streams, and grounded asks share that lane across routes and concurrent clients. Admission, the prompt
history read, model/retrieval work, and turn settlement therefore complete in order for the same chat, so
a waiting turn cannot assemble from stale history. Separate chat ids keep independent lanes and may execute
in parallel. A request aborted while waiting is removed without entering the protected operation; the lane
is always released after completion or failure.

Canonical Chat delivery has explicit outcomes. `completed` carries the exact persisted
assistant-message identity. `cancelled` records separately whether the canonical user row was
persisted; a persisted cancellation is terminal and never arms speech. `in-progress` means
reconciliation found the scope-bound user turn while its original generation may still be running,
so the Chat-owned queue polls with the same opaque turn identity. `not-sent` remains retryable inside
the queue's finite admission window. `failed` remains fail-visible and is not guessed into success.
Optimistic UI state is not treated as proof of persistence, and a user row alone never proves that an
assistant answer completed.

### D2 — Realtime has media-and-transcription authority only

The Realtime negotiation request may contain only the configured endpoint/authentication, explicit
Realtime and transcription deployment aliases, input transcription options, acoustic or semantic
VAD tuning, a pseudonymous safety identifier, the opaque SDP offer, and bounded transport controls.
The browser control-plane `session.create` contains only transport/profile identifiers plus
`chatContext: {chatId}` for local authority binding. The shared protocol validator in
`packages/keiko-contracts/src/voice-protocol.ts` (`VOICE_SESSION_CREATE_FIELDS`,
`VOICE_SESSION_CHAT_CONTEXT_FIELDS`, `isOptionalSessionChatContext`) allowlists and type-validates
persona, `transcriptionLanguage`, and `chatContext.{chatId, memory, grounding}` — it does **not** by
itself reject their presence. The Twin transport's `resolveSessionChatContext` in
`packages/keiko-server/src/voice-realtime.ts` performs the endpoint-specific rejection: it closes the
WebSocket with `not-allowed-for-profile` when `parsed.transcriptionLanguage` or `parsed.persona` is
present on the Twin endpoint, or when `chatContext` fails `isVoiceSessionChatContext`. Any new consumer
of the shared validator alone therefore does **not** inherit the Twin transport's rejection semantics —
that enforcement is transport-specific by design.

It contains no assistant instructions, tools, tool choice, memory block, grounding context, output
voice, persona, or assistant response configuration. Both server negotiation and browser session
updates force `create_response: false` and `interrupt_response: false`. Caller-provided VAD tuning
cannot override those flags.

The browser WebRTC transport accepts only two outbound data-channel operations:

- a strictly shaped, response-disabled VAD `session.update`; and
- `input_audio_buffer.commit` for transcription finalisation.

It rejects `response.create`, `response.cancel`, tool output, assistant instructions, output voices,
and unknown session mutations. Inbound parsing accepts lifecycle, user speech, partial/final user
transcription, and redacted error events only. Provider-native assistant text, audio, response, and
function-call events are ignored and have no rendering, playback, persistence, or tool bridge.

The generic voice protocol retains transcript control kinds, but the productive Twin loopback
WebSocket rejects client-originated partial and committed transcript frames. Its server replay holds
content-free control only. Provider finals therefore have exactly one continuity path: the short
Realtime continuation buffer followed by synchronous transfer to the Chat-owned queue.

The microphone is negotiated through a `sendonly` audio transceiver. Every local audio media section
must contain exactly one `a=sendonly` attribute, and every answer section exactly one `a=recvonly`.
The BFF validates both the client offer before provider egress and the provider answer before client
egress; the browser repeats the answer check before applying it. Directionless, duplicated,
conflicting, or permissive audio sections fail without reflecting secret-bearing SDP in diagnostics.

Some provider schemas require `output_modalities: ["audio"]` to create a Realtime media session. That
field is a negotiation-schema compatibility artifact, not assistant authority: Keiko registers no
remote-output consumer and never requests a response.

### D3 — Assistant speech is explicit TTS, never a Realtime voice

The visible canonical assistant message is the sole source for optional speech playback. TTS starts
only after the corresponding canonical send completes and only while the same chat remains active.
Grounding and citation metadata stay attached to the visible answer; speech-safe projection affects
only synthesis input and never rewrites persisted or rendered content.

`supportsRealtimeVoice` does not imply `supportsSpeechOutput`. Realtime-only providers contribute no
assistant personas and no provider voice ids. Persona resolution considers only providers that
explicitly advertise `supportsSpeechOutput` and carry a configured server-side persona mapping.

Twin Voice is offered only when all of the following resolve fail-closed:

- a reachable Realtime WebRTC transport;
- an explicit compatible live-transcription deployment alias;
- browser support for the approved WebRTC capture posture;
- a reachable explicit speech-output provider; and
- at least one persona mapped to that speech-output provider.

Batch STT remains Composer dictation or push-to-talk assistance. It is not a second, supposedly
equivalent Voice Dialogue transport fallback. A Realtime-only deployment may support live transcript
capture but must never report `speaks: true`.

No default transcription deployment or output voice is inherited when a deployment changes. An
unchanged existing provider-specific value may be preserved by an unrelated update; selecting a new
Realtime or TTS deployment requires an explicit compatible value.

### D4 — Turn settlement, reconnect, interruption, and cleanup are deterministic

Final transcription is settled after the configured continuation window so natural pauses do not end
a turn prematurely. Continuation fragments are bounded and joined once. Matching normalizes only the
comparison token to NFC with locale-independent case folding; output retains the original transcript.
Multi-token overlap is accepted generally, while one-token overlap is limited to distinctive numbers,
identifiers, and clearly capitalized names. Every Realtime-owned timer, waiter, media track,
data-channel callback, and negotiation controller is owned by the active session identity and is
cancelled on disconnect, replacement, mode change, or unmount. The Chat-owned FIFO described in D1 is
deliberately outside that teardown boundary. A stale peer-connection callback cannot close or mutate its
replacement. A recoverable socket detach retains the same session/idempotency binding; deliberate
stop and protocol violations are terminal, discard server replay state, and cannot be resumed.

Recoverable reconnect preserves final-item deduplication. Explicit stop, terminal transport failure,
and unmount flush an already provider-final continuation exactly once, then discard partial-only
session buffers. Once that synchronous handoff completes, teardown cannot delete or rewrite the
Chat-owned item. Provider-controlled identifiers, transcript deltas, continuation state, queue item
count, queued bytes, and replay records are numerically bounded. Canonical queue items are immutable
and processed FIFO. A reconciled `in-progress` turn is polled by the Chat owner only to a small finite
ceiling with its same scope-bound identity; a cancellation with a persisted user row is terminal and
bypasses that poll.

Barge-in stops the local canonical TTS playback and returns the floor to input capture. It does not
cancel or start a provider assistant response. An unrelated assistant message, a late answer from a
previous chat, or a failed/cancelled send cannot arm speech playback.

### D5 — Retrieval, memory, grounding, and citations have no Voice branch

Knowledge Pods, repository search, local knowledge, MemoriaViva, grounding, source selection, line
ranges, multi-source synthesis, timeout handling, and citation rendering run after the final
transcript through the existing canonical chat layers. Equal final text plus equal chat context must
therefore make the same retrieval decisions whether the text originated from typing or speech.

Realtime receives none of those bodies. This removes a provider prompt-injection surface and keeps
evidence and diagnostics body-free. Spoken facts reach MemoriaViva because the canonical user message
is persisted and processed, not because Realtime receives a second memory tool.

### D6 — Parallel answer routes and tool bridges are removed

The following routes are not part of the product and must remain unregistered:

- `POST /api/desktop/chat/voice-turn`;
- `POST /api/voice/realtime/grounded-tool`; and
- `POST /api/voice/realtime/memory-tool`.

Their client functions, server handlers, provider tool definitions, response append logic, and tests
of positive availability are deleted. Route tests assert absence. There is one persistence path and
one assistant-answer path, so an idempotency or redaction fix cannot land on only one of two copies.

### D7 — Verification is layered and live-microphone evidence stays honest

Hermetic tests cover transcript settlement, pause continuation, cumulative bounds, final
deduplication, collision-resistant turn identities, stale reconnect callbacks, bounded readiness and
reconnect, Chat-owned FIFO reconciliation across teardown and chat switching, TTS admission,
transport allowlisting, response-disabled VAD, capability/persona separation, route absence, and
provider-output event rejection. Server tests additionally cover store-bound same-chat exclusion across
buffered, SSE, and grounded routes, FIFO order for concurrent clients, parallel execution for different
chats, cancelled waiters, and lane release after failure. The default serializer registry is structurally
keyed by `UiStore`, so independent stores cannot share a lane. Browser smoke covers a provider final entering
normal chat and a canonical answer driving TTS without the removed routes.

A real microphone/voice check remains a separate manual test because it depends on the agreed speaker
and office conditions. Automated or synthetic results must never be reported as that live test.

## Consequences

- Typed and spoken turns share one governed retrieval, memory, persistence, and citation path.
- Every canonical BFF route observes fresh, ordered same-chat history without globally serializing
  unrelated chats or independent stores.
- Realtime provider compromise or schema drift cannot directly create an assistant answer or invoke a
  Keiko retrieval/memory tool.
- Voice Dialogue now requires explicit Realtime transcription and explicit TTS configuration. This is
  more setup than a provider-native speech-to-speech session but makes compatibility and authority
  honest.
- A Realtime deployment without TTS can still support transcript capture where surfaced, but it cannot
  claim a spoken Twin.
- TTS begins after the canonical answer completes, so response latency includes the governed chat
  pipeline. That cost is accepted in exchange for retrieval, memory, citation, and persistence parity.
- Older positive tests and documentation for provider tools, Realtime personas, or Voice-specific
  append routes are invalid and must not be used as release evidence.

## Alternatives considered

### Keep provider-native assistant audio and reconcile it later

Rejected. Reconciliation cannot make two independently generated answers identical or retroactively
apply canonical retrieval, governance, citations, memory capture, and persistence to provider audio.

### Let Realtime invoke canonical retrieval and memory tools

Rejected. It still grants the provider an independent assistant/tool loop and duplicates orchestration
already owned by canonical chat. Passing the final transcript to chat is smaller and strictly stronger.

### Preserve the batch STT+TTS dialogue fallback

Rejected for Twin Voice. Batch STT remains useful Composer dictation, but presenting it as equivalent
dialogue would create a second capture/settlement lifecycle and weaken the Realtime/VAD turn-taking
contract. Twin availability fails closed when its Realtime prerequisites are absent.

### Infer universal model and voice defaults

Rejected. Deployment aliases and valid voice ids are provider- and resource-specific. A convenient
default can silently select a nonexistent or incompatible paid deployment.

## Related decisions

- [ADR-0095](ADR-0095-voice-assistant-speech-synthesis.md) remains the TTS playback boundary.
- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) remains the optional,
  capability-gated Voice foundation.
- [ADR-0101](ADR-0101-voice-control-media-capability-replay-protocol.md) remains the bounded control
  and replay contract where it does not grant provider assistant authority.
- [ADR-0102](ADR-0102-realtime-voice-transport.md) remains the proxied-SDP/WebRTC transport decision.
- [ADR-0104](ADR-0104-voice-turn-manager.md) remains the floor-control and cleanup state machine.
