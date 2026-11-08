# Server mutation and Memory startup follow-up — #4321 / PR #4288

This delivery starts at `4f23d5ed4`. All Vitest runs use the isolated Linux container
`keiko-codex3-c4`, Node 24.18.0, with OS Keychain access disabled. No host Vitest,
HOME override, schema rewrite, rebase or dev integration is involved.

## Baseline and bisect

The four assigned dev-regression suites pass unchanged on `b762563f1`: 166 tests,
exit 0, after that checkout's package build. On the PR base they contain 173 tests,
with five failures. The other eleven assigned server suites contain 2,520 tests,
with 393 failures. These are measured baselines, not estimates from the issue list.

Candidate runs resolve workspace exports to each candidate's actual source. This avoids
misidentifying a regression through stale compiled packages. A missing test or collection failure
is never counted as a passing bisect candidate.

| Regression                                             | First bad commit                           | Owning cause                                                                                         |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| OAuth credential custody and two route vocabulary pins | `1674409911aaf27a1db80f850c1ae4c5a8d7a047` | A nested guard directory violated the flat custody layout; the registered route literal was omitted. |
| `store/chatJiraBinding`                                | `fdcfd7a69f95aa3946625a2e3df81ed2bfec00ca` | The current Jira descriptor rejects the historical result shape in the unchanged dev proof.          |
| `deps` lazy Jira graph                                 | `fdcfd7a69f95aa3946625a2e3df81ed2bfec00ca` | The graph catalog no longer has every canonical handler expected by the unchanged dev proof.         |

The latter two causes cross the explicit Codex 2 catalog/descriptor boundary. This change does
not alter their dev pins, weaken result validation, or offer additional tools to the model to
manufacture a passing count. They remain separately identified integration dependencies.

## Assigned server fixes

| File                                               | Measured failures before | Cause and repair                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -----------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp/mcpOAuthCredentialStore.test.ts`              |                        1 | Keep stable kernel guard databases flat in the existing custody directory. Cross-process ownership and release assertions remain.                                                                                                                                      |
| `observability/route-template.test.ts`             |                        2 | Register the closed `human-inputs` route literal. Dynamic route redaction stays unchanged.                                                                                                                                                                             |
| `atlassian/credentialRoutes.test.ts`               |                        1 | Same flat guard ownership repair.                                                                                                                                                                                                                                      |
| `atlassian/jiraTemplateEnforcement.test.ts`        |                      283 | Do not resolve private Chat context when no private-port factory exists. Restore the acceptance-criteria whitespace assertion to its exact dev value.                                                                                                                  |
| `atlassian/jiraAuthenticationObservation.test.ts`  |                       55 | Construct canonical synthetic native URLs with one separator. Pin encoded-slash refusal before dispatch separately; do not expand the product authentication exceptions.                                                                                               |
| `atlassian/jiraChatMutation.test.ts`               |                       23 | Exact durable outcomes can replay after recovery ends a turn. Correct PR-only replay assertions to the existing outcome-only journal contract; full first-execution private receipts and no-repeat effects remain pinned.                                              |
| `atlassian/jiraOperationTransport.test.ts`         |                       18 | Independent fixture routes must cover the int64 workflow confirmation variants and canonical actor identity. Raw native receipts precede managed browse-URL presentation. Preserve a readable remote-link snapshot while proving no foreign-origin request follows it. |
| `atlassian/jiraSavedConfigurationReceipts.test.ts` |                        3 | Reject control characters in actor identity at the shared connector value boundary. Assert the entire safe timeout result when a malformed inherited receipt is dropped.                                                                                               |
| `atlassian/jiraRelationLifecycleReceipts.test.ts`  |                        1 | Same connector actor identity boundary; its pins are unchanged.                                                                                                                                                                                                        |
| `atlassian/writeActionRoutes.test.ts`              |                        3 | Preserve the closed legacy action identity on the existing terminal action-outcome line. General authority classification retains its existing vocabulary. Its dev pins are unchanged.                                                                                 |
| `store/jiraOperationMigration.test.ts`             |                        4 | Run the original V63 rejection assertions against production migrations through V63. V77 legitimately admits those later actions. No migration or rejection assertion changed.                                                                                         |
| `atlassian/jiraOperationActivity.test.ts`          |                        1 | Correct the PR inventory to include the already restored local `jira.draft-batch`: three local reads and four composites. Native count, uniqueness, complete coverage and field bounds stay pinned.                                                                    |
| `atlassian/jiraAvatarComposition.test.ts`          |                        1 | Use the advertised `Uint8Array` image input rather than a Vitest-specific Buffer comparison. Byte and authority assertions remain.                                                                                                                                     |

The journal fix has an additional red-first proof on the actual base: settle an uncertain result,
end the original turn, then replay the matching identity without redispatch. A changed actor or a
new mutation remains refused, without a new record. Private receipts stay in the existing private
transcript; no journal columns or receipt store were added (ADR-0128).

The connector text rule has a seeded property proof which fails on the actual base and passes
with the repair. Every run injects all 65 Unicode control codes, including TAB, CR and LF, into
valid bounded Unicode actor words. The test has an exercised-input count and a shrinking input;
it does not filter away the rejected cases. General JSON/prose content retains its existing rule.

Fixture dispatcher refactoring and explicit return types address the touched files' inherited
lint findings without suppressing a rule or changing their assertions.

## Memory startup

The storage owner classifies non-corruption open/migration errors as
`MemoryStorageError("vault-migration-failed")`. It uses fixed text without SQL or an underlying
exception cause. The existing transaction rolls back and the open owner closes the handle;
corruption retains its existing quarantine owner. A newer schema gets the same closed code.
`deps` withholds only the two known Memory storage codes and propagates unrelated exceptions.

The health projection is additive: server `status: "ok"`, Memory `readiness: "withheld"`, and a
closed reason. The footer status and workspace notice explain the cause while Chat remains
available. The Memory unavailable formatter asks for repair/restart, not a transient retry.
English and German, both withholding reasons, invalid wire projections and response correlation
preservation have targeted UI coverage.

`memory-vault.store.open-failed` uses the existing failure class and log sink. Only closed phase
and reason fields are emitted. The operation catalog and failure inventory are generated from
source declarations. ADR-0035 and ADR-0173 describe the same behavior.

| Red-first proof                                                                  | Before                                                            | After targeted repair                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Broken v12 through direct migration and open; newer schema                       | exit 1, three failing cases                                       | exit 0; fixed code/message, unchanged version/rows/schema, handle closed, no quarantine      |
| Existing directory cannot be opened as a database (actual base control)          | exit 1                                                            | exit 0; existing path retained                                                               |
| Graph startup: classified failure and real broken v12; foreign TypeError control | exit 1, two failures and passing TypeError control on actual base | exit 0; Memory absent, closed readiness/diagnostic, Health 200 and a real Chat handler reply |
| Memory notice, footer and formatter                                              | exit 1, three new UI cases                                        | exit 0; expanded targeted UI matrix: 50 tests                                                |
| Ended-turn journal replay (actual base control)                                  | exit 1                                                            | exit 0; no new dispatch and no identity widening                                             |
| Actor control-character property (actual base control)                           | exit 1                                                            | exit 0; all control codes exercised                                                          |

All existing Memory migration SQL, versions and ordering are unchanged. UI-store migrations
v62–v77 are unchanged.

## Final verification

Final command exit codes and the measured residual server-suite failures are recorded with the
delivery after the complete implementation and integration checks. The two catalog dependencies
above and the explicitly excluded environment suites must not be represented as repaired here.
