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
current, factual state rather than an unmet precondition. The signed-platform and audit-process
inputs remain genuinely external and are covered further down.

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
   still has neither configured, which is why the harness still fails closed here.
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
  `docs/acceptance/coding-issue-journey-3390.json` declares the registered scenarios (nine active
  journey scenarios plus seven blocked-external rows carrying their own closed reason) and the
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

## Operator sequence

Once the orchestrator's controlled repository and gateway profile are configured (the resolved
inputs in section 1/2 above), a qualification run follows this sequence:

1. **Configure the environment.** Set `KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT` (a local
   checkout with a GitHub `origin`), a real model profile
   (`KEIKO_MODEL_<id>_API_KEY`/`_BASE_URL` or `KEIKO_QUALIFICATION_GATEWAY_CONFIG_PATH`), and
   `KEIKO_QUALIFICATION_SPEND_BUDGET_USD` (a positive, bounded evaluation budget — threaded into the
   launched production process's own env by `tests/e2e/servers/coding-issue-journey-server.mts` so
   it is available for gateway-side enforcement, and always recorded on the manifest so the
   validator can flag overspend after the fact even when the gateway does not enforce it).
2. **Run the journey.** `npm run test:e2e:coding-issue-journey:live` drives the real production
   composition end to end and, for each registered active scenario, produce a
   `<scenarioId>.receipt.json` (`{ scenarioId, commitSha, platform, testStatus, recordedAt,
   provenance }`) and a `<scenarioId>.artifact` file under a receipts directory (for example
   `docs/qa/evidence/coding-issue-journey/3390/receipts/`). The platform launch drivers
   (`scripts/qualify-macos-runtime-release.mjs --qualification-receipts <dir> --scenario-id <id>`,
   and the Windows sibling) bridge a real packaged-qualification receipt into the same shape.
3. **Generate the manifest.** `npm run qualify:coding-issue-journey:manifest -- --descriptor
   docs/acceptance/coding-issue-journey-3390.json --receipts <receipts-dir> --commit <head sha>
   --tree <head tree sha> --runtime-identity <id> --model-identity <id> --fixture-revision <id>
   --rubric <rubric file> --required-tools <catalog tool names> --spend-budget-usd <budget> [the
   opaque references and digests as they become available] --output
   docs/qa/evidence/coding-issue-journey/3390/manifest.json`. The descriptor's `blocked` rows (the
   seven external-dependency scenarios) need no receipt — their closed reason is carried in the
   descriptor itself, never fabricated by this step.
4. **Validate.** `npm run check:coding-issue-journey-evidence:3390` SHA-binds the manifest to the
   current git head, cross-references every scenario against the receipts directory, and prints the
   derived verdict (`qualified` / `blocked` / `failed`) with every failure named. A `blocked` row is
   never a skipped-green row: it names the external issue or process that still gates it (`#2198`,
   `#2951`, `#2952`, `#3421`, the red real-binary lane, or the operator-run `keiko-issue-audit`
   process) so a reader can see exactly what remains outside this repository's control, and the
   manifest-level verdict can never reach `qualified` while one is outstanding.

## Reading this alongside the epic

See the "Qualification inputs" section of [`docs/qa/epic-3384-delivery-plan.md`](../../../qa/epic-3384-delivery-plan.md)
for the same summary in the epic-wide delivery plan.
