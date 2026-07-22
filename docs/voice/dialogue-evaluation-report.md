# Voice dialogue mode — historical verification report (Issue #1563)

**Historical verdict: GO at the Issue #1563 head.** The then-current colleague-like voice dialogue mode
(Epic #1556) passed its production evaluation. This report is the archived closure evidence for Issue
[#1563](https://github.com/oscharko-dev/Keiko/issues/1563). The evaluation specification is
[dialogue-evaluation.md](dialogue-evaluation.md).

The deterministic suites ran with no live voice provider, model call, clock, or network read, and no stored
audio. The browser smoke drove the application through headless Chromium with injected fakes. The manual
headphone walkthrough recorded below belongs only to that historical closure. It is not the renewed Oliver
live-microphone acceptance test for ADR-0154; that current test remains deferred to the agreed office
appointment.

ADR-0154 supersedes this report's STT+TTS dialogue fallback. Current Twin Voice requires input-only
Realtime transcription, canonical chat, and independent TTS, and current readiness comes from exact-head
gates plus the separately recorded live test.

## Result summary

| Dimension                                    | Acceptance Criterion | Result | Evidence                                                 |
| -------------------------------------------- | -------------------- | ------ | -------------------------------------------------------- |
| Capability-profile coverage + no-voice teeth | AC1                  | PASS   | `index.test.ts`, `voice-dialogue.smoke.spec.ts`          |
| Latency / interruption recording + budgets   | AC2                  | PASS   | `latency.test.ts`                                        |
| Long-session resource-cleanup ledger         | AC3                  | PASS   | `cleanup.test.tsx`                                       |
| Consolidated accessibility audit             | AC4                  | PASS   | `accessibility.test.tsx`, `voice-dialogue.smoke.spec.ts` |

## AC1 — capability-profile coverage

All five configured profiles resolve to the correct control gating, scored against the real production
gate `voiceDialogueModeForResolution`:

| Profile                      | Dialogue offered? | Expected | Outcome |
| ---------------------------- | ----------------- | -------- | ------- |
| `no-voice`                   | no                | no       | pass    |
| `stt-only`                   | no                | no       | pass    |
| `speech-output-only`         | no                | no       | pass    |
| `stt-tts` (STT+TTS fallback) | yes               | yes      | pass    |
| `realtime-capable`           | yes               | yes      | pass    |

The "catch a no-voice deployment incorrectly rendering dialog controls" requirement is enforced by a unit
test that injects a deliberately broken gate (offers dialogue for every deployment); the no-voice profile
then fails and the summary flips to `NO-GO`, proving the comparator has teeth. The browser smoke
independently confirms the dialogue switch is absent for `no-voice`, `stt-only`, and `speech-output-only`
and present for the STT+TTS fallback.

## AC2 — latency / interruption evidence (recorded, content-free)

Latency and interruption evidence is recorded through the turn manager's content-free observer
(`latencyMs` per transition; interruption count and time in the snapshot). Every observation carries only
a closed-vocabulary leg label and an integer millisecond reading — a structural assertion confirms the
recorded evidence contains no data URL, audio marker, SDP, or transcript text. The four named legs score
within budget, and an over-budget reading is caught:

| Leg                    | Budget  | Controlled by          | Result                                   |
| ---------------------- | ------- | ---------------------- | ---------------------------------------- |
| `start-latency`        | 1500 ms | client (deterministic) | within budget                            |
| `interruption-latency` | 300 ms  | client (deterministic) | within budget                            |
| `end-of-turn-latency`  | 4000 ms | speech provider        | within budget (injected); manual closure |
| `time-to-first-audio`  | 4000 ms | speech provider        | within budget (injected); manual closure |

## AC3 — long-session cleanup

An eight-turn dialogue session driven over the live `useVoiceDialogueSession` hook, then stopped and
unmounted, leaves a fully balanced resource ledger:

- microphone tracks: acquired == released (== 8);
- audio elements: created == torn down (== 8);
- synthesized object URLs: created == revoked (== 8);
- timers: 0 pending after teardown (the dictation auto-stop timer is drained);
- realtime connections: 0 opened (the dialogue path is STT+TTS, ADR-0096 D7).

## AC4 — accessibility

The consolidated audit passes all seven checks across every dialogue surface and session state: an
automated `jest-axe` pass with zero violations; native button/switch keyboard operability; stable
accessible names; focus return to the Leave control on error; a polite live-region status (alert on
error); reduced-motion-independent comprehension (the animated dot is `aria-hidden`, the headline carries
the state in text); and colour-independent status (a distinct text headline and `data-dialog-state`
attribute per state). The browser smoke captures the active surface with the "Listening to you." live
status in [evidence/1563-dialogue-evaluation.png](evidence/1563-dialogue-evaluation.png).

## Commands and outcomes

| Command                                                                                                                  | Outcome                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `npx vitest run --config packages/keiko-ui/vitest.config.ts src/app/components/desktop/hooks/voice-dialogue-evaluation/` | PASS at the archived Issue #1563 head; current discovery belongs to the exact run.                    |
| `npm run test:coverage:ui`                                                                                               | PASS at the archived head; current floors and values come from the committed baseline and exact gate. |
| `npm run test:e2e:smoke` (voice-dialogue spec)                                                                           | PASS at the archived head; the scenario implemented the now-superseded STT+TTS flow.                  |
| `npm run typecheck`                                                                                                      | PASS                                                                                                  |
| `npm run lint`                                                                                                           | PASS (0 warnings)                                                                                     |
| `npm run arch:check`                                                                                                     | PASS (no dependency violations; import policy passed)                                                 |
| `npm run build:ui`                                                                                                       | PASS (ES2019 compatibility; CSP hashes written)                                                       |

## Known limitations

- **Wall-clock provider latency** (STT transcribe, TTS synthesis) is provider- and network-dependent and
  is out of the deterministic harness boundary, consistent with the Voice Digital Twin harness (#505,
  `evaluation-harness.md` §6). The deterministic suite proves the measurement, recording, and budget
  scoring; the provider legs carried a budget for the historical manual headphone walkthrough. That
  walkthrough exercised the then-current surface and must not be cited as the renewed ADR-0154/Oliver
  microphone test, which remains outstanding. The browser artifact is synthetic UI evidence only.
- **Realtime (WebRTC) media** is not exercised by dialogue mode; the colleague dialogue path is STT+TTS
  (ADR-0096 D3/D7). The realtime transport (#497) has its own browser smoke.

---

Signed-off-by: Claude coordinator implementation team.
