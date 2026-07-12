# Governed Feedback Flow Troubleshooting

This page is for developers and maintainers diagnosing the four user-visible failure modes in the
governed feedback flow. Each entry follows the repository troubleshooting template and uses stable,
content-free codes.

## Intake is unavailable

| Field             | Value                |
| ----------------- | -------------------- |
| Severity          | High                 |
| Surface           | Workflows / Evidence |
| Stable identifier | `unavailable`        |

**Symptom**

The feedback surface reports `unavailable` and does not offer submission. No receipt is created.

**Root Cause**

The configured intake destination is missing, invalid, or has failed its readiness checks. The local
flow fails closed so a report cannot be sent to an unverified destination.

**Diagnostic Steps**

Use `keiko status` to distinguish a stopped local process from an intake readiness failure. When the
local process is healthy, record the exact `unavailable` outcome shown by the feedback surface and
follow the [operator runbook readiness checklist](../feedback-intake/operator-runbook.md#deployment-boundary-and-readiness).
If the surface offers a receipt or reports `rate-limited`, use the corresponding entry below instead.

**Resolution**

1. Ask the operator to restore or validate the configured intake destination.
2. Restart the local application after configuration changes.
3. Re-open the feedback surface and confirm it reports readiness before preparing a report.

## Intake is rate limited

| Field             | Value          |
| ----------------- | -------------- |
| Severity          | Medium         |
| Surface           | Workflows      |
| Stable identifier | `rate-limited` |

**Symptom**

Submission is refused with the content-free code `rate-limited`. The report remains available for
local editing and no new receipt is returned.

**Root Cause**

The hosted intake service has applied its abuse-resistance policy to the submission window. This is a
service admission decision, not an indication that the report text is unsafe.

**Diagnostic Steps**

Record the exact `rate-limited` outcome from the isolated PostgreSQL #2077 integration test or the feedback
surface's content-free response. Do not resubmit the report to diagnose this state. `unavailable`
indicates a destination/readiness problem; consult that entry instead.

**Resolution**

1. Keep the report local and retain the preview.
2. Ask the operator to inspect rate-control readiness using the
   [operator runbook](../feedback-intake/operator-runbook.md#proxy-forwarding-and-abuse-controls).
3. Do not repeat the submission while diagnosing the incident.

## GitHub publication permission failed

| Field             | Value                |
| ----------------- | -------------------- |
| Severity          | High                 |
| Surface           | Workflows / Evidence |
| Stable identifier | `permission-denied`  |

**Symptom**

A maintainer-approved item cannot be published. The provider failure is `permission-denied`, and the
item enters `manual-reconciliation` with no public issue linkage. The maintainer surface reports
`Publication needs manual reconciliation. Do not repeat the action.`

**Root Cause**

The GitHub App adapter could not prove the configured issue-publication permission and target policy.
The adapter fails closed rather than widening authority or retrying an unverified operation.

**Diagnostic Steps**

Record the exact maintainer message, `permission-denied` failure, and `manual-reconciliation` state, then follow
the [operator runbook publication-readiness checklist](../feedback-intake/operator-runbook.md#github-app-setup-and-publication-readiness).
A `rate-limited` result concerns intake admission and is not a provider permission failure.

**Resolution**

1. Have the repository administrator verify the App installation and its issue-publication policy.
2. Re-run the maintainer readiness check after the policy is corrected.
3. Reconcile the approved item through the maintainer flow; do not create an issue manually from an
   unverified projection.

## Unsafe payload is blocked

| Field             | Value                                             |
| ----------------- | ------------------------------------------------- |
| Severity          | High                                              |
| Surface           | Workflows / Evidence                              |
| Stable identifier | `raw-log-content/unsafe-content/rewrite-required` |

**Symptom**

The preview blocks submission with one of the stable codes `raw-log-content`, `unsafe-content`, or
`rewrite-required`. The flow offers edit, rescan, or omission rather than a bypass.

**Root Cause**

The detector found content that cannot be included in the governed report projection, or a required
field has no safe remainder. Detection and disposition are governed by the [privacy contract](../feedback-intake/privacy-contract.md).

**Diagnostic Steps**

Record the exact content-free blocked outcome shown by the feedback surface. The listed stable code
confirms this entry. `unavailable` or `rate-limited` indicates an intake availability problem instead.

**Resolution**

1. Remove the flagged material from the draft, using placeholders such as `<example>`.
2. Rescan and review the complete preview.
3. Omit an optional unit when the safe remainder is not useful; rewrite a required field when the
   service reports `rewrite-required`.
4. If the content describes a suspected vulnerability, stop and follow [`SECURITY.md`](../../SECURITY.md)
   instead of submitting ordinary feedback.
