# ADR-0100: Provider runtime package boundary

## Status

Accepted (Issue #854, Epic #460, 2026-07-02).

## Context

Epic #460 adds provider-aware runtime behavior around the existing Model Gateway: provider registry,
capability discovery, diagnostics, local-session resolution, and governance surfaces. The existing package
graph already gives `@oscharko-dev/keiko-model-gateway` the productive model boundary, while
`@oscharko-dev/keiko-contracts` carries only browser-safe contracts and `@oscharko-dev/keiko-server` wires
loopback BFF routes, setup, vault-backed credential resolution, and UI responses.

The remaining question is whether provider runtime ownership should stay in
`@oscharko-dev/keiko-model-gateway` or move to a new package before the provider-aware slices grow.

## Decision

Provider runtime remains in `@oscharko-dev/keiko-model-gateway`.

No dedicated provider-runtime package is introduced for Epic #460. The current and near-term scope from
issues #464, #465, #466, and #467 is still one productive runtime boundary with multiple provider-shaped
adapters and safe projections. Extracting now would add a package edge without separating a second independent
runtime owner.

## Package-Boundary Rules

`@oscharko-dev/keiko-contracts`:

- May define provider-safe, credential-free wire types, capability predicates, safe enums, and validation for
  browser-visible projections.
- Must not define or import credential-bearing provider config, local-session resolver logic, CLI/session
  resolver logic, productive transport behavior, provider SDK adapters, or runtime credential material.

`@oscharko-dev/keiko-model-gateway`:

- Owns productive model traffic, provider config parsing, provider registry/runtime selection, provider SDK
  adapters, transport normalization, capability resolution, provider diagnostics, and local-session runtime
  resolution.
- May depend only on `@oscharko-dev/keiko-contracts` and `@oscharko-dev/keiko-security`, preserving the
  existing near-leaf graph position.
- Exposes only intentional public or documented internal subpaths. Provider-runtime internals are not a general
  server/CLI escape hatch.

`@oscharko-dev/keiko-server`:

- May compose the gateway through public package surfaces, inject vault-backed secret resolvers, host setup and
  diagnostics routes, and serialize safe projections to the browser.
- Must not own provider SDK adapters, productive transport implementations, local-session runtime resolution,
  or credential-bearing provider runtime logic outside setup/vault composition.
- Must not import provider-runtime internals such as the OpenAI adapter or transport normalization directly.

Browser-tier packages:

- May consume `@oscharko-dev/keiko-contracts` provider-safe projections.
- Must not import `@oscharko-dev/keiko-model-gateway` values or provider config internals.

## Extraction Trigger

Extraction into a dedicated package is deferred until one of these concrete conditions appears:

- A second productive runtime owner needs to execute provider traffic independently of the gateway.
- Provider runtime needs dependencies that would violate the gateway's current `contracts` + `security` graph.
- Local-session runtime state grows into a lifecycle service with its own persistence, scheduling, or process
  boundary that cannot stay behind the gateway package surface.
- Multiple non-gateway packages need to share credential-bearing provider runtime code, not just safe contracts
  or setup composition.

## Enforcement

- `.dependency-cruiser.cjs` keeps `@oscharko-dev/keiko-contracts` as a leaf and keeps
  `@oscharko-dev/keiko-model-gateway` limited to `contracts` + `security`.
- `scripts/check-package-graph.mjs` keeps the package dependency allowlist aligned with the same decision.
- `scripts/check-import-policy.mjs` adds `adr-0100-provider-runtime-no-internal-bypass`, forbidding
  non-gateway packages from importing provider-runtime internal subpaths such as
  `@oscharko-dev/keiko-model-gateway/internal/openai-adapter`.
- `scripts/arch-check-negative.mjs` proves that enforcement with
  `tests/architecture/fixtures/provider-runtime-internal-bypass/bad-import.ts`.

## Related

- ADR-0019: Modular package architecture.
- ADR-0020: Workspace tooling and architecture gate.
- ADR-0046: Local gateway and connector credential vault.
- ADR-0094: Voice provider capability registry extension.
- Issue #854 and Epic #460.
