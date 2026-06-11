# ADR-0038: Provider runtime package boundary

## Status

Accepted

## Date

2026-06-11

## Context

Epic #460 now has two foundational slices in place:

- ADR-0037 introduced an explicit provider contract with safe projections.
- Issues #462 and #463 introduced a provider registry plus a productive Codex local-session runtime
  bridge.

That creates a new architecture choice before the rest of the epic expands setup, capability,
governance, and diagnostics work:

- keep the provider runtime inside `@oscharko-dev/keiko-model-gateway`, or
- extract a new package for provider-runtime ownership immediately.

This decision must be based on the current responsibilities that already exist in the codebase, not
speculative future provider classes.

## Decision

The provider runtime remains inside `@oscharko-dev/keiko-model-gateway` for Epic #460.

No new provider-runtime package is introduced in this issue.

## Rationale

### 1. The current responsibilities already match ADR-0019

`@oscharko-dev/keiko-model-gateway` already owns:

- productive provider dispatch
- provider registry wiring
- capability discovery and model eligibility inputs
- provider transport behavior
- local-session CLI execution and health validation
- fail-closed provider execution semantics

Those are all part of the productive model-access boundary that ADR-0019 already places in the
model-gateway package.

### 2. Extraction now would mostly move files, not reduce trust-boundary risk

The new local-session runtime bridge is implemented as model-gateway-owned code that depends only on:

- `@oscharko-dev/keiko-contracts`
- `@oscharko-dev/keiko-security`
- Node process execution inside the gateway package

Creating a new package immediately would add build-graph and package-surface churn before the rest
of Epic #460 proves whether the runtime boundary is actually too wide. At this stage, extraction
would be structural motion without a clear reduction in risk or ambiguity.

### 3. Keeping the runtime in one package reduces credential-bearing sprawl

The main risk in this epic is not package size. It is secret-bearing runtime drift.

Keeping the provider runtime in `@oscharko-dev/keiko-model-gateway` preserves one authoritative
place for:

- credential-bearing provider config
- local-session resolver configuration
- Codex CLI integration
- provider-specific runtime health checks
- productive dispatch and response normalization

That is safer than allowing the resolver or transport details to spread into `server`, `ui`, or
`contracts`.

## Boundary Rules

### `@oscharko-dev/keiko-contracts`

Allowed:

- provider identity and provider-type contracts
- provider validation-state semantics
- browser-safe provider projections

Forbidden:

- credential resolver configuration
- CLI/session resolution logic
- productive transport logic
- process execution
- secret-bearing runtime state

### `@oscharko-dev/keiko-model-gateway`

Allowed:

- productive provider dispatch
- provider adapter factories and registries
- provider-specific runtime config parsing and narrowing
- local-session credential resolver seams
- Codex CLI execution, readiness checks, and fail-closed runtime behavior
- capability discovery and provider-aware model selection inputs

Forbidden:

- browser UI state
- workspace filesystem ownership
- patch/tool execution ownership unrelated to model access
- persistence of browser-owned product state

### `@oscharko-dev/keiko-server`

Allowed:

- runtime composition
- dependency wiring
- safe projection delivery over BFF routes
- setup and diagnostics APIs that call the gateway through its public surface

Forbidden:

- direct ownership of local-session credential resolver config
- direct Codex CLI integration for provider execution
- productive provider transport logic outside `@oscharko-dev/keiko-model-gateway`
- browser-visible serialization of secret-bearing provider runtime state

## Enforcement

This decision is enforced by:

- the existing ADR-0019 / ADR-0020 package-direction and trust-boundary architecture gates
- package `exports` and TypeScript project references
- a dedicated provider-runtime boundary test added in issue #854

The dedicated test asserts that:

- `@oscharko-dev/keiko-contracts` production source does not own resolver or Codex CLI runtime
  details
- `@oscharko-dev/keiko-server` production source does not own resolver or Codex CLI runtime
  details
- `@oscharko-dev/keiko-model-gateway` is the package that owns the local-session resolver seam and
  Codex CLI bridge

## Extraction Triggers

This decision must be revisited if any of these become true:

- provider-runtime code needs dependencies that do not belong in `@oscharko-dev/keiko-model-gateway`
- non-gateway packages need repeated internal access to provider-runtime implementation details
- the package surface can no longer distinguish stable gateway APIs from unstable provider-runtime
  internals
- additional provider classes require materially different runtime substrates that would make the
  gateway package incoherent rather than cohesive

If one of those triggers is reached, a follow-up ADR should define the extracted package, its
allowed dependencies, and the migration plan.

## Consequences

### Positive

- Preserves one authoritative productive model-runtime boundary.
- Avoids scattering credential-bearing provider logic.
- Minimizes package churn while the rest of Epic #460 is still landing.
- Keeps setup, diagnostics, governance, and capability work aimed at one stable runtime package.

### Negative

- `@oscharko-dev/keiko-model-gateway` now carries more responsibility than a pure HTTP adapter
  package.
- A later extraction may still be warranted if provider diversity grows beyond the current two
  classes.
