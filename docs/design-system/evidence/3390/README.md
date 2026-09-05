# Issue #3390 qualification evidence — deterministic pieces and blocked external inputs

This directory is not a visual design-system evidence bundle (#3390 introduced no changed UI
surface — the deliverable is a contracts schema, a machine validator, and a real-model harness
skeleton). It is the blocked-external record the issue's own text requires: which qualification
inputs are external and blocked in this environment, and which deterministic evidence exists in
their place. Nothing below is invented as a passing substitute for a blocked input (AGENTS.md §7:
no silent failures, fail closed).

## Qualification inputs that are external and blocked here

None of the four inputs below can be supplied inside an agent sandbox. Each is a named, closed
blocker — never a skipped-green row — until an operator supplies it.

1. **Operator-authorized controlled-repository credentials.** The real-model journey needs a real
   GitHub repository the operator owns, seeded with a real failing issue that requires coordinated
   changes across at least two production modules plus regression tests, an explicit acceptance
   rubric, and known failing-before behavior (issue #3390, Acceptance Criteria). No such repository,
   credential, or seeded issue exists in this repository or this environment.
2. **An approved real-model or LiteLLM profile with a bounded spend budget.** The harness
   (`tests/e2e/support/coding-issue-journey-config.ts`) resolves this through the same
   configuration surface production already reads — `KEIKO_MODEL_<id>_API_KEY`/`_BASE_URL` or a
   `keiko.config.json`-shaped file — plus `KEIKO_QUALIFICATION_SPEND_BUDGET_USD`. None is
   configured here, and this task does not provision one (issue #3390: "Do not provision paid
   resources ... spend beyond operator-approved evaluation budgets").
3. **Signed platform artifacts.** Issue #3390 correction 1 (verified 2026-09-04 against
   `epic/3384-issue-to-pr@a711d21f`) records that the signed/notarized macOS reference installation
   (#2198), the coding-runtime performance budgets (#2952), and the attested sidecar egress policy
   (#2951) are all open external prerequisites — #2951/#2952/#2198 are `OPEN` on GitHub as of that
   date. Every manifest row that depends on one of them (a packaged macOS arm64/x64 or Windows x64
   reference run, an egress/confinement proof, a startup/latency/output/backpressure/cleanup
   measurement) is `blocked` with the blocking issue number as its closed reason. The real-binary
   lane's `ps`/`lsof` egress sampling stays a `functional-not-platform-qualified` observation, never
   an attestation, and its evidence class is deliberately not added to the shared
   `CODE_TASK_EVIDENCE_CLASSES` vocabulary (see the comment on that constant in
   `packages/keiko-contracts/src/code-task-acceptance.ts`) — a `CodeTaskQualificationScenarioV1` row
   produced by that lane is recorded as `outcome: "blocked"` with a `blockedReason` naming the gap
   instead.
4. **The `keiko-issue-audit` reviewer reference.** Issue #3390 correction 7 records that
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
  `qualified`/`blocked`/`failed` field — the verdict is always derived, never producer-supplied.
- **The machine validator.** `scripts/check-coding-issue-journey-evidence.mjs` (CLI) and
  `scripts/lib/coding-issue-journey-evidence.mjs` (pure cross-referencing logic) SHA-bind a
  manifest to the qualified git head and cross-reference its scenarios against on-disk receipts,
  recomputing each receipt's artifact digest rather than trusting the manifest's claim. Negative
  fixtures under `scripts/__tests__/fixtures/coding-issue-journey-evidence/` cover a stale/foreign
  commit SHA, a scripted-model "passed" claim, an unregistered evidence class, a missing receipt, a
  tampered (wrong-digest) receipt, a wrong-platform receipt, a skipped test receipt, and an
  unregistered scenario; one fixture (`valid/`) is fully valid and yields the `qualified` verdict.
  `scripts/__tests__/check-coding-issue-journey-evidence.test.mjs` exercises all nine fixtures plus
  the pure verdict-derivation rules directly.
- **The real-model harness skeleton.** `tests/e2e/coding-issue-journey.spec.ts`,
  `tests/e2e/config/playwright.coding-issue-journey.config.ts`, and
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

## Reading this alongside the epic

See the "Qualification inputs" section of [`docs/qa/epic-3384-delivery-plan.md`](../../../qa/epic-3384-delivery-plan.md)
for the same summary in the epic-wide delivery plan.
