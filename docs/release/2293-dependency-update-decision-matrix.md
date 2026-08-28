# Compatible Dependency Update Decision Matrix (#2293)

Status: implemented and locally verified on 2026-07-11, then refreshed during the post-#2665 audit
on 2026-07-22. This matrix records the live npm registry refresh performed for issue #2293 on top
of the TypeScript compiler/API split from #2267 and #2268.

> **Superseded for version claims.** The tables below are the decision history of the #2293 wave —
> why each version was chosen at the time — and are kept as history rather than rewritten. They are
> not a statement of the current tree: the ESLint rows were superseded on 2026-08-28 by #2777, and
> several others drifted after the wave merged (Monaco moved to the 0.56 line and the pinned Action
> versions advanced). For the versions this repository actually resolves today, and for the gate
> that keeps that record from drifting again, see
> [`2296-dependency-security-closeout.md`](2296-dependency-security-closeout.md). Do not cite this
> file as evidence of the current baseline.

It is dependency evidence, not a second dependency-policy subsystem; the enforceable sources remain
the workspace manifests, root lockfile, supply-chain gates, and package-surface checks.

## Updated dependencies

| Dependency                       | Previous resolved version | Selected version | Disposition and compatibility evidence                                                                                                                                                                                              |
| -------------------------------- | ------------------------: | ---------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next`                           |                    16.2.9 |          16.2.10 | Retained reviewed baseline; the one-day-old 16.2.11 audit refresh was rejected after Socket reported new recency and license-policy alerts in the PR dependency diff.                                                               |
| `eslint-config-next`             |                    16.2.9 |          16.2.10 | Kept exactly aligned with `next`; its bundled lint plugins still limit the ESLint lane to version 9.                                                                                                                                |
| `eslint` (root workspace)        |                    10.6.0 |           9.39.5 | Root and UI use one peer-valid ESLint lane. Root `eslint .` traverses the UI flat config, so retaining ESLint 10 at the root would still load plugins whose published peer ranges end at ESLint 9 and would leave `npm ls` invalid. |
| `eslint` (`keiko-ui` workspace)  |                    10.6.0 |           9.39.5 | UI workspace pinned to the latest stable peer-valid ESLint 9 release. ESLint 10.7.0 was rejected because three current `eslint-config-next` plugins declare only ESLint <=9; accepting npm's override would leave `npm ls` invalid. |
| `@eslint/js` (root workspace)    |                    10.0.1 |           9.39.5 | Aligned with the single peer-valid ESLint 9 lane; no lint policy or zero-warning threshold is removed.                                                                                                                              |
| `vitest`                         |     4.1.8 root / 4.1.9 UI |           4.1.10 | Latest stable patch, deduplicated across root and UI.                                                                                                                                                                               |
| `@vitest/coverage-v8`            |                     4.1.8 |           4.1.10 | Exact peer match with Vitest 4.1.10.                                                                                                                                                                                                |
| `typescript-eslint`              |                    8.62.1 |           8.63.0 | Retained reviewed compatible release; supports ESLint 9 and TypeScript API versions below 6.1, matching Keiko's TypeScript 6 API lane.                                                                                              |
| `@playwright/test`               |                    1.61.0 |           1.61.1 | Latest stable compatible patch.                                                                                                                                                                                                     |
| `@types/node` (root range floor) |                    26.0.1 |           26.1.1 | Latest stable declarations used by the repository baseline.                                                                                                                                                                         |
| `@vitejs/plugin-react`           |                     6.0.3 |            6.0.3 | Retained reviewed baseline across root, editor, and UI manifests; no audit capability required the newer package.                                                                                                                   |
| `autoprefixer`                   |                    10.5.2 |           10.5.2 | Retained reviewed UI build baseline; no audit capability required the newer package.                                                                                                                                                |
| `knip`                           |                    6.26.0 |           6.26.0 | Retained reviewed baseline; 6.29.0 introduced a large new native Oxc binding fleet into the PR dependency diff without an audit capability need.                                                                                    |
| `postcss`                        |                    8.5.18 |           8.5.18 | Retained reviewed root override and UI pin; the local audit reports zero known vulnerabilities.                                                                                                                                     |
| `prettier`                       |                     3.9.5 |            3.9.5 | Retained reviewed formatter baseline; formatting policy is unchanged.                                                                                                                                                               |
| `react` / `react-dom`            |                    19.2.7 |           19.2.7 | Retained reviewed React 19 runtime and editor peer baseline.                                                                                                                                                                        |
| `vite`                           |                     8.1.4 |            8.1.4 | Retained reviewed UI build baseline; the newer Rolldown/native binding delta was unnecessary for the audit.                                                                                                                         |
| `ws`                             |                    8.21.0 |           8.21.0 | Retained reviewed WebSocket runtime across every direct declaration.                                                                                                                                                                |

The lockfile was regenerated from a dependency-free checkout state before `npm ci`. This is required
because npm 10 otherwise retained the stale UI-local Vitest 4.1.9 node in spite of an exact 4.1.10
manifest pin. The clean result deduplicates both workspaces to Vitest 4.1.10.

## Deferred dependency families

| Dependency family                          |              Registry candidate | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React, React DOM, and declaration packages |           19.2.7 / 19.2.x types | Deferred from #2293 to child issue #2295. The completed migration decisions, runtime semantics, UI/editor verification, hydration, and rollback contract are recorded in [`../react19-ui-editor-migration.md`](../react19-ui-editor-migration.md).                                                                                                                                                                                                  |
| Node.js and npm                            | Node 24 LTS / governed npm line | Deferred from #2293 to child issue #2294. The selected runtime, CI matrix, portable metadata, and operator contract are recorded in [`../runtime-toolchain.md`](../runtime-toolchain.md).                                                                                                                                                                                                                                                           |
| TypeScript runtime API                     |                TypeScript 7.0.2 | Deferred by #2269's stable-API entry gate. Keiko retains TypeScript 6.0.3 for the programmatic API and uses the separately governed TypeScript 7 native compiler.                                                                                                                                                                                                                                                                                   |
| UI framework TypeScript API                |                TypeScript 7.0.2 | The Next.js-supported UI compiler remains 5.7.3; the separate native TypeScript 7 source-compatibility gate proves Keiko-owned UI code.                                                                                                                                                                                                                                                                                                             |
| ESLint 10                                  |                          10.7.0 | **Superseded 2026-08-28 (issue #2777) — no longer deferred.** ESLint 10 landed on 2026-08-27 via PR #3290 and the migration was completed under #2777. The three plugins still publish ESLint <=9 peer ranges; the rule surface they describe is not loaded, and the acceptance is now an explicit reviewed `overrides` register held green by `check:eslint-lane`. See [`../next16-eslint10-ui-migration.md`](../next16-eslint10-ui-migration.md). |
| Monaco Editor                              |                          0.56.0 | Deferred to a separately governed editor migration: a `0.x` minor can change public and runtime contracts, and ADR-0042 pins the reviewed 0.55 line.                                                                                                                                                                                                                                                                                                |

### ESLint lane supersession (2026-08-28)

The four ESLint rows under [Updated dependencies](#updated-dependencies) (`eslint-config-next`,
`eslint` root, `eslint` `keiko-ui`, `@eslint/js`) and the `ESLint 10` row under [Deferred dependency
families](#deferred-dependency-families) record the 2026-07-11 decision to hold the repository on
the ESLint 9 lane. That decision no longer describes the tree. ESLint 10 was integrated on 2026-08-27 by PR #3290 and the
migration was completed on 2026-08-28 under issue #2777: the root and `keiko-ui` share one
`eslint@^10.8.1` declaration, `@eslint/js` moved to `^10.0.1`, and `npm ls eslint` exits `0`. The
current decision, the live upstream peer-range evidence, and the bounded override acceptance live in
[`../next16-eslint10-ui-migration.md`](../next16-eslint10-ui-migration.md).

## Already-current compatible direct dependencies

The live command `npm outdated --workspaces --include-workspace-root --json` returned no additional
compatible update for the following direct families after normalization: Babel 8, Playwright
tooling other than the patch above, Testing Library, jsdom, axe/jest-axe, dependency-cruiser, Acorn,
PDF.js, ZIP support, Diff, and the optional N-API canvas backend. Major releases and separately
governed `0.x` migrations remain out of scope unless assigned above.

## GitHub Actions

Every workflow action remains pinned to a full 40-character commit SHA. Live release/tag inspection
confirmed the pinned versions are current and the comments match their tag commits:

| Action                             | Pinned version |
| ---------------------------------- | -------------: |
| `actions/checkout`                 |          7.0.0 |
| `actions/setup-node`               |          6.4.0 |
| `actions/upload-artifact`          |          7.0.1 |
| `actions/download-artifact`        |          8.0.1 |
| `actions/dependency-review-action` |          5.0.0 |
| `github/codeql-action`             |         4.37.0 |

## Verification contract

The batch is acceptable only when a fresh `npm ci`, `npm ls`, zero-vulnerability audit, TypeScript,
lint, format, test, architecture, supply-chain/SBOM, package-surface, install-smoke, UI, and
release-impact gates all pass. No audit, peer, coverage, package-surface, or release threshold may be
lowered to accommodate an update.
