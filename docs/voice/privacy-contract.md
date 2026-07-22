# Voice Digital Twin — privacy contract

Privacy contract for the optional Voice Digital Twin (Epic #491), expanding
[ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) decisions D4 and D6. This contract
binds every voice child issue (#493–#506). It reuses Keiko's existing local-first confidentiality stack
verbatim and does not invent new cryptographic or storage mechanisms.

## 1. Local-first data boundary

The following voice state is **local to the Keiko host by default** and is transmitted **only** to an
explicitly configured model endpoint when the active voice capability requires it:

| Voice state         | Default location     | Leaves the host only when                                                       |
| ------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Raw audio buffers   | Process memory only  | Streamed to a configured realtime/STT model endpoint for the active capability. |
| Final transcripts   | Canonical UI chat DB | Sent to a configured model endpoint required by the active capability.          |
| Partial transcripts | Process memory only  | Sent to the configured Realtime/STT endpoint for the active capability.         |
| Voice session state | Local control plane  | Never (local system of record).                                                 |
| Memory candidates   | Local memory vault   | Never as raw candidates; only governed, gated memory writes.                    |
| Recap artifacts     | Local evidence/store | Never (local).                                                                  |
| Policy decisions    | Local                | Never (local).                                                                  |
| Audit metadata      | Local, redacted      | Never (local; redacted-by-construction).                                        |

### The external-call rule (AC4)

Voice mode introduces no provider HTTP destination except an explicitly configured model endpoint selected
through runtime capability metadata. The separately reviewed WebRTC media plane follows the provider answer
SDP and therefore requires deployment-network acceptance rather than being described as a positive host
allowlist. The implementation reuses these seams:

- **Bounded outbound transports.** Provider HTTP signaling, STT, and TTS calls route through
  `gatewayFetch` (`packages/keiko-model-gateway/src/http.ts`,
  [ADR-0038](../adr/ADR-0038-outbound-egress.md)), inheriting corporate-proxy, custom-CA, timeout, and byte-cap
  behavior. Realtime microphone media is the separately reviewed, send-only browser→provider DTLS-SRTP
  plane negotiated by that proxied SDP; it does not traverse `gatewayFetch`.
- **Provider-bounded reachability.** Only configured-provider base URLs are ever fetched, and only configured
  _and_ capable models are electable: `assertConfiguredModel`, `selectConfiguredModel`,
  `selectCompletionModel` (`packages/keiko-model-gateway/src/model-selection.ts` lines 57–111). A capability
  that names no configured provider can never be elected. This is precisely "explicitly configured model
  endpoints selected by runtime capability metadata".
- **Enforced egress for untrusted execution.** Any model-generated code executed for a voice flow requests
  `network: "none"` to inherit the OS-enforced, CI-proven egress boundary
  (`keiko-sandbox`, [ADR-0043](../adr/ADR-0043-enforced-execution-isolation.md)).

### Honest limitation: no destination host allowlist exists yet

`gatewayFetch` has **no positive destination allowlist** — it fetches whatever configured base URL it is
handed — and `validateBaseUrl` (`packages/keiko-model-gateway/src/config.ts` lines 441–464) intentionally does
**not** restrict host/IP, because private/self-hosted endpoints are first-class targets in customer-hosted
deployments. Provider HTTP egress is bounded by configured providers plus capability selection, not by a
deny-everything-else allowlist. The WebRTC media destination is additionally governed by the provider SDP
and enterprise network and must be accepted per deployment.

If a deployment requires positively **denying all non-model destinations**, that is a thin, **opt-in** egress
policy layer (a base-URL/host allowlist derived from configured providers, enforced at the `gatewayFetch`
boundary) that **does not exist today** and must be added by a later child issue without breaking private
endpoints. This contract does not claim an allowlist that is not present.

## 2. Never persist raw audio or provider secrets

- **Raw audio is never persisted.** Microphone and generated speech buffers are processed in memory only and
  never reach a writer. Settled final transcript text is different: ADR-0154 intentionally persists it as
  the ordinary canonical user chat message, while partial transcripts remain ephemeral.
- **Provider secrets are never persisted in cleartext.** Voice/STT provider keys persist only as sealed vault
  material referenced by `apiKeySecretRef` ([ADR-0046](../adr/ADR-0046-local-credential-vault.md));
  environment-supplied credentials stay transient and are never written back; resolution is behind the gateway
  via an injected secret resolver. The audit redactor scrubs resolved key values from logs and evidence.
- **The productive browser holds no provider credential.** Proxied-SDP keeps standard provider keys and any
  host-minted `ephemeral-session` secret on the Keiko host. `direct-ephemeral` remains an unwired protocol
  value that requires a separate architecture and security decision.

## 3. Confidentiality at rest (reused mechanisms)

Final Voice transcripts persist as ordinary canonical chat messages and therefore inherit exactly the
UI database posture of typed chat, not a separate Voice vault. Memory candidates, Local Knowledge,
credentials, and evidence keep their own existing controls — no parallel Voice crypto subsystem is
introduced:

- **Canonical transcript storage.** The UI SQLite database uses an owner-only directory/file posture
  (`0700`/`0600`) under ADR-0013. Application-level encryption of that database remains explicitly
  deferred by ADR-0013 D10; host full-disk encryption is therefore required where chat-at-rest
  confidentiality is mandatory. Voice neither weakens nor overstates that inherited posture.
- **Domain encryption where already decided.** Memory-vault and Local-Knowledge reconstructive
  content use AES-256-GCM through their existing distinct key namespaces. Provider credentials use
  their dedicated sealed credential vault. A final transcript may reach those domains only through
  the canonical governed Chat/memory paths and is then protected by the destination domain's controls.
- **File permissions.** Owner-only POSIX modes (`0o700` directories, `0o600` files) set at write time and
  re-normalized by `keiko repair`; best-effort/non-fatal on non-POSIX filesystems.
- **Redaction.** Redacted-by-construction then deep re-redacted at persist via
  `packages/keiko-security/src/redaction.ts` (`redact`, `createAuditRedactor`, `deepRedactStrings`); the
  redactor scrubs secret _values_, never names, and uses only ReDoS-safe linear patterns.
- **Identifier hashing.** Session/chat identifiers and workspace paths are hashed (SHA-256) to audit
  identifiers before entering any manifest, exactly as
  `packages/keiko-evidence/src/compaction-evidence.ts` already does for recap/session-state records.
- **Retention.** Deterministic, manifest-driven retention (`packages/keiko-evidence/src/retention.ts`)
  applies; disabled is a no-op.

The voice surfaces are added as new rows to the per-surface control matrix in
[`docs/local-runtime-state-contract.md`](../local-runtime-state-contract.md) when implemented, consistent with
the four confidentiality classes of [ADR-0048](../adr/ADR-0048-evidence-artifact-confidentiality.md).

## 4. Security review requirements for the voice surface (AC6)

Every child issue that touches the realtime media path, signaling, or provider credentials must pass a
security review covering, at minimum:

| Requirement                      | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider session credentials** | Productive proxied-SDP keeps standard keys and any host-minted short-lived session secret on the server; no provider credential reaches the browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Provider credentials**         | Sealed vault material via `apiKeySecretRef`; env creds transient and never written back; redactor scrubs resolved values (ADR-0046).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **ICE candidate privacy**        | Non-trickle candidates remain inside opaque secret-bearing SDP; browser mDNS behavior is deployment-dependent; never log or persist raw SDP/candidates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Endpoint posture**             | Provider HTTP signaling is bounded by configured Model Gateway endpoints; the shipped browser supplies no custom STUN/TURN or relay host, and customer WebRTC routing requires deployment acceptance evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Audit redaction**              | Redacted-by-construction + deep re-redaction; identifiers hashed; raw audio and provider secrets never persisted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Existing controls to relax**   | Re-justify, do not silently drop: `Permissions-Policy ... microphone=()` (`keiko-server/src/headers.ts`) — **scoped, not dropped, by Issue #495** (STT) and **Issue #497** (realtime): the BFF keeps `microphone=()` by default and emits `microphone=(self)` only when the resolved voice capability advertises speech-to-text **or** full-realtime voice (`isVoiceDictationCapable \|\| isVoiceRealtimeCapable`), never wider than `(self)`. CSP `default-src 'none'` / `connect-src 'self'` (`keiko-server/src/csp.ts`) is **unchanged** by #497: the realtime control WebSocket is opened **same-origin** (covered by `connect-src 'self'`) and proxied-SDP keeps signaling server-side, so no `connect-src` / `webrtc` directive is added; it must be extended only for a future opt-in browser-direct (`direct-ephemeral`) media / STUN/TURN path. **The re-opened BFF WebSocket upgrade** (deliberately hard-rejected before) is re-justified by **Issue #497 / [ADR-0102](../adr/ADR-0102-realtime-voice-transport.md)**: it is confined to the single loopback path `/api/voice/control`, gated on full-realtime capability + policy, reuses the loopback `Host`/`Origin` check (rejecting opaque `Origin: null`), rejects raw-audio binary frames, and keeps the `404` + `socket.destroy()` default for every other upgrade. |

These map to the existing `Security review` expected-verification gate (trust boundaries, secrets, model
access, external calls, CSP). Because Issue #492 ships **documentation only** and changes no trust-boundary,
auth, secrets, CSP, model-access, or execution code, no code-level security gate is triggered by this issue
itself; the requirements above are obligations on the implementing child issues.

## 5. Threat model and limitations (honest)

- These controls protect data **at rest** and **in transit to configured endpoints**; they do not protect a
  live process, or a host where a vault key is already unlocked.
- Cleartext metadata (kept for indexing) leaks the _shape_ of activity, not its content.
- Audit/evidence is **local machine state**, not a hosted compliance archive: no remote sync, replication,
  backup, KMS, hosted secret store, hosted vector DB, or cloud control plane is introduced or referenced.
- ICE candidate behavior and local-IP exposure can differ across operating systems and managed networks
  (enterprise policies, macOS "Local Network" prompt); the privacy posture must be verified per deployment,
  not assumed uniform.
- A future browser-direct credential would be exposed to XSS and expiry races. Productive proxied-SDP avoids
  that posture; wiring `direct-ephemeral` requires a separate review.
- Customer-reconstructive evidence is not encrypted at rest in 0.2.x (ADR-0048 D3 deferral); voice
  reconstructive artifacts inherit that documented limitation until the deferral is lifted.
- Canonical typed and spoken chat messages in `keiko-ui.db` are not application-level encrypted under
  ADR-0013 D10. Owner-only permissions and host full-disk encryption are the current at-rest controls.
