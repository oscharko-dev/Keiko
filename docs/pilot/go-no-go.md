# Wave 1 Pilot Go/No-Go Assessment

**Audience:** pilot program leadership, customer model evaluators, release decision-makers

**Status:** baseline criteria for automated harness validation; final pilot Go/No-Go requires human-reviewed live model evaluation.

---

## Purpose

The evaluation harness (`keiko evaluate`) measures the two Wave 1 developer workflows (unit-test generation, bug investigation) across seven dimensions and runs in two modes.

**What the harness establishes:**

- **Offline mode (deterministic):** The harness machinery, safety guards, and audit pipeline work end-to-end as a composed system. Scripted model transcripts prove that the parser, patch validator, verification machinery, and evidence-persistence layer all function correctly under controlled inputs.
- **Live mode (opt-in):** Real-world model behaviour against a candidate customer model, with recorded evidence manifests linking scores to audit trails for pilot-team review.

**What the harness does NOT measure:**

- Real model output quality, token efficiency, or sensitivity to prompt variations. Offline mock transcripts are hand-authored; they exercise harness machinery deterministically but do not measure model performance.
- Model safety or appropriateness for your customer domain. Live evaluation is opt-in; a team that never runs `--live` has no evidence of real model behaviour.
- Edge cases or feature completeness beyond the Wave 1 fixture set (≥3 fixtures per workflow).

---

## Evaluation Dimensions

The harness scores seven dimensions per fixture, plus one structural surface-parity check.

| Dimension                     | Meaning                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| **task-completion**           | Workflow reaches a success terminal status (not rejected, cancelled, or failed)                |
| **patch-correctness**         | Model output produces the expected diff (or absence thereof)                                   |
| **test-pass-rate**            | Generated tests run and pass on the source code (apply mode only)                              |
| **verification-completeness** | Workflow produces verification results or explicitly declares skip acceptable                  |
| **patch-size**                | Diff stays within expected file-count and byte-size limits                                     |
| **audit-completeness**        | Run produces a valid, redacted evidence manifest (compliance property)                         |
| **unsafe-action-rejection**   | Dangerous diffs (e.g., touching `.github/workflows/`, `.husky/`) are rejected with zero writes |

**Surface-parity (structural, not scored):** CLI flags, SDK exports, UI descriptor, and workflow types present a consistent contract. Parity failure is a hard blocker (exit 1) regardless of dimension scores.

---

## Running the Harness

### Offline mode (default)

```bash
keiko evaluate
keiko evaluate --suite unit-tests
keiko evaluate --fixture unit-tests/happy-path
keiko evaluate --json
keiko evaluate --output ./scorecard.json
```

No credentials required. Runs in CI. Deterministic, reproducible.

### Live mode (opt-in)

```bash
keiko evaluate --live --model gpt-4
keiko evaluate --live --model claude-opus
```

Requires:

- Gateway config file (`keiko.config.json` or via env)
- API credentials (`KEIKO_DEFAULT_API_KEY` and `KEIKO_DEFAULT_BASE_URL`)

**Fail-closed behaviour:** when `--live` is requested but credentials are absent, the harness prints a clear error message and exits 1. It never silently downgrades to offline mode.

### Output formats

- **Text summary (default):** per-fixture results, per-dimension table, Go/No-Go verdict
- **JSON scorecard (`--json` or `--output <path>`):** versioned `EvalScorecard` (schemaVersion: "1") with all dimension results, surface-parity checks, and evidence references

### Exit codes

- `0` — all applicable dimensions passed AND surface-parity passed
- `1` — a dimension failed, surface-parity failed, missing config, or runtime error
- `2` — usage error (unknown flag, mutual-exclusion violation, unknown suite/fixture)

---

## Reading the Scorecard

The `EvalScorecard` JSON contains these top-level fields:

| Field              | Meaning                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **schemaVersion**  | Always `"1"`. Change signals breaking schema modifications.                                                                                                       |
| **evaluatedAt**    | ISO 8601 timestamp of run start.                                                                                                                                  |
| **mode**           | `"offline"` or `"live"`.                                                                                                                                          |
| **liveRunContext** | Present in live mode only. Contains `modelId`, `configDescriptor` (no secrets), and `evidenceRefs` (paths to evidence manifests written during this run).         |
| **dimensions**     | Array of `ScorecardEntry`; one per dimension name. Each has `passCount`, `failCount`, `notApplicableCount`, and `passRate` (or `null` if no applicable fixtures). |
| **surfaceParity**  | Boolean `allPassed` and array of per-check results.                                                                                                               |
| **fixtureResults** | Array of `FixtureRunResult`; one per fixture run. Contains `fixtureName`, `workflowKind`, `durationMs`, `dimensionResults`, and raw `report`.                     |
| **summary**        | `ScorecardSummary` with the following fields.                                                                                                                     |

### ScorecardSummary fields

| Field                   | Meaning                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **totalFixtures**       | Total number of fixtures evaluated.                                                                                                                                                    |
| **fullyPassedFixtures** | Count of fixtures where all applicable dimensions passed.                                                                                                                              |
| **safetyGatePassed**    | `true` iff every unsafe-action-rejection fixture passed AND surface-parity passed. False means security regression or integration drift.                                               |
| **pilotReadyIndicator** | `true` iff all the offline Go/No-Go thresholds (see next section) are met. **This is a machine-computable check only.** Final pilot approval requires human review of live evaluation. |

---

## Go/No-Go Criteria

### Offline Go/No-Go thresholds (machine-computable)

The following thresholds apply to the deterministic offline mock suite. All are blockers; any failure is NO-GO.

| Criterion                            | Threshold           | Rationale                                                                                             |
| ------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------- |
| **unsafe-action-rejection passRate** | 1.0 (zero failures) | A single pass-through of a dangerous diff is a security regression.                                   |
| **task-completion passRate**         | 1.0                 | Mock transcripts are designed to succeed; any mock-mode failure indicates harness machinery breakage. |
| **audit-completeness passRate**      | 1.0                 | Every run must produce a valid, redacted manifest — this is a compliance requirement.                 |
| **patch-correctness passRate**       | 1.0                 | Mock transcripts produce valid patches; any failure indicates parser or guard breakage.               |
| **surface-parity**                   | All checks pass     | Divergent surfaces (CLI, SDK, UI descriptor) indicate integration drift that blocks users.            |

When all five thresholds pass, `pilotReadyIndicator` is `true` and the harness exits 0.

### Live Go/No-Go assessment (human-reviewed)

**The offline thresholds gate harness integrity. Final pilot Go/No-Go additionally requires human evaluation of a live model run.**

The pilot team runs `keiko evaluate --live --model <candidate-model>` and reviews:

1. **Per-dimension scores** against the pilot's quality bar for your domain (e.g., "test-pass-rate must exceed 85% on realistic code samples").
2. **Linked evidence manifests** (`EvalScorecard.liveRunContext.evidenceRefs`) — inspect the raw workflow reports and redacted audit trails to understand failure modes.
3. **Model identity and config** (`EvalScorecard.liveRunContext.configDescriptor` and `liveRunContext.modelId`) — confirm the tested model and gateway settings match your deployment target.

No machine-computable threshold is published for live evaluation; the pilot team's domain expertise determines readiness.

---

## Known Limitations

### Mock transcripts do not measure model quality

Offline fixtures are hand-authored by the harness author. They exercise the harness machinery and scoring logic deterministically but do NOT measure:

- Real model output quality or usefulness
- Token efficiency or cost per invocation
- Sensitivity to prompt variations or instruction tuning
- Performance on your customer's codebase characteristics

A green offline score means "the harness machinery works," not "the model is ready for production."

### Live evaluation is opt-in and non-gating

- A team that never runs `keiko evaluate --live` has zero evidence of real model behaviour.
- Live evaluation is not part of the required CI check set. There is no automated gate on model regressions.
- Operationally, the pilot team must schedule live evaluation manually and review results before releases.

### The Wave 1 fixture set is intentionally minimal

- Unit-test workflow: 3 fixtures (happy-path, unsafe-action rejection, retry-on-rejection)
- Bug-investigation workflow: 3 fixtures (happy-path, unsafe-action rejection, investigation-only)

Edge cases, corner inputs, and adversarial prompts beyond these scenarios are not covered.

### test-pass-rate and verification-completeness only apply in apply mode

These dimensions measure the second-stage verification (running generated tests, checking fixes against the original failing test). They are:

- **Not applicable** in default dry-run mode (which is the default for offline fixtures)
- **Only meaningful** when a fixture explicitly enables apply mode with real or mocked command execution

Offline fixtures score these dimensions as "not-applicable" unless configured otherwise; this is expected and correct.

---

## References

- **ADR-0012: Wave 1 Evaluation Harness and Model Benchmarks** — full design, decision rationale, and implementation contract. See especially decisions D6 (dimensions), D7 (surface-parity), D8 (output schema), D10 (CLI), and D13 (Go/No-Go criteria). [../adr/ADR-0012-wave-1-evaluation-harness-and-model-benchmarks.md](../adr/ADR-0012-wave-1-evaluation-harness-and-model-benchmarks.md)
- **Issue #11: Create Wave 1 evaluation harness and model benchmark fixtures** — acceptance criteria and delivery evidence.
