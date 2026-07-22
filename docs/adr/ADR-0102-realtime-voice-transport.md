# ADR-0102: Realtime voice transport — re-opened loopback WebSocket control + browser WebRTC media

> Renumbered from ADR-0060 on 2026-07-04 to resolve the 0058-0069 editor/voice numbering collision (Epic #491 voice series moved to 0100-0111).

## Status

Accepted (Issue #497, Epic #491, 2026-06-24)

Amended by [ADR-0154](ADR-0154-canonical-twin-voice-pipeline.md). The proxied-SDP and loopback
WebSocket trust boundaries remain, but Realtime is now input-only: the browser offers exactly
`sendonly`, the provider answer is exactly `recvonly`, and both directions are validated by the BFF.
Realtime receives no assistant instructions, tools, memory, grounding context, persona, or output
voice and is never an assistant-response authority. Canonical chat generates the answer and an
independent, explicitly configured TTS provider may speak that persisted answer.

## Version

0.3.1

## Context

[ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) (D3) and
[ADR-0101](ADR-0101-voice-control-media-capability-replay-protocol.md) (D3) originally established that
"WebSocket is the authoritative control plane" was a **role**, then realized for v1 on the loopback
HTTP + Server-Sent Events seam because the BFF bound `127.0.0.1` and **hard-rejected every WebSocket upgrade**
([`server.ts`](../../packages/keiko-server/src/server.ts)). Both ADRs deferred one decision to the
transport child issue: **whether to re-open a bidirectional WebSocket upgrade on the BFF**, as "an
explicit, ADR-gated change … never smuggled in." This ADR records that decision and the realtime
transport #497 implements against the #496 protocol contract
([`voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts)).

Issue #497 is explicit: its Scope mandates "Use the existing `ws` runtime dependency for local voice
control and signaling," its Deliverables require a "WebSocket control endpoint," and Acceptance
Criterion 6 requires transport state observable "through local WebSocket control events." `ws` is a
WebSocket library and the loopback-HTTP+SSE realization would not use it; the issue therefore selects
the `loopback-websocket` control transport the #496 contract already models
(`VoiceControlTransport = "loopback-http-sse" | "loopback-websocket"`).

## Decision

### D1 — Re-open the BFF WebSocket upgrade, narrowly and capability-gated

> **Current amendment:** ADR-0154 keeps this narrowly gated WebSocket route but changes the
> productive v1 constant to `"loopback-websocket"`. The earlier statement below that the SSE
> baseline constant remained unchanged records the original #497 migration only.

The BFF re-opens the upgrade for the **single loopback path `/api/voice/control`**, and **only** when
the resolved voice capability is the `full-realtime` profile and voice is not disabled by policy
(`isVoiceRealtimeCapable` = `voice.available && voice.transport.webrtcMedia`, mirroring
`isVoiceDictationCapable`). Every other upgrade — any other path, a no-voice / STT-only /
policy-disabled deployment — keeps the **identical hard `HTTP/1.1 404` + `socket.destroy()` default**
that existed before (AC1, AC3). The `ws` `WebSocketServer({ noServer: true })` handles the gated
upgrade; the server binds loopback only, so the control plane is loopback by construction. The #496
contract baseline `VOICE_CONTROL_TRANSPORT_V1 = "loopback-http-sse"` is **not mutated** — each
full-realtime session reports `controlTransport: "loopback-websocket"` in its `session.created`
message, exactly as the contract anticipated a "transport realization detail, not a contract break."

### D2 — Proxied-SDP media negotiation; no long-lived credential reaches the browser (AC2)

> **Current amendment:** the proxied-SDP credential boundary remains. ADR-0154 supersedes the
> assistant-session payload described below: current negotiation carries input transcription and
> response-disabled VAD only, with exact `sendonly`/`recvonly` audio direction. It carries no
> instructions, tools, memory, grounding, persona, output voice, or response authority.

Real-time media uses **native browser WebRTC** (`RTCPeerConnection` / `getUserMedia` /
`RTCDataChannel`, zero npm dependencies). Negotiation uses the contract's preferred **`proxied-sdp`**
mode: the browser creates the SDP offer and sends it over the control plane; the Keiko host performs
the browser↔provider SDP exchange through a new provider-neutral Model Gateway adapter
(`requestRealtimeNegotiation`, posting the opaque offer to the OpenAI-compatible
`/realtime/calls` endpoint via the single `gatewayFetch` egress seam, ADR-0038), and returns the
answer. The long-lived provider credential never leaves the host. The browser therefore holds **no**
credential — neither the long-lived key nor an ephemeral token. The contract's opt-in
`direct-ephemeral` mode (browser holds a short-lived minted token) remains a supported protocol value
but is **not** the default and is **not** wired browser-direct in #497, so no CSP relaxation for
browser-direct provider/STUN/TURN traffic is required.

**Historical #497 assistant-session payload (superseded by ADR-0154):** for standard server API-key
authentication, the adapter originally used the GA unified WebRTC call: one
`multipart/form-data` request carries the `sdp` offer and the complete `session` JSON. Instructions,
voice, input transcription, turn detection, grounding tools, tool posture, current chat context, and
MemoriaViva priming are therefore applied atomically before media starts. For providers configured with
`realtimeAuthMode: "ephemeral-session"`, the host first mints a client secret with the same server-owned
session JSON and then submits the SDP with that short-lived token. Neither path exposes a credential to
the browser.

In that superseded design, the server was the single owner of session persona, tools, memory,
grounding, transcription, and default turn detection. The browser could send a narrow
`session.update` only for an explicitly selected acoustic turn-detection profile. ADR-0154 removes
assistant instructions, tools, memory, and grounding from Realtime entirely; current session updates
can affect input transcription and response-disabled VAD only.

### D3 — Security posture for the re-opened upgrade (ADR-0100 D6)

- **Cross-origin defense.** A WebSocket handshake cannot carry the JSON + `X-Keiko-Csrf` guard, so the
  upgrade reuses the existing loopback `isAllowedHost` check (`host-check.ts`) — it validates the
  `Host` and (when present) `Origin` are loopback on the bound port and **rejects opaque
  `Origin: null`** and any non-loopback origin, giving the upgrade the same strictness as the HTTP path.
- **Secrets never logged.** SDP, including non-trickle ICE candidates, is opaque `secret-bearing` data
  forwarded without content logging and never persisted. The shipped path has no standalone candidate
  relay. Every host→client frame passes the existing BFF redactor before send. The generic protocol
  retains transcript kinds for compatibility, but the productive Twin BFF rejects browser-originated
  `transcript.partial` and `transcript.committed` control frames. Provider finals travel through the
  browser's bounded canonical-Chat queue instead; the BFF replay buffer therefore remains content-free
  and never stores transcript text (ADR-0154).
- **No raw audio on the control plane (AC1).** A binary WebSocket frame is rejected and the socket is
  closed; raw audio rides only the WebRTC media plane and is never persisted.
- **Bounded state, deterministic teardown.** Per-session sequence numbers + idempotency on
  `(sessionId, seq)`; a bounded (≤200) content-free, replay-eligible-only buffer is the local "replay
  diagnostics" record (AC6); a bounded resume window (60 s) lets a reconnect resume by idempotency key. Sessions tear
  down deterministically on `session.close`, socket close (browser close / route change), provider
  failure, and server shutdown; an in-flight negotiation is aborted on cancel/close.

### D4 — Existing strict controls: re-justified, not silently relaxed (ADR-0100 D6)

- **`Permissions-Policy` microphone.** The `microphone=(self)` directive (`headers.ts`) is now scoped to
  deployments that advertise speech-to-text **or** full-realtime voice (`isVoiceDictationCapable ||
  isVoiceRealtimeCapable`), so a realtime-without-STT profile still grants the WebRTC capture track. It
  is **never widened beyond `(self)`**, and a no-voice / policy-disabled deployment keeps the strict
  `microphone=()` default.
- **CSP is unchanged.** The browser opens the control WebSocket **same-origin**
  (`ws(s)://${location.host}/api/voice/control`), which CSP3 `connect-src 'self'` already permits; the
  proxied-SDP design keeps all signaling same-origin, so no `connect-src` / `webrtc` directive change is
  required. `default-src 'none'` and the rest of `csp.ts` are untouched.
- **Supply chain.** No new runtime media package is added; the control plane reuses the existing `ws`
  dependency (repo-wide since the CDP browser tooling; already pinned at `ws` 8.21.1 in `keiko-tools`)
  and the media plane uses browser-native WebRTC. `ws` is now also declared explicitly in
  `keiko-server/package.json` for manifest correctness — this is a declaration of the existing
  dependency on its new consumer, not a new package in the repository. The #496 supply-chain denylist
  test (which does not list `ws`) stays green.

### D5 — No new persisted local-runtime state

The transport persists **no** new on-disk state: the content-free replay buffer is in-memory, bounded,
and ephemeral, and raw audio is never written. ADR-0154 separately routes each final user transcript
through the existing canonical Chat persistence path; this transport never owns a transcript store.
Recap and memory-candidate state remain governed by their owning subsystems and the
`docs/local-runtime-state-contract.md` registry.

## Consequences

- The realtime voice path is a true bidirectional WebSocket control plane using the existing `ws`
  dependency, satisfying the issue's explicit transport requirement, with the WebRTC media plane on
  native browser APIs and no new dependency.
- The re-opened upgrade is a deliberate, reviewed trust-boundary change confined to one loopback path
  behind a capability + policy gate; the deny-by-default upgrade rejection is preserved everywhere else.
  This ADR is the security re-justification the gate (ADR-0100 D6) requires.
- ADR-0101 is promoted to **Accepted**: its protocol is now realized by transport. The contract baseline
  constant is unchanged; `loopback-websocket` is reported per full-realtime session.
- Browser-direct `direct-ephemeral` negotiation and any STUN/TURN CSP relaxation remain **future,
  explicitly-gated** decisions, out of scope for #497.

## References

- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#497](https://github.com/oscharko-dev/Keiko/issues/497).
- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) (D3 transport, D6 security),
  [ADR-0101](ADR-0101-voice-control-media-capability-replay-protocol.md) (the protocol contract).
- [ADR-0038](ADR-0038-outbound-egress.md) (`gatewayFetch` egress),
  [ADR-0046](ADR-0046-local-credential-vault.md) (sealed credentials).
- [`docs/voice/realtime-transport.md`](../voice/realtime-transport.md) — the transport implementation
  notes; [`docs/voice/protocol.md`](../voice/protocol.md) — the normative protocol;
  [`docs/voice/privacy-contract.md`](../voice/privacy-contract.md) — the privacy/security contract.
- Transport: [`packages/keiko-server/src/voice-realtime.ts`](../../packages/keiko-server/src/voice-realtime.ts),
  [`packages/keiko-model-gateway/src/realtime-voice-adapter.ts`](../../packages/keiko-model-gateway/src/realtime-voice-adapter.ts),
  and the keiko-ui `hooks/voice-rtc-transport.ts` / `hooks/voice-realtime-client.ts` /
  `hooks/useRealtimeVoice.ts` client.
