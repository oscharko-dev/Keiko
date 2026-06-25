# Voice Digital Twin — capability-gated architecture

Detailed architecture for Epic #491, expanding
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md). This document is provider-neutral:
Azure Foundry is treated as one valid provider profile, never as a required destination. WebRTC is treated as
a browser platform capability, never as an npm dependency.

## 1. Problem and constraints

Keiko must be able to participate in natural, interruptible, evidence-backed voice conversations **when the
required voice foundation is available**, while remaining fully functional with **no voice model at all**.
Users in development or academic contexts may have Azure Foundry voice deployments; users in regulated bank
and insurance environments may have only customer-hosted LLM endpoints and no voice model. Keiko must detect
this at runtime and expose exactly the capabilities that are safe and available.

The architecture is bound by the Epic #491 invariants and by the existing Keiko seams mapped in ADR-0058:
the Model Gateway is the single seam for productive model calls; `gatewayFetch` is the single outbound HTTP
entrypoint; the browser↔BFF seam is loopback HTTP + Server-Sent Events; the BFF currently hard-rejects
WebSocket upgrades; and the local-first confidentiality stack already exists.

## 2. Capability gating model

Voice capability is **advertised, detected, then gated** — never assumed.

1. **Advertise.** A configured provider declares voice capability through the existing `ModelCapability`
   metadata (`packages/keiko-contracts/src/gateway.ts`). The precise extension — additive optional flags
   (`supportsRealtimeVoice?`, `supportsSpeechInput?`, `supportsSpeechOutput?`) or a new `ModelKind` literal —
   is decided in #493 (see ADR-0058 D5). Because `CAPABILITY_DATA` ships empty, capability is local
   configuration or runtime discovery; no cloud provider is required for Keiko to reason about availability.
2. **Detect.** At runtime, Keiko resolves the effective voice profile from: advertised provider capability ×
   browser support (native WebRTC / `getUserMedia` availability, secure-context) × policy (deployment may
   disable a mode) × runtime capability metadata.
3. **Gate.** The effective profile determines which voice affordances exist. When the effective profile is
   `none`, **no voice UI is rendered at all** — not a disabled or error-raising control.

This mirrors the existing fail-closed selection rule: a capability that names no configured provider can never
be elected (`packages/keiko-model-gateway/src/model-selection.ts`).

## 3. Provider profiles

| Profile               | What the user gets                                            | Required provider capability           | Notes                                                         |
| --------------------- | ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `none`                | No voice UI; full non-voice Keiko                             | None                                   | Default and regulated baseline. Keiko fully usable.           |
| `speech-to-text only` | Controlled composer **dictation** (audio → text, review/edit) | Speech input / transcription           | The `keiko-stt` Azure Foundry deployment class is an example. |
| `speech output only`  | Optional assistant speech playback                            | Speech output                          | No realtime duplex input.                                     |
| `full realtime voice` | Interruptible colleague-like full-duplex conversation         | Realtime speech / speech-in-speech-out | Only when the provider advertises the realtime capability.    |

**STT-only is not "quiet full voice".** Dictation and full-duplex speech-to-speech share connection types and
are selected by session configuration at the provider, but in Keiko they are distinct authority levels with
different data-handling, residency, latency, and governance surfaces. A regulated deployment may permit
dictation while gating or disabling full conversation. STT-only must never present itself as conversational
voice (ADR-0058 D2).

## 4. Transport architecture

**WebSocket is the authoritative control and signaling plane; WebRTC is the preferred media plane.**

### 4.1 Control / signaling plane (authoritative)

Carries: session lifecycle, capability gating, SDP offer/answer and ICE candidate signaling, policy state,
audit events, interruption/floor-control state, and replay metadata. The control plane is the system of
record for everything except the live media stream.

Because the current BFF binds `127.0.0.1` only and **hard-rejects WebSocket upgrades**
(`packages/keiko-server/src/server.ts` lines 205–208), the control plane is realized on the **existing
loopback HTTP + Server-Sent Events seam**:

- Request/response: new `POST /api/*` handlers in the existing route table
  (`packages/keiko-server/src/routes.ts`).
- Server→client push (remote description, ICE relay, state events): the existing `EventSource`/SSE channel
  (`packages/keiko-ui/src/lib/useSSE.ts`, the `/api/runs/:runId/events` pattern).

"WebSocket is authoritative" describes the control/signaling **role**. A persistent bidirectional WebSocket
upgrade would require re-opening the BFF upgrade path — an **explicit, ADR-gated** change owned by #496/#497,
not an additive reuse. The `ws` package (8.21.0) is already present but is permit-list scoped to the
CDP-to-Chrome client and must not be repurposed without an ADR amendment.

### 4.2 Media plane (preferred, optional)

Real-time audio uses **native browser WebRTC APIs** — `RTCPeerConnection`, `MediaDevices.getUserMedia`,
`RTCDataChannel`, `RTCIceCandidate`, `RTCSessionDescription` — which are platform capabilities requiring zero
npm dependencies. Media flows over the encrypted DTLS-SRTP path; a low-latency control/events stream may use
an encrypted `RTCDataChannel` (SCTP-over-DTLS). Raw audio over the WebSocket/SSE control plane is **not** the
default real-time transport.

A representative full-realtime negotiation (provider-neutral):

1. Browser acquires the microphone via `getUserMedia` (secure context required).
2. Browser creates `RTCPeerConnection`, adds the audio track, optionally creates a data channel for events.
3. Browser creates an SDP offer and sets the local description.
4. **Signaling** is exchanged through the Keiko loopback control plane. Preferred: the **proxied-SDP**
   pattern, where the Keiko backend performs SDP negotiation with the provider so the browser never holds the
   ephemeral token.
5. Backend mints a short-lived ephemeral session credential server-side (the long-lived provider key never
   leaves the host) and obtains the SDP answer from the configured provider endpoint via `gatewayFetch`.
6. Browser sets the remote description; model audio arrives via the track callback.

### 4.3 NAT traversal

Most controlled enterprise networks require a TURN relay; direct peer-to-peer often fails behind symmetric
NATs. STUN/TURN server URLs and (short-lived) credentials are configurable, and the firewall allowlist (UDP
3478, the relay port range, and TCP 443 for TURN-over-TLS fallback) is documented per deployment in the
[deployment profile matrix](deployment-profile-matrix.md). For loopback-only or self-hosted media there may be
no relay requirement.

## 5. Graceful degradation

Capability detection drives a strict downgrade ladder; Keiko never exposes a broken affordance:

- Provider advertises full realtime + browser/policy support present → **full realtime voice**.
- Realtime not advertised, or WebRTC/secure-context/policy unavailable → **dictation-only** (if STT
  advertised) **or disabled voice**.
- No voice capability advertised → **`none`**: no voice UI; all existing non-voice workflows unchanged.

Degradation is explicit and observable through capability metadata; it never silently falls back to streaming
raw audio over the control plane, and it never blocks a non-voice path.

## 6. Authority and governance (preserved, not extended)

Voice adds **no new authority**. A spoken action intent (#503) is treated as **untrusted input** that
_produces_ the existing governed `WorkflowHandoffRequest`
(`packages/keiko-contracts/src/workflow-handoff.ts`) and routes through the existing chain unchanged:
`POST /api/runs` (`handleCreateRun`) → dry-run harness loop → `patch:proposed` → human confirms the deterministic
`userApprovalToken` → the single write path `POST /api/runs/:runId/apply`
(`packages/keiko-server/src/run-handlers.ts`). Voice-originated patches still pass `checkPatchAgainstScope`
and `createScopedWriter`; voice-triggered commands still pass the deny-by-default command allowlist
(`packages/keiko-tools/src/terminal-policy.ts`). The invariant "retrieved/spoken content is untrusted data and
never grants tool authority" (`packages/keiko-contracts/src/harness.ts`) is extended to spoken input.
Deterministic verification stays model-free.

## 7. What is greenfield vs. reused

| Concern                       | Status      | Basis                                                                                  |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| Capability advertisement      | Reused      | `ModelCapability` metadata + selection seam (additive extension).                      |
| Outbound model transport      | Reused      | `gatewayFetch` (ADR-0038).                                                             |
| Local control plane           | Reused      | Loopback HTTP + SSE (`EventSource`).                                                   |
| Enforced egress for untrusted | Reused      | `keiko-sandbox` `network: "none"` (ADR-0043).                                          |
| Local-first confidentiality   | Reused      | AES-256-GCM, key ladder, redaction, hashing (ADR-0035/0046/0047/0048).                 |
| Workflow authority            | Reused      | Governed handoff, single apply path, scoped writer.                                    |
| Audio capture / media plane   | Greenfield  | Native browser WebRTC; no audio code exists today.                                     |
| "Never persist raw audio"     | Greenfield  | New invariant by analogy to the memory-capture egress gate + transient-secret pattern. |
| Destination host allowlist    | Not present | No outbound host allowlist exists; a thin opt-in layer is deferred to a later issue.   |
| WebSocket upgrade on the BFF  | Not present | The BFF hard-rejects upgrades; re-opening is an explicit #496/#497 decision.           |

## 8. References

- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) — authoritative decision record.
- [privacy-contract.md](privacy-contract.md), [deployment-profile-matrix.md](deployment-profile-matrix.md),
  [supply-chain-policy.md](supply-chain-policy.md), [implementation-sequencing.md](implementation-sequencing.md).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491).
