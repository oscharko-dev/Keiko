# Issue #2077 — Closure evidence

This record closes the implementation and audit evidence for the governed feedback flow. It covers
the local report preview, hosted intake and receipt, maintainer authorization and review, and the
fake GitHub App publication boundary. No live provider credential or external publication is used.

## Delivered evidence

| Evidence                        | Repository location                                                                                                                                                                             | Result                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete flow harness           | [`tests/feedback-flow-2077.integration.test.ts`](../../tests/feedback-flow-2077.integration.test.ts)                                                                                            | Five PostgreSQL-backed scenarios pass: happy path, unsafe content, unavailable intake, rate limiting, and provider permission denial.                                               |
| Exact governed projection       | [`tests/feedback-flow-2077-publication.ts`](../../tests/feedback-flow-2077-publication.ts)                                                                                                      | The fake provider operation exactly matches the approved title and body; a configured sensitive canary is absent and the intentional `Bearer` false-positive boundary is preserved. |
| Receipt and maintainer boundary | [`tests/feedback-flow-2077-infrastructure.ts`](../../tests/feedback-flow-2077-infrastructure.ts) and [`tests/feedback-flow-2077-publication.ts`](../../tests/feedback-flow-2077-publication.ts) | Receipt lookup returns only its bounded status projection. Missing session, invalid CSRF, and missing publish permission create no preparation.                                     |
| User and operator guidance      | [`user-guide.md`](user-guide.md), [`operator-runbook.md`](operator-runbook.md), and [`feedback-flow.md`](../troubleshooting/feedback-flow.md)                                                   | Sent and never-sent data, the public GitHub alternative, private security routing, setup, and four failure modes are documented.                                                    |
| Release metadata                | [`release-impact.catalog.json`](../../release-impact.catalog.json)                                                                                                                              | Version `0.2.15` has reviewed `update-notes` metadata under authorization `issue:#2077`.                                                                                            |

## Verification results

The following commands passed in the issue worktree on 12 July 2026:

- `DATABASE_URL=<local-postgresql> npm run test:feedback-flow-2077`: 1 file and 5 tests passed.
- `DATABASE_URL=<local-postgresql> npm test --workspace @oscharko-dev/keiko-feedback-intake -- --run`: 51 files and 365 tests passed.
- `npx vitest run tests/pilot/issue-2077-docs.test.ts`: 1 file and 3 tests passed, including local file and heading-anchor links.
- Root TypeScript no-emit check, targeted ESLint, Prettier, release-impact validation, and `git diff --check`: passed.

The branch verification gate writes a receipt bound to the final child-branch commit. The GitHub
issue and child pull request carry that receipt, the final audit receipt, and the green remote check
results so they cannot be confused with evidence from an earlier revision.

## Audit settlement

The first specialist audit found gaps in public-projection assertions, receipt coverage,
maintainer authorization negatives, documentation accuracy, and duplicate CI build work. Commit
`8a966531` settles those findings. The second read-only security, performance, and pull-request review
reported zero remaining actionable findings. The final SHA-bound audit receipt is generated only
after this closure record is committed and reverified.

## Scope boundary

This evidence proves deterministic local and CI behavior with loopback PostgreSQL and an injected
fake GitHub transport. It does not claim hosted-service availability, GitHub provider approval, a
human release approval, or publication of a real issue.
