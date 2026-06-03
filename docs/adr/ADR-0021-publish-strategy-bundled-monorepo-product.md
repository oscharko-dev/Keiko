# ADR-0021: Publish Strategy — Bundled Monorepo Product

## Status

Accepted

## Date

2026-06-03

## Version

1.0

## Context

ADR-0019 §"Build And Packaging Model" states: "The published package may bundle internal workspace
packages into `dist` to avoid publishing many customer-facing packages prematurely. Publishing
separate internal packages is a later decision, not part of this ADR." ADR-0020 D7 explicitly
defers the publish strategy, per-package SBOM generation, and the installable-smoke gate to
Issue #169.

As of `a4c0c828` (dev, 2026-06-03), the workspace extraction sprint has produced ten private
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

All ten carry `"private": true` in their `package.json`. A separate UI package,
`@oscharko-dev/keiko-ui`, also exists under `packages/` and is build-time-only.

The root `package.json` lists all ten domain packages as `"*"` dependencies
(`package.json:67-77`). These resolve at install time via npm workspace symlinks during
development. The root manifest does not yet set `private: true`, and currently carries no
`bundleDependencies` field.

An empirical verification on 2026-06-03 confirmed the gap: running `npm pack` at the repo root
produces `oscharko-dev-keiko-0.1.6.tgz`. Installing that tarball into a clean `tmpdir` fails with
`E404 @oscharko-dev/keiko-cli@*` — the workspace-symlinked packages are not on the public registry
and are therefore unreachable. Every package dependency resolves to MISSING. This is the
correctness gap that Issue #169 Acceptance Criterion 2 gates against.

The architectural question resolved here: how should the root product artifact be made
self-contained without publishing the ten private workspace packages to the registry?

## Decision

### D1 — Strategy: `bundleDependencies` in the root package

We will add a `bundleDependencies` array to the root `package.json` listing every
`@oscharko-dev/keiko-*` workspace package except `keiko-ui`:

```json
"bundleDependencies": [
  "@oscharko-dev/keiko-contracts",
  "@oscharko-dev/keiko-security",
  "@oscharko-dev/keiko-model-gateway",
  "@oscharko-dev/keiko-workspace",
  "@oscharko-dev/keiko-tools",
  "@oscharko-dev/keiko-evidence",
  "@oscharko-dev/keiko-harness",
  "@oscharko-dev/keiko-workflows",
  "@oscharko-dev/keiko-server",
  "@oscharko-dev/keiko-cli"
]
```

Workspace packages remain `"private": true`. The root `@oscharko-dev/keiko` remains the only
published artifact.

When `npm pack` runs at the repo root with workspaces installed, npm walks the listed names in
`node_modules/`, follows the workspace symlinks to `packages/<name>/`, and includes each package's
published surface (governed by that package's own `files` list — `dist/` only) inside a
`node_modules/@oscharko-dev/keiko-<name>/` tree in the tarball. On `npm install`, npm extracts the
bundle in place and no registry lookup occurs for those names.

### D2 — keiko-ui is excluded from `bundleDependencies`

`@oscharko-dev/keiko-ui` is a build-time-only package. `scripts/build-ui.mjs:51` runs
`npm run build --workspace @oscharko-dev/keiko-ui`, which invokes the Next.js static export.
`scripts/build-ui.mjs:53-54` then copies the output into `dist/ui/static/`. The BFF
(`dist/ui/index.js`) never imports from `keiko-ui` at runtime — it only serves the pre-built
static files that were copied during `prepack`.

Including `keiko-ui` in `bundleDependencies` would:

- ship Next.js, React, and all Next.js build-time devDependencies inside the consumer's tarball;
- duplicate the React runtime alongside the already-copied `dist/ui/static/` output;
- balloon the tarball with code the BFF process never executes.

The existing `scripts/check-package-surface.mjs:101-103` already enforces that no
`packages/keiko-ui/` source enters the tarball. That rule is unchanged.

### D3 — Why NOT publish every workspace package independently

Publishing each `@oscharko-dev/keiko-*` package independently to the npm registry would require:

- removing `"private": true` from all ten packages;
- independently versioning each package and managing inter-package version ranges;
- releasing all ten in lock-step on every product change (any domain update touches multiple
  packages simultaneously);
- re-auditing every package's `files` manifest, `exports` surface, and public API contract as a
  stable, consumer-facing interface;
- establishing a multi-package release automation pipeline (changesets or similar) before the
  package boundaries have stabilised.

The workspace boundaries exist for source-tree clarity, dependency-direction enforcement, and the
architecture gate (ADR-0020 D4), not for independent distribution. Independent publishing is an
option for a future ADR if a customer requires a single internal package without the full product
install. That decision should follow at least one product release cycle of the bundled artifact
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

The build chain is already `tsc -p tsconfig.build.json` (root) plus per-package `npm run build`
(each `packages/<name>/`). `bundleDependencies` is the idiomatic npm primitive for producing a
self-contained tarball from an already-compiled workspace without a bundler.

### D5 — Why NOT a pre-pack vendoring script

An alternative is a script that runs `npm pack` per workspace package, places the resulting
`.tgz` files in a `vendor/` directory, and rewrites the root `dependencies` to
`"file:./vendor/<name>.tgz"` before `npm pack`. This would:

- require a bespoke script that must stay synchronised with the package list and version numbers;
- make the `npm pack` output dependent on script execution order and intermediate state;
- complicate `npm ci` and lockfile reproducibility (file-path references resolve differently in CI
  without the vendor directory pre-populated);
- be invisible to tools that understand `bundleDependencies` semantics (npm audit, SBOM tooling).

`bundleDependencies` is the documented npm primitive for this exact problem and requires no
bespoke tooling.

### D6 — Supply-chain audit compensator for `bundleDependencies`

`bundleDependencies` is a known reduction in supply-chain transparency: bundled package trees are
not independently enumerated in the consumer's `package-lock.json` after install. Four compensating
controls are put in place:

1. Every bundled package is `"private": true` and its source is reproducible from this repo's
   commit. There is no external resolution surface — the registry is never consulted for these
   names.
2. Per-workspace CycloneDX SBOMs are emitted in CI by the new
   `scripts/check-workspace-supply-chain.mjs` script and uploaded as the
   `workspace-sboms-cyclonedx` CI artifact. This provides an auditable bill of materials for
   every bundled package's transitive dependency graph.
3. The installable-smoke gate (`scripts/installable-package-smoke.mjs`, run as
   `npm run smoke:install`) re-verifies after every push that the packed tarball installs cleanly
   into a clean directory and that `keiko --version` and `keiko --help` exit 0. AC2 cannot
   silently regress.
4. A workspace-license allow-list encoded in `scripts/check-workspace-supply-chain.mjs` fails CI
   on any SPDX identifier not in the approved set, making unexpected license introduction visible
   in PR review.

### D7 — Installable-package smoke

The script `scripts/installable-package-smoke.mjs` defines the AC2 gate: it runs `npm pack`,
installs the resulting tarball into a `mkdtemp` directory, asserts the bundled workspace `dist/`
trees are present, and executes `keiko --version` and `keiko --help`. It also asserts the SDK root
export resolves with named exports via a dynamic `import()`. The full step-by-step procedure is
defined in the Issue #169 spec D2 and is owned by the developer; this ADR references its existence
as an architecture invariant but does not duplicate the implementation steps.

The `smoke:install` script is wired into the existing `build-scan-sbom-smoke` CI job
(`.github/workflows/ci.yml:79`) after the `Build` step.

### D8 — Acceptance of tarball size trade-off

The root tarball today packs at approximately 1.3 MB unpacked. With ten workspace `dist/` trees
bundled, the unpacked size grows to approximately 2.3 MB. This is acceptable for an enterprise
developer-assist product where:

- the install is a one-shot per-developer operation, not a container base-image layer;
- the alternative (independent package publishing) introduces higher operational complexity;
- the added size is entirely compiled TypeScript output (`dist/`) with no duplicate transitive
  third-party dependencies (each workspace package depends only on other workspace packages and
  the small set of runtime dependencies already present in the root `dependencies` field).

## Consequences

### Positive

- The published `@oscharko-dev/keiko` tarball becomes self-contained; `npm install` into a clean
  environment no longer fails with E404 for workspace package names.
- Workspace packages remain `"private": true`; no per-package versioning, release pipeline, or
  public API contract is required at this stage.
- No new build tooling is required; `bundleDependencies` is a standard npm field processed by the
  existing `npm pack` / `npm install` implementation.
- The installable-smoke gate (AC2) permanently closes the regression window where a packaging
  change can silently break the published artifact.
- Per-workspace SBOMs (AC4) provide supply-chain transparency that the bundled tarball format
  would otherwise reduce.

### Negative

- Tarball unpacked size grows from approximately 1.3 MB to approximately 2.3 MB.
- `bundleDependencies` bundled trees are not independently visible in the consumer's
  `package-lock.json` after install; mitigated by the per-workspace SBOM gate (D6 control 2).
- Any workspace package added to `packages/` in the future must also be added to
  `bundleDependencies` and the supply-chain script simultaneously, or AC2 will fail on the next
  `npm pack` cycle.

### Neutral

- The `keiko-ui` exclusion from `bundleDependencies` requires the pre-built `dist/ui/static/`
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

### Alternative 2: Bundler (esbuild/rollup) at the root

- **Pros**: Single emitted file; can tree-shake unused exports; deployment artefact is maximally
  compact.
- **Cons**: Places a bundler on the trust path (ADR-0006); collapses per-package ESM `exports`;
  complicates source maps; invalidates the dependency-cruiser import graph that is the architecture
  gate's input; adds ongoing bundler configuration maintenance.
- **Why rejected**: The build chain is already correct (`tsc` + per-package `npm run build`).
  Introducing a bundler solves a non-problem and creates new surface in the trust path.

### Alternative 3: Pre-pack vendoring script with `file:` references

- **Pros**: No dependency on `bundleDependencies` semantics; vendor directory is visually
  inspectable.
- **Cons**: Bespoke script; must stay synchronised with the package list and version numbers;
  requires the vendor directory to be pre-populated for `npm ci` to resolve cleanly; less legible
  to npm audit and SBOM tooling than `bundleDependencies`.
- **Why rejected**: `bundleDependencies` is the documented npm primitive for this exact scenario.
  A bespoke script adds complexity and failure modes without improving on the primitive.

### Alternative 4: Status quo — do nothing

- **Pros**: No code change required; workspace packages remain uncoupled from the root publish
  path.
- **Cons**: `npm install @oscharko-dev/keiko` fails with E404 for every extracted workspace
  package. The product is not installable from the registry. This is the confirmed broken state
  as of 2026-06-03.
- **Why rejected**: A product artifact that cannot be installed is not a product artifact. This
  state must be gated by AC2 and must not recur.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md): Modular Package Architecture — establishes
  that internal workspace packages may be bundled into the root product; defers the how to a later
  decision.
- [ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md): Workspace Tooling and
  Architecture Gate — D7 explicitly defers the publish strategy, per-package SBOM, and
  installable-smoke gate to Issue #169; this ADR resolves that deferral.
- Issue #156: Epic — Modular package architecture sprint (parent).
- Issue #169: CI, package-surface, SBOM, and release gates for the workspace architecture (this
  issue — the deliverable this ADR supports).
- `scripts/installable-package-smoke.mjs` — new script (developer-owned, Issue #169) that
  implements the AC2 installable-smoke gate referenced in D7.
- `scripts/check-workspace-supply-chain.mjs` — new script (developer-owned, Issue #169) that
  implements the per-workspace SBOM and license allow-list gate referenced in D6.

## Revision Policy

If the `bundleDependencies` list changes (new workspace package added or promoted to independent
publish), or the supply-chain compensating controls change materially, increment the version and
record the reason in the Version History table below.

## Version History

| Version | Date       | Change                                                                                                                               |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0     | 2026-06-03 | Accepted bundled-monorepo publish strategy for Issue #169; resolves ADR-0020 deferred decision D7. |
