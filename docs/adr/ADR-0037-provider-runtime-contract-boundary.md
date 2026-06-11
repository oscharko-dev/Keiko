# ADR-0037: Provider runtime contract boundary and safe projection model

## Status

Accepted

## Date

2026-06-11

## Context

Epic #460 introduces a pluggable provider runtime that must support two materially different
provider classes:

- an OpenAI-compatible gateway provider that requires an endpoint and API credential
- a local OpenAI/Codex session provider that relies on local user-bound session state and a
  resolver seam rather than browser-supplied credentials

The pre-epic gateway contract models every provider as `baseUrl + apiKey`. That shape is no
longer viable:

- it forces fake compatibility fields onto local-session providers
- it makes provider type implicit
- it blurs the line between browser-safe configuration and runtime-only credential state
- it gives later setup, runtime, audit, and UI code no authoritative provider discriminant

This ADR resolves the contract boundary before registry wiring, local-session execution, setup UX,
and diagnostics land.

## Decision

### 1. Provider configuration becomes a discriminated union

The runtime provider config surface is no longer a single structural shape. Keiko now models at
least these provider classes explicitly:

- `gateway-openai-compatible`
- `openai-codex-local-session`

The productive gateway provider continues to carry endpoint and API credential fields. The
local-session provider instead carries a runtime-only credential resolver seam, beginning with the
`codex-cli` resolver contract.

### 2. Safe projections are a separate union, not an "omitted fields" convention

Browser-safe provider configuration is represented by a dedicated safe-projection union. It omits:

- API credentials
- provider endpoints
- local credential-resolver configuration
- local session artifacts
- any future runtime-only state needed to operate a provider

This is a deliberate type boundary, not a documentation promise. Later UI and BFF work must
consume the safe-projection union rather than runtime provider config objects.

### 3. Existing gateway configs migrate forward without breaking productive use

Existing gateway-centric configuration remains valid. When a provider entry omits `providerType`,
the parser treats it as `gateway-openai-compatible` and normalizes the parsed runtime object to the
explicit gateway provider type.

This keeps current productive setups working while making the normalized in-process contract
explicit for future provider-aware code.

### 4. Current runtime ownership boundaries remain unchanged

This ADR does not introduce provider registry wiring, live local-session resolution, or setup UX.
Those land in later Epic #460 child issues.

Boundary ownership after this ADR:

- `@oscharko-dev/keiko-contracts`
  - owns provider identity, selection, and validation-state semantics
  - owns browser-safe provider projection shapes
  - must remain free of secret-bearing runtime state
- `@oscharko-dev/keiko-model-gateway`
  - owns credential-bearing runtime provider config
  - owns provider parser and normalization logic
  - owns runtime-only resolver seams
- `@oscharko-dev/keiko-server` and `@oscharko-dev/keiko-ui`
  - must consume only safe projections over browser-visible paths

### 5. Unsupported provider execution remains fail-closed until later issues land

This ADR intentionally allows the config contract to represent the local-session provider before
the runtime can execute it productively. Call sites that still rely on gateway-only transport must
remain explicit about that assumption and fail closed when given an unsupported provider class.

That constraint is preferable to keeping an unsafe fake-compatible config shape.

## Consequences

### Positive

- Provider type becomes authoritative and machine-readable.
- Local-session providers no longer require fake `baseUrl` or `apiKey` fields.
- Safe serialization can exclude resolver and session details by construction.
- Later setup, runtime, audit, and diagnostics work can target one stable provider contract.

### Negative

- Some runtime paths remain gateway-only until subsequent epic slices land.
- The normalized contract becomes more explicit before all consumers are provider-aware, so
  gateway-only callers must narrow deliberately rather than assuming every provider is HTTP-based.

## Migration notes

- Existing gateway config files remain valid without adding `providerType`.
- New provider-aware configuration should prefer explicit `providerType` values.
- Browser-safe surfaces must treat runtime provider config as forbidden and use the safe projection
  union exclusively.
