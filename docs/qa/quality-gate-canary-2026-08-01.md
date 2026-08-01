# Quality-gate canary — 2026-08-01

This pull request is the post-migration canary for the repository-owned quality surface introduced
by #2876. Its first signed commit deliberately contains a slower benchmark, policy drift, and a
weakened fail-closed comparison so the live CodSpeed and independent-review paths can prove that
they reject the exact candidate head. A later signed commit restores the protected policy and
records the recovery evidence before merge.

The canary never changes the protected `dev` branch directly, relaxes branch protection, dismisses
a finding, or uses an administrator bypass. Only the final clean documentation record is intended
to remain in the squash merge.
