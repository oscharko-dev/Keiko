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

Issue #461 does not introduce provider registry wiring or a local-session adapter. Productive
runtime dispatch therefore remains fail-closed:

- `gateway-openai-compatible` providers continue to route through the existing OpenAI-compatible
  gateway path
- `openai-codex-local-session` is parseable and safe-projectable, but productive dispatch rejects
  it until #462 and #463 land

This preserves ADR-0019 trust boundaries by keeping productive model traffic behind
`@oscharko-dev/keiko-model-gateway` without inventing a partial local-session transport here.

## Follow-up seams for Epic #460

The following work is intentionally deferred to later child issues:

- #462: provider registry, dispatch factory, and route-time selection by provider class
- #463: local-session credential resolution and runtime bridge
- #464: provider-aware setup payloads and onboarding UX
- #465: provider-aware capability discovery and model eligibility
- #466: local-session redaction and audit hardening

The main coordination risk to carry back to the epic thread is that productive selection still
uses `modelId` in current runtime code. `providerId` now exists as the stable contract identity, but
dispatch and persistence do not use it yet. That migration must stay coordinated across #462, #464,
and #465 so provider-aware selection remains deterministic.
