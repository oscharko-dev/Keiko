# ADR-0021: Publish Strategy — Vendored Monorepo Product

## Status

Accepted

## Date

2026-06-03

## Version

1.1

## Context

ADR-0019 §"Build And Packaging Model" states: "The published package may bundle internal workspace
packages into `dist` to avoid publishing many customer-facing packages prematurely. Publishing
separate internal packages is a later decision, not part of this ADR." ADR-0020 D7 explicitly
defers the publish strategy, per-package SBOM generation, and the installable-smoke gate to
Issue #169.

As of `a4c0c828` (dev, 2026-06-03), the workspace extraction sprint had produced ten private
workspace packages under `packages/`:

- `@oscharko-dev/keiko-contracts`
- `@oscharko-dev/keiko-security`
- `@oscharko-dev/keiko-model-gateway`
- `@oscharko-dev/keiko-workspace`
- `@oscharko-dev/keiko-tools`
- `@oscharko-dev/keiko-evidence`
- `@oscharko-dev/keiko-harness`
- `@oscharko-dev/keiko-workflows`
- `@oscharko-dev/keiko-server`
- `@oscharko-dev/keiko-cli`

The runtime set has since grown, but the invariant is unchanged: runtime workspaces carry
`"private": true`, while `keiko-ui` and `keiko-editor` are build-time-only.

The source root `package.json` lists private runtime workspaces as pinned dependencies and keeps the
runtime inventory in `bundleDependencies`. Those fields resolve through npm workspace symlinks
during development. They are build inputs, not the manifest shipped to customers.

An empirical verification on 2026-06-03 confirmed the gap: running `npm pack` at the repo root
produces `oscharko-dev-keiko-0.1.6.tgz`. Installing that tarball into a clean `tmpdir` fails with
`E404 @oscharko-dev/keiko-cli@*` — the workspace-symlinked packages are not on the public registry
and are therefore unreachable. Every package dependency resolves to MISSING. This is the
correctness gap that Issue #169 Acceptance Criterion 2 gates against.

On 2026-08-13 a customer reported the same class of failure with Yarn 4.9.1:
`@oscharko-dev/keiko-cli@npm:0.3.6: No candidates found`. Yarn has deliberately not supported
`bundleDependencies` since Yarn 2; it ignores the embedded `node_modules` graph and resolves the
declared dependencies from the registry. The registry smoke had explicitly skipped Yarn for this
root-only bundle, so the incompatible artifact passed every release gate. A package-manager-specific
bundle is therefore not a self-contained product artifact.

The architectural question resolved here: how should the root product artifact be made
self-contained without publishing private workspace packages to the registry?

## Decision

### D1 — Strategy: staged `file:` vendoring in the root package

The source root `package.json` keeps the reviewed runtime-workspace inventory in
`bundleDependencies`. Build-time-only workspaces such as `keiko-ui` and `keiko-editor` are excluded.
`scripts/stage-publish-package.mjs` converts that inventory into a temporary publish directory after
the release gates pass. It copies every declared publish path from each runtime workspace, writes a
reduced private manifest, packs that surface into a versioned archive under `vendor/`, copies
the root product surface, and writes a staged root manifest such as:

```json
"files": ["dist", "vendor", "README.md", "LICENSE", "NOTICE", "TRADEMARKS.md"],
"dependencies": {
  "@oscharko-dev/keiko-contracts": "file:vendor/oscharko-dev-keiko-contracts-0.3.7.tgz",
  "@oscharko-dev/keiko-server": "file:vendor/oscharko-dev-keiko-server-0.3.7.tgz",
  "@oscharko-dev/keiko-cli": "file:vendor/oscharko-dev-keiko-cli-0.3.7.tgz"
}
```

The staged manifest retains `bundleDependencies` and carries its reduced payload under
`node_modules/` for npm, while every internal dependency also names a standard `file:` archive
whose bytes are inside the same root tarball for Yarn. Both projections come from the same staged
workspace surface. The dual representation is required because npm consumes its bundle payload
when installing an outer tarball, while Yarn gives directory `file:` dependencies different
resolution semantics when the parent is an npm registry locator. Internal edges in vendored manifests
become exact-version peer dependencies so npm and Yarn resolve every private package to the sibling
provided by the root. External dependencies remain declared by their owning vendored manifest and
are also promoted at their reviewed lockfile version to the staged root manifest so the published
root graph remains deterministic and auditable. External peers are promoted as required or optional
according to their peer metadata. Missing or incompatible
locked resolutions fail staging; missing runtime surfaces fail the npm/Yarn install smoke.

Source workspace manifests remain `private: true`, source dependencies stay pinned for ordinary npm
workspace development, and no source file is mutated during staging. The root
`@oscharko-dev/keiko` tarball remains the only published npm artifact; package managers never query
the registry for internal workspace names.

### D2 — build-time browser workspaces are excluded from vendoring

`@oscharko-dev/keiko-ui` is a build-time-only package. `scripts/build-ui.mjs:51` runs
`npm run build --workspace @oscharko-dev/keiko-ui`, which invokes the Next.js static export.
`scripts/build-ui.mjs:53-54` then copies the output into `dist/ui/static/`. The BFF
(`dist/ui/index.js`) never imports from `keiko-ui` at runtime — it only serves the pre-built
static files that were copied during `prepack`.

Including `keiko-ui` in the vendored runtime would:

- ship Next.js, React, and all Next.js build-time devDependencies inside the consumer's tarball;
- duplicate the React runtime alongside the already-copied `dist/ui/static/` output;
- balloon the tarball with code the BFF process never executes.

The existing `scripts/check-package-surface.mjs:101-103` already enforces that no
`packages/keiko-ui/` source enters the tarball. That rule is unchanged.

`@oscharko-dev/keiko-editor` is also build-time-only for the published root product and is excluded
from the runtime inventory. Its build output is checked by repository build gates, but it is not an
independently published npm package and not a runtime dependency of the root artifact.

### D3 — Why NOT publish every workspace package independently

Publishing each `@oscharko-dev/keiko-*` package independently to the npm registry would require:

- removing `"private": true` from internal packages;
- independently versioning each package and managing inter-package version ranges;
- releasing all internal workspaces in lock-step on every product change (any domain update touches multiple
  packages simultaneously);
- re-auditing every package's `files` manifest, `exports` surface, and public API contract as a
  stable, consumer-facing interface;
- establishing a multi-package release automation pipeline (changesets or similar) before the
  package boundaries have stabilised.

The workspace boundaries exist for source-tree clarity, dependency-direction enforcement, and the
architecture gate (ADR-0020 D4), not for independent distribution. Independent publishing is an
option for a future ADR if a customer requires a single internal package without the full product
install. That decision should follow at least one product release cycle of the vendored artifact
proving the boundaries are stable.

### D4 — Why NOT a bundler (esbuild/rollup) at the root

Introducing esbuild or rollup at the root would:

- place a bundler on the trust path described in ADR-0006, which governs safe tool execution and
  patch application boundaries;
- collapse the distinct per-package ESM `exports` fields, making it impossible to verify
  package-surface invariants per package in `scripts/check-package-surface.mjs`;
- complicate source maps and the architecture gate (dependency-cruiser validates the un-bundled
  import graph; a bundler changes that graph);
- add a new build tool to the `devDependencies` surface and require ongoing maintenance of bundler
  configuration as packages evolve.

The build chain remains TypeScript project output plus the root facade. Staged vendoring preserves
the per-package module and export boundaries without placing a JavaScript bundler on the runtime
trust path.

### D5 — Staging is isolated and deterministic

The earlier decision rejected pre-pack vendoring because an in-place script could mutate source
manifests, depend on intermediate tarballs, and drift from the workspace list. The customer failure
changes the decisive fact: npm's bundle primitive is not portable across supported package
managers. The accepted implementation avoids those rejected failure modes:

- the source `package.json`, workspace manifests, and lockfile are never rewritten;
- one temporary directory is assembled directly from the reviewed runtime inventory and built
  outputs, then deleted after pack/publish;
- each workspace archive is produced from an isolated reduced manifest and declared publish surface;
  temporary assembly directories are deleted before the root package is packed;
- staged manifests retain normal dependency and bundle metadata, so npm, Yarn, audit tools, and
  SBOM gates see the runtime graph;
- package-surface, install, and release-publish paths all call the same staging producer.

Direct publication from the source root is not the release path. `scripts/release-publish.mjs`
publishes only the staged directory after the full `prepack` gate.

### D6 — Supply-chain controls for vendored private workspaces

Vendoring keeps internal packages private but still requires an auditable source and dependency
graph. Four controls remain load-bearing:

1. Every vendored package is `"private": true` and its source is reproducible from this repo's
   commit. The registry is never consulted for internal names; ordinary third-party dependencies
   continue to resolve from the configured registry under their reviewed manifests.
2. Per-workspace CycloneDX SBOMs are emitted in CI by the new
   `scripts/check-workspace-supply-chain.mjs` script and uploaded as the
   `workspace-sboms-cyclonedx` CI artifact. This provides an auditable bill of materials for
   every vendored package's transitive dependency graph.
3. The installable-smoke gate (`scripts/installable-package-smoke.mjs`, run as
   `npm run smoke:install`) re-verifies after every push that npm installs the staged tarball and
   pinned Yarn 4.9.1 installs it through a loopback npm-registry locator. It then verifies that
   `keiko --version`, `keiko --help`, the SDK root, and external declarations remain reachable.
   AC2 cannot silently regress.
4. A workspace-license allow-list encoded in `scripts/check-workspace-supply-chain.mjs` fails CI
   on any SPDX identifier not in the approved set, making unexpected license introduction visible
   in PR review.

### D7 — Installable-package smoke

The script `scripts/installable-package-smoke.mjs` defines the AC2 gate: it stages and packs the
publish artifact, installs the tarball into a clean npm project, and serves the exact same bytes
through a hermetic loopback npm registry for a clean Yarn 4.9.1 install. It asserts all vendored
workspace `dist/` trees are installed and executes `keiko --version` and `keiko --help`. It also
asserts the SDK root runtime and declaration exports resolve. The npm lane continues through the
packaged UI and lifecycle integration proof.

The `smoke:install` script is wired into the existing `build-scan-sbom-smoke` CI job
(`.github/workflows/ci.yml:79`) after the `Build` step.

### D8 — Acceptance of tarball size trade-off

The 0.3.6 npm bundle was approximately 73.4 MB unpacked because npm embedded internal and transitive
trees. The corrected staged artifact measures approximately 7.8 MB compressed / 32.1 MB unpacked
before ordinary third-party installation. This is acceptable for an enterprise developer-assist
product where:

- the install is a one-shot per-developer operation, not a container base-image layer;
- the alternative (independent package publishing) introduces higher operational complexity;
- the vendored bytes are the reviewed private manifests and compiled workspace output; ordinary
  third-party dependencies remain package-manager-managed instead of being duplicated in the
  tarball.

## Consequences

### Positive

- The published `@oscharko-dev/keiko` tarball is portable across npm and Yarn 4; neither package
  manager queries the registry for private workspace names.
- Workspace packages remain `"private": true`; no per-package versioning, release pipeline, or
  public API contract is required at this stage.
- No JavaScript bundler or public internal-package release train is required.
- The installable-smoke gate (AC2) permanently closes the regression window where a packaging
  change can silently break the published artifact.
- Per-workspace SBOMs (AC4) continue to provide supply-chain transparency for the vendored graph.

### Negative

- Release packaging now owns a small staging implementation that must remain synchronized with npm
  and Yarn file-dependency semantics.
- Every internal package is installed as a root-provided file dependency so peer edges remain
  package-manager-visible; this is a deliberate publish-time projection of the source dependency
  graph.
- Any workspace package added to `packages/` in the future must also be added to
  the runtime inventory and supply-chain script simultaneously, or staging/AC2 fails on the next
  pack cycle.

### Neutral

- The `keiko-ui` exclusion from runtime vendoring requires the pre-built `dist/ui/static/`
  output to be present in the tarball; `prepack` already enforces this via `scripts/build-ui.mjs`
  and `scripts/check-package-surface.mjs`.
- Independent per-package publishing remains a valid future path; removing `"private": true` from
  individual packages and publishing them is a one-ADR change once boundaries are proven stable
  across a full product release cycle.

## Alternatives Considered

### Alternative 1: Publish every workspace package independently

- **Pros**: Each package is independently installable; consumers could adopt a subset of the
  product stack; supply-chain tooling handles each package transparently.
- **Cons**: Requires removing `"private": true`, independent versioning, lock-step releases,
  per-package `files` / `exports` auditing as a public surface contract, and a multi-package
  release automation pipeline. The package boundaries have not yet proven stable across a full
  product release cycle.
- **Why rejected**: The workspace boundaries exist for source-tree governance, not independent
  distribution. The overhead is disproportionate until boundaries are proven stable and a customer
  explicitly requires a single internal package.

### Alternative 2: Keep npm `bundleDependencies` and document Yarn as unsupported

- **Pros**: No release-pipeline change.
- **Cons**: Yarn 2+ deliberately resolves those declared dependencies from the registry, so the
  documented install command fails before fetching Keiko. The existing registry gate had to skip
  Yarn to remain green.
- **Why rejected**: Keiko already models Yarn as a supported installed update mode. A root package
  that cannot be installed by Yarn is a product defect, not an acceptable documentation caveat.

### Alternative 3: Bundler (esbuild/rollup) at the root

- **Pros**: Single emitted file; can tree-shake unused exports; deployment artefact is maximally
  compact.
- **Cons**: Places a bundler on the trust path (ADR-0006); collapses per-package ESM `exports`;
  complicates source maps; invalidates the dependency-cruiser import graph that is the architecture
  gate's input; adds ongoing bundler configuration maintenance.
- **Why rejected**: The build chain is already correct (`tsc` + per-package `npm run build`).
  Introducing a bundler solves a non-problem and creates new surface in the trust path.

### Alternative 4: In-place or per-workspace-tarball vendoring

- **Pros**: Also avoids `bundleDependencies` semantics.
- **Cons**: Mutates reviewed source manifests or creates ordering-dependent intermediate tarballs;
  a failed lifecycle can leave the checkout in a publish-only state.
- **Why rejected**: D5's isolated directory staging gets the portability benefit without source
  mutation or intermediate package archives.

### Alternative 5: Status quo — do nothing

- **Pros**: No code change required; workspace packages remain uncoupled from the root publish
  path.
- **Cons**: `npm install @oscharko-dev/keiko` fails with E404 for every extracted workspace
  package. The product is not installable from the registry. This is the confirmed broken state
  as of 2026-06-03.
- **Why rejected**: A product artifact that cannot be installed is not a product artifact. This
  state must be gated by AC2 and must not recur.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md): Modular Package Architecture — establishes
  that internal workspace packages may ship inside the root product; defers the how to a later
  decision.
- [ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md): Workspace Tooling and
  Architecture Gate — D7 explicitly defers the publish strategy, per-package SBOM, and
  installable-smoke gate to Issue #169; this ADR resolves that deferral.
- Issue #156: Epic — Modular package architecture sprint (parent).
- Issue #169: CI, package-surface, SBOM, and release gates for the workspace architecture (this
  issue — the deliverable this ADR supports).
- `scripts/installable-package-smoke.mjs` — new script (developer-owned, Issue #169) that
  implements the AC2 installable-smoke gate referenced in D7.
- `scripts/stage-publish-package.mjs` — the single producer for the vendored npm artifact.
- `scripts/check-workspace-supply-chain.mjs` — new script (developer-owned, Issue #169) that
  implements the per-workspace SBOM and license allow-list gate referenced in D6.

## Revision Policy

If the runtime inventory or staged manifest projection changes (new workspace package, dependency
promotion, or independent publish), or the supply-chain controls change materially, increment the
version and record the reason in the Version History table below.

## Version History

| Version | Date       | Change                                                                                                                               |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0     | 2026-06-03 | Accepted bundled-monorepo publish strategy for Issue #169; resolves ADR-0020 deferred decision D7. |
| 1.1     | 2026-08-13 | Replaced the Yarn-incompatible published bundle with isolated `file:` vendoring and mandatory npm/Yarn install proofs.               |
