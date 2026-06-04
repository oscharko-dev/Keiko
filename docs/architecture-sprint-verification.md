# Final Modular Architecture Verification (Issue #170)

This document is the closure gate for the modular-architecture epic
[#156](https://github.com/oscharko-dev/Keiko/issues/156). It aggregates the executable
evidence that proves the modular architecture works end-to-end from a packed npm artifact:
ten extracted workspace packages install and run, the CLI and local UI come up from a clean
sandbox, the gateway / workflow / tool / evidence surfaces behave identically to the
pre-modular release, and a 0.1.x install upgrades without forced reconfiguration or silent
state loss. It enumerates the acceptance criteria for issue
[#170](https://github.com/oscharko-dev/Keiko/issues/170), the deliverables, the encoded
[ADR-0019](adr/ADR-0019-modular-package-architecture.md) invariants, the known limitations,
and the follow-up epics that resume on this foundation. This document is the deliverable, not
a release manifest.

## Scope

This verification proves that the in-tree modular architecture is internally consistent and
that the artifact `npm pack` produces is installable, runnable, and read-compatible with a
0.1.x install. It does NOT publish a release to the npm registry, it does NOT add a new
Windows-hosted CI runner, and it does NOT introduce new test infrastructure: every cited
primitive already exists on `dev` and is exercised on every push by the `ci`,
`build-scan-sbom-smoke`, and `ui` jobs in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Verification context

| Field          | Value                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| Tree SHA       | `b9e1d15a73322be67f7685ce38f81054b70faf41`                                    |
| Branch         | `codex/release-0.1.7-architecture-audit`                                      |
| Run timestamp  | 2026-06-04T05:47:45Z                                                          |
| Node / npm     | v22.22.3 / 10.9.8                                                             |
| Tarball        | `oscharko-dev-keiko-0.1.7.tgz` (949.2 kB packed, 3.7 MB unpacked, 1768 files) |
| Tarball shasum | `ff9ebc5437c59484910864960276ff159603abae`                                    |

## Acceptance criteria verdict

| #   | Acceptance criterion                                                                                                | Verification primitive (file:line or command)                                                                                                                                                                                                                                                                    | Evidence (run output / verdict)                                                                                                                                                                                                                                                                                                                                             | Verdict |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | The packed artifact installs without private workspace symlink leakage.                                             | [`scripts/installable-package-smoke.mjs`](../scripts/installable-package-smoke.mjs) + [`scripts/check-package-surface.mjs`](../scripts/check-package-surface.mjs)                                                                                                                                                | `smoke:install` exit 0 in 18.8s: `installable-smoke ok: tarball installed, 10 bundled packages present, CLI + SDK reachable.` Every `@oscharko-dev/keiko-<name>` listed in the root `bundleDependencies` (the 10-entry array in [`package.json`](../package.json)) ships under `node_modules/@oscharko-dev/keiko/node_modules/<scope>/<name>/dist/`.                        | PASS    |
| 2   | The CLI lifecycle and local UI work from a clean sandbox.                                                           | `smoke:install` (tmpdir tarball install + CLI bin + SDK root) + `node dist/cli/index.js ui --port N` + `curl http://127.0.0.1:N/api/health`                                                                                                                                                                      | CLI mode `-rwxr-xr-x`; `--version` → `keiko 0.1.7`; `--help` lists 14 subcommands; unknown command exits 2; UI returns body `{"status":"ok","version":"0.1.7"}`, exits clean on signal. SDK root export resolves 132 named keys and `runVerification` is a function.                                                                                                        | PASS    |
| 3   | The existing gateway setup, model call, workspace access, workflow run, tool, and evidence behavior is preserved.   | `KEIKO_EVIDENCE_DIR=… node dist/cli/index.js evaluate --suite all` (CI-parity command that exercises the gateway, workflows, tools, and evidence surfaces in one) + the full vitest suite (`npm test`)                                                                                                           | `evaluate` exit 0 in 0.03s: `Verdict: GO — pilot ready (all Go/No-Go thresholds met).` 6 fixtures / 6 PASS, 7 scoring dimensions / 7 PASS, surface-parity 8 checks PASS. Vitest: 148 files / 2068 passed / 1 skipped.                                                                                                                                                       | PASS    |
| 4   | Pre-modular local state is read by the packed modular artifact without forced reconfiguration or silent state loss. | [`tests/upgrade-smoke/upgrade-compatibility.test.ts`](../tests/upgrade-smoke/upgrade-compatibility.test.ts) (10 tests against [`tests/upgrade-smoke/fixture/pre-modular-0.1.x/`](../tests/upgrade-smoke/fixture/pre-modular-0.1.x/)) + [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md) | Vitest 10/10 passing. The post-modular surfaces imported by the test (`@oscharko-dev/keiko-server`, `@oscharko-dev/keiko-evidence`, `@oscharko-dev/keiko-model-gateway`) are the same surfaces a tarball-installed consumer resolves. The 8-category verdict is recorded at [issue #170 comment](https://github.com/oscharko-dev/Keiko/issues/170#issuecomment-4616809868). | PASS    |
| 5   | The Conversation Center and PWA epics can resume with the architecture prerequisite satisfied or documented.        | ADR-0019 §"Required Dependency Direction" (9 rules) + §"Trust-Boundary Rules" (8 rules), encoded in [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs); negative-test fixtures under [`tests/architecture/fixtures/`](../tests/architecture/fixtures/)                                                      | Epic #156 audit hardening reran the gate with `arch:check` exit 0: `no dependency violations found (523 modules, 1126 dependencies cruised)`. `arch:check:negative` exit 0: `PASS — gate fired on 12 fixture(s) as expected.` Epics #142 and #121 inherit these boundaries unchanged.                                                                                       | PASS    |

## Deliverables verdict

| #   | Deliverable                                      | Location                                                                                                                                                                                                                                                                                                                  | Status                                                       |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Final architecture-sprint verification matrix.   | This document (`docs/architecture-sprint-verification.md`).                                                                                                                                                                                                                                                               | Delivered by this PR.                                        |
| 2   | Fresh-install evidence from the packed artifact. | [`scripts/installable-package-smoke.mjs`](../scripts/installable-package-smoke.mjs), executed on every push to `dev` via the `build-scan-sbom-smoke` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).                                                                                                    | Delivered. Latest run captured in the matrix above (step 9). |
| 3   | Closure comment on the architecture epic.        | Posted to [issue #156](https://github.com/oscharko-dev/Keiko/issues/156#issuecomment-4617430851) after [PR #241](https://github.com/oscharko-dev/Keiko/pull/241) merged, linking to this document, to the verdict matrix at [issue #170](https://github.com/oscharko-dev/Keiko/issues/170), and to the merged commit SHA. | Delivered.                                                   |
| 4   | Upgrade-compatibility evidence.                  | [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md) + [`tests/upgrade-smoke/upgrade-compatibility.test.ts`](../tests/upgrade-smoke/upgrade-compatibility.test.ts) + the 8-category verdict at [issue #170 comment](https://github.com/oscharko-dev/Keiko/issues/170#issuecomment-4616809868).       | Delivered.                                                   |

## ADR-0019 invariants

The two rule families defined in [ADR-0019](adr/ADR-0019-modular-package-architecture.md) are
encoded in [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs) and proven live by the
negative-test gate [`scripts/arch-check-negative.mjs`](../scripts/arch-check-negative.mjs)
against fixtures under [`tests/architecture/fixtures/`](../tests/architecture/fixtures/).

### Required Dependency Direction (9 rules)

| ADR rule                                                                                                                                            | Encoding (rule names in `.dependency-cruiser.cjs`)                                                                                                                                      | Status |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1. `keiko-contracts` is a leaf                                                                                                                      | `adr-0019-direction-1-contracts-leaf`                                                                                                                                                   | PASS   |
| 2. `keiko-security` depends only on contracts                                                                                                       | `adr-0019-direction-2-security-only-contracts`                                                                                                                                          | PASS   |
| 3. Infra leaves (`model-gateway`, `workspace`, `tools`, `evidence`) depend only on contracts + security (plus, for `tools`/`evidence`, `workspace`) | `adr-0019-direction-3-infra-only-contracts-security` (warn base) + strict per-package siblings `adr-0019-direction-3a-model-gateway-…`, `3b-workspace-…`, `3c-tools-…`, `3d-evidence-…` | PASS   |
| 4. `keiko-harness` depends only on contracts + security + infra leaves                                                                              | `adr-0019-direction-4-harness-scope` + strict `adr-0019-direction-4a-harness-only-contracts-security-model-gateway-workspace-tools-evidence`                                            | PASS   |
| 5. `keiko-workflows` depends only on contracts + security + infra + harness                                                                         | `adr-0019-direction-5-workflows-scope` + strict `adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence`                                | PASS   |
| 6. `keiko-server` depends on contracts + security + infra + harness + workflows, never on CLI/UI                                                    | `adr-0019-direction-6-domain-not-server` + strict `adr-0019-direction-6a-server-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence`                       | PASS   |
| 7. `keiko-cli` depends on every domain package, never on UI                                                                                         | `adr-0019-direction-7-domain-not-cli` + strict `adr-0019-direction-7a-cli-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence-server`                      | PASS   |
| 8. UI may only consume contracts as type-only values                                                                                                | `adr-0019-direction-8-ui-not-node-domain-values`                                                                                                                                        | PASS   |
| 9. The root product package is composition-only                                                                                                     | `adr-0019-direction-9-root-product-composition-only`                                                                                                                                    | PASS   |

### Trust-Boundary Rules (8 rules)

| ADR rule                                                 | Encoding (rule name in `.dependency-cruiser.cjs`) | Status |
| -------------------------------------------------------- | ------------------------------------------------- | ------ |
| 1. Provider SDKs are isolated to `keiko-model-gateway`   | `adr-0019-trust-1-provider-sdk-isolation`         | PASS   |
| 2. UI never imports provider config                      | `adr-0019-trust-2-ui-no-provider-config`          | PASS   |
| 3. UI never imports gateway internals                    | `adr-0019-trust-3-ui-no-gateway-internals`        | PASS   |
| 4. No direct filesystem access outside `keiko-workspace` | `adr-0019-trust-4-no-direct-fs-outside-workspace` | PASS   |
| 5. Patches route through `keiko-tools`                   | `adr-0019-trust-5-patch-routes-through-tools`     | PASS   |
| 6. Evidence is written only by allow-listed callers      | `adr-0019-trust-6-evidence-allowed-callers`       | PASS   |
| 7. CLI ⇄ server never bypasses the published port        | `adr-0019-trust-7-cli-server-no-port-bypass`      | PASS   |
| 8. No `doNotFollow` escape hatch in production builds    | `adr-0019-trust-8-no-do-not-follow-in-prod`       | PASS   |

`scripts/arch-check-negative.mjs` asserts 12 expected rules fire EXACTLY ONCE each against
intentional-violation fixtures, one fixture per physically-extracted package boundary plus the
browser UI and root facade composition gates. All 17 ADR-0019 rules plus the 12-fixture
negative test passed in the Epic #156 audit hardening run.

## Release-gate primitives

The four release-gate scripts named below are wired into the `prepack` chain in
[`package.json`](../package.json) and exercised on every push to `dev` across the `ci`,
`build-scan-sbom-smoke`, and `ui` jobs in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). The per-script CI placement is
called out below.

- [`scripts/check-package-surface.mjs`](../scripts/check-package-surface.mjs) (CI job: `ui`,
  after `build:ui` + `prepare:bin`) — static asserts on the packed file list: CLI bin
  executable bit, no `.env`, no source maps, no `packages/keiko-ui/` source leakage,
  `dist/ui/static` present, `dist/ui/csp-hashes.json` matches inline-script hashes, and SDK
  sentinel `runVerification` is exported.
- [`scripts/installable-package-smoke.mjs`](../scripts/installable-package-smoke.mjs) (CI
  job: `build-scan-sbom-smoke`) — packs and installs into a tmpdir with `--ignore-scripts`,
  asserts the CLI bin executes, the bundled workspace payload is present for every entry in
  `bundleDependencies`, and the SDK root import succeeds.
- [`scripts/check-workspace-supply-chain.mjs`](../scripts/check-workspace-supply-chain.mjs)
  (CI job: `build-scan-sbom-smoke`) — per-workspace SBOM emission and license allow-list
  enforcement; 12 CycloneDX SBOMs total (`sbom/root.cdx.json` + 11
  `sbom/workspace-keiko-*.cdx.json`).
- [`scripts/arch-check-negative.mjs`](../scripts/arch-check-negative.mjs) (CI job: `ci`) —
  invokes `depcruise` against 12 intentional-violation fixtures and asserts every expected
  rule fires EXACTLY ONCE.

## Known limitations

- The upgrade-compatibility smoke
  ([`tests/upgrade-smoke/upgrade-compatibility.test.ts`](../tests/upgrade-smoke/upgrade-compatibility.test.ts))
  executes against the in-repository `dist/` build, not against the packed tarball install.
  The architectural-equivalence argument is recorded in
  [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md): paths,
  environment-variable names, SQLite schema version, and evidence schema version are
  byte-identical between in-repo `dist/` and packed `dist/` because the same `prepack` chain
  (`clean → build → prepare:bin → build:ui → check:package-surface`, defined in
  [`package.json`](../package.json)) produces both. A future enhancement could invoke the
  upgrade test against the smoke-installed tarball; this is not required for AC4 and would
  not change the verdict.
- Categories 2 (credential env-var names) and 7 (`ui.pid` / `ui.log` lifecycle files) in
  [`docs/local-runtime-state-contract.md`](local-runtime-state-contract.md) are
  documentary-only — no in-process read assertion. Category 2 is customer-owned configuration,
  not Keiko-persisted state. Category 7 requires a running `keiko ui` process; the lifecycle
  file paths are asserted by the unchanged source constants at
  `packages/keiko-cli/src/lifecycle.ts:165-186`.
- `npm run build` alone does not satisfy `npm run check:package-surface`. The check requires
  `npm run build:ui` (the static UI export) and `npm run prepare:bin` (the CLI executable
  bit) to have run as well. These execute automatically via the `prepack` hook on `npm pack`
  and `npm publish` (`package.json` `scripts.prepack`); they are not enforced when a
  developer runs `build` in isolation. This is existing design, not a regression.
- The native Windows path support added in
  [issue #174](https://github.com/oscharko-dev/Keiko/issues/174) is verified by unit tests on
  the Linux CI runner. A Windows-hosted CI runner is not yet wired up; native execution on
  Windows is verified by issue #174's path-validator tests, not by an end-to-end Windows CI
  run.
- The `--experimental-sqlite` `ExperimentalWarning` fires on Node 22 during
  `check:package-surface`, `build:ui`, and `keiko ui` startup. This is pre-existing since
  [issue #62](https://github.com/oscharko-dev/Keiko/issues/62); non-fatal; resolves when
  SQLite stabilizes upstream in Node.

## Follow-ups

- Epic [#142](https://github.com/oscharko-dev/Keiko/issues/142) "Elevate the Keiko
  Conversation Center" resumes on this foundation; open child issues include #143, #146,
  #153, #155, #184, #185, #197, #200, #212.
- Epic [#121](https://github.com/oscharko-dev/Keiko/issues/121) "Deliver installable Keiko
  PWA experience" resumes on this foundation; open child issues include #122–#128.
- Epic [#204](https://github.com/oscharko-dev/Keiko/issues/204) "Build Keiko governed
  enterprise memory" is independent of the architecture sprint but inherits the workspace
  package boundaries.
- Epic [#177](https://github.com/oscharko-dev/Keiko/issues/177) "Build evidence-driven
  connected repository context" consumes the `@oscharko-dev/keiko-workspace` retrieval seam.
- Epic [#189](https://github.com/oscharko-dev/Keiko/issues/189) "Build local knowledge
  connectors and persistent knowledge capsules" depends on the connector boundary
  established in this sprint.
- Issue [#221](https://github.com/oscharko-dev/Keiko/issues/221) "Add Troubleshooting Guide"
  was consolidated under issue
  [#257](https://github.com/oscharko-dev/Keiko/issues/257) and is now addressed by the
  [Troubleshooting Guide](troubleshooting/README.md).

## Closure note

This document is the closure evidence for issue
[#170](https://github.com/oscharko-dev/Keiko/issues/170). After
[PR #241](https://github.com/oscharko-dev/Keiko/pull/241) merged, a closure comment on epic
[#156](https://github.com/oscharko-dev/Keiko/issues/156#issuecomment-4617430851) linked to
this document, to the verdict matrix at issue #170, and to the merged commit SHA, marking the
modular-architecture sprint complete.

## Evidence appendix

### Full command log

Captured 2026-06-04T05:47:45Z against tree SHA `b9e1d15a73322be67f7685ce38f81054b70faf41`,
Node v22.22.3, npm 10.9.8.

The table below records the 0.1.7 release-audit run. The Epic #156 audit hardening promoted
the UI/root/trust gates, removed the two Trust-6 warnings, and reran `arch:check` /
`arch:check:negative` with no warnings and 12 negative fixtures as recorded in the
acceptance matrix above.

| #   | Command                                                            | Exit | Duration | Key output                                                                                       |
| --- | ------------------------------------------------------------------ | ---- | -------- | ------------------------------------------------------------------------------------------------ |
| 1   | `npm ci`                                                           | 0    | 3.0s     | `added 587 packages, audited 599 packages`                                                       |
| 2   | `npm run typecheck`                                                | 0    | 7.3s     | 10 workspace packages built + `tsc --noEmit` clean                                               |
| 3   | `npm run lint`                                                     | 0    | 6.8s     | `eslint . --max-warnings=0` clean                                                                |
| 4   | `npm run arch:check`                                               | 0    | 0.7s     | `no dependency violations found (523 modules, 1126 dependencies cruised)`                        |
| 5   | `npm run arch:check:negative`                                      | 0    | 0.7s     | `PASS — gate fired on 12 fixture(s) as expected.`                                                |
| 6   | `npm test`                                                         | 0    | 20.4s    | `148 passed (148) / 2068 passed, 1 skipped (2069)`                                               |
| 7   | `npm run prepack`                                                  | 0    | 15.5s    | `package-surface check passed: 1768 files, dist/ui/static present.`                              |
| 8   | `npm pack --json --dry-run --ignore-scripts`                       | 0    | 1.3s     | `oscharko-dev-keiko-0.1.7.tgz`, 949185 bytes packed, 3716385 bytes unpacked, 1768 files          |
| 9   | `npm run smoke:install`                                            | 0    | 18.8s    | `installable-smoke ok: tarball installed, 10 bundled packages present, CLI + SDK reachable.`     |
| 10  | `npm run check:workspace-supply-chain`                             | 0    | 3.5s     | `workspace supply-chain ok: 11 per-workspace SBOMs emitted, all licenses within the allow-list.` |
| 11  | `KEIKO_EVIDENCE_DIR=… node dist/cli/index.js evaluate --suite all` | 0    | 0.03s    | `Verdict: GO — pilot ready (all Go/No-Go thresholds met).`                                       |
| 12  | `node dist/cli/index.js --version`                                 | 0    | —        | `keiko 0.1.7`                                                                                    |
| 13  | `node dist/cli/index.js --help`                                    | 0    | —        | 14 subcommands listed                                                                            |
| 14  | `node dist/cli/index.js definitely-not-a-command`                  | 2    | —        | unknown-command exit asserted                                                                    |

Notable release-gate detail captured during step 9:

- Tarball produced: `oscharko-dev-keiko-0.1.7.tgz` — 949.2 kB packed, 3.7 MB unpacked, 1768
  files, shasum `ff9ebc5437c59484910864960276ff159603abae`.
- 10 bundled workspace packages confirmed under
  `node_modules/@oscharko-dev/keiko/node_modules/@oscharko-dev/keiko-<name>/dist/`:
  contracts, security, model-gateway, workspace, tools, evidence, harness, workflows,
  server, cli. `ws@8.21.0` is also bundled as a transitive runtime dependency, for 11 bundled
  packages total.
- CLI bin mode `-rwxr-xr-x`.
- SDK root export resolves 132 named keys; `runVerification` is a function.
- `dist/ui/static` present; `dist/ui/csp-hashes.json` matches inline-script hashes.
- 12 SBOMs emitted under `sbom/` (`root.cdx.json` plus 11 `workspace-keiko-*.cdx.json`).
- UI smoke (separate verifier invocation): `node dist/cli/index.js ui --port 4399`, then
  `curl http://127.0.0.1:4399/api/health` → body `{"status":"ok","version":"0.1.7"}`,
  terminated cleanly.
- `evaluate` verdict `GO` across 6 fixtures, 7 dimensions; surface-parity 8 checks PASS.
- [`tests/upgrade-smoke/upgrade-compatibility.test.ts`](../tests/upgrade-smoke/upgrade-compatibility.test.ts)
  ran inside step 6 and reported 10/10 passing. Its imports
  (`@oscharko-dev/keiko-server`, `@oscharko-dev/keiko-evidence`,
  `@oscharko-dev/keiko-model-gateway`) are the same surfaces a tarball-installed consumer
  resolves.

Non-blocking anomalies observed in the run:

1. Manual command ordering — `npm run build` alone does not satisfy
   `npm run check:package-surface`; the latter also requires `npm run build:ui` and
   `npm run prepare:bin`. These run automatically via `prepack` on `npm pack` and
   `npm publish`. Existing design, not a regression.
2. `ExperimentalWarning: SQLite` fires in `check:package-surface`, `build:ui`, and
   `keiko ui` startup — pre-existing since
   [issue #62](https://github.com/oscharko-dev/Keiko/issues/62) (Node 22
   `--experimental-sqlite` flag). Non-fatal.
3. `npm ci` deprecation notices for transitive packages (`eslint@8.57.1`, `inflight@1.0.6`,
   `rimraf@3.0.2`, `glob@7.2.3`). `npm audit` reports 0 vulnerabilities.
