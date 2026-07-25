# Coverage truth model

One table, one rule: **every coverage question has exactly one measuring artifact and exactly one
enforcement point.** If you are about to add a check that answers a question already in this table,
you are adding an eleventh ruler — extend the existing one instead.

Governed by [ADR-0158](../adr/ADR-0158-one-coverage-ruler-per-question.md), which is the record of
how ten overlapping rulers became this table. [ADR-0157](../adr/ADR-0157-sharded-coverage-evidence-and-cached-provisioning.md)
owns the job topology; [ADR-0156](../adr/ADR-0156-measurement-and-verdict-separation.md) D1 is the
governing principle (one verdict, one place).

## The map

| Question                                                        | Measuring artifact (produced once)                                                                                        | Enforcement point (evaluated once)                                                                                                                 | Threshold                                                          | Tolerance                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Does a workspace package hold its **lines** floor?              | `coverage/packages/coverage-summary.json` (merged from three shards) + `packages/keiko-ui/coverage/coverage-summary.json` | `check:coverage:quality` → package ratchet                                                                                                         | `min(85, recorded baseline)`, or 85 where no baseline exists       | 0.1pp when ratcheted below target, 0.004pp otherwise |
| …its **statements**, **branches**, **functions** floor?         | same two summaries, same parse                                                                                            | `check:coverage:quality` → package ratchet (`--all-metrics`)                                                                                       | as above, per metric                                               | as above                                             |
| Does `keiko-ui` hold its **release lines target**?              | `packages/keiko-ui/coverage/coverage-summary.json`                                                                        | `check:coverage:quality` → `--release-target keiko-ui=88`                                                                                          | 88, strict (no ratchet)                                            | 0.004pp                                              |
| Does `keiko-cli` hold its **release lines target**?             | `coverage/packages/coverage-summary.json`                                                                                 | `check:coverage:quality` → `--release-target keiko-cli=87`                                                                                         | 87, strict (no ratchet)                                            | 0.004pp                                              |
| Did a **governed file** regress?                                | same two summaries, same parse                                                                                            | `check:coverage:quality` → `--enforce-file-floors` against `fileFloors` in [`package-coverage-baseline.json`](package-coverage-baseline.json)      | per entry; `ratcheted` = recorded measurement, `absolute` = policy | `ratcheted` 0.5pp, `absolute` 0pp                    |
| Do the **10 gate scripts** hold their four-metric floors?       | `coverage/packages/coverage-summary.json`                                                                                 | same engine — `governance: "absolute"` entries in the same store                                                                                   | branches 85 / functions 90 / lines 90 / statements 90              | 0pp                                                  |
| Is **new code** covered?                                        | `coverage/packages/lcov.info`, `packages/keiko-ui/coverage/lcov.info`, `coverage/scripts/lcov.info`                       | SonarCloud `Keiko Banking Grade` (`new_coverage`), arbitrated by `check-sonar-pr-quality-gate.mjs` — locally mirrored by `check:coverage:new-code` | 85 (`KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum`)       | none                                                 |
| Is every changed production source **mapped into LCOV** at all? | the same three LCOV reports                                                                                               | `check-lcov-source-mapping.mjs`                                                                                                                    | every coverable source needs an `SF:` record                       | none                                                 |

Two properties are not in the table because they are structural rather than thresholded: a governed
file that **vanished** from the summary fails as `missing` rather than passing silently, and a
release target whose package was **not measured** fails as `not-measured` rather than reading as met.

## The one constant

`85` appears in this table three times and is defined **once**, in
`KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum` (`scripts/sonar-quality-gate-contract.mjs`).
`check-package-coverage.mjs` imports it as its default target and as the value the generated baseline
records; a committed baseline whose `target` disagrees fails the gate closed. Do not write the
literal `85` into a coverage gate — import the constant.

## The one ruler with two mirrors

New-code coverage is the single case where two artifacts answer the same question, deliberately:

- `npm run check:coverage:new-code` (`scripts/check-new-code-coverage.mjs`) **confirms** the answer
  locally, before the push. It reads the same threshold constant, the same main-scope predicate
  (`isCoverableProductSource`), and the same LCOV reports SonarCloud ingests.
- SonarCloud's `Keiko Banking Grade` gate, read by `check-sonar-pr-quality-gate.mjs`, **arbitrates**.
  It is the required check; the local mirror has no authority.

This is one ruler with two mirrors, not two rulers (ADR-0156, issue #2699). The mirror exists so the
required gate _confirms_ a known answer instead of _discovering_ it. That only holds while the mirror
reads the same inputs — `LCOV_CANDIDATES` in `check-new-code-coverage.mjs` must stay identical to
`sonar.javascript.lcov.reportPaths` in `sonar-project.properties`. It drifted once (it listed a
`coverage/ui/lcov.info` that nothing writes and omitted the real keiko-ui report, so it measured zero
keiko-ui new code) and was corrected in ADR-0158.

## Where each suite executes — exactly once per pull request

| Suite    | Configuration                                 | Job                            | Evidence handed on                                                    |
| -------- | --------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| packages | `vitest.coverage.packages.config.ts`          | `coverage-packages` (3 shards) | vitest blob reports, merged by `coverage-sonar` with `--mergeReports` |
| keiko-ui | `packages/keiko-ui/vitest.coverage.config.ts` | `coverage-ui`                  | `lcov.info` + `coverage-summary.json` artifact                        |
| scripts  | `vitest.coverage.scripts.config.ts`           | `coverage-scripts`             | `lcov.info` + `coverage-summary.json` artifact                        |

`coverage-sonar` downloads all three, reassembles the package summary, and is the only job that
evaluates anything. No other job measures coverage — the `ui` job used to run the keiko-ui suite a
second time and judge its own discarded copy; ADR-0158 D4 removed it.

Note that `scripts/__tests__/**` test _files_ execute in two suites (the packages suite measures the
gate scripts they cover; the scripts suite measures the rest of `scripts/`). Those are two suites
with two different coverage scopes, not one suite running twice.

## No vitest configuration judges

No `coverage.thresholds` block exists in any vitest configuration, and
`scripts/__tests__/vitest-config-parity.test.mjs` fails if one reappears. Two things depend on that:

- **Sharding stays safe.** vitest evaluates thresholds against whatever a run produced, so a shard
  measuring a third of the suite would judge it against the whole suite's floors (ADR-0157 D1). With
  no thresholds anywhere, that cannot happen — it is structural, not maintained by a second
  configuration file.
- **The per-file floor store stays single.** A threshold block is a second floor engine with its own
  storage and its own noise policy. That split is exactly what ADR-0158 D1 removed.

Per-file floors go in `fileFloors`. All four metrics are expressible there.

## Changing a floor

| You want to…                             | Do this                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Raise a package floor after adding tests | `npm run check:coverage:write-baseline` — re-derives package values and `ratcheted` file floors from the current measurement               |
| Govern a new critical file               | Let `check:coverage:write-baseline` record it (files at or below 50% lines are recorded automatically), or add an `absolute` entry by hand |
| Change a gate script's floor             | Edit its `absolute` entry in `fileFloors`; `check-package-coverage.test.mjs` pins the ten current values and will name the change          |
| Lower any floor or widen any tolerance   | Don't. If a floor is genuinely wrong, that is an issue with a rationale, not a baseline edit                                               |

`check:coverage:write-baseline` never erases an `absolute` entry: those encode policy rather than
measurement, and all ten gate scripts sit far above the ratchet threshold that decides which files
get recorded, so a measurement-only regeneration would drop every one of them.

## Running it locally

```bash
npm run test:coverage:quality
```

That measures all three suites and then runs the one consolidated evaluation. To re-judge without
re-measuring (the summaries are already on disk):

```bash
npm run check:coverage:quality
```
