# ADR-0025: Forward-only 0.2.0 modular package baseline

## Status

Accepted (Epic #423, 2026-06-06). Builds on ADR-0019, ADR-0020, and ADR-0021.

## Context

Keiko now operates on a single `0.2.0` modular package baseline. The repository needs one short,
current statement of the on-disk topology, publish contract, and enforcement posture that the live
tooling protects.

## Decision

The `0.2.0` baseline commits to the following invariants:

1. **Owned package boundaries.** Domain implementation lives in `packages/keiko-<name>/src/`.
2. **Minimal root package.** Root `src/` contains only the product barrel (`src/index.ts`) and the CLI entrypoint (`src/cli/index.ts`).
3. **Dedicated SDK package.** The programmatic SDK surface lives in `@oscharko-dev/keiko-sdk`, not under root `src/`.
4. **Bundled runtime artifact.** Internal runtime packages are carried by the root product through `dependencies` plus `bundleDependencies`. The UI workspace is not shipped as a separate runtime package; the shipped runtime artifact is the static export under `dist/ui/static/`.
5. **Error-severity architecture gate.** The ADR-0019 package-boundary rules are enforced at error severity in the live dependency-cruiser configuration.
6. **Single version baseline.** The root package, `KEIKO_PRODUCT_VERSION`, and bundled runtime package set are kept aligned at `0.2.0`.

## Consequences

- New domain implementation does not land under root `src/`.
- Publish and install checks defend one packaged product, not multiple independently published workspace packages.
- Current-state operational docs should describe the live baseline directly and leave historical rollout material in archived records.

## Related

- ADR-0019 — Modular package architecture.
- ADR-0020 — Workspace tooling and architecture gate.
- ADR-0021 — Publish strategy: bundled monorepo product.
- [`../PUBLIC_API_SURFACE.md`](../PUBLIC_API_SURFACE.md) — Current packaged surface summary.
