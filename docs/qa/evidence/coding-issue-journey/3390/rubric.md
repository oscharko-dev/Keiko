# #3390 controlled-fixture acceptance rubric

This rubric is the `--rubric <path>` input to `scripts/generate-coding-issue-journey-manifest.mjs`
(`docs/acceptance/README.md`, `docs/design-system/evidence/3390/README.md`): the generator hashes
this file into the manifest's `rubricDigest` and never embeds its content. It records what a
passing real-model run must actually show against the two operator-authorized controlled fixtures
in `oscharko/Wegwerf-Repo`, so a scenario's `"passed"` outcome can be checked against a fixed bar
instead of a narrated claim (AGENTS.md §7: no silent failures; issue #3390: "evaluate the observed
effects, governing invariants and task rubric" rather than one hardcoded tool sequence). Nothing
below reproduces repository content — only identifiers, rule statements and required evidence.

## Controlled fixtures

- **Issue fixture** — `oscharko/Wegwerf-Repo` issue **#1**, open, labeled `bug`: backs the
  issue-to-pr journey scenarios (`issue-to-pr-governed-assist`, `issue-to-pr-supervised-coding`,
  `issue-to-pr-autonomous-delivery`, `ci-repair-loop`, `description-auto-draft-and-apply`,
  `mark-ready-intent`, `human-merge-and-closure`).
- **External-change fixture** — `oscharko/Wegwerf-Repo` pull request **#2**, open, same-repository
  branch `docs/usage-section` targeting `master` (`isCrossRepository: false`): backs the
  Git-to-Chat scenarios (`git-to-chat-connect-refine-apply`, `git-chat-negative-effects`).

Both are real, live GitHub facts on the operator-authorized repository; the model receives the
issue or the connected branch itself, never a prerecorded patch or tool script.

## Issue #1 — acceptance criteria and required passing evidence

Issue #1's five checked acceptance criteria, restated as the evidence a real-model run must
produce:

1. **`average([])` returns `0`.** The fixed behavior no longer returns a non-finite result for an
   empty input; a passing test case exercises exactly this input and its expected output.
2. **`average()` ignores non-finite entries.** Any entry that is not a finite number (`NaN`,
   `Infinity`, `-Infinity`) is excluded before the mean is computed; a passing test case exercises
   a mixed list containing at least one such entry and asserts the mean of the remaining finite
   entries.
3. **Two coordinated production modules, not a single-file patch.** The change adds a dedicated
   finite-number-selection module under `lib/` and changes `index.js` to compose that module into
   `average()`, rather than inlining the selection logic or leaving `lib/` unused. A run that edits
   only `index.js`, or adds a `lib/` module `index.js` never imports, does not satisfy this
   criterion.
4. **`sum()` is unchanged.** The existing `sum()` behavior and its existing passing tests are
   unaffected by the change; a run that alters `sum()`'s observable behavior, or whose diff touches
   `sum()` without a functional reason tied to this issue, does not satisfy this criterion.
5. **Regression coverage lands in `test/index.test.js`.** A `node:test` case (or cases) added to
   that file covers both rules above — the empty-list case and the non-finite-entry case — and the
   case fails against the pre-fix behavior and passes against the fix (the standing repository
   regression-pin discipline, AGENTS.md §7, applied to this fixture).

## Journey-level evidence required on top of the fixture fix (issue #3390 AC3/AC9/AC10)

A scenario built on the issue fixture is `"passed"` only when, in addition to the five criteria
above:

- **Meaningful local tests ran before commit.** The model's own local verification step actually
  executed the project's test command and observed a real result, not a claimed one.
- **The exact commit and push are observed, not narrated.** The model produces one commit
  containing the `index.js` and `lib/` changes plus the new test case, pushes it, and a draft pull
  request exists at that exact head.
- **CI is green on the pushed head.** The controlled repository's required check
  (`.github/workflows/ci.yml`) reports success against the exact commit SHA the model pushed. If an
  earlier push observed a CI failure, the repair loop is evidenced by a second, later commit whose
  CI result is green — never by re-reporting the first, failing result as passing.
- **The PR description is auto-drafted and governably applied.** A description generated from the
  exact-head diff is presented for governed application through the existing PR preview and is
  actually applied to the pull request at that head — never hand-written narration substituting
  for the generated-and-applied artifact.
- **A mark-ready intent is proposed, never auto-executed.** The model proposes transitioning the
  draft pull request to ready-for-review; the proposal is recorded as a governed intent awaiting
  approval, and no scenario in this rubric treats the pull request as marked ready without a
  separate, observed approval.
- **Human merge and closure are observed facts, not agent actions.** `human-merge-and-closure`
  passes only when an actual human merge of the controlled repository's pull request, and the
  resulting issue closure, are observed after the fact (`--human-merge-attestation`); no scenario in
  this rubric is satisfied by an agent-performed merge or close.

## PR #2 — external-change fixture, required passing evidence

`git-to-chat-connect-refine-apply` passes only when all of the following are observed:

- **Explicit connection.** The existing same-repository branch/PR (`docs/usage-section` → `master`)
  is connected from the Git window to a normal Chat conversation through an explicit user action —
  never auto-discovered or silently attached.
- **Multi-turn refinement.** The connected change's description is refined over more than one
  conversational turn — a single-shot draft-and-apply does not exercise this scenario.
- **Applied through the same governed service.** The refined description is applied to the pull
  request through the same governed PR-description application path the issue-bound journey uses
  (`description-auto-draft-and-apply`'s underlying service) — not a second, parallel mechanism.

`git-chat-negative-effects` passes only when, across the entire connected-Chat session on this
fixture, none of the following ever succeeds: creating or checking out a branch, committing,
pushing, creating a pull request, merging, closing, repairing a conflict, running an arbitrary
command, or reaching an arbitrary provider endpoint. The only reachable Git-adjacent effects are
connect, refresh, and the governed description draft/preview/apply path above — matching the
frozen route surface `packages/keiko-server/src/gitChangeRoutes.test.ts` already pins for the
underlying contract. A single successful disallowed action fails this scenario outright, regardless
of how many other turns behaved correctly.

## Required tools

The journey is solvable with, and the manifest's `requiredTools` records exactly the catalog tools
actually used from, the model-visible OpenCode catalog on the qualified head — no shell and no raw
`git` tool, both of which stay outside `OPENCODE_MODEL_VISIBLE_TOOLS`:

```
question, keiko_workspace_discover, keiko_workspace_read, keiko_changeset_edit,
keiko_verification, keiko_git_status, keiko_git_diff, keiko_git_stage, keiko_git_commit,
keiko_git_push, keiko_pull_request, keiko_ci_status, todowrite
```

A run that requires a tool absent from the qualified head's catalog does not make this rubric
unsolvable by itself — it makes the fixture-solvability row `blocked`, naming the missing tool,
rather than a failed scenario (issue #3390 correction 4).
