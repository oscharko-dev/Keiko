# Quality Intelligence supply-chain gate — release notes

> Companion to ADR-0023 §D5/§D11/§D12 and the decision matrix at
> [`quality-intelligence-dependency-decision-matrix.md`](./quality-intelligence-dependency-decision-matrix.md).
> Owned by issue #287; consumed by the parity / release gate in issue #285.

## 1. What ships in this PR

| Artifact                                                                                                                                         | Role                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`scripts/check-quality-intelligence-supply-chain.mjs`](../../scripts/check-quality-intelligence-supply-chain.mjs)                               | Fail-closed Node 22+ script; six checks (source imports, root manifest, workspace manifests, matrix consistency, lifecycle hooks, telemetry substrings).        |
| [`scripts/__tests__/check-quality-intelligence-supply-chain.test.mjs`](../../scripts/__tests__/check-quality-intelligence-supply-chain.test.mjs) | Vitest unit + end-to-end harness; runs the script against synthetic `mkdtemp` repos for both pass and fail cases.                                               |
| [`quality-intelligence-dependency-decision-matrix.md`](./quality-intelligence-dependency-decision-matrix.md)                                     | Allow/deny decision rows; the script enforces consistency between this matrix and live manifests.                                                               |
| `package.json` script `check:qi-supply-chain`                                                                                                    | One-line wrapper invoked by `prepack`, `prepublishOnly`, and the CI step below.                                                                                 |
| `prepack` and `prepublishOnly` chain                                                                                                             | Extended to fail-close on `npm pack` and `npm publish` before any tarball leaves the repo.                                                                      |
| `.github/workflows/ci.yml` step in the `ci` job                                                                                                  | New step `Quality Intelligence supply-chain gate` runs `npm run check:qi-supply-chain`; reuses the byte-exact `ci` required-check name (no new required check). |

## 2. Pre-existing supply-chain machinery (unchanged by this PR)

| Script                                     | Role                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `scripts/check-package-surface.mjs`        | Tarball contents check (ADR-0011 D6) — runs after this gate in the `prepack` chain.                   |
| `scripts/check-workspace-supply-chain.mjs` | Per-workspace SBOM + license allow-list (Issue #169 D4) — runs in the `build-scan-sbom-smoke` CI job. |
| `scripts/installable-package-smoke.mjs`    | Installable-package smoke (Issue #169 AC2).                                                           |

The new QI gate is purposely scoped narrower than these: it does not generate SBOMs and does
not exercise the tarball — those gates already exist. It only checks what's special about the
QI migration: the deny set and the matrix.

## 3. Dependency-cruiser rule and `EXPECTED_RULES`

ADR-0023 §D14 introduces a new strict rule
`adr-0019-direction-10a-quality-intelligence-only-contracts-security`, which limits
`keiko-quality-intelligence` to depend on `keiko-contracts` and `keiko-security` only. The
rule is **not** added in this PR for two reasons:

1. The `keiko-quality-intelligence` package does not exist on disk yet; it is created in
   issue #272 alongside the first code migration. Adding a dependency-cruiser rule that
   matches a non-existent package path would be a no-op at best and a misleading addition
   at worst.
2. The `EXPECTED_RULES` counter in `scripts/arch-check-negative.mjs` is locked to the
   current rule count; updating that counter in the same PR that lands the rule is
   simpler than splitting the change across two PRs.

**Follow-up owned by #272**: add rule `direction-10a` to `.dependency-cruiser.cjs`, extend
the allow-lists in rules 4a (harness), 5a (workflows), 6a (server), and 7a (cli) to include
`keiko-quality-intelligence`, extend `trust-6` to include
`packages/keiko-quality-intelligence/src/`, and bump `EXPECTED_RULES` by 1. ADR-0023 §D14
covers this in detail.

## 4. Verification surface for issue #285

The final parity gate in #285 should compose the following checks, all reachable from this
PR:

- `npm run check:qi-supply-chain` — this gate.
- `npm run check:package-surface` — public surface, ADR-0011.
- `npm run check:workspace-supply-chain` — SBOM + license, Issue #169.
- `npm run smoke:install` — installable-package smoke.
- `npm run arch:check` — dependency-direction enforcement (once #272 adds rule
  `direction-10a`).
- `npm test` — includes the harness tests for this gate.

## 5. Decision lifecycle reference

New runtime or development dependencies introduced by Quality Intelligence work land via
the decision matrix (§2 of the matrix doc) **before** any manifest change. The script
catches stale rows on the next CI run.

## 6. Cross-references

- ADR-0023, §D5, §D11, §D12, §D14.
- Issue #287 (this gate).
- Issue #270 (epic).
- Issue #272 (depends on this gate; will land the `direction-10a` rule and the package).
- Issue #285 (parity / release gate that consumes this gate's evidence).
- Issue #271 (ADR — not modified by this PR).
