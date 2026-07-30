# Voice dialogue providers — configuration and testing runbook (Epic #1556 / Issue #1564)

Final, consolidated runbook for **configuring and functionally testing** the colleague-like voice
dialogue mode end-to-end, delivered as part of the Epic #1556 closure gate ([Issue #1564](https://github.com/oscharko-dev/Keiko/issues/1564)).

This runbook is the **functional companion** to the security-focused
[operator-runbook.md](operator-runbook.md) (Issue #1562). Where the operator runbook proves that a
configured deployment is _safe_ (Permissions-Policy, kill-switch, secret non-leakage, no audio
persistence, incident response), this runbook shows an operator or developer how to _bring up and
exercise_ a working dialogue deployment: which providers to register, how the `oscharko-dev`
development profile maps its Azure Foundry credentials, how to validate provider reachability without
exposing secrets, and how to run the full voice verification matrix.

It does not restate the configuration contract; read these first and treat them as authoritative:

- [capability-configuration.md](capability-configuration.md) — the voice capability model, credential
  resolution precedence, the persona → voice-id config contract, and the degradation ladder.
- [deployment-profile-matrix.md](deployment-profile-matrix.md) — provider × environment profiles,
  credential posture, and persona availability per profile.
- [operator-runbook.md](operator-runbook.md) — credential placement, kill-switch, and the safety
  validation checklist (§4) every deployment must pass.

## 1. What "dialogue mode" requires

The colleague-like dialogue switch is offered only when the resolved capability advertises
**Realtime WebRTC input media**, an independent speech-output deployment, and at least one explicitly
mapped product voice persona. The single predicate is `voiceDialogueModeForResolution`
(`packages/keiko-ui/src/app/components/desktop/hooks/voice-dialogue-session.ts`), which gates both the
switch and the session, fail-closed (ADR-0154 D3). In capability terms:

| Configured providers                                     | Effective profile | Dialogue offered?                   |
| -------------------------------------------------------- | ----------------- | ----------------------------------- |
| None                                                     | `none`            | No (and no voice UI at all)         |
| Speech-to-text only (e.g. `keiko-stt`)                   | `speech-to-text`  | No — dictation only (composer mic)  |
| Speech-output only (e.g. `keiko-tts`)                    | `speech-output`   | No — assistant playback only        |
| STT and speech output, but no Realtime WebRTC + personas | `full-realtime`   | No — push-to-talk helpers only      |
| Realtime WebRTC + TTS with mapped personas               | `full-realtime`   | **Yes** — canonical spoken dialogue |

The practical consequence for bring-up: a deployment that has registered **only** `keiko-stt` (the
default development convenience) gets composer dictation, **not** spoken dialogue. To get the colleague
experience you must register a Realtime input provider plus a separate speech-output provider whose
`voiceProfiles` explicitly map the offered personas. A Realtime-only provider contributes no persona.
STT+TTS without Realtime remains a push-to-talk composition and does not expose the dialogue switch.

## 2. The `oscharko-dev` development profile credentials

The development profile targets Azure AI Foundry voice deployments in **Sweden Central**. The
credentials are staged in the repository-root `.env` for local testing and are **never** read by name
from committed source — `keiko-server` resolves every provider credential through the generic
per-model path, not through `KEIKO_AZURE_FOUNDRY_VOICE_*` names. The staged values are pasted by the
operator into the Gateway Setup wizard
(`packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx` →
`packages/keiko-server/src/gateway-setup.ts`). The server validates the submitted connection, seals the
credential in the local vault, and writes only the credential-free provider configuration and secret
reference to `keiko.config.json`.

| `.env` staging variable (developer convenience)  | Where it lands in the running deployment                                |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `KEIKO_AZURE_FOUNDRY_VOICE_OPENAI_BASE_URL`      | Provider `baseUrl` (OpenAI-compatible v1 surface, ends in `/openai/v1`) |
| `KEIKO_AZURE_FOUNDRY_VOICE_API_KEY`              | Sealed-vault key (`apiKeySecretRef`) or `KEIKO_MODEL_<MODEL>_API_KEY`   |
| `KEIKO_AZURE_FOUNDRY_VOICE_ENDPOINT`             | Cognitive-services endpoint (control-plane / portal reference only)     |
| `KEIKO_AZURE_FOUNDRY_VOICE_REGION` / `_RESOURCE` | Operator reference for locating the deployments in the Azure portal     |

The runtime credential-resolution precedence is unchanged from
[capability-configuration.md §2](capability-configuration.md#2-registering-the-existing-keiko-stt-deployment-stt-only):
`KEIKO_MODEL_<MODEL>_API_KEY` → sealed vault `apiKeySecretRef` → file `apiKey` → `KEIKO_DEFAULT_API_KEY`.
The Azure Foundry voice resource uses the `api-key` header form (not `Bearer`), so the provider record's
`apiKeyHeaderName` is `api-key`.

> **Never commit secrets.** `.env`, the resolved `keiko.config.json` credential block, and the sealed
> vault are local-only artifacts. The Gateway Setup wizard also generates a credentials vault on first
> run — do not add it to version control.

## 3. Bringing up full dialogue mode

To exercise the colleague-like dialogue end-to-end, register the four product roles: optional batch
dictation, Realtime media/VAD, live Realtime transcription, and exact-answer speech output. Using the Foundry
development deployment aliases:

```jsonc
{
  "providers": [
    {
      "modelId": "keiko-stt",
      "baseUrl": "https://<your-foundry-host>/openai/v1",
      "apiKeyHeaderName": "api-key",
      "apiKeySecretRef": "voice/keiko-stt",
      "capability": {
        "kind": "voice",
        "supportsSpeechInput": true,
        "voiceProviderLocality": "azure-foundry",
      },
    },
    {
      "modelId": "keiko-realtime",
      "baseUrl": "https://<your-foundry-host>/openai/v1",
      "apiKeyHeaderName": "api-key",
      "apiKeySecretRef": "voice/keiko-realtime",
      "capability": {
        "kind": "voice",
        "supportsRealtimeVoice": true,
        "realtimeTranscriptionModel": "keiko-realtime-stt",
        "voiceProviderLocality": "azure-foundry",
      },
    },
    {
      "modelId": "keiko-tts",
      "baseUrl": "https://<your-foundry-host>/openai/v1",
      "apiKeyHeaderName": "api-key",
      "apiKeySecretRef": "voice/keiko-tts",
      "capability": {
        "kind": "voice",
        "supportsSpeechOutput": true,
        "voiceProviderLocality": "azure-foundry",
      },
      // Credential-tier persona → provider voice-id mapping (never reaches the browser):
      "voiceProfiles": [
        { "persona": "male", "voiceId": "<provider-male-voice-id>" },
        { "persona": "female", "voiceId": "<provider-female-voice-id>" },
        { "persona": "neutral", "voiceId": "<provider-neutral-voice-id>" },
      ],
    },
  ],
}
```

Voice Dialogue starts only when Realtime WebRTC and independent speech output are both reachable, the
TTS provider has at least one explicit persona mapping, and Realtime declares
`realtimeTranscriptionModel` as the exact provider deployment alias accepted inside its session. Keiko
infers neither that alias nor a provider voice id. The transcription alias is not a second standalone
provider record. STT+TTS alone is not a fluid-dialogue fallback.

## 4. Validating provider readiness without exposing secrets

Use Keiko's Gateway Setup save/verification flow for endpoint and credential validation. Enter the
provider base URL, the provider's declared authentication-header posture, the credential, and each
explicit deployment role in the UI. The BFF performs the bounded provider checks through the Model
Gateway egress seam, seals the credential, and returns only coded success/failure information plus safe
model identifiers. It never returns the submitted key or raw provider error body to the browser.

Do not copy a key from `.env` into a shell variable or pass it to `curl -H`: command arguments are visible
to other local processes and shell tooling even when the command does not print the key. Do not use a raw
provider call as release evidence. A successful Gateway Setup verification is the credential/readiness
check; `GET /api/voice/capability` only confirms the resulting metadata and performs no provider probe.

Functional STT, Realtime transcription, and TTS behavior is then verified through the product-owned paths
in the next section. Those calls must use non-sensitive test content and the configured development
subscription; no new deployment or paid resource is required.

## 5. Functional dialogue walkthrough (headset-style acceptance)

Start Keiko with the voice-capable config and a loopback BFF (default `http://127.0.0.1:1983`):

```bash
keiko ui --port 1983   # or: node scripts/dev-runner.mjs
```

Then walk the colleague-like conversation. Each step maps to an Epic #1556 acceptance criterion:

1. **Ask** — open a chat, toggle **Voice dialogue mode** on, and speak. The switch starts the Realtime
   WebRTC session directly; there is no separate **Start realtime voice** or per-turn **Start speaking**
   button. Low-eagerness semantic VAD and Keiko's continuation window treat short thinking pauses as part of
   the same utterance before the settled transcript enters the existing chat history (AC1).
2. **Listen** — the final user transcript is sent through the normal chat request. The visible canonical
   assistant answer is synthesized through the configured speech-output role; the Realtime provider creates
   no competing answer. Raw audio remains transient and is not stored (AC2).
3. **Ground in files / context** — run this step twice, because the two context sources are separate
   routes and only one of them can carry a turn:
   - **Knowledge Pod / repository scope** — connect the scope, then speak. Verify the spoken user
     message, grounded answer, and sources appear in the same chat, and that MemoriaViva processes the
     turn exactly as it does for typed input (AC2).
   - **Staged attachment** — in a chat with NO connected scope, attach a document, then speak. The chips
     stay visible and removable in the dialogue composer, and the spoken turn carries the same
     attachment descriptors plus extracted document context a typed turn would; the post-send
     "documents included as context" note names exactly the documents that turn carried, and the chips
     clear once it settles (ADR-0154 D1/D5).
     Attachments and a grounding scope cannot be combined: the grounded route has no attachment channel,
     so a typed send is rejected and a spoken turn proceeds without the attachments while surfacing the
     same "Attachments are not supported for grounded chats" notice. Verify that notice rather than
     expecting a grounded answer that also reads the attachment (#2843).
4. **Switch voices** — open the **Voice profile** selector and choose **Male**, **Female**, then
   **Neutral**. The visible active-voice label updates; the next spoken turn uses the chosen persona.
   The selection persists across reload (stored content-free as the persona enum in `localStorage` key
   `keiko.voice.dialog.persona`) (AC3).
5. **Interrupt** — while the assistant is speaking, click **Interrupt the assistant** (barge-in); the
   assistant yields the floor (AC1).
6. **Mute / stop** — toggle mute (the assistant keeps the floor but playback is suppressed) and confirm
   the written answer is unaffected (AC1).
7. **Leave / recover** — click **Leave voice dialogue**. The per-turn controls disappear, the switch
   flips off, the microphone tracks are released, and the composer stays fully text-capable. Re-enter
   and confirm a fresh session starts cleanly (AC1).
8. **Fail-closed paths** — deny the microphone permission, start with no voice provider, start with only
   STT/TTS, use a browser without WebRTC media, or enable the kill-switch (`KEIKO_VOICE_DISABLED=1`); the
   switch is absent or the session fails closed while text chat stays fully usable.

## 6. Automated verification matrix

The behaviours above are pinned deterministically so the walkthrough is a confirmation, not the only
proof. Run, from the repository root:

```bash
# Compile internal packages so contracts/gateway resolve downstream.
npm run build:packages

# Type / lint / architecture gates.
npm run typecheck
npm run typecheck --workspace @oscharko-dev/keiko-ui   # package-local tsc --noEmit (stricter)
npm run lint
npm run arch:check && npm run arch:check:negative

# Voice unit/integration suites (UI workspace config + server suites).
npm run test --workspace @oscharko-dev/keiko-ui -- \
  ChatWindow.voice VoiceDialogMode useVoiceDialogMode useVoiceDialogueSession \
  useAssistantSpeech useDictation useVoiceCapability voice-dialog-state \
  voice-dialogue-session voice-dialogue-evaluation
npm run build:packages && npx vitest run \
  packages/keiko-server/src/voice-handlers.test.ts \
  packages/keiko-server/src/voice-handlers.speak.test.ts \
  packages/keiko-server/src/voice-handlers.dialogue-safety.test.ts

# Browser smoke (real app path, headless Chromium; injects fake media — no hardware, no provider).
npx playwright test --config tests/e2e/config/playwright.config.ts --project=chromium --grep "voice dialogue @smoke"
```

The browser smoke regenerates the acceptance screenshots under `docs/voice/evidence/`
(`1560-dialogue-session.png`, `1562-dialogue-mic-lifecycle.png`, `1563-dialogue-evaluation.png`,
`1564-persona-*.png`). They contain no audio and no secrets.

## 7. Release impact

Twin voice parity is a user-visible bug fix with `high` release-note priority. Spoken final
transcripts now enter the canonical governed chat pipeline, so the visible turn, Memoria Viva,
Knowledge Pod and repository grounding, citations, and the synthesized canonical answer match typed
chat. Existing conversation, memory-proposal, and repository-index stores are affected without a
schema migration, reindex, restart, or user remediation requirement.

The release-note bullet for the next release is: “Align Digital Twin voice with governed chat and
upgrade repository grounding to precise multi-hop retrieval.” The supported-from version is the first
development build containing this change; remediation is `no-action-required`.

`release-impact.catalog.json` is intentionally not edited on this feature branch without a target
release version and release-owner approval reference. The normalized metadata above and in the pull
request is the reviewable preparation record; the release owner adds the catalog entry at release cut,
as required by the [release-impact runbook](../release/release-impact-runbook.md).

## 8. References

- **Safety validation & incident response:** [operator-runbook.md](operator-runbook.md) §4–§5.
- **Configuration contract:** [capability-configuration.md](capability-configuration.md).
- **Profiles & credential posture:** [deployment-profile-matrix.md](deployment-profile-matrix.md).
- **Spoken-equals-visible mechanism:** [assistant-speech-synthesis.md](assistant-speech-synthesis.md).
- **Dialogue orchestration:** [dialogue-session.md](dialogue-session.md).
- **Security review / threat model:** [dialogue-mode-threat-model.md](dialogue-mode-threat-model.md).
- **Production evaluation:** [dialogue-evaluation-report.md](dialogue-evaluation-report.md).
- **Epic closure record:** [epic-1556-closure.md](epic-1556-closure.md).
- **ADRs:** [ADR-0094](../adr/ADR-0094-voice-provider-capability-registry-extension.md),
  [ADR-0095](../adr/ADR-0095-voice-assistant-speech-synthesis.md),
  [ADR-0096](../adr/ADR-0096-voice-dialogue-session-orchestration.md).
