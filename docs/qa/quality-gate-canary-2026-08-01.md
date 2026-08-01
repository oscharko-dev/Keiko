# Quality-gate canary — 2026-08-01

This pull request is the post-migration canary for the repository-owned quality surface introduced
by #2876. Its first signed commit, `1069aa9a7a75d7e3e19489a197af4671402de3a0`, deliberately
contained a slower benchmark, policy drift, and a weakened fail-closed comparison. The exact-head
negative evidence was:

- `CodSpeed policy` failed because the candidate changed the immutable 5% contract to 10%.
- `CodSpeed Performance Analysis` failed with a 51.48% aggregate regression and bound its report
  to the candidate and `dev` SHAs.
- `Greptile Review` failed at 3/5 confidence and emitted three P1 findings over all three deliberate
  defects.
- The base-owned `Greptile findings` context independently failed on that exact Greptile evidence.
- `Core quality` rejected the weakened repository configuration and comparison logic.

The next signed commit restores the protected 5% policy, exact live-settings comparison, and
calibrated benchmark workload. No failure was acknowledged and no baseline was changed.

The canary never changes the protected `dev` branch directly, relaxes branch protection, dismisses
a finding, or uses an administrator bypass. Only this clean, redacted evidence record remains in
the final diff.
