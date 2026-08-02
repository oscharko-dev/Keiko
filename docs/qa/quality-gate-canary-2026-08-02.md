# Post-retirement quality-gate canary — 2026-08-02

This redacted marker is the sole candidate change in the fresh pull-request canary required by
ADR-0169 D5. It does not alter product behavior or gate configuration. Its purpose is to make the
post-retirement branch-protection topology prove itself on a new exact head.

The canary succeeds only when all of the following are true:

- the exact branch-head candidate commit and resulting squash merge are validly signed; an
  ephemeral synthetic test-merge object is not delivery evidence;
- the complete required-check set equals the exact ten App-bound checks in ADR-0169 D3, and all ten
  succeed on the current head;
- no retired hosted quality provider listed in ADR-0167 or ADR-0169 has a workflow, status,
  configuration, or App participating;
- every valid automated-review finding is repaired and its conversation is resolved without a
  human approving review; and
- GitHub native auto-merge performs the squash after the checks settle.

GitHub's check-run, review-thread, branch-protection, and merge records are the authoritative
evidence. This file intentionally does not copy mutable provider output or finding bodies into the
repository.
