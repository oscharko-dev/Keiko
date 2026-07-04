# Voice dialogue mode — operator runbook (Issue #1562)

Operator guide for safely configuring, validating, and managing voice providers in regulated Keiko deployments. This document covers credential posture, deployment validation, and incident response for voice dialogue mode enabled by children issues #1557–#1561 of Epic #1556 (colleague-like voice conversation).

For the privacy and security contract, see [privacy-contract.md](privacy-contract.md). For the threat model and security review requirements, see [dialogue-mode-threat-model.md](dialogue-mode-threat-model.md). For configuration reference, see [capability-configuration.md](capability-configuration.md).

## 1. Audience and scope

This runbook is for deployment operators, security teams, and regulated-environment (bank/insurance/health) admins who run Keiko in controlled networks and must verify that voice configuration poses no risk to credential confidentiality, audio privacy, or compliance posture.

The scope covers:

- Provider registration and credential placement (Azure Foundry, customer-hosted private endpoints, local-only / no-voice deployments).
- Verification that Permissions-Policy and kill-switch controls are correctly wired.
- Validation that provider secrets never leak into responses, evidence, or logs.
- Confirmation that raw/generated audio is never persisted.
- Incident response when provider credentials are suspected compromised.

Voice is optional and defaults to disabled. This runbook assumes you have read [capability-configuration.md](capability-configuration.md) and [deployment-profile-matrix.md](deployment-profile-matrix.md).

## 2. Provider locality and credential posture

Voice providers operate in three localities; only explicitly configured providers are reachable.

| Locality            | Provider example          | Credential storage         | Network egress                   |
| ------------------- | ------------------------- | -------------------------- | -------------------------------- |
| **Azure Foundry**   | `keiko-stt`, `keiko-tts`  | Sealed vault on Keiko host | Outbound to configured Azure URL |
| **Customer-hosted** | Private RFC-1918 endpoint | Sealed vault on Keiko host | Outbound to configured endpoint  |
| **Local-only**      | No voice provider         | N/A                        | No voice egress                  |

In all cases:

- **The long-lived provider API key stays server-side** in the sealed credential vault.
- **The browser never receives a secret** — only content-free enum metadata (persona names, availability status).
- **Audio and transcripts are never persisted to disk** unless explicitly archived by the user.

See [deployment-profile-matrix.md §5](deployment-profile-matrix.md#5-credential-posture-per-environment) for the full matrix.

## 3. Configuring a voice provider safely

Voice providers are registered through the Model Gateway configuration file (typically a JSON file pointed to by `KEIKO_CONFIG_FILE` or an inline capability in the provider definition).

### 3.1 Credential placement (sealed vault, never plaintext)

**Preferred:** Use a sealed vault reference. The key stays encrypted on disk.

```jsonc
{
  "providers": [
    {
      "modelId": "keiko-stt",
      "baseUrl": "https://<your-foundry-or-customer-host>/...",
      "apiKeySecretRef": "voice/keiko-stt", // Sealed vault reference (preferred)
      "capability": {
        "kind": "voice",
        "supportsSpeechInput": true,
        "voiceProviderLocality": "azure-foundry",
        // ... other capability fields
      },
    },
  ],
}
```

The `apiKeySecretRef` points to a vault namespace (e.g., `voice/keiko-stt`). The actual key is resolved from:

1. **Environment variable** (highest priority): `KEIKO_MODEL_KEIKO_STT_API_KEY`
2. **Local vault** (file-based, encrypted): stored in the sealed vault service at the referenced path
3. **Config file plaintext** (lowest priority, deprecated): inline `apiKey` field — avoid this in production

**Environment variable placement (for CI/containerized deployments):**

```bash
export KEIKO_MODEL_KEIKO_STT_API_KEY="actual-secret-token-here"
# or
export KEIKO_MODEL_KEIKO_TTS_API_KEY="speech-output-secret-token-here"
export KEIKO_MODEL_KEIKO_REALTIME_API_KEY="realtime-secret-token-here"
```

Environment secrets are never written back to disk (transient, by design) and are never logged by the BFF.

### 3.2 Voice provider personas (product voices — male / female / neutral)

Product voice personas are the **output** voices the assistant uses (relevant for TTS or full-realtime providers only). The persona → provider-voice-id mapping is sensitive and must never reach the browser.

Personas are declared on the credential-tier `voiceProfiles` array:

```jsonc
{
  "providers": [
    {
      "modelId": "keiko-tts",
      "baseUrl": "https://<your-foundry-host>/...",
      "apiKeySecretRef": "voice/keiko-tts",
      "capability": {
        "kind": "voice",
        "supportsSpeechOutput": true,
        "voiceProviderLocality": "azure-foundry",
        // ... other fields
      },
      // Credential-tier persona mapping (never reaches browser):
      "voiceProfiles": [
        { "persona": "male", "voiceId": "<provider-male-voice-id>" },
        { "persona": "female", "voiceId": "<provider-female-voice-id>" },
        { "persona": "neutral", "voiceId": "<provider-neutral-voice-id>" },
      ],
    },
  ],
}
```

The `voiceId` values are provider-specific (e.g., Azure voice names) and are **never serialized to the browser**. Only the persona enums (`"male"`, `"female"`, `"neutral"`) are published to the UI via `/api/voice/capability`.

See [capability-configuration.md §2a](capability-configuration.md#2a-product-voice-personas-male--female--neutral--issue-1557) for the full configuration contract.

### 3.3 Disabling voice globally (the kill-switch)

If a regulated deployment must disable voice without removing the configuration, set the kill-switch environment variable:

```bash
export KEIKO_VOICE_DISABLED=1
# or
export KEIKO_VOICE_DISABLED=true
```

The `/api/voice/capability` endpoint will report `available: false`, `reason: "policy-disabled"`, and the UI will render no voice affordance. Keiko remains fully usable for chat, editing, and non-voice workflows.

## 4. Validation checklist after configuring a provider

Run these verification steps after deploying a voice provider configuration to confirm safety.

> The examples below target the default loopback BFF address `http://127.0.0.1:1983` (the BFF binds the
> loopback host `127.0.0.1` on `DEFAULT_UI_PORT` 1983; see `packages/keiko-server/src/server.ts`).
> Substitute the host/port your deployment was started with (`keiko ui --port <port>`).

### 4.1 Verify the Permissions-Policy header

The `Permissions-Policy` header must permit microphone access only when voice is actually capable. Check this on a non-voice deployment and a voice-capable one.

**No-voice deployment (or kill-switch enabled):**

```bash
curl -I http://127.0.0.1:1983/api/voice/capability
```

Look for:

```
Permissions-Policy: ..., microphone=(), ...
```

Microphone must be `()` (blocked).

**Voice-capable deployment (STT or realtime):**

```bash
curl -I http://127.0.0.1:1983/api/voice/capability
```

Look for:

```
Permissions-Policy: ..., microphone=(self), ...
```

Microphone must be `(self)` (allow same-origin only), never wider.

**Failure:** If you see `microphone=*` or a wider directive, voice configuration is incorrect. Verify that `KEIKO_VOICE_DISABLED` is not set and that a voice-capable provider is registered.

### 4.2 Verify the kill-switch blocks voice routes

When voice is disabled by policy, the `/api/voice/transcribe` and `/api/voice/speak` routes return a static, redacted 503 error.

**With kill-switch enabled:**

```bash
export KEIKO_VOICE_DISABLED=1
curl -X POST http://127.0.0.1:1983/api/voice/transcribe \
  -H "Content-Type: application/json" \
  -d '{"audio": "ZmFrZS1hdWRpbw==", "mimeType": "audio/webm"}'
```

Expected response:

```json
{
  "error": {
    "code": "VOICE_UNAVAILABLE",
    "message": "Speech-to-text dictation is not available."
  }
}
```

**Critical:** The response contains no provider secret, base URL, model ID, or diagnostic hint. It is identical to the response when no voice provider is configured at all.

### 4.3 Verify no secret leakage in responses

Provider secrets (API keys, voice IDs, base URLs) must never appear in any `/api/voice/*` response, even on error.

**Successful synthesis request:**

```bash
curl -X POST http://127.0.0.1:1983/api/voice/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test of the voice system."}'
```

Response (on success):

```json
{
  "audio": "//NExAAiw0EWRTqAA=...",
  "mimeType": "audio/mpeg"
}
```

**Verify no leakage:**

```bash
curl -X POST http://127.0.0.1:1983/api/voice/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello"}' | \
  grep -E "apiKey|secret|baseUrl|voiceId|endpoint" && echo "FAIL: Secret detected" || echo "PASS"
```

The response body must contain **only**:

- `audio` (base64-encoded audio bytes, not the raw bytes)
- `mimeType` (e.g., `"audio/mpeg"`)

No provider credential, endpoint, or voice identifier must appear.

### 4.4 Verify no raw or generated audio persistence

After a voice dialogue session, the evidence directory must not contain audio artifacts.

**Run a voice dialogue interaction:**

1. Start Keiko.
2. Enter voice dialogue mode (if running with a voice-capable provider).
3. Speak or dictate text (or run an automated integration test that exercises voice).
4. Exit dialogue mode.

**Check the evidence directory:**

The evidence directory is resolved by the `KEIKO_EVIDENCE_DIR` precedence (explicit `--evidence-dir` → `KEIKO_EVIDENCE_DIR` → the default `./.keiko/evidence`, relative to Keiko's working directory).

```bash
EVIDENCE_DIR="${KEIKO_EVIDENCE_DIR:-./.keiko/evidence}"
find "$EVIDENCE_DIR" -type f \( -name "*.wav" -o -name "*.mp3" -o -name "*.webm" -o -name "*.ogg" -o -name "*.m4a" \)
# Should find nothing (no audio files).

# Also check for suspicious base64 or hex-encoded audio in JSON manifests:
find "$EVIDENCE_DIR" -type f -name "*.json" -exec grep -l "RIFF\|ftyp" {} \;
# If found, inspect the manifest to confirm it is metadata (e.g., a mime type string) not raw audio.
```

**Failure:** If audio files are found or if JSON manifests contain decoded audio, the evidence redaction layer has failed. This is a critical security bug — isolate the environment and contact the Keiko team.

### 4.5 Verify provider key does not appear in logs or evidence metadata

Provider API keys and base URLs must never appear in Keiko logs or evidence records, even in redacted form.

**Check logs:** Keiko writes operational logs to the process stdout/stderr (capture them with your process manager, container runtime, or `keiko ui ... > keiko.log 2>&1`). Scan the captured log for any provider host or model id:

```bash
# Replace keiko.log with wherever your process manager captured Keiko's stdout/stderr:
grep -E "keiko-stt|foundry|<your-provider-host>" keiko.log 2>/dev/null && echo "FAIL: provider host in logs" || echo "PASS: no provider host in logs"
```

**Check evidence records:**

```bash
EVIDENCE_DIR="${KEIKO_EVIDENCE_DIR:-./.keiko/evidence}"
# Evidence records may contain hashed identifiers and redacted activity, but never the actual key or endpoint.
find "$EVIDENCE_DIR" -name "*.json" -exec grep -l "apiKey\|baseUrl\|<your-provider-host>" {} \;
# Should find nothing.
```

## 5. Incident response: provider credential suspected leaked

If a provider API key is suspected compromised (e.g., accidentally logged, sent in plaintext, or exposed in a misconfigured proxy):

1. **Immediately rotate the key at the provider.**
   - Log into the Azure Foundry or customer-hosted provider management portal.
   - Revoke the compromised API key.
   - Generate a new key.

2. **Update the local vault or environment variable.**
   - If using a sealed vault: update the vault entry at the referenced path (e.g., `voice/keiko-stt`).
   - If using an environment variable: update `KEIKO_MODEL_KEIKO_STT_API_KEY` (or the respective provider).
   - Restart Keiko to pick up the new credential.

3. **Redeploy and re-validate.**
   - Verify the new credential is in place: `curl http://127.0.0.1:1983/api/voice/capability` should return `available: true` (if voice is configured) and make no network errors.
   - Re-run the validation checklist (§4.1–§4.5) to confirm no stale secrets are lingering.

4. **Audit historical evidence and logs.**
   - Check evidence and log files for the old key string.
   - If found, purge or re-encrypt the files (use `keiko repair` or manual file removal, depending on your retention policy).
   - If the key appeared in transit to the provider, check provider logs to see if unauthorized requests were made and lock the account temporarily if needed.

## 6. References

- **Configuration:** [capability-configuration.md](capability-configuration.md) — detailed config keys and the sealed vault contract.
- **Deployment matrix:** [deployment-profile-matrix.md](deployment-profile-matrix.md) — provider × environment profiles and network egress expectations.
- **Privacy contract:** [privacy-contract.md](privacy-contract.md) — local-first data boundaries and the external-call rule.
- **Threat model:** [dialogue-mode-threat-model.md](dialogue-mode-threat-model.md) — security review requirements and known limitations.
- **Source:** `packages/keiko-server/src/headers.ts` (Permissions-Policy implementation), `packages/keiko-server/src/read-handlers.ts` (voice capability resolution and kill-switch), `packages/keiko-model-gateway/src/config.ts` (configuration parsing).
- **Tests:** `packages/keiko-server/src/voice-handlers.test.ts`, `packages/keiko-server/src/voice-handlers.speak.test.ts`, `packages/keiko-server/src/headers.test.ts` (secret redaction assertions).
- **ADR-0100:** [Voice Digital Twin capability architecture](../adr/ADR-0100-voice-digital-twin-capability-architecture.md).
- **ADR-0094:** [Voice provider capability registry extension (personas)](../adr/ADR-0094-voice-provider-capability-registry-extension.md).
- **ADR-0095:** [Voice assistant speech synthesis](../adr/ADR-0095-voice-assistant-speech-synthesis.md).
- **ADR-0096:** [Voice dialogue session orchestration](../adr/ADR-0096-voice-dialogue-session-orchestration.md).
