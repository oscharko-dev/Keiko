# Issue #3390 qualification evidence — deterministic pieces and blocked external inputs

This directory is not a visual design-system evidence bundle (#3390 introduced no changed UI
surface — the deliverable is a contracts schema, a machine validator, and a real-model harness
skeleton). It is the blocked-external record the issue's own text requires: which qualification
inputs are external and blocked in this environment, and which deterministic evidence exists in
their place. Nothing below is invented as a passing substitute for a blocked input (AGENTS.md §7:
no silent failures, fail closed).

## Qualification inputs that were external and blocked in the agent sandbox

The controlled repository and a real gateway profile now exist on the orchestrator's machine (a
private repository the operator controls, seeded with a real issue and an external branch/PR for
the Git-to-Chat journey) — nothing about them is secret, and the sections below describe the
current, factual state rather than an unmet precondition. The signed-platform, cross-platform
egress-enforcement, and audit-process inputs remain genuinely external and are covered further
down; the operator's 2026-09-05 scope clarification (issue #3384, comment `5553579963`) also keeps
coding-runtime confinement and coding-runtime performance qualification in this task's scope even
though Apple/Windows signing (#2198) and the Atlassian half of #2952 are excluded.

1. ~~**Operator-authorized controlled-repository credentials.**~~ Resolved on the orchestrator's
   machine: `KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT` points at a real local checkout of an
   operator-owned repository with a real seeded issue and an external branch/PR, satisfying issue
   #3390's Acceptance Criteria. This agent sandbox still has no such checkout, which is why the
   harness (below) still fails closed here — that is expected, not a defect.
2. ~~**An approved real-model or LiteLLM profile with a bounded spend budget.**~~ Resolved on the
   orchestrator's machine: the harness (`tests/e2e/support/coding-issue-journey-config.ts`)
   resolves this through the same configuration surface production already reads —
   `KEIKO_MODEL_<id>_API_KEY`/`_BASE_URL` or a `keiko.config.json`-shaped file — plus
   `KEIKO_QUALIFICATION_SPEND_BUDGET_USD`, a positive bounded evaluation budget. This agent sandbox
   still has neither configured, which is why the harness still fails closed here. See "Budget
   note" under Operator sequence for exactly what this variable does and does not enforce.
3. **Signed platform artifacts and cross-platform egress enforcement.** The signed/notarized macOS
   reference installation (#2198) is excluded from this task by the operator's scope
   clarification, and the attested sidecar egress policy (#2951) still has no Linux
   network-namespace bridge or Windows-native enforcement (ADR-0043 D14 addendum). Every manifest
   row that depends on one of them — a packaged Windows x64 or macOS x64 reference run, or the
   Linux/Windows half of the egress-confinement proof — is `blocked`, with the blocking issue
   number, and for the confinement row the ADR-0043 D14 gap it names, as its closed reason. The
   real-binary lane's `ps`/`lsof` egress sampling stays a `functional-not-platform-qualified`
   observation, never an attestation, and its evidence class is deliberately not added to the
   shared `CODE_TASK_EVIDENCE_CLASSES` vocabulary (see the comment on that constant in
   `packages/keiko-contracts/src/code-task-acceptance.ts`) — a `CodeTaskQualificationScenarioV1`
   row produced by that lane is recorded as `outcome: "blocked"` with a `blockedReason` naming the
   gap instead.
4. **Coding-runtime performance budgets and macOS gateway confinement are in scope, not blocked.**
   `coding-runtime-performance-budgets` is an active scenario: its receipt is derived from
   `scripts/coding-runtime-performance-gate.mjs`'s deterministic judgement over the native
   macOS-arm64 measurement `scripts/coding-runtime-performance-producer.mjs` produces (see
   "Operator sequence" below) — it no longer cites #2952 wholesale, since only that issue's
   Atlassian half is excluded. `egress-confinement-macos-arm64` is its sibling active scenario: the
   macOS Seatbelt/gateway confinement enforcement `packages/keiko-sandbox`'s tests already cover,
   backed on a live run by the `runtime.confinement.spawned` activity-log evidence
   (`packages/keiko-server/src/coding-runtime/devLaneRuntimeProcessBackend.ts`). Only the
   Linux/Windows half of that same confinement proof stays blocked (item 3 above).
5. **The `keiko-issue-audit` reviewer reference.** Issue #3390 correction 7 records that
   `keiko-issue-audit` is an operator-run process outside this repository (`git grep -i
   "issue-audit" HEAD` returns no hits). The qualification manifest carries an opaque
   `auditReference`/`auditDigest` binding for it; the validator checks that binding and reports its
   absence as `blocked`, and never executes, reproduces, or substitutes for the audit itself.

## Deterministic evidence that does exist

- **The qualification-manifest schema.** `CodeTaskQualificationManifestV1` and
  `CodeTaskQualificationScenarioV1` in `packages/keiko-contracts/src/code-task-acceptance.ts` — a
  versioned sibling of the #2384 `CodeTaskAcceptanceContributionV1` contract, reusing its closed
  evidence-class/platform/scenario-outcome vocabularies. `codeTaskQualificationManifestFailures` and
  `codeTaskQualificationVerdictFor` are pure, unit-tested functions
  (`packages/keiko-contracts/src/code-task-acceptance.test.ts`): the manifest itself carries no
  `qualified`/`blocked`/`failed` field — the verdict is always derived, never producer-supplied. A
  final-audit pass (F3/F9/F10/F15) closed four gaps: a manifest that silently omitted a required
  scenario now fails with `missing required scenario: <id>`; a `humanMergeAttestationDigest` fact
  is required whenever `journeyOutcomeDigest` is known (the manifest cannot itself see whether that
  referenced outcome claims merged/closed, so the fail-closed reading requires the attestation
  whenever the outcome digest exists at all); a `requiredTools` list of catalog tool names is
  validated against the model-visible OpenCode tool catalog on the qualified head; and
  `spendBudgetUsd`/`observedSpendUsd` let the validator flag overspend after the fact.
- **The manifest producer.** `scripts/generate-coding-issue-journey-manifest.mjs` (CLI) and
  `scripts/lib/coding-issue-journey-manifest.mjs` (pure descriptor+receipts join) mirror
  `scripts/generate-code-task-acceptance.mjs`'s pipeline for this versioned sibling schema:
  `docs/acceptance/coding-issue-journey-3390.json` declares the registered scenarios (eleven active
  journey scenarios plus six blocked-external rows carrying their own closed reason) and the
  generator derives each scenario's outcome/receiptDigest from a receipts directory, validating the
  assembled manifest against the contract before writing it. See
  [`docs/acceptance/README.md`](../../../acceptance/README.md#3390-qualification-manifest-a-versioned-sibling-pipeline)
  for the full pipeline diagram and CLI reference.
- **The machine validator.** `scripts/check-coding-issue-journey-evidence.mjs` (CLI) and
  `scripts/lib/coding-issue-journey-evidence.mjs` (pure cross-referencing logic) SHA-bind a
  manifest to the qualified git head and cross-reference its scenarios against on-disk receipts,
  recomputing each receipt's artifact digest rather than trusting the manifest's claim, and reject
  any `requiredTools` entry absent from the model-visible tool catalog on that head. Negative
  fixtures under `scripts/__tests__/fixtures/coding-issue-journey-evidence/` cover a stale/foreign
  commit SHA, a scripted-model "passed" claim, an unregistered evidence class, a missing receipt, a
  tampered (wrong-digest) receipt, a wrong-platform receipt, a skipped test receipt, an unregistered
  scenario, a manifest missing a required scenario, a known journey outcome with no human merge
  attestation, and a required tool absent from the catalog; one fixture (`valid/`) is fully valid
  and yields the `qualified` verdict.
  `scripts/__tests__/check-coding-issue-journey-evidence.test.mjs` exercises all twelve fixtures
  plus the pure verdict-derivation rules directly.
- **The platform launch drivers.** `scripts/qualify-macos-runtime-release.mjs` and
  `scripts/qualify-windows-runtime-release.mjs` each gained a
  `writeQualificationEvidenceReceipt`/`--qualification-receipts <dir> --scenario-id <id>` mode that
  translates a real, passing runtime-qualification receipt into the `<scenarioId>.receipt.json` +
  `.artifact` pair the checker and producer above already read — so a real qualification becomes
  #3390 evidence with no separate translation step once its external prerequisite (#2198, #2951)
  lands. While that prerequisite stays open the mode is simply never invoked for the
  packaged-reference scenarios; their manifest rows carry the descriptor's own closed `blocked`
  reason instead of a fabricated receipt.
- **The coding-runtime performance and macOS confinement producers.** These reuse the exact same
  shared writer (`scripts/lib/qualification-evidence-receipt.mjs`), fed from a different real
  result instead of a platform driver's own receipt.
  `scripts/coding-runtime-performance-producer.mjs` measures the native macOS-arm64 reference
  (`npm run perf:evidence:coding-runtime`) and `scripts/coding-runtime-performance-gate.mjs` judges
  it deterministically (`npm run check:perf-evidence:coding-runtime -- --enforce-source-freshness`);
  the gate's pass/fail result, together with the measurement's bound source commit and
  `darwin`/`arm64` environment, becomes `coding-runtime-performance-budgets`'s receipt.
  `egress-confinement-macos-arm64`'s receipt is the same translation applied to
  `packages/keiko-sandbox`'s Seatbelt/gateway confinement tests passing, cross-referenced against
  the live run's own `runtime.confinement.spawned` activity-log evidence. See "Operator sequence"
  below for the exact commands.
- **The real-model harness.** `tests/e2e/coding-issue-journey.spec.ts` drives all eight
  fully-harness-owned `playwright-journey` scenarios listed in step 2 below, each through its own
  `test()` gated by `KEIKO_QUALIFICATION_SCENARIOS`, reusing generalized issue-intake/mode-selection/
  approval-answering helpers under `tests/e2e/support/coding-issue-journey-live*.ts` rather than one
  hardcoded "Full access" path. `tests/e2e/config/playwright.coding-issue-journey.config.ts`, and
  `tests/e2e/servers/coding-issue-journey-server.mts` compose the actual production factory
  (`@oscharko-dev/keiko-cli`'s `runUiCli`, the same composition `npm run dev:start` uses) — never
  the scripted resolver in `tests/e2e/servers/coding-runtime-server-shared.mts`. The server process
  fails closed (non-zero exit, no server ever bound) when
  `tests/e2e/support/coding-issue-journey-config.ts` cannot resolve a real gateway profile and a
  real controlled-repository checkout; `tests/e2e/support/coding-issue-journey-config.test.ts`
  proves this deterministically (an empty environment, a nonexistent gateway config path, a
  non-git checkout, a checkout with no GitHub `origin`, and a zero/negative/non-numeric spend
  budget all resolve to the closed `qualification-input-unavailable` reason with every missing
  input named). Because the config resolution is a hermetic precondition of the server ever
  starting, and no scripted composition is reachable from that file at all, it is not possible for
  `npm run test:e2e:coding-issue-journey:live` to pass against anything but the real, wired
  production path — the deliverable this issue requires, per its own text ("It must be impossible
  for the lane to pass with the scripted runtime").
- **What remains unverified.** The harness's "configured" branch — a real run against a real model
  and a real controlled repository — has not executed in this environment for the reasons in
  "Qualification inputs" above. Its Playwright assertions were written against the real,
  already-shipped Coding Workbench selectors and endpoints `coding-issue-intake.spec.ts` (#3385)
  already exercises (the "Preview issue" / "Use this issue" / "Bind workspace" / "Start coding run"
  buttons, the `/api/coding-workbench/github-authorization` and
  `/api/coding-workbench/runtime/status` routes, and the timeline's `data-timeline-kind="tool"`
  rows), not against a mock, but they have not been run end to end against a live model.

## Operator sequence

Once the orchestrator's controlled repository and gateway profile are configured (the resolved
inputs in section 1/2 above), a qualification run follows this sequence.

1. **Configure the environment.** Set:
   - `KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT` — a local checkout with a GitHub `origin`.
   - `KEIKO_QUALIFICATION_CONTROLLED_ISSUE_REFERENCE` — the seeded controlled issue (for example
     `#1`), read directly by the Playwright spec.
   - A real model profile: either `KEIKO_MODEL_<id>_API_KEY` and `_BASE_URL` together, or
     `KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH` naming a `keiko.config.json`-shaped file.
   - `KEIKO_QUALIFICATION_SPEND_BUDGET_USD` — a positive, bounded evaluation budget. It is threaded
     into the launched production process's own environment
     (`tests/e2e/servers/coding-issue-journey-server.mts`) and always recorded on the manifest, but
     see "Budget note" below for exactly what it does and does not enforce.
   - `KEIKO_CODING_DEPLOYMENT_CEILING` — the server reads its deployment ceiling once at process
     start (`packages/keiko-server/src/deps.ts`) and defaults to `governed-assist` when unset.
     `playwright.coding-issue-journey.config.ts`'s own `webServer.env` block now resolves this to
     `autonomous-delivery` by default (an operator override is still honoured), so a bare
     `npm run test:e2e:coding-issue-journey:live` invocation is no longer clamped below the mode
     the "Full access" journey scenarios need. Setting the highest ceiling here does not force the
     effective mode: ADR-0138 still lets the actual mode be selected independently, at or below the
     ceiling, through the Settings → Security UI radios — one server process covers every mode row
     without a restart.
2. **Run the journey scenarios.** `npm run test:e2e:coding-issue-journey:live`, scoped to one or
   more scenario ids via `KEIKO_QUALIFICATION_SCENARIOS` (comma-separated; unset or empty runs
   every scenario in the file) and, optionally, pointed at a receipts directory via
   `KEIKO_QUALIFICATION_RECEIPTS_DIR` — unset defaults to
   `docs/qa/evidence/coding-issue-journey/3390/receipts` (`playwright.coding-issue-journey.config.ts`),
   the exact path these receipts are committed under. Each selected scenario's `test()` drives the
   real production composition end to end and writes a `<scenarioId>.receipt.json` (`{ scenarioId,
   commitSha, platform, testStatus, recordedAt, provenance }`) plus a `<scenarioId>.artifact` file
   into that directory, using the same shared writer the platform launch drivers use
   (`scripts/lib/qualification-evidence-receipt.mjs`) — never a fabricated `passed` result: a
   scenario that does not reach its asserted real effect within its bounded wait records `failed`
   with the observed reason. This produces the eight
   fully-harness-owned `playwright-journey` scenarios (`issue-to-pr-governed-assist`,
   `issue-to-pr-supervised-coding`, `issue-to-pr-autonomous-delivery`, `ci-repair-loop`,
   `description-auto-draft-and-apply`, `mark-ready-intent`, `git-to-chat-connect-refine-apply`,
   `git-chat-negative-effects`), each scoped to the ADR-0138 mode or journey stage its scenario id
   names. `human-merge-and-closure` is the one exception: the harness records the journey's own
   outcome, but its receipt can only be completed after the human merge checkpoint in step 5.
3. **Produce the coding-runtime performance receipt.** From the native macOS-arm64 reference
   machine: `npm run perf:evidence:coding-runtime` (append `-- --calibrate` the first time only, if
   `docs/release/2952-coding-runtime-calibration.json` does not yet exist — calibration is
   immutable once written) followed by
   `npm run check:perf-evidence:coding-runtime -- --enforce-source-freshness`. The gate's pass/fail
   judgement, together with the measurement's own bound source commit and `darwin`/`arm64`
   environment, is translated into `coding-runtime-performance-budgets`'s
   `<scenarioId>.receipt.json` + `.artifact` pair through the same shared writer the platform
   launch drivers use (`scripts/lib/qualification-evidence-receipt.mjs`), written into the same
   receipts directory as step 2.
4. **Produce the macOS egress-confinement receipt.** `egress-confinement-macos-arm64`'s receipt is
   the same translation applied to a different real result: `packages/keiko-sandbox`'s
   Seatbelt/gateway confinement tests passing, cross-referenced against the live run's own
   `runtime.confinement.spawned` activity-log evidence from step 2. The Linux/Windows half of this
   same proof has no producer and stays `blocked` (see "Qualification inputs" above); this step
   never fabricates one in its place.
5. **The human merge checkpoint — performed by the operator, never by an agent.** Issue #3390 AC5
   requires a separate, explicit human review and merge in the controlled repository; the harness
   must not bypass this with agent merge/close permissions, and no automated step above performs
   it. The operator reviews and merges the controlled repository's pull request by hand, then
   supplies the resulting merge fact through `--human-merge-attestation <path-to-digest>` on the
   manifest generator (step 6) so `human-merge-and-closure` can complete. No script or harness step
   in this pipeline ever merges or closes on the operator's behalf.
6. **Generate the manifest.** `npm run qualify:coding-issue-journey:manifest -- --descriptor
   docs/acceptance/coding-issue-journey-3390.json --receipts <receipts-dir> --commit <head sha>
   --tree <head tree sha> --runtime-identity <id> --model-identity <id> --fixture-revision <id>
   --rubric docs/qa/evidence/coding-issue-journey/3390/rubric.md --required-tools <catalog tool
   names> --spend-budget-usd <budget> [--issue-ref <opaque>] [--pr-ref <opaque>] [--run-ref
   <opaque>] [--readiness-digest <sha256>] [--journey-outcome-digest <sha256>]
   [--human-merge-attestation <path-to-digest>] [--audit-ref <opaque>] [--audit-digest <sha256>]
   [--observed-spend-usd <number>] --output
   docs/qa/evidence/coding-issue-journey/3390/manifest.json`. The descriptor's six `blocked` rows
   need no receipt; their closed reason is carried in the descriptor itself, never fabricated by
   this step.
7. **Validate.** `npm run check:coding-issue-journey-evidence:3390` SHA-binds the manifest to the
   current git head, cross-references every scenario against the receipts directory, and prints the
   derived verdict (`qualified` / `blocked` / `failed`) with every failure named. A `blocked` row is
   never a skipped-green row: it names the external issue or process that still gates it (`#2198`,
   `#2951` — including, on the egress row, the ADR-0043 D14 Linux/Windows confinement-enforcement
   gap — the red real-binary lane, or the operator-run `keiko-issue-audit` process), so a reader can
   see exactly what remains outside this repository's control, and the manifest-level verdict can
   never reach `qualified` while one is outstanding.

### Budget note

`KEIKO_QUALIFICATION_SPEND_BUDGET_USD` is validated as a positive-number start precondition and
recorded on the manifest; it is not a running, pre-call monetary ceiling. Nothing in the Model
Gateway converts token usage into a dollar figure to compare against it while a run is in
progress — the product records token usage, not live monetary spend. The USD ceiling the operator
approves for the run (or for the aggregate of all real-model attempts and retries) is enforced
procedurally: the operator watches actual provider billing during the run and stops it manually if
the ceiling is reached, then records the real figure through `--observed-spend-usd <number>` on the
manifest generator (step 6) so the validator can flag an overage after the fact. Omitting that flag
records `{ outcome: "unknown" }` on the manifest and skips the overspend check silently — always
supply it for a run that spent anything.

## Reading this alongside the epic

See the "Qualification inputs" section of [`docs/qa/epic-3384-delivery-plan.md`](../../../qa/epic-3384-delivery-plan.md)
for the same summary in the epic-wide delivery plan.
