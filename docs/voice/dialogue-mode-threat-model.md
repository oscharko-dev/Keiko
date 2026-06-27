# Voice dialogue mode — security review notes and threat model (Issue #1562)

Security review notes and STRIDE-flavored threat model for the **colleague-like voice dialogue mode**
(Epic [#1556](https://github.com/oscharko-dev/Keiko/issues/1556), children #1557–#1561). This document is the
D1 deliverable of Issue [#1562](https://github.com/oscharko-dev/Keiko/issues/1562) and, together with the
AC → evidence matrix in [§5](#5-acceptance-criteria--evidence-validation-matrix), constitutes the completed
security review that satisfies that issue's AC4 ("security review is complete before final closure of the
epic").

It **extends, and does not restate**, the epic-#491 privacy contract: the local-first data boundary, the
external-call rule, the never-persist-raw-audio invariant, and the at-rest confidentiality stack are specified
in [privacy-contract.md](privacy-contract.md) and the closure gate in [production-readiness.md](production-readiness.md).
This document is the dialogue-mode-specific surface: the exact runtime data path that the #1556 controller
adds, the threats it introduces, and the code that mitigates each. Every claim cites a verifiable
`file:line`.

The authoritative decision records for the surface under review are
[ADR-0090](../adr/ADR-0090-voice-dialogue-session-orchestration.md) (dialogue orchestration),
[ADR-0089](../adr/ADR-0089-voice-assistant-speech-synthesis.md) (assistant speech synthesis), and
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) (capability-gated architecture).

## 1. Scope and the complete dialogue-mode data path

### 1.1 Transport: STT + TTS, not WebRTC realtime

The colleague dialogue mode runs as a **half-duplex speech-to-text + text-to-speech turn loop**, not a
WebRTC realtime media session. The orchestrator hardcodes the realtime phase to `idle` and never starts a
realtime media connection:

- `useVoiceDialogueSession` derives its UI state with `realtimePhase: "idle"` literally
  (`packages/keiko-ui/src/app/components/desktop/hooks/useVoiceDialogueSession.ts:300`).
- The turn loop is "driven by the **dictation (STT-batch)** capture path … The realtime media connection is
  **not** started" ([dialogue-session.md](dialogue-session.md) §"The STT+TTS production turn loop", step 1).

Consequently the realtime transport, its re-opened loopback WebSocket control plane, and its browser-direct
DTLS-SRTP / SDP / ICE handling (Issue #497, [ADR-0060](../adr/ADR-0060-realtime-voice-transport.md),
[realtime-transport.md](realtime-transport.md)) are **not in the dialogue-mode path** and are out of scope for
this review. They are governed by their own ADR and the closure gate's two-egress-channel discussion
([production-readiness.md](production-readiness.md) §4). No SDP, ICE candidate, ephemeral browser token, or
direct browser↔provider media channel exists on the surface reviewed here.

### 1.2 The data path, hop by hop

Each numbered hop is the concrete code that executes one full dialogue turn:

1. **Microphone capture (browser).** A turn begins only on an explicit user gesture
   (`onListen`, `useVoiceDialogueSession.ts:266`). Capture lives behind the injectable recorder seam;
   the production recorder calls `navigator.mediaDevices.getUserMedia({ audio: true })` exactly once per
   session start (`dictation-recorder.ts:207`) and records through a native `MediaRecorder`
   (`dictation-recorder.ts:144`–`192`). Audio is held only in memory and handed to the caller as base64
   (`dictation-recorder.ts:160`–`180`); nothing is written to disk or logged in this module
   (`dictation-recorder.ts:6`–`8`).
2. **Transcript (browser → BFF → provider).** Stopping capture posts the base64 clip to the BFF
   `POST /api/voice/transcribe` route (`useDictation.ts:196`–`198`). The route is capability-gated, forwards
   the decoded audio once to the configured STT provider via the Model Gateway egress seam, and returns only
   the transcript (`voice-handlers.ts:370`–`391`, `voice-handlers.ts:358`–`368`).
3. **Chat send (browser).** Only the reviewed, trimmed, **non-empty** committed transcript reaches chat, and
   it is handed directly to the existing chat lifecycle via `sendMessage({ text })`
   (`useVoiceDialogueSession.ts:190`–`200`). An empty or whitespace transcript is dropped before any send
   (`useVoiceDialogueSession.ts:191`–`193`). No spoken text auto-selects or auto-executes an action.
4. **Assistant answer (existing chat path).** The reply is produced by the unchanged chat pipeline; the
   dialogue controller consumes only the latest **complete** assistant message text + id
   (`useVoiceDialogueSession.ts:68`–`72`).
5. **Assistant speech (browser → BFF → provider).** Only that visible answer text is synthesized, through the
   capability-gated BFF `POST /api/voice/speak` route (`voice-handlers.ts:595`–`622`); the response is base64
   audio plus a canonicalized MIME type (`voice-handlers.ts:587`–`593`).
6. **Playback (browser).** `useAssistantSpeech` plays the returned audio through a single
   `HTMLAudioElement` fed by an object URL (`useAssistantSpeech.ts:218`–`221`); the URL is revoked and the
   element released on every completion / stop / mute / interrupt (`useAssistantSpeech.ts:155`–`175`).
   The BFF CSP permits this playback with `media-src 'self' blob:` only (`csp.ts`), leaving
   `default-src 'none'`, `script-src`, and `connect-src` unchanged.
7. **Interruption / barge-in (browser).** Activating the mic while the assistant holds the floor, or pressing
   Interrupt, applies a content-free turn signal whose emitted effects stop playback and cancel an in-flight
   chat request (`useVoiceDialogueSession.ts:161`–`174`, `289`–`292`); only enum kinds, integers, and
   millisecond deltas cross the turn manager ([dialogue-session.md](dialogue-session.md) §"Privacy
   invariants").
8. **Memory / recap.** The dialogue controller writes no memory. Memory candidate capture from a voice
   session is the separate, user-triggered, content-free-audit governed flow of Issue #504
   ([session-recap.md](session-recap.md)); it is not invoked by the dialogue turn loop.
9. **Action intent.** A spoken turn is a normal chat message; it never bypasses the deterministic,
   fail-closed spoken-action governance of Issue #503
   ([action-intent-governance.md](action-intent-governance.md)). The controller performs no spoken-action
   auto-execution ([dialogue-session.md](dialogue-session.md) §"The STT+TTS production turn loop", step 4;
   `useVoiceDialogueSession.ts:188`–`200`).

## 2. Trust boundaries

| Boundary                          | Side under our control                             | Trust assumption                                                                                                                                  |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser (renderer)**            | Yes — the React controller and the audio/mic seams | Runs untrusted-input-bearing code; assumed to honor the BFF CSP and `Permissions-Policy`; holds **no** provider credential and no voice id.       |
| **BFF (loopback `127.0.0.1`)**    | Yes — `keiko-server` route handlers                | The capability gate, request validation, redaction, and static error envelopes live here; state-changing routes ride the JSON + CSRF gate.        |
| **Model Gateway → provider**      | Gateway code ours; provider endpoint is external   | Reached **only** through `gatewayFetch` to a configured provider base URL; provider TLS is relied upon for confidentiality in transit.            |
| **Local credential vault / host** | Yes — sealed vault material on the Keiko host      | The long-lived provider key stays host-side as sealed vault material (`apiKeySecretRef`); a host whose vault is already unlocked is out of scope. |

The BFF binds loopback and the control plane is loopback-only in every voice profile
([deployment-profile-matrix.md](deployment-profile-matrix.md) §4). The persona → provider voice-id mapping
lives on the credential-tier provider record and never reaches the browser
([deployment-profile-matrix.md](deployment-profile-matrix.md) §6).

## 3. Data in motion and data at rest

### 3.1 In motion (what crosses each boundary)

| Hop                          | Crosses                   | Payload                                                                            | Never carries                                                                   |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Mic → BFF (`/transcribe`)    | Browser → BFF (loopback)  | base64 audio + MIME + optional duration/language (`useDictation.ts:147`–`152`)     | No credential; rides existing JSON + CSRF envelope (`voice-handlers.ts:7`–`12`) |
| BFF → STT provider           | BFF → configured endpoint | Decoded audio forwarded once via `gatewayFetch` (`voice-handlers.ts:334`–`352`)    | —                                                                               |
| BFF → browser (transcribe)   | BFF → browser             | Transcript + content-free metadata only (`voice-handlers.ts:358`–`368`)            | No base URL, credential, voice id, or provider body                             |
| Answer text → BFF (`/speak`) | Browser → BFF (loopback)  | Visible answer text + optional persona enum (`useAssistantSpeech.ts:70`–`75`)      | No voice id (resolved server-side, `voice-handlers.ts:536`–`558`)               |
| BFF → TTS provider           | BFF → configured endpoint | Answer text + resolved voice id via `gatewayFetch` (`voice-handlers.ts:560`–`579`) | —                                                                               |
| BFF → browser (speak)        | BFF → browser             | base64 audio + canonicalized MIME (`voice-handlers.ts:587`–`593`)                  | No base URL, credential, persona→voice-id mapping, or provider body             |

### 3.2 At rest (what is persisted by the dialogue surface)

The dialogue surface persists **exactly one thing**: a content-free persona enum in browser `localStorage`.

- The persisted value is the persona literal only (`"male" | "female" | "neutral"`), written by
  `writeStoredPersona` under the key `keiko.voice.dialog.persona`
  (`useVoiceDialogMode.ts:19`, `useVoiceDialogMode.ts:64`–`72`), and re-validated against the closed
  `VOICE_PERSONAS` set on read (`useVoiceDialogMode.ts:45`–`60`). It carries no voice id and nothing
  content-bearing (`useVoiceDialogMode.ts:9`–`11`).

The dialogue surface persists **nothing else**. Specifically:

- **No raw audio.** Capture audio lives only in memory and is never written to disk or logged
  (`dictation-recorder.ts:6`–`8`); the BFF holds the decoded clip only for the request and never writes it to
  the evidence store, a side file, a log, or any on-disk location (`voice-handlers.ts:10`–`12`,
  `voice-handlers.ts:357`).
- **No generated audio.** The synthesized blob lives only behind a per-turn object URL that is revoked on
  teardown (`useAssistantSpeech.ts:15`, `useAssistantSpeech.ts:171`–`174`); the BFF holds the synthesized
  buffer only for the request and never persists it (`voice-handlers.ts:401`–`405`, `voice-handlers.ts:586`).
- **No transcript.** The committed transcript flows into a normal chat message and is never written by the
  dialogue controller to a side store.
- **No provider secret.** The provider key stays host-side sealed vault material and never reaches the browser
  or a response ([privacy-contract.md](privacy-contract.md) §2; `voice-handlers.ts:13`–`14`).

## 4. Threats → mitigations

STRIDE categories in brackets: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure,
**D**enial of service, **E**levation of privilege.

| #   | Threat (STRIDE)                                                                | Mitigation, with enforcing code                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider key / base URL / voice-id exfiltration to the browser or evidence (I) | Static, secret-free error envelopes for every coded failure (`voice-handlers.ts:163`–`205`, `441`–`480`); success bodies carry only transcript/audio + content-free metadata and run through `deps.redactor` (`voice-handlers.ts:358`–`368`); voice id resolved and kept server-side (`voice-handlers.ts:536`–`558`, `573`–`575`). Asserted by the existing `voice-handlers.speak.test.ts` and `voice-handlers.test.ts`.                       |
| 2   | Raw input audio persistence / leakage (I)                                      | In-memory only in the recorder (`dictation-recorder.ts:6`–`8`, `160`–`180`); BFF forwards once and never writes the clip (`voice-handlers.ts:10`–`12`, `357`).                                                                                                                                                                                                                                                                                 |
| 3   | Generated audio persistence / leakage (I)                                      | Per-turn object URL revoked on every teardown (`useAssistantSpeech.ts:155`–`175`); BFF never persists the synthesized buffer (`voice-handlers.ts:401`–`405`, `586`).                                                                                                                                                                                                                                                                           |
| 4   | Microphone left open after stop / leave / unmount (I, "always-on mic")         | `MediaRecorder` tracks are stopped on stop and on cancel (`dictation-recorder.ts:127`–`131`, `160`–`191`); the dialogue master cleanup cancels dictation, stops playback, closes + resets the turn manager (`useVoiceDialogueSession.ts:240`–`247`), and runs on stop (`294`–`297`), capability loss (`251`–`256`), and unmount (`259`).                                                                                                       |
| 5   | Mic re-grant race in the permission window (I, "double getUserMedia")          | Synchronous `startingRef` blocks a second `start()` before the first grant resolves (`useDictation.ts:174`, `210`–`242`); `onListen` additionally refuses a re-tap during `requesting`/`transcribing` (`useVoiceDialogueSession.ts:272`–`275`).                                                                                                                                                                                                |
| 6   | Leaving mid-permission still establishing a session (I, late grant)            | `cancelledRef` set by `cancel()` (`useDictation.ts:179`, `244`–`253`) makes a grant that resolves after a cancel release the just-granted track instead of opening a session (`useDictation.ts:227`–`230`).                                                                                                                                                                                                                                    |
| 7   | Egress to an attacker-controlled host (I, SSRF-style)                          | All provider traffic routes through `gatewayFetch` to a configured provider base URL only (`voice-handlers.ts:334`–`352`, `560`–`579`); HTTPS targets get full TLS verification with a bounded recoverable-trust CA fallback (`http.ts:105`–`111`, `714`–`740`); the configured-and-capable model selection bounds reachability ([privacy-contract.md](privacy-contract.md) §1).                                                               |
| 8   | Oversized / malformed input → resource exhaustion (D)                          | Early 413 body cap (`voice-handlers.ts:91`–`116`), decoded-audio byte ceiling (`voice-handlers.ts:45`, `286`–`291`), bounded dictation duration (`voice-handlers.ts:51`, `235`–`249`), anchored base64 / language patterns (`voice-handlers.ts:71`–`74`), capped speech input (`voice-handlers.ts:412`, `514`–`521`), client auto-stop at the same bound (`useDictation.ts:27`, `233`); gateway response byte cap (`http.ts:13`, `199`–`216`). |
| 9   | Spoken text injecting an unintended action (E)                                 | A spoken turn is an ordinary chat message; it never auto-selects or auto-executes (`useVoiceDialogueSession.ts:188`–`200`) and is subject to the unchanged #503 spoken-action governance ([action-intent-governance.md](action-intent-governance.md)).                                                                                                                                                                                         |
| 10  | Memory leakage of voice content (I)                                            | The dialogue controller writes no memory; recap is the separate user-triggered, content-free-audit governed flow ([session-recap.md](session-recap.md), Issue #504). The turn manager only ever sees enum kinds / integers ([dialogue-session.md](dialogue-session.md) §"Privacy invariants").                                                                                                                                                 |
| 11  | Mic affordance exposed on a no-voice / unsupported deployment (E)              | `Permissions-Policy` keeps `microphone=()` by default and emits `microphone=(self)` only when the resolved capability is dictation- or realtime-capable, never wider (`headers.ts:25`–`28`, `43`; wired in `server.ts:182`–`185`); the UI fallback matrix offers dialogue only for the full conjunction (`useVoiceDialogMode.ts:87`–`92`, `useVoiceDialogueSession.ts:117`–`121`).                                                             |
| 12  | Late provider answer playing after the turn is gone (T)                        | Synthesis is aborted via `AbortController`, and a settled promise is dropped when `cancelled` or `signal.aborted` (`useAssistantSpeech.ts:204`–`216`, `247`–`253`, `255`–`258`).                                                                                                                                                                                                                                                               |
| 13  | Disabled / unconfigured deployment doing audio work (D, defense in depth)      | Both routes run the capability gate **before** any body is read (`voice-handlers.ts:324`–`332`, `374`–`377`, `485`–`493`, `599`–`600`), and honor the `KEIKO_VOICE_DISABLED` policy kill-switch (`read-handlers.ts:77`–`78`, used at `voice-handlers.ts:326`, `487`).                                                                                                                                                                          |
| 14  | CSP blocks generated assistant audio or is widened too far (D/I)               | Playback is allowed only by `media-src 'self' blob:` for same-origin media and ephemeral object URLs (`csp.ts`); `connect-src 'self'` and hash-based `script-src` are unchanged, so the repair does not open browser-to-provider egress or script execution.                                                                                                                                                                                   |

## 5. Acceptance criteria → evidence validation matrix

The tests added by Issue #1562 (rows tagged **#1562**) prove the dialogue-mode-specific behavior; existing
tests (cited where they already hold) prove the redaction / header invariants this surface relies on and must
not duplicate.

| AC / D  | Claim                                                                                            | Proving artifact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC1** | No secret / endpoint / raw audio / generated audio / SDP / token reaches the browser or evidence | Existing `voice-handlers.speak.test.ts` (response + failure envelopes never carry the secret, base URL, or voice id) and `voice-handlers.test.ts` (transcribe gate + redacted failures); **#1562** `voice-handlers.dialogue-safety.test.ts` (no raw / generated audio persistence; redacted provider failures across the dialogue routes). No SDP/token surface exists in this path ([§1.1](#11-transport-stt--tts-not-webrtc-realtime)).                                                                                                                            |
| **AC2** | Microphone is requested only when entering a voice mode requiring capture                        | Code: `getUserMedia` only inside the recorder `start()` driven by an explicit gesture (`dictation-recorder.ts:207`, `useDictation.ts:210`–`242`, `useVoiceDialogueSession.ts:266`). **#1562** `useDictation` Issue-1562 tests prove no second `getUserMedia` opens during the permission window (`startingRef`); `useVoiceDialogueSession.miclifecycle.test.tsx` proves capture starts only on activation.                                                                                                                                                           |
| **AC3** | Stopping or leaving dialog mode releases mic and playback deterministically                      | Code: master cleanup on stop / leave / unmount / capability loss (`useVoiceDialogueSession.ts:240`–`259`, `294`–`297`); track stop on cancel (`dictation-recorder.ts:181`–`191`); object-URL revoke + abort on playback teardown (`useAssistantSpeech.ts:155`–`175`); `cancelledRef` releases a late grant (`useDictation.ts:227`–`230`). **#1562** `useVoiceDialogueSession.miclifecycle.test.tsx` and the e2e voice-dialogue smoke mic-lifecycle test prove deterministic release; **#1562** `useDictation` Issue-1562 tests prove the mid-permission cancel path. |
| **AC4** | Security review complete before epic closure                                                     | This document (§1–§7) plus the operator runbook (D4). The disposition is recorded in [§7](#7-security-review-disposition).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **D1**  | Threat model + security review notes                                                             | This document.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **D2**  | Automated tests for no raw/generated audio persistence and redacted provider failures            | **#1562** `voice-handlers.dialogue-safety.test.ts`; corroborated by existing `voice-handlers.speak.test.ts` / `voice-handlers.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **D3**  | `Permissions-Policy` + browser permission lifecycle verification                                 | Existing `headers.test.ts` (`microphone=()` default; `microphone=(self)` only when `allowMicrophone`; never widened) — **not duplicated** here; lifecycle proven by the **#1562** `useDictation` Issue-1562 tests + `useVoiceDialogueSession.miclifecycle.test.tsx` + the e2e mic-lifecycle smoke test.                                                                                                                                                                                                                                                              |
| **D4**  | Operator runbook for configuring / validating voice providers                                    | The dialogue-mode operator runbook delivered alongside this document under `docs/voice/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 6. Residual risks and honest limitations

Mirroring the honesty of [privacy-contract.md](privacy-contract.md) §5 and
[production-readiness.md](production-readiness.md) §8:

1. **No positive destination-host allowlist beyond HTTPS + configured endpoints.** `gatewayFetch` fetches
   whatever configured base URL it is handed and does not restrict host/IP, because private / self-hosted
   endpoints are first-class for customer-hosted deployments
   ([privacy-contract.md](privacy-contract.md) §1, "Honest limitation"). Dialogue mode inherits this: egress
   is bounded by _which endpoints are reachable and which models are electable_, not by a
   deny-everything-else allowlist. A thin opt-in egress-policy layer remains a deferred follow-up.
2. **Confidentiality in transit relies on provider TLS.** `gatewayFetch` enforces HTTPS verification with a
   bounded recoverable-trust CA fallback (`http.ts:705`–`740`), but the confidentiality of audio / transcript
   / answer text in transit to the provider rests on that provider's TLS endpoint and the deployment's CA
   posture; it is not independently end-to-end encrypted by Keiko.
3. **Browser-trust assumptions.** The mic-lifecycle and content-free guarantees hold within an honest
   renderer that respects the BFF CSP and `Permissions-Policy`. A compromised renderer (e.g. via an XSS that
   defeats CSP) is outside this surface's threat boundary; the persona `localStorage` value is the only
   at-rest browser state, and it is content-free.
4. **Half-duplex by construction.** The deployed loop is listen-then-speak; literal full-duplex overlap
   awaits a realtime transcript provider behind the same controller seam
   ([dialogue-session.md](dialogue-session.md) §"Optional and capability-gated"). This is a behavioral, not a
   security, limitation, recorded for completeness.
5. **Provider-side handling of forwarded content is out of scope.** Once audio / text reaches a configured
   provider it is governed by that provider's data-handling terms, which the operator selects per deployment
   ([deployment-profile-matrix.md](deployment-profile-matrix.md) §2) and validates with the D4 runbook.

## 7. Security review disposition

The security review of the **voice dialogue-mode surface** introduced by Epic #1556 is **complete**.

- The dialogue path is STT + TTS only; no WebRTC realtime / SDP / ICE / ephemeral-token surface is added
  ([§1.1](#11-transport-stt--tts-not-webrtc-realtime)).
- No provider key, endpoint secret, raw provider body, raw audio, generated audio, SDP secret, or
  token-bearing artifact reaches a browser-visible payload or an evidence store
  ([§3](#3-data-in-motion-and-data-at-rest), threats 1–3).
- The microphone is requested only on an explicit gesture into a capture-requiring mode, and stopping /
  leaving releases the microphone and playback resources deterministically — including the permission-window
  re-grant and late-grant races ([§4](#4-threats--mitigations), threats 4–6).
- Egress is bounded to configured provider endpoints over verified HTTPS, with the named allowlist limitation
  carried forward honestly ([§6](#6-residual-risks-and-honest-limitations), item 1).
- Generated-audio playback is permitted only through the narrow CSP `media-src 'self' blob:` directive; no
  browser network, script, provider endpoint, credential, or voice-id surface is widened.
- Every claim is grounded in cited code and in the automated tests of the AC → evidence matrix
  ([§5](#5-acceptance-criteria--evidence-validation-matrix)).

**Disposition:** PASS for the dialogue-mode surface, with the residual risks of
[§6](#6-residual-risks-and-honest-limitations) recorded and accepted (each is a pre-existing, documented
epic-#491 limitation, not a regression introduced by this surface). This satisfies Issue #1562 AC4.
— Application security review, Issue #1562.

## 8. References

- [privacy-contract.md](privacy-contract.md) — the epic-#491 privacy contract this document extends.
- [production-readiness.md](production-readiness.md) — the regulated production-readiness closure gate.
- [dialogue-session.md](dialogue-session.md) — the dialogue session controller behavior under review.
- [deployment-profile-matrix.md](deployment-profile-matrix.md) — provider × environment profiles and credential posture.
- [action-intent-governance.md](action-intent-governance.md) (#503), [session-recap.md](session-recap.md) (#504) — spoken-action and memory governance the dialogue path defers to.
- [ADR-0090](../adr/ADR-0090-voice-dialogue-session-orchestration.md), [ADR-0089](../adr/ADR-0089-voice-assistant-speech-synthesis.md), [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) — decision records.
- Epic [#1556](https://github.com/oscharko-dev/Keiko/issues/1556); Issue [#1562](https://github.com/oscharko-dev/Keiko/issues/1562).
