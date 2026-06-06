# Architecture Verification Baseline

This document names the current automated checks that keep the `0.2.0` modular architecture valid.
It is not a sprint diary or release-history log.

## Current verification surfaces

| Concern | Source of truth | What it proves |
| ------- | --------------- | -------------- |
| Package boundaries | [ADR-0019](adr/ADR-0019-modular-package-architecture.md), [ADR-0020](adr/ADR-0020-workspace-tooling-and-architecture-gate.md), `npm run arch:check`, `npm run arch:check:negative` | Dependency-direction and trust-boundary rules remain enforced in the live package graph. |
| Root public surface | [`docs/PUBLIC_API_SURFACE.md`](PUBLIC_API_SURFACE.md), `npm run check:package-surface` | The packed product exports only the approved root barrel, CLI bin, and bundled UI runtime assets. |
| Version consistency | `npm run check:version-consistency` | Workspace package versions stay aligned, `KEIKO_PRODUCT_VERSION` matches the root version, legacy shim removals remain enforced, and SDK version sourcing stays consistent. |
| Installable artifact | `npm run smoke:install`, `npm run smoke:install:memory` | A packed artifact installs cleanly and the bundled runtime packages are usable after installation. |
| Supply chain | `npm run check:workspace-supply-chain`, `npm run check:qi-supply-chain` | Workspace license/SBOM requirements and Quality Intelligence deny-list rules hold before publish. |
| Functional regression | `npm test`, `npm run lint`, `npm run typecheck` | Current implementation changes still satisfy the repo's executable and static correctness gates. |
| Local runtime state | [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md) | The approved local config, evidence, lifecycle, and memory surfaces are documented in one current-state contract. |

## Release-pack baseline

For any publishable build, the minimum baseline is:

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run arch:check`
5. `npm run arch:check:negative`
6. `npm run check:package-surface`
7. `npm run check:version-consistency`
8. `npm run check:workspace-supply-chain`
9. `npm run check:qi-supply-chain`
10. `npm run smoke:install`

## Historical note

Historical closure evidence for the earlier modularization sprint remains in git history and issue
threads. This page now records only the current verification baseline used to keep the repository
coherent at `0.2.0`.
