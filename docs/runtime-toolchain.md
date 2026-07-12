# Governed Runtime Toolchain

Status: production baseline for issue #2294, effective 2026-07-11.

## Supported baseline

Keiko develops, tests, packages, and stages portable artifacts on Node.js 24.18.0 LTS (`Krypton`).
Repository and published workspace manifests accept later Node.js 24 patches but reject Node.js 22,
Node.js 25, and the not-yet-LTS Node.js 26 line. CI and portable release inputs use the exact
24.18.0 patch so their artifact identity is reproducible.

The governed package manager is npm 11.16.0, the version bundled in the official Node.js 24.18.0
archives. Keiko pins it exactly in `packageManager` and `engines.npm`; every workflow verifies both
executed versions before `npm ci`.

## npm 12 decision

npm 12.0.1 was the registry's current stable version during implementation and supports Node.js
24.15 or newer. It is intentionally deferred. Official Node.js 24.18.0 archives carry npm 11.16.0,
so selecting npm 12 would require a separate network installation or mutation step in CI and every
portable target. That would make the declared package manager differ from the verified archive until
activation and would add a second supply-chain input outside the existing portable approval store.

The npm 12 decision can be reopened when an approved LTS archive bundles it or a separately
checksummed, offline npm payload is added to the existing portable-runtime approval and staging
contract. Updating `packageManager` alone is never sufficient.

## Enforced surfaces

- Root and all workspace `engines.node`: `>=24.18.0 <25`.
- Root and UI `engines.npm`: `11.16.0`; root `packageManager`: `npm@11.16.0`.
- Every GitHub Actions Node setup: exact `24.18.0`, followed by
  `node scripts/check-runtime-toolchain.mjs --exact` before installation.
- Cross-platform CI: Linux, macOS, and Windows perform clean install, typecheck, tests, build, and
  install smoke with native optional dependencies.
- Sandbox fallback image: `node:24.18.0-slim` with the existing no-network and workspace-containment
  controls unchanged.
- Portable Node archives: official 24.18.0 Windows x64, macOS arm64, and macOS x64 archives with
  SHA-256 identities sourced by the existing verified approvals updater.

Runtime diagnostics are body-free. The toolchain gate reports only Node.js version, npm version,
workspace count, and fixed policy errors; it does not emit environment variables, paths, package
manager logs, archive URLs, or credentials.

## Contributor migration

Install Node.js 24.18.x and use its bundled npm 11.16.0, then replace the dependency tree from the
committed lockfile:

```bash
node --version
npm --version
node scripts/check-runtime-toolchain.mjs
npm ci
```

Expected versions are Node.js `v24.18.0` or a later 24.x patch and npm `11.16.0`. CI remains exact at
Node.js 24.18.0. Node.js 22 is no longer a supported development or product runtime.

## Updating the LTS patch

Use the existing fail-closed updater; never edit archive digests by hand:

```bash
npm run portable:approve-runtimes -- --node-version <approved-24.x-version>
npm run check:portable-approvals
```

In the same reviewed change, update the engine floor, workflow inputs, sandbox image, toolchain gate,
and this document. Re-run all cross-platform, portable staging, package-surface, audit, SBOM, native
optional dependency, SQLite, and install-smoke gates before handoff. Publishing assets remains a
separate human-approved action.

## Rollback

Rollback is a normal reviewed revert or forward fix; it never rewrites Git history. Restore the last
approved Node.js 22/npm 10 declarations, workflow pins, sandbox image, and documentation, then use
the same updater to restore the reviewed Node.js 22 portable archive identities. Regenerate the
lockfile with that governed npm version and rerun the full release gate surface on all platforms.
Do not mix Node.js 24 manifests with Node.js 22 portable approvals, and do not publish rollback
assets without separate human authorization.
