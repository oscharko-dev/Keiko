# Provider Runtime Contract

Issue: #461  
Parent Epic: #460

## Purpose

This note records the authoritative provider contract introduced for the first provider-runtime
slice. It defines how Keiko distinguishes browser-safe provider state from runtime-only provider
state while preserving the current productive gateway flow.

## Provider classes

The contract recognises two provider classes:

- `gateway-openai-compatible`
- `openai-codex-local-session`

Both classes share the same provider-neutral base semantics:

- `providerId`: stable provider identity for future setup, dispatch, and audit surfaces
- `modelId`: productive model identifier
- retry policy: `timeoutMs`, `maxRetries`, `retryBaseDelayMs`
- provider-safe validation state

`providerId` defaults to `modelId` for legacy gateway configurations so existing productive setups
continue to parse without manual migration.

## Safe versus runtime-only state

The browser-safe projection exposes only:

- `providerId`
- `providerType`
- `modelId`
- `validationState`
- retry policy
- `credentialHeaderName` only for `gateway-openai-compatible`

The safe projection never carries:

- `apiKey`
- `baseUrl`
- local-session resolver state
- session artifacts
- token-bearing runtime handles

`openai-codex-local-session` is intentionally projected as `validationState: "runtime-only"`.
That state is explicit enough for later setup and UX work without serialising session-bound runtime
details into the browser.

## Migration rules

Legacy provider entries that omit `providerType` are normalised to
`gateway-openai-compatible`. This keeps existing `keiko.config.json` files and env-backed gateway
setups valid.

`openai-codex-local-session` is explicit-only. When that provider type is selected:

- `baseUrl` is rejected
- `apiKey` is rejected
- `apiKeyHeaderName` is rejected
- `KEIKO_MODEL_*_BASE_URL` and `KEIKO_MODEL_*_API_KEY` are not consulted

This prevents accidental mixed-mode configuration where a local-session provider silently consumes
gateway-only fields.

## Current runtime boundary

Issue #462 introduces the internal provider runtime registry and the route-time adapter-factory
seam. Productive runtime dispatch now resolves provider implementations through that registry:

- `gateway-openai-compatible` providers execute through the registry into the current
  OpenAI-compatible productive adapter path
- `openai-codex-local-session` remains parseable and safe-projectable, but the registry keeps
  productive dispatch fail-closed until #463 lands

This preserves ADR-0019 trust boundaries by keeping productive model traffic behind
`@oscharko-dev/keiko-model-gateway`.

## Local-session bridge

Issue #463 wires `openai-codex-local-session` through a bounded local resolver before productive
chat traffic reaches the existing OpenAI-compatible adapter path.

The approved local runtime seam is intentionally narrow:

- `codex --version`
- `codex auth status --json`

No browser payload, safe-config projection, or audit-facing object may carry:

- the resolved runtime `apiKey`
- the resolved runtime `baseUrl`
- raw `codex` command output
- session expiry metadata beyond fail-closed diagnostics

The resolver accepts only a documented JSON health shape from `codex auth status --json`:

- authenticated session state
- non-expired session metadata
- runtime `baseUrl`
- runtime credential material
- explicit `chatCompletions: true`
- explicit `workflow: true`

Anything outside that contract fails closed with a stable gateway-safe error:

- missing CLI or unsupported CLI version -> `ConfigInvalidError`
- missing or expired login/session -> `AuthenticationError`
- malformed response or unsupported capability shape -> `ConfigInvalidError`

## Follow-up seams for Epic #460

The following work is intentionally deferred to later child issues:

- #463: local-session credential resolution and runtime bridge
- #464: provider-aware setup payloads and onboarding UX
- #465: provider-aware capability discovery and model eligibility
- #466: local-session redaction and audit hardening

The main coordination risk to carry back to the epic thread is that productive selection still
uses `modelId` in current runtime code. `providerId` now exists as the stable contract identity, but
dispatch and persistence do not use it yet. That migration must stay coordinated across #463, #464,
and #465 so provider-aware selection remains deterministic.
