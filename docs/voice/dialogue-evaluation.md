# Voice dialogue mode — historical production evaluation (Issue #1563)

This document records the production evaluation originally used for the colleague-like **voice dialogue mode** (Epic
[#1556](https://github.com/oscharko-dev/Keiko/issues/1556)). It is the deliverable of Issue
[#1563](https://github.com/oscharko-dev/Keiko/issues/1563) and proves that dialogue mode is responsive,
understandable, interruptible, accessible, and stable enough for the Issue #1563 closure.

> **Current authority:** this specification preserves the superseded STT+TTS dialogue design. ADR-0154
> now requires input-only Realtime transcription, canonical chat, and independent TTS. In particular,
> STT+TTS without WebRTC again offers the dialogue switch through ADR-0154's canonical chat path. The historical headphone walkthrough is not
> the renewed live-microphone checks recorded below for PR #3559.

The evaluation is **verification, not new product behavior**. It adds no runtime dependency, deploys no
model, and changes no production code path. It reuses the shipped dialogue runtime (#1557–#1562) and the
existing test infrastructure.

## PR #3559 verification and conversational quality (2026-09-19)

The renewed local checks use the canonical chat path, the configured Azure deployments, and a
separate loopback LiteLLM container. They do not claim acceptance for every customer deployment.

| Check                                      | Observed evidence                                                                                                                                                                     | Limit                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Actual microphone and speaker conversation | The user confirmed that spoken interruption stops playback and feels responsive after the barge-in repair. The Activity Log records interruption followed by the next canonical turn. | Subjective acceptance; no measured acoustic latency or room/device matrix.              |
| Actual browser controls                    | The existing conversation displays consecutive list numbers; voice mode shows one contextual icon beside the Keiko switch. The microphone was explicitly released after testing.      | Local in-app browser.                                                                   |
| Automated voice journeys                   | Chromium and WebKit each passed all 23 dialogue/dictation cases, including canonical private memory scope, interruption and the separate workbench dictation path.                    | Synthetic media and provider seams; not an acoustic benchmark.                          |
| Firefox                                    | 22 cases passed initially; the reduced-motion return-to-text case passed in isolation after its initial timeout.                                                                      | The initial full run was not green.                                                     |
| LiteLLM with actual Azure upstream         | WAV, MP3, raw PCM, Ogg/Opus, FLAC and AAC speech requests returned successful audio; a synthetic WAV round trip transcribed the expected test phrase.                                 | Existing Azure TTS and `gpt-4o-mini-transcribe`; not the customer's Whisper deployment. |
| LiteLLM Whisper alias                      | A real proxy container discovered and routed an `audio_transcription` alias for Whisper with a deterministic test upstream.                                                           | Confirms metadata/routing compatibility, not real Whisper inference.                    |

Natural dialogue requires separate checks for turn timing, interruptions, pauses, recovery and
context continuity. [Full-Duplex-Bench](https://arxiv.org/abs/2503.04721) evaluates these as distinct
interaction abilities. [Moshi](https://arxiv.org/abs/2410.00037) demonstrates a different, jointly
trained speech architecture; its latency numbers must not be attributed to this cascaded pipeline.
The practical priorities for Keiko are uninterrupted local barge-in detection, retaining the first
words of the new turn, intelligible complete playback, concise spoken wording and canonical private
memory retrieval. Automatic interruption never broadens memory scope or action authority.

The cascaded path deliberately retains canonical chat and its existing memory/governance semantics.
It can provide conversational turn taking, but text mediation does not preserve every prosodic cue
of an end-to-end speech model. Do not describe it as equivalent to one or claim unmeasured latency.
Long silent listening must renew bounded local capture without submitting silence to STT; the VAD
and microphone remain live, and overlap protects speech that begins during buffer replacement.

Official integration references: [LiteLLM transcription](https://docs.litellm.ai/docs/audio_transcription/),
[LiteLLM speech output](https://docs.litellm.ai/docs/text_to_speech/) and
[LiteLLM model management](https://docs.litellm.ai/docs/proxy/model_management).

## Reuse-first design

The evaluation does **not** introduce a separate test runner. It runs under the existing commands:

- `npm run test:coverage:ui` (the `ci` and `ui` GitHub checks) runs the deterministic suites.
- `npm run test:e2e:smoke` (the `ui` GitHub check) runs the browser smoke.

It reuses, rather than re-implements, the shipped runtime as its measurement substrate:

- the production capability gate `voiceDialogueModeForResolution` (the dialogue fallback matrix);
- the live floor-control reducer `createVoiceTurnManager` and its content-free observer (`latencyMs`,
  `interruptions`, interrupt time);
- the `useVoiceDialogueSession` hook and its production seam contract (recorder, transcribe, synthesize,
  audio element, object-URL store) for the long-session cleanup ledger;
- the presentational `VoiceDialogMode` surfaces for the accessibility audit;
- `jest-axe` (already a dev dependency) for the automated accessibility pass.

The contract-boundary Voice Digital Twin evaluation ([#505](evaluation-harness.md), ADR-0110) proves the
profile × environment matrix at the `keiko-contracts` tier and **cannot import `keiko-ui`** (ADR-0019 rule
3l). Because dialogue mode is a `keiko-ui` runtime concern (live hooks, controls, latency, cleanup,
accessibility), this evaluation lives beside the runtime in
`packages/keiko-ui/src/app/components/desktop/hooks/voice-dialogue-evaluation/`. The two evaluations are
complementary: #505 proves the contract tables; #1563 proves the running dialogue surface.

No ADR is added: the evaluation introduces no new architecture boundary and reuses existing seams.

## Files

| File                                                     | Role                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hooks/voice-dialogue-evaluation/index.ts`               | Pure, deterministic scoring engine: profile fixtures, latency budgets, the cleanup and accessibility scorers, the GO/NO-GO summary, and the report renderer. |
| `hooks/voice-dialogue-evaluation/index.test.ts`          | Unit proof of the scorers, the AC1 "teeth", and the GO/NO-GO algebra.                                                                                        |
| `hooks/voice-dialogue-evaluation/latency.test.ts`        | AC2: latency/interruption evidence recorded content-free via the real turn manager, scored against budgets.                                                  |
| `hooks/voice-dialogue-evaluation/cleanup.test.tsx`       | AC3: the long-session resource ledger over the live `useVoiceDialogueSession`.                                                                               |
| `hooks/voice-dialogue-evaluation/accessibility.test.tsx` | AC4: the consolidated accessibility audit (axe + structural) over the dialogue surfaces.                                                                     |
| `tests/e2e/voice-dialogue.smoke.spec.ts`                 | Browser evidence: dialogue lifecycle, voice selection, listening status, and every capability profile's control gating.                                      |
| `docs/voice/dialogue-evaluation-report.md`               | The final verification report (closure evidence).                                                                                                            |

## Historical capability profiles (AC1)

The original evaluation enumerated five configured deployment profiles and asserted that dialogue
controls were offered only when the deployment could both capture user speech and speak the answer (the
full STT+TTS conjunction, ADR-0096 D2). That historical oracle was compared against the then-production
gate; a gate that offered dialogue for a partial or no-voice deployment flipped the verdict to `NO-GO`.

This was the Issue #1563 oracle. Under ADR-0154, the `stt-tts` row below now uses turn-based capture,
canonical chat, and independent TTS. Native Realtime remains available when WebRTC and a suitable
deployment are present.

| Profile                      | `available` / `profile`   | WebRTC media | Issue #1563 historical dialogue? | ADR-0154 current Twin?             |
| ---------------------------- | ------------------------- | ------------ | -------------------------------- | ---------------------------------- |
| `no-voice`                   | `false` / `none`          | no           | **no**                           | **no**                             |
| `stt-only`                   | `true` / `speech-to-text` | no           | **no**                           | **no**                             |
| `speech-output-only`         | `true` / `speech-output`  | no           | **no**                           | **no**                             |
| `stt-tts` (STT+TTS fallback) | `true` / `full-realtime`  | no           | **yes**                          | **yes**, through canonical chat    |
| `realtime-capable`           | `true` / `full-realtime`  | yes          | **yes**                          | **yes**, with explicit TTS/persona |

The Issue #1563 column records the historical scorer and browser-smoke oracle, including the former
STT+TTS fallback. It must not be read as current product acceptance. The ADR-0154 column records the
current architecture: Twin accepts Realtime WebRTC input or turn-based STT capture, then uses canonical
chat and independent explicit TTS with a mapped persona. Current live-microphone evidence is recorded below; it does not replace the historical scorer.

## Latency / interruption (AC2)

Latency and interruption evidence is **recorded content-free** — every observation carries only a
closed-vocabulary leg label and an integer millisecond reading; no transcript text, audio, or SDP can
enter it. The turn manager's observer records `latencyMs` per floor transition and the snapshot records
the interruption count and time; the evaluation consumes these and scores four named legs against
production budgets:

| Leg                                                          | Budget  | Controlled by          |
| ------------------------------------------------------------ | ------- | ---------------------- |
| `start-latency` (gesture → capture armed)                    | 1500 ms | client (deterministic) |
| `interruption-latency` (barge-in → playback stop)            | 300 ms  | client (deterministic) |
| `end-of-turn-latency` (stop speaking → transcript committed) | 4000 ms | speech provider        |
| `time-to-first-audio` (answer settled → playback begins)     | 4000 ms | speech provider        |

The client-controlled legs (arming capture, stopping playback on barge-in) are proven deterministically.
The provider-dependent legs (STT transcribe, TTS synthesis) were budgeted; their wall-clock value depended
on the deployed speech provider and the historical headphone walkthrough recorded in the verification
report. Current live checks are recorded separately below and do not establish a measured provider latency budget. The deterministic
suite proves only the measurement-and-recording path and that an over-budget fixture is caught.

## Long-session cleanup (AC3)

A multi-turn dialogue session is driven over the live `useVoiceDialogueSession` hook and then stopped and
unmounted. A single content-free resource ledger is captured after teardown and must balance across every
resource class:

- every acquired microphone track is released (acquire count == release count);
- every audio element is torn down (paused and `src` cleared);
- every synthesized object URL is revoked (create count == revoke count);
- no timer remains pending (the dictation auto-stop timer is drained);
- in the historical design no Realtime connection was opened because the dialogue path was STT+TTS
  (ADR-0096 D7, superseded by ADR-0154).

Each counter also equals the turn count, so a silently skipped turn is caught. The ledger is the leak
detector: any regressed release path diverges the counts and fails the dimension.

## Accessibility (AC4)

The consolidated accessibility audit runs seven WCAG-relevant checks across every dialogue surface and
session state, then scores them into the same GO/NO-GO scorecard:

- [ ] **axe-clean** — an automated `jest-axe` pass over the composed dialogue surface in every session
      state reports no violations.
- [ ] **keyboard-operable** — every interactive control exposes a native `button`/`switch` role and is
      keyboard operable (Enter/Space).
- [ ] **stable-accessible-names** — the dialogue switch keeps a stable accessible name across its on/off
      state; every control has an accessible name.
- [ ] **focus-return-on-error** — when the session errors, focus moves to the Leave recovery control
      (WCAG 2.4.3).
- [ ] **live-region-status** — the status strip is a polite live region (`role="status"`,
      `aria-live="polite"`) and an `alert` on error.
- [ ] **reduced-motion-independent** — the animated status dot is decorative (`aria-hidden`) and the state
      is always carried by the headline text, so comprehension never depends on motion (motion itself is
      gated behind `prefers-reduced-motion` in `globals.css`).
- [ ] **color-independent-status** — every session state has a distinct text headline and a
      `data-dialog-state` attribute, so status is never conveyed by color alone (WCAG 1.4.1).

## Dimensions → Acceptance Criteria

| Dimension                                    | Acceptance Criterion | Proof                                                    |
| -------------------------------------------- | -------------------- | -------------------------------------------------------- |
| capability-profile coverage + no-voice teeth | AC1                  | `index.test.ts`, `voice-dialogue.smoke.spec.ts`          |
| latency / interruption recording + budgets   | AC2                  | `latency.test.ts`                                        |
| long-session resource ledger                 | AC3                  | `cleanup.test.tsx`                                       |
| consolidated accessibility audit             | AC4                  | `accessibility.test.tsx`, `voice-dialogue.smoke.spec.ts` |

## Reproduction

```bash
# Deterministic suites (the ci / ui GitHub checks):
npm run build:packages
npx vitest run --config packages/keiko-ui/vitest.config.ts \
  src/app/components/desktop/hooks/voice-dialogue-evaluation/

# Full keiko-ui coverage (as ci runs it):
npm run test:coverage:ui

# Browser smoke (the ui GitHub check); regenerates docs/voice/evidence/*.png:
npm run test:e2e:smoke
```

## Report format

`renderDialogueEvaluationReport(scorecard)` renders a content-free closure report: a header with the
schema version, one section per dimension (capability profiles, latency/interruption, long-session
cleanup, accessibility), explicit coverage flags (all-profiles, no-voice-misgating-caught), and a final
`GO` / `NO-GO` verdict. The filled report for this issue is
[dialogue-evaluation-report.md](dialogue-evaluation-report.md).

## Out of scope (per the issue)

- No subjective benchmark that stores real user audio.
- No external telemetry dependency for production acceptance.
- No weakening of CI to accommodate slow voice tests; the deterministic suites run in milliseconds and the
  browser smoke reuses the existing `@smoke` Playwright project.
