# Quality-gate canary — 2026-08-01

PR #2878 is the post-migration canary for the repository-owned quality surface introduced by
PR #2876. Evidence below is redacted to immutable heads and check/job identifiers; service
endpoints and finding bodies are omitted.

Its first signed commit, `1069aa9a7a75d7e3e19489a197af4671402de3a0`, deliberately contained a
slower benchmark, policy drift, and a weakened fail-closed comparison. Exact-head negative evidence:

- `CodSpeed policy` rejected the candidate change from 5% to 10% in job 91356603600.
- `CodSpeed Performance Analysis` reported a 51.48% aggregate regression in check 91357704565 and
  bound its comparison to candidate and `dev` SHAs.
- Native Greptile review failed at 3/5 confidence with three P1 findings in check 91356606358.
- Base-owned Greptile settlement independently rejected the evidence in job 91356603731.
- `Core quality` rejected the weakened repository configuration and comparison logic in job 91356603921.

Signed recovery commit `d86f64250b226e815d66756f31b17e2e79f8c502` restored the protected 5%
policy, exact live-settings comparison, and calibrated benchmark workload. `CodSpeed policy` job
91358992913, `CodSpeed Performance Analysis` check 91359719104, native Greptile check 91358998906,
and base-owned Greptile settlement job 91358992919 all passed on that exact head. No failure was
acknowledged and no baseline was changed.

After recovery, branch protection was temporarily expanded from 11 to 14 App-bound contexts.
`Greptile Review` was already the eleventh context; `CodSpeed Performance Analysis` (App 257293),
`CodSpeed policy` (App 15368), and `Greptile findings` (App 15368) were added atomically. All
pre-existing contexts, conversation resolution, signed commits, linear history, and force-push and
deletion protections remained intact.

On later exact head `b56de3aedc364a2ac6f5aa34a06ac5b6ba932efc`, Greptile reported that the
trial account had reached its 50-credit limit and omitted the review. Base-owned settlement failed
rather than accepting stale evidence. This proved that the trial was not durable even before its
calendar expiry. The documented zero-cost rollback therefore ran early: both Greptile contexts were
removed atomically, the organization App was uninstalled, and the repository-owned Greptile config,
validator, tests, and workflow were retired.

The final canary also exposed native CodSpeed comparison variance. Neither
`b56de3aedc364a2ac6f5aa34a06ac5b6ba932efc` nor
`1c10cc44fde5f7695648cb6a708fc38ef6b9e9ef` changed a benchmark or transitive production path, yet
native checks 91361869877 and 91365139527 reported different large regressions. The first explicitly
reported different runtime environments; the second reported a 27.45% prompt-injection regression
while another unchanged benchmark improved 7.3%. The benchmark workflows themselves passed. This
proved the shared-runner verdict could not distinguish candidate cost from environment variance.
`CodSpeed Performance Analysis` was therefore removed from branch protection without acknowledging
a regression, changing a baseline, or relaxing the 5% dashboard policy. It remains advisory;
`CodSpeed policy` remains required. The final protected set contains 11 App-bound checks.

The canary never changes the protected `dev` branch directly, relaxes branch protection, dismisses
a finding, acknowledges a performance regression, changes a baseline, or uses an administrator
bypass. Only the hardened live-value validation, its regression tests, provider rollbacks justified
by exact-head evidence, and redacted evidence remain in the final diff.
