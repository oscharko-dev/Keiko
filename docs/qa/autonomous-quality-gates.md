# Autonomous quality gates

Keiko ships autonomously only when repository-owned and live-promoted required checks provide
independent, exact-current-head evidence that proves the candidate clean. For that required
evidence, a missing, skipped, neutral, stale, cancelled, timed-out, quota-paced, or differently
produced result is blocking. Advisory output carries no merge authority; every finding it does emit
is still repaired. Acknowledgement, dismissal, admin bypass, and threshold relaxation are not repair
paths.

## Enforced thresholds

- Sonar unresolved pull-request issues and new violations: `0`.
- Sonar new-code coverage: `>= 85%`.
- Sonar new-code duplication: `<= 3%` until Issue #2874 can safely synchronize a `<= 1%` OSS gate.
- Sonar new-code ratings: maintainability `A`, reliability `A`, and security `A`.
- Sonar security hotspots reviewed: `100%` on new code and overall.
- Semantic clone groups introduced by the diff: `0` at `>= 100` tokens and `>= 10` lines.
- Secrets introduced anywhere in the pull-request commit range: `0`.
- TypeScript and lint: strict, no `any`, explicit returns, and `0` warnings.
- Complexity and function size: cyclomatic complexity `<= 10` and `<= 50` non-comment lines per
  function.
- Package/file coverage: no committed per-file or per-package ratchet regression.
- CodSpeed CPU-simulation regression: `<= 5%` against the `dev` baseline; above 5% fails.
- Automated-review findings: `0` unresolved blocking findings and all conversations resolved.

The 85% coverage floor is constitutional, not aspirational. Per-file floors and package ratchets
prevent a high aggregate from hiding untested changed code. Mutation testing remains the deeper
scheduled/manual proof for security-critical code; it is not placed on every pull-request critical
path because its multi-hour runtime would turn availability into merge authority.

## Parallel gate topology

The protected `ci` context aggregates independent jobs and fails closed if any dependency is not
successful:

- core quality: typecheck, lint, formatting, architecture, contract, package, security, retrieval,
  evidence, and regression gates;
- sharded package/UI/script coverage, followed by one Sonar verdict over the reassembled evidence;
- cross-platform smoke when the change can affect native behavior;
- Fallow semantic duplicate analysis over changed files only; and
- Gitleaks over every addition in the pull-request commit range, including intermediate commits.

The jobs run concurrently. Full mutation, extended end-to-end, and reference-machine performance
measurements remain scheduled or release-owned; fast deterministic proxies and affected-area tests
stay on every pull request.

## Hosted supplemental checks

SonarCloud and Socket remain independently required. CodeRabbit is assertive but advisory: its trial
exhausted the review quota on PR #2876 and emitted success without reviewing the current head. It
therefore has neither required status nor review authority. Findings it does emit are still repaired
and actual conversations are settled; an absent or quota-paced CodeRabbit review is not merge
evidence and is not a merge blocker. Greptile and CodSpeed are promoted only after a live pull
request proves exact-head emission, an observed negative case, repaired recovery, stable producer
identity, and bounded settlement. CodSpeed additionally requires zero-cost continuity. Greptile may
be required during its no-payment trial only with a recorded hard expiry and owner-bound automated
rollback.

CodSpeed benchmark execution uses the exact candidate head. Its dashboard-policy verdict is a
different, base-trusted context: GitHub loads the validator from protected `dev`, downloads only the
candidate JSON policy, and never executes pull-request code. The context becomes required only after
a later canary proves this default-branch activation path.

Hosted products are not described as open-source merely because their service is free for a public
repository. The merge-critical foundation is repository-owned and implemented with open-source
tooling. No payment method or paid entitlement may be introduced. Greptile is removed from branch
protection no later than 24 hours before its trial expires unless the pending free-OSS exception is
approved and its live probes pass. Active automation `keiko-greptile-trial-rollback` owns that
deadline and must record successful live removal evidence rather than merely attempt the mutation.

## Sonar independence

The native `SonarCloud Code Analysis` context and `scripts/check-sonar-pr-quality-gate.mjs` enforce
Sonar independently. The repository validator binds the exact current head, native gate status,
custom gate definition, metric values, unresolved issue count, and new-violation count. No review
bot or retired aggregate participates in that decision.
