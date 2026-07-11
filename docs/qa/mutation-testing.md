# Mutation testing — security-critical modules

## Purpose

Line and branch coverage metrics cannot detect mutation-blind tests: tests that pass even when the
production logic is subtly wrong. Mutation testing injects small syntactic changes (mutations) into
the source and asserts that the existing test suite detects each one by making at least one test
fail.

For Keiko the highest-risk surface is the set of modules that enforce security invariants:
redaction, encryption, hashing, and manifest-integrity checks. A mutation-blind test on these
modules could mask a real bypass. This config (`stryker.security.conf.json`) focuses Stryker on
exactly those modules so the mutation score is meaningful without the multi-hour runtime of a
full-repo run.

## Covered modules

| Module glob                                                                   | Security invariant                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/keiko-security/src/redaction.ts`                                    | Core secret-redaction primitive used by the gateway and evidence pipeline |
| `packages/keiko-security/src/secretbox.ts`                                    | AES-GCM secretbox wrapper                                                 |
| `packages/keiko-security/src/hashing.ts`                                      | SHA-256 content-hash used for manifest integrity                          |
| `packages/keiko-security/src/secrets.ts`                                      | Secret-detection patterns                                                 |
| `packages/keiko-evidence/src/redaction.ts`                                    | Evidence-layer redaction before persistence                               |
| `packages/keiko-evidence/src/qualityIntelligence/redaction.ts`                | QI-specific manifest redaction                                            |
| `packages/keiko-memory-vault/src/redact-record.ts`                            | Vault record redaction                                                    |
| `packages/keiko-model-gateway/src/openai-adapter.ts`                          | Gateway streaming redaction (includes `redactResponse`, `redactToolCall`) |
| `packages/keiko-server/src/qualityIntelligence/figma/figmaSnapshotBuilder.ts` | Figma render-URL host allowlist                                           |
| `packages/keiko-evidence/src/qualityIntelligence/store.ts`                    | QI manifest integrity-hash verification                                   |
| `packages/keiko-memory-vault/src/cipher.ts`                                   | AES-GCM vault cipher                                                      |
| `packages/keiko-memory-vault/src/migrate-encrypt.ts`                          | Vault at-rest encryption migration                                        |

## How to run

Stryker and the Vitest runner are exact-pinned development dependencies in the root lockfile:

```sh
npm run test:mutation:security
```

The underlying command is:

```sh
stryker run stryker.security.conf.json
```

An HTML report is written to `reports/mutation/security/index.html`. Open it in any browser to
inspect surviving mutants file-by-file.

## Thresholds

| Level          | Score |
| -------------- | ----- |
| `high`         | 90 %  |
| `low`          | 80 %  |
| `break` (fail) | 80 %  |

`coverageAnalysis: "perTest"` is used so Stryker only runs the tests that cover each mutated file,
keeping the wall-clock time reasonable.

## Pull-request and scheduled enforcement

The `Mutation security` workflow always emits the required `Mutation quality gate` check for pull
requests targeting `dev`. It computes the diff against the immutable PR base and runs mutation
testing only when governed or security-critical production TypeScript changed. The changed files
override the static mutation list, so the test proves the exact changed logic rather than an
unrelated security fixture. Documentation-only and test-only changes produce an explicit
not-applicable success. A daily scheduled run continues to exercise the complete static list.

Mutation runs are intentionally risk-scoped because they execute the relevant tests for every
injected mutation and a full-monorepo run would take hours. The operating policy is:

- Run mutation testing locally before pushing changes to covered modules; CI repeats it on the PR.
- Review surviving mutants before merging a change to a security-critical file.
- Raise the threshold values in `stryker.security.conf.json` after eliminating surviving mutants.

## How to extend the scope

Add entries to the `mutate` array in `stryker.security.conf.json`. Use glob patterns relative to
the repo root, e.g.:

```json
"mutate": [
  "packages/keiko-security/src/redaction.ts",
  "packages/keiko-local-knowledge/src/privacy/diagnostic-redactor.ts"
]
```

Avoid globbing entire packages (`packages/keiko-security/src/**`) unless you intend a full-package
run; the default thresholds assume focused, security-critical coverage and would give misleading
scores against boilerplate code.
