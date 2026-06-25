# Composer dictation UX (Issue #495)

Implemented by Issue [#495](https://github.com/oscharko-dev/Keiko/issues/495) (Epic #491). This document
describes the user-facing speech-to-text dictation experience in the chat composer. It builds on the
capability metadata from [#493](capability-configuration.md) and the BFF speech-to-text route from
[#494](dictation-endpoint.md). It is **STT dictation only** — it never offers full Voice Digital Twin
conversation, assistant speech playback, or realtime transport (those remain out of scope per
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md)).

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
2. **Record** — the button flips to a clearly-labelled stop control with a recording indicator. Recording
   auto-stops at the dictation limit (120 s) so a clip can never exceed the BFF's accepted duration.
3. **Transcribe** — on stop, the captured audio is base64-encoded and posted to
   `POST /api/voice/transcribe` inside the standard JSON + CSRF envelope. The audio is held only in memory
   for the request and is never written to disk or logged on the client.
4. **Review** — the returned transcript appears in an editable preview with **Insert**, **Re-record**, and
   **Discard** actions. The user can edit the text before inserting.
5. **Insert** — inserting appends the reviewed transcript to the composer draft and returns focus to the
   textarea. Dictation never auto-sends; the user sends through the normal composer flow.

## Failure handling

Every failure resolves to a non-blocking message that leaves the composer fully usable (AC4):

| Condition                               | UI outcome                                                            |
| --------------------------------------- | --------------------------------------------------------------------- |
| Microphone permission denied            | Alert: allow microphone access; retry / dismiss. Composer unaffected. |
| No microphone device                    | Alert: connect a microphone and try again.                            |
| Browser cannot capture                  | No microphone affordance is rendered at all.                          |
| `VOICE_UNAVAILABLE` (503)               | Alert: dictation is not available right now.                          |
| Provider error / timeout / rate-limited | Alert: dictation could not be completed; retry / dismiss.             |

## Privacy

The preview surface carries a permanently-visible, screen-reader-discoverable disclosure: **"Audio is sent
only to your configured speech-to-text endpoint and is not stored."** The transcribe response is content-free
apart from the transcript and provider-neutral metadata (no base URL, credential, or model id), by
construction on the BFF side (#494). The edited transcript lives only in component state and is discarded
without persistence when the user discards the preview.

## Permissions-Policy scoping

Browser microphone access is governed by the `Permissions-Policy` response header. The BFF keeps the strict
default `microphone=()` and relaxes it to `microphone=(self)` **only** when the resolved voice capability
advertises speech-to-text (and voice is not disabled by policy). A no-voice deployment therefore keeps the
microphone fully disabled at the platform level — the relaxation is scoped to exactly the deployments that
need it (ADR-0058 D6; see [privacy-contract.md](privacy-contract.md)). The directive is never widened beyond
`(self)`.

## Accessibility

- The microphone button carries a dynamic `aria-label` (start / stop / starting / transcribing), `aria-pressed`
  while recording, and `aria-describedby` the local-only privacy disclosure.
- State transitions are announced through polite `role="status"` regions; failures use `role="alert"`.
- Focus moves to the transcript field when the preview appears and to the retry action when an error appears;
  discarding returns focus to the microphone button.
- The recording indicator is a solid colour by default and only animates under
  `prefers-reduced-motion: no-preference` (WCAG 2.3.3); all controls are fully keyboard operable.

## Tests and evidence

- Executable AC coverage (runs in the required `ci` check): `packages/keiko-ui` vitest suites for
  `useVoiceCapability`, `useDictation`, `dictation-recorder`, `VoiceDictation`, and the `ChatWindow` dictation
  integration (enabled / disabled / denied / provider-error / no-voice), plus axe checks; the
  `transcribeDictation` client test in `src/lib/api.test.ts`; and the server-side `headers` and
  `isVoiceDictationCapable` tests for the Permissions-Policy scoping.
- Browser evidence: `tests/e2e/voice-dictation.smoke.spec.ts` (`@smoke`) drives the real app composer in
  headless Chromium for the no-voice path and the stubbed STT flow (fake `MediaRecorder`, stubbed transcribe).
