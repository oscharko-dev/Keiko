Only auto-approve a pull request when the review is complete for the exact current head, every
changed executable and trust-boundary file was inspected, every finding at every severity is
resolved by an owning-layer fix with deterministic regression or boundary coverage, and no file is
reported as unreviewed because of a service limit.

Never auto-approve stale, partial, skipped, cancelled, timed-out, unparseable, wrong-producer, or
non-zero-finding evidence. A Gitar approval may arm GitHub native auto-merge, but it never replaces
the app-bound `Keiko for Quality` required check. Never use `gitar unblock`, force-push, push directly
to `dev`, dismiss a finding to obtain green status, or widen task authority.
