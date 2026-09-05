# Verified commit browser evidence (#3386)

This lane uses the built UI, mounted production runtime/review/approval routes, a real temporary Git
repository and managed worktrees. The fixture composes `createProductionVerifiedCommitDependencies`
with the actual BFF settings, workspace, dirty-buffer checks, verification evidence and snapshot store.
It invokes the real run's authenticated tool facade; browser approval uses the existing approval
panel. It does not issue approval claims or create a second authority store.

The OpenCode supervisor and model responses are deterministic functional fixtures. This lane opts
into executing the exact repository-generated tool shims in an isolated Node VM with the child's
environment and real facade transport. It evaluates no model- or workspace-supplied source. The
fixture implements only the upstream permission queue: generated edit/verification asks reach the
real UI and manager, and the generated proof is forwarded only after their decision. No digest
formula is copied into the fixture.

The fixture edits a synthetic source constant, proposes and executes its staging through the real
Git facade, and executes the real `node --check src/example.ts` verification command. Ask mode must
receive separate edit, staging and verification approvals through the existing panel. Supervised
and Full access perform these routine operations inside their validated authority. Its file control channel selects
proposal, execution and completion steps while the scripted final model response waits. This
channel exists only in the test server and cannot approve a proposal. The mounted Stop route closes
any still-active controlled run; either a preceding child completion or explicit cancellation is a
valid cleanup outcome. These are production-composed functional checks, not live-model completion
qualification, published GitHub delivery or a release attestation. The receipts record
`modelQualification: false`.

## Reproduce

```sh
npm run test:e2e:coding-issue-commit
```

The command builds the packages and static UI, compiles the fixture server, pairs Chromium through
the existing launcher attestation route and runs the journey. The tests share a single real runtime
and run serially; a failure stops the remaining scenarios so an unfinished run cannot contaminate
later results. Generated evidence defaults to gitignored `test-results/e2e-evidence/`. Refresh the
tracked artifacts deliberately:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-issue-commit
```

The configured fixture port must be available; use `KEIKO_E2E_UI_PORT` for an isolated concurrent run.

## Receipts

- `visual-proof.json` records screenshot hashes, exact UI source hashes, actual browser axe findings
  and horizontal-overflow checks for seven canonical modes plus a 360-pixel compact window. Captures
  show the pending reviewed commit, including plain-text message and expanded exact binding facts.
- `journey-proof.json` is emitted only after all six scenarios finish. Successful scenarios cover all
  three autonomy modes, the unpaired review refusal, pre-approval execution refusal, actual approval,
  one exact commit, receipt restoration after reload and duplicate-execution refusal. Other scenarios
  cover dirty worktree rejection, candidate drift after review, and explicit UI denial. It also checks
  correlated commit activity logging and absence of fixture source/message bodies from the log.

Screenshots contain synthetic fixture text and temporary repository paths. No customer content is
used. Source hashes identify the actual UI bytes measured, including development changes that have
not yet been committed. Changed source bytes require renewed evidence before a release claim.
