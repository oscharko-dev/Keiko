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

| Path                          | What                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger-lab/`                 | The lab repository at its `main` head `0ee16fa`, byte for byte, without `.git/`, `node_modules/` and `package-lock.json`                                                                                        |
| `patches/initial-state.patch` | The inverse of the lab history `c3ee08f..0ee16fa`. Applied to `ledger-lab/` it reproduces the first lab commit `c3ee08f`, the state T1 to T3 ran on                                                             |
| `patches/replant-t2-t3.patch` | A small alternative: re-plants only the T2 and T3 defects on the head tree (`src/ledger.ts`, `src/csv.ts`) and removes the four regression tests their fixes added                                              |
| `patches/head-t7.patch`       | The reference T7 result on the head tree: the 13 lint findings fixed in six files, nothing else (see below). It is the baseline `head+t7` of T8, T9 and T12                                                     |
| `patches/head-md.patch`       | Appends reference sections to `AGENTS.md` (the five rules on top stay verbatim) until the file is 30,621 bytes, above the 16 KiB cap of the repository-instructions loader. It is the baseline `head+md` of T13 |

`initial-state.patch` and `replant-t2-t3.patch` were generated from the lab history with `git diff`
and verified with `git apply --check` against this tree; `initial-state.patch` reproduces the
`c3ee08f` tree exactly.

`head-t7.patch` is different, because the lab history holds no commit with the T7 fixes: no model
run has completed T7 yet (the runs of its text recorded so far, the ledger's T7a to T7c rows, all
ended before the 13 findings were fixed). It is the reference T7 result, written by hand as the
smallest change that clears the findings without a suppression, without touching `eslint.config.mjs`,
`tsconfig.json` or `package.json`, and without touching the T8 defects, which stay in place. It
was generated with `git diff` against this tree and applies cleanly. With it applied,
`tsc --noEmit`, `eslint .` and `node --test` pass (17 of 17 tests; checked with TypeScript 6.0.3,
ESLint 10.10.0 and typescript-eslint 8.70.0). One change per file, 13 findings in all:

- `src/csv.ts` (4): `charAt(i)` instead of the indexed read in the CSV splitter, and `String(...)`
  around the two numbers in the error message.
- `src/importers/bank-b.ts` (2): `String(...)` around the two numbers in the error message.
- `src/money.ts` (1): `String(...)` around the number in `formatAmount`.
- `src/ledger.ts` (1): the month entries are sorted instead of looked up again with a `!`.
- `src/ledger.test.ts` (1): a block body for the arrow function that only calls a void function.
- `src/report.test.ts` (4): two optional chains dropped where the type already excludes `undefined`,
  and a narrowing helper instead of two `as Entry` casts, which resolves the
  `no-non-null-assertion` against `non-nullable-type-assertion-style` conflict without disabling
  either rule.

| Baseline  | How to get it                                    | Used by                                           |
| --------- | ------------------------------------------------ | ------------------------------------------------- |
| `initial` | `ledger-lab/` plus `patches/initial-state.patch` | T1, T2, T3 (as recorded in the ledger)            |
| `head`    | `ledger-lab/` as it is                           | T4 to T7, T10, T11                                |
| `head+t7` | `ledger-lab/` plus `patches/head-t7.patch`       | T8, T9, T12 (they verify with `npm run check`)    |
| `head+md` | `ledger-lab/` plus `patches/head-md.patch`       | T13 (per-turn cost of an AGENTS.md above the cap) |

Apply a patch to the copy before its first commit (`git apply` works outside a repository), and
never on top of another baseline's patch: each one starts from `ledger-lab/` as it is.

`replant-t2-t3.patch` is the lighter way to run T2 or T3 on the `head` tree. Its `AGENTS.md` asks
for `npm run check`, so the 13 unrelated lint findings keep that check red until T7 has run.

`head-md.patch` keeps the `head` tree and its defects and only grows `AGENTS.md`. The
repository-instructions loader reads the file whole (it is under the 64 KiB read ceiling),
cuts it at a line boundary to 16 KiB and re-sends that block with every model turn, so the file is
the cost under test, not a task input: see T13 in the lab README.

## Use a copy

Never run `npm install` or `npm test` inside this directory: it sits inside the Keiko monorepo,
and an install here would write `node_modules/` and a lockfile into the repository tree. Copy it
out and give it a Git history (the Workbench works on a Git repository on branch `main`):

```bash
LAB=$HOME/keiko-lab-ledger
mkdir -p "$LAB" && cp -R tests/fixtures/coding-workbench-lab/ledger-lab/. "$LAB"/
cd "$LAB"
# Pick the baseline the task needs; at most one of these:
# T1 to T3:      git apply <keiko checkout>/tests/fixtures/coding-workbench-lab/patches/initial-state.patch
# T8, T9, T12:   git apply <keiko checkout>/tests/fixtures/coding-workbench-lab/patches/head-t7.patch
# T13:           git apply <keiko checkout>/tests/fixtures/coding-workbench-lab/patches/head-md.patch
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
