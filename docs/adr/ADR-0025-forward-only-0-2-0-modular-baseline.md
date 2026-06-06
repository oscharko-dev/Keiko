# ADR-0025: Forward-only 0.2.0 modular package baseline

## Status

Accepted (Epic #423, 2026-06-06). Builds on and finalises ADR-0019 and ADR-0020. Does not supersede them; the rules they encode are now enforced as the live 0.2.0 baseline.

## Context

ADR-0019 declared the modular package topology and ADR-0020 the workspace tooling and architecture gate. From 2025 through Epic #423 the repository operated in a migration mode where:

- some packages had been extracted into `packages/keiko-<name>/` and others still lived as legacy `src/<domain>/` shims;
- the dependency-cruiser gate ran the strict per-package variants at `error` severity for extracted packages and a `warn`-level base rule for the not-yet-extracted set;
- the root `@oscharko-dev/keiko` package owned a mix of product composition (`src/index.ts`, `src/sdk/**`) and compatibility re-export shims (`src/audit/**`, `src/gateway/**`, etc.).

That topology made the rules harder to read and the publish surface harder to defend. Epic #423 closes the migration so the build graph, package manifests, dependency-cruiser rules, install-smoke checks, and publish checks all describe one coherent 0.2.0 model.

## Decision

The 0.2.0 baseline is forward-only. The repository commits to the following invariants:

1. **Owned packages only.** Every domain implementation lives under `packages/keiko-<name>/src/`. The two final extractions landed in Epic #423: `@oscharko-dev/keiko-verification` (issue #424) and `@oscharko-dev/keiko-evaluations` (issue #425).
2. **Root facade.** The root `@oscharko-dev/keiko` package owns only `src/index.ts` (the public 0.2.0 product barrel), `src/sdk/**` (the explicitly approved root SDK surface — `runAgent`, `SdkAgentConfig`, `SdkEvidenceOptions`, `SDK_VERSION`), and `src/cli/index.ts` (the installed `keiko` bin entrypoint). Nine legacy shim directories were deleted in issue #426.
3. **Versioned baseline.** Every internal workspace package converges on version `0.2.0`. Drift (0.1.0 / 0.1.7 / 0.3.0 / 0.4.0) is retired in issue #427.
4. **Bundled artifact contract.** Every internal runtime workspace package is named in the root `dependencies` AND `bundleDependencies` (issue #428). The `@oscharko-dev/keiko-ui` workspace is intentionally NOT in `bundleDependencies` because the runtime artifact carried by the packed root product is the static-export tree under `dist/ui/static/`, not the npm package itself.
5. **Architecture gate at error severity.** Every per-package strict variant of the ADR-0019 direction rules is enforced as `error`. Broader `warn`-level base rules remain as safety nets for regressions that slip past a stricter regex.

## Consequences

- Every future internal package extraction follows the established pattern: new `packages/keiko-<name>/`, public package barrel, dependency-cruiser strict variant at `error`, negative fixture wired into `scripts/arch-check-negative.mjs`, bundle-set membership.
- The legacy `src/<domain>/` re-export shim pattern is retired. New domain implementation never lands under root `src/`.
- ADR-0019 remains the authoritative direction-rule statement. This ADR is the closure-evidence that the rules now match the on-disk topology.
- Migration narratives that previously lived under `docs/migration/` move into `docs/historical/` so the active docs folder is current-state-only.

## Related

- ADR-0019 — Modular package architecture (foundation).
- ADR-0020 — Workspace tooling and architecture gate (foundation).
- ADR-0021 — Publish strategy: bundled monorepo product (bundle contract).
- ADR-0023 — Quality Intelligence migration architecture (one of the migrations whose closure evidence informs this baseline).
- Epic #423 — Finalize forward-only 0.2.0 modular package architecture.
