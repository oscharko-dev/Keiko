# Feedback Intake

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| Severity          | Medium                                 |
| Surface           | In-app feedback, maintainer review     |
| Stable identifier | `feedback-intake: governed submission` |

## Symptom

Keiko cannot submit feedback, the preview reports an unsafe payload, a maintainer cannot create a
GitHub Issue, or an intake item remains blocked in review.

## Root Cause

The feedback flow is fail-closed. Submission requires redaction provenance, bounded payload size, and
an available intake service. GitHub Issue creation additionally requires maintainer approval and a
configured GitHub App adapter.

## Diagnostic Steps

1. Confirm the user reviewed the redacted preview before submission.
2. Check whether the response code is `FEEDBACK_MISSING_REDACTION_PROVENANCE`,
   `FEEDBACK_UNSAFE_PAYLOAD`, `FEEDBACK_PAYLOAD_TOO_LARGE`, `FEEDBACK_INTAKE_UNAVAILABLE`, or
   `FEEDBACK_GITHUB_UNAVAILABLE`.
3. For GitHub Issue creation, confirm the intake item is `approved-for-github`.
4. Confirm the GitHub App installation and repository allowlist are configured in the deployment.

## Resolution

- Rebuild the feedback preview if redaction provenance is missing.
- Remove optional sections or attachment previews when the payload is too large.
- Route suspected vulnerabilities to GitHub Security Advisories instead of general feedback.
- Configure the intake service and GitHub App adapter before enabling maintainer issue creation.

Do not paste API keys, customer data, internal endpoint URLs, or unredacted logs into troubleshooting
comments or public issues.
