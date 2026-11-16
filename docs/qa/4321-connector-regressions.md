# Connector regression follow-up (#4321)

Base: `c8ebf090526c63f5c1c12d391fc36caec59f4a26`. All tests run in the isolated
`keiko-codex3-c4` Linux container with `KEIKO_OS_KEYCHAIN=off`. No host Vitest,
credential-store access, authority change or guard relaxation is used.

## Dev control and bisect

The first test run uses the actual `b762563f1` source in an independent shared clone:
`jira-requirement-trace.put.test.ts` and `jira-field-metadata.test.ts` pass all 139 tests.
On the delivery base those suites have 141 tests and seven failed assertions.
Five are regressions in conversion evidence for unchanged native values; the other two
are PR assertions conflicting with the accepted dev image and quoted-source contracts.

A failure-specific bisect of the native-value assertions identifies
`432378e066f3fe4a7adc3a311f216f5d5c5f18a1` as the first bad commit. It merges the
dev canonical `jira-markdown-wiki.ts` into the feature's independently implemented file
and routes all Data Center descriptions through the projection, while retaining an
unconditional `descriptionProjection` marker. Unchanged native values therefore falsely
claim conversion. The fix belongs in `jira-field-metadata.ts`: emit the existing marker
only for explicit Markdown or an actual rewrite. The canonical renderer stays shared.

The bisect runs candidate connector source through a Vitest alias and builds that
candidate's contracts, security and Activity Log dependencies. It does not execute stale
connector output. Good observations: `c9a9b2999`, `9fce3ec`, `917a978`, `e9412d6`.
Bad observations: `575997e`, `741e58`, `432378e` (the same five native-evidence failures).
An earlier whole-suite bisect found transient formatting failures at `893761fa7`;
those had already been repaired before the current regression, so they are not attributed
to this fix. Direct controls on `c5b2e7e5b^` and `c5b2e7e5b` both produce the same
141 tests and seven failures. The literal-identifier underscore fix is retained.

## Per-file diagnosis and red–green evidence

All original dev preservation assertions remain. A changed PR quote assertion is restored
to the exact dev value. Corrections to other PR-owned fixtures retain their semantic pins
and, where useful, add exact structural or request assertions.

| File in `packages/keiko-connectors/src/`          | Cause                                                                                                 | Fix                                                                                                                    | Red → green                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `jira-requirement-trace.put.test.ts`              | False conversion evidence on native lists; PR changed literal quoted source to quote macros           | Fix evidence in field owner; restore dev quote pin; add exact Context/acceptance-criteria wiki PUT with trace          | 2 failed → 16 passed          |
| `jira-field-metadata.test.ts`                     | False conversion evidence on four unchanged native values; PR rejected an image supported by dev      | Fix evidence in field owner; assert exact native image output; add oversized-projection refusal without partial fields | 5 failed → 127 passed         |
| `jira-template-native-evidence.test.ts`           | Eight formal fixtures used the nonexistent `labelsPattern` key and never reached their assertions     | Use the registered `labelPattern`; retain all unknown-label and replacement assertions                                 | 8 failed → 40 passed          |
| `jira-managed-notification-schemes.test.ts`       | Whole-result text search matched the legitimate description “Team notifications”                      | Check absent event/recipient properties structurally and retain the readable description                               | 2 failed → 44 passed          |
| `jira-request-body.test.ts`                       | Pin expected generic unavailability for a current-authority denial                                    | Assert the precise `effect-denied` result, one admission check and zero HTTP calls                                     | 2 failed → 20 passed          |
| `jira-managed-directory-access-mutations.test.ts` | Claimed complete membership pages lacked the required `isLast` evidence                               | Supply complete native pages; retain both inherited-membership outcomes and exact reads                                | 2 failed → 63 passed          |
| `jira-bulk-create-preparation.test.ts`            | Ambiguous native `##` text incorrectly claimed Markdown provenance                                    | Use the advertised explicit Markdown value; retain exact wiki and trace payloads                                       | 1 failed → 6 passed           |
| `jira-directory-self-access.test.ts`              | Mock returned user expansion for the independent group-membership read too                            | Provide and assert the distinct complete disjoint membership page and both reads                                       | 1 failed → 9 passed           |
| `jira-managed-screen-configuration.test.ts`       | Stale-order fixture omitted the field page needed for the complete snapshot                           | Supply the field page; retain stale-state refusal and zero effects                                                     | 1 failed → 59 passed          |
| `jira-managed-search-post.test.ts`                | Numeric custom-field fixture lacked the recognized native custom type                                 | Supply the native float type; retain exact typed zero, query, fields, cursor and URL assertions                        | 1 failed → 11 passed          |
| `jira-managed-version-link-mutations.test.ts`     | Assertion treated an omitted HTTP method as a write, although the request contract defaults it to GET | Apply that default in the assertion and pin all four native read paths                                                 | 1 failed → 57 passed          |
| `jira-managed-entity-properties.test.ts`          | Vitest `%j` title serialization threw on BigInt before collecting the suite                           | Use the case index in titles; retain BigInt and every non-JSON refusal                                                 | Collection error → 154 passed |

ADR-0128 now describes the accepted dev renderer rather than the superseded parallel
strict parser. No production schema, parser, bounds or request admission rule is widened.

## Final verification

Complete connector result: **5,627 passed, zero failures, 159 files**, including all 154
previously uncollected entity-property tests and two additional description regressions.
The 26 inherited assertion failures and BigInt collection failure are removed.
Formatting the touched PR suites also exposes their existing lint debt; explicit return
types, real Promise-returning mocks and a smaller metadata-fixture dispatcher repair it
without rule suppression or changed test semantics.

Except for the host Sonar wrapper (which starts the analyzer container), these commands
execute through `docker exec -w /repo keiko-codex3-c4`. The base control uses
`/tmp/c3-inherited-dev` in the same container and builds its own candidate package output.

| Command                                                                                                                                                                                                                                                            |  Exit | Result                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----: | ------------------------------------------------------------------------------------- |
| Two description suites on dev `b762563f1`                                                                                                                                                                                                                          |     0 | 139 passed                                                                            |
| Same two suites on base `c8ebf0905`, before the fix                                                                                                                                                                                                                |     1 | Seven failing assertions, 141 tests                                                   |
| Same suites on `c5b2e7e5b^` / `c5b2e7e5b`                                                                                                                                                                                                                          | 1 / 1 | Identical seven failures, 141 tests each                                              |
| `npx vitest run packages/keiko-connectors/src/jira-field-metadata.test.ts packages/keiko-connectors/src/jira-requirement-trace.put.test.ts packages/keiko-contracts/src/jira-markdown-wiki.test.ts packages/keiko-contracts/src/jira-description-sections.test.ts` |     0 | 308 passed                                                                            |
| Ten remaining affected connector suites                                                                                                                                                                                                                            |     0 | 463 passed                                                                            |
| `npx vitest run packages/keiko-connectors/src --reporter=json --outputFile=/tmp/c3-connectors-delivery.json`                                                                                                                                                       |     0 | 5,627 passed; zero assertion or collection errors                                     |
| `npx vitest run packages/keiko-server/src/grounded-jira-read-repair.public-handler.test.ts packages/keiko-server/src/atlassian/jiraReportRoutes.test.ts`                                                                                                           |     0 | 26 passed, including both accepted Golden report pins                                 |
| `npm run build:packages`                                                                                                                                                                                                                                           |     0 | Current package output                                                                |
| `node node_modules/@typescript/native/bin/tsc -p packages/keiko-ui/tsconfig.json --noEmit`                                                                                                                                                                         |     0 | UI typecheck                                                                          |
| `npm run typecheck`                                                                                                                                                                                                                                                |     0 | Package graph and root typecheck                                                      |
| ESLint `--max-warnings=0` on all touched TypeScript files                                                                                                                                                                                                          |     0 | Zero warnings                                                                         |
| `npm run lint --workspace @oscharko-dev/keiko-ui`                                                                                                                                                                                                                  |     0 | Zero warnings                                                                         |
| Prettier `--check` on every touched file and `packages/keiko-ui/src/app/components/desktop/chat-processing-pipeline.ts`                                                                                                                                            |     0 | Formatting passes                                                                     |
| `npm run generate:op-catalog`                                                                                                                                                                                                                                      |     0 | No generated inventory drift                                                          |
| `npm run check:activity-log`                                                                                                                                                                                                                                       |     0 | All seven checks, including op-catalog, scenarios, architecture and negative fixtures |
| `KEIKO_LOCAL_SONAR_NODE_MAXSPACE=12288 npm run gates:sonar -- --base c8ebf0905`                                                                                                                                                                                    |     0 | Real analyzer; zero unresolved findings on changed connector files                    |

An additional seven-suite run covers the two Golden suites, both shared Markdown suites,
`codingJiraPodMcp.test.ts`, `jiraChatMutation.test.ts` and `jiraTemplateEnforcement.test.ts`.
It exits **1**: 413 passed, 306 failed. The Coding suite's 77 tests and both Markdown
suites pass. An independent control on unchanged `c8ebf0905` reproduces exactly the same
306 failed assertion identities: 23 in `jiraChatMutation.test.ts`, 283 in
`jiraTemplateEnforcement.test.ts`; **zero new failures**. These server suites are outside
the assigned connector cleanup and remain with the server owner. Their failures are not
hidden by the green connector total or changed in this delivery.

The delivered signed head and push exit code are reported after the push. No rebase,
force push, merge from `dev` or integration into `dev` is used.
