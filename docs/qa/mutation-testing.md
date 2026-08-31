# Mutation testing — security-critical modules

## Purpose

Coverage proves that a line executed; mutation testing checks whether the tests detect a harmful
change to that line. Keiko therefore mutation-tests the code that enforces redaction, encryption,
integrity, authority, and other trust-boundary decisions.

The toolchain is reproducible: `@stryker-mutator/core` and
`@stryker-mutator/vitest-runner` are exact-version development dependencies in the root lockfile.
The workflow never downloads an unpinned package through `npx`.

## Covered modules

The authoritative scope is the `mutate` array in [`stryker.security.conf.json`](../../stryker.security.conf.json).
It currently covers the security primitives, evidence redaction and integrity checks, memory-vault
encryption and redaction, model-gateway response redaction, and the Figma snapshot host allowlist.
Governed debugging adds a
separate 100-percent configuration in
[`stryker.debug-launch.security.conf.json`](../../stryker.debug-launch.security.conf.json) for the
DAP parser, process hardening, capsule isolation, closed launch policy, registry, and teardown
boundaries required by ADR-0136.

## Execution policy

Full mutation testing is deliberately outside the pull-request critical path. The focused Stryker
configuration can take hours on a large trust-boundary change, so making its completion a Required
Check creates an availability dependency rather than a bounded quality decision. The daily
scheduled workflow runs the complete critical configuration, and maintainers can start the same
complete run through `workflow_dispatch`. It remains strict and may not use `continue-on-error`.

Pull requests remain blocked by deterministic coverage ratchets, Sonar New Code analysis,
architecture checks, sandbox isolation, typecheck/lint, security scans, and affected functional and
E2E tests. [`scripts/check-mutation-scope.mjs`](../../scripts/check-mutation-scope.mjs) remains the
local tool for selecting critical changed files when a focused mutation run is practical, but it
does not create a GitHub branch-protection requirement. It invokes `/usr/bin/git` directly, accepts
only repository-relative safe paths, and distinguishes the dedicated debug-launch scope so local
runs can select the strict DAP configuration without widening an unrelated mutation run.

The scheduled/manual `test:mutation:security` command runs the general critical configuration, the
dedicated debug-launch configuration, and the historical-debt baseline ratchet exactly once each.

## How to run

```sh
npm run test:mutation:security
npm run test:mutation:debug-launch-security
```

The first command is the complete scheduled/manual regression. The second is the focused 100-percent
debug-launch proof for local repair loops.

The HTML report is written to `reports/mutation/security/index.html`. Temporary worktrees and
reports are ignored by Git and ESLint.
The security mutation configuration runs with `concurrency: 16` by default so local reruns and CI
start with the same bounded worker count instead of relying on ad-hoc CLI overrides.
The focused Stryker test matrix keeps the hermetic `keiko-sandbox` unit tests but intentionally
excludes `packages/keiko-sandbox/src/egress.test.ts`: that file is a live host-network proof for
the regular sandbox CI job, and its nested isolation backend can fail closed before printing the
expected `BLOCKED`/`TIMEOUT` marker inside Stryker worker sandboxes. Excluding it from mutation
testing does not weaken the runtime gate; the normal `@oscharko-dev/keiko-sandbox` test job still
executes the live proof.

The same class applies to
`packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts`. That file
drives a scripted OpenCode child, a loopback BFF, and a model-gateway round-trip. Nested process
isolation inside Stryker workers fails closed (`functional-scenario-failed`) before the dry-run can
score mutants (#3349). A `!`-prefixed `testFiles` entry _does_ negate in minimatch, but Stryker
OR-combines each `testFiles` entry over the whole tree, so a `!` entry cannot subtract — it would
select almost every test. `ignorePatterns` with a `**` glob hangs the full-tree crawl, so the
coding-runtime glob is
`**/!(*.functional).test.ts`: hermetic unit tests stay in the matrix and the functional pipeline
never enters the dry-run. The ordinary vitest job still executes the functional proof.

## Thresholds

| Level           | Score |
| --------------- | ----- |
| target (`high`) | 90 %  |
| warning (`low`) | 80 %  |
| hard failure    | 80 %  |

The target remains at least 90 percent and the hard target remains 80 percent. The first complete
run on 2026-07-11 established that the pre-existing critical scope starts at 61.66 percent, with
591 survivors and 126 no-coverage mutants. That debt is recorded by exact, location-bound
fingerprints in [`security-mutation-baseline.json`](security-mutation-baseline.json); it is not
reclassified as acceptable quality.

Until the remediation reaches 80 percent, every complete run is guarded by a fail-closed ratchet:

- the aggregate score may not decrease;
- survivor and no-coverage counts may not increase;
- no new survivor or no-coverage fingerprint is allowed;
- removing existing debt is accepted without rewriting the baseline downward.

A focused pre-publication run for changed critical production code is stricter: it must score at
least 80 percent and have zero surviving and zero no-coverage mutants. A numerical aggregate never
excuses a new mutant in a trust-boundary, redaction, secret, authority, integrity, or merge decision.

The dedicated debug-launch configuration has no historical-debt allowance: `high`, `low`, and
`break` are all 100 percent. Every mutant in that closed trust-boundary scope must be killed.

`coverageAnalysis: "perTest"` limits each mutant to tests that cover it after the focused security
test matrix has run. The Vitest runner's `related` discovery is intentionally disabled for this
gate: these trust-boundary tests often exercise routes, stores, and gateways indirectly, and related
test discovery can otherwise produce no covering tests for changed security code. Stryker emits
machine-readable JSON; `scripts/check-mutation-quality.mjs` is the authoritative ratchet/scoped
decision.
Stryker's native break value is zero only so that this stricter repository-owned decision can
evaluate both historical fingerprints and current results after the complete run.

Static module-initialization mutants are excluded because Stryker cannot reliably activate them
after an ESM module has been cached by a reused Vitest worker. Exact required-check names, immutable
producer IDs, event dispatch tables, and exported worker wiring remain asserted by ordinary tests;
all runtime trust and merge decisions remain mutation-tested.

## Supply-chain policy

Stryker remains permitted only while npm audit, OSV, Dependency Review, Socket, lockfile integrity,
and provenance evidence remain acceptable. The current transitive Socket findings are documented
in [`supply-chain-risk-acceptances.json`](supply-chain-risk-acceptances.json). Each acceptance is
bound to an exact package version and integrity digest; the repository test fails closed when the
lockfile changes, so an upgrade cannot inherit an old decision.

## Extending the scope

Add the smallest security-relevant production files to `mutate` and the corresponding path family
to `scripts/check-mutation-scope.mjs`. Add behavioural tests that kill all relevant mutants, then
run the complete configuration locally. Do not lower thresholds or add mutation/coverage ignore
comments to make a change pass.
