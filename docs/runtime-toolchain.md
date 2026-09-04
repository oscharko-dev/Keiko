# Governed Runtime Toolchain

Status: production baseline for issue #2294, effective 2026-07-11.

## Supported baseline

Keiko develops and tests on Node.js 24 LTS (`Krypton`) and Node.js 26. Repository and published
workspace manifests accept Node.js `>=24.18.0 <25 || >=26.3.0 <27`; Node.js 26.3.0 is the first 26.x
release that bundles the minimum governed npm version. Node.js 22, Node.js 25, Node.js 26.0-26.2,
and Node.js 27 or newer are rejected. Portable releases and D12 measurements remain exact on
24.18.0 so their artifact and measurement identities stay reproducible.

The supported package-manager range is npm `>=11.16.0 <12`. Keiko retains `npm@11.16.0` as its exact
`packageManager`, publish, portable, and measurement baseline; Node.js 26.8.1 compatibility CI uses
its bundled npm 11.19.0. Every workflow verifies an approved Node/npm pair before `npm ci`.

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

- Root and all workspace `engines.node`: `>=24.18.0 <25 || >=26.3.0 <27`.
- Root and UI `engines.npm`: `>=11.16.0 <12`; root `packageManager`: `npm@11.16.0`.
- GitHub Actions use exact approved pairs: the reproducible baseline is `24.18.0`/`11.16.0`, and
  dedicated compatibility CI uses `26.8.1`/`11.19.0`. Every setup is followed by
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

Install Node.js 24.18.x or later in the 24 line, or Node.js 26.3.x or later in the 26 line, and use
npm 11.16.0 or newer below npm 12. Then replace the dependency tree from the committed lockfile:

```bash
node --version
npm --version
node scripts/check-runtime-toolchain.mjs
npm ci
```

Expected versions match `>=24.18.0 <25 || >=26.3.0 <27` with npm `>=11.16.0 <12`. CI proves the
exact pairs `24.18.0`/`11.16.0` and `26.8.1`/`11.19.0`. Odd Node.js majors remain unsupported.

## Updating runtime baselines

Use the existing fail-closed updater; never edit archive digests by hand:

```bash
npm run portable:approve-runtimes -- --node-version <approved-24.x-version>
npm run check:portable-approvals
```

Updating the portable Node 24 patch still uses the updater above. Updating a compatibility baseline
changes the exact CI tuple and toolchain gate but does not alter portable approvals, sandbox images,
or D12 evidence. Re-run all cross-platform, package-surface, native optional dependency, SQLite, and
install-smoke gates before handoff. Publishing assets remains a separate human-approved action.

## Rollback

Rollback is a normal reviewed revert or forward fix; it never rewrites Git history. To withdraw
Node 26 compatibility, restore the Node-24-only engine and npm declarations and remove the Node 26
CI tuple while leaving the exact Node 24 portable approvals unchanged. Regenerate the lockfile with
the governed npm version and rerun the full release gate surface on all platforms.
