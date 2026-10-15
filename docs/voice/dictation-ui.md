# Composer dictation UX (Issue #495)

Implemented by Issue [#495](https://github.com/oscharko-dev/Keiko/issues/495) (Epic #491). This document
describes the user-facing speech-to-text dictation experience in the chat composer. It builds on the
capability metadata from [#493](capability-configuration.md) and the BFF speech-to-text route from
[#494](dictation-endpoint.md). It is **STT dictation only** — it never offers Twin conversation,
assistant speech playback. Native live transcription, when configured, and Voice Dialogue are governed by
[ADR-0154](../adr/ADR-0154-canonical-twin-voice-pipeline.md).

## Capability gating

The composer consults the content-free voice-capability resolution (`GET /api/voice/capability`) before it
renders any voice affordance, and the probe **never blocks composer rendering**:

- The probe is fired lazily on first composer mount and is module-cached, so the multiple composer instances
  in the desktop shell share a single request (`useVoiceCapability`).
- Until the probe resolves — and if it ever fails — the composer renders fully and shows **no** microphone
  affordance. A no-voice deployment is therefore clean, stable, and fully text-capable (AC1).
- The microphone affordance appears only when **both** conditions hold:
  1. the resolution reports `available === true` and `capabilities.speechToText === true`, and
  2. the browser can capture audio (`navigator.mediaDevices.getUserMedia` and `MediaRecorder` are present).

When voice is disabled by policy (`KEIKO_VOICE_DISABLED`), unconfigured, unreachable, or unsupported by the
browser, the affordance is simply absent — there is no broken or disabled-looking control.

## Dictation flow

1. **Start** — the user clicks the microphone button (an explicit gesture; there is never background
   capture, AC3). `getUserMedia` requests microphone access and `MediaRecorder` begins capture using native
   browser APIs only — no third-party recorder package is added.
2. **Record** — the same button becomes a labelled stop square. A waveform displays actual microphone
   levels in the free space between the model/skill controls and the microphone. New samples enter on
   the right and move left; the oldest third fades to full transparency before the skill controls.
   Model selection, Skills, and the selected skill remain visible. Recording auto-stops at 120 s.
3. **Stop and transcribe** — one click on the square stops capture and uses the configured transcription
   route. The same control announces finishing/transcribing while the result is pending.
4. **Edit the draft** — the completed transcript is appended directly to the existing composer draft,
   once, and focus returns to the composer. There is no separate review panel or Insert/Re-record/Discard
   step in ordinary Chat. The user can edit, dictate again, or send through the normal composer flow.
   Dictation never auto-sends. The Coding Workbench retains its explicit preview/insertion flow.
   Switching the conversation cancels the active capture and rejects its pending transcript.
   An empty result leaves the draft unchanged and displays a brief instruction to try the microphone
   again; no additional action buttons appear.

## Failure handling

Every failure resolves to a non-blocking message that leaves the composer fully usable (AC4):

| Condition                               | UI outcome                                                          |
| --------------------------------------- | ------------------------------------------------------------------- |
| Microphone permission denied            | Alert: allow microphone access, then retry with the microphone.     |
| No microphone device                    | Alert: connect a microphone and try again.                          |
| Browser cannot capture                  | No microphone affordance is rendered at all.                        |
| `VOICE_UNAVAILABLE` (503)               | Alert: dictation is not available right now.                        |
| Provider error / timeout / rate-limited | Alert: dictation could not be completed; retry with the microphone. |

## Privacy

The microphone's accessible description explains that audio goes only to the configured speech-to-text
endpoint. Keiko holds capture audio in memory and does not log it. Once inserted, recognized text is an
ordinary editable composer draft and follows the existing private draft persistence policy. The existing
Activity Log records the closed `dictation-inserted` or `dictation-empty` completion category and
`dictation-context-changed` when a conversation switch cancels the flow;
no audio, transcript, selected-skill content, or endpoint enters this diagnostic.

## Permissions-Policy scoping

Browser microphone access is governed by the `Permissions-Policy` response header. The BFF keeps the strict
default `microphone=()` and relaxes it to `microphone=(self)` **only** when the resolved voice capability
advertises speech-to-text (and voice is not disabled by policy). A no-voice deployment therefore keeps the
microphone fully disabled at the platform level — the relaxation is scoped to exactly the deployments that
need it (ADR-0100 D6; see [privacy-contract.md](privacy-contract.md)). The directive is never widened beyond
`(self)`.

## Accessibility

- The microphone button carries a dynamic `aria-label` (start / stop / starting / transcribing), `aria-pressed`
  while recording, and `aria-describedby` the local-only privacy disclosure.
- State transitions are announced through polite `role="status"` regions; failures use `role="alert"`.
- Focus returns to the editable composer after transcription. Errors leave the same microphone available
  for retry; there is no additional button row.
- The waveform reflects measured levels only, uses a bounded history, and clears its timer and samples
  when capture ends. It does not invent sound activity. Its graphics are hidden from assistive technology;
  the polite status announces recording/transcription instead. All controls are keyboard operable.

## Tests and evidence

- Executable AC coverage (runs in the required `ci` check): `packages/keiko-ui` vitest suites for
  `useVoiceCapability`, `useDictation`, `dictation-recorder`, `VoiceDictation`, and the `ChatWindow` dictation
  integration (enabled / disabled / denied / provider-error / no-voice), plus axe checks; the
  `transcribeDictation` client test in `src/lib/api.test.ts`; and the server-side `headers` and
  `isVoiceDictationCapable` tests for the Permissions-Policy scoping.
- Browser evidence: `tests/e2e/voice-dictation.smoke.spec.ts` (`@smoke`) drives the real app composer in
  headless Chromium for the no-voice path and the stubbed STT flow (fake `MediaRecorder`, stubbed transcribe).
