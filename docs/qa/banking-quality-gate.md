# Banking Quality Gate

Pull requests targeting `dev` are mergeable only when evidence for the exact current head commit
passes every independent control. Human-review bypasses for the two repository maintainers do not
bypass this technical gate.

The base-controlled `workflow_run` workflow starts only after the protected `CI` workflow completes.
It checks out the repository default branch, never checks out or executes pull-request code, and
rejects triggers that are not bound to the exact head of a pull request targeting `dev`. It publishes
a custom `Banking Quality Gate` check on that untrusted head SHA and reads only GitHub check/review
metadata. This prevents a pull request from weakening the aggregator that evaluates it.

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
