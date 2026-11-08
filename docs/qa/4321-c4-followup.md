# Jira report estimate parity and Sonar follow-up (#4321 C4)

Base: `c05e7c952`. All Vitest runs use the isolated `keiko-codex3-c4` Linux container
with `KEIKO_OS_KEYCHAIN=off`; no host test runner or credential store is used.

## Red–green evidence

- `jira-report-estimate-parity.test.ts`: all three new tests failed before the fix
  (Scrum Story Points board with time-only Task screens, Kanban time-only screens,
  and JQL-only). After the fix all three pass with the original estimate in seconds
  and an hours figure. Board configuration does not override an inapplicable screen field.
- `jira-report-estimate-bounds.test.ts`: configuration reads use at most four workers;
  exceeding the existing board item bound yields `metadata-unavailable` without reading
  board configurations.
- The two Golden report cases in
  `grounded-jira-read-repair.public-handler.test.ts` initially failed. The accepted fixture on
  `c05e7c952` includes `timetracking` and an empty board list. This delivery retains those
  tests unchanged: exact figures `10800/3600/7200`, same-turn evidence and citation repair.
- The Activity Log writer/analyzer proof also checks the closed `time-tracking` source;
  field identifiers and names remain absent from the emitted line.

## Parent-type bisect

Container command: `git bisect start bc360a0e0 b762563f1`, then
`git bisect run /tmp/c4-bisect-parent.sh`. The script executes the candidate's actual
`jira-report-parent-types.test.ts` with the repository Vitest configuration. Candidates
without that suite are classified as good; this does not claim that the missing pins ran.

First bad commit: `e9412d6c5d4b86e21e36f90cf8a77131eba95611`.
A separate control transplanted the unchanged suite onto `b762563f1`: 12 of 13 pins failed,
because the native parent-evidence feature and its tests were absent there. The bisect therefore
identifies the introduction of the failing feature/suite, not a previously passing dev suite.
It introduced the suite with 8 failures among 13 tests. The field-catalog projection dropped
valid field IDs when display names were absent, preventing the explicitly selected parent
field from being read. The report also treated an empty required-field rule set as judged.
The fix retains the validated ID as the fallback display name and requires an actual rule
before counting a required-field check as judged. The no-required-fields fixture now carries
only its optional time-tracking field. All 13 parent-type assertions pass unchanged.

Bisect observations: `249c122`, `e93848e`, `fbf6ab1` and `8826bec` lacked the suite;
`71afb8d`, `432378e` and the first bad `e9412d6` each produced the same 8 failures.

## Scope after owner assignment

By owner instruction, the Sonar cleanup in this delivery covers `keiko-connectors`.
General server/contracts refactors were removed; Codex 1 owns those packages. The only
cross-package C4 changes are the closed `time-tracking` estimate source and its serialized
Activity Log proof. The accepted Golden fixture from the base is unchanged.

## Verification

The real analyzer passes with
`KEIKO_LOCAL_SONAR_NODE_MAXSPACE=12288 npm run gates:sonar -- --base c05e7c952`.
All 85 connector files carrying the original 157 findings are included in that diff;
remaining connector findings: **0**. Server/contracts Sonar cleanup belongs to Codex 1.

The complete connector suite was compared with the unchanged base in an isolated shared
clone. The baseline configuration aliases the connector package to that clone's source,
so package imports cannot accidentally execute the delivery's connector implementation.
Both runs use the same Linux dependencies and the same built non-connector packages.

- Base: 34 failed assertions.
- Delivery: 5,445 passed, 26 failed assertions, 5,471 total; no new failed assertion.
- Exactly the eight parent-type failures are removed.
- Both runs also encounter the unchanged BigInt collection error in
  `jira-managed-entity-properties.test.ts`.

These inherited failures are retained, without weakening their pins. The four temporary
role-mutation regressions found during the cleanup were corrected by preserving omission
fallback to the reviewed description; all 66 role-mutation tests pass.

The report regression command is:

```bash
docker exec keiko-codex3-c4 npx vitest run packages/keiko-connectors/src/jira-report \
  packages/keiko-connectors/src/jira-managed-role-mutations.test.ts \
  packages/keiko-server/src/grounded-jira-read-repair.public-handler.test.ts \
  packages/keiko-server/src/atlassian/jiraReportRoutes.test.ts
```

All Vitest commands above execute through `docker exec keiko-codex3-c4`; the original
three new parity tests failed before the implementation, and the two accepted Golden
pins fail against `c05e7c952` before this fix.

Final verification (all tests in the container):

| Command                                                                                    |  Exit | Result                                                                                  |
| ------------------------------------------------------------------------------------------ | ----: | --------------------------------------------------------------------------------------- |
| `npm run build:packages`                                                                   |     0 | Package emits current                                                                   |
| `node node_modules/@typescript/native/bin/tsc -p packages/keiko-ui/tsconfig.json --noEmit` |     0 | UI typecheck                                                                            |
| `npm run typecheck`                                                                        |     0 | Package graph and root typecheck                                                        |
| Report regression command above                                                            |     0 | 349 tests in 18 files                                                                   |
| `npm run test:coverage:ui`                                                                 |     0 | 14,256 passed, 1 skipped                                                                |
| `npm run lint --workspace @oscharko-dev/keiko-ui`                                          |     0 | Zero warnings                                                                           |
| ESLint over the changed C4 report files                                                    |     0 | Zero warnings                                                                           |
| `npm run generate:op-catalog`                                                              |     0 | Generated inventory refreshed                                                           |
| `npm run check:op-catalog`                                                                 |     0 | 97 drift checks                                                                         |
| `npm run check:activity-log`                                                               |     0 | All 7 registered-inventory checks                                                       |
| `npm run arch:check` / `npm run arch:check:negative`                                       | 0 / 0 | Dependency and negative checks                                                          |
| `npm run gates:sonar -- --base c05e7c952`                                                  |     0 | Connector findings 157 → 0                                                              |
| `npx vitest run packages/keiko-connectors/src`                                             |     1 | 26 inherited assertions and inherited BigInt collection error; no new failing assertion |

Prettier and signature/push verification are reported with the delivered head.
No rule suppression, gate relaxation, rebase, force push or integration into `dev` is used.
