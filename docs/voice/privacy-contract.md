# Voice Digital Twin — privacy contract

Privacy contract for the optional Voice Digital Twin (Epic #491), expanding
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) decisions D4 and D6. This contract
binds every voice child issue (#493–#506). It reuses Keiko's existing local-first confidentiality stack
verbatim and does not invent new cryptographic or storage mechanisms.

## 1. Local-first data boundary

The following voice state is **local to the Keiko host by default** and is transmitted **only** to an
explicitly configured model endpoint when the active voice capability requires it:

| Voice state         | Default location      | Leaves the host only when                                                       |
| ------------------- | --------------------- | ------------------------------------------------------------------------------- |
| Raw audio buffers   | Process memory only   | Streamed to a configured realtime/STT model endpoint for the active capability. |
| Transcripts         | Local, sealed at rest | Sent to a configured model endpoint required by the active capability.          |
| Voice session state | Local control plane   | Never (local system of record).                                                 |
| Memory candidates   | Local memory vault    | Never as raw candidates; only governed, gated memory writes.                    |
| Recap artifacts     | Local evidence/store  | Never (local).                                                                  |
| Policy decisions    | Local                 | Never (local).                                                                  |
| Audit metadata      | Local, redacted       | Never (local; redacted-by-construction).                                        |

### The external-call rule (AC4)

Voice mode introduces **no external destinations except explicitly configured model endpoints selected
through runtime capability metadata.** This is enforced by reusing existing seams:

- **Single outbound transport.** All voice model traffic routes through `gatewayFetch`
  (`packages/keiko-model-gateway/src/http.ts`, [ADR-0038](../adr/ADR-0038-outbound-egress.md)), inheriting
  corporate-proxy, custom-CA, timeout, and 10 MB byte-cap behavior. No bespoke HTTP/WebRTC-signaling client is
  introduced for provider calls.
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
deployments. AC4 is satisfied today by _bounding which endpoints are reachable and which models are electable_
(configured providers + capability selection), not by a deny-everything-else allowlist.

If a deployment requires positively **denying all non-model destinations**, that is a thin, **opt-in** egress
policy layer (a base-URL/host allowlist derived from configured providers, enforced at the `gatewayFetch`
boundary) that **does not exist today** and must be added by a later child issue without breaking private
endpoints. This contract does not claim an allowlist that is not present.

## 2. Never persist raw audio or provider secrets

- **Raw audio is never persisted.** Audio buffers are processed in memory only and never reach a writer. This
  is a **new** invariant (no audio path exists today); it is established by analogy to the transient-secret
  pattern ([ADR-0046](../adr/ADR-0046-local-credential-vault.md): env credentials stay transient, never
  written back) and the pre-persist egress gate
  (`packages/keiko-memory-capture/src/capture-safety.ts`, `memoryTextEgressRejectionReason`).
- **Provider secrets are never persisted in cleartext.** Voice/STT provider keys persist only as sealed vault
  material referenced by `apiKeySecretRef` ([ADR-0046](../adr/ADR-0046-local-credential-vault.md));
  environment-supplied credentials stay transient and are never written back; resolution is behind the gateway
  via an injected secret resolver. The audit redactor scrubs resolved key values from logs and evidence.
- **Ephemeral browser credentials are short-lived and scoped.** Realtime browser sessions use short-lived
  ephemeral session credentials minted server-side; the long-lived provider key never reaches the browser.
  Prefer the **proxied-SDP** pattern so the browser never holds even the ephemeral token.

## 3. Confidentiality at rest (reused mechanisms)

When voice transcripts, recap, session state, memory candidates, or audit metadata are persisted, they reuse
the existing controls — no new crypto, no new dependency:

- **Encryption at rest.** AES-256-GCM via `packages/keiko-security/src/secretbox.ts`
  (`sealString`/`openString`/`sealBytes`/`openBytes`), keyed through the env → OS-keychain → `0600`-keyfile
  ladder (`packages/keiko-security/src/secret-vault.ts`) with a **distinct namespace per domain** (e.g. a
  dedicated `KEIKO_VOICE_KEY` → `keiko-voice-vault` keychain service → `voice-vault.key`). Cross-vault replay
  is prevented by key separation. Crypto stays confined to the store/IO boundary (ADR-0047 pattern).
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

| Requirement                    | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ephemeral tokens**           | Short-lived, scoped session credentials minted server-side; refresh/re-mint handling; prefer proxied-SDP so the browser holds no token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Provider credentials**       | Sealed vault material via `apiKeySecretRef`; env creds transient and never written back; redactor scrubs resolved values (ADR-0046).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **ICE candidate privacy**      | Browser mDNS `.local` UUID host-candidate obfuscation scoped to origin/page lifetime; never log/exfiltrate raw candidates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Allowlisted endpoints**      | Provider signaling/media and STUN/TURN hosts are configurable and validated; SDP signaling stays under Keiko's loopback origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Audit redaction**            | Redacted-by-construction + deep re-redaction; identifiers hashed; raw audio and provider secrets never persisted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Existing controls to relax** | Re-justify, do not silently drop: `Permissions-Policy ... microphone=()` (`keiko-server/src/headers.ts`) — **scoped, not dropped, by Issue #495**: the BFF keeps `microphone=()` by default and emits `microphone=(self)` only when the resolved voice capability advertises speech-to-text (`isVoiceDictationCapable`, mirroring the dictation route gate), never wider than `(self)`. CSP `default-src 'none'` / `connect-src 'self'` (`keiko-server/src/csp.ts` lines 61, 65) is **unchanged** for STT dictation (same-origin `/api/voice/transcribe`, no browser-direct media); it must be extended only for future browser-direct media or STUN/TURN (proxied-SDP minimizes this). |

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
- Ephemeral tokens can expire mid-negotiation; if the browser holds a token at all it is exposed to XSS — both
  reasons to prefer the proxied-SDP pattern and a strict CSP on the voice surface.
- Customer-reconstructive evidence is not encrypted at rest in 0.2.x (ADR-0048 D3 deferral); voice
  reconstructive artifacts inherit that documented limitation until the deferral is lifted.
