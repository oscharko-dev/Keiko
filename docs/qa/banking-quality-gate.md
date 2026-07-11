# Banking Quality Gate

Pull requests targeting `dev` are mergeable only when evidence for the exact current head commit
passes every independent control. Human-review bypasses for the two repository maintainers do not
bypass this technical gate.

The base-controlled `workflow_run` workflow starts only after the protected `CI` workflow completes.
It checks out the repository default branch, never checks out or executes pull-request code, and
rejects triggers that are not bound to the exact head of a pull request targeting `dev`. It publishes
a custom `Banking Quality Gate` check on that untrusted head SHA and reads only GitHub check/review
metadata. This prevents a pull request from weakening the aggregator that evaluates it.

zizmor classifies every `workflow_run` trigger as dangerous without inspecting whether untrusted
data reaches execution. The trigger has a narrow inline `dangerous-triggers` disposition because
this workflow does not consume triggering-run artifacts, caches, environment files, command-line
values, repository content, or executable input. The only untrusted values are a GitHub-issued PR
number and commit SHA used in authenticated API paths after base-ref and exact-head validation.
Non-PR CI completions are skipped at the job boundary, and CI runs for pull requests not targeting
`dev` exit successfully without publishing a gate. When GitHub omits pull-request metadata for a
fork, the script resolves candidate pull requests from the commit API and still requires the exact
head SHA and `dev` base before publishing a check.

The aggregate requires app-bound success from:

- the repository `ci` job, including typecheck, lint, tests, coverage ratchets, architecture gates,
  and the commit-bound SonarCloud verifier;
- `actionlint` and the pinned-action verifier;
- both CodeQL analyses;
- the release build, scan, SBOM, and smoke job;
- the dependency-diff review and UI gate;
- `zizmor`;
- the risk-scoped `Mutation quality gate`;
- the OSV `Scan dependency lockfiles` job;
- SonarCloud's own analysis check;
- both Socket project and pull-request checks; and
- Gitar.

Gitar's processing check can be green while findings exist. The aggregator therefore also rejects
a current-head Gitar `CHANGES_REQUESTED` review and a current dashboard comment with unresolved
findings. A stabilization window prevents the check from racing ahead of Gitar's review output.

Missing, pending, stale, cancelled, skipped, neutral, timed-out, or app-mismatched evidence never
passes. A new commit receives a new head-bound check and invalidates all prior evidence.
