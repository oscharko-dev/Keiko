# Epic #1556 — Colleague-Like Voice Dialogue Mode: closure record

**Audience:** epic coordinators, planning leads, security reviewers, and governance stakeholders
reviewing the end-to-end delivery and independent closure verification of
[Epic #1556](https://github.com/oscharko-dev/Keiko/issues/1556) ("Complete Colleague-Like Voice
Dialogue Mode").

> **Historical evidence:** this record is fixed to the Epic #1556 closure head and preserves the former
> STT+TTS dialogue design. ADR-0154 supersedes that design: productive Twin Voice now requires input-only
> Realtime transcription, canonical chat, and independent TTS. Counts and pass statements below are not
> current-head evidence. The renewed Oliver live-microphone acceptance test has not been performed and
> remains deferred to the agreed office appointment.

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

The ledger below records the original closure decision. Its STT+TTS fallback, latest-message speech
selection, and provider-readiness assumptions are historical and must not be used as current normative
behavior; ADR-0154 and the exact-head audit are authoritative.

| Acceptance Criterion / Target Outcome                                                                         | Status      | Independent Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Delivered By        |
| ------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **AC1 — Converse in dialog mode via configured voice providers** (TO1/TO3/TO5)                                | ✅ Verified | `useVoiceDialogueSession.ts` drives the mic→dictation→user-end-of-turn→chat-send turn loop; `useVoiceDialogMode.ts:92,132-142` and `voice-dialogue-session.ts` (`voiceDialogueModeForResolution`) gate the switch+session on the STT+TTS+persona conjunction, fail-closed. Browser smoke drives the real composer headless: switch appears, two spoken turns commit, leave releases the mic and keeps text chat usable.                                                                                                                                    | #1559, #1560, #1561 |
| **AC2 — Spoken answers match visible answers, grounded in files + chat context** (TO4)                        | ✅ Verified | `useAssistantSpeech.ts:42-50,179-211` synthesizes **only** the latest _complete_ assistant message's rendered `content`, keyed by its stable id — the same string ChatWindow renders — so spoken cannot diverge from visible; synthesis fires only after the stream settles (over-long answers degrade to text via 413, never truncated). The committed spoken transcript is sent through the _same_ chat-send path as a typed message (`useVoiceDialogueSession.context-grounding.test.tsx`), so attachments/repo/local-knowledge grounding is identical. | #1558, #1560, #1561 |
| **AC3 — Male / female / neutral selectable and persistent for the active config/session**                     | ✅ Verified | `VOICE_PERSONAS = ["male","female","neutral"]` (`keiko-contracts/src/gateway.ts:76,80`), surfaced content-free as `availableVoicePersonas`. `useVoiceDialogMode.ts:45-72,94-130` persists the persona **enum** (never a voice id) to `localStorage` key `keiko.voice.dialog.persona`, re-validated fail-closed on mount. Server resolves persona→`voiceId` server-side only (`voice-handlers.ts:537-575`, `selectVoicePersonaVoice`); unsupported persona → 400 `INVALID_PERSONA`. New e2e walks all three personas + reload persistence.                  | #1557, #1558, #1559 |
| **AC4 — All child issues closed, required checks passed, closure evidence recorded** (TO7)                    | ✅ Verified | #1557–#1564 all `CLOSED`/`COMPLETED` with per-issue closure comments and merged into HEAD `c75af49d`; this record + the Issue #1564 closure comment capture the closure evidence; required `ci` green on the #1564 PR head.                                                                                                                                                                                                                                                                                                                                | #1562, #1563, #1564 |
| **TO2 — Choose voice before or during dialog mode**                                                           | ✅ Verified | Persona selector renders all offered personas with a visible active-voice label and is operable before entering and mid-session (`VoiceDialogMode.tsx:30-38,111-151`; e2e voice-selection test).                                                                                                                                                                                                                                                                                                                                                           | #1559               |
| **TO6 — Fail-closed across permission denial, device/network loss, unsupported browser, missing creds**       | ✅ Verified | Single capability predicate gates everything fail-closed (undefined/none/partial → no switch); kill-switch `KEIKO_VOICE_DISABLED` and Permissions-Policy `microphone=()`/`(self)` enforced; mic acquired only on explicit gesture and released on every exit path (`useDictation.ts` `startingRef`/`cancelledRef`; e2e mic-lifecycle asserts `getUserMedia==0` on enter, `==1` on gesture, `track.stop>=1` on leave).                                                                                                                                      | #1560, #1562        |
| **DoD — No raw/generated audio, provider secret, provider body, or token-bearing artifact persisted/exposed** | ✅ Verified | The closure checks covered ephemeral audio and secret confinement. Under current ADR-0154 semantics, raw audio and partial transcripts remain unpersisted, while the settled final transcript is intentionally persisted through canonical chat.                                                                                                                                                                                                                                                                                                           | #1562               |

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
  - The named keiko-ui and keiko-server voice/dialogue suites passed at the recorded closure head.
  - The historical headless browser smoke passed against the then-current STT+TTS flow. Test discovery
    and counts belong to the archived run and are not copied forward.
- **Credential mapping validation (`oscharko-dev` historical dev profile):** the closure coordinator
  recorded a provider authentication check. The current runbook deliberately does not reproduce a raw
  shell probe because credentials must not appear in process arguments; use Keiko's Gateway Setup
  save/verification flow instead.
- **Adversarial regression review:** a three/five-lens skeptic review (spoken==visible divergence,
  persona persistence + server-side voice-id confinement, microphone/audio teardown, privacy
  non-persistence, capability gating) attempted to refute every high-risk claim and **confirmed zero
  blocking defects** — the merged feature is closure-ready.

## Security / Performance / Accessibility Evidence Summary (Deliverable 3)

| Dimension         | Disposition      | Authoritative evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security**      | ✅ Signed off    | [dialogue-mode-threat-model.md](dialogue-mode-threat-model.md) — STT+TTS (not WebRTC) data path, trust boundaries, §5 acceptance-criteria→evidence matrix, §7 "security review complete" disposition. Browser never receives a secret or voice id; credentials stay server-side; `voice-handlers.dialogue-safety.test.ts` asserts non-persistence. Generated audio playback is permitted by the narrow `media-src 'self' blob:` CSP directive only; `connect-src` and `script-src` are not widened. [privacy-contract.md](privacy-contract.md) governs redaction. Permissions-Policy / kill-switch validation in [operator-runbook.md](operator-runbook.md) §4. |
| **Performance**   | ✅ Within budget | [dialogue-evaluation-report.md](dialogue-evaluation-report.md) — content-free per-leg latency budgets across the turn loop, interruption/barge-in responsiveness, and long-session resource-cleanup ledger (no leaked microphone tracks or audio elements over repeated turns).                                                                                                                                                                                                                                                                                                                                                                                 |
| **Accessibility** | ✅ WCAG-clean    | [dialogue-evaluation-report.md](dialogue-evaluation-report.md) accessibility dimension — `jest-axe` **0 violations**, full keyboard operability of the switch / persona selector / Speak / Interrupt / mute / stop controls, live-region status announcements (`voice-dialog-state.ts` headlines), and colour-independent state signalling.                                                                                                                                                                                                                                                                                                                     |

## Known Limitation and Follow-Ups

**Historical named limitation:**

The closure record correctly noted that `keiko-stt` alone provides composer dictation, not spoken
dialogue. Its former statement that speech output or Realtime plus `voiceProfiles` was sufficient is
superseded. ADR-0154 now requires Realtime WebRTC input with an explicit transcription deployment plus a
separate speech-output provider carrying the persona mapping.

**Recommended, non-blocking follow-ups (deferred):**

- Carry forward the Epic #491 follow-ups that remain open (positive egress allowlist; transitive
  lockfile scan for denied media packages) — they are unchanged by this epic.
- Realtime WebRTC subsequently shipped under ADR-0102, without caller-configured TURN relays. Custom relay
  support remains a separate future architecture, credential, and egress decision.

## Sign-Off

Signed-off-by: Claude coordinator implementation team.
