---
title: "Autonomous dev delivery authority"
description: "Repair accepted dev PRs autonomously while protecting exact-head merge authority"
when: "Every pull request targeting dev, with additional checks for changes to autonomy, policy, Authority Envelopes, evidence, Git operations, GitHub integration, workflows, branch protection, or delivery behavior"
actions: "Enable Auto-Apply, repair code-review findings and attributable CI failures on the PR branch, add deterministic tests, and post a redacted progress comment; never unblock, force-push, push to dev, bypass Keiko for Quality, or merge incomplete evidence"
---

# Autonomous delivery checks

- Verify stricter-wins policy composition and every mode-independent hard denial.
- Apply owning-layer fixes and deterministic tests to the PR branch until productive strategies are
  exhausted or every finding and attributable CI failure is resolved.
- Permit native auto-merge only after the exact-head `Keiko for Quality` required check succeeds.
- Verify evidence remains content-free and bound to the current head and trusted producer.
- Reject unblock commands, direct `dev` pushes, force pushes, stale evidence reuse, permissive
  fallbacks, authority widening, and gate weakening.
