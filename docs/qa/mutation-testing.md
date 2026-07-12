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
encryption and redaction, model-gateway response redaction, the Figma snapshot host allowlist, and
the independent Banking Quality Gate's evidence and merge decisions.

## Execution policy

`Mutation quality gate` is emitted for every pull request targeting `dev`:

- changes to critical production files run the complete focused Stryker configuration;
- test-only, documentation, configuration, and unrelated production changes produce an explicit
  successful `not applicable` result;
- deleted files do not trigger a run; a renamed critical production destination does;
- the daily scheduled workflow runs the complete critical configuration regardless of the diff;
- maintainers can start the same complete run through `workflow_dispatch`.

The scope decision is made by [`scripts/check-mutation-scope.mjs`](../../scripts/check-mutation-scope.mjs)
from the exact PR base and head commits. It invokes `/usr/bin/git` directly, accepts only
repository-relative safe paths, and emits the selected files through `GITHUB_OUTPUT`.

## How to run

```sh
npm run test:mutation:security
```

The HTML report is written to `reports/mutation/security/index.html`. Temporary worktrees and
reports are ignored by Git and ESLint.

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

A PR that changes critical production code is stricter: the changed-file Stryker run must score at
least 80 percent and have zero surviving and zero no-coverage mutants. A numerical aggregate never
excuses a new mutant in a trust-boundary, redaction, secret, authority, integrity, or merge decision.

`coverageAnalysis: "perTest"` limits each mutant to tests that cover it. Stryker emits machine-
readable JSON; `scripts/check-mutation-quality.mjs` is the authoritative ratchet/scoped decision.
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
