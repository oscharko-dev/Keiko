# Architecture Verification Record

This document is the retained verification record for the modularization work that established the
`0.2.0` package baseline. It is not the live release gate for current builds. Current operational
contracts live in [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md),
[ADR-0025](adr/ADR-0025-forward-only-0-2-0-modular-baseline.md), and the package scripts and CI
jobs they reference.

## Verification surfaces captured by the record

| Concern | Source of truth | What it proves |
| ------- | --------------- | -------------- |
| Package boundaries | [ADR-0019](adr/ADR-0019-modular-package-architecture.md), [ADR-0020](adr/ADR-0020-workspace-tooling-and-architecture-gate.md), `npm run arch:check`, `npm run arch:check:negative` | Dependency-direction and trust-boundary rules remain enforced in the live package graph. |
| Root public surface | [`docs/PUBLIC_API_SURFACE.md`](PUBLIC_API_SURFACE.md), [`scripts/root-package-surface.contract.json`](../scripts/root-package-surface.contract.json), `npm run check:package-surface` | The packed product exposes only the approved root barrel, CLI bin, and bundled UI runtime assets as customer-facing contract; bundled private workspace packages remain internal implementation detail. |
| Version consistency | `npm run check:version-consistency` | Workspace package versions stay aligned, `KEIKO_PRODUCT_VERSION` matches the root version, legacy shim removals remain enforced, and SDK version sourcing stays consistent. |
| Installable artifact | `npm run smoke:install`, `npm run smoke:install:memory` | A packed artifact installs cleanly as one self-contained product without requiring separately published workspace packages. |
| Supply chain | `npm run check:workspace-supply-chain`, `npm run check:qi-supply-chain` | Workspace license/SBOM requirements and Quality Intelligence deny-list rules hold before publish. |
| Functional regression | `npm test`, `npm run lint`, `npm run typecheck` | Current implementation changes still satisfy the repo's executable and static correctness gates. |
| Local runtime state | [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md) | The approved local config, evidence, lifecycle, and memory surfaces are documented in one current-state contract. |

## Historical publishable-build baseline

At the time this record was written, the minimum publishable-build baseline was:

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
threads. Other docs may cite this page as background for the modularization rollout, but current
release expectations should come from the live package scripts, CI, and current-state contract
docs rather than this retained record.
