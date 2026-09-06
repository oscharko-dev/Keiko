# #3390 controlled-fixture acceptance rubric

This rubric is the `--rubric <path>` input to `scripts/generate-coding-issue-journey-manifest.mjs`
(`docs/acceptance/README.md`, `docs/design-system/evidence/3390/README.md`). The generator hashes
this file into the manifest's `rubricDigest` and never embeds its content. It records what five
passing real-model flows must show against the operator-authorized fixtures in
`oscharko/Wegwerf-Repo`, so a passed outcome is checked against observed effects and fixed
acceptance criteria rather than narration. Nothing below reproduces repository content.

## Controlled fixtures

The five issue flows are distinct, sequential GitHub journeys. Each starts from the actual remote
`master` produced by the preceding merged flow, uses the configured mode, and produces its own
task/run, pull request, merge commit, closed issue observation, evidence receipt, and spend delta.

| Flow                  | Issue | Mode                 | Required production result                                                                             |
| --------------------- | ----: | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `issue-to-pr-flow-01` |    #1 | Ask for approval     | Repair finite-only average behavior through `index.js` and a dedicated selection module under `lib/`.  |
| `issue-to-pr-flow-02` |    #3 | Supervised workspace | Export median calculation from `index.js` and own it in a dedicated module under `lib/`.               |
| `issue-to-pr-flow-03` |    #4 | Full access          | Export finite numeric range calculation from `index.js` and own it in a dedicated module under `lib/`. |
| `issue-to-pr-flow-04` |    #5 | Supervised workspace | Export population variance from `index.js` and own it in a dedicated module under `lib/`.              |
| `issue-to-pr-flow-05` |    #6 | Full access          | Export a composed statistics summary from `index.js` and own it in a dedicated module under `lib/`.    |

The external-change fixture remains pull request **#2**, an open same-repository
`docs/usage-section` branch targeting `master` (`isCrossRepository: false`). It backs the
Git-to-Chat scenarios. Every issue and pull-request identity is a live GitHub fact on the
controlled repository; the model receives the accepted issue or connected branch, never a
prerecorded patch or tool script.

## Per-issue acceptance criteria

Every issue flow must observe a relevant failing regression before its production implementation,
retain a later passing verifier result in that run, keep the accepted regression coverage and
earlier public behavior passing, and change at least two coordinated production modules. A newly
discovered defect, including a CI-only defect, must gain its own local regression before delivery.
Tests alone, an unused module, a single-file implementation, or a prerecorded patch do not qualify.

The criterion IDs below are the closed inventory for the independent reviewer. Every response
must retain all common criteria and all criteria for its accepted issue. The receipt derives its
counts from this frozen inventory; a reviewer cannot omit an inconvenient criterion.

## Common independent review criteria

- `accepted-scope`: The final diff implements the accepted issue, preserves prior public behavior,
  and contains no unrelated changes or weakened workflow, tests, or required checks.
- `observed-red-green`: The run observed a relevant failing regression before the production fix
  and a passing verification afterward; newly discovered defects have local regression coverage.
- `coordinated-production-modules`: At least two coordinated production modules implement the
  behavior; an unused file or a test-only change does not satisfy this criterion.
- `exact-head-required-ci`: The reviewer inspected successful required checks for the exact final
  pull-request head, with their expected GitHub application binding.

### Issue #1 — finite-only average

- `average-empty`: `average([])` returns `0`.
- `average-finite-only`: `NaN`, `Infinity`, and `-Infinity` are excluded from the average.
- `average-composition`: `index.js` composes a dedicated finite-number selection module in `lib/`.
- `average-sum-compatibility`: The existing `sum()` behavior remains unchanged.
- `average-regressions`: Tests cover empty and mixed finite/non-finite samples.
- `average-numerical-stability`: Finite large-value averaging works, has a local regression,
  and passes the retained numerical-stability CI step.

### Issue #3 — median

- `median-empty`: `median([])` returns `0`.
- `median-order`: Odd and even samples use numeric order and return the mathematical median.
- `median-finite-only`: Non-finite values are excluded.
- `median-immutable`: The function does not mutate its input.
- `median-composition`: `index.js` exports the function from a dedicated median module in `lib/`.
- `median-regressions`: Tests cover empty, odd, even, mixed, and immutability cases.

### Issue #4 — range

- `range-bounds`: The result is the finite `{ min, max }` bounds of the sample.
- `range-empty`: Empty and non-finite-only samples return `null`.
- `range-negative-single`: Negative and single-value samples have correct bounds.
- `range-composition`: `index.js` exports the function from a dedicated range module in `lib/`.
- `range-regressions`: Tests cover empty, non-finite-only, mixed, negative, and single-value cases.

### Issue #5 — population variance

- `variance-empty-single`: Empty and one-value samples return `0`.
- `variance-finite-only`: Non-finite values are excluded.
- `variance-population`: A known multi-value sample returns the population mean squared distance.
- `variance-composition`: `index.js` composes existing helpers with a dedicated variance module in
  `lib/`.
- `variance-regressions`: Tests cover empty, one-value, mixed, and known-value cases.

### Issue #6 — composed summary

- `summary-fields`: The result contains exactly the accepted `count`, `sum`, `average`, `median`,
  `min`, `max`, and `populationVariance` fields.
- `summary-finite-only`: Every field uses only finite sample entries.
- `summary-empty`: An empty sample returns the exact values specified by the accepted issue.
- `summary-immutable`: The function does not mutate its input.
- `summary-composition`: A dedicated module in `lib/` composes previously merged production
  helpers without duplicating their formulas, and `index.js` exports the composed result.
- `summary-regressions`: Tests cover empty, mixed, known-value, consistency, and immutability cases.

## Real CI repair fixture

Before flow 1 starts, the controlled base contains the issue #1 regression cases in its normal
`npm test` suite. They fail against the untouched production implementation, so the model can
observe the required local red state before editing and the local green state after its issue fix.

The same base also runs a CI-only `numerical-stability` step inside the repository's existing
required `ci` job for a real, previously unhandled overflow: averaging two `Number.MAX_VALUE`
inputs returns `Infinity` even though the mathematical mean is finite. The issue explicitly names
this requirement and both verification commands. The `ci-repair-loop` scenario qualifies only if
Keiko observes an actual
required-check failure on a pushed head, the model repairs production code, adds the discovered
case to the local regression suite without changing or suppressing the workflow or seeded tests, a
later commit is pushed, and the required `ci` check passes on that new exact head. If the first
pushed head is already green, the ordinary delivery may continue but it does not qualify the
CI-repair scenario.

## Journey-level evidence

Each issue flow passes only when all of these effects are observed:

- The model uses `keiko_repository_search`, consumes at least one returned hit to select a
  bounded repository read, and performs the issue's own failing-before and passing-after
  verification sequence. Earlier discovery or reads are allowed; no fixed tool sequence is required.
- The model produces a verification-backed commit containing the required production modules and
  regression tests, pushes it, and opens a draft pull request at that exact head.
- Required checks are green on the exact delivered head. A CI repair requires a recorded failed
  head and a distinct later passing head.
- The exact-head diff produces an automatic description draft, and the product applies the bound
  artifact through its governed preview/application service.
- The draft-to-ready transition is separately proposed and approved through the product surface.
- The operator's standing authorization for these five controlled-repository flows is exercised
  through the Governed Merge UI confirmation. The product performs the approval-bound merge; the
  observer then records the actual GitHub merge commit and closed issue. A shell `gh` merge, a
  manual out-of-band mutation, or a fabricated human attestation does not qualify.

## PR #2 — external-change fixture

`git-to-chat-connect-refine-apply` passes only when the existing same-repository branch/PR is
connected from the Git window to a normal Chat conversation through an explicit user action, its
description is refined over more than one turn, and the result is applied through the same
governed PR-description service used by the issue-bound journey.

`git-chat-negative-effects` passes only when no connected-Chat turn succeeds in creating or
checking out a branch, committing, pushing, creating or merging a pull request, closing an issue,
repairing a conflict, running an arbitrary command, or reaching an arbitrary provider endpoint.
The only reachable Git-adjacent effects are connect, refresh, and governed description
draft/preview/apply. One successful forbidden effect fails the scenario.

## Required tools

The manifest's `requiredTools` records exactly these model-visible catalog tools; shell and raw Git
remain outside `OPENCODE_MODEL_VISIBLE_TOOLS`:

```
question, keiko_repository_search, keiko_workspace_discover, keiko_workspace_read,
keiko_changeset_edit, keiko_verification, keiko_git_status, keiko_git_diff, keiko_git_stage, keiko_git_execute,
keiko_git_commit, keiko_git_push, keiko_pull_request, keiko_ci_status, todowrite
```

A tool missing from the qualified head makes fixture solvability blocked with the missing tool
named. It never turns an unavailable capability into a passing scenario.
