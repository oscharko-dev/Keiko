# Quality-gate canary — 2026-08-01

This pull request is the post-migration canary for the repository-owned quality surface introduced
by #2876. Its first signed commit, `1069aa9a7a75d7e3e19489a197af4671402de3a0`, deliberately
contained a slower benchmark, policy drift, and a weakened fail-closed comparison. The exact-head
negative evidence was:

- `CodSpeed policy` rejected the candidate change from 5% to 10%
  ([job 91356603600](https://github.com/oscharko-dev/Keiko/actions/runs/30695136576/job/91356603600)).
- `CodSpeed Performance Analysis` reported a 51.48% aggregate regression and bound its comparison
  to the candidate and `dev` SHAs
  ([check 91357704565](https://github.com/oscharko-dev/Keiko/runs/91357704565)).
- `Greptile Review` failed at 3/5 confidence with three P1 findings
  ([check 91356606358](https://github.com/oscharko-dev/Keiko/runs/91356606358)); its exact-head
  [summary](https://github.com/oscharko-dev/Keiko/pull/2878#issuecomment-5150973232) records the
  complete changed-file inventory.
- The base-owned `Greptile findings` context independently rejected that evidence
  ([job 91356603731](https://github.com/oscharko-dev/Keiko/actions/runs/30695136580/job/91356603731)).
- `Core quality` rejected the weakened repository configuration and comparison logic
  ([job 91356603921](https://github.com/oscharko-dev/Keiko/actions/runs/30695136614/job/91356603921)).

Signed recovery commit `d86f64250b226e815d66756f31b17e2e79f8c502` restored the protected 5%
policy, exact live-settings comparison, and calibrated benchmark workload. `CodSpeed policy`
([job 91358992913](https://github.com/oscharko-dev/Keiko/actions/runs/30696038720/job/91358992913)),
`CodSpeed Performance Analysis`
([check 91359719104](https://github.com/oscharko-dev/Keiko/runs/91359719104)), native Greptile
([check 91358998906](https://github.com/oscharko-dev/Keiko/runs/91358998906)), and base-owned
Greptile settlement
([job 91358992919](https://github.com/oscharko-dev/Keiko/actions/runs/30696038726/job/91358992919))
all passed on that exact head. No failure was acknowledged and no baseline was changed.

After the recovery proof, branch protection was atomically expanded from 11 to 14 App-bound
contexts by adding `CodSpeed Performance Analysis` (App 257293), `CodSpeed policy` (App 15368), and
`Greptile findings` (App 15368). All pre-existing contexts, conversation resolution, signed commits,
linear history, and force-push/deletion protections remained intact.

The canary never changes the protected `dev` branch directly, relaxes branch protection, dismisses
a finding, or uses an administrator bypass. Only the hardened live-value validation, its regression
tests, and clean redacted evidence remain in the final diff.
