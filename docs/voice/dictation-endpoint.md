# Voice dictation endpoint (BFF speech-to-text)

Implementation contract delivered by Issue [#494](https://github.com/oscharko-dev/Keiko/issues/494)
(Epic #491), realizing decisions **D1, D2, D4, and D6** of
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md). It is the optional,
capability-gated BFF endpoint for **short controlled composer dictation**: audio in → transcript
text. It is intentionally narrower than the full Voice Digital Twin — it transcribes one clip per
request and never implies assistant speech output or realtime turn-taking.

This issue owns the **server route and the provider-neutral STT invocation seam only**. The
capability-gated native composer dictation UX (microphone capture, the `getUserMedia`
`Permissions-Policy` relaxation, CSP changes) is Issue #495 and remains gated behind the security
review (ADR-0058 D6); nothing here relaxes the `Permissions-Policy: ... microphone=() ...` header or
the CSP (`default-src 'none'` / `connect-src 'self'`).

## 1. Capability gating

The route is **usable only when the resolved voice capability advertises speech-to-text** (ADR-0058
D1/D2). It gates on the same content-free resolution the UI reads from
[`GET /api/voice/capability`](capability-configuration.md) and the same `KEIKO_VOICE_DISABLED`
kill-switch (Issue #493). When voice is not configured, disabled by policy, unreachable, or the
configured provider does not advertise `supportsSpeechInput`, the route returns a deterministic
`VOICE_UNAVAILABLE` and Keiko stays fully usable (AC1/AC2). Capability resolution happens **before**
any audio is read or processed.

## 2. Request

```
POST /api/voice/transcribe
Content-Type: application/json
X-Keiko-Csrf: 1
```

The audio rides inside the existing JSON + CSRF request envelope (base64), so the BFF's
"state-changing requests must be JSON and carry the CSRF guard" invariant is preserved unchanged — the
endpoint adds no relaxation of the server media-type or CSRF gate.

```jsonc
{
  "audio": "<base64-encoded audio bytes>", // required
  "mimeType": "audio/webm", // required; container MIME (parameters such as ;codecs=opus are accepted)
  "durationMs": 4000, // optional; declared clip length, must be ≤ 120000
  "language": "en", // optional; BCP-47-ish hint, omitted lets the provider auto-detect
}
```

### Validation

| Field        | Rule                                                                                                                                         | Failure                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| body size    | The JSON envelope is capped (~6 MB) and the decoded audio is capped at 4 MB.                                                                 | `413 PAYLOAD_TOO_LARGE`                       |
| `mimeType`   | Base type must be in the closed allowlist (`audio/webm`, `audio/ogg`, `audio/wav`, `audio/mp4`, `audio/m4a`, `audio/mpeg`, `audio/flac`, …). | `400 UNSUPPORTED_AUDIO_FORMAT`                |
| `audio`      | Non-empty, well-formed base64 that decodes to ≥ 1 byte and ≤ 4 MB.                                                                           | `400 INVALID_AUDIO` / `413 PAYLOAD_TOO_LARGE` |
| `durationMs` | When present: a positive integer ≤ 120000 (two minutes).                                                                                     | `400 INVALID_DURATION`                        |
| `language`   | When present: an anchored BCP-47-ish tag, length ≤ 16.                                                                                       | `400 INVALID_LANGUAGE`                        |

The decoded-byte cap is the authoritative bound on transcribable duration: precise server-side
duration measurement would require decoding the container, which needs an audio-processing
dependency that the supply-chain policy (ADR-0058 D8) forbids, so the byte cap bounds the maximum
possible duration regardless of codec and the optional `durationMs` is an additional declared-length
ceiling.

## 3. Response

On success (`200`):

```jsonc
{
  "transcript": "the quick brown fox", // may be an empty string for silence
  "confidence": 0.92, // present only when the provider reports it
  "language": "en", // present only when the provider reports it
  "durationMs": 2500, // present only when the provider reports it
}
```

The response carries **only** the transcript and content-free provider metadata. The provider base
URL, credential, and model id never appear in any response (AC4); the payload is passed through the
live audit redactor defensively (AC5).

## 4. Error semantics

Every failure is a deterministic `{ "error": { "code", "message" } }` envelope with a static,
operator-safe message — no provider body, URL, path, IP, or credential is ever interpolated (AC5).

| Condition                                               | Status | Code                                                                                                   |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| No STT capability / disabled / unreachable / model gone | `503`  | `VOICE_UNAVAILABLE`                                                                                    |
| Provider rate-limited                                   | `429`  | `VOICE_RATE_LIMITED`                                                                                   |
| Provider timed out                                      | `504`  | `VOICE_TIMEOUT`                                                                                        |
| Audio too large (request or provider-reported)          | `413`  | `PAYLOAD_TOO_LARGE`                                                                                    |
| Any other provider/transport/egress/TLS failure         | `502`  | `VOICE_PROVIDER_ERROR`                                                                                 |
| Invalid request field                                   | `400`  | `INVALID_AUDIO` / `UNSUPPORTED_AUDIO_FORMAT` / `INVALID_DURATION` / `INVALID_LANGUAGE` / `BAD_REQUEST` |

## 5. Data boundary (no raw audio persistence)

The decoded audio is held only in memory for the duration of the request and is forwarded **once** to
the configured STT provider through the Model Gateway egress seam (`gatewayFetch`,
[ADR-0038](../adr/ADR-0038-outbound-egress.md)), so voice traffic inherits the same corporate-proxy,
custom-CA, timeout, and byte-cap behavior as every other productive model call (ADR-0058 D4). The
audio is **never** written to the evidence store, a side file, a log, or any other on-disk location
(AC3). The only external destination introduced by this route is the configured provider endpoint.

The provider call is provider-neutral: it uses the OpenAI-compatible multipart
`POST {baseUrl}/audio/transcriptions` contract that the gateway already speaks for chat and
embeddings. The Azure Foundry `keiko-stt` deployment class is one valid provider locality among three
([capability-configuration.md](capability-configuration.md) §2, ADR-0058 D7); a customer-hosted
controlled-network endpoint (which may be a private/RFC-1918 host behind a corporate proxy) uses the
identical shape — the multipart audio body is forwarded byte-for-byte even through the proxy/CA
fallback egress path.

## 6. References

- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) — decisions D1, D2, D4, D6.
- [capability-configuration.md](capability-configuration.md) — capability metadata, the read
  endpoint, and the disable kill-switch (Issue #493).
- [privacy-contract.md](privacy-contract.md) — credential and redaction posture.
- [implementation-sequencing.md](implementation-sequencing.md) — write-ownership boundaries (#494
  owns `keiko-server` BFF routes; the dictation UX is #495).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#494](https://github.com/oscharko-dev/Keiko/issues/494).
