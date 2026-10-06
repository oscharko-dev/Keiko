# Coding Workbench lab fixture (`ledger-lab`)

The baseline repository of the live Coding Workbench qualification (epic #3871, issue #3872): a
small, dependency-free TypeScript expense ledger that a self-hosted Gemma model edits through the
Workbench. How to run the lab end to end is in
[`docs/qa/coding-workbench-lab/README.md`](../../../docs/qa/coding-workbench-lab/README.md); the
evidence ledger is
[`docs/qa/coding-workbench-gemma-litellm-lab.md`](../../../docs/qa/coding-workbench-gemma-litellm-lab.md).

## The planted defects are intentional

**This tree is deliberately defective test data, not an example of Keiko code. Do not fix it in
place.** Every defect below is the starting point of a lab task, and the patches in `patches/`
apply to exactly these bytes. Agents and reviewers: a "bug" in `ledger-lab/` is a feature of the
fixture; the lab agent fixes it inside a scratch copy (see "Use a copy" below).

| Defect in `ledger-lab/` (head `0ee16fa`)                                                                                                                     | Task |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `npm run lint` reports 13 errors across six files under the raised bar (strict TypeScript, ESLint `strictTypeChecked`, complexity 10, 50 lines per function) | T7   |
| Bank B import: `germanAmountToCents` in `src/importers/bank-b.ts` reads `1.234,50` as 1.23 (the thousands dot breaks `parseFloat`)                           | T8   |
| Month report: `summarizeMonths` in `src/report.ts` picks the smallest expense as the month's largest                                                         | T8   |
| `parseAmount` in `src/money.ts` rejects thousands separators such as `1,234.56`; `docs/FORMAT.md` documents that as the rule                                 | T4   |
| No `--month` filter on `ledger summary`; `recurringEntries` in `src/report.ts` has no CLI command                                                            | T5   |

The 13 lint findings, as measured in a scratch copy: `src/csv.ts` (4: `restrict-plus-operands` x2,
`restrict-template-expressions` x2), `src/importers/bank-b.ts` (2: `restrict-template-expressions`),
`src/ledger.test.ts` (1: `no-confusing-void-expression`), `src/ledger.ts` (1: `no-non-null-assertion`,
from the T2 fix), `src/money.ts` (1: `restrict-template-expressions`) and `src/report.test.ts` (4:
`no-unnecessary-condition` x2, `non-nullable-type-assertion-style` x2). `non-nullable-type-assertion-style`
asks for the `!` that `no-non-null-assertion` forbids: a rule conflict that T7 must resolve without
disabling either rule.

The first two lab defects, T2 (month keys) and T3 (quoted CSV fields), are already fixed in the
head tree: they were fixed by Gemma in the first lab runs and the fixes were kept. Reproduce T2 and
T3 from the earlier state with the patches below.

## What is here

| Path                          | What                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ledger-lab/`                 | The lab repository at its `main` head `0ee16fa`, byte for byte, without `.git/`, `node_modules/` and `package-lock.json`                                           |
| `patches/initial-state.patch` | The inverse of the lab history `c3ee08f..0ee16fa`. Applied to `ledger-lab/` it reproduces the first lab commit `c3ee08f`, the state T1 to T3 ran on                |
| `patches/replant-t2-t3.patch` | A small alternative: re-plants only the T2 and T3 defects on the head tree (`src/ledger.ts`, `src/csv.ts`) and removes the four regression tests their fixes added |

Both patches were generated from the lab history with `git diff` and verified with `git apply
--check` against this tree; `initial-state.patch` reproduces the `c3ee08f` tree exactly.

| Baseline  | How to get it                                    | Used by                                        |
| --------- | ------------------------------------------------ | ---------------------------------------------- |
| `initial` | `ledger-lab/` plus `patches/initial-state.patch` | T1, T2, T3 (as recorded in the ledger)         |
| `head`    | `ledger-lab/` as it is                           | T4 to T7, T10, T11                             |
| `head+t7` | `head` after the T7 lint fixes were committed    | T8, T9, T12 (they verify with `npm run check`) |

`replant-t2-t3.patch` is the lighter way to run T2 or T3 on the `head` tree. Its `AGENTS.md` asks
for `npm run check`, so the 13 unrelated lint findings keep that check red until T7 has run.

## Use a copy

Never run `npm install` or `npm test` inside this directory: it sits inside the Keiko monorepo,
and an install here would write `node_modules/` and a lockfile into the repository tree. Copy it
out and give it a Git history (the Workbench works on a Git repository on branch `main`):

```bash
LAB=$HOME/keiko-lab-ledger
mkdir -p "$LAB" && cp -R tests/fixtures/coding-workbench-lab/ledger-lab/. "$LAB"/
cd "$LAB"
# For T1 to T3 only: git apply <keiko checkout>/tests/fixtures/coding-workbench-lab/patches/initial-state.patch
git init -b main && git add -A
git -c user.name="Keiko Lab" -c user.email=lab@keiko.invalid -c commit.gpgsign=false commit -m "Baseline"
npm install
```

The tasks, their exact texts and the drivers are described in the lab README. The lab repository
never contains secrets, and none is needed to run its tests.

## Not part of the repository gates

The fixture is data, so the repository gates must neither lint, format, type-check nor run it:

| Gate                      | How the fixture stays out                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint (`npm run lint`)   | `eslint.config.js` `ignores` lists `tests/fixtures/coding-workbench-lab/ledger-lab/**`                                                   |
| Prettier (`format:check`) | `.prettierignore` lists `tests/fixtures/coding-workbench-lab/ledger-lab/`                                                                |
| TypeScript (`typecheck`)  | `tsconfig.json` `exclude` lists `tests/fixtures/coding-workbench-lab/ledger-lab/**` (it uses `.ts` import extensions and type stripping) |
| Vitest and coverage       | `vitest.config.ts` and `vitest.coverage.packages.config.ts` already exclude `tests/fixtures/**`; the lab tests use `node:test`           |
| knip                      | `knip.json` already ignores `tests/fixtures/**`                                                                                          |
| SonarCloud                | `tests/**` is test scope (`sonar.exclusions` and `sonar.test.inclusions`)                                                                |

ESLint 10 resolves the nearest configuration of an explicit path, so
`npx eslint tests/fixtures/coding-workbench-lab/ledger-lab` lints the fixture with its own
`eslint.config.mjs` and reports the 13 planted findings; `eslint .` (the repository lane) skips the
folder through the root `ignores`.
