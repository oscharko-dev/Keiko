# Issue #2077 — Governed feedback-flow verification matrix

This matrix is for maintainers and release reviewers verifying the governed feedback flow across
the local report, hosted intake, maintainer review, and GitHub Issue publication boundaries. It
records repeatable checks and points to the contracts that define expected behaviour; it does not
duplicate those contracts.

## Verification scope

The flow is complete only when the local preview remains the submitted canonical projection, unsafe
content is stopped, an accepted report can be checked with its receipt, publication remains a
maintainer action, and the private security route remains available for suspected vulnerabilities.

| Area                | Verification                                                                          | Expected result                                                                                                            | Normative reference                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local intake        | Preview, edit, rescan, and submit a safe placeholder report                           | Preview and submission use the same approved projection; edits invalidate the previous approval                            | [Privacy contract — canonical projection](privacy-contract.md#d4---preview-and-every-destination-use-one-canonical-sanitized-projection)                                                    |
| Unsafe content      | Submit a report containing a placeholder unsafe marker, then remove or rewrite it     | Intake blocks the report and offers rewrite or omission; no bypass is offered                                              | [Privacy contract — detection and disposition](privacy-contract.md#d2---detect-and-dispose-without-retaining-source-content)                                                                |
| Hosted intake       | Submit the approved projection and query its receipt                                  | The caller receives only the bounded receipt result; report content is not returned                                        | [Privacy contract — hosted intake](privacy-contract.md#hosted-intake-and-review-contract)                                                                                                   |
| Rate control        | Run the hermetic #2077 integration test with its fake policy response                 | The test records `rate-limited` without repeating a submission or creating a public issue                                  | [`tests/feedback-flow-2077.integration.test.ts`](../../tests/feedback-flow-2077.integration.test.ts)                                                                                        |
| Maintainer review   | Open an accepted item as a maintainer and prepare, approve, and reconcile publication | State transitions follow the closed review contract; approval is required before publication                               | [Review state contract](review-state-contract.md)                                                                                                                                           |
| GitHub App boundary | Run the provider permission and target-policy checks with the configured test adapter | Missing or broader-than-allowed permissions fail closed with content-free `unavailable` and the manual-remediation message | [Privacy contract — GitHub publication](privacy-contract.md#d8---create-github-issues-only-after-review-through-a-dedicated-github-app-adapter)                                             |
| Security routing    | Enter a suspected vulnerability in the feedback surface                               | The flow stops and routes the reporter to [`SECURITY.md`](../../SECURITY.md); details do not enter ordinary feedback       | [Threat model — private vulnerability process](threat-model.md#assets-and-actors)                                                                                                           |
| Evidence            | Run the focused documentation test and release-impact check                           | Documentation links, stable codes, release wording, and catalog shape are verified                                         | [`tests/pilot/issue-2077-docs.test.ts`](../../tests/pilot/issue-2077-docs.test.ts)                                                                                                          |
| Integrated flow     | Run the governed-flow integration test with its support harness                       | Exact prepared bytes and fail-closed negative cases are checked when the integration database is available                 | [`tests/feedback-flow-2077.integration.test.ts`](../../tests/feedback-flow-2077.integration.test.ts) and [`tests/feedback-flow-2077-support.ts`](../../tests/feedback-flow-2077-support.ts) |

## Release-review checklist

For the authorized `issue:#2077` review, run the focused test, `npm run check:release-impact`,
`npx prettier --check docs/feedback-intake/2077-verification-matrix.md docs/troubleshooting/feedback-flow.md docs/troubleshooting/README.md tests/pilot/issue-2077-docs.test.ts`,
and `git diff --check`. Record command output in the issue or pull request. The catalog entry records
the authorized review reference; this is not a claim of a GitHub PR review or publication approval.

## Out-of-scope claims

This matrix does not claim hosted-service availability, provider approval, or human release approval.
Those facts require the corresponding operator evidence and review records described by the linked
contracts.
