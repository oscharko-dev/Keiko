# ADR-0058: Capability-gated Voice Digital Twin architecture, privacy contract, and supply-chain policy

## Status

Proposed (Issue #492, Epic #491, 2026-06-24)

## Version

0.2.0

## Context

Epic #491 introduces an optional **Voice Digital Twin**: a capability-gated interaction layer that lets a user
speak with Keiko like a colleague when the required voice foundation is available, while preserving full
non-voice Keiko functionality when it is not. Keiko is a regulated enterprise coding agent for banking and
insurance engineering workflows; voice must not weaken the product's local-first posture, its deterministic
verification, the Model Gateway seam, or workflow authority.

This decision is the architecture baseline that the remaining child issues (#493–#506) reference. It is
**design and governance only**: it adds no runtime code, deploys no models, and adds no dependencies. Issue
#492 produces this ADR plus the detailed contracts under [`docs/voice/`](../voice/README.md).

A full read-only mapping of the current repository establishes the starting point — the entire voice surface
is **greenfield**:

- **No voice implementation code exists.** There is no `getUserMedia`, `MediaRecorder`, `AudioContext`,
  `RTCPeerConnection`, `SpeechRecognition`, or `navigator.mediaDevices` usage anywhere in `packages/*/src`,
  and no STT/TTS/ASR integration. The UI already carries a placeholder capability gate
  `VOICE_SUPPORTED = false`
  ([`ChatWindow.tsx`](../../packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx) lines 70–72, with the
  voice button omitted) that explicitly anticipates this epic's AC1. The only other `voice`/`whisper` string
  hits are a microphone-denying CSP directive in
  [`headers.ts`](../../packages/keiko-server/src/headers.ts), a prose prompt string in
  [`generator.ts`](../../packages/keiko-model-gateway/src/promptEnhancer/generator.ts), and CSS comments.
  Every "transcript" in the tree is the evaluation harness's scripted-model log, unrelated to speech.
- **The Model Gateway is the single seam for productive model calls.** `ModelCapability`
  ([`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) lines 43–80) is the capability registry
  entry; its modality discriminant `ModelKind` is `"chat" | "embedding" | "ocr-vision"` (line 15) — there is
  no audio/voice/realtime member today. The gateway barrel
  ([`index.ts`](../../packages/keiko-model-gateway/src/index.ts)) deliberately keeps adapters, HTTP
  transport, and normalization off the public surface "so productive calls cannot bypass Gateway routing".
- **`gatewayFetch` is the single outbound HTTP entrypoint.**
  [`http.ts`](../../packages/keiko-model-gateway/src/http.ts) (`gatewayFetch`, line 733), governed by
  [ADR-0038](ADR-0038-outbound-egress.md), hardens _how_ egress happens (proxy, custom-CA, timeouts, 10 MB
  cap, coded errors). It has no destination allowlist; reachability is bounded by _which providers are
  configured_ and `validateBaseUrl` scheme/credential hygiene
  ([`config.ts`](../../packages/keiko-model-gateway/src/config.ts) lines 441–464).
- **Deny-by-default network isolation is OS-enforced.** [ADR-0043](ADR-0043-enforced-execution-isolation.md)
  and `keiko-sandbox` enforce `network: "none"` for untrusted code with a CI-proven egress test; the single
  spawn boundary is [`exec.ts`](../../packages/keiko-tools/src/exec.ts) `runCommand`.
- **Local-first confidentiality already has a complete, ADR-governed stack.** AES-256-GCM
  ([`secretbox.ts`](../../packages/keiko-security/src/secretbox.ts)), the env → OS-keychain → `0600`-keyfile
  key ladder ([`secret-vault.ts`](../../packages/keiko-security/src/secret-vault.ts)), boundary redaction
  ([`redaction.ts`](../../packages/keiko-security/src/redaction.ts)), two-layer compaction-evidence redaction
  with hashed identifiers ([`compaction-evidence.ts`](../../packages/keiko-evidence/src/compaction-evidence.ts)),
  the memory-candidate egress gate ([`capture-safety.ts`](../../packages/keiko-memory-capture/src/capture-safety.ts)),
  and the four/five confidentiality controls of [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md),
  [ADR-0046](ADR-0046-local-credential-vault.md), [ADR-0047](ADR-0047-local-knowledge-content-encryption.md),
  [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md), and
  [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md).
- **Workflow authority is explicit and dry-run-first.** The harness loop owns control flow; a model response
  is never executed as an instruction; `allowsTools`/`allowsPatch` are fixed by task type, not by input
  contents; the only write path is `POST /api/runs/:runId/apply`
  ([`run-handlers.ts`](../../packages/keiko-server/src/run-handlers.ts) lines 514–545), gated by a
  deterministic `userApprovalToken`
  ([`governed-workflow.ts`](../../packages/keiko-server/src/governed-workflow.ts) lines 107–122) and
  `checkPatchAgainstScope` ([`workflow-handoff.ts`](../../packages/keiko-contracts/src/workflow-handoff.ts)).
- **The browser↔BFF seam is loopback HTTP + Server-Sent Events.** The BFF is plain `node:http` bound to
  `127.0.0.1` and **hard-rejects every WebSocket upgrade**
  ([`server.ts`](../../packages/keiko-server/src/server.ts) lines 205–208); streaming uses `EventSource`
  ([`useSSE.ts`](../../packages/keiko-ui/src/lib/useSSE.ts) line 53). The `ws` dependency (8.21.0) is present
  only for the CDP-to-Chrome client ([`cdp-client.ts`](../../packages/keiko-tools/src/browser/cdp-client.ts))
  and is permit-list scoped to that client (decision ADR-0017, recorded in `cdp-client.ts`; ADR-0017 is an
  internal code-level decision with no standalone `docs/adr/` file).

## Decision

We adopt a **capability-gated, local-first, provider-neutral** Voice Digital Twin architecture. The full
design lives in [`docs/voice/`](../voice/README.md); this ADR records the load-bearing decisions.

### D1 — Voice is optional and capability-gated; Keiko is fully usable with no voice model (AC1)

Keiko **must start and remain fully usable when no voice model is configured, is unreachable, is disabled by
policy, or is unsupported by the active provider.** Voice is an additive capability layer, never a startup or
runtime dependency for chat, workflows, memory, repository context, evidence, or the editor. When no voice
capability is advertised, Keiko exposes **no voice affordances at all** (not a disabled, broken, or
error-raising control) and every existing non-voice path is byte-for-byte unchanged. This mirrors the
existing fail-closed posture: a capability that names no configured provider can never be elected
([`model-selection.ts`](../../packages/keiko-model-gateway/src/model-selection.ts) lines 86–111).

### D2 — Four provider profiles; STT-only dictation is distinct from full realtime conversation (AC2)

The architecture defines four mutually ordered provider profiles, gated by advertised capability:

1. **`none`** — no voice capability advertised; no voice UI; the default and the regulated baseline.
2. **`speech-to-text only`** — controlled composer **dictation** only (audio in → text into the composer for
   review/edit/discard/send). The `keiko-stt` Azure Foundry deployment class is an example of this profile in
   development contexts. It does **not** advertise or imply colleague-like conversation.
3. **`speech output only`** — optional assistant speech playback without realtime duplex input.
4. **`full realtime voice`** — interruptible, colleague-like, full-duplex conversation, available **only**
   when the active provider advertises the required realtime speech / speech-in-speech-out capability.

The STT-only and full-realtime modes are **architecturally distinct authority levels**, not the same feature
at different volumes: as the realtime provider research confirms, dictation versus full-duplex
speech-to-speech is selected by session configuration, but in Keiko they carry different data-handling,
residency, latency, and governance surfaces, and a regulated deployment may permit dictation while gating or
disabling full conversation. STT-only must never present itself as full voice conversation.

### D3 — WebSocket is the authoritative control/signaling plane; WebRTC is the preferred media plane (AC3)

**WebSocket is the authoritative local control and signaling plane** for session lifecycle, capability
gating, SDP/ICE signaling, policy state, audit events, interruption state, and replay metadata — a _role_ that
is realized today on the existing loopback HTTP + Server-Sent Events seam (see the paragraph below), because
the BFF does not currently accept WebSocket upgrades. **WebRTC is the preferred media and optional data plane**
for real-time audio, used only when supported by browser, policy, provider, and runtime capability metadata.
Raw audio over the control plane is not the default real-time transport. When WebRTC is unavailable, the system gracefully degrades to dictation-only or disabled voice;
it never silently downgrades to streaming raw audio over the control plane.

Because the current BFF binds loopback-only and hard-rejects WebSocket upgrades
([`server.ts`](../../packages/keiko-server/src/server.ts) lines 205–208), the **local control plane is
realized on the existing loopback HTTP + Server-Sent Events seam** (request/response over `POST /api/*`,
server→client push over the existing `EventSource` channel). "WebSocket is authoritative" describes the
control/signaling _role_ — local control rides the existing HTTP+SSE seam, and any future re-introduction of
a bidirectional WebSocket upgrade is an explicit, ADR-gated change to be raised by the transport child issue
(#496/#497), never smuggled in. The browser-side media path uses **native browser WebRTC APIs**
(`RTCPeerConnection`, `getUserMedia`, `RTCDataChannel`) which are platform capabilities requiring zero npm
dependencies. See [`docs/voice/architecture.md`](../voice/architecture.md).

**Defined by #496:** the versioned control/media protocol contract — the WebSocket control / signaling
message catalog, the WebRTC media-plane descriptor, the capability-gating and fallback state table, and
the replay / reconnect / redaction semantics — is specified in
[ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) and
[`docs/voice/protocol.md`](../voice/protocol.md), with the typed contract in
[`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts).
The protocol keeps the v1 control transport on loopback HTTP + SSE; re-opening the WebSocket upgrade
remains the explicit, ADR-gated decision owned by the transport child issue (#497).

### D4 — Local-first data boundary: no external destinations except explicitly configured model endpoints (AC4)

Audio buffers, transcripts, voice session state, memory candidates, recap artifacts, policy decisions, and
audit metadata **remain local to the Keiko host** unless the active voice capability explicitly invokes a
configured model endpoint for that capability. Voice mode introduces **no external destinations except
explicitly configured model endpoints selected through runtime capability metadata.**

This is realized by reusing existing seams rather than inventing new ones:

- Voice model traffic routes through `gatewayFetch` ([ADR-0038](ADR-0038-outbound-egress.md)) so it inherits
  corporate-proxy, custom-CA, timeout, and byte-cap behavior.
- Which endpoints are reachable is bounded by the **provider-config + capability-selection** seam: only
  configured-provider base URLs are ever fetched, and only configured _and_ capable models are electable
  (`assertConfiguredModel`, `selectConfiguredModel`,
  [`model-selection.ts`](../../packages/keiko-model-gateway/src/model-selection.ts) lines 57–111). This is
  exactly AC4's "explicitly configured model endpoints selected by runtime capability metadata".
- Untrusted/model-generated code executed for a voice flow must request `network: "none"` to inherit the
  OS-enforced egress boundary ([ADR-0043](ADR-0043-enforced-execution-isolation.md)).

**Honest limitation.** The Model Gateway has **no positive destination host allowlist today** — `gatewayFetch`
will fetch any configured base URL, and `validateBaseUrl` intentionally does not restrict host/IP because
private/self-hosted endpoints are first-class targets
([`config.ts`](../../packages/keiko-model-gateway/src/config.ts) lines 441–464). If a deployment requires
positively _denying_ all non-model destinations (not merely bounding which models are electable), that is a
thin, opt-in allowlist layer that **does not exist yet** and must be added by a later child issue as an
egress policy at the `gatewayFetch` boundary, without breaking private endpoints. This ADR does not claim an
allowlist that is not present. The privacy contract records this precisely.

### D5 — The Model Gateway advertises voice capability without requiring a cloud provider (gateway seam)

Voice capability is advertised through the **existing** `ModelCapability` metadata, with zero new runtime
dependencies, using one of the two proven extension mechanisms (Epics #761, #1210, Issue #810 precedents):

- **Additive optional flags** on `ModelCapability` (for example `supportsRealtimeVoice?`,
  `supportsSpeechInput?`, `supportsSpeechOutput?`), parsed in `providerCapabilityFlags`, added to the closed
  `MODEL_CAPABILITY_KNOWN_KEYS` allowlist, with chat-only invariants enforced exactly as
  `supportsInfilling`/`infillingAlignment` are. Per the contract comment, additive optional flags do **not**
  bump `CONVERSATION_CAPABILITY_CONTRACT_VERSION` (currently `2`).
- **Or a new `ModelKind` literal** (for example `"realtime"`), which is a _structural_ change that bumps the
  contract version and trips the fail-closed `INELIGIBILITY_REASON_BY_KIND` exhaustiveness gate
  ([`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) lines 276–281), forcing explicit
  classification.

The precise mechanism (flags vs. new kind) is delegated to the capability-metadata child issue (#493). Either
way, capability is local configuration / runtime discovery — `CAPABILITY_DATA` ships empty
([`capabilities.data.ts`](../../packages/keiko-model-gateway/src/capabilities.data.ts) line 8), so no cloud
provider is required for Keiko to reason about voice availability.

**Realized by #493:** the **new `ModelKind` literal** mechanism was chosen — `"voice"` is added to `ModelKind`
(bumping `CONVERSATION_CAPABILITY_CONTRACT_VERSION` to `3` and forcing classification through the
`INELIGIBILITY_REASON_BY_KIND` exhaustiveness gate, which now maps `voice → "voice-only"`). This is the safer
option for a regulated product because a transcription/realtime endpoint is then never conversation-eligible,
never workflow-eligible, and never elected for chat completion. The voice modality is refined by additive
optional flags `supportsSpeechInput?`, `supportsSpeechOutput?`, `supportsRealtimeVoice?`, plus
`voiceProviderLocality?` (`azure-foundry` | `customer-hosted` | `local-only`, D7), all on the closed
`MODEL_CAPABILITY_KNOWN_KEYS` allowlist and enforced by two voice invariants (voice fields require
`kind: "voice"`; a voice capability must advertise ≥1 sub-capability and a locality). A content-free
`resolveVoiceCapability` resolver and a UI-readable `GET /api/voice/capability` BFF endpoint expose the
effective profile. See [`docs/voice/capability-configuration.md`](../voice/capability-configuration.md).

### D6 — Security review requirements for the voice surface (AC6)

Any voice implementation child issue that touches the realtime media path, signaling, or provider
credentials must satisfy a security review covering, at minimum:

- **Ephemeral tokens.** Browser realtime sessions use short-lived, scoped ephemeral session credentials
  minted server-side, with refresh/re-mint handling; the long-lived provider key never reaches the browser.
  Prefer the **proxied-SDP** pattern where the backend performs SDP negotiation so the browser never holds
  even the ephemeral token.
- **Provider credentials.** Persist only as sealed vault material referenced by `apiKeySecretRef`
  ([ADR-0046](ADR-0046-local-credential-vault.md)); environment-supplied credentials stay transient and are
  never written back; the audit redactor scrubs resolved key values.
- **ICE candidate privacy.** Rely on browser mDNS `.local` host-candidate obfuscation (UUID hostnames scoped
  to origin and page lifetime) so local/private IPs are not exposed to page JavaScript; never log or
  exfiltrate raw candidates; expect mDNS hostnames or `0.0.0.0`/`::` in stats.
- **Allowlisted endpoints.** Provider signaling/media hosts and STUN/TURN servers are configurable and
  validated; SDP signaling stays under Keiko's own loopback origin so auth, rate limiting, audit logging, and
  host allowlisting are controlled locally.
- **Audit redaction.** Voice evidence is redacted-by-construction then deep-redacted at persist, identifiers
  are hashed, and raw audio and provider secrets are never persisted, reusing the existing redaction and
  hashing seams.
- **Existing strict controls voice must relax (and re-justify).** The voice surface necessarily relaxes two
  existing deny-by-default controls, so a child issue must name and re-justify each under the security gate
  rather than silently dropping it: the `Permissions-Policy: ... microphone=() ...` directive
  ([`headers.ts`](../../packages/keiko-server/src/headers.ts) line 13), which must be scoped to the voice
  origin before `getUserMedia` can acquire the microphone; and the CSP `default-src 'none'` / `connect-src 'self'`
  ([`csp.ts`](../../packages/keiko-server/src/csp.ts) lines 61, 65), which must be extended for any
  browser-direct media or STUN/TURN traffic — the preferred proxied-SDP pattern keeps signaling server-side and
  minimizes this relaxation.

Full detail, the threat model, and the per-surface review checklist live in
[`docs/voice/privacy-contract.md`](../voice/privacy-contract.md).

### D7 — Deployment profiles cover Azure Foundry and customer-hosted controlled-network endpoints (AC5)

The architecture supports, as first-class deployment profiles: **Azure Foundry development / academic**
deployments (one valid provider profile, e.g. the `keiko-stt` STT deployment and GA realtime endpoints),
**customer-hosted controlled-network (professional)** deployments (customer-operated model endpoints,
including private/RFC-1918 hosts, inside controlled networks), and **no-voice** deployments. The provider profile is **not** assumed
constant across development, academic, customer-hosted, offline, or restricted-network environments. The full
matrix (provider profile × environment profile, with capability, transport, data-egress, and credential
columns) is [`docs/voice/deployment-profile-matrix.md`](../voice/deployment-profile-matrix.md).

### D8 — Supply-chain policy: no new runtime media packages by default (supply-chain)

The runtime dependency budget for voice is **the existing `ws` package (8.21.0) plus browser-native WebRTC
APIs** — nothing more, by default. No `socket.io`, `simple-peer`, `peerjs`, `mediasoup`, `livekit`,
server-side WebRTC stack, or other runtime media package may be added by default. WebRTC is treated as a
browser platform capability, not an npm dependency (at most `adapter.js` as an optional compatibility shim, to
be justified by a child issue). If a future design requires the Node.js backend to become a WebRTC peer, that
is a separate dependency and architecture decision, not part of this epic. The policy and its enforcement
hooks (existing `npm audit`, per-workspace CycloneDX SBOM gate `check:workspace-supply-chain`,
dependency-review) are in [`docs/voice/supply-chain-policy.md`](../voice/supply-chain-policy.md).

### D9 — Implementation sequencing for the child issues (sequencing)

The architecture defines the dependency order and write-ownership boundaries for #493–#506 so later issues
can reference a stable baseline. Sequencing notes are in
[`docs/voice/implementation-sequencing.md`](../voice/implementation-sequencing.md).

## Consequences

- The voice epic can proceed with a stable, cited architecture baseline; child issues reference this ADR and
  the `docs/voice/` contracts rather than re-deciding boundaries.
- Keiko's local-first posture, deterministic verification, Model Gateway seam, and workflow authority are
  preserved by construction: voice reuses existing seams and adds no authority and no default dependency.
- Two honest gaps are documented rather than hidden: (1) there is no outbound destination host allowlist
  today (D4), and (2) "never persist raw audio" is a _new_ invariant the voice implementation must establish
  by analogy to the existing egress gate and transient-secret patterns, because no audio path exists yet.
- A bidirectional WebSocket control channel would require re-opening the BFF upgrade path (currently closed),
  which is an explicit future architecture decision for #496/#497, not an additive change.
- This ADR is **Proposed**; it is design-only and ships no runtime code. It is promoted as child issues land.

## References

- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#492](https://github.com/oscharko-dev/Keiko/issues/492).
- [`docs/voice/README.md`](../voice/README.md) — voice architecture document set index.
- [ADR-0038](ADR-0038-outbound-egress.md), [ADR-0043](ADR-0043-enforced-execution-isolation.md),
  [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md), [ADR-0046](ADR-0046-local-credential-vault.md),
  [ADR-0047](ADR-0047-local-knowledge-content-encryption.md),
  [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md),
  [ADR-0052](ADR-0052-deterministic-context-engineering-layer.md).
- [`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md).
