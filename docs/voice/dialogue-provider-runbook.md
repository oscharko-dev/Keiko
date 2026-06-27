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

The colleague-like dialogue switch (and its per-turn Speak / Interrupt controls) is offered only when
the resolved voice capability is the **STT + TTS conjunction** _and_ at least one product voice persona
is offered. The single predicate is `voiceDialogueModeForResolution`
(`packages/keiko-ui/src/app/components/desktop/hooks/voice-dialogue-session.ts`), which gates both the
switch and the session, fail-closed (ADR-0096 D3). In capability terms:

| Configured providers                                   | Effective profile | Dialogue offered?                                    |
| ------------------------------------------------------ | ----------------- | ---------------------------------------------------- |
| None                                                   | `none`            | No (and no voice UI at all)                          |
| Speech-to-text only (e.g. `keiko-stt`)                 | `speech-to-text`  | No — dictation only (composer mic)                   |
| Speech-output only (e.g. `keiko-tts`)                  | `speech-output`   | No — assistant playback only                         |
| STT **and** speech output, **or** realtime, + personas | `full-realtime`   | **Yes** — full spoken dialogue (male/female/neutral) |

The practical consequence for bring-up: a deployment that has registered **only** `keiko-stt` (the
default development convenience) gets composer dictation, **not** spoken dialogue. To get the colleague
experience you must additionally register a speech-output (or realtime) provider that declares
`voiceProfiles` for the personas. This is by design — see [§3](#3-bringing-up-full-dialogue-mode).

## 2. The `oscharko-dev` development profile credentials

The development profile targets Azure AI Foundry voice deployments in **Sweden Central**. The
credentials are staged in the repository-root `.env` for local testing and are **never** read by name
from committed source — `keiko-server` resolves every provider credential through the generic
per-model path, not through `KEIKO_AZURE_FOUNDRY_VOICE_*` names. The staged values are pasted by the
operator into the Gateway Setup wizard
(`packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx` →
`packages/keiko-server/src/gateway-setup.ts`), which writes them into the Model Gateway provider record
in `keiko.config.json`.

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

To exercise the colleague-like dialogue end-to-end you must register **both** halves of the turn loop
plus the personas. Using the Foundry development deployments:

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

With both providers reachable, the resolver reports `profile: "full-realtime"` and
`availableVoicePersonas: ["male", "female", "neutral"]`, and the dialogue switch is offered. A realtime
deployment (`keiko-realtime`, `supportsRealtimeVoice: true`) declares `voiceProfiles` identically; in a
browser without WebRTC media the session transparently falls back to the STT+TTS turn loop (ADR-0096 D3).

## 4. Validating provider reachability without exposing secrets

Before driving the UI, confirm the configured endpoint and key are valid. The Azure Foundry voice
resource exposes an **OpenAI-compatible v1 surface** (`<host>/openai/v1`), so a list-models call is the
cheapest authenticated probe. The procedure below prints **only** the HTTP status and non-secret model
identifiers — never the key, the full host, or any audio.

```bash
# Values are read from .env into shell variables and never echoed.
ENVFILE=/path/to/Keiko/.env
BASE=$(grep -E '^KEIKO_AZURE_FOUNDRY_VOICE_OPENAI_BASE_URL=' "$ENVFILE" | cut -d= -f2- | tr -d '"'\''')
KEY=$(grep  -E '^KEIKO_AZURE_FOUNDRY_VOICE_API_KEY='        "$ENVFILE" | cut -d= -f2- | tr -d '"'\''')

# Authenticated list-models: 200 proves endpoint reachable AND key authenticates.
curl -s -o /dev/null -w "real key  -> HTTP %{http_code}\n" --max-time 25 \
  -H "Authorization: Bearer $KEY" "${BASE%/}/models"

# Control with a deliberately wrong key: expect 401, proving auth is actually enforced.
curl -s -o /dev/null -w "wrong key -> HTTP %{http_code}\n" --max-time 25 \
  -H "Authorization: Bearer wrong-key" "${BASE%/}/models"
```

**Expected:** `real key -> HTTP 200` and `wrong key -> HTTP 401`. A `200`/`401` split confirms
reachability and that the staged key authenticates. The Azure Foundry resource also accepts the
`api-key: $KEY` header form (the form Keiko's gateway uses). A `404` on a `/openai/deployments/...`
data-plane path is expected for this Foundry endpoint shape and is **not** an auth failure — the
OpenAI-compatible base already includes `/openai/v1`, so per-deployment audio routes hang off that base.

> This is a connectivity/auth check only. It deliberately sends **no audio** and persists nothing.
> Functional STT/TTS correctness is proven by driving the product (the next sections), not by raw curl.

## 5. Functional dialogue walkthrough (headset-style acceptance)

Start Keiko with the voice-capable config and a loopback BFF (default `http://127.0.0.1:1983`):

```bash
keiko ui --port 1983   # or: node scripts/dev-runner.mjs
```

Then walk the colleague-like conversation. Each step maps to an Epic #1556 acceptance criterion:

1. **Ask** — open a chat, toggle **Voice dialogue mode** on, click **Start speaking**, and ask a
   question (e.g. about an attached file). The status strip announces _Listening to you._ (AC1)
2. **Listen** — click **Stop speaking and send**; the transcript is sent through the _same_ chat send
   path a typed message uses, the assistant answer renders, and the assistant speaks the **exact**
   visible answer text. Visible and spoken responses cannot diverge — both read one identical string
   (AC2). (See [assistant-speech-synthesis.md](assistant-speech-synthesis.md).)
3. **Ground in files / context** — attach a file (or reference earlier chat) and ask about it; the
   spoken request carries the same `documentContext` and grounding as a typed turn, so the answer is
   grounded identically (AC2).
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
8. **Fail-closed paths** — deny the microphone permission, or start with no voice provider / the
   kill-switch (`KEIKO_VOICE_DISABLED=1`); the switch is absent or the session fails closed while text
   chat stays fully usable.

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
npx playwright test --project=chromium --grep "voice dialogue @smoke"
```

The browser smoke regenerates the acceptance screenshots under `docs/voice/evidence/`
(`1560-dialogue-session.png`, `1562-dialogue-mic-lifecycle.png`, `1563-dialogue-evaluation.png`,
`1564-persona-*.png`). They contain no audio and no secrets.

## 7. References

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
