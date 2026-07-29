# Voice Digital Twin — realtime transport (WebSocket control + browser WebRTC media)

Implementation notes for Epic #491, the deliverable of Issue
[#497](https://github.com/oscharko-dev/Keiko/issues/497) and the transport that realizes the #496
protocol ([protocol.md](protocol.md), [ADR-0101](../adr/ADR-0101-voice-control-media-capability-replay-protocol.md)).
The load-bearing decisions are in [ADR-0102](../adr/ADR-0102-realtime-voice-transport.md); this document
describes the realized transport. It is **optional and capability-gated**: a no-voice or STT-only
deployment runs none of it.

## 1. Two planes

| Plane                   | Realization (#497)                                                                         | npm cost    |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| **Control / signaling** | A bidirectional WebSocket on the loopback path `/api/voice/control` (`loopback-websocket`) | none (`ws`) |
| **Media**               | Native browser WebRTC (`RTCPeerConnection` / `getUserMedia` / `RTCDataChannel`, DTLS-SRTP) | none        |

The control plane carries the admitted #496 lifecycle and signaling messages; raw audio is **never** a
control message (a binary frame is rejected and the socket closed). Microphone media flows browser →
provider over a send-only WebRTC audio transceiver. Provider audio is neither negotiated nor consumed.

## 2. The re-opened WebSocket upgrade (server)

The BFF previously hard-rejected **every** WebSocket upgrade. Issue #497 re-opens it for the **single**
path `/api/voice/control`, and only when the deployment is full-realtime capable:

1. `server.on("upgrade")` calls the voice control plane's `handleUpgrade`. It accepts only when the
   path is `/api/voice/control`, `isAllowedHost(req, port)` passes (loopback `Host`/`Origin`; opaque
   `Origin: null` and non-loopback are rejected), and `isVoiceRealtimeCapable(deps)` is true.
2. Any other path / host / capability falls through to the **unchanged** `HTTP/1.1 404` +
   `socket.destroy()` default.

A WebSocket handshake cannot carry the JSON + `X-Keiko-Csrf` guard, so the loopback `Host`/`Origin`
check plus the capability gate are the load-bearing cross-origin defenses (ADR-0102 D3).

## 3. Session lifecycle and proxied-SDP handshake

```
client                                   BFF (/api/voice/control)            provider (via gatewayFetch)
  │  ── session.create (proxied-sdp) ──▶  │
  │  ◀── session.created (loopback-       │   controlTransport=loopback-websocket
  │       websocket, webrtc) ───────────  │   mediaTransport=webrtc
  │  ◀── capability.offer ─────────────── │
  │  ── signal.sdp.offer (SDP) ────────▶  │
  │                                        │  ── POST /realtime/calls ───────────────────▶
  │                                        │     multipart: sdp + server session
  │                                        │  ◀── SDP answer ────────────────────────────
  │  ◀── media.track.state (negotiating)  │
  │  ◀── signal.sdp.answer (SDP) ───────  │
  │  ◀── media.track.state (audio-in live) │
  │  ═════ WebRTC microphone media (DTLS-SRTP), browser ──▶ provider ═════
```

- A `session.create` whose `negotiationMode` is inconsistent with the effective profile's canonical
  mode (`VOICE_PROFILE_NEGOTIATION_MODE`) is rejected before session allocation.
- Twin `session.create` is exact-key validated and carries only the canonical `chatId` beyond
  transport/profile identity. Persona, memory, grounding, history, arbitrary legacy fields, and the
  live-dictation-only language hint are rejected before session allocation.
- The host performs the SDP exchange (`requestRealtimeNegotiation`); the browser never holds the
  provider credential (AC2). A negotiation failure returns `error` code `negotiation-failed`.
- Before provider egress, the BFF requires exactly one `a=sendonly` direction in every client audio
  section. Before client egress, it requires exactly one `a=recvonly` direction in every provider
  answer section. Directionless, permissive, duplicate, conflicting, oversized, or malformed SDP
  fails with a content-free code; the secret-bearing SDP is never reflected in diagnostics.
- Standard-key providers receive the SDP and the media/VAD/final-transcription session configuration
  atomically as GA multipart form data. Ephemeral-session providers receive the same input-only
  configuration when the host mints the short-lived secret, followed by the raw SDP call. Neither path
  configures assistant instructions, tools, output voice, or native response generation.
- Live dictation uses that realtime WebRTC contract in both authentication modes: provider session
  `type` is `realtime`, `turn_detection` is `null`, and the input-transcription object contains only
  the configured deployment alias plus an optional language hint. It never mixes the dedicated
  transcription-session `delay` field into `/realtime/calls` or `/realtime/client_secrets`; the
  browser explicitly commits the captured input buffer.
- A failed live-dictation negotiation emits one body-free operator diagnostic and returns the same
  bounded correlation id with the stable `negotiation-failed` control code. The composer localizes
  that failure class and shows the support id; provider bodies, endpoints, credentials, SDP, audio,
  and transcript text remain server-side-secret or never-persisted.
- Per-direction monotonic `seq` + idempotency on `(sessionId, seq)`; a re-sent `session.create` with
  the same `idempotencyKey` resumes the detached session and replays the bounded `replayable` buffer
  rather than creating a duplicate (protocol §7). The key remains bound to its original session,
  profile, and chat; a conflicting binding or a concurrent second socket fails closed. Only an
  abnormal transport detach is resumable: explicit close and protocol-violation sessions are terminal
  and their replay state is discarded.

## 4. The browser client

- `hooks/voice-rtc-transport.ts` — the injectable native-WebRTC seam: `getUserMedia` →
  `RTCPeerConnection` → add the microphone with `direction: "sendonly"` plus the data channel → create
  offer → wait for ICE gathering to **complete** (non-trickle) → verify every audio section remains
  send-only. `applyAnswer` accepts only provider `recvonly` audio sections before setting the remote
  description. A browser or answer that cannot preserve this input-only posture fails closed. `close()`
  stops the mic track (clears the OS recording indicator) and closes the peer.
- `hooks/voice-realtime-client.ts` — the injectable WebSocket control client. Opens the WS
  **same-origin** (`ws(s)://${location.host}/api/voice/control`), runs the handshake, resolves with the
  answer SDP. Recovery closes only the socket and preserves its session/idempotency identity; a
  deliberate stop, mode leave, or teardown first sends sequenced `session.close`, preventing terminal
  sessions from occupying the bounded resume registry.
- `hooks/useRealtimeVoice.ts` — the `idle → requesting → negotiating → connected` state machine, the
  Realtime data-channel parser bridge, committed-transcript handoff to canonical chat, local barge-in
  signaling, and deterministic teardown. Its outbound data-channel allowlist admits only transcription
  commit and response-disabled VAD updates. Provider response, cancellation, tool, instruction, and
  output-audio commands are rejected.
- The composer no longer renders a separate **Start realtime voice** button. The **Voice dialogue mode**
  switch starts this Realtime session only when Realtime capture, independent speech output, an
  explicitly mapped persona, and `realtimeVoiceTransportSupported()` (including send-only transceivers)
  are all true. A Realtime-only, no-voice, STT-only, or STT+TTS-without-WebRTC deployment renders no
  dialogue switch.

## 5. Security and privacy (ADR-0102 D3/D4, privacy-contract §2/§4)

- **No long-lived credential reaches the browser** (proxied-SDP).
- **SDP, including non-trickle ICE candidates, is opaque `secret-bearing` data** — forwarded without
  content logging and never persisted. The shipped path has no standalone candidate relay. Every
  host→client frame passes the BFF redactor. The productive control socket rejects client-originated
  partial and committed transcript frames, so its bounded replay buffer contains no customer text.
- **No raw audio is persisted**, and raw audio never rides the control plane.
- **`Permissions-Policy` microphone** is scoped to STT-or-realtime deployments, never widened past
  `(self)`. **CSP is unchanged** — the same-origin WebSocket is covered by `connect-src 'self'`.
- **No new runtime media package** — the control plane reuses `ws`; the media plane is browser-native.

## 6. State boundary

The transport persists **no raw audio** and keeps its content-free control replay buffer in memory,
bounded, and ephemeral. Provider finals arrive only through the browser RTCDataChannel, are held for
the short continuation window, and are then handed to the ordinary desktop-chat send path. That single
path persists the user message and runs the normal memory, retrieval, grounding, citation, assistant,
and persistence pipeline. Realtime never returns an assistant transcript turn.

## 7. References

- [ADR-0102](../adr/ADR-0102-realtime-voice-transport.md) — the transport decision record.
- [protocol.md](protocol.md), [ADR-0101](../adr/ADR-0101-voice-control-media-capability-replay-protocol.md)
  — the protocol contract; [privacy-contract.md](privacy-contract.md) — privacy/security;
  [deployment-profile-matrix.md](deployment-profile-matrix.md) — provider/environment profiles.
- Transport code: `packages/keiko-server/src/voice-realtime.ts`,
  `packages/keiko-model-gateway/src/realtime-voice-adapter.ts`, and the keiko-ui
  `hooks/voice-rtc-transport.ts` / `hooks/voice-realtime-client.ts` / `hooks/useRealtimeVoice.ts` /
  `VoiceDialogMode.tsx` / `ChatWindow.tsx` client path.
