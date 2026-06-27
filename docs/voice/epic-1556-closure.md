# Epic #1556 — Colleague-Like Voice Dialogue Mode: closure record

**Audience:** epic coordinators, planning leads, security reviewers, and governance stakeholders
reviewing the end-to-end delivery and independent closure verification of
[Epic #1556](https://github.com/oscharko-dev/Keiko/issues/1556) ("Complete Colleague-Like Voice
Dialogue Mode").

Epic #1556 extends the completed Voice Digital Twin foundation (Epic #491,
[epic-491-closure.md](epic-491-closure.md)) into a finished, production-ready bidirectional dialogue
experience: a user can toggle dialog mode in the Keiko chat, choose a male, female, or neutral
assistant voice, speak naturally, hear Keiko answer from the _same_ grounded chat context as text chat,
interrupt, mute, stop, and leave safely — all over the existing chat, model-gateway, evidence, memory,
and local-knowledge surfaces, with no parallel assistant and no raw-audio or secret persistence.

This record consolidates the epic Definition of Done, the child delivery rollup, the independent
verification performed at closure under [Issue #1564](https://github.com/oscharko-dev/Keiko/issues/1564)
(the closure gate), and the final security / performance / accessibility evidence summary
(Deliverable 3). It is the parent-epic closure update (Deliverable 4).

The authoritative closure evidence is posted to Issue #1564 and to Epic #1556 as closure comments.

## Closure Verdict

**All seven epic Target Outcomes, all four Issue #1564 Acceptance Criteria, and all epic
Definition-of-Done items are satisfied** by the union of the merged child deliverables (#1557–#1564),
independently re-verified at closure on `feat/keiko-colleague-like-voice-dialogue-mode` HEAD
`c75af49d`. Issue #1564 is the closure gate and, consistent with its Engineering Notes, introduced **no
product code change**: it is a reuse-first verification, documentation, and closure capstone. A later
Epic #1556 audit repair added the narrow `media-src 'self' blob:` CSP directive needed for generated
assistant audio playback without widening script, network, or provider egress policy. A
three-lens adversarial regression review found **zero** defects, broken invariants, or unproven
acceptance claims that block closure. One named, non-blocking operational note is documented (the
development profile's `keiko-stt`-only convenience yields dictation, not full dialogue; full dialogue
requires an output/realtime provider with personas — by design, see
[dialogue-provider-runbook.md](dialogue-provider-runbook.md) §1/§3).

## Epic Acceptance Ledger

| Acceptance Criterion / Target Outcome                                                                         | Status      | Independent Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Delivered By        |
| ------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **AC1 — Converse in dialog mode via configured voice providers** (TO1/TO3/TO5)                                | ✅ Verified | `useVoiceDialogueSession.ts` drives the mic→dictation→user-end-of-turn→chat-send turn loop; `useVoiceDialogMode.ts:92,132-142` and `voice-dialogue-session.ts` (`voiceDialogueModeForResolution`) gate the switch+session on the STT+TTS+persona conjunction, fail-closed. Browser smoke drives the real composer headless: switch appears, two spoken turns commit, leave releases the mic and keeps text chat usable.                                                                                                                                    | #1559, #1560, #1561 |
| **AC2 — Spoken answers match visible answers, grounded in files + chat context** (TO4)                        | ✅ Verified | `useAssistantSpeech.ts:42-50,179-211` synthesizes **only** the latest _complete_ assistant message's rendered `content`, keyed by its stable id — the same string ChatWindow renders — so spoken cannot diverge from visible; synthesis fires only after the stream settles (over-long answers degrade to text via 413, never truncated). The committed spoken transcript is sent through the _same_ chat-send path as a typed message (`useVoiceDialogueSession.context-grounding.test.tsx`), so attachments/repo/local-knowledge grounding is identical. | #1558, #1560, #1561 |
| **AC3 — Male / female / neutral selectable and persistent for the active config/session**                     | ✅ Verified | `VOICE_PERSONAS = ["male","female","neutral"]` (`keiko-contracts/src/gateway.ts:76,80`), surfaced content-free as `availableVoicePersonas`. `useVoiceDialogMode.ts:45-72,94-130` persists the persona **enum** (never a voice id) to `localStorage` key `keiko.voice.dialog.persona`, re-validated fail-closed on mount. Server resolves persona→`voiceId` server-side only (`voice-handlers.ts:537-575`, `selectVoicePersonaVoice`); unsupported persona → 400 `INVALID_PERSONA`. New e2e walks all three personas + reload persistence.                  | #1557, #1558, #1559 |
| **AC4 — All child issues closed, required checks passed, closure evidence recorded** (TO7)                    | ✅ Verified | #1557–#1564 all `CLOSED`/`COMPLETED` with per-issue closure comments and merged into HEAD `c75af49d`; this record + the Issue #1564 closure comment capture the closure evidence; required `ci` green on the #1564 PR head.                                                                                                                                                                                                                                                                                                                               | #1562, #1563, #1564 |
| **TO2 — Choose voice before or during dialog mode**                                                           | ✅ Verified | Persona selector renders all offered personas with a visible active-voice label and is operable before entering and mid-session (`VoiceDialogMode.tsx:30-38,111-151`; e2e voice-selection test).                                                                                                                                                                                                                                                                                                                                                           | #1559               |
| **TO6 — Fail-closed across permission denial, device/network loss, unsupported browser, missing creds**       | ✅ Verified | Single capability predicate gates everything fail-closed (undefined/none/partial → no switch); kill-switch `KEIKO_VOICE_DISABLED` and Permissions-Policy `microphone=()`/`(self)` enforced; mic acquired only on explicit gesture and released on every exit path (`useDictation.ts` `startingRef`/`cancelledRef`; e2e mic-lifecycle asserts `getUserMedia==0` on enter, `==1` on gesture, `track.stop>=1` on leave).                                                                                                                                      | #1560, #1562        |
| **DoD — No raw/generated audio, provider secret, provider body, or token-bearing artifact persisted/exposed** | ✅ Verified | Voice hooks and the server speak/transcribe handlers emit no audio/transcript/secret to evidence, logs, or memory; synthesized audio lives only for one turn (object URL revoked in teardown); responses carry only `audio`+`mimeType`. Verified by the #1562 threat model §5 matrix and `voice-handlers.dialogue-safety.test.ts`.                                                                                                                                                                                                                         | #1562               |

## Child Delivery Rollup

| Issue | Title                                                          | PR(s)        | Merge SHA(s)           |
| ----- | -------------------------------------------------------------- | ------------ | ---------------------- |
| #1557 | Extend voice provider capability registry (personas, realtime) | #1566        | `b1e8da3f`             |
| #1558 | Assistant speech output through the Model Gateway              | #1568        | `467dcbbe`             |
| #1559 | Chat dialog-mode switch + voice profile selection UX           | #1582, #1583 | `aa9f99ac`, `3de8f470` |
| #1560 | Full-duplex dialogue turns, interruption, STT+TTS fallback     | #1586, #1592 | `de36514b`, `59bd0a18` |
| #1561 | Ground spoken dialogue in files/repo/memory/local knowledge    | #1590        | `3643101a`             |
| #1562 | Harden privacy, permissions, audit evidence, voice safety      | #1594        | `951b93b7`             |
| #1563 | Production evaluation (latency, cleanup, accessibility)        | #1595        | `b39c059e`             |
| #1564 | Finalize end-to-end delivery, runbooks, and closure evidence   | #1596        | `c75af49d`             |

All child PRs are merged into `feat/keiko-colleague-like-voice-dialogue-mode`; merge-commit signatures
are GitHub-verified. Children #1557–#1564 are `CLOSED` with state reason `COMPLETED`.

## Independent Verification Performed at Closure

Performed by the coordinator at closure through PR #1596 on HEAD `c75af49d`:

- **Deterministic gates (local):**
  - `npm run typecheck` — clean; `npm run typecheck --workspace @oscharko-dev/keiko-ui` (the stricter
    package-local `tsc --noEmit` the CI `ui` job runs) — clean.
  - `npm run lint` — clean (eslint `--max-warnings=0` + keiko-ui eslint).
  - `npm run arch:check` — PASS (ADR-0019 import-policy); `npm run arch:check:negative` — PASS
    (forbidden edges still rejected).
- **Executable voice evidence (local):**
  - keiko-ui voice/dialogue-related suites: **45 files / 776 tests passed** (dialogue session, hook,
    persona selection/persistence, assistant speech, dictation lifecycle, evaluation profiles/latency/
    cleanup/accessibility).
  - keiko-server voice suites: **7 files / 152 tests passed** (capability gating, speak/persona
    resolution, dialogue-safety/non-persistence).
  - e2e voice-dialogue browser smoke: **7 / 7 passed** in headless Chromium against the real app path
    (no-voice gating, STT+TTS fallback turn loop, mic lifecycle, partial-profile gating, voice
    selection + live status), regenerating the evidence screenshots under `docs/voice/evidence/`.
- **Credential mapping validation (`oscharko-dev` dev profile, no secrets):** an authenticated,
  secret-free reachability probe against the Azure Foundry voice resource
  (`<host>.services.ai.azure.com/openai/v1`, Sweden Central) returned **HTTP 200** with the staged key
  and **HTTP 401** with a deliberately wrong key — confirming the endpoint is reachable and the staged
  credential authenticates. The probe printed only HTTP status codes and non-secret model identifiers;
  it sent no audio and persisted nothing. Procedure recorded in
  [dialogue-provider-runbook.md](dialogue-provider-runbook.md) §4.
- **Adversarial regression review:** a three/five-lens skeptic review (spoken==visible divergence,
  persona persistence + server-side voice-id confinement, microphone/audio teardown, privacy
  non-persistence, capability gating) attempted to refute every high-risk claim and **confirmed zero
  blocking defects** — the merged feature is closure-ready.

## Security / Performance / Accessibility Evidence Summary (Deliverable 3)

| Dimension         | Disposition      | Authoritative evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security**      | ✅ Signed off    | [dialogue-mode-threat-model.md](dialogue-mode-threat-model.md) — STT+TTS (not WebRTC) data path, trust boundaries, §5 acceptance-criteria→evidence matrix, §7 "security review complete" disposition. Browser never receives a secret or voice id; credentials stay server-side; `voice-handlers.dialogue-safety.test.ts` asserts non-persistence. Generated audio playback is permitted by the narrow `media-src 'self' blob:` CSP directive only; `connect-src` and `script-src` are not widened. [privacy-contract.md](privacy-contract.md) governs redaction. Permissions-Policy / kill-switch validation in [operator-runbook.md](operator-runbook.md) §4. |
| **Performance**   | ✅ Within budget | [dialogue-evaluation-report.md](dialogue-evaluation-report.md) — content-free per-leg latency budgets across the turn loop, interruption/barge-in responsiveness, and long-session resource-cleanup ledger (no leaked microphone tracks or audio elements over repeated turns).                                                                                                                                                                                                                                |
| **Accessibility** | ✅ WCAG-clean    | [dialogue-evaluation-report.md](dialogue-evaluation-report.md) accessibility dimension — `jest-axe` **0 violations**, full keyboard operability of the switch / persona selector / Speak / Interrupt / mute / stop controls, live-region status announcements (`voice-dialog-state.ts` headlines), and colour-independent state signalling.                                                                                                                                                                    |

## Known Limitation and Follow-Ups

**Named limitation (documented, non-blocking):**

The `oscharko-dev` development profile, when only `keiko-stt` is registered (the default convenience),
resolves to the `speech-to-text` profile — composer dictation, not full spoken dialogue. Full dialogue
mode requires additionally registering a speech-output or realtime provider with `voiceProfiles`
(personas), exactly as documented in [dialogue-provider-runbook.md](dialogue-provider-runbook.md) §1/§3.
This is by-design capability gating, not a defect; the dialogue switch correctly fails closed when the
output half is absent.

**Recommended, non-blocking follow-ups (deferred):**

- Carry forward the Epic #491 follow-ups that remain open (positive egress allowlist; transitive
  lockfile scan for denied media packages) — they are unchanged by this epic.
- Optional realtime WebRTC media transport for controlled networks that can supply TURN relays (an
  additional dependency + architecture decision, out of scope for this epic, which ships the
  production-default STT+TTS turn loop).

## Sign-Off

Signed-off-by: Claude coordinator implementation team.
