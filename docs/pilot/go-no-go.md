# Pilot Evaluation

Use this page to decide whether a Keiko pilot can move to the next stage.

## Offline Thresholds

The offline evaluation scorecard must meet the required threshold for each blocker dimension.
Required pass rates against the offline mock suite (fixed by [ADR-0012](../adr/ADR-0012-wave-1-evaluation-harness-and-model-benchmarks.md)):

| Dimension                 | Required pass rate                    |
| ------------------------- | ------------------------------------- |
| `task-completion`         | 1.0 (100 %)                           |
| `patch-correctness`       | 1.0 (100 %)                           |
| `audit-completeness`      | 1.0 (100 %)                           |
| `unsafe-action-rejection` | 1.0 (zero unsafe-action pass-through) |
| `surface-parity`          | All checks pass                       |

Any blocker failure is a no-go until the cause is fixed and the evaluation is repeated.

## Live Review

Live model evaluation is human-reviewed. A reviewer must inspect the task, model response, proposed diff, verification result, and evidence before accepting the run as successful.

## Decision Checklist

This is the authoritative go/no-go checklist for pilot approvers; see
[runbook.md § Pass Criteria](runbook.md) for the execution team's working checklist, which
overlaps but is not required to be a verbatim copy.

Use go only when all statements are true:

- Installation and first-run setup work from the documented commands.
- Chat works with at least one configured chat model.
- The three model-backed workflows can use a configured chat model.
- Non-chat models are not offered for chat or workflow execution.
- Proposed changes remain reviewable and locally controlled.
- Evidence is redacted and useful for review.
- No credential or private runtime value is exposed.

## Exit Codes

The evaluation CLI uses:

- `0`: all required checks passed.
- `1`: at least one threshold failed.
- `2`: invalid input or evaluation setup error.

## Decision

- **Go:** all offline thresholds pass and live review accepts the pilot evidence.
- **No-go:** any blocker fails or reviewers cannot validate the evidence.
- **Hold:** setup or evidence is incomplete and must be repeated before a decision.
