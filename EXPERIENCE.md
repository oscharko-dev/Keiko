# Keiko engineering experience

This is a task-scoped record of repository lessons, not an additional authority source or a
transcript of agent sessions. Read the entries relevant to the files, tools or failure under
investigation. Applicable instructions remain binding; a lesson cannot weaken AGENTS.md, an ADR,
a regression pin, security controls or required checks.

## How to maintain this file

- Record a lesson only after a reproducible failure, accepted review finding or verified repair.
  An agent's speculation and an unverified social-media claim are not repository experience.
- Prefer a regression test, lint rule or existing deterministic gate when the lesson is executable.
  Link that proof here instead of repeating its implementation or numerical thresholds.
- Keep one entry per failure class. Amend or remove stale advice in the same PR that changes its
  premise; preserve incident history through Git rather than appending contradictory instructions.
- The contributor changing an entry checks its evidence; the responsible maintainer validates it
  during normal review. Revalidate when the referenced implementation, toolchain or gate changes.
- Do not automatically append after every task, import the whole file into every prompt, or store
  private logs, prompts, customer content, credentials or personal data here.
- Use this shape for new or materially revised entries:

  - Scope and symptom: when does this apply, and what observable failure occurs?
  - Cause and correction: the owning invariant and the smallest durable repair.
  - Evidence: issue/PR/commit plus the existing test, gate or reproduction command.
  - Validation: date, revision and actual result; distinguish historical evidence from a fresh run.
  - Retirement trigger: which implementation or toolchain change requires revisiting the advice?

## Migrated repository lessons

The following eight entries are preserved from AGENTS.md section 9 at
[`babee4b4c`](https://github.com/oscharko-dev/Keiko/blob/babee4b4c/AGENTS.md).
Migration on 2026-10-19 is provenance, not a claim that every historical experiment was rerun.
Existing linked decisions and executable gates remain the source to check before applying advice.

- **`packages/keiko-ui/**/globals.css` is behind a SHA-pinned visual-proof gate (#1300).** Editing
  it to add component or state styling trips a byte-exact hash check and a cross-mode axe/visual
  proof, turning CI red. Style components with **component-scoped classes** (e.g. `.cmp-*`), not
  by extending global CSS. See [`docs/design-system/`](docs/design-system/).
- **Editor perf evidence does not need an in-flight regeneration — except for toolchain edits.**
  The pull-request gate validates evidence integrity + budgets only (ADR-0139 D10), and since
  ADR-0156 D2 it asks the toolchain-freshness question only of a diff that actually touches
  `D12_MEASUREMENT_TOOLCHAIN_PATHS`. Regenerate in-flight (`npm run perf:evidence:regen`) when
  your diff touches a path listed in that set — changing the ruler requires re-measuring with it.
  Real per-PR perf protection lives in the deterministic bundle gates (`check:editor-release-evidence`,
  `check:editor-bundle-size`).
- **The D12 reference environment is a developer machine, not CI (ADR-0156 D6).** The budgets are
  absolute numbers calibrated on the pinned container at linux/arm64 with >=14 logical cores, which
  is where every committed evidence document was measured. A hosted runner has 4 cores and measures
  the same scenario at roughly twice the cost, so it cannot produce a passing document — the
  scheduled `nightly-perf-evidence` lane therefore **detects drift and does not measure**, and files
  a tracking issue when the committed evidence stops binding `dev`. If you see a 2x "regression",
  check the provenance hardware in the document before believing it: comparing a local document
  against a hosted run is comparing two machine classes. See
  [`docs/qa/perf-evidence.md`](docs/qa/perf-evidence.md).
- **New package exports drift `check:package-surface`.** Adding a public export changes the
  packaged surface contract; run `npm run check:package-surface:assembled` and update the expected
  surface. The aggregate builds the product, prepares the CLI mode, builds the UI, removes
  build-only and host-native artifacts, and then runs the fail-closed surface checker.
- **`check:package-surface:assembled` prunes the LIVE `node_modules`, not a staged copy.** Its
  `prune:package-build-artifacts` and `prune:package-native-optionals` steps run against the real
  checkout: they delete `node_modules/@napi-rs/canvas` and `canvas-*` (root, and the same under
  every `packages/*/node_modules`), and remove `packages/<name>/node_modules` entirely for every one
  of the ~23 workspaces listed in the root `package.json`'s `bundleDependencies`. Nothing later in
  the aggregate restores them. Run `npm test` afterward in the same checkout and
  `scripts/__tests__/registry-install-smoke-security.test.mjs`'s dependency-closure test fails —
  `@napi-rs/canvas` missing from the tree it walks — a false regression with nothing to do with your
  change. Run the assembled surface check LAST, after `npm test`, or restore first with
  `npm install`.
- **A new long-lived integration branch (`feat/…`) must be added in THREE places in
  `.github/workflows/ci.yml`**: the `push:` trigger list, the `pull_request:` trigger list, AND
  the protected-branch-gate `case` allowlist (`refs/heads/<branch>:` and `*:<branch>` patterns) —
  miss the third and CI runs but the gate still rejects the merge. Add the same branch to CodeQL's
  `push:` and `pull_request:` lists and Dependency Review's `pull_request:` list. Verify the
  three-workflow branch-list comparison with `npm run check:workflow-branch-parity`; it is the
  repository-owned replacement for the audit's `awk`/`diff` check and fails on any missing or
  extra branch.
- **Coverage is ratcheted against a committed baseline** (`docs/qa/package-coverage-baseline.json`)
  with per-file floors across all four metrics. Lowering coverage fails the gate; if you add code,
  add tests. There is exactly ONE per-file floor store and ONE evaluation
  (`npm run check:coverage:quality`) — do not add a `coverage.thresholds` block to a vitest config
  to gate a file, and do not write the literal `85` into a coverage gate (import
  `KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum`). Which ruler answers which question is
  the one table in [`docs/qa/coverage-truth-model.md`](docs/qa/coverage-truth-model.md); the
  reasoning is [ADR-0158](docs/adr/ADR-0158-one-coverage-ruler-per-question.md).
- **Some agent harnesses run sub-agents in an isolated worktree at clean `HEAD`.** If you delegate
  edits, confirm they landed on _this_ working tree and not a throwaway checkout before you report
  the change as made.

## Lessons recorded since the migration

- **A window retry must preserve the existing turn's terminal settlement (#4244).**
  - Scope and symptom: a provider context-window overflow after a confirmed tool write can be
    swallowed into an early answer, or a later retry preflight can fail outside the tool turn and
    report failure despite the committed write.
  - Cause and correction: carry the existing bounded retry owner's decision through every active
    consumer, retain correction state only while that retry remains valid, and route a refused
    second preflight through the existing answer/transcript settlement. Read existing grants and
    liveness; do not reset budgets or infer retry fit from the previous prompt size.
  - Evidence and validation: on 2026-11-04, the failure-first public-handler, window-owner and turn
    regressions passed in 13 suites (650 tests), including tight-grant refusals, successful retries,
    canonical replay and stop/scope changes. See `grounded-jira-mixed.public-handler.test.ts`,
    `gateway-context-window.test.ts` and ADR-0181.
  - Retirement trigger: revisit when the window owner, synthesis grants or tool-turn terminal
    settlement changes.

- **Commit a complete runtime source checkpoint before HEAD-bound qualification (#4244).**
  - Scope and symptom: after adding runtime imports, the real owned-source digest test in
    `scripts/__tests__/tool-catalog-conformance.test.mjs` can reject an otherwise valid dirty tree
    with `Git source inventory does not match the owned source set`.
  - Cause and correction: the collector follows current runtime imports, while the digest reads
    those files from the specified Git commit. Commit every new runtime file on the feature branch
    before running HEAD-bound qualification; preserve the fail-closed digest check.
  - Evidence and validation: on 2026-11-04, four newly imported runtime files were absent from the
    base commit. The unchanged conformance suite passed 73/73 on source checkpoint
    `95d18d8d8004f479263a871106aaf18a0b36b5e6`; no test or gate change was needed.
  - Retirement trigger: revisit if the owned-source collector stops deriving its inventory from
    current runtime imports, or qualification gains an explicit immutable source-snapshot input.

- **Root `package.json` is a SHA-pinned source of the #1300 design-evidence proofs.** Adding an npm
  script, even an alias for repository tooling, changes its digest and turns the keiko-ui coverage
  suite red (`globals.css.test.ts`, "pins the complete shared producer, fixture and stylesheet input
  set"), and the proofs may only be regenerated on the Linux reference environment. Give a lab or
  tool a `node scripts/...` entry point and register it in `knip.json` instead; the continuity and
  memory labs run that way. Seen on PR #4230 (2026-11-03).
