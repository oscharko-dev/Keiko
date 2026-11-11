# Server mutation and Memory startup follow-up — #4321 / PR #4288

This delivery starts at `4f23d5ed4` and integrates feature-branch head `29b3857fc` without conflicts. All Vitest runs use the isolated Linux container
`keiko-codex3-c4`, then `keiko-codex3-c4-recovery`, Node 24.18.0, with OS Keychain access disabled.
After the machine-load instruction the verification container is limited to at most four CPUs,
reduced to two CPUs for recovery and delivery. Subsequent heavy checks require a passing
headroom check and run sequentially with at most four Vitest workers. No host Vitest,
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

The broad run also exposed two related pin conflicts. The PR had replaced the dev terminal
identity assertion in `actionOutcomeActivity.test.ts` with a generic class. Its legacy inputs
now retain the exact dev assertion; separately, expanded PR read inputs retain the bounded
class. Digest, content exclusion and reconstruction assertions remain. The PR-only
`httpPrivateIdentity.journal.test.ts` expected a settled result to become pending after recovery.
It now pins the exact stored outcome and replay marker before and after re-admission, without
a private actor receipt, executor call or extra native write. These 17 cases and unchanged
write-route controls pass together: 275 tests, exit 0.

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

The merged Codex 4 permission-scheme test needed explicit non-null fixture references for
strict TypeScript. Its assertions are unchanged.

All existing Memory migration SQL, versions and ordering are unchanged. UI-store migrations
v62–v77 are unchanged.

## Completed measurements and remaining Server failures

The combined package sweep passes 5,638 Connector tests and 262 Memory-vault tests. The additional
Security sweep exposes nine inherited failures in `macos-keychain-withheld`,
`secret-vault.resolve-once` and `secret-vault`; unchanged `4f23d5ed4` source reproduces all nine.
Four depend on the lane's explicit keychain-withheld environment; five concern the pre-existing
secret-vault path/refusal contract. Affected kernel-lock/CAS and OAuth/credential tests pass.

UI coverage passes 14,269 tests with one skip in 726 files. The original nine-case updater
producer also passes, including real BFF stop/restart; its unchanged freshness check passes.
The recovery producer passes all nine cases in 2.2 minutes, regenerates all 17 artifacts, and
its 14 captures were visually inspected. The Editor release-evidence checker passes against
the rebuilt export without changing its numerical budget.

The final whole Server sweep uses `--maxWorkers=4 --pool=forks` under the four-CPU ceiling.
It reports 946 failed, 33,965 passed and 314 skipped tests over 1,317 files, with one worker OOM
in the reserved `jiraManagedMutationIntegration` file. No final JSON is produced by that run.
The entire suite is not repeated: only the aborted file runs again in four disjoint name groups,
with one worker and JSON output. All 835 unique names are covered exactly once, with no missing
or overlapping cases: 829 fail and six pass. The 17 terminal/private-journal pin conflicts above
pass in their targeted follow-up.

The combined receipt therefore contains **937 failed tests in 20 files**, 33,983 passed and
314 skipped (35,234 tests), plus one Draft suite setup error that leaves 26 tests skipped.
This is a combined measurement, not a claim of a second whole-suite run or a green PR.
The remaining failures belong to the reserved Codex 2 scope (885), Draft/Grounding owned by
Codex 1 (29), and container-boundary failures (23). The additional `postApplyVerification`
container failure reproduces identically on untouched dev `b762563f1`: 11 pass, one fails,
exit 1. Its pin is unchanged.

| Remaining Server file                                         | Failed tests | Suite setup error |
| ------------------------------------------------------------- | -----------: | ----------------- |
| `atlassian/jiraChatAuthority.test.ts`                         |           32 | no                |
| `atlassian/jiraChatToolTurn.test.ts`                          |            1 | no                |
| `atlassian/jiraDraftBatchTool.test.ts`                        |           28 | no                |
| `atlassian/jiraDraftInputContract.test.ts`                    |            0 | yes               |
| `atlassian/jiraEmailTemplateDescriptors.test.ts`              |            4 | no                |
| `atlassian/jiraEntityPropertyMutationDescriptors.test.ts`     |            1 | no                |
| `atlassian/jiraManagedMutationIntegration.test.ts`            |          829 | no                |
| `atlassian/jiraMonitoringDescriptors.test.ts`                 |            4 | no                |
| `atlassian/jiraVersionLinkMutationDescriptors.test.ts`        |            1 | no                |
| `chat-tool-runtime.test.ts`                                   |            1 | no                |
| `coding-runtime/codingJiraCatalog.test.ts`                    |            7 | no                |
| `coding-runtime/productionOpenCodeBackend.functional.test.ts` |            1 | no                |
| `coding-runtime/secureWorkspaceTextRead.test.ts`              |           16 | no                |
| `deps.test.ts`                                                |            1 | no                |
| `editor/postApplyVerification.test.ts`                        |            1 | no                |
| `editor/verificationExecution.test.ts`                        |            3 | no                |
| `editor/verificationRuntimeTarget.test.ts`                    |            1 | no                |
| `gitChangeSnapshotService.test.ts`                            |            1 | no                |
| `grounded-jira-mixed.public-handler.test.ts`                  |            1 | no                |
| `store/chatJiraBinding.test.ts`                               |            1 | no                |
| `tool-catalog/catalogNonCodingConsumer.test.ts`               |            3 | no                |

## Worktree recovery

After the successful assembled package-surface check, the active worktree disappeared together
with its Git registration. Signed commits and verification receipts remained available. The
replacement detached worktree is locked. Its 48 analyzed text files were recovered from the
successful local Sonar source snapshot; source formatting removes the API's extra terminal
newline. UI sources match the signed checkpoint byte for byte. Generated registries and updater
evidence are rebuilt by their original producers. No whole Server or UI coverage sweep is repeated
for this recovery; relevant regression and type checks qualify the recovered source.

## Final verification

Commands below run inside the isolated container unless they invoke the host-side governor or
the container-owning Sonar wrapper. Vitest uses `--maxWorkers=4 --pool=forks` after the machine-load
instruction; the four matrix partitions use one worker. The complete Server sweep runs once.
The two catalog dependencies above and the explicitly excluded environment suites are not
represented as repaired here.

| Command / scope                                                                            |   Exit | Measured result                                                                                                                      |
| ------------------------------------------------------------------------------------------ | -----: | ------------------------------------------------------------------------------------------------------------------------------------ |
| Assigned dev controls on `b762563f1`                                                       |      0 | 166 passed; unchanged dev pins                                                                                                       |
| Red-first Memory, ended-turn replay and actor-character controls                           |      1 | Each fails before its repair; detailed cases above                                                                                   |
| Assigned repaired server/storage regression selection                                      |      0 | 2,631 passed                                                                                                                         |
| Recovery `npx vitest run` over the nine affected regression files                          |      0 | 859 passed                                                                                                                           |
| Recovery targeted UI Vitest, four files                                                    |      0 | 50 passed                                                                                                                            |
| `npm run test:coverage:ui`                                                                 |      0 | 14,269 passed, one skipped                                                                                                           |
| Combined Connector / Memory / Security Vitest sweep                                        |      1 | Connector 5,638 passed; Memory 262 passed; Security 1,552 passed and nine inherited failures, all nine reproduced on the actual base |
| Whole Server Vitest sweep                                                                  |      1 | 946 failures and one worker OOM; completed and corrected by the disjoint/targeted measurements above                                 |
| Four disjoint managed-mutation partitions                                                  | 1 each | All 835 names measured exactly once; 829 failed, six passed                                                                          |
| Terminal outcome / private journal / unchanged write-route follow-up                       |      0 | 275 passed; combined residual Server count is 937 plus one suite setup error                                                         |
| `postApplyVerification` unchanged dev control                                              |      1 | Identical container failure; 11 passed, one failed                                                                                   |
| `npm run build:packages` immediately before delivery                                       |      0 | Recovered package graph builds                                                                                                       |
| `npm run typecheck` immediately before delivery                                            |      0 | Root/package type checks pass                                                                                                        |
| `node node_modules/@typescript/native/bin/tsc -p packages/keiko-ui/tsconfig.json --noEmit` |      0 | UI type check passes                                                                                                                 |
| ESLint on all touched non-UI TypeScript, `--max-warnings=0`                                |      0 | No warnings                                                                                                                          |
| `npm run lint --workspace @oscharko-dev/keiko-ui`                                          |      0 | No warnings                                                                                                                          |
| `npm run check:error-observability`                                                        |      0 | Explicit typed error rethrows are recognized; no suppression                                                                         |
| `npm run generate:op-catalog`; `npm run check:op-catalog`                                  | 0 each | Generated closed operation inventory matches source                                                                                  |
| `npm run check:activity-log`                                                               |      0 | All seven implementation-gate stages pass, including architecture and negative controls                                              |
| `npm run gates:sonar -- --base 29b3857fc`                                                  |      0 | Real local analyzer: zero findings in this delivery's analyzed diff                                                                  |
| `npm run check:package-surface:assembled`                                                  |      0 | Repeated successfully after worktree recovery                                                                                        |
| `KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:update-ui-1696`                           |      0 | Nine unchanged browser cases passed                                                                                                  |
| `npm run check:update-ui-evidence`                                                         |      0 | Current source/harness fingerprints                                                                                                  |
| `npm run check:editor-release-evidence`                                                    |      0 | Actual rebuilt export; existing budget unchanged                                                                                     |

The final `prettier --check` exits 0 across all 61 changed supported text files, including
`packages/keiko-ui/src/app/components/desktop/chat-processing-pipeline.ts`. The source recovery
comparison covers all 48 analyzed TypeScript files, with zero hash differences after normalizing
only the Sonar API's extra terminal newline. The final delivery includes the regenerated
operation emitter name, not a hand-edited catalog digest.
