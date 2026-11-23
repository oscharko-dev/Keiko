# Governed Runtime Toolchain

Status: Node 26 LTS only, owner decision effective 2026-11-15.

## Supported baseline

Keiko develops, tests and ships on **Node.js 26 LTS (Lithium)**. Repository and published workspace
manifests accept `>=26.13.1 <27`. Node 24 and earlier, pre-baseline Node 26 releases and Node 27 or
newer are rejected. The exact baseline is **Node 26.13.1 with its bundled npm 11.20.0** across CI,
portable archives, sandbox fallback and performance measurement.

The supported package-manager range is `>=11.20.0 <12`; `packageManager` is `npm@11.20.0`.
The archive's bundled npm is the supply-chain input: no separate npm-major upgrade is implied.
Every workflow verifies the exact Node/npm pair before `npm ci`.

Node 26 does not bundle Corepack. Install-smoke jobs copy the lockfile-verified Corepack package
into the selected Node runtime trust root with `scripts/prepare-trusted-corepack.mjs` before
provisioning the pinned Yarn smoke. They never execute a workspace-supplied package-manager shim.

## Enforced surfaces

- Root and all workspace `engines.node`: `>=26.13.1 <27`.
- Root and UI `engines.npm`: `>=11.20.0 <12`; root `packageManager`: `npm@11.20.0`.
- Every GitHub Actions Node setup: `26.13.1`, followed by the exact toolchain check.
- Full Linux test and coverage lanes plus macOS/Windows build, installation, native and environment
  regression checks. The latter cover temporary paths, local dates, certificate roots and actual
  isolated runtime selection; a successful Linux suite alone does not prove those host behaviors.
- Local gate image: Node `26.13.1-bookworm`; sandbox fallback: `node:26.13.1-slim`, retaining the
  existing no-network and workspace-containment controls.
- Portable Windows x64, macOS arm64, macOS x64 and Linux x64 Node 26.13.1 archives: SHA-256
  identities sourced from official Node release checksums by the existing approvals updater.

Runtime diagnostics are body-free. The gate reports versions, workspace count and fixed policy
errors, never environment values, paths, archive URLs or credentials. Existing runtime admission
and launch evidence records the actual selected executable and policy through its redacted fields.

## Contributor migration

Install the exact Node 26.13.1/npm 11.20.0 pair, select it on PATH, and replace dependencies from the
committed lockfile. Do not share `node_modules` between macOS, Windows and Linux containers.

```bash
node --version
npm --version
node scripts/check-runtime-toolchain.mjs --exact
npm ci
npm run provision:usearch
```

## Updating the baseline

Use the existing fail-closed updater; never edit archive digests by hand:

```bash
npm run portable:approve-runtimes -- --node-version <approved-26.x-version>
npm run check:portable-approvals
```

Update the exact gate, workflow and container pins, manifests and lockfile together. Re-measure
performance evidence whose measurement toolchain changed using its documented reference
procedure. Historical release receipts keep their actual recorded versions. Verify native optional
dependencies, SQLite, package assembly and install smokes on the supported desktop platforms.
Publishing release assets remains a separate action.

## Rollback

Use a reviewed revert or forward fix; never rewrite Git history. Restoring an older runtime line
requires a deliberate support-policy decision and coordinated manifests, exact pins, archive
approvals and qualification. A local PATH change alone never changes the product's runtime policy.

## Retired compatibility matrix

Node 26 is now the main runtime, so the separate four-shard Node 26 compatibility job is
removed. The required package-coverage matrix collects the complete root test inventory;
Editor fast-path PRs use the same four jobs to run the complete suite without coverage
instrumentation. Typecheck, UI builds and native optional install smokes remain in the
required core and cross-platform jobs. Exact Node/npm verification remains in every setup
lane, and verified-tree reuse requires every package and script shard to have succeeded.

## Pinned native helpers provisioned per checkout

Moved from [`AGENTS.md`](../AGENTS.md) §2 on 2026-11-23 without content changes.

**`provision:usearch` is a real prerequisite, not an optional extra.** The pinned USearch HNSW ANN
runtime (ADR-0164; sqlite-vec was retired — it performed exhaustive KNN, not ANN) is deliberately not
an npm dependency (upstream publishes an invalid SPDX license string that two supply-chain gates
reject), so the exact upstream tarball is fetched and SHA-256-verified by that script instead. CI
runs it as a setup step before every test lane. `npm test` does **not** run it for you, so on a
fresh checkout the two Knowledge-M2 proof suites — `knowledge-m2-closeout` (its `ann-active` proof)
and `knowledge-m2-clean-checkout-demo` — fail until you have run it once. They fail rather than skip
on purpose: a missing runtime must never quietly mask a real ANN regression.

**`provision:ripgrep` is the same pattern for the OpenCode coding runtime (#3897).** OpenCode's
`glob` and `grep` tools and its file finder run ripgrep. Left alone, the runtime downloads it from
GitHub on first use, which a firewalled customer and the loopback-only runtime lane forbid, and
search then fails silently. Keiko ships the identical upstream release (15.1.0) pinned and
SHA-256-verified in `packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts`: the script fetches
the one approved archive for the host, extracts only `rg` and `LICENSE-MIT` into the gitignored
`.ripgrep/<version>/<target>/`, and verifies both again. Portable staging copies those verified files
to `runtime/native/rg` (`rg.exe` on Windows). The npm runtime package builder
(`scripts/build-coding-runtime-npm-package.mjs`) stages the same verified `rg`, its `LICENSE-MIT` and a
component SBOM into `@oscharko-dev/keiko-coding-runtime-<target>` at the same paths, provisioning the
TARGET's release, so a clean `npm install -g` finds search normally and the server verifies
`<package>/runtime/native/rg` against the pinned digest at every run launch; `KEIKO_RIPGREP_BINARY_PATH`
remains a developer and qualification override only. Unit tests are hermetic and do not need it; the
customer-shape qualification, the nightly real-binary journey, the portable stage jobs and the npm runtime
package build do, and CI runs it as a setup step there.
